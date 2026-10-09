/**
 * conversation-manager.ts — 会话级管理（屏蔽 / 移除）
 *
 * 「移除不需要的对话」的执行者：按固定顺序级联清理一个会话在各处的痕迹。
 *
 * 级联顺序（缺一不可，见 docs/conversation-hygiene-plan.md §6）：
 *   1. 内存话题（TopicRegistry）→ 2. 销毁运行时实例（Subagent）
 *   → 3. DB 话题（topics + topics_fts + topics_vec）
 *   → 4. 原始消息（message_log）→ 5. attention / signal pool
 *   → 6. session 文件 → 7. 群组画像（group_models）→ 8. 写审计
 *
 * **明确不动**：core_facts / person_identities / person_profiles /
 * person_group_profiles / interactions / session_digests —— 这些是沉淀后的长期记忆，
 * 会话删除不牵连（用户想删可走记忆面板各自的删除入口）。
 *
 * 设计约束：依赖以窄接口注入（与 meta-api/conversations.ts 同一风格），
 * 便于单测与避免与上游改动正面相撞。
 */

import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./logger.js";
import { safeGroupModelKey } from "./chat-id.js";

const log = createLogger("conversation-manager");

// ─── 删除理由 ───

/**
 * 删除理由预设。删除不可逆，理由必须可追溯 ——
 * 与 core_facts 带 provenance 同理：动作本身要有依据。
 */
export type DeleteReasonCode = "ad" | "too_long" | "no_need" | "inactive" | "other";

export interface DeleteReasonPreset {
    code: DeleteReasonCode;
    /** 人类可读标签 */
    label: string;
    /** 何时该用它 */
    hint: string;
}

export const DELETE_REASON_PRESETS: readonly DeleteReasonPreset[] = [
    { code: "ad", label: "广告 / 推广刷屏", hint: "对方持续发送广告或推广信息，没有保存必要" },
    { code: "too_long", label: "内容过长，主动清理截断", hint: "群聊体量过大，主动清理以控制存储与上下文" },
    { code: "no_need", label: "无需保留上下文", hint: "用户不希望被主动发起对话，且没有需要保留的上下文" },
    { code: "inactive", label: "长期无价值", hint: "会话已结束、长期无互动，没有长期价值" },
    { code: "other", label: "其它（需填写说明）", hint: "以上都不适用时使用，说明会写入审计" },
] as const;

const REASON_CODES = new Set<string>(DELETE_REASON_PRESETS.map((p) => p.code));

/** 删除被拒（理由缺失/非法、会话不存在等）。 */
export class ConversationDeleteError extends Error {
    constructor(message: string, readonly code: "reason_required" | "invalid_reason" | "not_found" = "reason_required") {
        super(message);
        this.name = "ConversationDeleteError";
    }
}

export function describeDeleteReason(code: DeleteReasonCode, text?: string): string {
    const preset = DELETE_REASON_PRESETS.find((p) => p.code === code);
    const label = preset?.label ?? code;
    const trimmed = text?.trim();
    return trimmed ? `${label}：${trimmed}` : label;
}

// ─── 依赖 ───

/** 会话管理用到的存储读取面（窄接口，结构性匹配 MemoryStoreV2）。 */
export interface ConversationStore {
    deleteTopicsByChat(chatId: string): number;
    deleteMessagesByChat(chatId: string): number;
    deleteGroupModel(chatId: string): boolean;
    countMessagesByChat(chatId: string): number;
    countTopicsByChat(chatId: string): number;
    listKnownChatIds?(platformPrefix?: string): string[];
    listGroupModels?(query?: string): Array<{ chatId: string; chatTitle?: string; isDirectMessage?: boolean }>;
    getRecentMessages?(chatId: string, limit?: number): Array<{ timestamp: string }>;
}

/** 运行时依赖（窄接口）。 */
export interface ConversationRuntime {
    get(chatId: string): {
        topicRegistry?: { purgeChat(chatId: string): number };
        /** GroupSubagent 上该字段类型是 `unknown`，由 asCodeActExecutor() 运行时窄化。 */
        codeActExecutor?: unknown;
    } | undefined;
    remove(chatId: string): boolean;
    getAllSubagents(): Array<{ chatId: string }>;
    getSessionFilePath(chatId: string): string;
}

/** 取消面（仅取我们真正用到的两个方法）。 */
interface CodeActCancelPort {
    cancelCurrentRun?: () => Promise<void>;
    isProcessing?: () => boolean;
}

export interface ConversationManagerOptions {
    memory: ConversationStore;
    subagentManager: ConversationRuntime;
    /** AttentionAccumulator.remove(chatId)：清 pending / signal pool 与 blocked 标记。 */
    accumulator: { remove(chatId: string): void };
    /** 审计文件路径，默认 workspace/conversation-deletions.json */
    auditPath?: string;
    /** 审计保留条数，默认 200 */
    auditLimit?: number;
}

// ─── 记录 ───

export interface ConversationDeletionRecord {
    chatId: string;
    chatTitle?: string;
    reasonCode: DeleteReasonCode;
    reasonText?: string;
    /** describeDeleteReason 的结果，便于直接展示 */
    reason: string;
    deletedAt: string;
    deleted: {
        /** 内存话题数（TopicRegistry） */
        memoryTopics: number;
        /** DB 话题数（topics 主表） */
        topics: number;
        messages: number;
        /** 是否移除了运行时 Subagent 实例 */
        runtimeInstance: boolean;
        /** 是否清理了 session 文件 */
        sessionFile: boolean;
        /** 是否删掉了群组画像行 */
        groupModel: boolean;
    };
    /** 级联中失败的步骤（有值时说明是"部分删除"，需要人工确认） */
    failures?: string[];
}

export interface ConversationSummary {
    chatId: string;
    chatTitle: string;
    platform: string;
    isDirectMessage: boolean;
    messageCount: number;
    topicCount: number;
    lastMessageAt: string | null;
    /** 运行时是否有活跃 Subagent 实例 */
    active: boolean;
}

// ─── 实现 ───

export class ConversationManager {
    private readonly memory: ConversationStore;
    private readonly runtime: ConversationRuntime;
    private readonly accumulator: { remove(chatId: string): void };
    private readonly auditPath: string;
    private readonly auditLimit: number;

    constructor(options: ConversationManagerOptions) {
        this.memory = options.memory;
        this.runtime = options.subagentManager;
        this.accumulator = options.accumulator;
        this.auditPath = options.auditPath ?? path.join("workspace", "conversation-deletions.json");
        this.auditLimit = options.auditLimit ?? 200;
    }

    /**
     * 列出可选会话（Dashboard 会话管理列表）。
     *
     * 来源是并集：运行时 Subagent 实例 ∪ message_log 出现过的会话 ∪ 群组画像。
     * 与 Dashboard 的 groups 快照同源思路，保证"列表里看得到的都能删"。
     */
    listConversations(): ConversationSummary[] {
        const activeChatIds = new Set(this.runtime.getAllSubagents().map((s) => s.chatId));
        const chatIds = new Set<string>(activeChatIds);

        for (const chatId of this.memory.listKnownChatIds?.() ?? []) chatIds.add(chatId);

        const groupModels = this.memory.listGroupModels?.() ?? [];
        const groupModelByChatId = new Map(groupModels.map((group) => [group.chatId, group]));
        for (const group of groupModels) chatIds.add(group.chatId);

        const summaries: ConversationSummary[] = [];
        for (const chatId of chatIds) {
            if (!chatId) continue;
            const group = groupModelByChatId.get(chatId) ?? groupModelByChatId.get(safeGroupModelKey(chatId));
            const recent = this.memory.getRecentMessages?.(chatId, 1) ?? [];
            summaries.push({
                chatId,
                chatTitle: group?.chatTitle ?? "",
                platform: platformOf(chatId),
                isDirectMessage: group?.isDirectMessage === true,
                messageCount: this.memory.countMessagesByChat(chatId),
                topicCount: this.memory.countTopicsByChat(chatId),
                lastMessageAt: recent[0]?.timestamp ?? null,
                active: activeChatIds.has(chatId),
            });
        }

        summaries.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
        return summaries;
    }

    /**
     * 移除一个会话。理由必填。
     *
     * 不可逆：删完 message_log / 话题 / session，记忆层不动。
     */
    delete(chatId: string, input: { reasonCode: string; reasonText?: string; chatTitle?: string }): Promise<ConversationDeletionRecord>;
    async delete(chatId: string, input: { reasonCode: string; reasonText?: string; chatTitle?: string }): Promise<ConversationDeletionRecord> {
        const id = chatId?.trim();
        if (!id) throw new ConversationDeleteError("chatId 不能为空", "not_found");

        const reasonCode = String(input?.reasonCode ?? "").trim();
        if (!reasonCode) {
            throw new ConversationDeleteError("删除会话必须给出理由（reasonCode）", "reason_required");
        }
        if (!REASON_CODES.has(reasonCode)) {
            throw new ConversationDeleteError(
                `未知的删除理由：${reasonCode}（可选：${[...REASON_CODES].join(" / ")}）`,
                "invalid_reason",
            );
        }
        const reasonText = input?.reasonText?.trim() || undefined;
        if (reasonCode === "other" && !reasonText) {
            throw new ConversationDeleteError("理由选「其它」时必须填写说明", "reason_required");
        }

        const code = reasonCode as DeleteReasonCode;
        // 任一步失败都不中断后续步骤（删一半比删不动更难排查），
        // 失败项汇总进审计，让"部分删除"可被发现。
        const failures: string[] = [];
        const step = <T>(name: string, fn: () => T, fallback: T): T =>
            this.runStep(id, name, fn, fallback, failures);

        const subagent = this.runtime.get(id);

        // 1) 先取消并等停进行中的 CodeAct 执行：它跑完会 saveSession()，
        //    不先处理就会把第 6 步删掉的 session 文件重新写回来。
        await this.cancelInFlightCodeAct(id, asCodeActCancelPort(subagent?.codeActExecutor), failures);

        // 2) 内存话题（必须在销毁实例之前取到 registry）
        const memoryTopics = step("purgeTopics", () => subagent?.topicRegistry?.purgeChat(id) ?? 0, 0);

        // 3) 销毁运行时实例
        const runtimeInstance = step("removeInstance", () => this.runtime.remove(id), false);

        // 4) DB 话题（topics + topics_fts + topics_vec）
        const topics = step("deleteTopics", () => this.memory.deleteTopicsByChat(id), 0);

        // 5) 原始消息
        const messages = step("deleteMessages", () => this.memory.deleteMessagesByChat(id), 0);

        // 6) attention / signal pool
        step("clearAttention", () => this.clearAttention(id), false);

        // 7) session 文件
        const sessionFile = step("removeSessionFile", () => this.removeSessionFile(id), false);

        // 8) 群组画像
        const groupModel = step("deleteGroupModel", () => this.memory.deleteGroupModel(safeGroupModelKey(id)), false);

        const record: ConversationDeletionRecord = {
            chatId: id,
            chatTitle: input?.chatTitle?.trim() || undefined,
            reasonCode: code,
            reasonText,
            reason: describeDeleteReason(code, reasonText),
            deletedAt: new Date().toISOString(),
            deleted: { memoryTopics, topics, messages, runtimeInstance, sessionFile, groupModel },
            ...(failures.length > 0 ? { failures } : {}),
        };

        this.appendAudit(record);
        log.info("会话已移除", { ...record.deleted, chatId: id, reasonCode: code, failures: failures.length });
        return record;
    }

    /** 读取审计记录（最新在前）。 */
    listAudit(limit = 50): ConversationDeletionRecord[] {
        return this.readAudit().slice(0, Math.max(1, limit));
    }

    // ─── 内部 ───

    /** 执行级联中的一步：失败只记入 failures 并回退默认值，不中断后续步骤。 */
    private runStep<T>(chatId: string, name: string, fn: () => T, fallback: T, failures: string[]): T {
        try {
            return fn();
        } catch (err) {
            failures.push(`${name}: ${String(err)}`);
            log.warn(`delete: ${name} 失败`, { chatId, error: String(err) });
            return fallback;
        }
    }

    /** 清 attention 队列与持久化的 signal pool。 */
    private clearAttention(chatId: string): boolean {
        this.accumulator.remove(chatId);
        return true;
    }

    /** 取消并等停进行中的 CodeAct 执行；失败只记入 failures，不阻断删除。 */
    private async cancelInFlightCodeAct(chatId: string, executor: CodeActCancelPort | null, failures: string[]): Promise<void> {
        if (!executor?.cancelCurrentRun) return;
        try {
            await executor.cancelCurrentRun();
            await waitUntilIdle(executor);
        } catch (err) {
            failures.push(`cancelCodeAct: ${String(err)}`);
            log.warn("delete: 取消进行中的 CodeAct 失败", { chatId, error: String(err) });
        }
    }

    private removeSessionFile(chatId: string): boolean {
        try {
            const filePath = this.runtime.getSessionFilePath(chatId);
            if (!filePath || !fs.existsSync(filePath)) return false;
            fs.rmSync(filePath, { force: true });
            return true;
        } catch (err) {
            log.warn("delete: session 文件清理失败", { chatId, error: String(err) });
            return false;
        }
    }

    private readAudit(): ConversationDeletionRecord[] {
        try {
            if (!fs.existsSync(this.auditPath)) return [];
            const parsed = JSON.parse(fs.readFileSync(this.auditPath, "utf-8"));
            return Array.isArray(parsed) ? (parsed as ConversationDeletionRecord[]) : [];
        } catch (err) {
            log.warn("审计读取失败", { auditPath: this.auditPath, error: String(err) });
            return [];
        }
    }

    private appendAudit(record: ConversationDeletionRecord): void {
        try {
            const dir = path.dirname(this.auditPath);
            if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const next = [record, ...this.readAudit()].slice(0, this.auditLimit);
            fs.writeFileSync(this.auditPath, JSON.stringify(next, null, 2), "utf-8");
        } catch (err) {
            // 审计写失败不影响删除本身（已发生的删除无法回滚）
            log.warn("审计写入失败", { auditPath: this.auditPath, error: String(err) });
        }
    }
}

function platformOf(chatId: string): string {
    const index = chatId.indexOf(":");
    return index > 0 ? chatId.slice(0, index) : "unknown";
}

/**
 * 窄化 `GroupSubagent.codeActExecutor`（源码里类型是 `unknown`）。
 * 方法必须 bind 回原对象 —— `cancelCurrentRun` 内部读写 `this.cancelRequested`，
 * 裸函数引用调用会因 this 丢失而抛错。
 */
function asCodeActCancelPort(value: unknown): CodeActCancelPort | null {
    if (!value || typeof value !== "object") return null;
    const candidate = value as { cancelCurrentRun?: unknown; isProcessing?: unknown };
    const port: CodeActCancelPort = {};
    if (typeof candidate.cancelCurrentRun === "function") {
        port.cancelCurrentRun = (candidate.cancelCurrentRun as () => Promise<void>).bind(value);
    }
    if (typeof candidate.isProcessing === "function") {
        port.isProcessing = (candidate.isProcessing as () => boolean).bind(value);
    }
    return port.cancelCurrentRun || port.isProcessing ? port : null;
}

/**
 * 轮询等待执行器停下。取消是异步的 —— `cancelCurrentRun()` 返回只代表已发出取消，
 * 进行中的 `execute()` 仍可能走到收尾的 `saveSession()`，把 session 文件写回来。
 */
async function waitUntilIdle(executor: CodeActCancelPort, timeoutMs = 5_000): Promise<void> {
    if (typeof executor.isProcessing !== "function") return;
    const deadline = Date.now() + timeoutMs;
    while (executor.isProcessing() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
