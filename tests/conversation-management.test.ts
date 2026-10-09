import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    ConversationManager,
    ConversationDeleteError,
    describeDeleteReason,
    DELETE_REASON_PRESETS,
} from "../src/core/conversation-manager.js";
import {
    resolveCutoffIso,
    resolveMessageRetention,
    sweepMessageLog,
} from "../src/core/message-retention.js";

/** 记录调用顺序的假 store：只为断言"哪些被清、哪些没被碰"。 */
function createFakeStore() {
    const calls: string[] = [];
    return {
        calls,
        deleteTopicsByChat: (chatId: string) => { calls.push(`topics:${chatId}`); return 3; },
        deleteMessagesByChat: (chatId: string) => { calls.push(`messages:${chatId}`); return 42; },
        deleteGroupModel: (chatId: string) => { calls.push(`group:${chatId}`); return true; },
        countMessagesByChat: () => 42,
        countTopicsByChat: () => 3,
        listKnownChatIds: () => [] as string[],
        listGroupModels: () => [] as Array<{ chatId: string; chatTitle?: string }>,
        getRecentMessages: () => [] as Array<{ timestamp: string }>,
    };
}

function createFakeRuntime(sessionFile: string | null) {
    const removed: string[] = [];
    const cancelled: string[] = [];
    let purged = 0;
    return {
        removed,
        cancelled,
        getPurged: () => purged,
        get: (chatId: string) => ({
            topicRegistry: { purgeChat: () => { purged = 2; return 2; } },
            codeActExecutor: {
                cancelCurrentRun: async () => { cancelled.push(chatId); },
                isProcessing: () => false,
            },
        }),
        remove: (chatId: string) => { removed.push(chatId); return true; },
        getAllSubagents: () => [] as Array<{ chatId: string }>,
        getSessionFilePath: () => sessionFile ?? "",
    };
}

const tmpDirs: string[] = [];
function makeAuditPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-mgmt-"));
    tmpDirs.push(dir);
    return path.join(dir, "deletions.json");
}

after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("会话删除理由校验", () => {
    let manager: ConversationManager;

    beforeEach(() => {
        manager = new ConversationManager({
            memory: createFakeStore(),
            subagentManager: createFakeRuntime(null),
            accumulator: { remove: () => {} },
            auditPath: makeAuditPath(),
        });
    });

    it("缺理由时拒绝删除", async () => {
        await assert.rejects(manager.delete("telegram:1", { reasonCode: "" }), (err: unknown) => {
            assert.ok(err instanceof ConversationDeleteError);
            assert.equal(err.code, "reason_required");
            return true;
        });
    });

    it("未知理由码被拒绝", async () => {
        await assert.rejects(manager.delete("telegram:1", { reasonCode: "whatever" }), (err: unknown) => {
            assert.ok(err instanceof ConversationDeleteError);
            assert.equal(err.code, "invalid_reason");
            return true;
        });
    });

    it("理由选 other 时必须补文字说明", async () => {
        await assert.rejects(manager.delete("telegram:1", { reasonCode: "other" }), (err: unknown) => {
            assert.equal((err as ConversationDeleteError).code, "reason_required");
            return true;
        });
        // 补了说明就放行
        await manager.delete("telegram:1", { reasonCode: "other", reasonText: "自建测试" });
    });

    it("所有预设理由码都能用", async () => {
        for (const preset of DELETE_REASON_PRESETS) {
            const record = await manager.delete(`telegram:${preset.code}`, {
                reasonCode: preset.code,
                reasonText: preset.code === "other" ? "补充" : undefined,
            });
            assert.equal(record.reasonCode, preset.code);
            assert.ok(record.reason.includes(preset.label));
        }
    });

    it("describeDeleteReason 拼接标签与补充说明", () => {
        assert.equal(describeDeleteReason("ad"), "广告 / 推广刷屏");
        assert.equal(describeDeleteReason("ad", "   "), "广告 / 推广刷屏");
        assert.equal(describeDeleteReason("ad", "每天十条"), "广告 / 推广刷屏：每天十条");
    });
});

describe("会话删除级联", () => {
    it("按顺序清运行时/内存话题/DB 话题/消息/群组画像，并写审计", async () => {
        const store = createFakeStore();
        const runtime = createFakeRuntime(null);
        const auditPath = makeAuditPath();
        const manager = new ConversationManager({
            memory: store,
            subagentManager: runtime,
            accumulator: { remove: () => {} },
            auditPath,
        });

        const record = await manager.delete("telegram:-100", { reasonCode: "too_long" });

        assert.deepEqual(runtime.cancelled, ["telegram:-100"], "删除前必须取消进行中的 CodeAct");
        assert.equal(runtime.getPurged(), 2, "内存话题应被清空");
        assert.deepEqual(runtime.removed, ["telegram:-100"], "运行时实例应被销毁");
        assert.deepEqual(store.calls, [
            "topics:telegram:-100",
            "messages:telegram:-100",
            "group:telegram:-100",
        ]);
        assert.deepEqual(record.deleted, {
            memoryTopics: 2,
            topics: 3,
            messages: 42,
            runtimeInstance: true,
            sessionFile: false,
            groupModel: true,
        });
        assert.equal(record.failures, undefined, "全部成功时不应有 failures");

        const audit = manager.listAudit();
        assert.equal(audit.length, 1);
        assert.equal(audit[0].chatId, "telegram:-100");
        assert.equal(audit[0].reasonCode, "too_long");
    });

    it("某一步失败时不中断后续步骤，并写进 failures 与审计", async () => {
        const store = createFakeStore();
        const brokenStore = {
            ...store,
            deleteTopicsByChat: () => { throw new Error("db locked"); },
        };
        const auditPath = makeAuditPath();
        const manager = new ConversationManager({
            memory: brokenStore,
            subagentManager: createFakeRuntime(null),
            accumulator: { remove: () => {} },
            auditPath,
        });

        const record = await manager.delete("telegram:x", { reasonCode: "ad" });

        assert.equal(record.deleted.topics, 0, "失败步骤回退默认值");
        assert.ok(store.calls.includes("messages:telegram:x"), "后续步骤仍应执行");
        assert.ok(store.calls.includes("group:telegram:x"));
        assert.equal(record.failures?.length, 1);
        assert.match(record.failures![0], /^deleteTopics: /);

        const audit = manager.listAudit();
        assert.equal(audit.length, 1, "部分删除也必须留下审计");
        assert.equal(audit[0].failures?.length, 1);
    });

    it("不存在 session 文件时不报错，audit 最新在前", async () => {
        const manager = new ConversationManager({
            memory: createFakeStore(),
            subagentManager: createFakeRuntime(null),
            accumulator: { remove: () => {} },
            auditPath: makeAuditPath(),
        });
        await manager.delete("telegram:a", { reasonCode: "ad" });
        await manager.delete("telegram:b", { reasonCode: "inactive" });
        const audit = manager.listAudit();
        assert.deepEqual(audit.map((r) => r.chatId), ["telegram:b", "telegram:a"]);
    });

    it("群组画像 key 走 Discord 归并（channel → guild）", async () => {
        const store = createFakeStore();
        const manager = new ConversationManager({
            memory: store,
            subagentManager: createFakeRuntime(null),
            accumulator: { remove: () => {} },
            auditPath: makeAuditPath(),
        });
        await manager.delete("discord:guild1:chan2", { reasonCode: "no_need" });
        assert.ok(store.calls.includes("group:discord:guild1"), `期望归并到 guild，实际：${store.calls.join()}`);
    });
});

describe("原始消息定期保留", () => {
    it("days<=0 时不清理（永久保存语义）", () => {
        const calls: string[] = [];
        const deleted = sweepMessageLog({
            memory: { pruneMessagesBefore: (cutoff) => { calls.push(cutoff); return 5; } },
            config: { messageLogDays: 0 },
        });
        assert.equal(deleted, 0);
        assert.deepEqual(calls, [], "关闭时不应触碰存储");
    });

    it("cutoff 按天回推；非法值回退默认 7 天", () => {
        const now = Date.UTC(2026, 0, 10, 0, 0, 0);
        assert.equal(resolveCutoffIso(7, now), new Date(Date.UTC(2026, 0, 3)).toISOString());
        assert.equal(resolveCutoffIso(0, now), null);
        assert.equal(resolveCutoffIso(-1, now), null);

        const resolved = resolveMessageRetention({ messageLogDays: -3, sweepIntervalHours: 0 });
        assert.equal(resolved.messageLogDays, 7, "负数天数回退默认");
        assert.equal(resolved.sweepIntervalHours, 6, "非正数间隔回退默认");
        assert.equal(resolved.enabled, true);
    });

    it("恰好等于 cutoff 的消息保留（严格小于才删）", () => {
        const now = Date.UTC(2026, 0, 10);
        const cutoffMs = now - 24 * 60 * 60 * 1000;
        // 三条消息：早 1ms / 恰好 cutoff / 晚 1ms
        const timestamps = [cutoffMs - 1, cutoffMs, cutoffMs + 1];

        const deleted = sweepMessageLog({
            memory: {
                pruneMessagesBefore: (cutoff) => {
                    const cutoffParsed = Date.parse(cutoff);
                    return timestamps.filter((t) => t < cutoffParsed).length;
                },
            },
            config: { messageLogDays: 1 },
            now: () => now,
        });

        assert.equal(deleted, 1, "只有严格早于 cutoff 的消息会被删");
    });
});
