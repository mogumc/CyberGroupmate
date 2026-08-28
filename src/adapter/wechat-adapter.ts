/**
 * wechat-adapter.ts — 微信渠道 adapter（Claw / OpenClaw-weixin 协议，扫码登录）
 *
 * 直接对接 Tencent `@tencent-weixin/openclaw-weixin` 插件所使用的 iLink bot HTTP 协议
 * （协议参考：https://github.com/Tencent/openclaw-weixin 的"后端 API 协议"章节）：
 *
 * - 登录：POST ilink/bot/get_bot_qrcode 获取二维码 → GET ilink/bot/get_qrcode_status 长轮询
 *   （wait/scaned/need_verifycode/expired/scaned_but_redirect/confirmed），confirmed 后拿到
 *   bot_token + baseurl。二维码同步打印到终端并写入连接状态（Dashboard 展示）。
 * - 收消息：POST ilink/bot/getupdates 长轮询（get_updates_buf 游标持久化，重启不重放）
 * - 发消息：POST ilink/bot/sendmessage（message_type=BOT，携带入站消息的 context_token）
 * - 媒体：入站经 CDN（full_url 或 /download?encrypted_query_param=...）下载 + AES-128-ECB 解密；
 *   出站 getuploadurl 取预签名 → AES-ECB 加密 POST 上传 → x-encrypted-param 回填媒体引用
 * - typing：getconfig 拿 typing_ticket → sendtyping
 * - 生命周期：notifystart / notifystop；errcode -14（会话超时）→ 清凭据重新扫码
 *
 * 凭据与游标持久化在 workspace/wechat-session/<session_name>.json，重启免扫码。
 * 独立平台名 "wechat"（与 onebot/qqbot 相互独立）；chatId：wechat:private:{from_user_id} / wechat:group:{group_id}。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NotificationCenter } from "../event/notification-center.js";
import { loadConfig, type WeChatConfig } from "../core/config.js";
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
import * as QRCode from "qrcode";

const log = createLogger("wechat-adapter");

// ─── 协议常量（与 openclaw-weixin 插件对齐） ───

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
/** iLink-App-Id：openclaw-weixin 插件 package.json 的 ilink_appid 字段（通用 bot 应用标识） */
const ILINK_APP_ID = "bot";
/** iLink-App-ClientVersion：0x00MMNNPP = major<<16 | minor<<8 | patch */
const CG_VERSION = "0.1.0";
const ILINK_APP_CLIENT_VERSION = (() => {
    const parts = CG_VERSION.split(".").map((p) => parseInt(p, 10) || 0);
    return ((parts[0]! & 0xff) << 16) | ((parts[1]! & 0xff) << 8) | (parts[2]! & 0xff);
})();
const DEFAULT_BOT_AGENT = `CyberGroupmate/${CG_VERSION}`;
const BOT_TYPE = "3";

const UPLOAD_MAX_RETRIES = 3;
const QR_REFRESH_MAX = 3;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;

// MessageItemType / MessageType / MessageState（openclaw-weixin src/api/types.ts）
const MSG_ITEM = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
const MSG_TYPE = { USER: 1, BOT: 2 } as const;
const MSG_STATE = { FINISH: 2 } as const;
const UPLOAD_MEDIA = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

// ─── 协议类型 ───

interface WeixinMessageItem {
    type?: number;
    text_item?: { text?: string };
    image_item?: { media?: CDNMedia; aeskey?: string };
    voice_item?: { media?: CDNMedia; text?: string; playtime?: number };
    file_item?: { media?: CDNMedia; file_name?: string };
    video_item?: { media?: CDNMedia };
}

interface CDNMedia {
    encrypt_query_param?: string;
    aes_key?: string;
    full_url?: string;
}

interface WeixinMsg {
    seq?: number;
    message_id?: number;
    from_user_id?: string;
    to_user_id?: string;
    client_id?: string;
    create_time_ms?: number;
    session_id?: string;
    group_id?: string;
    message_type?: number;
    item_list?: WeixinMessageItem[];
    context_token?: string;
}

interface GetUpdatesResp {
    ret?: number;
    errcode?: number;
    errmsg?: string;
    msgs?: WeixinMsg[];
    get_updates_buf?: string;
    longpolling_timeout_ms?: number;
}

interface QRCodeResponse {
    qrcode?: string;
    qrcode_img_content?: string;
}

interface QRStatusResponse {
    status?: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
    bot_token?: string;
    ilink_bot_id?: string;
    baseurl?: string;
    ilink_user_id?: string;
    redirect_host?: string;
}

interface PersistedSession {
    token: string;
    baseUrl: string;
    ilinkBotId?: string;
    getUpdatesBuf?: string;
    savedAt: string;
}

interface NormalizedWechatMessage {
    chatId: string;
    peerId: string;
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

interface PromptHandler {
    (prompt: string): Promise<string>;
}

// ─── AES-128-ECB（与 openclaw-weixin src/cdn/aes-ecb.ts 一致） ───

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
    const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
    const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 解析 CDNMedia.aes_key（两种现实编码，与 openclaw-weixin pic-decrypt.parseAesKey 一致）：
 * - base64(16 字节原始 key)：图片
 * - base64(32 个 hex 字符)：文件/语音/视频（需再按 hex 解析）
 */
export function parseAesKey(aesKeyBase64: string, label: string): Buffer {
    const decoded = Buffer.from(aesKeyBase64, "base64");
    if (decoded.length === 16) return decoded;
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
        return Buffer.from(decoded.toString("ascii"), "hex");
    }
    throw new Error(`${label}: aes_key 编码异常（${decoded.length} 字节，期望 16 字节或 32 位 hex）`);
}

export class WeChatAdapter implements PlatformAdapter {
    readonly platform = "wechat";

    private readonly connection = new ConnectionTracker("wechat");
    private stopRequested = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private startInFlight: Promise<void> | null = null;
    private pollAbort: AbortController | null = null;
    private pollLoopRunning = false;
    private loginGeneration = 0;

    /** 会话凭据（持久化） */
    private token: string | null = null;
    private baseUrl: string = DEFAULT_BASE_URL;
    private getUpdatesBuf = "";

    /** chatId → 最近入站消息的 context_token（发送回复用） */
    private contextTokens = new Map<string, { token: string; receivedAt: number }>();
    /** chatId → 回复对端（from_user_id） */
    private peers = new Map<string, string>();
    /** chatId → typing_ticket（getconfig 获取，短期复用） */
    private typingTickets = new Map<string, { ticket: string; fetchedAt: number }>();

    private mutedChats: Map<string, number> = new Map();

    private readonly defaultBaseUrl: string;
    private readonly botAgent: string;
    private readonly sessionPath: string;

    constructor(
        private config: WeChatConfig,
        private nc: NotificationCenter,
        private promptUser: PromptHandler = async () => "",
        private mediaDownloader?: MediaDownloader,
    ) {
        this.defaultBaseUrl = (config.apiBaseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.baseUrl = this.defaultBaseUrl;
        const sanitizedBotAgent = (config.botAgent?.trim() || DEFAULT_BOT_AGENT).slice(0, 256);
        this.botAgent = sanitizedBotAgent;
        const sessionName = (config.sessionName?.trim() || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
        this.sessionPath = path.resolve(process.cwd(), "workspace", "wechat-session", `${sessionName}.json`);
        // 手动配置的 token 优先
        if (config.token?.trim()) this.token = config.token.trim();
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

    async reconnect(): Promise<void> {
        log.info("WeChatAdapter 手动重连");
        this.clearReconnectTimer();
        this.reconnectAttempts = 0;
        this.connection.resetAttempts();
        this.stopRequested = true;
        this.abortPoll();
        // 手动重连保留已登录凭据：直接重拉（仅当需要重新扫码时才会走扫码流程）
        await sleep(300);
        this.stopRequested = false;
        await this.start();
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
        this.loginGeneration++;
        this.clearReconnectTimer();
        this.connection.markStopped();
        this.connection.setQrCodeUrl(undefined);
        this.abortPoll();
        // 尽力通知服务端下线
        if (this.token) {
            await this.apiPost("ilink/bot/msg/notifystop", {}).catch(() => { /* 尽力 */ });
        }
        this.token = null;
    }

    private validateConfig(): void {
        // wechat 配置无必填项（token 缺省走扫码）
    }

    private async doStart(): Promise<void> {
        this.validateConfig();
        this.connection.markConnecting("weixin iLink");

        if (this.token) {
            // 已有凭据：直接进入收消息循环
            this.connection.markConnected(`ilink bot, base=${this.baseUrl}`);
            this.print("✅ WeChatAdapter 已连接（使用持久化凭据）");
            await this.apiPost("ilink/bot/msg/notifystart", {}).catch((err) => {
                log.warn("notifystart 失败（非致命）", { error: String(err).slice(0, 120) });
            });
            void this.runPollLoop();
            return;
        }

        // 无凭据：后台启动扫码登录（不阻塞 start() 返回——扫码可能耗时数分钟）
        this.connection.markConnecting("等待手机扫码登录（二维码见终端 / Dashboard）");
        const generation = ++this.loginGeneration;
        void this.runQrLogin(generation).catch((err) => {
            log.warn("微信扫码登录流程异常", { error: String(err).slice(0, 200) });
        });
    }

    private print(message: string): void {
        console.log(`🤖 ${message}`);
    }

    private scheduleReconnect(reason: string): void {
        if (this.stopRequested || this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts - 1), 60_000);
        this.connection.markRetryScheduled(this.reconnectAttempts, delay);
        log.info(`WeChatAdapter 将在 ${delay}ms 后重试启动 (第 ${this.reconnectAttempts} 次)`, { reason });
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.stopRequested) return;
            try {
                await this.doStart();
            } catch (err) {
                log.warn("WeChatAdapter 重试启动失败", { error: String(err).slice(0, 150) });
            }
        }, delay);
        if (this.reconnectTimer.unref) this.reconnectTimer.unref();
    }

    private clearReconnectTimer(): void {
        if (!this.reconnectTimer) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    // ─── 扫码登录 ───

    private async runQrLogin(generation: number): Promise<void> {
        const isCurrent = () => !this.stopRequested && generation === this.loginGeneration && !this.token;
        let currentBase = this.defaultBaseUrl;

        for (let qrRound = 1; qrRound <= QR_REFRESH_MAX; qrRound++) {
            if (!isCurrent()) return;

            // 1. 取二维码
            const qrResp = await this.apiPostRaw("ilink/bot/get_bot_qrcode?bot_type=" + BOT_TYPE, {
                local_token_list: [],
            }, currentBase) as QRCodeResponse;
            if (!qrResp?.qrcode || !qrResp?.qrcode_img_content) {
                throw new Error("获取登录二维码失败（get_bot_qrcode 未返回 qrcode）");
            }
            log.info("已获取微信登录二维码", { round: qrRound });

            // 2. 终端 + Dashboard 同步展示
            try {
                const dataUrl = await QRCode.toDataURL(qrResp.qrcode_img_content, { margin: 1, width: 240 });
                this.connection.setQrCodeUrl(dataUrl);
                this.nc.push({
                    type: "system.wechat_scan",
                    scene: "wechat",
                    statusText: "等待手机扫码",
                    scanUrl: qrResp.qrcode_img_content,
                    qrCodeUrl: dataUrl,
                    timestamp: new Date().toISOString(),
                } as never);
            } catch (err) {
                log.warn("生成扫码二维码失败", { error: String(err).slice(0, 120) });
            }
            try {
                const terminalQr = await QRCode.toString(qrResp.qrcode_img_content, { type: "terminal", small: true });
                console.log(terminalQr);
            } catch { /* 终端渲染失败不阻断 */ }
            this.print(`📱 请用手机微信扫描二维码完成登录（备用链接: ${qrResp.qrcode_img_content}）`);

            // 3. 长轮询扫码状态
            let verifyCode: string | undefined;
            while (isCurrent()) {
                let statusResp: QRStatusResponse;
                try {
                    const endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrResp.qrcode!)}`
                        + (verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : "");
                    const raw = await this.apiGetRaw(endpoint, currentBase, QR_LONG_POLL_TIMEOUT_MS);
                    statusResp = JSON.parse(raw) as QRStatusResponse;
                    verifyCode = undefined; // 已携带的验证码消费掉
                } catch (err) {
                    // 网关超时/网络抖动视为 wait 继续
                    log.debug("get_qrcode_status 轮询异常，继续等待", { error: String(err).slice(0, 120) });
                    continue;
                }

                const status = statusResp.status ?? "wait";
                if (status === "wait") continue;

                if (status === "scaned") {
                    this.connection.markConnecting("已扫码，请在手机上确认");
                    this.print("📱 已扫码，请在手机上确认登录");
                    continue;
                }

                if (status === "need_verifycode") {
                    this.connection.markConnecting("需要输入手机上显示的配对数字");
                    const code = await this.promptUser("📱 输入手机微信显示的数字以继续登录: ");
                    verifyCode = code.trim();
                    continue;
                }

                if (status === "scaned_but_redirect") {
                    if (statusResp.redirect_host) {
                        currentBase = statusResp.redirect_host.replace(/\/+$/, "");
                        log.info("扫码登录重定向", { redirectHost: currentBase });
                    }
                    continue;
                }

                if (status === "expired") {
                    this.print("⏳ 二维码已过期");
                    break; // 跳出内层循环 → 刷新二维码
                }

                if (status === "confirmed") {
                    if (!statusResp.bot_token) {
                        throw new Error("扫码确认成功但未返回 bot_token");
                    }
                    this.token = statusResp.bot_token;
                    this.baseUrl = (statusResp.baseurl?.trim() || currentBase).replace(/\/+$/, "");
                    this.getUpdatesBuf = "";
                    this.connection.setQrCodeUrl(undefined);
                    this.persistSession(statusResp.ilink_bot_id);
                    this.reconnectAttempts = 0;
                    this.connection.markConnected(`ilink bot, base=${this.baseUrl}`);
                    this.print(`✅ WeChatAdapter 微信登录成功 (bot_id=${statusResp.ilink_bot_id ?? "?"})`);
                    await this.apiPost("ilink/bot/msg/notifystart", {}).catch(() => { /* 尽力 */ });
                    void this.runPollLoop();
                    return;
                }

                if (status === "binded_redirect" || status === "verify_code_blocked") {
                    log.warn("扫码登录异常状态", { status });
                    this.connection.markDisconnected(`登录异常: ${status}`);
                    return;
                }
            }
        }

        if (isCurrent()) {
            this.connection.markDisconnected("二维码多次过期，登录已停止（可通过 Dashboard 重连重新发起）");
            log.warn("微信扫码登录多次过期，放弃本轮登录");
        }
    }

    private persistSession(ilinkBotId?: string): void {
        if (!this.token) return;
        try {
            const session: PersistedSession = {
                token: this.token,
                baseUrl: this.baseUrl,
                ilinkBotId,
                getUpdatesBuf: this.getUpdatesBuf,
                savedAt: new Date().toISOString(),
            };
            fs.mkdirSync(path.dirname(this.sessionPath), { recursive: true });
            fs.writeFileSync(this.sessionPath, JSON.stringify(session, null, 2));
        } catch (err) {
            log.warn("微信会话凭据保存失败", { error: String(err).slice(0, 120) });
        }
    }

    private loadPersistedSession(): void {
        try {
            if (!fs.existsSync(this.sessionPath) || this.token) return;
            const session = JSON.parse(fs.readFileSync(this.sessionPath, "utf-8")) as PersistedSession;
            if (session.token?.trim()) {
                this.token = session.token.trim();
                if (session.baseUrl?.trim()) this.baseUrl = session.baseUrl.trim().replace(/\/+$/, "");
                this.getUpdatesBuf = session.getUpdatesBuf ?? "";
                log.info("已加载持久化的微信登录凭据", { savedAt: session.savedAt });
            }
        } catch (err) {
            log.warn("读取微信会话凭据失败", { error: String(err).slice(0, 120) });
        }
    }

    private clearSession(): void {
        this.token = null;
        this.getUpdatesBuf = "";
        try {
            if (fs.existsSync(this.sessionPath)) fs.unlinkSync(this.sessionPath);
        } catch { /* ignore */ }
    }

    // ─── HTTP 基础 ───

    private buildHeaders(withAuth: boolean): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "iLink-App-Id": ILINK_APP_ID,
            "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
        };
        if (withAuth && this.token) {
            headers["AuthorizationType"] = "ilink_bot_token";
            headers["Authorization"] = `Bearer ${this.token}`;
            // X-WECHAT-UIN：随机 uint32 十进制字符串的 base64（协议要求，服务端不校验值）
            const uint32 = crypto.randomBytes(4).readUInt32BE(0);
            headers["X-WECHAT-UIN"] = Buffer.from(String(uint32), "utf-8").toString("base64");
        }
        return headers;
    }

    private baseInfo(): Record<string, unknown> {
        return { channel_version: CG_VERSION, bot_agent: this.botAgent };
    }

    private async apiPostRaw(endpoint: string, body: Record<string, unknown>, baseUrl?: string, timeoutMs = API_TIMEOUT_MS): Promise<string> {
        const base = (baseUrl ?? this.baseUrl).replace(/\/+$/, "");
        const response = await fetch(`${base}/${endpoint.replace(/^\/+/, "")}`, {
            method: "POST",
            headers: this.buildHeaders(this.token != null),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = await response.text();
        if (!response.ok) {
            throw new Error(`WeChat API ${endpoint} ${response.status}: ${raw.slice(0, 200)}`);
        }
        return raw;
    }

    private async apiPost<T = Record<string, unknown>>(endpoint: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T> {
        const raw = await this.apiPostRaw(endpoint, { ...body, base_info: this.baseInfo() }, undefined, timeoutMs);
        return JSON.parse(raw) as T;
    }

    private async apiGetRaw(endpoint: string, baseUrl: string, timeoutMs: number): Promise<string> {
        const base = baseUrl.replace(/\/+$/, "");
        const response = await fetch(`${base}/${endpoint.replace(/^\/+/, "")}`, {
            method: "GET",
            headers: this.buildHeaders(false),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = await response.text();
        if (!response.ok) {
            throw new Error(`WeChat API GET ${endpoint} ${response.status}: ${raw.slice(0, 200)}`);
        }
        return raw;
    }

    // ─── 收消息长轮询 ───

    private async runPollLoop(): Promise<void> {
        if (this.pollLoopRunning) return;
        this.pollLoopRunning = true;
        try {
            while (!this.stopRequested && this.token) {
                const controller = new AbortController();
                this.pollAbort = controller;
                const abortTimer = setTimeout(() => controller.abort(), DEFAULT_LONG_POLL_TIMEOUT_MS + 15_000);
                try {
                    const resp = await this.apiPost<GetUpdatesResp>("ilink/bot/getupdates", {
                        get_updates_buf: this.getUpdatesBuf,
                    }, DEFAULT_LONG_POLL_TIMEOUT_MS + 10_000);

                    // -14 会话超时：token 失效，清凭据重新扫码
                    if (resp.errcode === -14) {
                        log.warn("微信会话已超时（errcode -14），需要重新扫码登录");
                        this.connection.markDisconnected("会话超时（errcode -14），需要重新扫码");
                        this.clearSession();
                        this.connection.setQrCodeUrl(undefined);
                        const generation = ++this.loginGeneration;
                        void this.runQrLogin(generation).catch(() => { /* 内部已处理 */ });
                        return;
                    }
                    if (resp.ret != null && resp.ret !== 0) {
                        log.warn("getupdates 返回错误", { ret: resp.ret, errmsg: resp.errmsg });
                        await sleep(2000);
                        continue;
                    }
                    this.connection.markConnected();

                    const msgs = resp.msgs ?? [];
                    for (const msg of msgs) {
                        try {
                            await this.processMessage(msg);
                        } catch (err) {
                            log.warn("处理微信消息失败", { messageId: msg.message_id, error: String(err).slice(0, 200) });
                        }
                    }
                    if (typeof resp.get_updates_buf === "string" && resp.get_updates_buf !== this.getUpdatesBuf) {
                        this.getUpdatesBuf = resp.get_updates_buf;
                        this.persistSession();
                    }
                } catch (err) {
                    if (this.stopRequested) break;
                    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) continue;
                    this.reconnectAttempts++;
                    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts - 1), 60_000);
                    this.connection.noteError(String(err).slice(0, 200));
                    log.warn("getupdates 失败，稍后重试", { attempt: this.reconnectAttempts, delayMs: delay, error: String(err).slice(0, 150) });
                    await sleep(delay);
                } finally {
                    clearTimeout(abortTimer);
                    if (this.pollAbort === controller) this.pollAbort = null;
                }
            }
        } finally {
            this.pollLoopRunning = false;
        }
    }

    private abortPoll(): void {
        this.pollAbort?.abort();
        const deadline = Date.now() + 2000;
        // 长轮询 abort 后循环自然退出；这里短暂等待让 stop 语义完整
        while (this.pollLoopRunning && Date.now() < deadline) {
            void sleep(30);
            if (!this.pollLoopRunning) break;
        }
    }

    // ─── 入站消息处理 ───

    private async processMessage(msg: WeixinMsg): Promise<void> {
        // 只处理用户消息（BOT 类型是自己的下发回执/回显）
        if (msg.message_type != null && msg.message_type !== MSG_TYPE.USER) return;
        const fromUserId = String(msg.from_user_id ?? "").trim();
        if (!fromUserId || !msg.message_id) return;

        const isGroup = Boolean(msg.group_id);
        const chatId = isGroup
            ? composeChatId("wechat", "group", String(msg.group_id))
            : composeChatId("wechat", "private", fromUserId);
        const messageId = String(msg.message_id);

        // 登记回复上下文
        this.peers.set(chatId, fromUserId);
        if (msg.context_token) {
            this.contextTokens.set(chatId, { token: msg.context_token, receivedAt: Date.now() });
        }

        if (shouldDropInbound(loadConfig().chatFilter, { chatId, userId: composeChatId("wechat", fromUserId) })) return;
        if (userGate.shouldDrop(composeChatId("wechat", fromUserId))) return;

        // ── item_list 解析：文本聚合 + 媒体下载 ──
        const textParts: string[] = [];
        let mediaInfo: MediaInfo | undefined;
        for (const item of msg.item_list ?? []) {
            switch (item.type) {
                case MSG_ITEM.TEXT: {
                    const text = String(item.text_item?.text ?? "").trim();
                    if (text) textParts.push(text);
                    break;
                }
                case MSG_ITEM.VOICE: {
                    // 语音带服务端转写文本，优先作为消息内容
                    const transcript = String(item.voice_item?.text ?? "").trim();
                    if (transcript) textParts.push(transcript);
                    mediaInfo = mediaInfo ?? await this.downloadWeixinMedia(item, MSG_ITEM.VOICE, chatId, messageId);
                    break;
                }
                case MSG_ITEM.IMAGE:
                    mediaInfo = mediaInfo ?? await this.downloadWeixinMedia(item, MSG_ITEM.IMAGE, chatId, messageId);
                    break;
                case MSG_ITEM.VIDEO:
                    mediaInfo = mediaInfo ?? await this.downloadWeixinMedia(item, MSG_ITEM.VIDEO, chatId, messageId);
                    break;
                case MSG_ITEM.FILE:
                    mediaInfo = mediaInfo ?? await this.downloadWeixinMedia(item, MSG_ITEM.FILE, chatId, messageId);
                    break;
                default:
                    break; // TOOL_CALL_* 等插件内部类型不处理
            }
        }

        let text = textParts.join("\n");
        if (!text && mediaInfo) {
            switch (mediaInfo.type) {
                case "photo": text = "[📷 图片]"; break;
                case "video": text = "[🎬 视频]"; break;
                case "audio": text = "[🎙 语音]"; break;
                case "document": text = "[📎 文件]"; break;
                default: text = "[📎 媒体]"; break;
            }
        }
        if (!text) return;

        const normalized: NormalizedWechatMessage = {
            chatId,
            peerId: fromUserId,
            userId: composeChatId("wechat", fromUserId),
            displayName: `微信用户_${fromUserId.slice(-6)}`,
            text,
            timestamp: msg.create_time_ms ? new Date(msg.create_time_ms).toISOString() : new Date().toISOString(),
            messageId,
            chatType: isGroup ? "group" : "private",
            chatTitle: isGroup ? `微信群_${String(msg.group_id).slice(-6)}` : undefined,
            isDirectMessage: !isGroup,
            mentionsAgent: !isGroup, // iLink bot 会话为 1:1 私聊语义，私聊即直达
            mediaInfo,
        };

        log.debug("接收微信消息", {
            messageId,
            chatId,
            textPreview: normalized.text.slice(0, 60),
            mediaType: mediaInfo?.type,
        });

        this.nc.push({
            type: "nc.message",
            scene: "wechat",
            source: {
                scene: "wechat",
                platform: "wechat",
                chatId,
                userId: normalized.userId,
                messageId,
            },
            chatId,
            userId: normalized.userId,
            displayName: normalized.displayName,
            text: normalized.text,
            timestamp: normalized.timestamp,
            messageId,
            chatTitle: normalized.chatTitle,
            chatType: normalized.chatType,
            isDirectMessage: normalized.isDirectMessage,
            mentionsAgent: normalized.mentionsAgent,
            mediaInfo: normalized.mediaInfo,
            payload: {
                scene: "wechat",
                chatId,
                userId: normalized.userId,
                displayName: normalized.displayName,
                text: normalized.text,
                timestamp: normalized.timestamp,
                messageId,
                chatType: normalized.chatType,
                isDirectMessage: normalized.isDirectMessage,
                mentionsAgent: normalized.mentionsAgent,
                mediaInfo: normalized.mediaInfo,
                platformData: { originalType: "wechat.message" },
            },
            _urgent: normalized.isDirectMessage || normalized.mentionsAgent ? true : false,
        } as never);
    }

    /** 入站媒体下载（full_url 直下；否则 /download?encrypted_query_param=... 回退）+ AES-ECB 解密 */
    private async downloadWeixinMedia(item: WeixinMessageItem, itemType: number, chatId: string, messageId: string): Promise<MediaInfo | undefined> {
        let type: MediaInfo["type"];
        let media: CDNMedia | undefined;
        let fileName: string | undefined;
        let aesKeyB64: string | undefined;
        if (itemType === MSG_ITEM.IMAGE) {
            type = "photo";
            media = item.image_item?.media;
            // image_item.aeskey 是 hex 字符串形式，优先级高于 media.aes_key
            aesKeyB64 = item.image_item?.aeskey
                ? Buffer.from(Buffer.from(item.image_item.aeskey, "hex")).toString("base64")
                : media?.aes_key;
        } else if (itemType === MSG_ITEM.VOICE) {
            type = "audio";
            media = item.voice_item?.media;
            aesKeyB64 = media?.aes_key;
        } else if (itemType === MSG_ITEM.VIDEO) {
            type = "video";
            media = item.video_item?.media;
            aesKeyB64 = media?.aes_key;
        } else if (itemType === MSG_ITEM.FILE) {
            type = "document";
            media = item.file_item?.media;
            fileName = item.file_item?.file_name;
            aesKeyB64 = media?.aes_key;
        } else {
            return undefined;
        }
        if (!media) return undefined;

        const uniqueFileId = crypto.createHash("sha1")
            .update(media.encrypt_query_param ?? media.full_url ?? messageId)
            .digest("hex").slice(0, 24);
        const mediaInfo: MediaInfo = {
            type,
            rawType: `item_${itemType}`,
            fileId: media.full_url ?? media.encrypt_query_param,
            uniqueFileId,
            fileName,
        };
        if (!this.mediaDownloader) return mediaInfo;

        const existing = this.mediaDownloader.getExistingPath(uniqueFileId);
        if (existing) {
            mediaInfo.filePath = existing;
            mediaInfo.downloadStatus = "cached";
            return mediaInfo;
        }

        try {
            let buffer: Buffer;
            if (media.full_url) {
                buffer = await this.fetchCdnBytes(media.full_url, `wechat ${type}`);
                if (aesKeyB64) {
                    buffer = decryptAesEcb(buffer, parseAesKey(aesKeyB64, `wechat ${type}`));
                }
            } else if (media.encrypt_query_param && aesKeyB64) {
                const url = `${this.baseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
                buffer = decryptAesEcb(await this.fetchCdnBytes(url, `wechat ${type}`), parseAesKey(aesKeyB64, `wechat ${type}`));
            } else {
                mediaInfo.downloadStatus = "failed";
                mediaInfo.downloadError = "缺少 full_url / aes_key，无法下载";
                return mediaInfo;
            }
            const saved = this.mediaDownloader.saveMedia(buffer, {
                chatId,
                messageId,
                uniqueFileId,
                mediaType: type,
                fileName,
            });
            mediaInfo.fileSize = buffer.length;
            if (saved) {
                mediaInfo.filePath = saved.path;
                mediaInfo.downloadStatus = "downloaded";
            } else {
                mediaInfo.downloadStatus = "too_large";
            }
        } catch (err) {
            mediaInfo.downloadStatus = "failed";
            mediaInfo.downloadError = String(err).slice(0, 300);
            log.warn("微信媒体下载失败", { chatId, messageId, type, error: String(err).slice(0, 150) });
        }
        return mediaInfo;
    }

    private async fetchCdnBytes(url: string, label: string): Promise<Buffer> {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`${label}: CDN 下载 ${res.status} ${res.statusText}`);
        }
        return Buffer.from(await res.arrayBuffer());
    }

    // ─── 发送 ───

    private buildTextReq(peerId: string, text: string, contextToken?: string): Record<string, unknown> {
        return {
            msg: {
                from_user_id: "",
                to_user_id: peerId,
                client_id: `cg-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
                message_type: MSG_TYPE.BOT,
                message_state: MSG_STATE.FINISH,
                item_list: [{ type: MSG_ITEM.TEXT, text_item: { text } }],
                ...(contextToken ? { context_token: contextToken } : {}),
            },
        };
    }

    private async sendMessageReq(body: Record<string, unknown>): Promise<void> {
        const resp = await this.apiPost<{ ret?: number; errmsg?: string }>("ilink/bot/sendmessage", body);
        if (resp.ret != null && resp.ret !== 0) {
            throw new Error(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
        }
    }

    private async sendTextTo(chatId: string, text: string): Promise<{ id: string; text: string }> {
        const peerId = this.peers.get(chatId) ?? this.peerFromChatId(chatId);
        const context = this.contextTokens.get(chatId)?.token;
        const body = this.buildTextReq(peerId, text, context);
        try {
            await this.sendMessageReq(body);
        } catch (err) {
            if (context) {
                // context_token 可能已过期：去掉上下文重试一次（可能被平台按主动消息限额处理）
                log.warn("sendmessage 携带 context_token 失败，重试无上下文发送", { chatId, error: String(err).slice(0, 150) });
                await this.sendMessageReq(this.buildTextReq(peerId, text));
            } else {
                throw err;
            }
        }
        return { id: `wechat_${Date.now().toString(36)}`, text };
    }

    private peerFromChatId(chatId: string): string {
        const raw = chatId.startsWith("wechat:") ? chatId.slice("wechat:".length) : chatId;
        if (raw.startsWith("private:")) return raw.slice("private:".length);
        if (raw.startsWith("group:")) return raw.slice("group:".length);
        return raw;
    }

    // ─── host-call 接口面 ───

    canHandle(method: string): boolean {
        return method.startsWith("wechat.");
    }

    getWriteMethods(): string[] {
        return [
            "wechat.sendText",
            "wechat.sendMedia",
            "wechat.sendFile",
            "wechat.sendTyping",
        ];
    }

    formatMention(_rawUserId: string, username?: string): string | undefined {
        return username ? `@${username}` : undefined;
    }

    getSceneTypeDefs(scene: string, baseTypeDefs: string): string | undefined {
        if (scene !== "wechat") return undefined;
        const modeNote = "// 当前 adapter 驱动: wechat (Claw/OpenClaw-weixin 协议，iLink bot 扫码登录)\n"
            + "// 平台限制: 无历史消息 API；回复优先使用入站消息的 context_token（被动回复）；\n"
            + "// 发送媒体走 iLink CDN 加密上传（图片/视频/文件）；语音发送暂不支持。\n";
        return `${modeNote}\n${baseTypeDefs}`.trim();
    }

    async handleCall(method: string, args: unknown[]): Promise<unknown> {
        if (!this.token) {
            throw new Error("WeChatAdapter 未登录（等待扫码或未配置 token）");
        }
        const chatId = String(args[0] ?? "");

        // ─── /mute 写操作拦截 ───
        const MUTE_BLOCKED_METHODS = ["wechat.sendText", "wechat.sendMedia", "wechat.sendFile", "wechat.sendTyping"];
        if (MUTE_BLOCKED_METHODS.includes(method)) {
            const compositeChatId = ensureCompositeId("wechat", chatId);
            if (this.isChatMuted(compositeChatId)) {
                const remaining = this.getMuteRemainingHours(compositeChatId);
                log.info("mute 拦截写操作", { method, chatId: compositeChatId, remaining });
                throw new Error(`[禁言中] 你在该聊天已被 /mute，剩余 ${remaining}。所有发送操作已被抑制。`);
            }
        }

        switch (method) {
            case "wechat.getMe":
                return {
                    id: "wechat-bot",
                    platform: "wechat-ilink",
                    baseUrl: this.baseUrl,
                    botAgent: this.botAgent,
                };

            case "wechat.sendText": {
                const text = String(args[1] ?? "");
                if (!text.trim()) throw new Error("wechat.sendText: text 不能为空");
                return this.sendTextTo(chatId, text);
            }

            case "wechat.sendMedia": {
                const media = (args[1] && typeof args[1] === "object" ? args[1] : {}) as Record<string, unknown>;
                const result = await this.sendMediaTo(chatId, media);
                const caption = typeof media.caption === "string" && media.caption.trim() ? media.caption : "";
                if (caption) {
                    try {
                        await this.sendTextTo(chatId, caption);
                    } catch (err) {
                        log.warn("wechat.sendMedia caption 发送失败（媒体已发出）", { error: String(err).slice(0, 150) });
                    }
                }
                return result;
            }

            case "wechat.sendFile": {
                const filePath = String(args[1] ?? "");
                if (!filePath.trim()) throw new Error("wechat.sendFile: filePath 不能为空");
                const fsMod = await import("node:fs");
                const pathMod = await import("node:path");
                const localPath = filePath.trim().replace(/^file:\/\//i, "");
                const candidates = [
                    pathMod.isAbsolute(localPath) ? localPath : pathMod.resolve(process.cwd(), "workspace", localPath),
                    pathMod.isAbsolute(localPath) ? localPath : pathMod.resolve(process.cwd(), localPath),
                ];
                const existing = [...new Set(candidates)].find((c) => fsMod.existsSync(c));
                if (!existing) throw new Error(`wechat.sendFile: 本地文件不存在: ${filePath}`);
                const buffer = fsMod.readFileSync(existing);
                const fileOpts = (args[2] ?? {}) as Record<string, unknown>;
                const result = await this.sendMediaTo(chatId, {
                    type: "document",
                    file: buffer,
                    fileName: typeof fileOpts.fileName === "string" && fileOpts.fileName
                        ? fileOpts.fileName
                        : pathMod.basename(existing),
                });
                const caption = typeof fileOpts.caption === "string" && fileOpts.caption ? fileOpts.caption : "";
                if (caption) {
                    try {
                        await this.sendTextTo(chatId, caption);
                    } catch { /* 尽力 */ }
                }
                return result;
            }

            case "wechat.sendTyping": {
                const peerId = this.peers.get(chatId) ?? this.peerFromChatId(chatId);
                await this.sendTypingTo(peerId);
                return null;
            }

            case "wechat.readHistory":
                // 无已读回执
                return null;

            case "wechat.getChat": {
                const raw = chatId.startsWith("wechat:") ? chatId.slice("wechat:".length) : chatId;
                return {
                    id: chatId,
                    type: raw.startsWith("group:") ? "group" : "private",
                    // iLink 协议不提供群名/昵称查询
                };
            }

            case "wechat.downloadMedia": {
                // 入站媒体已落盘：按 uniqueFileId 从媒体缓存读取
                const fileRef = args[0];
                const uniqueFileId = typeof fileRef === "string"
                    ? fileRef
                    : fileRef && typeof fileRef === "object" && typeof (fileRef as { uniqueFileId?: unknown }).uniqueFileId === "string"
                        ? (fileRef as { uniqueFileId: string }).uniqueFileId
                        : "";
                if (!uniqueFileId) throw new Error("wechat.downloadMedia: 需要 mediaInfo.uniqueFileId");
                const cachedPath = this.mediaDownloader?.getExistingPath(uniqueFileId);
                if (!cachedPath) throw new Error(`wechat.downloadMedia: 未找到媒体缓存 uniqueFileId=${uniqueFileId}`);
                const fsMod = await import("node:fs");
                const buffer = fsMod.readFileSync(cachedPath);
                return { buffer: buffer.toString("base64"), size: buffer.length };
            }

            case "wechat.getHistory":
            case "wechat.getDialogs":
            case "wechat.findDialogs":
            case "wechat.getMessages":
            case "wechat.searchMessages":
            case "wechat.getChatMembers":
                throw new Error(
                    `${method}: 微信（iLink bot）平台无历史消息/会话遍历/成员列表 API。请基于当前消息上下文直接使用 wechat.sendText(chatId, text) 回复`,
                );

            default:
                throw new Error(`Unsupported WeChatAdapter call: ${method}`);
        }
    }

    // ─── typing ───

    private async sendTypingTo(peerId: string, cancel = false): Promise<void> {
        let ticket = this.typingTickets.get(peerId)?.ticket;
        if (!ticket || Date.now() - (this.typingTickets.get(peerId)?.fetchedAt ?? 0) > 10 * 60_000) {
            const resp = await this.apiPost<{ ret?: number; typing_ticket?: string }>("ilink/bot/getconfig", {
                ilink_user_id: peerId,
            }, CONFIG_TIMEOUT_MS);
            ticket = resp.typing_ticket;
            if (!ticket) return;
            this.typingTickets.set(peerId, { ticket, fetchedAt: Date.now() });
        }
        await this.apiPost("ilink/bot/sendtyping", {
            ilink_user_id: peerId,
            typing_ticket: ticket,
            status: cancel ? 2 : 1,
        }, CONFIG_TIMEOUT_MS);
    }

    // ─── 出站媒体（CDN AES-ECB 上传） ───

    private async sendMediaTo(chatId: string, media: Record<string, unknown>): Promise<{ id: string; text: string }> {
        const peerId = this.peers.get(chatId) ?? this.peerFromChatId(chatId);
        const context = this.contextTokens.get(chatId)?.token;

        // ── 解析来源 ──
        let buffer: Buffer;
        let fileName = typeof media.fileName === "string" && media.fileName ? media.fileName : undefined;
        const source = media.url ?? media.file;
        if (typeof source === "string" && /^https?:\/\//i.test(source.trim())) {
            buffer = await this.fetchCdnBytes(source.trim(), "wechat sendMedia");
            fileName = fileName ?? (path.basename(new URL(source.trim()).pathname) || "media");
        } else if (Buffer.isBuffer(source)) {
            buffer = source;
        } else if (typeof source === "string" && source.trim()) {
            const fsMod = await import("node:fs");
            const localPath = source.trim().replace(/^file:\/\//i, "");
            const candidates = [
                path.isAbsolute(localPath) ? localPath : path.resolve(process.cwd(), "workspace", localPath),
                path.isAbsolute(localPath) ? localPath : path.resolve(process.cwd(), localPath),
            ];
            const existing = [...new Set(candidates)].find((c) => fsMod.existsSync(c));
            if (!existing) throw new Error(`wechat.sendMedia: 本地文件不存在: ${source}`);
            buffer = fsMod.readFileSync(existing);
            fileName = fileName ?? path.basename(existing);
        } else {
            throw new Error("wechat.sendMedia: 无法识别的媒体来源（支持 http(s) URL / 本地路径 / Buffer）");
        }

        // ── 类型映射 ──
        const rawType = String(media.type ?? "").toLowerCase();
        let uploadMediaType: number;
        let itemType: number;
        if (rawType === "photo" || rawType === "image" || rawType.startsWith("image/")) {
            uploadMediaType = UPLOAD_MEDIA.IMAGE;
            itemType = MSG_ITEM.IMAGE;
        } else if (rawType === "video" || rawType.startsWith("video/")) {
            uploadMediaType = UPLOAD_MEDIA.VIDEO;
            itemType = MSG_ITEM.VIDEO;
        } else if (rawType === "audio" || rawType === "voice" || rawType.startsWith("audio/")) {
            throw new Error("wechat.sendMedia: 语音发送需要 silk 编码，暂不支持；请改用 wechat.sendText");
        } else {
            uploadMediaType = UPLOAD_MEDIA.FILE;
            itemType = MSG_ITEM.FILE;
        }
        fileName = fileName ?? (uploadMediaType === UPLOAD_MEDIA.IMAGE ? "image.jpg"
            : uploadMediaType === UPLOAD_MEDIA.VIDEO ? "video.mp4" : "file.bin");

        // ── getuploadurl（预签名） ──
        const aesKey = crypto.randomBytes(16);
        const ciphertextSize = Math.ceil((buffer.length + 1) / 16) * 16;
        const filekey = `cg_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
        const isThumbRequired = uploadMediaType === UPLOAD_MEDIA.IMAGE || uploadMediaType === UPLOAD_MEDIA.VIDEO;
        const thumb = isThumbRequired && uploadMediaType === UPLOAD_MEDIA.IMAGE
            ? await this.buildImageThumb(buffer)
            : null;
        const uploadResp = await this.apiPost<{
            ret?: number;
            upload_param?: string;
            thumb_upload_param?: string;
            upload_full_url?: string;
        }>("ilink/bot/getuploadurl", {
            filekey,
            media_type: uploadMediaType,
            to_user_id: peerId,
            rawsize: buffer.length,
            rawfilemd5: crypto.createHash("md5").update(buffer).digest("hex"),
            filesize: ciphertextSize,
            aeskey: aesKey.toString("base64"),
            ...(isThumbRequired && thumb
                ? {
                    thumb_rawsize: thumb.raw.length,
                    thumb_rawfilemd5: crypto.createHash("md5").update(thumb.raw).digest("hex"),
                    thumb_filesize: Math.ceil((thumb.raw.length + 1) / 16) * 16,
                }
                : { no_need_thumb: true }),
        });

        // ── CDN 上传（AES-ECB 加密后 POST octet-stream） ──
        const downloadParam = await this.uploadToCdn(buffer, {
            uploadFullUrl: uploadResp.upload_full_url,
            uploadParam: uploadResp.upload_param,
            filekey,
            aesKey,
        }, "wechat sendMedia");

        // ── 发送媒体消息 ──
        const mediaRef: CDNMedia = {
            encrypt_query_param: downloadParam,
            aes_key: aesKey.toString("base64"),
        };
        const item: WeixinMessageItem = itemType === MSG_ITEM.IMAGE
            ? { type: itemType, image_item: { media: mediaRef } }
            : itemType === MSG_ITEM.VIDEO
                ? { type: itemType, video_item: { media: mediaRef } }
                : { type: itemType, file_item: { media: mediaRef, file_name: fileName } };
        const body: Record<string, unknown> = {
            msg: {
                from_user_id: "",
                to_user_id: peerId,
                client_id: `cg-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
                message_type: MSG_TYPE.BOT,
                message_state: MSG_STATE.FINISH,
                item_list: [item],
                ...(context ? { context_token: context } : {}),
            },
        };
        await this.sendMessageReq(body);
        return { id: `wechat_${Date.now().toString(36)}`, text: `[media:${rawType || "file"}]` };
    }

    /** 图片缩略图（JPEG，最长边 240px）——使用 @napi-rs/canvas；失败返回 null（走 no_need_thumb） */
    private async buildImageThumb(source: Buffer): Promise<{ raw: Buffer } | null> {
        try {
            const { createCanvas, loadImage } = await import("@napi-rs/canvas");
            const img = await loadImage(source);
            const scale = Math.min(1, 240 / Math.max(img.width, img.height));
            const canvas = createCanvas(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return { raw: canvas.toBuffer("image/jpeg") };
        } catch (err) {
            log.warn("生成图片缩略图失败，改用 no_need_thumb", { error: String(err).slice(0, 120) });
            return null;
        }
    }

    private async uploadToCdn(
        buf: Buffer,
        params: { uploadFullUrl?: string; uploadParam?: string; filekey: string; aesKey: Buffer },
        label: string,
    ): Promise<string> {
        const ciphertext = encryptAesEcb(buf, params.aesKey);
        const cdnUrl = params.uploadFullUrl?.trim()
            || (params.uploadParam
                ? `${this.baseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`
                : "");
        if (!cdnUrl) {
            throw new Error(`${label}: CDN 上传地址缺失（need upload_full_url or upload_param）`);
        }

        let downloadParam: string | undefined;
        let lastError: unknown = null;
        for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
            try {
                const res = await fetch(cdnUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/octet-stream" },
                    body: new Uint8Array(ciphertext),
                });
                if (res.status >= 400 && res.status < 500) {
                    const errMsg = res.headers.get("x-error-message") ?? (await res.text()).slice(0, 200);
                    throw new Error(`CDN 上传客户端错误 ${res.status}: ${errMsg}`);
                }
                if (res.status !== 200) {
                    const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
                    throw new Error(`CDN 上传服务端错误: ${errMsg}`);
                }
                downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
                if (!downloadParam) {
                    throw new Error("CDN 上传响应缺少 x-encrypted-param 头");
                }
                break;
            } catch (err) {
                lastError = err;
                if (err instanceof Error && err.message.includes("客户端错误")) throw err;
                if (attempt < UPLOAD_MAX_RETRIES) {
                    log.warn(`${label}: CDN 上传第 ${attempt} 次失败，重试`, { error: String(err).slice(0, 150) });
                    await sleep(500 * attempt);
                }
            }
        }
        if (!downloadParam) {
            throw lastError instanceof Error ? lastError : new Error(`${label}: CDN 上传失败`);
        }
        return downloadParam;
    }

    // ─── /mute 状态（dashboard 用） ───

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
        // 微信无已读回执
    }

    async fetchMissedMessages(_options: BackfillOptions): Promise<BackfillResult> {
        return {
            chats: 0,
            messages: 0,
            notes: ["微信（iLink bot）无历史读取能力，离线期间的消息无法补抓（平台限制）；轮询游标已持久化，运行期间不丢消息"],
        };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
