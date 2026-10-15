import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    ConversationManager,
    ConversationDeleteError,
    describeDeleteReason,
    recordKey,
    resolveAuditCutoffIso,
    resolveAuditRetention,
    DEFAULT_AUDIT_DAYS,
    DEFAULT_AUDIT_LIMIT,
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

describe("审计清理（单条 / 按时间 / 全量）", () => {
    /** 固定"现在"，避免 Date.now() 在断言之间漂移。 */
    const FIXED_NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
    const DAY = 24 * 60 * 60 * 1000;

    /** 直接写审计文件，造一条"deletedAt = FIXED_NOW - days 天"的记录。 */
    function seedFile(auditPath: string, entries: Array<{ chatId: string; days: number; id?: string }>) {
        const records = entries.map((e, i) => ({
            id: e.id ?? `id-${i}`,
            chatId: e.chatId,
            reasonCode: "ad",
            reason: "广告 / 推广刷屏",
            deletedAt: new Date(FIXED_NOW - e.days * DAY).toISOString(),
            deleted: { memoryTopics: 0, topics: 0, messages: 1, runtimeInstance: true, sessionFile: false, groupModel: true },
        }));
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.writeFileSync(auditPath, JSON.stringify(records, null, 2), "utf-8");
    }

    function makeManager(auditPath: string, retention?: { auditDays?: number; auditLimit?: number }) {
        return new ConversationManager({
            memory: createFakeStore(),
            subagentManager: createFakeRuntime(null),
            accumulator: { remove: () => {} },
            auditPath,
            auditRetention: retention,
            now: () => FIXED_NOW,
        });
    }

    it("默认保留 14 天 / 200 条", () => {
        const resolved = resolveAuditRetention(undefined);
        assert.equal(resolved.auditDays, DEFAULT_AUDIT_DAYS);
        assert.equal(resolved.auditDays, 14);
        assert.equal(resolved.auditLimit, DEFAULT_AUDIT_LIMIT);
        // 非法值回退默认；0 是合法值（关闭清理）
        assert.equal(resolveAuditRetention({ auditDays: -1 }).auditDays, 14);
        assert.equal(resolveAuditRetention({ auditDays: 0 }).auditDays, 0);
        assert.equal(resolveAuditRetention({ auditLimit: 0 }).auditLimit, 0);
    });

    it("cutoff 按天回推；days<=0 返回 null", () => {
        const now = Date.UTC(2026, 0, 20);
        assert.equal(resolveAuditCutoffIso(14, now), new Date(Date.UTC(2026, 0, 6)).toISOString());
        assert.equal(resolveAuditCutoffIso(0, now), null);
        assert.equal(resolveAuditCutoffIso(-3, now), null);
    });

    it("超过保留期的记录不出现在 listAudit，且被 sweepAudit 物理清掉", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [
            { chatId: "telegram:old", days: 20 },
            { chatId: "telegram:new", days: 1 },
        ]);
        const manager = makeManager(auditPath);

        assert.deepEqual(manager.listAudit().map((r) => r.chatId), ["telegram:new"], "读取时过滤过期");
        assert.equal(manager.countAudit(), 1);

        const removed = manager.sweepAudit();
        assert.equal(removed, 1, "sweep 应物理删掉 1 条");
        const onDisk = JSON.parse(fs.readFileSync(auditPath, "utf-8"));
        assert.equal(onDisk.length, 1, "磁盘上只剩未过期的那条");
        assert.equal(onDisk[0].chatId, "telegram:new");
    });

    it("写入时顺带物理丢弃过期记录（无需等 sweep）", async () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [{ chatId: "telegram:old", days: 20 }]);
        const manager = makeManager(auditPath);

        await manager.delete("telegram:fresh", { reasonCode: "ad" });
        const onDisk = JSON.parse(fs.readFileSync(auditPath, "utf-8"));
        assert.deepEqual(onDisk.map((r: { chatId: string }) => r.chatId), ["telegram:fresh"]);
    });

    it("auditDays=0 时永久保留，sweepAudit 不动作", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [{ chatId: "telegram:ancient", days: 999 }]);
        const manager = makeManager(auditPath, { auditDays: 0 });

        assert.equal(manager.listAudit().length, 1, "永久保留：不过滤");
        assert.equal(manager.sweepAudit(), 0);
        assert.equal(JSON.parse(fs.readFileSync(auditPath, "utf-8")).length, 1);
    });

    it("auditLimit=0 表示不限条数", async () => {
        const auditPath = makeAuditPath();
        const manager = makeManager(auditPath, { auditLimit: 0 });
        for (let i = 0; i < 5; i++) await manager.delete(`telegram:${i}`, { reasonCode: "ad" });
        assert.equal(manager.listAudit(999).length, 5);
    });

    it("超上限时截断最旧的记录", async () => {
        const auditPath = makeAuditPath();
        const manager = makeManager(auditPath, { auditLimit: 3 });
        for (let i = 0; i < 5; i++) await manager.delete(`telegram:${i}`, { reasonCode: "ad" });
        const kept = manager.listAudit(999).map((r) => r.chatId);
        assert.deepEqual(kept, ["telegram:4", "telegram:3", "telegram:2"], "保留最新的 3 条");
    });

    it("purgeAudit 单条删除（按 id），不牵连其它记录", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [
            { chatId: "telegram:a", days: 1, id: "keep-a" },
            { chatId: "telegram:b", days: 2, id: "drop-b" },
            { chatId: "telegram:expired", days: 30, id: "expired-c" }, // 不可见，但必须保留
        ]);
        const manager = makeManager(auditPath);

        assert.equal(manager.purgeAudit({ id: "drop-b" }), 1);
        assert.deepEqual(
            JSON.parse(fs.readFileSync(auditPath, "utf-8")).map((r: { chatId: string }) => r.chatId),
            ["telegram:a", "telegram:expired"],
            "删单条不该波及过期的无关记录",
        );
    });

    it("purgeAudit 按时间清理：恰好等于 cutoff 的记录保留", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [
            { chatId: "telegram:old", days: 10 },
            { chatId: "telegram:new", days: 1 },
        ]);
        const manager = makeManager(auditPath);

        // cutoff 恰好等于 old 的 deletedAt —— 严格小于才删，所以保留
        const cutoffExact = new Date(FIXED_NOW - 10 * DAY).toISOString();
        assert.equal(manager.purgeAudit({ before: cutoffExact }), 0, "恰好等于 cutoff 不删");

        const cutoffLater = new Date(FIXED_NOW - 9 * DAY).toISOString();
        assert.equal(manager.purgeAudit({ before: cutoffLater }), 1, "严格早于才删");
        assert.deepEqual(manager.listAudit(999).map((r) => r.chatId), ["telegram:new"]);
    });

    // 回归：purgeAudit 必须作用于磁盘全部记录，而非 listAudit 那份"已按保留期过滤"的视图。
    // 用过滤后的视图做删除决策会导致 before 落在可见窗口外时静默失效。
    it("purgeAudit 能清理【已过期】记录（before 落在可见窗口外）", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [
            { chatId: "telegram:old", days: 20 }, // 超出 14 天保留期 → listAudit 看不见
            { chatId: "telegram:new", days: 1 },
        ]);
        const manager = makeManager(auditPath);
        assert.equal(manager.listAudit(999).length, 1, "前置：old 确实不在可见窗口内");

        const removed = manager.purgeAudit({ before: new Date(FIXED_NOW - 14 * DAY).toISOString() });
        assert.equal(removed, 1, "过期的 old 必须被清掉，且如实上报");
        assert.deepEqual(JSON.parse(fs.readFileSync(auditPath, "utf-8")).map((r: { chatId: string }) => r.chatId), ["telegram:new"]);
    });

    it("purgeAudit 的 removed 等于磁盘实际减少条数，且不牵连未命中的过期记录", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [
            { chatId: "old", days: 60 },    // 命中（60 天前 < 30 天前）
            { chatId: "expired", days: 20 }, // 未命中，但已过期（不可见）
            { chatId: "fresh", days: 1 },    // 未命中
        ]);
        const manager = makeManager(auditPath);
        const beforeCount = JSON.parse(fs.readFileSync(auditPath, "utf-8")).length;

        const removed = manager.purgeAudit({ before: new Date(FIXED_NOW - 30 * DAY).toISOString() });
        const afterCount = JSON.parse(fs.readFileSync(auditPath, "utf-8")).length;

        assert.equal(removed, 1, "只有 old 命中 before");
        assert.equal(beforeCount - afterCount, removed, "removed 必须等于磁盘实际减少量");
        assert.deepEqual(
            JSON.parse(fs.readFileSync(auditPath, "utf-8")).map((r: { chatId: string }) => r.chatId),
            ["expired", "fresh"],
            "未命中的 expired 不该被连带抹掉（它的去留属于 sweepAudit 的职责）",
        );
    });

    it("purgeAudit 无 filter = 全清，文件被删掉且不留痕", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [
            { chatId: "telegram:a", days: 1 },
            { chatId: "telegram:b", days: 2 },
        ]);
        const manager = makeManager(auditPath);

        assert.equal(manager.purgeAudit(), 2);
        assert.equal(fs.existsSync(auditPath), false, "全清后文件应被删除");
        assert.equal(manager.listAudit().length, 0);
        assert.equal(manager.purgeAudit(), 0, "已空时再清返回 0 且不报错");
    });

    it("全清时即使记录全部已过期，也必须删掉文件", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [
            { chatId: "a", days: 20 },
            { chatId: "b", days: 60 },
        ]);
        const manager = makeManager(auditPath);
        assert.equal(manager.listAudit(999).length, 0, "前置：全都不可见");

        assert.equal(manager.purgeAudit(), 2, "可见数为 0 不代表磁盘为空");
        assert.equal(fs.existsSync(auditPath), false);
    });

    it("purgeAudit 拒绝非法 before，且不碰任何数据", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [
            { chatId: "a", days: 1 },
            { chatId: "b", days: 3 },
            { chatId: "c", days: 5 },
        ]);
        const manager = makeManager(auditPath);
        const before = fs.readFileSync(auditPath, "utf-8");

        // 直接做字符串比较时 "2026-…Z" < "garbage" 恒为真 → 会被静默变成「全清」。
        for (const bad of ["garbage", "2026-13-45", "not a date"]) {
            assert.throws(
                () => manager.purgeAudit({ before: bad }),
                (err: unknown) => err instanceof ConversationDeleteError && err.code === "invalid_before",
                `before=${JSON.stringify(bad)} 必须被拒绝`,
            );
        }
        assert.equal(fs.readFileSync(auditPath, "utf-8"), before, "校验失败时数据必须原封不动");
    });

    it("purgeAudit 归一化 before：等价的非 ISO 写法行为一致", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [
            { chatId: "old", days: 10 },
            { chatId: "new", days: 1 },
        ]);
        const manager = makeManager(auditPath);

        // 同一时刻的三种写法（ISO / 去毫秒 / 本地化）必须等价
        const iso = new Date(FIXED_NOW - 2 * DAY).toISOString();
        const noMs = iso.replace(".000Z", "Z");
        assert.equal(manager.purgeAudit({ before: noMs }), 1, "去毫秒的写法应等价");
        assert.deepEqual(JSON.parse(fs.readFileSync(auditPath, "utf-8")).map((r: { chatId: string }) => r.chatId), ["new"]);
    });

    it("before 为空串时抛错，绝不退化成全清", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [{ chatId: "a", days: 1 }]);
        const manager = makeManager(auditPath);

        // 空串不是合法时间 → 必须抛错。若退化成全清，一个 `?before=` 就能毁掉全部审计。
        assert.throws(
            () => manager.purgeAudit({ before: "" }),
            (err: unknown) => err instanceof ConversationDeleteError && err.code === "invalid_before",
        );
        assert.equal(fs.existsSync(auditPath), true, "数据必须原封不动");
    });

    it("recordKey 兼容没有 id 的旧记录", () => {
        const legacy = { chatId: "telegram:1", deletedAt: "2026-01-01T00:00:00.000Z" } as never;
        assert.equal(recordKey(legacy), "telegram:1@2026-01-01T00:00:00.000Z");
    });

    it("配置 getter 热生效：切到永久保留后过期记录不再被过滤", () => {
        const auditPath = makeAuditPath();
        seedFile(auditPath, [{ chatId: "telegram:old", days: 20 }]);
        let days = 14;
        const manager = new ConversationManager({
            memory: createFakeStore(),
            subagentManager: createFakeRuntime(null),
            accumulator: { remove: () => {} },
            auditPath,
            auditRetention: () => ({ auditDays: days }),
            now: () => FIXED_NOW,
        });

        assert.equal(manager.listAudit().length, 0, "14 天策略下被过滤");
        days = 0; // 模拟 Dashboard 改成永久保留
        assert.equal(manager.listAudit().length, 1, "改配置后立刻生效，无需重启");
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
