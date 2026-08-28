/**
 * qqbot-official-adapter.ts — QQ 官方机器人平台 adapter（q.qq.com 开放平台）
 *
 * 与 onebot-adapter.ts（OneBot v11 / NapCat 自建客户端协议）并存的第三个 QQ 渠道驱动：
 * - 认证：appId + appSecret → bots.qq.com 换取 access_token（7200s，提前 5min 刷新，401 自动重试）
 * - 事件：WebSocket 网关（wss://api.sgroup.qq.com/websocket），op 2 Identify + op 1 心跳 + op 6 Resume
 * - 消息域：GROUP_AT_MESSAGE_CREATE（群聊 @ 消息，平台只投递 @ 消息）+ C2C_MESSAGE_CREATE（单聊）
 *   频道（guild）域不在本驱动范围
 * - 发送：REST v2（/v2/users/{openid}/messages），受平台"被动回复"规则强约束：
 *   群聊/单聊消息必须携带收到消息的 msg_id（5 分钟内有效，每条 msg_id 最多 5 次被动回复），
 *   主动消息（不带 msg_id）需要平台配额，默认额度极少——超出窗口的发送自动降级为主动消息并告警
 * - chatId 结构：qqbot:group:{group_openid}（群聊）/ qqbot:private:{user_openid}（单聊）
 *
 * 平台硬限制（agent 文档同步说明）：
 * - 无历史消息 API（离线/断线期间的消息无法补抓）
 * - 无成员列表 / 无昵称 API（openid 为唯一定位符，displayName 用 openid 短摘要代替）
 * - 发送媒体仅支持公网可访问 URL（file_type: 1 图片 / 2 视频 / 3 音频），无通用文件
 */

import type { NotificationCenter } from "../event/notification-center.js";
import { loadConfig, type QQBotConfig } from "../core/config.js";
import type {
    AdapterConnectionStatus,
    BackfillOptions,
    BackfillResult,
    PlatformAdapter,
} from "./platform-adapter.js";
import { ConnectionTracker } from "./connection-tracker.js";
import type { MediaInfo } from "./telegram-adapter.js";
import { composeChatId, ensureCompositeId } from "../core/chat-id.js";
import { createLogger } from "../core/logger.js";
import { shouldDropInbound } from "../core/inbound-filter.js";
import { userGate } from "./user-gate.js";
import type { MediaDownloader } from "../core/media-downloader.js";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";

const log = createLogger("qqbot-official-adapter");

// ─── 常量 ───

const DEFAULT_API_BASE = "https://api.sgroup.qq.com";
const DEFAULT_AUTH_URL = "https://bots.qq.com/app/getAppAccessToken";
/** 群聊和单聊事件 intent（GROUP_AND_C2C_EVENT） */
const INTENT_GROUP_AND_C2C = 1 << 25;
/** 被动回复窗口：官方为 5 分钟，留 30s 余量 */
const PASSIVE_WINDOW_MS = 4.5 * 60_000;
/** 每条 msg_id 最多 5 次被动回复 */
const MAX_PASSIVE_SEQ = 5;

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60_000;

// ─── 平台类型（仅覆盖用到的字段） ───

interface QQBotGroupMessagePayload {
    id?: string;
    group_openid?: string;
    content?: string;
    author?: { id?: string; member_openid?: string };
    attachments?: QQBotAttachment[];
}

interface QQBotC2CMessagePayload {
    id?: string;
    user_openid?: string;
    content?: string;
    author?: { user_openid?: string };
    attachments?: QQBotAttachment[];
}

interface QQBotAttachment {
    content_type?: string;
    filename?: string;
    url?: string;
    size?: number;
}

interface QQBotWsFrame {
    op: number;
    s?: number;
    t?: string;
    /** op 9 的 d 可能是 boolean false，心跳帧的 d 是 seq 数字，dispatch 的 d 是事件对象 */
    d?: unknown;
}

interface QQBotNormalizedMessage {
    chatId: string;
    userId: string;
    displayName: string;
    text: string;
    timestamp: string;
    messageId: string;
    chatTitle?: string;
    chatType?: string;
    isDirectMessage: boolean;
    mentionsAgent: boolean;
    mediaInfo?: MediaInfo;
}

interface MediaFileUploadResult {
    file_uuid?: string;
    file_info?: string;
}

/** 与 telegram-adapter 的 PlainMessage 保持结构兼容（sandbox ack/返回值用） */
interface PlainSendResult {
    id: string;
    text: string;
    date: string;
    isPassive: boolean;
}

/** 构造与实时入站一致的 NC 消息载荷（字段结构与 buildTelegramNcMessage 对齐） */
function buildQQBotNcMessage(normalized: QQBotNormalizedMessage): Record<string, unknown> {
    const source = {
        scene: "qqbot",
        platform: "qqbot",
        chatId: normalized.chatId,
        userId: normalized.userId,
        chatType: normalized.chatType,
        messageId: normalized.messageId,
    };
    const core = {
        chatId: normalized.chatId,
        userId: normalized.userId,
        displayName: normalized.displayName,
        text: normalized.text,
        timestamp: normalized.timestamp,
        messageId: normalized.messageId,
        chatTitle: normalized.chatTitle,
        chatType: normalized.chatType,
        isDirectMessage: normalized.isDirectMessage,
        mentionsAgent: normalized.mentionsAgent,
        mediaInfo: normalized.mediaInfo,
    };
    return {
        type: "nc.message",
        scene: "qqbot",
        source,
        ...core,
        payload: {
            scene: "qqbot",
            ...core,
            source,
            platformData: { originalType: "qqbot.message" },
        },
        _urgent: normalized.isDirectMessage || normalized.mentionsAgent ? true : false,
    };
}

export class QQBotOfficialAdapter implements PlatformAdapter {
    readonly platform = "qqbot";

    private readonly connection = new ConnectionTracker("qqbot");
    private stopRequested = false;
    private ws: WebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private lastSeq: number | null = null;
    private sessionId: string | null = null;
    private startInFlight: Promise<void> | null = null;

    private token: string | null = null;
    private tokenExpiresAt = 0;
    private tokenRefreshInFlight: Promise<string> | null = null;

    /** 被动回复登记：chatId → 最近收到的 msg_id 与已用被动次数 */
    private passiveReplies = new Map<string, { msgId: string; receivedAt: number; seq: number }>();
    private mutedChats: Map<string, number> = new Map();

    private readonly apiBase: string;
    private readonly authUrl: string;
    private readonly c2cEnabled: boolean;

    constructor(
        private config: QQBotConfig,
        private nc: NotificationCenter,
        private mediaDownloader?: MediaDownloader,
    ) {
        this.apiBase = (config.apiBaseUrl?.trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
        this.authUrl = config.authUrl?.trim() || DEFAULT_AUTH_URL;
        this.c2cEnabled = config.c2cEnabled !== false;
    }

    // ─── 生命周期 ───

    async start(): Promise<void> {
        if (this.startInFlight) return this.startInFlight;
        this.stopRequested = false;
        this.startInFlight = this.doStart().finally(() => {
            this.startInFlight = null;
        });
        try {
            await this.startInFlight;
        } catch (err) {
            this.connection.markDisconnected(String(err));
            this.scheduleReconnect(String(err));
            throw err;
        }
    }

    getConnectionStatus(): AdapterConnectionStatus {
        return this.connection.snapshot();
    }

    /** 手动重连：断开当前 WS 后重走完整启动（换 token → 网关 → Identify） */
    async reconnect(): Promise<void> {
        log.info("QQBotOfficialAdapter 手动重连");
        this.clearReconnectTimer();
        this.reconnectAttempts = 0;
        this.connection.resetAttempts();
        this.sessionId = null;
        this.stopRequested = true;
        await this.teardownWs("manual reconnect");
        this.stopRequested = false;
        await this.start();
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
        this.clearReconnectTimer();
        this.connection.markStopped();
        await this.teardownWs("stop");
    }

    private validateConfig(): void {
        if (!this.config.appId || !this.config.appSecret) {
            throw new Error("qqbot.app_id / qqbot.app_secret 不能为空（q.qq.com 开放平台凭据）");
        }
    }

    private async doStart(): Promise<void> {
        this.validateConfig();
        this.connection.markConnecting(`app_id=${this.config.appId}, base=${this.apiBase}`);

        // 重连场景下先清理可能残留的旧连接
        if (this.ws) {
            await this.teardownWs("restart");
        }

        // 换取 accessToken（后续 REST / WS 鉴权共用）
        await this.ensureAccessToken();

        // 获取 WS 网关地址并连接
        const gateway = await this.apiRequest<{ url: string }>("GET", "/gateway");
        if (!gateway?.url) throw new Error("QQ Bot 网关地址获取失败（/gateway 未返回 url）");

        await this.connectGateway(gateway.url);
        this.reconnectAttempts = 0;
        this.connection.markConnected(`app_id=${this.config.appId}, mode=official, base=${this.apiBase}`);
        this.print(`✅ QQBotOfficialAdapter 已启动: app_id=${this.config.appId}, 网关: ${gateway.url}`);
    }

    private print(message: string): void {
        console.log(`🤖 ${message}`);
    }

    // ─── accessToken 管理 ───

    private async ensureAccessToken(): Promise<string> {
        if (this.token && Date.now() < this.tokenExpiresAt - 300_000) return this.token;
        if (!this.tokenRefreshInFlight) {
            this.tokenRefreshInFlight = this.fetchAccessToken().finally(() => {
                this.tokenRefreshInFlight = null;
            });
        }
        return this.tokenRefreshInFlight;
    }

    private invalidateToken(): void {
        this.token = null;
        this.tokenExpiresAt = 0;
    }

    private async fetchAccessToken(): Promise<string> {
        const response = await fetch(this.authUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                appId: this.config.appId,
                clientSecret: this.config.appSecret,
            }),
        });
        const data = await response.json().catch(() => null) as
            | { access_token?: string; expires_in?: number; message?: string; code?: number }
            | null;
        if (!response.ok || !data?.access_token) {
            throw new Error(
                `获取 QQ bot access_token 失败: ${response.status} ${data?.message ?? response.statusText}`,
            );
        }
        this.token = data.access_token;
        this.tokenExpiresAt = Date.now() + (Number(data.expires_in) || 7200) * 1000;
        log.info("QQ bot access_token 已刷新", {
            expiresInSec: Number(data.expires_in) || 7200,
        });
        return this.token;
    }

    // ─── REST 基础 ───

    private async apiRequest<T>(
        httpMethod: "GET" | "POST",
        apiPath: string,
        body?: Record<string, unknown>,
        allowAuthRetry = true,
    ): Promise<T> {
        const token = await this.ensureAccessToken();
        const response = await fetch(`${this.apiBase}${apiPath}`, {
            method: httpMethod,
            headers: {
                "Authorization": `QQBot ${token}`,
                "Content-Type": "application/json",
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (response.status === 401 && allowAuthRetry) {
            // token 失效（例如平台侧提前吊销）：刷新后重试一次
            this.invalidateToken();
            return this.apiRequest<T>(httpMethod, apiPath, body, false);
        }
        const data = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (!response.ok) {
            const detail = data?.message ?? data?.msg ?? response.statusText;
            throw new Error(`QQ Bot API ${apiPath} failed: ${response.status} ${String(detail).slice(0, 300)}`);
        }
        return data as T;
    }

    // ─── WebSocket 网关 ───

    private connectGateway(url: string): Promise<void> {
        return new Promise<void>((resolvePromise, rejectPromise) => {
            let settled = false;
            const ws = new WebSocket(url);
            this.ws = ws;
            const generation = ++QQBotOfficialAdapter._generationCounter;
            const isCurrent = () => this.ws === ws && !this.stopRequested;

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { ws.close(); } catch { /* ignore */ }
                rejectPromise(new Error("QQ Bot 网关连接超时（30s 内未收到 READY）"));
            }, 30_000);
            if (timeout.unref) timeout.unref();

            ws.on("open", () => {
                log.info("QQ Bot 网关已连接，等待 Hello", { generation });
            });

            ws.on("message", async (raw: unknown) => {
                let frame: QQBotWsFrame;
                try {
                    frame = JSON.parse(String(raw)) as QQBotWsFrame;
                } catch {
                    return;
                }
                try {
                    await this.handleWsFrame(frame, isCurrent, () => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timeout);
                        resolvePromise();
                    });
                } catch (err) {
                    log.warn("处理 QQ Bot 网关帧失败", { op: frame.op, t: frame.t, error: String(err).slice(0, 200) });
                }
            });

            ws.on("close", (code: number, reason: Buffer) => {
                clearTimeout(timeout);
                this.clearHeartbeat();
                if (this.ws === ws) this.ws = null;
                if (!settled) {
                    settled = true;
                    rejectPromise(new Error(`QQ Bot 网关连接关闭: code=${code} ${reason.toString().slice(0, 100)}`));
                    return;
                }
                if (this.stopRequested) {
                    this.connection.markStopped();
                    return;
                }
                // 运行中断线：记录状态并安排重连
                this.connection.markDisconnected(`ws closed code=${code}`);
                log.warn("QQ Bot 网关连接断开", { code, reason: reason.toString().slice(0, 100) });
                this.scheduleReconnect(`ws closed code=${code}`);
            });

            ws.on("error", (err: Error) => {
                if (isCurrent()) this.connection.noteError(String(err));
                log.warn("QQ Bot 网关错误", { error: String(err).slice(0, 200) });
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    rejectPromise(err);
                }
            });
        });
    }

    private static _generationCounter = 0;

    private async handleWsFrame(
        frame: QQBotWsFrame,
        isCurrent: () => boolean,
        onReady: () => void,
    ): Promise<void> {
        switch (frame.op) {
            case 10: {
                // Hello：下发心跳间隔，随后 Identify 或 Resume
                const interval = Number((frame.d as { heartbeat_interval?: unknown })?.heartbeat_interval ?? 30_000);
                if (!isCurrent()) return;
                if (this.sessionId && this.lastSeq !== null) {
                    this.sendWs({ op: 6, d: {
                        token: `QQBot ${await this.ensureAccessToken()}`,
                        session_id: this.sessionId,
                        seq: this.lastSeq,
                    } });
                    log.info("QQ Bot 网关尝试 Resume", { sessionId: this.sessionId.slice(0, 8), seq: this.lastSeq });
                } else {
                    this.sendWs({ op: 2, d: {
                        token: `QQBot ${await this.ensureAccessToken()}`,
                        intents: INTENT_GROUP_AND_C2C,
                        shard: [0, 1],
                    } });
                    log.info("QQ Bot 网关 Identify", { intents: INTENT_GROUP_AND_C2C });
                }
                this.startHeartbeat(interval);
                return;
            }
            case 11:
                // 心跳 ACK
                return;
            case 9: {
                // Invalid Session：会话失效，需重新 Identify
                log.warn("QQ Bot 网关会话失效，将重新 Identify");
                this.sessionId = null;
                this.lastSeq = null;
                if (!isCurrent()) return;
                const delayMs = frame.d === false ? 5000 : 1000;
                setTimeout(() => {
                    if (!isCurrent()) return;
                    void (async () => {
                        this.sendWs({ op: 2, d: {
                            token: `QQBot ${await this.ensureAccessToken()}`,
                            intents: INTENT_GROUP_AND_C2C,
                            shard: [0, 1],
                        } });
                    })();
                }, delayMs);
                return;
            }
            case 7:
                // 服务端要求重连：主动断开触发 close → scheduleReconnect
                log.info("QQ Bot 网关要求重连 (op 7)");
                this.ws?.close(4000, "server requested reconnect");
                return;
            case 0: {
                // Dispatch
                if (typeof frame.s === "number") this.lastSeq = frame.s;
                if (!isCurrent()) return;
                switch (frame.t) {
                    case "READY": {
                        this.sessionId = String((frame.d as { session_id?: unknown })?.session_id ?? "");
                        log.info("QQ Bot 网关 READY", { sessionId: this.sessionId.slice(0, 8) });
                        onReady();
                        return;
                    }
                    case "RESUMED": {
                        log.info("QQ Bot 网关 Resume 成功");
                        onReady();
                        return;
                    }
                    case "GROUP_AT_MESSAGE_CREATE":
                        this.processGroupMessage(frame.d as QQBotGroupMessagePayload).catch((err) => {
                            log.warn("处理 QQ 群消息失败", { error: String(err).slice(0, 200) });
                        });
                        return;
                    case "C2C_MESSAGE_CREATE":
                        if (this.c2cEnabled) {
                            this.processC2CMessage(frame.d as QQBotC2CMessagePayload).catch((err) => {
                                log.warn("处理 QQ 单聊消息失败", { error: String(err).slice(0, 200) });
                            });
                        }
                        return;
                    default:
                        // FRIEND_ADD / GROUP_ADD_ROBOT / C2C_MSG_REJECT 等事件暂不处理
                        log.debug("QQ Bot 事件（忽略）", { type: frame.t });
                        return;
                }
            }
            default:
                return;
        }
    }

    private sendWs(frame: QQBotWsFrame): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify(frame));
    }

    private startHeartbeat(intervalMs: number): void {
        this.clearHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.sendWs({ op: 1, d: this.lastSeq });
        }, Math.max(5000, intervalMs - 2000));
        if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    }

    private clearHeartbeat(): void {
        if (!this.heartbeatTimer) return;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    private async teardownWs(reason: string): Promise<void> {
        this.clearHeartbeat();
        const ws = this.ws;
        this.ws = null;
        if (!ws) return;
        await new Promise<void>((resolvePromise) => {
            const timer = setTimeout(() => resolvePromise(), 2000);
            ws.once("close", () => {
                clearTimeout(timer);
                resolvePromise();
            });
            try {
                ws.close(1000, reason);
            } catch {
                clearTimeout(timer);
                resolvePromise();
            }
        });
    }

    private scheduleReconnect(reason: string): void {
        if (this.stopRequested || this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1), RECONNECT_MAX_MS);
        this.connection.markRetryScheduled(this.reconnectAttempts, delay);
        log.info(`QQBotOfficialAdapter 将在 ${delay}ms 后重连 (第 ${this.reconnectAttempts} 次)`, { reason });
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.stopRequested) return;
            try {
                await this.doStart();
            } catch (err) {
                log.warn("QQBotOfficialAdapter 重连失败", { error: String(err).slice(0, 200) });
            }
        }, delay);
        if (this.reconnectTimer.unref) this.reconnectTimer.unref();
    }

    private clearReconnectTimer(): void {
        if (!this.reconnectTimer) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    // ─── 入站处理 ───

    private async processGroupMessage(payload: QQBotGroupMessagePayload): Promise<void> {
        const groupOpenid = String(payload.group_openid ?? "").trim();
        const messageId = String(payload.id ?? "").trim();
        if (!groupOpenid || !messageId) return;

        const memberOpenid = String(payload.author?.id ?? payload.author?.member_openid ?? "").trim();
        const chatId = composeChatId("qqbot", "group", groupOpenid);
        // 群聊事件只在 bot 被 @ 时投递（平台行为），天然等价于 mention
        const normalized = await this.normalizeInbound({
            chatId,
            messageId,
            senderOpenid: memberOpenid,
            content: payload.content,
            attachments: payload.attachments,
            chatType: "group",
            isDirectMessage: false,
            mentionsAgent: true,
            chatTitle: `QQ群_${groupOpenid.slice(-6)}`,
        });
        if (normalized) this.pushInbound(normalized);
    }

    private async processC2CMessage(payload: QQBotC2CMessagePayload): Promise<void> {
        const userOpenid = String(payload.user_openid ?? payload.author?.user_openid ?? "").trim();
        const messageId = String(payload.id ?? "").trim();
        if (!userOpenid || !messageId) return;

        const chatId = composeChatId("qqbot", "private", userOpenid);
        const normalized = await this.normalizeInbound({
            chatId,
            messageId,
            senderOpenid: userOpenid,
            content: payload.content,
            attachments: payload.attachments,
            chatType: "private",
            isDirectMessage: true,
            mentionsAgent: false,
            chatTitle: undefined,
        });
        if (normalized) this.pushInbound(normalized);
    }

    private async normalizeInbound(input: {
        chatId: string;
        messageId: string;
        senderOpenid: string;
        content?: string;
        attachments?: QQBotAttachment[];
        chatType: string;
        isDirectMessage: boolean;
        mentionsAgent: boolean;
        chatTitle?: string;
    }): Promise<QQBotNormalizedMessage | null> {
        // 被动回复登记：记录最近 msg_id 供发送侧使用
        this.passiveReplies.set(input.chatId, {
            msgId: input.messageId,
            receivedAt: Date.now(),
            seq: 0,
        });

        const mediaInfo = await this.extractAttachmentsMedia(input.attachments, input.chatId, input.messageId);
        let text = String(input.content ?? "").trimStart();
        if (!text && mediaInfo) {
            switch (mediaInfo.type) {
                case "photo": text = "[📷 图片]"; break;
                case "video": text = "[🎬 视频]"; break;
                case "audio": text = "[🎙 语音/音频]"; break;
                default: text = "[📎 媒体]"; break;
            }
        }
        if (!text) return null;

        return {
            chatId: input.chatId,
            // 与 OneBot 约定一致：userId 用平台裸 ID（qqbot:<openid>），不加会话段前缀
            userId: input.senderOpenid
                ? composeChatId("qqbot", input.senderOpenid)
                : "qqbot:unknown",
            displayName: input.senderOpenid ? `QQ用户_${input.senderOpenid.slice(-6)}` : "Unknown",
            text,
            timestamp: new Date().toISOString(),
            messageId: input.messageId,
            chatTitle: input.chatTitle,
            chatType: input.chatType,
            isDirectMessage: input.isDirectMessage,
            mentionsAgent: input.mentionsAgent,
            mediaInfo,
        };
    }

    private pushInbound(normalized: QQBotNormalizedMessage): void {
        if (shouldDropInbound(loadConfig().chatFilter, {
            chatId: normalized.chatId,
            userId: normalized.userId,
        })) return;

        log.debug("接收 QQ 官方消息", {
            messageId: normalized.messageId,
            chatId: normalized.chatId,
            chatType: normalized.chatType,
            textPreview: normalized.text.slice(0, 80),
            mediaType: normalized.mediaInfo?.type,
        });
        this.nc.push(buildQQBotNcMessage(normalized) as never);
    }

    private async extractAttachmentsMedia(
        attachments: QQBotAttachment[] | undefined,
        chatId: string,
        messageId: string,
    ): Promise<MediaInfo | undefined> {
        if (!attachments || attachments.length === 0) return undefined;
        const first = attachments[0];
        const url = String(first?.url ?? "").trim();
        if (!url) return undefined;

        const contentType = String(first?.content_type ?? "").toLowerCase();
        const filename = String(first?.filename ?? "");
        let type: MediaInfo["type"] = "other";
        if (contentType.startsWith("image") || /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(url)) type = "photo";
        else if (contentType.startsWith("video") || /\.(mp4|mov|webm)(\?|$)/i.test(url)) type = "video";
        else if (contentType.startsWith("audio") || /\.(mp3|amr|wav|ogg|silk)(\?|$)/i.test(url)) type = "audio";

        const uniqueFileId = filename || createHash("sha1").update(url).digest("hex").slice(0, 24);
        const mediaInfo: MediaInfo = {
            type,
            rawType: contentType || undefined,
            fileId: url,
            uniqueFileId,
            fileName: filename || undefined,
            fileSize: typeof first?.size === "number" ? first.size : undefined,
        };

        // 自动下载入站媒体（语义与 telegram 驱动一致：超限 / 失败只标记不阻断）
        if (this.mediaDownloader) {
            const existing = this.mediaDownloader.getExistingPath(uniqueFileId);
            if (existing) {
                mediaInfo.filePath = existing;
                mediaInfo.downloadStatus = "cached";
            } else if (this.mediaDownloader.isWithinSizeLimit(mediaInfo.fileSize)) {
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                    const buffer = Buffer.from(await response.arrayBuffer());
                    const saved = this.mediaDownloader.saveMedia(buffer, {
                        chatId,
                        messageId,
                        uniqueFileId,
                        mediaType: mediaInfo.type,
                        mimeType: contentType || undefined,
                        fileName: filename || undefined,
                    });
                    mediaInfo.fileSize = mediaInfo.fileSize ?? buffer.length;
                    if (saved) {
                        mediaInfo.filePath = saved.path;
                        mediaInfo.downloadStatus = "downloaded";
                    } else {
                        mediaInfo.downloadStatus = "too_large";
                    }
                } catch (err) {
                    mediaInfo.downloadStatus = "failed";
                    mediaInfo.downloadError = String(err).slice(0, 300);
                    log.warn("QQ 入站媒体自动下载失败", { chatId, messageId, type, error: String(err).slice(0, 150) });
                }
            } else {
                mediaInfo.downloadStatus = "too_large";
            }
        }
        return mediaInfo;
    }

    // ─── 发送侧：被动回复参数 ───

    /** 取当前会话可用的被动回复参数；窗口过期 / 次数用尽时返回空（降级为主动消息） */
    private takePassiveParams(chatId: string): { msg_id?: string; msg_seq?: number } {
        const entry = this.passiveReplies.get(chatId);
        if (entry && Date.now() - entry.receivedAt < PASSIVE_WINDOW_MS && entry.seq < MAX_PASSIVE_SEQ) {
            entry.seq += 1;
            return { msg_id: entry.msgId, msg_seq: entry.seq };
        }
        log.warn("QQ 被动回复窗口已失效，尝试主动消息（受平台配额限制）", {
            chatId,
            hasEntry: !!entry,
            ageMs: entry ? Date.now() - entry.receivedAt : -1,
            seqUsed: entry?.seq ?? -1,
        });
        return {};
    }

    /** 从 chatId 提取 REST v2 所需的 openid（群聊 group_openid / 单聊 user_openid） */
    private toOpenid(chatId: string): string {
        const raw = chatId.startsWith("qqbot:") ? chatId.slice("qqbot:".length) : chatId;
        if (raw.startsWith("group:")) return raw.slice("group:".length);
        if (raw.startsWith("private:")) return raw.slice("private:".length);
        return raw;
    }

    private async sendTextMessage(chatId: string, text: string): Promise<PlainSendResult> {
        const openid = this.toOpenid(chatId);
        const passive = this.takePassiveParams(chatId);
        const result = await this.apiRequest<Record<string, unknown>>("POST", `/v2/users/${encodeURIComponent(openid)}/messages`, {
            content: text,
            msg_type: 0,
            ...passive,
        });
        return {
            id: String(result?.id ?? ""),
            text,
            date: new Date().toISOString(),
            isPassive: !!passive.msg_id,
        };
    }

    /**
     * 发送媒体（图片/视频/语音）：先经 /files 用 URL 注册 file_info，再发 msg_type=7 消息。
     * 官方 API 仅接受公网可访问 URL，本地文件/Buffer 无法直接上传。
     */
    private async sendMediaMessage(chatId: string, media: Record<string, unknown>): Promise<PlainSendResult> {
        const openid = this.toOpenid(chatId);
        const mediaType = String(media.type ?? "").toLowerCase();
        const fileType = mediaType === "photo" || mediaType === "image" || mediaType.startsWith("image/")
            ? 1
            : mediaType === "video" || mediaType.startsWith("video/")
                ? 2
                : mediaType === "audio" || mediaType === "voice" || mediaType.startsWith("audio/")
                    ? 3
                    : null;
        if (fileType == null) {
            throw new Error(
                "qqbot.sendMedia: QQ 官方平台仅支持 图片/视频/音频 三类媒体（file_type 1/2/3），"
                + "不支持通用文件；请改用 sendText 或平台外渠道发送",
            );
        }
        const url = typeof media.url === "string" && media.url.trim()
            ? media.url.trim()
            : typeof media.file === "string" && /^https?:\/\//i.test(media.file)
                ? media.file.trim()
                : "";
        if (!url) {
            throw new Error(
                "qqbot.sendMedia: QQ 官方平台只接受公网可访问的 https URL（平台服务器会自行拉取），"
                + "不支持本地路径 / Buffer / data: URL。请先上传到图床或使用外网可达地址",
            );
        }
        const passive = this.takePassiveParams(chatId);
        // 1) 注册媒体文件（srv_send_msg=false 不直接发送）
        const uploaded = await this.apiRequest<MediaFileUploadResult>("POST", `/v2/users/${encodeURIComponent(openid)}/files`, {
            file_type: fileType,
            url,
            srv_send_msg: false,
            ...passive,
        });
        if (!uploaded?.file_info) {
            throw new Error("qqbot.sendMedia: /files 未返回 file_info");
        }
        // 2) 发送媒体消息（msg_type=7）
        const result = await this.apiRequest<Record<string, unknown>>("POST", `/v2/users/${encodeURIComponent(openid)}/messages`, {
            content: "",
            msg_type: 7,
            media: { file_info: uploaded.file_info },
            ...passive,
        });
        return {
            id: String(result?.id ?? ""),
            text: `[media:${mediaType}]`,
            date: new Date().toISOString(),
            isPassive: !!passive.msg_id,
        };
    }

    // ─── host-call 接口面 ───

    canHandle(method: string): boolean {
        return method.startsWith("qqbot.");
    }

    getWriteMethods(): string[] {
        return [
            "qqbot.sendText",
            "qqbot.sendMedia",
            "qqbot.sendFile",
            "qqbot.sendTyping",
        ];
    }

    formatMention(_rawUserId: string, _username?: string): string | undefined {
        // openid 无法直接构造 @ 格式；群消息本身就是 @ 触发的
        return undefined;
    }

    getSceneTypeDefs(scene: string, baseTypeDefs: string): string | undefined {
        if (scene !== "qqbot") return undefined;
        const modeNote = "// 当前 QQ adapter 驱动: qqbot 官方开放平台（WebSocket 网关 + REST v2）\n"
            + "// 平台限制: 群聊仅能收到 @ bot 的消息；回复为被动消息（收到消息 5 分钟内，每条 msg_id 最多 5 次）；\n"
            + "// 无历史消息/成员列表/昵称 API；发送媒体仅支持公网 URL（图片/视频/音频）。\n";
        return `${modeNote}\n${baseTypeDefs}`.trim();
    }

    async handleCall(method: string, args: unknown[]): Promise<unknown> {
        const chatId = String(args[0] ?? "");

        // ─── /mute 写操作拦截 ───
        const MUTE_BLOCKED_METHODS = ["qqbot.sendText", "qqbot.sendMedia", "qqbot.sendFile", "qqbot.sendTyping"];
        if (MUTE_BLOCKED_METHODS.includes(method)) {
            const compositeChatId = ensureCompositeId("qqbot", chatId);
            if (this.isChatMuted(compositeChatId)) {
                const remaining = this.getMuteRemainingHours(compositeChatId);
                log.info("mute 拦截写操作", { method, chatId: compositeChatId, remaining });
                throw new Error(`[禁言中] 你在该聊天已被 /mute，剩余 ${remaining}。所有发送操作已被抑制。`);
            }
        }

        switch (method) {
            case "qqbot.getMe":
                return {
                    id: this.config.appId,
                    displayName: `QQBot_${this.config.appId}`,
                    platform: "qqbot-official",
                };

            case "qqbot.sendText": {
                const text = String(args[1] ?? "");
                if (!text.trim()) throw new Error("qqbot.sendText: text 不能为空");
                return this.sendTextMessage(chatId, text);
            }

            case "qqbot.sendMedia": {
                const media = (args[1] && typeof args[1] === "object" ? args[1] : {}) as Record<string, unknown>;
                const result = await this.sendMediaMessage(chatId, media);
                // 官方媒体消息不支持 caption 字段，caption 走独立文本消息（消耗一次被动额度）
                const caption = typeof media.caption === "string" && media.caption.trim() ? media.caption : "";
                if (caption) {
                    try {
                        await this.sendTextMessage(chatId, caption);
                    } catch (err) {
                        log.warn("qqbot.sendMedia caption 发送失败（媒体已发出）", { error: String(err).slice(0, 150) });
                    }
                }
                return result;
            }

            case "qqbot.sendFile":
                throw new Error(
                    "qqbot.sendFile: QQ 官方平台不支持通用文件传输（仅 图片/视频/音频 URL），"
                    + "请使用 qqbot.sendMedia 或 qqbot.sendText 提供链接",
                );

            case "qqbot.sendTyping":
                // 官方平台无"正在输入"接口
                return null;

            case "qqbot.readHistory":
                // 官方平台无法标记已读
                return null;

            case "qqbot.downloadMedia": {
                // args: [fileId | mediaInfo, chatId?, messageId?, uniqueFileId?]
                const fileRef = args[0];
                const url = typeof fileRef === "string" && /^https?:\/\//i.test(fileRef)
                    ? fileRef.trim()
                    : fileRef && typeof fileRef === "object" && typeof (fileRef as { fileId?: unknown }).fileId === "string"
                        ? (fileRef as { fileId: string }).fileId
                        : "";
                if (!url || !/^https?:\/\//i.test(url)) {
                    throw new Error("qqbot.downloadMedia: 需要 attachments 的 URL（fileId）");
                }
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`qqbot.downloadMedia: ${response.status} ${response.statusText}`);
                }
                const buffer = Buffer.from(await response.arrayBuffer());
                return { buffer: buffer.toString("base64"), size: buffer.length };
            }

            case "qqbot.getChat":
                // openid 无群详情 API；返回本地已知信息
                return {
                    id: chatId,
                    type: chatId.includes(":group:") ? "group" : "private",
                    title: chatId.includes(":group:") ? `QQ群_${this.toOpenid(chatId).slice(-6)}` : undefined,
                };

            case "qqbot.getHistory":
            case "qqbot.getDialogs":
            case "qqbot.findDialogs":
            case "qqbot.getMessages":
            case "qqbot.searchMessages":
            case "qqbot.getChatMembers":
                throw new Error(
                    `${method}: QQ 官方平台无历史消息/会话遍历/成员列表 API。`
                    + "请基于当前消息上下文直接使用 qqbot.sendText(chatId, text) 回复",
                );

            default:
                throw new Error(`Unsupported QQBotOfficialAdapter call: ${method}`);
        }
    }

    // ─── /mute 状态（dashboard 用，与其它 adapter 一致） ───

    isChatMuted(chatId: string): boolean {
        const expiry = this.mutedChats.get(chatId);
        if (expiry === undefined) return false;
        if (expiry <= Date.now()) {
            this.mutedChats.delete(chatId);
            return false;
        }
        return true;
    }

    muteChat(chatId: string, hours: number): void {
        const h = Math.max(1, Math.min(24, hours));
        this.mutedChats.set(chatId, Date.now() + h * 3_600_000);
        log.info("muteChat (external)", { chatId, hours: h });
    }

    unmuteChat(chatId: string): void {
        this.mutedChats.delete(chatId);
        log.info("unmuteChat (external)", { chatId });
    }

    getMutedChats(): Array<{ chatId: string; expiry: number; remaining: string }> {
        const out: Array<{ chatId: string; expiry: number; remaining: string }> = [];
        for (const [chatId, expiry] of this.mutedChats) {
            if (expiry <= Date.now()) {
                this.mutedChats.delete(chatId);
                continue;
            }
            out.push({ chatId, expiry, remaining: this.getMuteRemainingHours(chatId) });
        }
        return out;
    }

    private getMuteRemainingHours(chatId: string): string {
        const expiry = this.mutedChats.get(chatId) ?? 0;
        const remainingMs = Math.max(0, expiry - Date.now());
        return `${(remainingMs / 3_600_000).toFixed(1)}h`;
    }

    async markAsRead(_chatId: string): Promise<void> {
        // 官方平台无法标记已读，静默忽略
    }

    /**
     * 补抓离线期间漏掉的消息。
     *
     * QQ 官方平台无历史消息 API，WS 断线期间的群 @ 消息无法补回（平台限制）；
     * 这一点比 Telegram bot（getUpdates 24h 保留）更受限。
     */
    async fetchMissedMessages(_options: BackfillOptions): Promise<BackfillResult> {
        return {
            chats: 0,
            messages: 0,
            notes: ["QQ 官方 bot 无历史读取能力，WS 断线期间的消息无法补抓（平台限制）"],
        };
    }
}
