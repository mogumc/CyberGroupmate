import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveBotApiStickerFormat } from "../src/adapter/telegram-bot-api-client.js";
import { sniffStickerContainer } from "../src/adapter/telegram-adapter.js";

describe("resolveBotApiStickerFormat", () => {
    it("maps is_video to webm", () => {
        const format = resolveBotApiStickerFormat({ file_unique_id: "AgADabc", is_video: true });
        assert.equal(format.mimeType, "video/webm");
        assert.equal(format.fileName, "AgADabc.webm");
    });

    it("maps is_animated to tgs", () => {
        const format = resolveBotApiStickerFormat({ file_unique_id: "AgADabc", is_animated: true });
        assert.equal(format.mimeType, "application/x-tgsticker");
        assert.equal(format.fileName, "AgADabc.tgs");
    });

    it("falls back to static webp", () => {
        const format = resolveBotApiStickerFormat({ file_unique_id: "AgADabc" });
        assert.equal(format.mimeType, "image/webp");
        assert.equal(format.fileName, "AgADabc.webp");
    });

    it("prefers is_video when both flags are set", () => {
        const format = resolveBotApiStickerFormat({ file_unique_id: "AgADabc", is_video: true, is_animated: true });
        assert.equal(format.mimeType, "video/webm");
    });

    it("degrades gracefully without any id", () => {
        const format = resolveBotApiStickerFormat({});
        assert.equal(format.mimeType, "image/webp");
        assert.equal(format.fileName, undefined);
    });
});

describe("sniffStickerContainer", () => {
    let dir: string;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-sticker-sniff-"));
    });

    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function write(name: string, bytes: number[] | Buffer): string {
        const filePath = path.join(dir, name);
        fs.writeFileSync(filePath, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
        return filePath;
    }

    it("detects webm/matroska magic", () => {
        assert.equal(sniffStickerContainer(write("a.webp", [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02])), "webm");
    });

    it("detects gzip-framed tgs", () => {
        assert.equal(sniffStickerContainer(write("b.webp", [0x1f, 0x8b, 0x08, 0x00])), "tgs");
    });

    it("detects RIFF/WEBP", () => {
        const webp = Buffer.concat([
            Buffer.from("RIFF", "latin1"),
            Buffer.from([0x24, 0x00, 0x00, 0x00]),
            Buffer.from("WEBP", "latin1"),
        ]);
        assert.equal(sniffStickerContainer(write("c.bin", webp)), "webp");
    });

    it("detects gif", () => {
        assert.equal(sniffStickerContainer(write("d.dat", Buffer.from("GIF89a....", "latin1"))), "gif");
    });

    it("flags png and jpeg as needing conversion", () => {
        assert.equal(sniffStickerContainer(write("e.webp", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image");
        assert.equal(sniffStickerContainer(write("f.webp", [0xff, 0xd8, 0xff, 0xe0])), "image");
    });

    it("returns undefined for unknown or truncated payloads", () => {
        assert.equal(sniffStickerContainer(write("g.webp", [0x1a, 0x45])), undefined);
        assert.equal(sniffStickerContainer(write("h.webp", [0x00, 0x01, 0x02, 0x03, 0x04, 0x05])), undefined);
    });

    it("returns undefined for a short RIFF header (no WEBP fourcc)", () => {
        assert.equal(sniffStickerContainer(write("i.webp", Buffer.from("RIFF\x10\x00", "latin1"))), undefined);
    });

    it("returns undefined when the file is missing", () => {
        assert.equal(sniffStickerContainer(path.join(dir, "does-not-exist.webp")), undefined);
    });

    it("treats a webm payload named .webp as webm", () => {
        const filePath = write("dirty.webp", [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
        assert.equal(path.extname(filePath), ".webp");
        assert.equal(sniffStickerContainer(filePath), "webm");
    });
});
