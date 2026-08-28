#!/usr/bin/env tsx
/**
 * tg-to-jsonl.ts — Telegram Desktop JSON 导出 → dry-run JSONL 转换器
 *
 * 使用 stream-json 流式解析巨大的 Telegram 导出 JSON，
 * 逐条转换为 dry-run.ts 所需的 JSONL 格式。
 *
 * 用法:
 *   npx tsx src/tools/tg-to-jsonl.ts <input.json> [output.jsonl]
 *
 * 如果不指定 output，则默认为 <input>.jsonl
 */

import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parser } = require("stream-json");
const { streamArray } = require("stream-json/streamers/StreamArray");
const { pick } = require("stream-json/filters/Pick");

// ─── 类型定义 ───

/** Telegram 导出的消息格式 */
interface TgMessage {
    id: number;
    type: "message" | "service" | string;
    date: string;
    from?: string;
    from_id?: string;  // "user654646640"
    text: string | TgTextEntity[];
    full_text?: string;
    reply_to_message_id?: number;
    // 媒体相关（不关心但可能存在）
    media_type?: string;
    sticker_emoji?: string;
    file?: string;
}

/** Telegram text_entities 中的实体 */
interface TgTextEntity {
    type: string;
    text: string;
}

/** dry-run.ts 所需的 JSONL 行格式 */
interface HistoryMessage {
    id: number;
    chat_id: number;
    user_id: number;
    user_name: string;
    text: string;
    date: string;
    reply_to?: number;
}

// ─── 辅助函数 ───

/** 从 "user654646640" 格式的 from_id 中提取数字 */
function extractUserId(fromId: string | undefined): number {
    if (!fromId) return 0;
    const match = fromId.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

/** 将 text 字段（可能是字符串或实体数组）转换为纯文本 */
function extractText(msg: TgMessage): string {
    // 优先使用 full_text
    if (msg.full_text && msg.full_text.length > 0) {
        return msg.full_text;
    }
    // text 可能是字符串
    if (typeof msg.text === "string") {
        return msg.text;
    }
    // text 可能是实体数组
    if (Array.isArray(msg.text)) {
        return msg.text.map(e => e.text).join("");
    }
    return "";
}

// ─── 主流程 ───

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error("用法: npx tsx src/tools/tg-to-jsonl.ts <input.json> [output.jsonl]");
        process.exit(1);
    }

    const inputPath = args[0];
    const outputPath = args[1] ?? inputPath.replace(/\.json$/, ".jsonl");

    console.log(`输入: ${inputPath}`);
    console.log(`输出: ${outputPath}`);

    // 我们需要先做一次预扫描读取顶层的 chat id，
    // 但由于文件巨大，我们用另一种策略：
    // 从文件开头读几 KB 提取 "id" 字段。
    const chatId = await extractChatId(inputPath);
    console.log(`Chat ID: ${chatId}`);

    let processed = 0;
    let skipped = 0;
    let written = 0;

    const outputStream = createWriteStream(outputPath, { encoding: "utf-8" });

    // 构建流式处理管道：
    // 读文件 → JSON 解析 → 提取 messages 数组 → 逐元素流式输出 → 转换 → 写文件
    const transformStream = new Transform({
        objectMode: true,
        transform(chunk: { key: number; value: TgMessage }, _encoding, callback) {
            processed++;
            const msg = chunk.value;

            // 只处理普通消息
            if (msg.type !== "message") {
                skipped++;
                callback();
                return;
            }

            const text = extractText(msg);

            // 跳过纯媒体消息（没有文本内容）
            if (!text || text.trim().length === 0) {
                skipped++;
                callback();
                return;
            }

            const record: HistoryMessage = {
                id: msg.id,
                chat_id: chatId,
                user_id: extractUserId(msg.from_id),
                user_name: msg.from ?? "Unknown",
                text,
                date: msg.date,
            };

            if (msg.reply_to_message_id != null) {
                record.reply_to = msg.reply_to_message_id;
            }

            written++;
            const line = JSON.stringify(record) + "\n";
            
            // 处理背压
            if (!outputStream.write(line)) {
                outputStream.once("drain", callback);
            } else {
                callback();
            }

            // 进度报告
            if (processed % 10000 === 0) {
                console.log(`  已处理 ${processed} 条, 已写入 ${written} 条, 跳过 ${skipped} 条`);
            }
        },
    });

    const readStream = createReadStream(inputPath, { encoding: "utf-8" });

    await pipeline(
        readStream,
        parser(),
        pick({ filter: "messages" }),
        streamArray(),
        transformStream,
    );

    outputStream.end();

    // 等待输出流完成
    await new Promise<void>((resolve, reject) => {
        outputStream.on("finish", resolve);
        outputStream.on("error", reject);
    });

    console.log("\n转换完成!");
    console.log(`  总处理: ${processed} 条`);
    console.log(`  已写入: ${written} 条`);
    console.log(`  已跳过: ${skipped} 条 (service/纯媒体)`);
    console.log(`  输出文件: ${outputPath}`);
}

/**
 * 从 JSON 文件开头提取顶层 "id" 字段（chat_id）。
 * 只读前 4KB，不会加载整个文件。
 */
async function extractChatId(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const stream = createReadStream(filePath, {
            encoding: "utf-8",
            start: 0,
            end: 4096,
        });
        let buffer = "";
        stream.on("data", (chunk) => {
            buffer += chunk;
        });
        stream.on("end", () => {
            // 从开头几行查找 "id": 数字 模式
            // 注意要跳过 messages 数组中的 id，只取顶层的
            const match = buffer.match(/"id"\s*:\s*(\d+)/);
            if (match) {
                resolve(parseInt(match[1], 10));
            } else {
                console.warn("无法从文件开头提取 chat_id，使用默认值 0");
                resolve(0);
            }
            stream.destroy();
        });
        stream.on("error", reject);
    });
}

main().catch((err) => {
    console.error("转换失败:", err);
    process.exit(1);
});
