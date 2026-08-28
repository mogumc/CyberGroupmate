/**
 * modules/qqbot/index.ts — QQ 官方机器人客户端代理模块
 *
 * 面向 q.qq.com 开放平台驱动（qqbot-official-adapter）的 sandbox 侧 proxy：
 * - 重复消息拦截（per-session 去重，与 onebot/telegram 模块行为一致）
 * - 违禁词拦截
 * - agent_message_sent 事件发射（main.ts 落盘依赖 event.scene="qqbot"）
 * - 所有 qqbot.* 方法的 callHost 转发
 *
 * 平台约束（详见 adapter 头注释）：群聊仅 @ 消息入站、发送为被动回复、媒体仅公网 URL。
 */

import type { CapabilityRegistryEnv } from "../../capability-registry.js";
import { DEFAULT_BANNED_WORDS, findBannedWords, buildBannedWordWarning } from "../../../core/banned-words.js";

export function createQQBotClientProxy(
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

    async function callQQBot<T = unknown>(method: string, args: unknown[]): Promise<T> {
        return env.callHost(method, args) as Promise<T>;
    }

    const methods = {
        /**
         * 发送文本消息（被动回复优先：收到消息 5 分钟内可用 msg_id 回复，每条 msg_id 最多 5 次；
         * 超出窗口降级为主动消息，受平台配额限制，可能失败）。
         * @example
         * await qqbot.sendText("qqbot:group:ABC123", "来啦来啦");
         */
        sendText: async (chatId: string, text: string): Promise<unknown> => {
            const target = String(chatId ?? "");
            const content = String(text ?? "");
            if (!target || !content.trim()) {
                throw new Error("qqbot.sendText: chatId 与 text 均不能为空");
            }

            if (content && bannedWords.length > 0) {
                const found = findBannedWords(content, bannedWords);
                if (found.length > 0) {
                    const warning = buildBannedWordWarning(found, content);
                    env.emitOutput(warning);
                    env.notifyHost({
                        type: "system.banned_word_blocked",
                        scene: "qqbot",
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
                    scene: "qqbot",
                    chatId: target,
                    text: content,
                    timestamp: Date.now(),
                });
                return null;
            }

            const result = await callQQBot("qqbot.sendText", [target, content]);
            recordSentIfDedupEnabled(target, content);
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "qqbot",
                chatId: target,
                messageId: result && typeof result === "object" && "id" in result
                    ? (result as { id?: unknown }).id
                    : undefined,
                text: content,
                timestamp: Date.now(),
            });
            env.emitOutput(`[QQ官方] sendText ok chat=${target}`);
            return result;
        },

        /**
         * 发送媒体（图片/视频/音频）。官方平台仅接受公网可访问 https URL，
         * 本地文件/Buffer 无法上传；caption 会作为独立文本消息随后发送。
         * @example
         * await qqbot.sendMedia("qqbot:group:ABC123", { type: "photo", file: "https://example.com/a.jpg", caption: "看图" });
         */
        sendMedia: async (chatId: string, media: Record<string, unknown>): Promise<unknown> => {
            const target = String(chatId ?? "");
            if (!target) throw new Error("qqbot.sendMedia: chatId 不能为空");
            if (!media || typeof media !== "object") throw new Error("qqbot.sendMedia: media 必须是对象");
            return callQQBot("qqbot.sendMedia", [target, media]);
        },

        /** 官方平台无"正在输入"指示，no-op。 */
        sendTyping: async (chatId: string): Promise<null> => callQQBot("qqbot.sendTyping", [String(chatId ?? "")]),

        /** 获取会话基础信息（openid 无群详情 API，仅返回类型与本地已知信息）。 */
        getChat: async (chatId: string): Promise<unknown> => callQQBot("qqbot.getChat", [String(chatId ?? "")]),

        /** 获取 bot 自身信息（app_id 等）。 */
        getMe: async (): Promise<unknown> => callQQBot("qqbot.getMe", []),

        /**
         * 下载入站媒体（attachments URL）到宿主机内存。
         * @example
         * const { buffer, size } = await qqbot.downloadMedia("https://multimedia.nt.qq.com/...");
         */
        downloadMedia: async (fileId: string): Promise<{ buffer: string; size: number }> => {
            const result = await callQQBot<{ buffer: string; size: number }>("qqbot.downloadMedia", [String(fileId ?? "")]);
            return result;
        },
    };

    return methods;
}
