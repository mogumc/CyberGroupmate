import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type TelegramEventHandler = (message: unknown) => void | Promise<void>;

type FetchLike = typeof fetch;

type BotApiEnvelope<T> = {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
};

type BotApiUser = {
    id: number;
    is_bot: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
};

type BotApiChat = {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
};

type BotApiFile = {
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    width?: number;
    height?: number;
    emoji?: string;
};

type BotApiMessage = {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    chat: BotApiChat;
    from?: BotApiUser;
    sender_chat?: BotApiChat;
    reply_to_message?: { message_id: number; from?: BotApiUser };
    entities?: Array<{ type: string; offset: number; length: number; user?: BotApiUser }>;
    caption_entities?: BotApiMessage["entities"];
    photo?: BotApiFile[];
    document?: BotApiFile;
    video?: BotApiFile;
    animation?: BotApiFile;
    audio?: BotApiFile;
    voice?: BotApiFile;
    sticker?: BotApiFile;
};

type BotApiUpdate = {
    update_id: number;
    message?: BotApiMessage;
    edited_message?: BotApiMessage;
    channel_post?: BotApiMessage;
    edited_channel_post?: BotApiMessage;
};

/**
 * HTTP client selected explicitly by mode: bot_api.
 * It keeps the TelegramAdapter event contract while
 * intentionally exposing only Bot API capabilities.
 */
export class TelegramBotApiClient {
    private readonly handlers = new Set<TelegramEventHandler>();
    private readonly baseUrl: string;
    /** getUpdates 长轮询超时（秒），钳制在 Telegram 允许的 0–50 区间 */
    private readonly pollTimeoutSec: number;
    private running = false;
    private polling: Promise<void> | null = null;
    private abortController: AbortController | null = null;
    private updateOffset = 0;
    private self: BotApiUser | null = null;
    private lifetime = new AbortController();
    private readonly errorHandlers = new Set<(error: Error) => void>();
    private readonly stateHandlers = new Set<(state: string) => void>();
    readonly onError = { add: (handler: (error: Error) => void) => { this.errorHandlers.add(handler); } };
    readonly onConnectionState = { add: (handler: (state: string) => void) => { this.stateHandlers.add(handler); } };

    readonly onNewMessage = {
        add: (handler: TelegramEventHandler) => {
            this.handlers.add(handler);
            this.ensurePolling();
        },
        remove: (handler: TelegramEventHandler) => {
            this.handlers.delete(handler);
            if (this.handlers.size === 0) this.abortController?.abort();
        },
    };

    constructor(
        private readonly botToken: string,
        private readonly fetchImpl: FetchLike = globalThis.fetch,
        baseUrl = "https://api.telegram.org",
        pollTimeoutSec = 30,
    ) {
        this.baseUrl = `${baseUrl.replace(/\/$/, "")}/bot${botToken}`;
        this.pollTimeoutSec = Math.max(0, Math.min(50, Math.floor(pollTimeoutSec)));
    }

    async start(_params: Record<string, unknown> = {}): Promise<unknown> {
        if (this.running) return this.getMe();
        if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
        const self = await this.api<BotApiUser>("getMe");
        const webhook = await this.api<{ url: string }>("getWebhookInfo");
        if (webhook.url) {
            throw new Error("Telegram Bot API polling conflicts with an existing webhook; remove it explicitly before starting bot_api mode");
        }
        this.self = self;
        this.running = true;
        this.ensurePolling();
        return this.normalizeUser(self);
    }

    async destroy(): Promise<void> {
        this.running = false;
        this.lifetime.abort();
        this.abortController?.abort();
        try {
            await this.polling;
        } catch {
            // An abort during shutdown is expected.
        }
        this.polling = null;
        this.abortController = null;
    }

    async getMe(): Promise<unknown> {
        if (!this.self) this.self = await this.api<BotApiUser>("getMe");
        return this.normalizeUser(this.self);
    }

    async getChat(chatId: unknown): Promise<unknown> {
        return this.normalizeChat(await this.api<BotApiChat>("getChat", { chat_id: this.chatId(chatId) }));
    }

    async downloadAsBuffer(fileId: unknown): Promise<Uint8Array> {
        const id = String(fileId ?? "").trim();
        if (!id) throw new Error("Telegram Bot API downloadAsBuffer requires a file_id");
        const file = await this.api<{ file_path?: string }>("getFile", { file_id: id });
        if (!file.file_path) throw new Error("Telegram Bot API getFile returned no file_path");
        const response = await this.request(`${this.baseUrl.replace(/\/bot([^/]+)$/, "/file/bot$1")}/${file.file_path}`);
        if (!response.ok) throw new Error(`Telegram Bot API file download failed: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
    }

    async sendText(chatId: unknown, text: unknown, opts?: unknown): Promise<unknown> {
        const result = await this.api<BotApiMessage>("sendMessage", {
            chat_id: this.chatId(chatId),
            text: typeof text === "string" ? text : String(text ?? ""),
            ...this.replyOptions(opts),
        });
        return this.normalizeMessage(result);
    }

    async sendTyping(chatId: unknown): Promise<void> {
        await this.api("sendChatAction", { chat_id: this.chatId(chatId), action: "typing" });
    }

    async sendMedia(chatId: unknown, media: unknown, opts?: unknown): Promise<unknown> {
        const value = media && typeof media === "object" ? media as Record<string, unknown> : { file: media };

        // 投票走 sendPoll 端点（Bot API 的 poll 不是 InputMedia；mtcute 侧通过 InputMedia.poll 实现）
        if (value.type === "poll") {
            // answers 兼容两种来源：sandbox 直接传字符串数组，adapter 的 sendPoll case 传 [{ text }] 对象数组
            const answers = Array.isArray(value.answers)
                ? value.answers.map((item) => ({
                    text: typeof item === "string" ? item : String((item as Record<string, unknown>)?.text ?? ""),
                }))
                : [];
            const payload: Record<string, unknown> = {
                chat_id: this.chatId(chatId),
                question: typeof value.question === "string" ? value.question : String(value.question ?? ""),
                options: answers,
                is_anonymous: value.isAnonymous !== false,
                ...this.replyOptions(opts),
            };
            if (value.quiz === true) {
                payload.type = "quiz";
                if (typeof value.correctOptionId === "number") payload.correct_option_id = value.correctOptionId;
                if (typeof value.solution === "string") payload.explanation = value.solution;
            }
            if (value.allowMultipleAnswers === true) payload.allows_multiple_answers = true;
            const result = await this.api<BotApiMessage>("sendPoll", payload);
            return this.normalizeMessage(result);
        }

        const type = typeof value.type === "string" ? value.type : "document";
        const methodAndField = this.mediaMethod(type, value);
        const form = new FormData();
        form.set("chat_id", this.chatId(chatId));
        const caption = typeof value.caption === "string" ? value.caption : undefined;
        if (caption) form.set("caption", caption);
        for (const [key, item] of Object.entries(this.replyOptions(opts))) {
            form.set(key, String(item));
        }

        const file = value.file;
        if (file instanceof Uint8Array || Buffer.isBuffer(file)) {
            const name = typeof value.fileName === "string" && value.fileName.trim()
                ? value.fileName.trim()
                : `${type || "document"}.bin`;
            const mime = typeof value.fileMime === "string" ? value.fileMime : "application/octet-stream";
            // Copy into a plain ArrayBuffer: Node's Buffer can be backed by a
            // SharedArrayBuffer, which TypeScript correctly refuses as BlobPart.
            const bytes = new Uint8Array(file.byteLength);
            bytes.set(file);
            form.set(methodAndField.field, new Blob([bytes.buffer], { type: mime }), basename(name));
        } else if (typeof file === "string" && file.trim()) {
            form.set(methodAndField.field, file.trim());
        } else {
            throw new Error("Telegram Bot API sendMedia requires a file_id, URL, or binary file");
        }

        const result = await this.apiForm<BotApiMessage>(methodAndField.method, form);
        return this.normalizeMessage(result);
    }

    async sendMediaGroup(chatId: unknown, medias: unknown, opts?: unknown): Promise<unknown[]> {
        const items = Array.isArray(medias) ? medias : [];
        if (items.length < 2 || items.length > 10) {
            throw new Error(`Telegram Bot API sendMediaGroup requires 2-10 media objects, got ${items.length}`);
        }
        const form = new FormData();
        form.set("chat_id", this.chatId(chatId));
        for (const [key, item] of Object.entries(this.replyOptions(opts))) {
            form.set(key, String(item));
        }
        const attached: Array<{ field: string; bytes: Uint8Array<ArrayBuffer>; fileName: string; mime: string }> = [];
        const inputMedia = items.map((raw, index) => {
            const value = (raw && typeof raw === "object" ? raw : { file: raw }) as Record<string, unknown>;
            const type = typeof value.type === "string" ? value.type : "document";
            const methodAndField = this.mediaMethod(type, value);
            const entry: Record<string, unknown> = { type: methodAndField.field };
            if (typeof value.caption === "string" && value.caption) entry.caption = value.caption;
            const file = value.file;
            if (file instanceof Uint8Array || Buffer.isBuffer(file)) {
                const field = `file${index}`;
                const name = typeof value.fileName === "string" && value.fileName.trim()
                    ? value.fileName.trim()
                    : `${methodAndField.field}.bin`;
                const mime = typeof value.fileMime === "string" ? value.fileMime : "application/octet-stream";
                // Copy into a plain ArrayBuffer: Node's Buffer can be backed by a
                // SharedArrayBuffer, which TypeScript correctly refuses as BlobPart.
                const bytes = new Uint8Array(new ArrayBuffer(file.byteLength));
                bytes.set(file);
                attached.push({ field, bytes, fileName: basename(name), mime });
                entry.media = `attach://${field}`;
            } else if (typeof file === "string" && file.trim()) {
                entry.media = file.trim();
            } else {
                throw new Error(`Telegram Bot API sendMediaGroup[${index}] requires a file_id, URL, or binary file`);
            }
            return entry;
        });
        form.set("media", JSON.stringify(inputMedia));
        for (const item of attached) {
            form.set(item.field, new Blob([item.bytes], { type: item.mime }), item.fileName);
        }
        const result = await this.apiForm<BotApiMessage[]>("sendMediaGroup", form);
        return result.map((message) => this.normalizeMessage(message));
    }

    /** 转发消息（Bot API forwardMessages 端点）。参数形状对齐 adapter 的 forwardMessagesById 调用。 */
    async forwardMessagesById(params: Record<string, unknown>): Promise<unknown[]> {
        const messageIds = Array.isArray(params.messages) ? params.messages.map(Number) : [Number(params.messages)];
        if (messageIds.length === 0 || messageIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
            throw new Error("forwardMessagesById requires positive message id(s)");
        }
        const payload: Record<string, unknown> = {
            chat_id: this.chatId(params.toChatId),
            from_chat_id: this.chatId(params.fromChatId),
            message_ids: messageIds,
        };
        if (params.noAuthor === true || params.drop_author === true) payload.drop_author = true;
        if (params.silent === true || params.disable_notification === true) payload.disable_notification = true;
        if (params.protectContent === true || params.protect_content === true) payload.protect_content = true;
        const result = await this.api<BotApiMessage[]>("forwardMessages", payload);
        return result.map((message) => this.normalizeMessage(message));
    }

    async sendReaction(params: { chatId: unknown; message: unknown; emoji: unknown }): Promise<void> {
        const emoji = params.emoji;
        await this.api("setMessageReaction", {
            chat_id: this.chatId(params.chatId),
            message_id: Number(params.message),
            reaction: emoji ? [{ type: "emoji", emoji: String(emoji) }] : [],
        });
    }

    async editMessage(params: { chatId: unknown; message: unknown; text: unknown }): Promise<unknown> {
        const result = await this.api<BotApiMessage>("editMessageText", {
            chat_id: this.chatId(params.chatId),
            message_id: Number(params.message),
            text: typeof params.text === "string" ? params.text : String(params.text ?? ""),
        });
        return this.normalizeMessage(result);
    }

    /** Bot API deleteMessages 单次上限 100 条，分批提交。 */
    async deleteMessagesById(chatId: unknown, messageIds: unknown, _opts?: unknown): Promise<void> {
        const ids = (Array.isArray(messageIds) ? messageIds : [messageIds])
            .map((id) => Number(id))
            .filter((id) => Number.isSafeInteger(id) && id > 0);
        const chat = this.chatId(chatId);
        for (let i = 0; i < ids.length; i += 100) {
            await this.api("deleteMessages", { chat_id: chat, message_ids: ids.slice(i, i + 100) });
        }
    }

    async pinMessage(params: { chatId: unknown; message: unknown; notify?: boolean }): Promise<void> {
        await this.api("pinChatMessage", {
            chat_id: this.chatId(params.chatId),
            message_id: Number(params.message),
            disable_notification: params.notify !== true,
        });
    }

    async unpinMessage(params: { chatId: unknown; message: unknown }): Promise<void> {
        await this.api("unpinChatMessage", {
            chat_id: this.chatId(params.chatId),
            message_id: Number(params.message),
        });
    }

    /** Bot API 没有 getUser 端点；对用户 ID 调 getChat 返回 private chat，映射成用户形状。 */
    async getUser(chatId: unknown): Promise<unknown> {
        const chat = await this.api<BotApiChat>("getChat", { chat_id: this.chatId(chatId) });
        return {
            id: chat.id,
            firstName: chat.first_name,
            lastName: chat.last_name,
            displayName: [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username,
            username: chat.username,
            isBot: false,
            type: "private",
        };
    }

    private ensurePolling(): void {
        if (!this.running || this.polling || this.handlers.size === 0) return;
        this.polling = this.pollLoop().finally(() => {
            this.polling = null;
            if (this.running && this.handlers.size > 0) this.ensurePolling();
        });
    }

    private async pollLoop(): Promise<void> {
        while (this.running && this.handlers.size > 0) {
            this.abortController = new AbortController();
            try {
                const updates = await this.api<BotApiUpdate[]>("getUpdates", {
                    offset: this.updateOffset || undefined,
                    timeout: this.pollTimeoutSec,
                    allowed_updates: ["message", "channel_post"],
                }, this.abortController.signal);
                for (const handler of this.stateHandlers) handler("connected");
                for (const update of updates) {
                    if (!this.running || this.handlers.size === 0) return;
                    const message = update.message ?? update.channel_post;
                    if (message) {
                        const normalized = this.normalizeMessage(message);
                        for (const handler of this.handlers) {
                            await handler(normalized);
                        }
                    }
                    // Acknowledge only after every handler completed, so a
                    // transient downstream failure is retried instead of lost.
                    this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
                }
            } catch (error) {
                if (!this.running || this.abortController.signal.aborted) return;
                const safeError = this.sanitizeError(error);
                for (const handler of this.errorHandlers) handler(safeError);
                for (const handler of this.stateHandlers) handler("offline");
                // Avoid a hot retry loop when Telegram or the network is transiently unavailable.
                await delay(2_000, undefined, {
                    signal: AbortSignal.any([this.lifetime.signal, this.abortController.signal]),
                }).catch(() => {});
            } finally {
                this.abortController = null;
            }
        }
    }

    private async api<T>(method: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
        const response = await this.request(`${this.baseUrl}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal,
        });
        const body = await this.readEnvelope<T>(response);
        if (!response.ok || !body.ok) {
            throw this.sanitizeError(`Telegram Bot API ${method} failed: ${body.description ?? response.statusText}`);
        }
        return body.result as T;
    }

    private async apiForm<T>(method: string, form: FormData): Promise<T> {
        const response = await this.request(`${this.baseUrl}/${method}`, { method: "POST", body: form });
        const body = await this.readEnvelope<T>(response);
        if (!response.ok || !body.ok) {
            throw this.sanitizeError(`Telegram Bot API ${method} failed: ${body.description ?? response.statusText}`);
        }
        return body.result as T;
    }

    private async readEnvelope<T>(response: Response): Promise<BotApiEnvelope<T>> {
        try {
            return await response.json() as BotApiEnvelope<T>;
        } catch {
            return { ok: false, description: `HTTP ${response.status}` };
        }
    }

    private sanitizeError(error: unknown): Error {
        const message = error instanceof Error ? error.message : String(error);
        const redacted = [this.botToken, encodeURIComponent(this.botToken)]
            .filter(Boolean).reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), message);
        // Do not retain the original error/cause: fetch errors may embed the token-bearing URL.
        return new Error(redacted);
    }

    private async request(url: string, init: RequestInit = {}): Promise<Response> {
        try {
            return await this.fetchImpl(url, {
                ...init,
                signal: AbortSignal.any([
                    this.lifetime.signal,
                    AbortSignal.timeout(60_000),
                    ...(init.signal ? [init.signal] : []),
                ]),
            });
        } catch (error) {
            throw this.sanitizeError(error);
        }
    }

    private chatId(value: unknown): string {
        const raw = String(value ?? "").trim().replace(/^telegram:/, "");
        if (!raw) throw new Error("Telegram Bot API requires a target chat ID");
        return raw;
    }

    private replyOptions(value: unknown): Record<string, unknown> {
        const opts = value && typeof value === "object" ? value as Record<string, unknown> : {};
        const replyTo = Number(opts.replyTo ?? opts.reply_to_message_id);
        return Number.isSafeInteger(replyTo) && replyTo > 0 ? { reply_to_message_id: replyTo } : {};
    }

    private mediaMethod(type: string, media: Record<string, unknown>): { method: string; field: string } {
        const fileName = typeof media.fileName === "string" ? media.fileName : "";
        const mime = typeof media.fileMime === "string" ? media.fileMime : "";
        const normalized = type === "auto"
            ? (mime.startsWith("image/") || /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(fileName) ? "photo" : "document")
            : type;
        switch (normalized) {
            case "photo": return { method: "sendPhoto", field: "photo" };
            case "video": return { method: "sendVideo", field: "video" };
            case "animation": return { method: "sendAnimation", field: "animation" };
            case "audio": return { method: "sendAudio", field: "audio" };
            case "voice": return { method: "sendVoice", field: "voice" };
            case "sticker": return { method: "sendSticker", field: "sticker" };
            default: return { method: "sendDocument", field: "document" };
        }
    }

    private normalizeUser(user: BotApiUser): Record<string, unknown> {
        return {
            id: user.id,
            firstName: user.first_name,
            lastName: user.last_name,
            displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username,
            username: user.username,
            isBot: user.is_bot,
            type: "private",
        };
    }

    private normalizeChat(chat: BotApiChat): Record<string, unknown> {
        return {
            id: chat.id,
            type: chat.type,
            title: (chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ")) || chat.username,
            username: chat.username,
        };
    }

    private normalizeMessage(message: BotApiMessage): Record<string, unknown> {
        return {
            id: message.message_id,
            text: message.text ?? message.caption ?? "",
            date: new Date(message.date * 1_000),
            chat: this.normalizeChat(message.chat),
            sender: message.sender_chat
                ? { ...this.normalizeChat(message.sender_chat), displayName: message.sender_chat.title }
                : message.from ? this.normalizeUser(message.from) : undefined,
            replyToMessage: message.reply_to_message ? { id: message.reply_to_message.message_id } : undefined,
            isMention: this.isMention(message),
            media: this.normalizeMedia(message),
        };
    }

    private isMention(message: BotApiMessage): boolean {
        const username = this.self?.username?.toLowerCase();
        const text = message.text ?? message.caption ?? "";
        const entities = message.text != null ? message.entities : message.caption_entities;
        if (entities?.some(entity =>
            (entity.type === "mention" && username
                && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${username}`)
            || (entity.type === "text_mention" && entity.user?.id === this.self?.id),
        )) return true;
        return this.self != null && message.reply_to_message?.from?.id === this.self.id;
    }

    private normalizeMedia(message: BotApiMessage): Record<string, unknown> | undefined {
        const pick = (files: BotApiFile[] | undefined) => files?.at(-1);
        const source = pick(message.photo) ?? message.document ?? message.video ?? message.animation ?? message.audio ?? message.voice ?? message.sticker;
        if (!source) return undefined;
        const type = message.photo ? "photo"
            : message.document ? "document"
            : message.video ? "video"
            : message.animation ? "animation"
            : message.audio ? "audio"
            : message.voice ? "voice"
            : "sticker";
        return {
            type,
            fileId: source.file_id,
            uniqueFileId: source.file_unique_id,
            fileName: source.file_name,
            mimeType: source.mime_type,
            fileSize: source.file_size,
            width: source.width,
            height: source.height,
            emoji: source.emoji,
        };
    }
}
