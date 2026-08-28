/**
 * wechat.d.ts — 微信渠道 API（Claw/OpenClaw-weixin 协议，iLink bot 扫码登录）
 *
 * 系统注入的微信 host proxy 接口。
 * 与 onebot/qq（NapCat）和 qqbot（官方开放平台）完全独立。
 *
 * 平台限制：
 * - 无历史消息 API（离线/断线期间的消息无法补抓；轮询游标已持久化，运行期间不丢消息）
 * - 已读回执不存在；发送语音暂不支持（iLink CDN 需要 silk 编码）
 * - 回复优先走被动回复（入站消息 context_token），无上下文的发送受平台主动消息配额约束
 */

interface WeChatMediaPayload {
    /** 媒体类型：photo / video / audio / document（发送侧主要影响占位日志） */
    type?: string;
    /** 公网 URL 或本地路径（相对 workspace 或绝对路径） */
    file?: string;
    /** 同 file，二选一 */
    url?: string;
    /** 文件名（URL 上传时可指定扩展名） */
    fileName?: string;
    /** 说明文字，会作为独立文本消息随后发送 */
    caption?: string;
}

interface WeChatSendAck {
    /** 本地生成的发送回执 ID（微信协议不回传服务端消息 ID） */
    id?: string;
    [key: string]: unknown;
}

declare const wechat: {
    /**
     * 发送文本消息。
     * chatId 来自消息上下文（wechat:private:{from_user_id} 或 wechat:group:{group_id}）。
     * @example
     * await wechat.sendText(chatId, "来啦来啦");
     */
    sendText(chatId: string, text: string): Promise<WeChatSendAck | null>;

    /**
     * 发送媒体消息（图片/视频/语音/文件）。支持公网 URL 与本地路径。
     * @example
     * await wechat.sendMedia(chatId, { type: "photo", file: "media-cache/abc.jpg", caption: "看图" });
     */
    sendMedia(chatId: string, media: WeChatMediaPayload): Promise<WeChatSendAck | null>;

    /**
     * 发送本地文件。
     * @example
     * await wechat.sendFile(chatId, "Downloads/report.pdf", { caption: "日报" });
     */
    sendFile(chatId: string, filePath: string, opts?: { caption?: string; fileName?: string }): Promise<WeChatSendAck | null>;

    /** 微信无 typing 指示，no-op。 */
    sendTyping(chatId: string): Promise<null>;

    /** 获取会话基础信息（群名 / 联系人备注名）。 */
    getChat(chatId: string): Promise<Record<string, unknown>>;

    /** 获取 bot 自身信息（登录账号 id 与昵称）。 */
    getMe(): Promise<Record<string, unknown>>;

    /**
     * 取回入站媒体二进制（按 mediaInfo.uniqueFileId，从本地媒体缓存读取）。
     * 返回 { buffer: base64, size }。
     */
    downloadMedia(uniqueFileId: string): Promise<{ buffer: string; size: number }>;
};
