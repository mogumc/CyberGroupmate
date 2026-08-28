/**
 * modules/wechat/index.ts — 微信渠道客户端代理模块（Claw/OpenClaw-weixin 协议）
 *
 * 面向 iLink bot 协议驱动（wechat-adapter，扫码登录）的 sandbox 侧 proxy：
 * - 重复消息拦截 / 违禁词拦截（与 onebot / qqbot 模块行为一致）
 * - agent_message_sent 事件发射（main.ts 落盘依赖 event.scene="wechat"）
 * - 所有 wechat.* 方法的 callHost 转发
 */

import type { CapabilityRegistryEnv } from "../../capability-registry.js";
import { DEFAULT_BANNED_WORDS, findBannedWords, buildBannedWordWarning } from "../../../core/banned-words.js";

export function createWeChatClientProxy(
    env: CapabilityRegistryEnv,
    sentHistory: Map<string, Set<string>>,
    deduplicateSentMessages = true,
    bannedWords: string[] = DEFAULT_BANNED_WORDS,
) {
    function isDuplicate(chatId: string, text: string): boolean {
        const existing = sentHistory.get(String(chatId));
        return existing?.has(text) ?? false;
    }

    function recordSentIfDedupEnabled(chatId: string, text: string): void {
        if (!deduplicateSentMessages) return;
        const key = String(chatId);
        const existing = sentHistory.get(key);
        if (!existing) {
            sentHistory.set(key, new Set([text]));
        } else {
            existing.add(text);
        }
    }

    function shouldBlockDuplicate(chatId: string, text: string): boolean {
        return deduplicateSentMessages && isDuplicate(chatId, text);
    }

    const methods = {
        /**
         * 发送文本消息。
         * 注意：微信群里用文本 @名字 一般不会触发对方的提醒（需要真实联系人对象），仅作展示。
         * @example
         * await wechat.sendText("wechat:group:R123@chatroom", "来啦来啦");
         */
        sendText: async (chatId: string, text: string): Promise<unknown> => {
            const target = String(chatId ?? "");
            const content = String(text ?? "");
            if (!target || !content.trim()) {
                throw new Error("wechat.sendText: chatId 与 text 均不能为空");
            }

            if (content && bannedWords.length > 0) {
                const found = findBannedWords(content, bannedWords);
                if (found.length > 0) {
                    const warning = buildBannedWordWarning(found, content);
                    env.emitOutput(warning);
                    env.notifyHost({
                        type: "system.banned_word_blocked",
                        scene: "wechat",
                        chatId: target,
                        text: content,
                        foundWords: found,
                        timestamp: Date.now(),
                    });
                    return null;
                }
            }

            if (content && shouldBlockDuplicate(target, content)) {
                const preview = content.length > 80 ? content.slice(0, 80) + "..." : content;
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${target} 的消息 "${preview}" 与本次 session 中已发送的消息内容完全一致，已自动拦截。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "wechat",
                    chatId: target,
                    text: content,
                    timestamp: Date.now(),
                });
                return null;
            }

            const result = await env.callHost("wechat.sendText", [target, content]);
            recordSentIfDedupEnabled(target, content);
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "wechat",
                chatId: target,
                messageId: result && typeof result === "object" && "id" in result
                    ? (result as { id?: unknown }).id
                    : undefined,
                text: content,
                timestamp: Date.now(),
            });
            env.emitOutput(`[微信] sendText ok chat=${target}`);
            return result;
        },

        /**
         * 发送媒体消息（图片/视频/语音/文件）。支持公网 URL 与本地路径（本地上传是微信的相对优势）。
         * caption 会作为独立文本消息随后发送。
         * @example
         * await wechat.sendMedia("wechat:group:R123@chatroom", { type: "photo", file: "Downloads/a.jpg", caption: "看图" });
         */
        sendMedia: async (chatId: string, media: Record<string, unknown>): Promise<unknown> => {
            const target = String(chatId ?? "");
            if (!target) throw new Error("wechat.sendMedia: chatId 不能为空");
            if (!media || typeof media !== "object") throw new Error("wechat.sendMedia: media 必须是对象");
            return env.callHost("wechat.sendMedia", [target, media]);
        },

        /**
         * 发送本地文件。
         * @example
         * await wechat.sendFile("wechat:private:wxid_xxx", "Downloads/report.pdf", { caption: "日报" });
         */
        sendFile: async (chatId: string, filePath: string, opts?: Record<string, unknown>): Promise<unknown> => {
            const target = String(chatId ?? "");
            if (!target) throw new Error("wechat.sendFile: chatId 不能为空");
            return env.callHost("wechat.sendFile", [target, String(filePath ?? ""), opts ?? {}]);
        },

        /** 微信无 typing 指示，no-op。 */
        sendTyping: async (chatId: string): Promise<null> => env.callHost("wechat.sendTyping", [String(chatId ?? "")]) as Promise<null>,

        /** 获取会话基础信息（群名 / 联系人备注名）。 */
        getChat: async (chatId: string): Promise<unknown> => env.callHost("wechat.getChat", [String(chatId ?? "")]),

        /** 获取 bot 自身信息（登录账号 id 与昵称）。 */
        getMe: async (): Promise<unknown> => env.callHost("wechat.getMe", []),

        /**
         * 取回入站媒体的二进制（按 mediaInfo.uniqueFileId，从本地媒体缓存读取）。
         * @example
         * const { buffer, size } = await wechat.downloadMedia(mediaInfo.uniqueFileId);
         */
        downloadMedia: async (uniqueFileId: string): Promise<{ buffer: string; size: number }> => {
            return env.callHost("wechat.downloadMedia", [String(uniqueFileId ?? "")]) as Promise<{ buffer: string; size: number }>;
        },
    };

    return methods;
}
