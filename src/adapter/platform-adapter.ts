/**
 * platform-adapter.ts — 平台接入抽象
 *
 * 定义平台 adapter 的统一接口。
 * 平台连接、消息监听、消息标准化、以及面向 sandbox 的 host-call
 * 都应通过官方 adapter 暴露，而不是由 bootstrap 代码自行创建监听器。
 */

/**
 * 平台连接状态。
 *
 * - connected: 已连接且可用
 * - connecting: 正在建连 / 正在重连
 * - disconnected: 已断开，等待自动重连
 * - stopped: 主动停止（stop() 之后），不会自动重连
 * - error: 连接失败且未安排重连
 */
export type AdapterConnectionState = "connected" | "connecting" | "disconnected" | "stopped" | "error";

export interface AdapterConnectionStatus {
    platform: string;
    state: AdapterConnectionState;
    /** 人类可读的补充信息（登录身份、ws 地址等） */
    detail?: string;
    /** 当前状态的起始时间 */
    since: string;
    /** 已连续重连尝试次数（成功后归零） */
    reconnectAttempts: number;
    /** 下一次自动重连的时间；无计划时为 null */
    nextRetryAt: string | null;
    /** 最近一次成功连接的时间 */
    lastConnectedAt: string | null;
    /** 最近一次错误信息 */
    lastError?: string;
    /** 待扫码登录的二维码（Data URL）。微信等扫码登录平台在等待扫码时提供；登录成功后清除。 */
    qrCodeUrl?: string;
    /** adapter 是否支持手动重连（由 dashboard 层填充） */
    supportsReconnect?: boolean;
}

/** 某个会话已知的最新消息（补抓水位线） */
export interface BackfillWatermark {
    /** 平台原生 message id */
    messageId: string;
    /** 该消息的原始时间（ISO 8601） */
    timestamp: string;
}

export interface BackfillOptions {
    /** 每个会话最多补抓多少条 */
    maxMessagesPerChat: number;
    /** 最多补抓多少个会话 */
    maxChats: number;
    /** 只补抓该时间点之后的消息 */
    since: Date;
    /** 查询某会话的水位线；null 表示本地没有任何历史 */
    getWatermark(chatId: string): BackfillWatermark | null;
    /** 本平台本地已知的会话列表（composite chatId），用于决定补抓范围 */
    knownChatIds: string[];
    /**
     * 投递一条补抓到的消息。
     * 由 coordinator 负责过滤（chatFilter / userGate）、落盘与唤醒统计，
     * adapter 只需要把消息标准化成与实时入站一致的形状。
     */
    deliver(event: Record<string, unknown>): void;
}

export interface BackfillResult {
    /** 实际补抓到消息的会话数 */
    chats: number;
    /** 投递的消息条数 */
    messages: number;
    /** 未能补抓的原因（如 bot 模式无历史权限），用于日志 */
    notes?: string[];
}

export interface PlatformAdapter {
    readonly platform: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    /** 当前连接状态（用于 dashboard 展示） */
    getConnectionStatus?(): AdapterConnectionStatus;
    /** 手动重连：丢弃当前连接并立即重建，重置退避计数 */
    reconnect?(): Promise<void>;
    /**
     * 补抓离线期间漏掉的消息。
     *
     * 平台能力差异很大（见 docs）：telegram userbot 可精确补齐，
     * telegram bot 无历史权限，discord 可按 snowflake 精确分页，
     * onebot 只能拉最近 N 条近似补齐。
     */
    fetchMissedMessages?(options: BackfillOptions): Promise<BackfillResult>;
    canHandle(method: string): boolean;
    handleCall(method: string, args: unknown[]): Promise<unknown>;
    getSceneTypeDefs?(scene: string, baseTypeDefs: string): string | undefined;
    /** 返回该平台的写操作方法名列表，用于 sandbox 安全限制 */
    getWriteMethods(): string[];
    /** 通过 adapter 下载媒体文件（各平台下载逻辑不同） */
    downloadMedia?(rawMessage: unknown, mediaRef: string): Promise<Buffer>;
    /** 构造平台特定的 @ 提及格式（如 Telegram "@username", Discord "<@id>"） */
    formatMention(rawUserId: string, username?: string): string | undefined;
    /** 禁言指定聊天（Dashboard 用） */
    muteChat?(chatId: string, hours: number): void;
    /** 解除禁言（Dashboard 用） */
    unmuteChat?(chatId: string): void;
    /** 获取所有被禁言的聊天列表 */
    getMutedChats?(): Array<{ chatId: string; expiry: number; remaining: string }>;
    /** 检查指定聊天是否被禁言 */
    isChatMuted?(chatId: string): boolean;
    /** 将指定聊天标记为已读（不支持的平台应静默忽略） */
    markAsRead?(chatId: string): Promise<void>;
}
