/**
 * grounding-util.ts — 并行 Grounding（联网事实查证）工具
 *
 * 支持三个 Provider：
 * - Google Gemini (googleSearch tool)
 * - Grok xAI (web_search via Responses API)
 * - Tavily (纯检索，无 LLM 综合)
 *
 * 设计原则：
 * 1. 对话内容先经过隐私过滤（人名替换为 User N，去除 @mention，去除时间戳）
 * 2. 与 attend-handler 的 LLM 决策并行执行
 * 3. 严格 Guardrail：无联网搜索证据则丢弃结果
 * 4. 多 Key 轮询：复用 llm-pool，429/quota 时自动冷却并切换下一个 key
 */

import { GoogleGenAI } from "@google/genai";
import { tavily } from "@tavily/core";
import type { TavilySearchResponse } from "@tavily/core";
import type { GroundingConfig } from "../core/config.js";
import { resolveGroundingPool, resolveComponentProfiles, resolveComponentTimeout } from "../core/config.js";
import {
    groundingProvider,
    groundingSummarizeProvider,
} from "../context-engine/providers/pipeline-providers.js";
import { getOrCreatePool } from "../core/llm-pool.js";
import type { LLMPool } from "../core/llm-pool.js";
import { createLogger } from "../core/logger.js";
import { llmEvents, isQuotaError, isAuthError, callLLMWithFallback } from "../core/llm.js";
import type { LLMCallEvent, LLMResponseEvent } from "../core/llm.js";

const log = createLogger("grounding");

let _groundingCallId = 0;
function nextGroundingCallId(): string {
    return `grounding_${Date.now()}_${++_groundingCallId}`;
}

/**
 * 发射 llm:call 事件（各 provider 的样板代码，抽出来避免重复）。
 * @returns callId 与起始时间戳，供调用方发射配对的 llm:response
 */
function emitGroundingCall(
    caller: string,
    provider: string,
    model: string,
    inputPreview: string,
): { callId: string; startTime: number } {
    const callId = nextGroundingCallId();
    const startTime = Date.now();
    if (llmEvents.listenerCount("llm:call") > 0) {
        const callEvent: LLMCallEvent = {
            callId,
            caller,
            model,
            temperature: 0,
            maxTokens: 0,
            provider,
            messageSummaries: [{ role: "user", contentPreview: inputPreview, imageCount: 0 }],
            timestamp: new Date().toISOString(),
        };
        llmEvents.emit("llm:call", callEvent);
    }
    return { callId, startTime };
}

/** 发射 llm:response 事件（幂等：无监听者时直接跳过） */
function emitGroundingResponse(event: LLMResponseEvent): void {
    if (llmEvents.listenerCount("llm:response") > 0) {
        llmEvents.emit("llm:response", event);
    }
}

// ─── 隐私过滤 ───

/**
 * 对消息文本进行隐私脱敏：
 * - 收集所有 displayName，映射为 User 1, User 2 ...
 * - 去除所有 @mention
 * - 去除时间戳（常见格式，如 [2024-01-01 12:00] 或 HH:MM）
 */
export function sanitizeForGrounding(
    messagesText: string,
    activePersons?: Array<{ displayName: string; userId?: string; username?: string }>,
): string {
    let text = messagesText;

    // 1. 收集所有出现的人名并建立映射
    const nameMap = new Map<string, string>();
    let counter = 1;

    if (activePersons?.length) {
        for (const p of activePersons) {
            if (p.displayName && !nameMap.has(p.displayName)) {
                nameMap.set(p.displayName, `User ${counter++}`);
            }
            // 也替换 username
            if (p.username && !nameMap.has(p.username)) {
                nameMap.set(p.username, nameMap.get(p.displayName) ?? `User ${counter++}`);
            }
        }
    }

    // 从文本中自动提取 "[timestamp] DisplayName: ..." 形式的发言者名
    const senderPattern = /^(?:\[.*?\]\s*)?([^:：\n]{1,30})[：:]\s/gm;
    let match: RegExpExecArray | null;
    while ((match = senderPattern.exec(text)) !== null) {
        const name = match[1].trim();
        if (name && !nameMap.has(name) && name.length > 0 && name.length <= 30) {
            nameMap.set(name, `User ${counter++}`);
        }
    }

    // 2. 按名字长度降序替换（避免短名误匹配长名的子串）
    const sortedNames = Array.from(nameMap.entries())
        .sort((a, b) => b[0].length - a[0].length);

    for (const [realName, anonName] of sortedNames) {
        // 转义正则特殊字符
        const escaped = realName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text.replace(new RegExp(escaped, "g"), anonName);
    }

    // 3. 去除 @mention（@user、@User_1 等形式）
    text = text.replace(/@[\w\u4e00-\u9fff]+/g, "");

    // 4. 去除时间戳
    // 匹配 [2024-01-01 12:00:00] 或 [12:00] 或 (2024/1/1 12:00) 之类的
    text = text.replace(/\[\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\]/g, "");
    text = text.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "");
    // 行首 timestamp: "2024-01-01 12:00 " 或 "12:00 "
    text = text.replace(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*/gm, "");

    // 5. 清理多余空行
    text = text.replace(/\n{3,}/g, "\n\n").trim();

    return text;
}

// ─── Provider 输入契约 ───

/**
 * 各 provider 的输入。
 * google/grok 只需要一个完整 prompt；tavily 既要检索词，又要在总结阶段拿到对话原文做比对
 * （否则模型只能复述资料，无法判断「与对话中哪些陈述不符」）。
 */
interface GroundingInput {
    /** 发给 provider 的 prompt（google/grok）或检索词（tavily） */
    payload: string;
    /** 隐私脱敏后的对话原文 */
    conversation: string;
}

// ─── Provider: Google Gemini ───

async function callGoogleGrounding(
    config: GroundingConfig,
    apiKey: string,
    promptText: string,
): Promise<string | undefined> {
    const model = config.model || "gemini-2.0-flash-lite";

    const ai = new GoogleGenAI({ apiKey });

    const { callId, startTime } = emitGroundingCall("grounding-google", "google", model, promptText);

    const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        config: {
            tools: [{ googleSearch: {} }],
        },
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    // Guardrail: 检查是否真的使用了 Google Search
    const metadata = response.candidates?.[0]?.groundingMetadata;
    const hasWebResults = metadata && (
        (metadata.webSearchQueries?.length ?? 0) > 0 ||
        ((metadata.groundingChunks ?? []) as any[]).filter((c: any) => c.web).length > 0
    );

    const text = response.text ?? "";
    const usage = response.usageMetadata;

    emitGroundingResponse({
        callId,
        caller: "grounding-google",
        contentPreview: hasWebResults ? text : "(guardrail: no search results)",
        contentLength: text.length,
        usage: usage ? {
            promptTokens: usage.promptTokenCount,
            completionTokens: usage.candidatesTokenCount,
            totalTokens: usage.totalTokenCount,
        } : undefined,
        durationMs: Date.now() - startTime,
        error: hasWebResults ? undefined : "guardrail: no search results, dropped",
        timestamp: new Date().toISOString(),
    });

    if (!hasWebResults) {
        log.info("Google Grounding 未返回搜索结果，丢弃", { elapsed: `${elapsed}s` });
        return undefined;
    }

    if (!text) {
        log.info("Google Grounding 返回空文本，丢弃", { elapsed: `${elapsed}s` });
        return undefined;
    }

    // 构建引用列表
    const sources: string[] = [];
    const chunks = (metadata.groundingChunks ?? []) as any[];
    for (const chunk of chunks) {
        if (chunk.web?.uri) {
            sources.push(`- ${chunk.web.title ?? chunk.web.uri}: ${chunk.web.uri}`);
        }
    }

    log.info("Google Grounding 完成", {
        elapsed: `${elapsed}s`,
        model,
        sources: sources.length,
        tokens: usage ? `${usage.promptTokenCount}→${usage.candidatesTokenCount}` : "N/A",
    });

    // 返回结构化文本
    let result = text;
    return result;
}

// ─── Provider: Grok xAI ───

async function callGrokGrounding(
    config: GroundingConfig,
    apiKey: string,
    promptText: string,
): Promise<string | undefined> {
    const baseUrl = (config.baseUrl || "https://api.x.ai/v1").replace(/\/$/, "");
    const model = config.model || "grok-3-mini-fast";

    const { callId, startTime } = emitGroundingCall("grounding-grok", "openai", model, promptText);

    const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            input: [
                { role: "user", content: promptText },
            ],
            tools: [{ type: "web_search" }],
        }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        const errMsg = `Grok API ${response.status}: ${body.slice(0, 200)}`;
        emitGroundingResponse({
            callId,
            caller: "grounding-grok",
            contentPreview: "",
            contentLength: 0,
            durationMs: Date.now() - startTime,
            error: errMsg,
            timestamp: new Date().toISOString(),
        });
        log.warn("Grok Grounding API 错误", {
            status: response.status,
            body: body.slice(0, 300),
            elapsed: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
        });
        // 抛出而非吞掉：交由 runWithKeyRotation 判断是否轮询到下一个 key
        throw new Error(errMsg);
    }

    const data = await response.json() as any;

    // 从 response.output 中提取 message 类型的 content
    const outputItems = Array.isArray(data.output) ? data.output : [];
    const messageItem = outputItems.find((item: any) => item.type === "message");
    const textContent = messageItem?.content
        ?.filter((c: any) => c.type === "output_text")
        ?.map((c: any) => c.text)
        ?.join("\n") ?? "";

    // Guardrail: 检查是否真的进行了网络搜索
    const hasWebSearch = outputItems.some((item: any) => item.type === "web_search_call");

    // 发射 llm:response 事件
    emitGroundingResponse({
        callId,
        caller: "grounding-grok",
        contentPreview: hasWebSearch ? textContent : "(guardrail: no web_search_call)",
        contentLength: textContent.length,
        usage: data.usage ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
        } : undefined,
        durationMs: Date.now() - startTime,
        error: hasWebSearch ? undefined : "guardrail: no web search, dropped",
        timestamp: new Date().toISOString(),
    });

    if (!textContent) {
        log.info("Grok Grounding 返回空文本，丢弃", { elapsed: `${((Date.now() - startTime) / 1000).toFixed(2)}s` });
        return undefined;
    }

    if (!hasWebSearch) {
        log.info("Grok Grounding 未执行网络搜索，丢弃", { elapsed: `${((Date.now() - startTime) / 1000).toFixed(2)}s` });
        return undefined;
    }

    // 提取搜索引用
    const sources: string[] = [];
    const annotations = messageItem?.content
        ?.flatMap((c: any) => c.annotations ?? [])
        ?.filter((a: any) => a.type === "url_citation") ?? [];
    for (const ann of annotations) {
        if (ann.url) {
            sources.push(`- ${ann.title ?? ann.url}: ${ann.url}`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    log.info("Grok Grounding 完成", {
        elapsed: `${elapsed}s`,
        model,
        sources: sources.length,
        tokens: data.usage
            ? `${data.usage.input_tokens ?? "?"}→${data.usage.output_tokens ?? "?"}`
            : "N/A",
    });

    let result = textContent;
    return result;
}

// ─── Provider: Tavily ───

/** Tavily query 长度上限（官方建议 query 保持在 400 字符内） */
const TAVILY_QUERY_MAX_LEN = 380;

/** 检索档位。advanced 才会返回「按 query 选取的相关切块」，basic 只给一段泛化摘要（事实细节最容易丢） */
const TAVILY_SEARCH_DEPTH = "advanced";
/** 每个来源最多取几个相关切块（仅 advanced 生效，上限 3，每块 ≤500 字符） */
const TAVILY_CHUNKS_PER_SOURCE = 3;
/** 返回的来源数量 */
const TAVILY_MAX_RESULTS = 5;

/**
 * 把脱敏后的对话文本压成一条搜索 query。
 * Tavily 是纯检索 API，没有 LLM 综合能力，因此不能直接喂 grounding prompt 模板，
 * 只能取对话中最靠后（最相关）的一段作为检索词。
 */
export function buildTavilyQuery(sanitizedText: string, maxLen = TAVILY_QUERY_MAX_LEN): string {
    const compact = sanitizedText.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLen) return compact;
    return compact.slice(-maxLen).trimStart();
}

/**
 * 整理资料块所需的最小结构。
 * 刻意不复用 SDK 的 `TavilySearchResponse`（字段全是必填），否则构造测试数据要补齐
 * query / responseTime / requestId 等一堆无关字段。SDK 的响应结构可直接赋予此类型。
 */
interface TavilyDigestSource {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string }>;
}

/** 资料块长度上限。advanced + chunks 3 后单次最多可返回 5×3×500 字符，必须封顶避免撑爆 prompt */
const TAVILY_DIGEST_MAX_CHARS = 6000;

/**
 * 把 Tavily 的返回整理成编号资料块。
 * 编号是为了让总结模型能引用来源（对标 google/grok 的「标注来源」要求）。
 */
export function buildTavilyDigest(data: TavilyDigestSource): string {
    const parts: string[] = [];
    if (data.answer?.trim()) {
        parts.push(`【检索引擎的直接回答】\n${data.answer.trim()}`);
    }
    const results = data.results ?? [];
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        parts.push([
            `【资料${i + 1}】${r.title ?? "(无标题)"}`,
            `URL: ${r.url ?? "N/A"}`,
            (r.content ?? "").trim(),
        ].join("\n"));
    }
    const digest = parts.join("\n\n").trim();
    return digest.length > TAVILY_DIGEST_MAX_CHARS
        ? `${digest.slice(0, TAVILY_DIGEST_MAX_CHARS)}\n…（资料过长已截断）`
        : digest;
}

/**
 * 判断总结模型是否判定「无需查证」。
 * 按「回复以该标记开头」判定，而不是「包含」—— 前者能覆盖「无需查证。」「无需查证，资料与对话无关」
 * 这类回复，又不会误杀「……因此对话中无需查证的判断不成立」这类**结论**。
 * 偏向「不轻易丢弃」：多注入一句无关结论无害，误丢一条真结论才是损失。
 */
export function isNothingToVerify(summary: string): boolean {
    return summary.replace(/[\s，。,.!！、~～;；:：]/g, "").startsWith("无需查证");
}

/** 总结结果：ok=有结论；nothing=模型判定无需查证；unavailable=总结不可用，应退回原始资料 */
type SummarizeOutcome =
    | { kind: "ok"; text: string }
    | { kind: "nothing" }
    | { kind: "unavailable" };

/**
 * 用宿主自己的 LLM 把检索资料综合成「结论式事实核对」。
 *
 * Tavily 自身没有 LLM，而下游执行器只有一种接收契约（「事实信息」）。
 * 这一步就是补齐这个语义差：让 tavily 的输出形态和 google/grok 对齐。
 * 失败一律降级为 unavailable（退回原始资料），绝不因为总结环节丢掉已经花额度换来的检索结果。
 */
async function summarizeTavilyDigest(conversation: string, searchDigest: string): Promise<SummarizeOutcome> {
    const prompts = groundingSummarizeProvider.render({ conversation, searchDigest });
    try {
        const configs = resolveComponentProfiles("grounding");
        if (configs.length === 0) return { kind: "unavailable" };

        const response = await callLLMWithFallback(
            [{ role: "user", content: prompts }],
            configs,
            {
                caller: "grounding-summarize",
                temperature: 0,
                timeoutMs: resolveComponentTimeout("grounding"),
            },
        );
        const text = response.content.trim();
        if (!text) return { kind: "unavailable" };
        if (isNothingToVerify(text)) return { kind: "nothing" };
        return { kind: "ok", text };
    } catch (err) {
        log.warn("Tavily 检索结果总结失败，退回原始资料", { error: String(err).slice(0, 200) });
        return { kind: "unavailable" };
    }
}

/**
 * 把 Tavily 的错误转成可被 isQuotaError / isAuthError 识别的形式后抛出。
 * Tavily 额度耗尽用的不是标准 429，而是 432（套餐额度用尽）/ 433（按量付费上限），
 * 这两种情况下换一个 key 才是正确行为，因此显式补上 "quota" 标记。
 */
export function rethrowTavilyError(err: unknown): never {
    const status = (err as any)?.response?.status as number | undefined;
    const detail = (err as any)?.response?.data?.detail as string | undefined;
    if (status === 432 || status === 433) {
        throw new Error(`Tavily quota exceeded (${status}): ${detail ?? "usage limit reached"}`);
    }
    // 429 / 401 / 403 等标准状态码的 axios 错误 message 里已含状态码，原样抛出即可
    throw err instanceof Error ? err : new Error(String(err));
}

async function callTavilyGrounding(
    config: GroundingConfig,
    apiKey: string,
    input: GroundingInput,
): Promise<string | undefined> {
    const model = config.model || "tavily-search";

    const { callId, startTime } = emitGroundingCall("grounding-tavily", "tavily", model, input.payload);

    const client = tavily({
        apiKey,
        ...(config.baseUrl ? { apiBaseURL: config.baseUrl.replace(/\/$/, "") } : {}),
    });

    let data: TavilySearchResponse;
    try {
        data = await client.search(input.payload, {
            searchDepth: TAVILY_SEARCH_DEPTH,
            chunksPerSource: TAVILY_CHUNKS_PER_SOURCE,
            maxResults: TAVILY_MAX_RESULTS,
            includeAnswer: true,
        });
    } catch (err) {
        emitGroundingResponse({
            callId,
            caller: "grounding-tavily",
            contentPreview: "",
            contentLength: 0,
            durationMs: Date.now() - startTime,
            error: String(err).slice(0, 200),
            timestamp: new Date().toISOString(),
        });
        // 交由 runWithKeyRotation 判断是否轮询到下一个 key
        rethrowTavilyError(err);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const results = data.results ?? [];

    // Guardrail: 没有任何检索结果则丢弃（与 google/grok 的「无搜索证据」一致）
    if (results.length === 0) {
        emitGroundingResponse({
            callId,
            caller: "grounding-tavily",
            contentPreview: "(guardrail: no results)",
            contentLength: 0,
            durationMs: Date.now() - startTime,
            error: "guardrail: no search results, dropped",
            timestamp: new Date().toISOString(),
        });
        log.info("Tavily Grounding 未返回搜索结果，丢弃", { elapsed: `${elapsed}s` });
        return undefined;
    }

    const digest = buildTavilyDigest(data);
    if (!digest) {
        log.info("Tavily Grounding 资料为空，丢弃", { elapsed: `${elapsed}s` });
        return undefined;
    }

    // 交给模型做结论式总结；不可用时退回原始资料，判定无需查证时丢弃
    const outcome = await summarizeTavilyDigest(input.conversation, digest);
    if (outcome.kind === "nothing") {
        emitGroundingResponse({
            callId,
            caller: "grounding-tavily",
            contentPreview: "(guardrail: nothing to verify)",
            contentLength: 0,
            durationMs: Date.now() - startTime,
            error: "guardrail: nothing to verify, dropped",
            timestamp: new Date().toISOString(),
        });
        log.info("Tavily 检索结果经判断无需查证，丢弃", { elapsed: `${elapsed}s` });
        return undefined;
    }

    const text = outcome.kind === "ok" ? outcome.text : digest;

    emitGroundingResponse({
        callId,
        caller: "grounding-tavily",
        contentPreview: text,
        contentLength: text.length,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
    });

    log.info("Tavily Grounding 完成", {
        elapsed: `${elapsed}s`,
        results: results.length,
        summarized: outcome.kind === "ok",
        credits: data.usage?.credits ?? "N/A",
    });

    return text;
}

// ─── 对外接口 ───

/** 按 provider 分发到具体实现 */
function dispatchGrounding(
    config: GroundingConfig,
    apiKey: string,
    input: GroundingInput,
): Promise<string | undefined> {
    switch (config.provider) {
        case "google":
            return callGoogleGrounding(config, apiKey, input.payload);
        case "grok":
            return callGrokGrounding(config, apiKey, input.payload);
        case "tavily":
            return callTavilyGrounding(config, apiKey, input);
        default:
            log.warn("未知 Grounding provider", { provider: String((config as GroundingConfig).provider) });
            return Promise.resolve(undefined);
    }
}

/** 一次尝试的结果。done = 轮询应当终止（拿到业务结果，或没有可换的 key 了） */
interface GroundingAttempt {
    done: boolean;
    /** done 时作为最终查证结果，undefined 表示被 Guardrail 丢弃 */
    text?: string;
    error?: unknown;
    /** 是否值得换一个 key 重试（仅 quota/认证类失败） */
    retryable: boolean;
}

/**
 * 用池里下一个可用 key 尝试一次，内部完成 acquire → 调用 → release。
 * 把「是否该换 key」的判定收敛成返回值，避免调用方堆出多层嵌套 try/catch。
 *
 * 注意：Guardrail 丢弃（没有联网证据）是正常业务结果，必须 done + retryable=false，
 * 否则会拿着一个完全健康的 key 去白白轮询下一个。
 */
async function attemptGroundingOnce(
    pool: LLMPool,
    config: GroundingConfig,
    input: GroundingInput,
): Promise<GroundingAttempt> {
    const handle = pool.acquire();
    if (!handle) return { done: true, retryable: false }; // 所有 key 都在冷却中或已禁用

    try {
        const text = await dispatchGrounding(config, handle.apiKey, input);
        pool.release(handle, true);
        return { done: true, retryable: false, text };
    } catch (err) {
        const quota = isQuotaError(err);
        const auth = isAuthError(err);
        pool.release(handle, false, quota, auth);
        return { done: false, error: err, retryable: quota || auth };
    }
}

/**
 * 依次用池里的 key 尝试查证，最多 pool.size 次，永不抛异常。
 * Grounding 是增强能力——任何失败都要降级成「这次没有查证结果」，不能中断 dispatch。
 */
async function runWithKeyRotation(
    pool: LLMPool,
    config: GroundingConfig,
    input: GroundingInput,
): Promise<string | undefined> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < pool.size; attempt++) {
        const outcome = await attemptGroundingOnce(pool, config, input);
        if (outcome.done) return outcome.text;

        lastError = outcome.error;
        if (!outcome.retryable || attempt === pool.size - 1) break;

        log.warn("Grounding key 失效，切换下一个 key", {
            provider: config.provider,
            attempt: attempt + 1,
            total: pool.size,
        });
    }

    if (lastError) {
        log.warn("Grounding 执行失败", {
            provider: config.provider,
            keys: pool.size,
            error: String(lastError).slice(0, 300),
        });
    }
    return undefined;
}

/**
 * 执行并行 Grounding 联网搜索
 *
 * 多 Key 时按 pool.strategy 轮询；遇到 429/quota 或 401/403 会自动冷却/禁用当前 key
 * 并切换到下一个 key 重试，最多尝试 pool.size 次。
 *
 * @param config Grounding 配置（provider + apiKey/pool + baseUrl）
 * @param messagesText 经过 enrichMessages 富化后的消息文本
 * @param activePersons 活跃人物列表（用于隐私脱敏映射）
 * @returns 联网查证结果文本，如果没有有效结果则返回 undefined
 */
export async function runParallelGrounding(
    config: GroundingConfig,
    messagesText: string,
    activePersons?: Array<{ displayName: string; userId?: string; username?: string }>,
): Promise<string | undefined> {
    const poolConfig = resolveGroundingPool(config);
    if (!poolConfig) {
        log.debug("Grounding 未配置 API Key，跳过");
        return undefined;
    }

    // 1. 隐私脱敏
    const sanitizedText = sanitizeForGrounding(messagesText, activePersons);
    if (!sanitizedText || sanitizedText.length < 10) {
        log.debug("Grounding 脱敏后文本过短，跳过");
        return undefined;
    }

    // 2. 准备输入：google/grok 走 LLM prompt，tavily 用对话尾部当检索词（原文另留给总结阶段比对）
    const input: GroundingInput = config.provider === "tavily"
        ? { payload: buildTavilyQuery(sanitizedText), conversation: sanitizedText }
        : { payload: groundingProvider.render({ sanitizedText }), conversation: sanitizedText };
    if (!input.payload) {
        log.debug("Grounding 输入为空，跳过");
        return undefined;
    }

    // 3. key 指纹作为 poolId，保证同一份配置在多次调用间共享调度状态（冷却/禁用不丢失）
    const fingerprint = poolConfig.members.map(m => m.apiKey.slice(0, 8)).sort().join(",");
    const pool = getOrCreatePool(`grounding:${config.provider}:${fingerprint}`, poolConfig);

    try {
        return await runWithKeyRotation(pool, config, input);
    } catch (err) {
        log.warn("Grounding 执行异常", { provider: config.provider, error: String(err).slice(0, 300) });
        return undefined;
    }
}
