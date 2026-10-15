/**
 * conversation-manager.ts — 会话级管理（屏蔽 / 移除）
 *
 * 「移除不需要的对话」的执行者：按固定顺序级联清理一个会话在各处的痕迹。
 *
 * 级联顺序（缺一不可）：
 *   1. 取消在途 CodeAct → 2. 内存话题（TopicRegistry）→ 3. 销毁运行时实例（Subagent）
 *   → 4. DB 话题（topics + topics_fts + topics_vec）
 *   → 5. 原始消息（message_log）→ 6. attention / signal pool
 *   → 7. session 文件 → 8. 群组画像（group_models）→ 9. 写审计
 *
 * **明确不动**：core_facts / person_identities / person_profiles /
 * person_group_profiles / interactions / session_digests —— 这些是沉淀后的长期记忆，
 * 会话删除不牵连（用户想删可走记忆面板各自的删除入口）。
 *
 * 审计（`workspace/conversation-deletions.json`）默认只保留最近
 * `DEFAULT_AUDIT_DAYS` 天：过期记录在读取时被过滤、在下次写入时物理丢弃；
 * 另提供 `purgeAudit()` 支持单条 / 按时间 / 全量清空（清空后不留痕）。
 * 保留天数与条数上限走 `config.retention.audit_days` / `audit_limit`。
 *
 * 设计约束：依赖以窄接口注入（与 meta-api/conversations.ts 同一风格），
 * 便于单测与避免与上游改动正面相撞。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "./logger.js";
import { safeGroupModelKey } from "./chat-id.js";
import type { RetentionConfig } from "./config.js";

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

// ─── 审计保留策略 ───

/**
 * 审计默认保留天数。与 message_log 的 7 天不同 —— 审计是"谁在什么时候删了什么"的
 * 唯一凭据，删了就再也查不回来，所以给到两周；0 表示永久保留。
 */
export const DEFAULT_AUDIT_DAYS = 14;
/** 审计默认条数上限（防止单日批量删除把文件撑爆）。0 表示不限。 */
export const DEFAULT_AUDIT_LIMIT = 200;

/** 解析后的审计保留策略。 */
export interface ResolvedAuditRetention {
    auditDays: number;
    auditLimit: number;
}

/**
 * 解析审计保留配置：缺省 14 天 / 200 条；非法值回退默认。
 * 与 message-retention 的 `resolveMessageRetention` 同风格（天数允许 0 = 关闭清理）。
 */
export function resolveAuditRetention(config?: RetentionConfig): ResolvedAuditRetention {
    return {
        auditDays: normalizeNonNegative(config?.auditDays, DEFAULT_AUDIT_DAYS),
        auditLimit: normalizeNonNegative(config?.auditLimit, DEFAULT_AUDIT_LIMIT),
    };
}

/** 天数允许 0（表示不清理），所以只要求非负。 */
function normalizeNonNegative(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** 计算审计的 cut-off（ISO）。days<=0 返回 null，表示不按时间清理。 */
export function resolveAuditCutoffIso(days: number, nowMs: number = Date.now()): string | null {
    if (!Number.isFinite(days) || days <= 0) return null;
    return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

/** 审计默认扫描间隔（小时）—— 过期记录多久被物理清一次。 */
export const DEFAULT_AUDIT_SWEEP_HOURS = 6;

/**
 * 启动审计定期清理，返回停止函数。
 *
 * `readAudit` 只在读取时过滤过期记录，磁盘上的旧数据要等下次写入才消失；
 * 没有新删除发生时就会一直留着。本定时器负责把过期记录真正清掉。
 *
 * 定时器**始终创建**，是否清理交给 `sweepAudit()` 每次读配置决定 ——
 * 这样 Dashboard 把 `audit_days` 从 0 改成 14（或反向）无需重启即可生效。
 *
 * 定时器写法对齐 main.ts 既有的 topicCleanupInterval / startMessageRetention。
 */
export function startAuditRetention(manager: { sweepAudit(): number }): () => void {
    const timer = setInterval(() => {
        try {
            manager.sweepAudit();
        } catch (err) {
            log.warn("审计定期清理失败", { error: String(err) });
        }
    }, DEFAULT_AUDIT_SWEEP_HOURS * 60 * 60 * 1000);
    if (typeof timer.unref === "function") timer.unref();
    log.info("审计定期清理已启动", { intervalHours: DEFAULT_AUDIT_SWEEP_HOURS });
    return () => clearInterval(timer);
}

/** 删除被拒（理由缺失/非法、会话不存在、审计清理参数非法等）。 */
export class ConversationDeleteError extends Error {
    constructor(
        message: string,
        readonly code: "reason_required" | "invalid_reason" | "not_found" | "invalid_before" = "reason_required",
    ) {
        super(message);
        this.name = "ConversationDeleteError";
    }
}

/**
 * 校验并归一化审计清理的 `before`。
 *
 * 必须归一化：`deletedAt` 一律是 `toISOString()` 的输出，而 `before` 来自外部
 * （HTTP query / 直接调用），格式不保证一致。直接做字符串比较时
 * `"2026-01-01T00:00:00.000Z" < "garbage"` 恒为真 —— 「按时间清理」会被静默变成「全清」。
 * 非法值必须抛错而不是返回 0：静默 no-op 会让人以为清过了（这正是上一轮修掉的错误类型）。
 */
function normalizeAuditBefore(before: string): string {
    const ms = Date.parse(before);
    if (!Number.isFinite(ms)) {
        throw new ConversationDeleteError(`before 不是合法时间：${before}`, "invalid_before");
    }
    return new Date(ms).toISOString();
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
    /**
     * 审计保留策略。支持传 getter（`() => loadConfig().retention`）以在
     * Dashboard 保存配置后热生效 —— 与 grounding 的 `GroundingConfigSource` 同思路。
     * 缺省用 DEFAULT_AUDIT_DAYS（14）/ DEFAULT_AUDIT_LIMIT（200）。
     */
    auditRetention?: RetentionConfig | (() => RetentionConfig | undefined);
    /** 覆盖"现在"（测试用） */
    now?: () => number;
}

// ─── 记录 ───

export interface ConversationDeletionRecord {
    /** 稳定标识（purgeAudit 按它做单条删除）。旧记录可能没有，读取时用 chatId+deletedAt 兜底。 */
    id?: string;
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

/** 审计清理条件。全部缺省 = 全清。 */
export interface AuditPurgeFilter {
    /** 只删 `deletedAt < before` 的记录（ISO，严格小于） */
    before?: string;
    /** 只删这一条（recordKey 的结果：id，或旧记录的 chatId@deletedAt） */
    id?: string;
}

// ─── 实现 ───

export class ConversationManager {
    private readonly memory: ConversationStore;
    private readonly runtime: ConversationRuntime;
    private readonly accumulator: { remove(chatId: string): void };
    private readonly auditPath: string;
    private readonly auditRetentionSource: RetentionConfig | (() => RetentionConfig | undefined) | undefined;
    private readonly now: () => number;

    constructor(options: ConversationManagerOptions) {
        this.memory = options.memory;
        this.runtime = options.subagentManager;
        this.accumulator = options.accumulator;
        this.auditPath = options.auditPath ?? path.join("workspace", "conversation-deletions.json");
        this.auditRetentionSource = options.auditRetention;
        this.now = options.now ?? Date.now;
    }

    /** 每次读写审计时重新解析，使 Dashboard 保存的保留策略能热生效。 */
    private auditPolicy(): ResolvedAuditRetention {
        const source = typeof this.auditRetentionSource === "function"
            ? this.auditRetentionSource()
            : this.auditRetentionSource;
        return resolveAuditRetention(source);
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
            id: randomUUID(),
            chatId: id,
            chatTitle: input?.chatTitle?.trim() || undefined,
            reasonCode: code,
            reasonText,
            reason: describeDeleteReason(code, reasonText),
            deletedAt: new Date(this.now()).toISOString(),
            deleted: { memoryTopics, topics, messages, runtimeInstance, sessionFile, groupModel },
            ...(failures.length > 0 ? { failures } : {}),
        };

        this.appendAudit(record);
        log.info("会话已移除", { ...record.deleted, chatId: id, reasonCode: code, failures: failures.length });
        return record;
    }

    /**
     * 读取审计记录（最新在前）。已按 `auditDays` 过滤掉过期记录 ——
     * 过期记录在下次 `appendAudit` / `sweepAudit` / `purgeAudit` 时会被物理丢弃。
     */
    listAudit(limit = 50): ConversationDeletionRecord[] {
        return this.readAudit().slice(0, Math.max(1, limit));
    }

    /** 审计记录总数（已按保留期过滤，与 listAudit 同源）。 */
    countAudit(): number {
        return this.readAudit().length;
    }

    /**
     * 物理丢弃过期审计记录。`readAudit` 只是过滤，文件里的过期记录要等下一次
     * 写入才消失；没有新删除发生时就会一直躺在磁盘上。定时调用本方法补上这一步。
     *
     * 返回删除条数。`auditDays <= 0`（永久保留）时不动作。
     */
    sweepAudit(): number {
        const { auditDays } = this.auditPolicy();
        const cutoff = resolveAuditCutoffIso(auditDays, this.now());
        if (!cutoff) return 0;

        const raw = this.readAuditRaw();
        const keep = raw.filter((rec) => !rec.deletedAt || rec.deletedAt >= cutoff);
        const removed = raw.length - keep.length;
        if (removed === 0) return 0;
        try {
            this.writeAudit(keep);
        } catch (err) {
            log.warn("审计清理失败", { auditPath: this.auditPath, error: String(err) });
            return 0;
        }
        log.info("已清理过期审计记录", { removed, remaining: keep.length, keepDays: auditDays });
        return removed;
    }

    /**
     * 清空审计。
     *
     * - 无 filter：全清（物理删除整个文件，readAudit 对不存在的文件返回空）。
     * - `before`：删除 `deletedAt < before` 的记录（**严格小于**，与
     *   `message-retention` 的 cutoff 语义一致 —— 恰好等于的记录保留）。
     * - `id`：只删一条。
     *
     * 返回实际删除条数。全清不留任何痕迹（不做"清空本身也记一笔"的反向审计）。
     *
     * ⚠️ 操作对象是**磁盘上的全部记录**（`readAuditRaw`），不是 `listAudit` 那份
     * 已按保留期过滤的视图 —— 否则 `before` 一旦落在可见窗口外就会静默失效，
     * 落在窗口内又会把过期记录连带抹掉却不上报。
     *
     * `before` 非法（含空串）抛 `ConversationDeleteError("invalid_before")`，不碰数据。
     * 只有**完全不传** `before` / `id` 才是"全清"—— 参数存在但无效绝不退化成全清。
     */
    purgeAudit(filter?: AuditPurgeFilter): number {
        const all = this.readAuditRaw();

        // 先归一化，让非法 before 在动数据之前就失败。
        const before = filter?.before != null ? normalizeAuditBefore(filter.before) : undefined;
        const id = filter?.id?.trim() || undefined;
        const hasFilter = id != null || before != null;

        // 全清：无 filter 时不做逐条比对，keep 直接为空。
        const keep = hasFilter
            ? all.filter((rec) => {
                if (id != null && recordKey(rec) === id) return false;
                if (before != null && rec.deletedAt && rec.deletedAt < before) return false;
                return true;
            })
            : [];
        const removed = all.length - keep.length;
        if (removed === 0) return 0;

        try {
            this.writeAudit(keep); // keep 为空时内部会删掉文件
        } catch (err) {
            log.warn("审计清理失败", { auditPath: this.auditPath, error: String(err) });
            return 0;
        }
        log.info(hasFilter ? "审计已部分清理" : "审计已清空", { removed, remaining: keep.length });
        return removed;
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

    /**
     * 读取磁盘上的**全部**审计记录（不过滤保留期）。
     *
     * 这是"真实状态"的唯一来源，供删除决策（`purgeAudit` / `sweepAudit`）使用；
     * 展示请走 `readAudit()`。二者刻意分开：过滤是展示策略，不该参与删除决策。
     * 文件不存在 / 解析失败一律返回空数组 —— 审计是旁路数据，不能拖垮主流程。
     */
    private readAuditRaw(): ConversationDeletionRecord[] {
        try {
            if (!fs.existsSync(this.auditPath)) return [];
            const raw = JSON.parse(fs.readFileSync(this.auditPath, "utf-8"));
            return Array.isArray(raw) ? (raw as ConversationDeletionRecord[]) : [];
        } catch (err) {
            log.warn("审计读取失败", { auditPath: this.auditPath, error: String(err) });
            return [];
        }
    }

    /** 展示视图：在 `readAuditRaw()` 之上按 `auditDays` 过滤掉过期记录。 */
    private readAudit(): ConversationDeletionRecord[] {
        const parsed = this.readAuditRaw();
        const cutoff = resolveAuditCutoffIso(this.auditPolicy().auditDays, this.now());
        if (!cutoff) return parsed;
        return parsed.filter((rec) => !rec.deletedAt || rec.deletedAt >= cutoff);
    }

    private appendAudit(record: ConversationDeletionRecord): void {
        try {
            // 写入前先按保留期过滤 + 截断条数上限，过期记录在这一步被物理丢弃。
            const { auditLimit } = this.auditPolicy();
            const limit = auditLimit > 0 ? auditLimit : Number.POSITIVE_INFINITY;
            const next = [record, ...this.readAudit()].slice(0, limit);
            this.writeAudit(next);
        } catch (err) {
            // 审计写失败不影响删除本身（已发生的删除无法回滚）
            log.warn("审计写入失败", { auditPath: this.auditPath, error: String(err) });
        }
    }

    /** 落盘。空数组视为"没有审计"，直接删掉文件（避免留下 `[]` 残骸）。 */
    private writeAudit(records: ConversationDeletionRecord[]): void {
        const dir = path.dirname(this.auditPath);
        if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (records.length === 0) {
            fs.rmSync(this.auditPath, { force: true });
            return;
        }
        fs.writeFileSync(this.auditPath, JSON.stringify(records, null, 2), "utf-8");
    }
}

function platformOf(chatId: string): string {
    const index = chatId.indexOf(":");
    return index > 0 ? chatId.slice(0, index) : "unknown";
}

/**
 * 审计记录的稳定标识。新记录有 `id`；旧记录（本字段引入前写入的）没有，
 * 退回 `chatId@deletedAt` —— 同一会话同一时刻不可能删两次，够唯一。
 */
export function recordKey(record: ConversationDeletionRecord): string {
    return record.id || `${record.chatId}@${record.deletedAt}`;
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
