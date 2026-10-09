/**
 * message-retention.ts — 原始消息的定期保留
 *
 * 原始对话是「缓存」，沉淀后的记忆（话题 / core_facts / 画像 / session_digests）才是资产。
 * 默认只保留最近 7 天的 `message_log`，更早的定期清掉；记忆层完全不受影响。
 *
 * 只删 message_log 的三个已知副作用（可接受，见 docs/conversation-hygiene-plan.md §7）：
 * - topic 归因回查 / reply chain 拿不到更早的消息（摘要已独立存在 topics.summary）；
 * - 补抓水位随之回退，靠 `backfill.maxAgeMinutes`（默认 720）兜住，别调大。
 *
 * 定时器写法对齐 main.ts 既有的 topicCleanupInterval / media-downloader.cleanupExpired。
 */

import { createLogger } from "./logger.js";
import { loadConfig } from "./config.js";
import type { RetentionConfig } from "./config.js";

const log = createLogger("message-retention");

/** 默认保留天数 */
export const DEFAULT_MESSAGE_LOG_DAYS = 7;
/** 默认扫描间隔（小时） */
export const DEFAULT_SWEEP_INTERVAL_HOURS = 6;

/** 清理动作只需要这一个能力（窄接口，结构性匹配 MemoryStoreV2）。 */
export interface RetentionStore {
    pruneMessagesBefore(cutoffIso: string): number;
}

export interface MessageRetentionOptions {
    memory: RetentionStore;
    config?: RetentionConfig;
    /** 覆盖"现在"（测试用） */
    now?: () => number;
    /** 一次清理完成后的回调（观测用） */
    onSweep?: (result: { cutoffIso: string; deleted: number }) => void;
}

export interface ResolvedRetention {
    messageLogDays: number;
    sweepIntervalHours: number;
    /** days<=0 表示关闭 */
    enabled: boolean;
}

/** 解析配置：缺省 7 天 / 6 小时；非法值回退默认。 */
export function resolveMessageRetention(config?: RetentionConfig): ResolvedRetention {
    const source = config ?? safeLoadConfig()?.retention;
    const days = normalizeNonNegative(source?.messageLogDays, DEFAULT_MESSAGE_LOG_DAYS);
    const hours = normalizePositive(source?.sweepIntervalHours, DEFAULT_SWEEP_INTERVAL_HOURS);
    return {
        messageLogDays: days,
        sweepIntervalHours: hours,
        enabled: days > 0,
    };
}

/** 计算 cut-off 时间（ISO）。days<=0 时返回 null 表示不清理。 */
export function resolveCutoffIso(days: number, nowMs: number = Date.now()): string | null {
    if (!Number.isFinite(days) || days <= 0) return null;
    return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 执行一次清理，返回删除条数。
 * `messageLogDays <= 0` 时不碰数据（保持"永久保存"语义）。
 */
export function sweepMessageLog(options: MessageRetentionOptions): number {
    const nowMs = options.now?.() ?? Date.now();
    const resolved = resolveMessageRetention(options.config);
    const cutoffIso = resolveCutoffIso(resolved.messageLogDays, nowMs);
    if (!cutoffIso) return 0;

    try {
        const deleted = options.memory.pruneMessagesBefore(cutoffIso);
        if (deleted > 0) {
            log.info("已清理过期原始消息", { cutoffIso, deleted, keepDays: resolved.messageLogDays });
        }
        options.onSweep?.({ cutoffIso, deleted });
        return deleted;
    } catch (err) {
        log.warn("清理原始消息失败", { cutoffIso, error: String(err) });
        return 0;
    }
}

/**
 * 启动定时清理。返回停止函数。
 * 关闭（days<=0）时不建定时器，直接返回 no-op。
 */
export function startMessageRetention(options: MessageRetentionOptions): () => void {
    const resolved = resolveMessageRetention(options.config);
    if (!resolved.enabled) {
        log.info("message retention 已关闭（message_log_days <= 0），原始消息将永久保存");
        return () => { /* no-op */ };
    }

    const intervalMs = Math.max(1, resolved.sweepIntervalHours) * 60 * 60 * 1000;
    const timer = setInterval(() => sweepMessageLog(options), intervalMs);
    // 与 main.ts 其它定时器一致：不阻止进程退出
    if (typeof timer.unref === "function") timer.unref();

    log.info("message retention 已启动", {
        keepDays: resolved.messageLogDays,
        intervalHours: resolved.sweepIntervalHours,
    });

    return () => clearInterval(timer);
}

/** 天数允许 0（表示关闭），所以只要求非负。 */
function normalizeNonNegative(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 间隔必须为正，0 / 负数一律回退默认。 */
function normalizePositive(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeLoadConfig(): { retention?: RetentionConfig } | null {
    try {
        return loadConfig();
    } catch {
        return null;
    }
}
