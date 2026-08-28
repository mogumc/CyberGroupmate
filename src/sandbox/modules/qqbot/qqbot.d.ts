/**
 * qqbot.d.ts — QQ 官方机器人平台 API（q.qq.com 开放平台）
 *
 * 系统注入的 QQ 官方平台 host proxy 接口。
 * 与 OneBot/NapCat（onebot/qq 模块）完全独立：本模块走官方 WebSocket 网关 + REST v2。
 *
 * 平台硬限制：
 * - 群聊只能收到 @ bot 的消息（平台只投递 @ 消息）
 * - 发送为被动回复：收到消息 5 分钟内有效，每条 msg_id 最多 5 次；主动消息需平台配额
 * - 无历史消息 / 成员列表 / 昵称 API（openid 是唯一定位符）
 * - 发送媒体仅支持公网可访问 https URL（图片/视频/音频三类）
 */

interface QQBotMediaPayload {
    /** 媒体类型：photo（图片，file_type=1）、video（视频，file_type=2）、audio/voice（音频，file_type=3） */
    type?: string;
    /** 公网可访问的 https URL（平台服务器自行拉取；不支持本地路径 / Buffer / data: URL） */
    file?: string;
    /** 同 file，二选一 */
    url?: string;
    /** 媒体说明文字。官方媒体消息不支持内嵌 caption，会作为独立文本消息随后发送 */
    caption?: string;
}

interface QQBotSendAck {
    /** 官方返回的消息 ID */
    id?: string;
    /** 是否为被动回复（携带 msg_id 发出） */
    isPassive?: boolean;
    [key: string]: unknown;
}

declare const qqbot: {
    /**
     * 发送文本消息（被动回复优先）。
     * chatId 来自消息上下文（qqbot:group:{group_openid} 或 qqbot:private:{user_openid}）。
     * 注意：群聊里用户只能通过 @ bot 触发你，回复内容无需再 @。
     * @example
     * await qqbot.sendText(chatId, "来啦来啦");
     */
    sendText(chatId: string, text: string): Promise<QQBotSendAck | null>;

    /**
     * 发送媒体消息（图片/视频/音频）。
     * 官方平台仅接受公网可访问的 https URL；本地文件请先上传图床。
     * @example
     * await qqbot.sendMedia(chatId, { type: "photo", file: "https://example.com/cat.jpg", caption: "看图" });
     */
    sendMedia(chatId: string, media: QQBotMediaPayload): Promise<QQBotSendAck | null>;

    /** 官方平台无 typing 指示，no-op。 */
    sendTyping(chatId: string): Promise<null>;

    /**
     * 获取会话基础信息。openid 无群详情 API，仅返回类型（group/private）与本地已知信息。
     */
    getChat(chatId: string): Promise<Record<string, unknown>>;

    /** 获取 bot 自身信息（app_id 等）。 */
    getMe(): Promise<Record<string, unknown>>;

    /**
     * 下载入站媒体（消息 mediaInfo.fileId 指向的 attachments URL）。
     * 返回 { buffer: base64, size }。
     * @example
     * const { buffer, size } = await qqbot.downloadMedia(mediaInfo.fileId);
     */
    downloadMedia(fileId: string): Promise<{ buffer: string; size: number }>;
};
