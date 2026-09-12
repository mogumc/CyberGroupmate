/**
 * tests/grounding-rotation.test.ts — Grounding 多 Key 轮询行为
 *
 * 这里不测「联网查得到什么」，只测失败路径的分支：
 * 什么情况该换 key、什么情况坚决不换、全挂了会不会把 dispatch 带崩。
 *
 * 手法：用 grok provider（走原生 fetch）+ 打桩 globalThis.fetch，无需真实 Key。
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearAllPools } from "../src/core/llm-pool.js";
import { runParallelGrounding } from "../src/main-agent/grounding-util.js";
import type { GroundingConfig, PoolConfig } from "../src/core/config.js";

/** 足够长、且不含冒号，避免被 sanitizeForGrounding 当成人名替换 */
const MESSAGES = "群里在讨论某个开源项目的最新版本号以及它的发布时间";

function grokConfig(members: string[], strategy: PoolConfig["strategy"] = "round_robin"): GroundingConfig {
    return {
        provider: "grok",
        apiKey: "",
        pool: { strategy, members: members.map(apiKey => ({ apiKey })) },
    };
}

/** 记录每次请求用的 key，并按下标指定各自的响应 */
function stubFetch(responses: Array<{ status: number; body?: unknown }>): string[] {
    const usedKeys: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
        const auth = String((init.headers as Record<string, string>).Authorization);
        usedKeys.push(auth.replace("Bearer ", ""));
        const plan = responses[Math.min(usedKeys.length - 1, responses.length - 1)];
        return new Response(plan.body === undefined ? "" : JSON.stringify(plan.body), {
            status: plan.status,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;
    return usedKeys;
}

/** grok 正常返回：必须带 web_search_call，否则会被 Guardrail 丢掉 */
const GROK_OK = {
    output: [
        { type: "web_search_call" },
        { type: "message", content: [{ type: "output_text", text: "查证结论" }] },
    ],
};

/** 有回答但没联网 —— Guardrail 应丢弃 */
const GROK_NO_SEARCH = {
    output: [{ type: "message", content: [{ type: "output_text", text: "我猜是这样" }] }],
};

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    clearAllPools();
});

describe("runParallelGrounding 多 Key 轮询", () => {
    it("429 时自动换下一个 key 并返回结果", async () => {
        const used = stubFetch([{ status: 429 }, { status: 200, body: GROK_OK }]);

        const text = await runParallelGrounding(grokConfig(["key-a-0000", "key-b-0000"]), MESSAGES);

        assert.equal(text, "查证结论");
        assert.deepEqual(used, ["key-a-0000", "key-b-0000"], "应先用 a，被限流后换 b");
    });

    it("401 认证失败同样换 key", async () => {
        const used = stubFetch([{ status: 401 }, { status: 200, body: GROK_OK }]);

        const text = await runParallelGrounding(grokConfig(["key-c-0000", "key-d-0000"]), MESSAGES);

        assert.equal(text, "查证结论");
        assert.deepEqual(used, ["key-c-0000", "key-d-0000"]);
    });

    it("所有 key 都失败时返回 undefined，不抛异常（不能拖垮 dispatch）", async () => {
        const used = stubFetch([{ status: 429 }, { status: 429 }]);

        const text = await runParallelGrounding(grokConfig(["key-e-0000", "key-f-0000"]), MESSAGES);

        assert.equal(text, undefined);
        assert.equal(used.length, 2, "两个 key 各试一次后放弃");
    });

    it("非配额错误（400）不换 key —— 换 key 也救不了参数错误", async () => {
        const used = stubFetch([{ status: 400, body: { error: "bad request" } }]);

        const text = await runParallelGrounding(grokConfig(["key-g-0000", "key-h-0000"]), MESSAGES);

        assert.equal(text, undefined);
        assert.equal(used.length, 1, "只打一次，不应浪费第二个 key");
    });

    it("Guardrail 丢弃（没联网）不换 key —— key 是好的，是模型没搜", async () => {
        const used = stubFetch([{ status: 200, body: GROK_NO_SEARCH }]);

        const text = await runParallelGrounding(grokConfig(["key-i-0000", "key-j-0000"]), MESSAGES);

        assert.equal(text, undefined);
        assert.equal(used.length, 1, "健康 key 不该因为模型没搜就被轮掉");
    });

    it("没配任何 key 时直接跳过，不发请求", async () => {
        const used = stubFetch([{ status: 200, body: GROK_OK }]);

        const text = await runParallelGrounding({ provider: "grok", apiKey: "" }, MESSAGES);

        assert.equal(text, undefined);
        assert.equal(used.length, 0);
    });

    it("只配单个 apiKey（无 pool）时照常工作", async () => {
        const used = stubFetch([{ status: 200, body: GROK_OK }]);

        const text = await runParallelGrounding({ provider: "grok", apiKey: "solo-key-0000" }, MESSAGES);

        assert.equal(text, "查证结论");
        assert.deepEqual(used, ["solo-key-0000"]);
    });
});
