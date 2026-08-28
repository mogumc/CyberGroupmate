/**
 * telegram-botapi-adapter.ts — Telegram Bot API HTTP 驱动
 *
 * 与 telegram-adapter.ts（mtcute MTProto）并存的第二个 Telegram 渠道驱动：
 * - 走标准 Bot API over HTTP，getUpdates 长轮询主动拉取（不依赖 MTProto / api_id / api_hash）
 * - api_base_url 可指向反向代理的 bot.telegram.org（自建网关 / 反代节点），不必直连官方服务器 IP
 *   注意：反向代理需要同时转发 /bot<token>/*（方法调用）与 /file/bot<token>/*（文件下载）两类路径
 * - 对外完全复用 platform="telegram" 的复合 chatId 与 sandbox host-call 接口面，
 *   main.ts / pipeline / dashboard 无感知切换
 *
 * 与 mtcute bot 模式的能力差异：
 * - 无历史读取（Bot API 禁止 bot 读历史）——但 getUpdates offset 持久化到本地，
 *   进程离线期间的更新（Telegram 服务端保留 24h）在重启后会全部补齐投递
 * - 无对话遍历 / 成员枚举 / username 解析（getChat 仅对 bot 已知会话生效）
 * - 发送面基本对齐：文本 / 图片 / 视频 / 动图 / 语音 / 文件 / 贴纸 / 相册 / 投票 / 转发 / 编辑 / 删除 / 置顶 / 表情回应
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig, type TelegramConfig } from "../core/config.js";
import type { NotificationCenter } from "../event/notification-center.js";
import type {
    AdapterConnectionStatus,
    BackfillOptions,
    BackfillResult,
    PlatformAdapter,
} from "./platform-adapter.js";
import { ConnectionTracker } from "./connection-tracker.js";
import { buildTelegramNcMessage, type MediaInfo, type NormalizedIncomingMessage } from "./telegram-adapter.js";
import { composeChatId, ensureCompositeId } from "../core/chat-id.js";
import { createLogger } from "../core/logger.js";
import { shouldDropInbound } from "../core/inbound-filter.js";
import { userGate } from "./user-gate.js";
import type { MediaDownloader } from "../core/media-downloader.js";

const log = createLogger("telegram-botapi-adapter");

// ─── Bot API 类型（仅覆盖用到的字段） ───

interface BotApiUser {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
}

interface BotApiChat {
    id: number;
    type?: string;
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
}

interface BotApiPhotoSize {
    file_id: string;
    file_unique_id: string;
    width?: number;
    height?: number;
    file_size?: number;
}

interface BotApiFileBase {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    width?: number;
    height?: number;
    duration?: number;
    emoji?: string;
    is_animated?: boolean;
    is_video?: boolean;
}

interface BotApiMessage {
    message_id: number;
    date?: number;
    chat: BotApiChat;
    from?: BotApiUser;
    text?: string;
    caption?: string;
    entities?: Array<{ type: string; offset: number; length: number; user?: BotApiUser }>;
    reply_to_message?: { message_id: number };
    photo?: BotApiPhotoSize[];
    sticker?: BotApiFileBase;
    animation?: BotApiFileBase;
    video?: BotApiFileBase;
    video_note?: BotApiFileBase;
    voice?: BotApiFileBase;
    audio?: BotApiFileBase;
    document?: BotApiFileBase;
    forward_origin?: Record<string, unknown>;
    forward_from?: BotApiUser | null;
    forward_from_chat?: BotApiChat | null;
    forward_sender_name?: string;
}

interface BotApiUpdate {
    update_id: number;
    message?: BotApiMessage;
}

interface BotApiFile {
    file_id: string;
    file_unique_id?: string;
    file_size?: number;
    file_path?: string;
}

interface BotApiResponse<T> {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: { retry_after?: number };
}

interface BotApiError extends Error {
    statusCode?: number;
    retryAfterSec?: number;
    conflict?: boolean;
}

// ─── 出入站归一化形状（与 telegram-adapter.ts 保持结构一致） ───

interface PlainUser {
    id: string;
    displayName?: string;
    title?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    isBot: boolean;
}

interface PlainChat {
    id: string;
    title?: string;
    username?: string;
    type: "private" | "group" | "supergroup" | "channel";
}

interface PlainMessage {
    id: string;
    text: string;
    date: string;
    chat: PlainChat;
    sender: PlainUser | null;
    isMention: boolean;
    replyToMessage?: { id: string } | null;
    media?: unknown;
    mediaInfo?: MediaInfo;
    forwardFrom?: string;
    forwardFromUrl?: string;
}

/** 发送入参的媒体对象（sandbox 传入形状，见 sandbox/modules/telegram） */
interface OutgoingMediaArg {
    type?: string;
    file?: unknown;
    caption?: string;
    fileName?: string;
    fileMime?: string;
}

interface ResolvedFile {
    kind: "buffer" | "url";
    buffer?: Buffer;
    url?: string;
    fileName?: string;
    mimeType?: string;
}

const PLAIN_TEXT_LIMIT = 4096;
const DEFAULT_POLL_TIMEOUT_SEC = 30;
const MAX_POLL_TIMEOUT_SEC = 50;

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60_000;

const EXT_MIME: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg",
    ".opus": "audio/opus", ".wav": "audio/wav", ".flac": "audio/flac",
    ".pdf": "application/pdf", ".zip": "application/zip", ".txt": "text/plain",
};

export class TelegramBotApiAdapter implements PlatformAdapter {
    readonly platform = "telegram";

    private readonly connection = new ConnectionTracker("telegram");
    private stopRequested = false;
    private pollAbort: AbortController | null = null;
    private pollLoopRunning = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private selfUser: PlainUser | null = null;
    private selfNumericId = "";
    private offset = 0;
    private mutedChats: Map<string, number> = new Map();
    /** botapi 模式不做拟人化延迟计算（由 sandbox host-call 层统一处理，与 mtcute adapter 一致） */
    private readonly apiBase: string;
    private readonly offsetPath = path.resolve(process.cwd(), "workspace", "tg-botapi-offset.json");

    constructor(
        private config: TelegramConfig,
        private nc: NotificationCenter,
        private mediaDownloader?: MediaDownloader,
    ) {
        this.apiBase = (config.apiBaseUrl?.trim() || "https://api.telegram.org").replace(/\/+$/, "");
    }

    // ─── 生命周期 ───

    async start(): Promise<void> {
        if (this.pollLoopRunning) return;
        this.stopRequested = false;
        try {
            await this.doStart();
        } catch (err) {
            this.connection.markDisconnected(String(err));
            this.scheduleReconnect(String(err));
            throw err;
        }
    }

    getConnectionStatus(): AdapterConnectionStatus {
        return this.connection.snapshot();
    }

    /** 手动重连：停止轮询循环后重新走完整启动（getMe → 轮询） */
    async reconnect(): Promise<void> {
        log.info("TelegramBotApiAdapter 手动重连");
        this.clearReconnectTimer();
        this.reconnectAttempts = 0;
        this.connection.resetAttempts();
        // 先置 stopRequested 让旧循环真正退出，再复位并重新启动
        this.stopRequested = true;
        await this.stopPollLoop();
        this.stopRequested = false;
        await this.start();
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
        this.clearReconnectTimer();
        this.connection.markStopped();
        await this.stopPollLoop();
    }

    private validateConfig(): void {
        if (this.config.mode !== "botapi") {
            throw new Error(`TelegramBotApiAdapter 仅支持 telegram.mode="botapi"，当前为 "${this.config.mode}"`);
        }
        if (!this.config.botToken) {
            throw new Error("telegram.bot_token is required in botapi mode");
        }
    }

    private async doStart(): Promise<void> {
        this.validateConfig();
        this.connection.markConnecting(`mode=botapi, base=${this.apiBase}`);
        this.offset = this.loadOffset();

        const me = await this.apiCall<BotApiUser>("getMe");
        this.selfNumericId = String(me.id);
        this.selfUser = {
            id: this.selfNumericId,
            displayName: [me.first_name, me.last_name].filter(Boolean).join(" ") || me.username || this.selfNumericId,
            username: me.username,
            firstName: me.first_name,
            lastName: me.last_name,
            isBot: true,
        };
        this.reconnectAttempts = 0;
        this.connection.markConnected(
            `${this.selfUser.displayName} (${this.selfUser.id}), mode=botapi, base=${this.apiBase}`,
        );
        this.print(`✅ TelegramBotApiAdapter 已启动: ${this.selfUser.displayName} (${this.selfUser.id}), 接口地址: ${this.apiBase}`);

        // getMe 成功即认为渠道可用；轮询循环后台运行，长轮询挂起不阻塞启动
        void this.runPollLoop();
    }

    private print(message: string): void {
        console.log(`🤖 ${message}`);
    }

    // ─── 长轮询循环 ───

    private async runPollLoop(): Promise<void> {
        if (this.pollLoopRunning) return;
        this.pollLoopRunning = true;
        try {
            while (!this.stopRequested) {
                const controller = new AbortController();
                this.pollAbort = controller;
                const timeoutSec = this.clampPollTimeout();
                // 长轮询本身会挂起 timeoutSec；超时兜底再放宽 30s，容忍反代链路延迟
                const abortTimer = setTimeout(() => controller.abort(), (timeoutSec + 30) * 1000);
                try {
                    const updates = await this.apiCall<BotApiUpdate[]>("getUpdates", {
                        offset: this.offset > 0 ? this.offset : undefined,
                        timeout: timeoutSec,
                        allowed_updates: ["message"],
                    }, controller.signal);
                    this.connection.markConnected();
                    this.reconnectAttempts = 0;

                    // 顺序处理，保持到达顺序；单条失败不影响批次其余消息
                    let batchChanged = false;
                    for (const update of updates) {
                        if (update.update_id >= this.offset) {
                            this.offset = update.update_id + 1;
                            batchChanged = true;
                        }
                        try {
                            await this.processUpdate(update);
                        } catch (err) {
                            log.warn("处理 Telegram update 失败", { updateId: update.update_id, error: String(err) });
                        }
                    }
                    if (batchChanged) this.saveOffset();
                } catch (err) {
                    if (this.stopRequested) break;
                    if (err instanceof Error && err.name === "AbortError") continue;
                    await this.handlePollError(err);
                } finally {
                    clearTimeout(abortTimer);
                    if (this.pollAbort === controller) this.pollAbort = null;
                }
            }
        } finally {
            this.pollLoopRunning = false;
        }
    }

    private async stopPollLoop(): Promise<void> {
        this.pollAbort?.abort();
        const deadline = Date.now() + 3000;
        while (this.pollLoopRunning && Date.now() < deadline) {
            await sleep(50);
        }
    }

    private clampPollTimeout(): number {
        const raw = this.config.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
        return Math.max(0, Math.min(MAX_POLL_TIMEOUT_SEC, Math.floor(raw)));
    }

    private async handlePollError(err: unknown): Promise<void> {
        const e = err as BotApiError;
        this.reconnectAttempts++;
        let delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1), RECONNECT_MAX_MS);
        let reason = String((err as Error)?.message ?? err);

        if (e?.retryAfterSec && Number.isFinite(e.retryAfterSec)) {
            delay = Math.max(delay, e.retryAfterSec * 1000);
        }
        if (e?.conflict) {
            reason = "409 Conflict: 同一 bot token 存在多个 getUpdates 消费者（检查是否有其他进程/实例在用）";
            delay = Math.max(delay, 30_000);
        }
        this.connection.markRetryScheduled(this.reconnectAttempts, delay);
        this.connection.noteError(reason);
        log.warn("getUpdates 失败，稍后重试", {
            attempt: this.reconnectAttempts,
            delayMs: delay,
            error: reason.slice(0, 200),
        });
        await sleep(delay);
    }

    private scheduleReconnect(reason: string): void {
        if (this.stopRequested || this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1), RECONNECT_MAX_MS);
        this.connection.markRetryScheduled(this.reconnectAttempts, delay);
        log.info(`TelegramBotApiAdapter 将在 ${delay}ms 后重试启动 (第 ${this.reconnectAttempts} 次)`, { reason });
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.stopRequested) return;
            try {
                await this.doStart();
            } catch (err) {
                log.warn("TelegramBotApiAdapter 重试启动失败", { error: String(err) });
            }
        }, delay);
        if (this.reconnectTimer.unref) this.reconnectTimer.unref();
    }

    private clearReconnectTimer(): void {
        if (!this.reconnectTimer) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    // ─── offset 持久化（离线消息恢复的关键：Telegram 服务端为未确认 update 保留 24h） ───

    private loadOffset(): number {
        try {
            if (fs.existsSync(this.offsetPath)) {
                const raw = JSON.parse(fs.readFileSync(this.offsetPath, "utf-8")) as { offset?: number };
                return Number.isFinite(raw.offset) ? Number(raw.offset) : 0;
            }
        } catch (err) {
            log.warn("读取 getUpdates offset 失败，从头拉取", { error: String(err) });
        }
        return 0;
    }

    private saveOffset(): void {
        try {
            fs.mkdirSync(path.dirname(this.offsetPath), { recursive: true });
            fs.writeFileSync(this.offsetPath, JSON.stringify({ offset: this.offset, savedAt: new Date().toISOString() }, null, 2));
        } catch (err) {
            log.warn("保存 getUpdates offset 失败", { error: String(err) });
        }
    }

    // ─── Bot API HTTP 基础 ───

    private methodUrl(method: string): string {
        return `${this.apiBase}/bot${this.config.botToken}/${method}`;
    }

    private fileUrl(filePath: string): string {
        return `${this.apiBase}/file/bot${this.config.botToken}/${filePath.replace(/^\/+/, "")}`;
    }

    private async parseResponse<T>(response: Response, method: string): Promise<T> {
        const data = await response.json().catch(() => null) as BotApiResponse<T> | null;
        if (!response.ok || !data || data.ok !== true) {
            const desc = data?.description ?? `${response.status} ${response.statusText}`;
            const err = new Error(`Bot API ${method} failed: ${desc}`) as BotApiError;
            err.statusCode = response.status;
            if (data?.parameters?.retry_after) err.retryAfterSec = data.parameters.retry_after;
            if (response.status === 409) err.conflict = true;
            throw err;
        }
        return data.result as T;
    }

    private async apiCall<T>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
        const response = await fetch(this.methodUrl(method), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body ? JSON.stringify(cleanBody(body)) : undefined,
            signal,
        });
        return this.parseResponse<T>(response, method);
    }

    private async apiUpload<T>(
        method: string,
        fields: Record<string, unknown>,
        fileField: string,
        file: { buffer: Buffer; fileName: string; mimeType?: string },
    ): Promise<T> {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
            if (value === undefined || value === null) continue;
            // multipart 表单里对象字段（如 reply_parameters）需要序列化为 JSON 字符串
            if (typeof value === "object") {
                form.append(key, JSON.stringify(value));
            } else {
                form.append(key, String(value));
            }
        }
        form.append(fileField, new Blob([new Uint8Array(file.buffer)], { type: file.mimeType || "application/octet-stream" }), file.fileName);
        const response = await fetch(this.methodUrl(method), { method: "POST", body: form });
        return this.parseResponse<T>(response, method);
    }

    private async downloadByFileId(fileId: string): Promise<Buffer> {
        const file = await this.apiCall<BotApiFile>("getFile", { file_id: fileId });
        if (!file.file_path) throw new Error(`getFile 未返回 file_path (file_id=${fileId.slice(0, 20)}...)`);
        const response = await fetch(this.fileUrl(file.file_path));
        if (!response.ok) {
            throw new Error(`下载媒体失败: ${response.status} ${response.statusText} (${file.file_path})`);
        }
        return Buffer.from(await response.arrayBuffer());
    }

    // ─── 入站处理 ───

    private async processUpdate(update: BotApiUpdate): Promise<void> {
        if (!update.message) return; // 只处理 message（edited_message / callback_query 暂不入站）

        const normalized = await this.normalizeBotApiMessage(update.message);
        if (!normalized || !normalized.messageId || !normalized.text) return;

        // 命令拦截与 mtcute adapter 一致：全局 chatFilter 同样约束命令回复
        if (shouldDropInbound(loadConfig().chatFilter, {
            chatId: normalized.chatId,
            userId: normalized.userId,
        })) return;

        const cmdHandled = await this.handleBotCommand(normalized);
        if (cmdHandled) return; // /invisible /mute /unmute 不进入 NC

        this.nc.push(buildTelegramNcMessage(normalized) as never);
    }

    private async normalizeBotApiMessage(msg: BotApiMessage): Promise<NormalizedIncomingMessage | null> {
        if (!msg.chat) return null;
        const chat = this.normalizeChat(msg.chat);
        const sender = msg.from ? this.normalizeUser(msg.from) : null;
        const chatId = composeChatId("telegram", chat.id);
        const isDirectMessage = chat.type === "private" || (!Number.isNaN(Number(chat.id)) && Number(chat.id) > 0);
        const mentionsAgent = this.detectSelfMention(msg);

        // ── 媒体元数据提取 + 自动下载（语义与 mtcute adapter 的 downloadIncomingMedia 一致） ──
        const mediaInfo = this.extractMediaInfo(msg);
        if (mediaInfo && mediaInfo.fileId) {
            await this.downloadIncomingMedia(mediaInfo, chatId, String(msg.message_id));
        }

        // 对纯 media 消息生成占位文本（与 mtcute adapter 相同的占位符）
        let text = msg.text ?? msg.caption ?? "";
        if (!text && mediaInfo) {
            switch (mediaInfo.type) {
                case "photo": text = "[📷 图片]"; break;
                case "sticker": text = mediaInfo.emoji ? `[🎭 贴纸: ${mediaInfo.emoji}]` : "[🎭 贴纸]"; break;
                case "video": text = "[🎬 视频]"; break;
                case "animation": text = "[🎞 GIF]"; break;
                case "audio": text = "[🎙 语音/音频]"; break;
                case "document": text = "[📎 文件]"; break;
                default: text = "[📎 媒体]"; break;
            }
        }

        const forward = this.extractForwardInfo(msg);
        if (forward?.name) {
            const urlHint = forward.url ? `(${forward.url})` : "";
            text = `[转发自: ${forward.name}${urlHint}]\n${text}`;
        }

        return {
            chatId,
            userId: sender ? composeChatId("telegram", sender.id) : "telegram:0",
            displayName: sender?.displayName ?? sender?.firstName ?? "Unknown",
            username: sender?.username ?? undefined,
            text,
            timestamp: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
            messageId: String(msg.message_id),
            replyToMessageId: msg.reply_to_message?.message_id != null ? String(msg.reply_to_message.message_id) : undefined,
            chatTitle: chat.title,
            chatType: chat.type,
            isDirectMessage,
            mentionsAgent,
            mediaInfo,
        };
    }

    /** @username / text_mention 是否指向 bot 自己（对应 mtcute 的 msg.isMention 语义） */
    private detectSelfMention(msg: BotApiMessage): boolean {
        if (!msg.entities || !Array.isArray(msg.entities)) return false;
        const selfUsername = this.selfUser?.username?.toLowerCase();
        for (const entity of msg.entities) {
            if (entity.type === "text_mention" && entity.user?.id != null) {
                if (String(entity.user.id) === this.selfNumericId) return true;
                continue;
            }
            if (entity.type === "mention" && selfUsername) {
                const mentioned = msg.text?.slice(entity.offset, entity.offset + entity.length)?.toLowerCase();
                if (mentioned === `@${selfUsername}`) return true;
            }
        }
        return false;
    }

    private extractForwardInfo(msg: BotApiMessage): { name?: string; url?: string } {
        const origin = msg.forward_origin as Record<string, unknown> | undefined;
        if (origin) {
            const type = String(origin.type ?? "");
            if (type === "user" || type === "hidden_user") {
                const user = origin.sender_user as BotApiUser | undefined;
                return {
                    name: (user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : "")
                        || String(origin.sender_user_name ?? "Unknown"),
                    url: user?.username ? `https://t.me/${user.username}` : undefined,
                };
            }
            if (type === "chat" || type === "channel") {
                const chat = (origin.chat ?? origin.sender_chat) as BotApiChat | undefined;
                return {
                    name: chat?.title ?? "Unknown",
                    url: chat?.username ? `https://t.me/${chat.username}` : undefined,
                };
            }
            return {};
        }
        // 旧版 Bot API 字段
        if (msg.forward_sender_name) return { name: msg.forward_sender_name };
        if (msg.forward_from) {
            const user = msg.forward_from;
            return {
                name: [user.first_name, user.last_name].filter(Boolean).join(" ") || String(user.id),
                url: user.username ? `https://t.me/${user.username}` : undefined,
            };
        }
        if (msg.forward_from_chat) {
            return {
                name: msg.forward_from_chat.title ?? String(msg.forward_from_chat.id),
                url: msg.forward_from_chat.username ? `https://t.me/${msg.forward_from_chat.username}` : undefined,
            };
        }
        return {};
    }

    /** Bot API 消息 → 结构化媒体元数据（类型映射与 mtcute extractMediaInfo 对齐） */
    private extractMediaInfo(msg: BotApiMessage): MediaInfo | undefined {
        const pick = (raw: BotApiFileBase, type: MediaInfo["type"], rawType?: string): MediaInfo => ({
            type,
            rawType: rawType ?? type,
            fileId: raw.file_id,
            uniqueFileId: raw.file_unique_id,
            emoji: typeof raw.emoji === "string" ? raw.emoji : undefined,
            mimeType: typeof raw.mime_type === "string" ? raw.mime_type : undefined,
            fileName: typeof raw.file_name === "string" ? raw.file_name : undefined,
            width: typeof raw.width === "number" ? raw.width : undefined,
            height: typeof raw.height === "number" ? raw.height : undefined,
            fileSize: typeof raw.file_size === "number" ? raw.file_size : undefined,
        });

        if (msg.sticker) return pick(msg.sticker, "sticker");
        if (msg.animation) return pick(msg.animation, "animation");
        if (msg.video_note) return pick(msg.video_note, "video", "video_note");
        if (msg.video) return pick(msg.video, "video");
        if (msg.voice) return pick(msg.voice, "audio", "voice");
        if (msg.audio) return pick(msg.audio, "audio");
        if (msg.photo?.length) {
            const largest = msg.photo.reduce((a, b) => ((b.width ?? 0) * (b.height ?? 0) >= (a.width ?? 0) * (a.height ?? 0) ? b : a));
            return {
                type: "photo",
                rawType: "photo",
                fileId: largest.file_id,
                uniqueFileId: largest.file_unique_id,
                width: largest.width,
                height: largest.height,
                fileSize: largest.file_size,
            };
        }
        if (msg.document) return pick(msg.document, "document");
        return undefined;
    }

    private async downloadIncomingMedia(mediaInfo: MediaInfo, chatId: string, messageId: string): Promise<void> {
        if (!this.mediaDownloader || !mediaInfo.fileId) return;

        const uniqueFileId = mediaInfo.uniqueFileId ?? mediaInfo.fileId;
        const existing = this.mediaDownloader.getExistingPath(uniqueFileId);
        if (existing) {
            mediaInfo.uniqueFileId = uniqueFileId;
            mediaInfo.filePath = existing;
            mediaInfo.downloadStatus = "cached";
            return;
        }

        if (!this.mediaDownloader.isWithinSizeLimit(mediaInfo.fileSize)) {
            mediaInfo.downloadStatus = "too_large";
            return;
        }

        try {
            const buffer = await this.downloadByFileId(mediaInfo.fileId);
            const saved = this.mediaDownloader.saveMedia(buffer, {
                chatId,
                messageId,
                uniqueFileId,
                mediaType: mediaInfo.type,
                mimeType: mediaInfo.mimeType,
                fileName: mediaInfo.fileName,
            });
            mediaInfo.uniqueFileId = uniqueFileId;
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
            log.warn("入站媒体自动下载失败", {
                chatId,
                messageId,
                type: mediaInfo.type,
                error: String(err).slice(0, 200),
            });
        }
    }

    // ─── /invisible /mute 命令（与 mtcute adapter 行为一致） ───

    private async handleBotCommand(normalized: NormalizedIncomingMessage): Promise<boolean> {
        const text = normalized.text.trim();

        const cmdMentionMatch = text.match(/^\/(\S+?)@(\S+)/);
        if (cmdMentionMatch) {
            const mentionedUsername = cmdMentionMatch[2].toLowerCase();
            const selfUsername = this.selfUser?.username?.toLowerCase();
            if (selfUsername && mentionedUsername !== selfUsername) {
                return false;
            }
        }

        if (/^\/invisible(?:@\S+)?$/i.test(text)) {
            const userId = normalized.userId;
            const nowInvisible = userGate.toggleInvisible(userId);
            if (nowInvisible) {
                log.info("/invisible ON", { userId, chatId: normalized.chatId });
                await this.replySafe(normalized.chatId, "🫥 你已开启隐身。你的所有消息将对 Bot 完全不可见（不处理、不记录）。再次发送 /invisible 可取消。");
            } else {
                log.info("/invisible OFF", { userId, chatId: normalized.chatId });
                await this.replySafe(normalized.chatId, "👁 你已取消隐身。Bot 将正常处理你的消息。");
            }
            return true;
        }

        const muteMatch = text.match(/^\/mute(?:@\S+)?(?:\s+(\d+(?:\.\d+)?))?$/i);
        if (muteMatch) {
            if (!muteMatch[1] && this.isChatMuted(normalized.chatId)) {
                this.mutedChats.delete(normalized.chatId);
                log.info("/mute OFF (toggle)", { chatId: normalized.chatId });
                await this.replySafe(normalized.chatId, "🔊 Bot 禁言已解除。");
                return true;
            }
            let hours = muteMatch[1] ? parseFloat(muteMatch[1]) : 1;
            hours = Math.max(1, Math.min(24, hours));
            const expiryMs = Date.now() + hours * 3_600_000;
            this.mutedChats.set(normalized.chatId, expiryMs);
            log.info("/mute ON", { chatId: normalized.chatId, hours, expiryMs });
            await this.replySafe(normalized.chatId, `🔇 Bot 已在本聊天禁言 ${hours} 小时。期间消息仍会被记录和处理，但 Bot 不会发送任何消息。再次发送 /mute 可解除。`);
            return true;
        }

        if (/^\/unmute(?:@\S+)?$/i.test(text)) {
            if (this.mutedChats.has(normalized.chatId)) {
                this.mutedChats.delete(normalized.chatId);
                log.info("/unmute", { chatId: normalized.chatId });
                await this.replySafe(normalized.chatId, "🔊 Bot 禁言已解除。");
            } else {
                await this.replySafe(normalized.chatId, "ℹ️ Bot 当前未被禁言。");
            }
            return true;
        }

        return false;
    }

    private async replySafe(chatId: string, text: string, autoDeleteMs?: number): Promise<void> {
        try {
            const chatArg = this.toBotApiChatId(chatId);
            const sent = await this.apiCall<BotApiMessage>("sendMessage", { chat_id: chatArg, text });
            if (autoDeleteMs && autoDeleteMs > 0 && sent?.message_id) {
                setTimeout(() => {
                    this.apiCall("deleteMessage", { chat_id: chatArg, message_id: sent.message_id }).catch(() => { /* 尽力删除 */ });
                }, autoDeleteMs);
            }
        } catch (err) {
            log.warn("replySafe 发送失败（忽略）", { chatId, error: String(err).slice(0, 200) });
        }
    }

    // ─── host-call 接口面 ───

    canHandle(method: string): boolean {
        return method.startsWith("telegram.");
    }

    getWriteMethods(): string[] {
        return [
            "telegram.sendText",
            "telegram.sendMedia",
            "telegram.sendFile",
            "telegram.sendSticker",
            "telegram.sendTyping",
            "telegram.sendMediaGroup",
            "telegram.forwardMessage",
            "telegram.sendPoll",
            "telegram.sendReaction",
            "telegram.editMessage",
            "telegram.deleteMessages",
            "telegram.pinMessage",
            "telegram.unpinMessage",
        ];
    }

    formatMention(_rawUserId: string, username?: string): string | undefined {
        return username ? `@${username}` : undefined;
    }

    getSceneTypeDefs(scene: string, baseTypeDefs: string): string | undefined {
        if (scene !== "telegram") return undefined;
        const modeNote = "// 当前 Telegram adapter 驱动: botapi (标准 Bot API over HTTP, getUpdates 长轮询)\n"
            + "// 注意: botapi 驱动无历史读取、对话遍历、成员枚举、username 解析等能力；\n"
            + "// 发送文本/媒体/贴纸/相册/投票/转发/编辑/删除/置顶/表情回应均可正常使用。\n";
        return `${modeNote}\n${baseTypeDefs}`.trim();
    }

    async handleCall(method: string, args: unknown[]): Promise<unknown> {
        if (this.config.mode !== "botapi") {
            throw new Error(`TelegramBotApiAdapter 仅处理 botapi 模式，当前为 "${this.config.mode}"`);
        }

        // ─── /mute 写操作拦截（与 mtcute adapter 一致） ───
        const MUTE_BLOCKED_METHODS = ["telegram.sendText", "telegram.sendMedia", "telegram.sendFile", "telegram.sendSticker", "telegram.sendTyping", "telegram.sendMediaGroup", "telegram.forwardMessage"];
        if (MUTE_BLOCKED_METHODS.includes(method)) {
            const chatId = ensureCompositeId("telegram", String(args[0] ?? ""));
            if (this.isChatMuted(chatId)) {
                const remaining = this.getMuteRemainingHours(chatId);
                log.info("mute 拦截写操作", { method, chatId, remaining });
                throw new Error(`[禁言中] 你在该聊天已被 /mute，剩余 ${remaining}。所有发送操作已被抑制。`);
            }
        }

        switch (method) {
            case "telegram.getMe":
                return this.selfUser;

            case "telegram.sendText": {
                const chatArg = this.toBotApiChatId(args[0]);
                const replyParams = this.toReplyParameters(args[2]);
                const text = String(args[1] ?? "");
                const chunks = this.splitPlainText(text);
                let sent: BotApiMessage | null = null;
                for (let i = 0; i < chunks.length; i++) {
                    sent = await this.apiCall<BotApiMessage>("sendMessage", {
                        chat_id: chatArg,
                        text: chunks[i],
                        ...(i === 0 && replyParams ? { reply_parameters: replyParams } : {}),
                    });
                }
                return this.normalizeSentMessage(sent);
            }

            case "telegram.sendMedia":
                return this.handleSendMedia(args[0], args[1], args[2]);

            case "telegram.sendFile": {
                // args: [chatId, filePath, opts?]
                const filePath = String(args[1] ?? "");
                const fileOpts = (args[2] ?? {}) as Record<string, unknown>;
                const buffer = this.readLocalUploadFile(filePath, "sendFile");
                const sent = await this.apiUpload<BotApiMessage>("sendDocument", {
                    chat_id: this.toBotApiChatId(args[0]),
                    ...(typeof fileOpts.caption === "string" && fileOpts.caption ? { caption: fileOpts.caption } : {}),
                    ...this.replyFields(args[2]),
                }, "document", {
                    buffer,
                    fileName: typeof fileOpts.fileName === "string" && fileOpts.fileName ? fileOpts.fileName : path.basename(filePath),
                    mimeType: typeof fileOpts.mimeType === "string" ? fileOpts.mimeType : undefined,
                });
                return this.normalizeSentMessage(sent);
            }

            case "telegram.sendSticker": {
                // args: [chatId, uniqueFileId, opts?]
                if (!this.mediaDownloader) {
                    throw new Error("sendSticker: mediaDownloader not injected into TelegramBotApiAdapter");
                }
                const uniqueFileId = String(args[1] ?? "");
                if (!uniqueFileId) throw new Error("sendSticker: uniqueFileId 为空");
                const stickerPath = this.mediaDownloader.getExistingPath(uniqueFileId);
                if (!stickerPath) throw new Error(`sendSticker: 未找到贴纸文件 uniqueFileId=${uniqueFileId}`);
                if (!fs.existsSync(stickerPath)) throw new Error(`sendSticker: 文件不存在 ${stickerPath}`);
                // Bot API sendSticker 原生接受 webp / webm / tgs，无需 mtcute adapter 的格式转换
                const buffer = fs.readFileSync(stickerPath);
                const ext = path.extname(stickerPath).toLowerCase();
                const sent = await this.apiUpload<BotApiMessage>("sendSticker", {
                    chat_id: this.toBotApiChatId(args[0]),
                    ...this.replyFields(args[2]),
                }, "sticker", {
                    buffer,
                    fileName: path.basename(stickerPath),
                    mimeType: EXT_MIME[ext] ?? (ext === ".tgs" ? "application/x-tgsticker" : undefined),
                });
                return this.normalizeSentMessage(sent);
            }

            case "telegram.getChat": {
                const chat = await this.apiCall<BotApiChat>("getChat", { chat_id: this.toBotApiChatId(args[0]) });
                return this.normalizeChat(chat);
            }

            case "telegram.getUser": {
                // Bot API 没有独立 getUser；getChat 对用户 ID 同样生效（要求 bot 已知该用户）
                const chat = await this.apiCall<BotApiChat>("getChat", { chat_id: this.toBotApiChatId(args[0]) });
                return this.normalizeUser({
                    id: chat.id,
                    first_name: chat.first_name,
                    last_name: chat.last_name,
                    username: chat.username,
                    is_bot: false,
                });
            }

            case "telegram.getChatMembers": {
                const opts = (args[1] ?? {}) as Record<string, unknown>;
                if (opts.userId != null) {
                    const member = await this.apiCall<BotApiUser>("getChatMember", {
                        chat_id: this.toBotApiChatId(args[0]),
                        user_id: Number(opts.userId),
                    });
                    return [this.normalizeUser(member)];
                }
                // Bot API 只能枚举管理员，无法全量枚举成员
                const admins = await this.apiCall<BotApiUser[]>("getChatAdministrators", { chat_id: this.toBotApiChatId(args[0]) });
                return admins.map((member) => this.normalizeUser(member));
            }

            case "telegram.getHistory": {
                throw new Error(
                    "botapi 驱动无历史读取权限（Bot API 禁止 bot 读历史）。"
                    + "请直接使用 telegram.sendText(chatId, text) 发送消息，不需要先获取历史消息。",
                );
            }

            case "telegram.getDialogs":
            case "telegram.findDialogs":
            case "telegram.searchMessages":
            case "telegram.getMessages":
                throw new Error(`botapi 驱动不支持 ${method}（Bot API 无对应能力）`);

            case "telegram.meetPeer":
            case "telegram.resolvePeer": {
                // botapi 只能解析数值 ID（bot 已知会话）；@username 无法反查
                const target = String(args[0] ?? "").replace(/^telegram:/, "").trim();
                if (!/^-?\d+$/.test(target)) {
                    throw new Error("botapi 驱动无法解析 username / phone（只能用数值 chat_id；会话 ID 可从消息上下文获取）");
                }
                const chat = await this.apiCall<BotApiChat>("getChat", { chat_id: Number(target) });
                return this.normalizeChat(chat);
            }

            case "telegram.readHistory":
                // Bot API 无法标记已读；静默忽略（read-receipts 调用方预期 no-op 也可以）
                return null;

            case "telegram.sendTyping": {
                await this.apiCall("sendChatAction", { chat_id: this.toBotApiChatId(args[0]), action: "typing" });
                return null;
            }

            case "telegram.downloadMedia": {
                // args: [fileId | mediaInfo, chatId?, messageId?, uniqueFileId?]
                const fileRef = args[0];
                const fileId = typeof fileRef === "string" && fileRef.trim()
                    ? fileRef.trim()
                    : fileRef && typeof fileRef === "object" && typeof (fileRef as { fileId?: unknown }).fileId === "string"
                        ? (fileRef as { fileId: string }).fileId
                        : "";
                if (!fileId) throw new Error("downloadMedia: fileId is required");
                const uniqueFileId = typeof args[3] === "string" ? args[3] : undefined;
                if (uniqueFileId && this.mediaDownloader) {
                    const cachedPath = this.mediaDownloader.getExistingPath(uniqueFileId);
                    if (cachedPath && fs.existsSync(cachedPath)) {
                        const cached = fs.readFileSync(cachedPath);
                        return { buffer: cached.toString("base64"), size: cached.length };
                    }
                }
                const buffer = await this.downloadByFileId(fileId);
                return { buffer: buffer.toString("base64"), size: buffer.length };
            }

            case "telegram.sendMediaGroup": {
                const medias = Array.isArray(args[1]) ? args[1] as OutgoingMediaArg[] : [];
                if (medias.length < 2 || medias.length > 10) {
                    throw new Error(`sendMediaGroup: 需要 2-10 个媒体对象，收到 ${medias.length} 个`);
                }
                const baseFields: Record<string, unknown> = {
                    chat_id: this.toBotApiChatId(args[0]),
                    ...this.replyFields(args[2]),
                };
                const prepared: Array<{ field: string; file: ResolvedFile }> = [];
                const inputMedia = [] as Record<string, unknown>[];
                for (let i = 0; i < medias.length; i++) {
                    const resolved = await this.resolveOutgoingFile(medias[i], `sendMediaGroup[${i}]`);
                    const botType = this.botApiMediaType(medias[i]?.type, resolved);
                    if (resolved.kind === "buffer") {
                        const field = `file${i}`;
                        prepared.push({ field, file: resolved });
                        inputMedia.push({
                            type: botType,
                            media: `attach://${field}`,
                            ...(medias[i]?.caption ? { caption: medias[i]!.caption } : {}),
                        });
                    } else {
                        inputMedia.push({
                            type: botType,
                            media: resolved.url,
                            ...(medias[i]?.caption ? { caption: medias[i]!.caption } : {}),
                        });
                    }
                }
                let sent: BotApiMessage[];
                if (prepared.length > 0) {
                    const form = new FormData();
                    for (const [key, value] of Object.entries(baseFields)) {
                        if (value === undefined || value === null) continue;
                        form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
                    }
                    form.append("media", JSON.stringify(inputMedia));
                    for (const item of prepared) {
                        form.append(item.field, new Blob([new Uint8Array(item.file.buffer!)], {
                            type: item.file.mimeType || "application/octet-stream",
                        }), item.file.fileName ?? "media");
                    }
                    sent = await this.parseResponse<BotApiMessage[]>(await fetch(this.methodUrl("sendMediaGroup"), { method: "POST", body: form }), "sendMediaGroup");
                } else {
                    sent = await this.apiCall<BotApiMessage[]>("sendMediaGroup", { ...baseFields, media: inputMedia });
                }
                return sent.map((m) => this.normalizeSentMessage(m));
            }

            case "telegram.forwardMessage": {
                const messageIds = this.normalizeMessageIds(args[2]);
                const opts = (args[3] ?? {}) as Record<string, unknown>;
                const sent = await this.apiCall<BotApiMessage[]>("forwardMessages", {
                    chat_id: this.toBotApiChatId(args[0]),
                    from_chat_id: this.toBotApiChatId(args[1]),
                    message_ids: messageIds,
                    ...(opts.dropAuthor === true || opts.drop_author === true ? { drop_author: true } : {}),
                    ...(opts.disableNotification === true || opts.disable_notification === true ? { disable_notification: true } : {}),
                    ...(opts.protectContent === true || opts.protect_content === true ? { protect_content: true } : {}),
                });
                const normalized = sent.map((m) => this.normalizeSentMessage(m));
                return Array.isArray(args[2]) ? normalized : normalized[0] ?? null;
            }

            case "telegram.sendPoll": {
                const question = String(args[1] ?? "");
                const options = Array.isArray(args[2]) ? args[2].map((opt) => String(opt)) : [];
                const pollOpts = (args[3] ?? {}) as Record<string, unknown>;
                const sent = await this.apiCall<BotApiMessage>("sendPoll", {
                    chat_id: this.toBotApiChatId(args[0]),
                    question,
                    options: options.map((text) => ({ text })),
                    is_anonymous: pollOpts.isAnonymous !== false,
                    ...(pollOpts.type === "quiz"
                        ? {
                            type: "quiz",
                            ...(typeof pollOpts.correctOptionId === "number" ? { correct_option_id: pollOpts.correctOptionId } : {}),
                            ...(typeof pollOpts.explanation === "string" ? { explanation: pollOpts.explanation } : {}),
                        }
                        : {}),
                    ...(pollOpts.allowsMultipleAnswers === true ? { allows_multiple_answers: true } : {}),
                    ...this.replyFields(args[3]),
                });
                return this.normalizeSentMessage(sent);
            }

            case "telegram.sendReaction": {
                const emoji = args[2] as string | null | undefined;
                await this.apiCall("setMessageReaction", {
                    chat_id: this.toBotApiChatId(args[0]),
                    message_id: Number(args[1]),
                    reaction: emoji ? [{ type: "emoji", emoji }] : [],
                });
                return null;
            }

            case "telegram.editMessage": {
                const sent = await this.apiCall<BotApiMessage>("editMessageText", {
                    chat_id: this.toBotApiChatId(args[0]),
                    message_id: Number(args[1]),
                    text: String(args[2] ?? ""),
                });
                return this.normalizeSentMessage(sent);
            }

            case "telegram.deleteMessages": {
                const chatArg = this.toBotApiChatId(args[0]);
                const ids = Array.isArray(args[1]) ? args[1].map(Number).filter((id) => Number.isSafeInteger(id)) : [];
                for (let i = 0; i < ids.length; i += 100) {
                    await this.apiCall("deleteMessages", { chat_id: chatArg, message_ids: ids.slice(i, i + 100) });
                }
                return null;
            }

            case "telegram.pinMessage": {
                const pinOpts = (args[2] ?? {}) as Record<string, unknown>;
                await this.apiCall("pinChatMessage", {
                    chat_id: this.toBotApiChatId(args[0]),
                    message_id: Number(args[1]),
                    disable_notification: pinOpts.silent === true,
                });
                return null;
            }

            case "telegram.unpinMessage": {
                await this.apiCall("unpinChatMessage", {
                    chat_id: this.toBotApiChatId(args[0]),
                    message_id: Number(args[1]),
                });
                return null;
            }

            case "telegram.joinChat":
            case "telegram.leaveChat":
                throw new Error("botapi 驱动不支持加入/退出会话（Bot API 无对应能力，请在 Telegram 客户端中手动操作）");

            case "telegram.mtcute":
                throw new Error("botapi 驱动不走 MTProto，telegram.mtcute 直连方法不可用");

            default:
                throw new Error(`Unsupported TelegramBotApiAdapter call: ${method}`);
        }
    }

    /** sendMedia 多路分发：按媒体类型选择 Bot API 端点 */
    private async handleSendMedia(chatIdArg: unknown, mediaArg: unknown, optsArg: unknown): Promise<unknown> {
        const chatArg = this.toBotApiChatId(chatIdArg);
        const media = (mediaArg && typeof mediaArg === "object" ? mediaArg : {}) as OutgoingMediaArg;
        const resolved = await this.resolveOutgoingFile(media, "sendMedia");
        const botType = this.botApiMediaType(media.type, resolved);
        const endpoint = this.botApiMediaEndpoint(botType);
        const fileField = this.botApiMediaFileField(botType);

        const caption = typeof media.caption === "string" && media.caption
            ? media.caption
            : typeof (optsArg as Record<string, unknown> | null)?.caption === "string"
                ? (optsArg as Record<string, unknown>).caption as string
                : undefined;

        const fields: Record<string, unknown> = {
            chat_id: chatArg,
            ...(caption ? { caption } : {}),
            ...this.replyFields(optsArg),
        };

        let sent: BotApiMessage;
        if (resolved.kind === "buffer") {
            sent = await this.apiUpload<BotApiMessage>(endpoint, fields, fileField, {
                buffer: resolved.buffer!,
                fileName: resolved.fileName ?? this.defaultFileName(botType),
                mimeType: resolved.mimeType,
            });
        } else {
            fields[fileField] = resolved.url!;
            sent = await this.apiCall<BotApiMessage>(endpoint, fields);
        }
        log.info("telegram.sendMedia:success", {
            target: String(chatIdArg ?? ""),
            mediaType: botType,
            messageId: sent?.message_id,
        });
        return this.normalizeSentMessage(sent);
    }

    private botApiMediaType(type: string | undefined, file: ResolvedFile): string {
        const raw = (type ?? "").toLowerCase();
        if (raw === "photo" || raw === "image") return "photo";
        if (raw === "sticker") return "sticker";
        if (raw === "video") return "video";
        if (raw === "animation" || raw === "gif") return "animation";
        if (raw === "audio") return "audio";
        if (raw === "voice") return "voice";
        if (raw === "video_note" || raw === "videonote") return "video_note";
        if (raw === "document" || raw === "file") return "document";
        // auto：按 MIME 猜；未知类型一律走 document（Bot API 接受任意文件）
        const mime = file.mimeType ?? "";
        if (mime.startsWith("image/")) return "photo";
        if (mime.startsWith("video/")) return "video";
        if (mime.startsWith("audio/")) return "audio";
        return "document";
    }

    private botApiMediaEndpoint(type: string): string {
        switch (type) {
            case "photo": return "sendPhoto";
            case "sticker": return "sendSticker";
            case "video": return "sendVideo";
            case "animation": return "sendAnimation";
            case "audio": return "sendAudio";
            case "voice": return "sendVoice";
            case "video_note": return "sendVideoNote";
            default: return "sendDocument";
        }
    }

    private botApiMediaFileField(type: string): string {
        switch (type) {
            case "photo": return "photo";
            case "sticker": return "sticker";
            case "video": return "video";
            case "animation": return "animation";
            case "audio": return "audio";
            case "voice": return "voice";
            case "video_note": return "video_note";
            default: return "document";
        }
    }

    private defaultFileName(type: string): string {
        switch (type) {
            case "photo": return "image.jpg";
            case "video": return "video.mp4";
            case "animation": return "animation.gif";
            case "audio": return "audio.mp3";
            case "voice": return "voice.ogg";
            case "video_note": return "video_note.mp4";
            default: return "file";
        }
    }

    /**
     * 解析发送侧媒体来源：
     * - http(s) URL → 直接透传给 Bot API（服务端自行拉取）
     * - data: URL / Buffer / 本地路径 → 读为 Buffer 上传
     * 本地路径解析顺序与 mtcute adapter 的 localUploadPathCandidates 一致（cwd / cwd/workspace）。
     */
    private async resolveOutgoingFile(media: OutgoingMediaArg | string, method: string): Promise<ResolvedFile> {
        const source = typeof media === "string" ? media : media?.file;
        if (typeof source === "string") {
            const trimmed = source.trim();
            if (/^https?:/i.test(trimmed)) {
                return { kind: "url", url: trimmed, fileName: typeof media === "object" ? media.fileName : undefined, mimeType: typeof media === "object" ? media.fileMime : undefined };
            }
            if (/^data:/i.test(trimmed)) {
                const buffer = this.bufferFromDataUrl(trimmed, method);
                return {
                    kind: "buffer",
                    buffer,
                    fileName: typeof media === "object" ? media.fileName : undefined,
                    mimeType: typeof media === "object" ? media.fileMime : undefined,
                };
            }
            const buffer = this.readLocalUploadFile(trimmed, method);
            return {
                kind: "buffer",
                buffer,
                fileName: typeof media === "object" && media.fileName ? media.fileName : path.basename(trimmed),
                mimeType: typeof media === "object" ? media.fileMime : undefined,
            };
        }
        if (Buffer.isBuffer(source)) {
            return {
                kind: "buffer",
                buffer: source,
                fileName: typeof media === "object" ? media.fileName : undefined,
                mimeType: typeof media === "object" ? media.fileMime : undefined,
            };
        }
        if (source instanceof Uint8Array) {
            return {
                kind: "buffer",
                buffer: Buffer.from(source),
                fileName: typeof media === "object" ? media.fileName : undefined,
                mimeType: typeof media === "object" ? media.fileMime : undefined,
            };
        }
        throw new Error(`${method}: 无法识别的媒体来源（支持 http(s) URL / data: URL / Buffer / 本地路径）`);
    }

    private readLocalUploadFile(filePath: string, method: string): Buffer {
        const trimmed = filePath.trim().replace(/^file:\/\//i, "");
        const candidates = [
            path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(process.cwd(), trimmed),
            path.resolve(process.cwd(), "workspace", trimmed),
        ];
        const existing = [...new Set(candidates)].find((candidate) => {
            try {
                return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
            } catch {
                return false;
            }
        });
        if (!existing) {
            throw new Error(`${method}: 本地媒体文件不存在: ${trimmed} (尝试: ${[...new Set(candidates)].join(", ")})`);
        }
        return fs.readFileSync(existing);
    }

    private bufferFromDataUrl(dataUrl: string, method: string): Buffer {
        const match = dataUrl.match(/^data:[^;,]*;(?:base64)?,([\s\S]*)$/i);
        if (!match) throw new Error(`${method}: 无法解析 data: URL`);
        return Buffer.from(match[1], "base64");
    }

    // ─── 小工具 ───

    /** composite chatId / raw ID / @username → Bot API chat_id（数字字符串转 number） */
    private toBotApiChatId(value: unknown): number | string {
        let raw = String(value ?? "").trim();
        if (raw.startsWith("telegram:")) raw = raw.slice("telegram:".length);
        if (/^-?\d+$/.test(raw)) return Number(raw);
        return raw;
    }

    private toReplyParameters(opts: unknown): { message_id: number } | undefined {
        if (!opts || typeof opts !== "object") return undefined;
        const replyTo = (opts as Record<string, unknown>).replyTo
            ?? (opts as Record<string, unknown>).reply_to;
        const num = Number(replyTo);
        if (Number.isFinite(num) && num > 0) {
            return { message_id: Math.floor(num) };
        }
        return undefined;
    }

    private replyFields(opts: unknown): Record<string, unknown> {
        const replyParams = this.toReplyParameters(opts);
        // Bot API 的 reply_parameters 是对象 { message_id }（JSON body 直接嵌套，multipart 由 apiUpload 序列化）
        return replyParams ? { reply_parameters: replyParams } : {};
    }

    private splitPlainText(text: string): string[] {
        const input = text.length > 0 ? text : "…";
        if (input.length <= PLAIN_TEXT_LIMIT) return [input];
        // 无损分块：优先在换行处切，切出的各段原样拼接回全文
        const chunks: string[] = [];
        let rest = input;
        while (rest.length > PLAIN_TEXT_LIMIT) {
            let cut = rest.lastIndexOf("\n", PLAIN_TEXT_LIMIT);
            if (cut < PLAIN_TEXT_LIMIT / 2) cut = PLAIN_TEXT_LIMIT;
            chunks.push(rest.slice(0, cut));
            rest = rest.slice(cut);
        }
        if (rest) chunks.push(rest);
        return chunks;
    }

    private normalizeMessageIds(value: unknown): number[] {
        const rawIds = Array.isArray(value) ? value : [value];
        const ids = rawIds.map((raw) => Number(raw));
        if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
            throw new Error("forwardMessage: messageIds must be a positive message id or id array");
        }
        if (ids.length > 100) {
            throw new Error("forwardMessage: Telegram only allows forwarding up to 100 messages at once");
        }
        return ids;
    }

    private normalizeSentMessage(msg: BotApiMessage | null): PlainMessage {
        if (!msg) {
            return {
                id: "",
                text: "",
                date: new Date().toISOString(),
                chat: { id: "", type: "private" },
                sender: null,
                isMention: false,
            };
        }
        return {
            id: String(msg.message_id),
            text: msg.text ?? msg.caption ?? "",
            date: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
            chat: this.normalizeChat(msg.chat),
            sender: msg.from ? this.normalizeUser(msg.from) : null,
            isMention: false,
            replyToMessage: msg.reply_to_message ? { id: String(msg.reply_to_message.message_id) } : undefined,
            mediaInfo: this.extractMediaInfo(msg),
        };
    }

    private normalizeUser(user: Partial<BotApiUser> & { id: number }): PlainUser {
        return {
            id: String(user.id ?? ""),
            displayName: [user.first_name, user.last_name].filter(Boolean).join(" ")
                || user.username
                || String(user.id ?? ""),
            username: typeof user.username === "string" ? user.username : undefined,
            firstName: typeof user.first_name === "string" ? user.first_name : undefined,
            lastName: typeof user.last_name === "string" ? user.last_name : undefined,
            isBot: Boolean(user.is_bot),
        };
    }

    private normalizeChat(chat: Partial<BotApiChat> & { id: number }): PlainChat {
        const type = chat.type;
        return {
            id: String(chat.id ?? ""),
            title: typeof chat.title === "string"
                ? chat.title
                : [chat.first_name, chat.last_name].filter(Boolean).join(" ") || undefined,
            username: typeof chat.username === "string" ? chat.username : undefined,
            type: type === "private" || type === "group" || type === "supergroup" || type === "channel" ? type : "group",
        };
    }

    // ─── /mute 查询方法（dashboard 用，与 mtcute adapter 一致） ───

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
        // Bot API 无法标记已读，静默忽略
    }

    /**
     * 补抓离线期间漏掉的消息。
     *
     * Bot API 无历史读取权限，但 getUpdates offset 持久化在本地：
     * 离线期间 Telegram 服务端会为未确认 update 保留 24 小时，
     * 重启后轮询循环会自动按 offset 拉齐，无需（也无法）在这里补抓。
     */
    async fetchMissedMessages(_options: BackfillOptions): Promise<BackfillResult> {
        return {
            chats: 0,
            messages: 0,
            notes: [
                "botapi 模式无历史读取权限（Bot API 禁止 bot 读历史）；"
                + "离线消息由 getUpdates offset 持久化自动恢复（服务端保留 24h）",
            ],
        };
    }
}

// ─── 模块级小工具 ───

function cleanBody(body: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
        if (value !== undefined && value !== null) out[key] = value;
    }
    return out;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
