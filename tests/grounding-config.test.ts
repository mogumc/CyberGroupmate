/**
 * tests/grounding-config.test.ts — Grounding 多 Key / Tavily 的边界条件
 *
 * 只覆盖容易写错的地方：
 * - pool 与 api_key 的优先级 / 兜底
 * - 只配 pool（api_key 为空）时配置不能丢
 * - 序列化往返不丢 pool.keys（保存一次配置就把多 Key 抹掉是致命 bug）
 * - tavily query 的截断边界
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearConfigCache,
    loadConfig,
    resolveComponentProfiles,
    resolveComponentTimeout,
    resolveGroundingKeys,
    serializeConfigToYAML,
} from "../src/core/config.js";
import {
    buildTavilyQuery,
    buildTavilyDigest,
    isNothingToVerify,
    rethrowTavilyError,
} from "../src/main-agent/grounding-util.js";
import { isAuthError, isQuotaError } from "../src/core/llm.js";

const tempDirs: string[] = [];

function writeConfig(lines: string[]): string {
    const dir = join(tmpdir(), `grounding-cfg-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    const p = join(dir, "config.yaml");
    writeFileSync(p, lines.join("\n"));
    return p;
}

after(() => {
    clearConfigCache();
    for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe("resolveGroundingKeys", () => {
    it("pool 存在时优先返回 pool 里的所有 key", () => {
        const keys = resolveGroundingKeys({
            provider: "tavily",
            apiKey: "single-key",
            pool: {
                strategy: "round_robin",
                members: [{ apiKey: "k1" }, { apiKey: "k2" }],
            },
        });
        assert.deepEqual(keys, ["k1", "k2"]);
    });

    it("没有 pool 时回退到单个 apiKey", () => {
        assert.deepEqual(
            resolveGroundingKeys({ provider: "google", apiKey: "only" }),
            ["only"],
        );
    });

    it("两者都没有 / 配置为空时返回空数组", () => {
        assert.deepEqual(resolveGroundingKeys({ provider: "google", apiKey: "" }), []);
        assert.deepEqual(resolveGroundingKeys(undefined), []);
        assert.deepEqual(resolveGroundingKeys(null), []);
    });
});

describe("grounding 配置解析", () => {
    it("只配 pool、api_key 为空时依然生效（且不回填 api_key，避免密钥在配置里存两份）", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig([
            "grounding:",
            "  provider: tavily",
            "  api_key: \"\"",
            "  pool:",
            "    strategy: least_pending",
            "    keys:",
            "      - api_key: tvly-a",
            "      - api_key: tvly-b",
        ]));
        assert.equal(cfg.grounding?.provider, "tavily");
        assert.equal(cfg.grounding?.pool?.strategy, "least_pending");
        assert.deepEqual(cfg.grounding?.pool?.members.map(m => m.apiKey), ["tvly-a", "tvly-b"]);
        assert.equal(cfg.grounding?.apiKey, "", "不应把 pool 首个 key 回填进 api_key");
        // 真正决定「能不能跑」的是这一步
        assert.deepEqual(resolveGroundingKeys(cfg.grounding), ["tvly-a", "tvly-b"]);
    });

    it("只配 pool 时序列化不会把首个 key 复制进 api_key", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig([
            "grounding:",
            "  provider: tavily",
            "  pool:",
            "    keys:",
            "      - api_key: tvly-only",
        ]));
        const yaml = serializeConfigToYAML(cfg);
        const groundingBlock = yaml.slice(yaml.indexOf("grounding:"));
        const occurrences = groundingBlock.split("tvly-only").length - 1;
        assert.equal(occurrences, 1, `密钥应只出现一次，实际出现 ${occurrences} 次`);
    });

    it("空键被过滤；全空则整个 grounding 视为未配置", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig([
            "grounding:",
            "  provider: tavily",
            "  pool:",
            "    keys:",
            "      - api_key: \"\"",
            "      - api_key: tvly-real",
        ]));
        assert.deepEqual(cfg.grounding?.pool?.members.map(m => m.apiKey), ["tvly-real"]);

        clearConfigCache();
        const empty = loadConfig(writeConfig([
            "grounding:",
            "  provider: tavily",
            "  pool:",
            "    keys:",
            "      - api_key: \"\"",
        ]));
        assert.equal(empty.grounding, undefined);
    });

    it("未知 provider 被拒绝（不会静默当成 google）", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig([
            "grounding:",
            "  provider: bing",
            "  api_key: some-key",
        ]));
        assert.equal(cfg.grounding, undefined);
    });

    it("序列化往返不丢 pool.keys", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig([
            "grounding:",
            "  provider: grok",
            "  api_key: tvly-a",
            "  pool:",
            "    strategy: random",
            "    keys:",
            "      - api_key: tvly-a",
            "      - api_key: tvly-b",
            "        base_url: https://proxy.example.com/v1",
        ]));
        const yaml = serializeConfigToYAML(cfg);

        clearConfigCache();
        const roundTripped = loadConfig(writeConfig(yaml.split("\n")));
        assert.equal(roundTripped.grounding?.pool?.strategy, "random");
        assert.deepEqual(
            roundTripped.grounding?.pool?.members.map(m => m.apiKey),
            ["tvly-a", "tvly-b"],
        );
        assert.equal(
            roundTripped.grounding?.pool?.members[1].baseUrl,
            "https://proxy.example.com/v1",
        );
    });
});

// ═══ llm_routing.grounding ═══

describe("llm_routing.grounding", () => {
    // llm_routing 的解析是逐组件硬编码枚举的，只加 RoutingComponentKey 类型 + 文档
    // 而漏加解析列表，配置会被静默忽略并回退到第一个 profile —— 这里把它钉死。
    it("配置会被真正解析（组件路由与组件级超时都不被丢弃）", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig([
            "llm_profiles:",
            "  cheap:",
            "    provider: openai",
            "    base_url: https://example.com/v1",
            "    api_key: k",
            "    model: cheap-model",
            "  expensive:",
            "    provider: openai",
            "    base_url: https://example.com/v1",
            "    api_key: k",
            "    model: expensive-model",
            "llm_routing:",
            "  meta: expensive",
            "  grounding: cheap",
            "  timeouts:",
            "    grounding: 8000",
        ]));

        assert.equal(cfg.llmRouting.grounding, "cheap");
        assert.equal(cfg.llmRouting.timeouts?.grounding, 8000);
        assert.deepEqual(
            resolveComponentProfiles("grounding", cfg).map(p => p.model),
            ["cheap-model"],
        );
        assert.equal(resolveComponentTimeout("grounding", cfg), 8000);
    });

    it("序列化往返不丢 llm_routing.grounding", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig([
            "llm_profiles:",
            "  cheap:",
            "    provider: openai",
            "    base_url: https://example.com/v1",
            "    api_key: k",
            "    model: cheap-model",
            "llm_routing:",
            "  grounding: cheap",
        ]));

        const yaml = serializeConfigToYAML(cfg);
        clearConfigCache();
        assert.equal(loadConfig(writeConfig(yaml.split("\n"))).llmRouting.grounding, "cheap");
    });
});

describe("buildTavilyQuery", () => {
    it("短文本原样返回，只压缩空白", () => {
        assert.equal(buildTavilyQuery("  今天  天气\n怎么样  "), "今天 天气 怎么样");
    });

    it("超长文本截取尾部且不超长", () => {
        const long = "A".repeat(1000);
        const q = buildTavilyQuery(long, 100);
        assert.equal(q.length, 100);
        assert.equal(q, "A".repeat(100));
    });

    it("恰好等于上限时不截断（边界）", () => {
        const exact = "B".repeat(50);
        assert.equal(buildTavilyQuery(exact, 50), exact);
    });

    it("截断后不会以空白开头", () => {
        const text = `${"C".repeat(90)}   TAIL-WORD`;
        const q = buildTavilyQuery(text, 20);
        assert.ok(!q.startsWith(" "), `不应以空白开头: ${JSON.stringify(q)}`);
        assert.ok(q.endsWith("TAIL-WORD"));
    });
});

describe("buildTavilyDigest", () => {
    it("资料按 1 起步连续编号，并带上引擎直接回答", () => {
        const digest = buildTavilyDigest({
            answer: "GPT-5 已于 2025 年发布。",
            results: [
                { title: "官网公告", url: "https://a.example", content: "片段A" },
                { title: "新闻报道", url: "https://b.example", content: "片段B" },
            ],
        });

        assert.ok(digest.includes("检索引擎的直接回答"));
        assert.ok(digest.includes("【资料1】官网公告"));
        assert.ok(digest.includes("【资料2】新闻报道"));
        assert.ok(!digest.includes("【资料3】"));
    });

    it("字段缺失时不产出 undefined 字样（避免污染给模型的资料块）", () => {
        const digest = buildTavilyDigest({ results: [{ content: "只有正文" }] });

        assert.ok(digest.includes("只有正文"));
        assert.ok(!digest.includes("undefined"));
        assert.ok(digest.includes("(无标题)"));
    });

    it("既无回答也无结果时返回空串（调用方据此丢弃）", () => {
        assert.equal(buildTavilyDigest({}), "");
        assert.equal(buildTavilyDigest({ results: [] }), "");
        assert.equal(buildTavilyDigest({ answer: "   " }), "");
    });

    it("超长资料被截断并标注（避免撑爆 prompt）", () => {
        const digest = buildTavilyDigest({
            results: [{ title: "长文", url: "https://a.example", content: "X".repeat(20000) }],
        });

        assert.ok(digest.length < 20000, "应被截断");
        assert.ok(digest.includes("资料过长已截断"));
        assert.ok(digest.includes("【资料1】"));
    });
});

describe("isNothingToVerify", () => {
    it("简短的「无需查证」判定为无需查证（容忍标点与空白）", () => {
        assert.equal(isNothingToVerify("无需查证"), true);
        assert.equal(isNothingToVerify("  无需查证。 "), true);
        assert.equal(isNothingToVerify("无需查证，资料与对话无关"), true);
    });

    it("长结论里顺带提到「无需查证」不误杀", () => {
        const long = "关于版本号的争议：资料显示已发布，因此对话中「无需查证」的说法本身不成立。";
        assert.equal(isNothingToVerify(long), false);
    });

    it("空串不算无需查证", () => {
        assert.equal(isNothingToVerify(""), false);
    });
});

describe("rethrowTavilyError", () => {
    /** 造一个 axios 风格的错误 */
    function axiosLike(status: number, detail?: string): Error {
        const err = new Error(`Request failed with status code ${status}`) as Error & { response?: unknown };
        err.response = { status, data: detail ? { detail } : {} };
        return err;
    }

    it("432/433（Tavily 的额度耗尽）被识别为 quota，从而触发换 key", () => {
        for (const status of [432, 433]) {
            assert.throws(
                () => rethrowTavilyError(axiosLike(status)),
                (err: Error) => isQuotaError(err),
                `status ${status} 应被判定为 quota`,
            );
        }
    });

    it("429 / 401 沿用标准状态码分类", () => {
        assert.throws(() => rethrowTavilyError(axiosLike(429)), (err: Error) => isQuotaError(err));
        assert.throws(() => rethrowTavilyError(axiosLike(401)), (err: Error) => isAuthError(err));
    });

    it("非 Error 值也会被包装成 Error 抛出", () => {
        assert.throws(() => rethrowTavilyError("boom"), (err: Error) => err instanceof Error && err.message === "boom");
    });
});
