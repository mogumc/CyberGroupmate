/**
 * media-downloader.test.ts — MediaDownloader 单元测试
 */

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { MediaDownloader } from "../src/core/media-downloader.js";

const TEST_DIR = "/tmp/test-media-downloads";

describe("MediaDownloader", () => {
    let downloader: MediaDownloader;

    before(() => {
        // 清理测试目录
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    after(() => {
        downloader?.dispose();
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("should create download directories on construction", () => {
        downloader = new MediaDownloader({ downloadDir: TEST_DIR, retentionDays: 1 });

        for (const cat of ["photos", "videos", "stickers", "documents", "other"]) {
            assert.ok(
                fs.existsSync(path.join(TEST_DIR, cat)),
                `Directory ${cat} should exist`,
            );
        }
    });

    it("should save media to correct category with correct filename", () => {
        const buffer = Buffer.from("fake image data");
        const result = downloader.saveMedia(buffer, {
            chatId: "-100123",
            messageId: "456",
            uniqueFileId: "abc123",
            mediaType: "photo",
            mimeType: "image/jpeg",
        });

        assert.ok(result !== null);
        assert.equal(result!.category, "photos");
        assert.ok(result!.path.endsWith(".jpeg"), `Expected .jpeg extension, got ${result!.path}`);
        assert.ok(result!.path.includes("abc123"));
        assert.equal(result!.size, buffer.length);
        assert.ok(fs.existsSync(result!.path));
    });

    it("should dedup by uniqueFileId", () => {
        const buffer = Buffer.from("more data");
        const result1 = downloader.saveMedia(buffer, {
            chatId: "-100123",
            messageId: "789",
            uniqueFileId: "dedup_test",
            mediaType: "document",
            mimeType: "application/pdf",
        });
        assert.ok(result1 !== null);

        const result2 = downloader.saveMedia(buffer, {
            chatId: "-100123",
            messageId: "999",
            uniqueFileId: "dedup_test",
            mediaType: "document",
            mimeType: "application/pdf",
        });
        assert.ok(result2 !== null);

        // Same path (deduped)
        assert.equal(result1!.path, result2!.path);
    });

    it("should return null for files exceeding size limit", () => {
        const smallDownloader = new MediaDownloader({
            downloadDir: TEST_DIR,
            maxFileSize: 10,
            retentionDays: 1,
        });

        const buffer = Buffer.alloc(20); // 20 bytes > 10 byte limit
        const result = smallDownloader.saveMedia(buffer, {
            chatId: "-100123",
            messageId: "100",
            uniqueFileId: "toobig",
            mediaType: "video",
            mimeType: "video/mp4",
        });
        assert.equal(result, null);
        smallDownloader.dispose();
    });

    it("should check size limits correctly", () => {
        assert.equal(downloader.isWithinSizeLimit(100), true);
        assert.equal(downloader.isWithinSizeLimit(undefined), true);
        assert.equal(downloader.isWithinSizeLimit(100 * 1024 * 1024), false);
    });

    it("should find existing files by uniqueFileId", () => {
        const existing = downloader.getExistingPath("abc123");
        assert.ok(existing !== null);
        assert.ok(existing!.includes("abc123"));

        const notFound = downloader.getExistingPath("nonexistent");
        assert.equal(notFound, null);
    });

    it("should categorize different media types correctly", () => {
        const testCases = [
            { mediaType: "video", mimeType: "video/mp4", expectedCat: "videos", ext: ".mp4" },
            { mediaType: "sticker", mimeType: "image/webp", expectedCat: "stickers", ext: ".webp" },
            { mediaType: "animation", mimeType: "video/mp4", expectedCat: "other", ext: ".mp4" },
        ];

        for (const tc of testCases) {
            const result = downloader.saveMedia(Buffer.from("test"), {
                chatId: "1",
                messageId: "1",
                uniqueFileId: `cat_test_${tc.mediaType}`,
                mediaType: tc.mediaType,
                mimeType: tc.mimeType,
            });
            assert.ok(result !== null, `Should save ${tc.mediaType}`);
            assert.equal(result!.category, tc.expectedCat, `${tc.mediaType} → ${tc.expectedCat}`);
            assert.ok(result!.path.endsWith(tc.ext), `${tc.mediaType} should have ${tc.ext} ext`);
        }
    });

    it("should cleanup expired files", () => {
        // Create a file and backdate its mtime to 5 days ago
        const buffer = Buffer.from("old file");
        const result = downloader.saveMedia(buffer, {
            chatId: "1",
            messageId: "1",
            uniqueFileId: "old_file_test",
            mediaType: "photo",
            mimeType: "image/png",
        });
        assert.ok(result !== null);

        // Backdate the file
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        fs.utimesSync(result!.path, fiveDaysAgo, fiveDaysAgo);

        // Run cleanup (retention = 1 day)
        downloader.cleanupExpired();

        // File should be deleted
        assert.equal(fs.existsSync(result!.path), false, "Expired file should be deleted");
        assert.equal(downloader.getExistingPath("old_file_test"), null, "Index should be cleared");
    });

    it("cleanupCache should purge everything except stickers (incl. root files and nested dirs)", () => {
        // 贴纸：同一内容两个 uniqueFileId（内容去重别名），清理后必须整体保留
        const stickerBuffer = Buffer.from("cleanup-test-sticker-content");
        const stickerA = downloader.saveMedia(stickerBuffer, {
            chatId: "1",
            messageId: "1",
            uniqueFileId: "cleanup_sticker_a",
            mediaType: "sticker",
            mimeType: "image/webp",
        });
        const stickerB = downloader.saveMedia(stickerBuffer, {
            chatId: "2",
            messageId: "2",
            uniqueFileId: "cleanup_sticker_b",
            mediaType: "sticker",
            mimeType: "image/webp",
        });
        assert.ok(stickerA && stickerB);
        assert.equal(stickerA!.path, stickerB!.path, "同一内容的贴纸应复用同一文件");

        // 待清理：普通图片 + 根目录散落文件 + other/ 嵌套子目录
        const photo = downloader.saveMedia(Buffer.from("cleanup-test-photo"), {
            chatId: "1",
            messageId: "3",
            uniqueFileId: "cleanup_photo",
            mediaType: "photo",
            mimeType: "image/png",
        });
        assert.ok(photo);

        const rootFile = path.join(TEST_DIR, "onebot_root_download.png");
        fs.writeFileSync(rootFile, "root junk");

        const nestedDir = path.join(TEST_DIR, "other", "qq-converted");
        fs.mkdirSync(nestedDir, { recursive: true });
        const nestedFile = path.join(nestedDir, "converted.silk");
        fs.writeFileSync(nestedFile, "nested junk");

        // 默认清理：除贴纸外全部
        const result = downloader.cleanupCache();
        const deletedFor = (key: string) => result.deleted.find((entry) => entry.key === key);

        assert.ok((deletedFor("photos")?.files ?? 0) >= 1, "photos 应被清理");
        assert.ok((deletedFor("root")?.files ?? 0) >= 1, "根目录散落文件应被清理");
        assert.ok((deletedFor("other")?.files ?? 0) >= 1, "other 嵌套子目录应被清理");
        assert.equal(fs.existsSync(photo!.path), false, "图片文件应被删除");
        assert.equal(fs.existsSync(rootFile), false, "根目录散落文件应被删除");
        assert.equal(fs.existsSync(nestedFile), false, "嵌套子目录文件应被删除");

        // 贴纸白名单：文件与索引（含别名）完整保留
        assert.equal(fs.existsSync(stickerA!.path), true, "贴纸文件不应被清理");
        assert.equal(downloader.getExistingPath("cleanup_sticker_a"), stickerA!.path);
        assert.equal(downloader.getExistingPath("cleanup_sticker_b"), stickerA!.path);

        // manifest 内部文件不参与清理
        assert.equal(fs.existsSync(path.join(TEST_DIR, "_manifest.json")), true);

        // 统计：除贴纸外全部归零，stickers 单独列项且仍有文件
        const stats = downloader.getCacheStats();
        const statFor = (key: string) => stats.categories.find((c) => c.key === key)!;
        for (const key of ["photos", "videos", "documents", "other", "root"]) {
            assert.equal(statFor(key).files, 0, `${key} 清理后应为空`);
        }
        assert.ok(statFor("stickers").files >= 1, "stickers 应单独列项且保留计数");
        assert.equal(stats.totalFiles, statFor("stickers").files);
    });

    it("cleanupCache with explicit stickers should purge sticker files and their aliases", () => {
        // 空数组 = 不清理任何内容（防误操作）
        const noop = downloader.cleanupCache([]);
        assert.equal(noop.deleted.length, 0, "空数组不应触发任何清理");

        const stickerPath = downloader.getExistingPath("cleanup_sticker_a");
        assert.ok(stickerPath, "前置用例应保留贴纸");

        const result = downloader.cleanupCache(["stickers"]);
        const stickerEntry = result.deleted.find((entry) => entry.key === "stickers");
        assert.ok(stickerEntry && stickerEntry.files >= 1, "贴纸应被显式清理");
        assert.equal(fs.existsSync(stickerPath!), false, "贴纸文件应被删除");

        // 内容去重的别名索引必须一并移除，不能留下悬空路径
        assert.equal(downloader.getExistingPath("cleanup_sticker_a"), null);
        assert.equal(downloader.getExistingPath("cleanup_sticker_b"), null);

        const stats = downloader.getCacheStats();
        assert.equal(stats.categories.find((c) => c.key === "stickers")!.files, 0);
    });
});
