import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    autoReconnect,
    disconnectAll,
    getConnectionConfigs,
    getMcpModuleEntries,
    initMcpBridge,
    mcpBridge,
    replaceConnectionConfigs,
} from "../src/sandbox/modules/mcp-bridge/index.js";
import { getModuleRegistryCache, refreshModuleRegistryCache } from "../src/subagent/code-act-executor.js";

describe("mcp-bridge Streamable HTTP", () => {
    async function readBody(req: IncomingMessage): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString("utf-8");
    }

    it("publishes connected MCP tools into the dynamic module registry", async () => {
        initMcpBridge({
            persistPath: "",
            onRegistryChange: () => {
                refreshModuleRegistryCache();
            },
        });

        let serverUrl = "";

        const server = createServer(async (req, res) => {
            if (req.method !== "POST") {
                res.writeHead(405);
                res.end();
                return;
            }

            const body = await readBody(req);
            const msg = JSON.parse(body) as {
                id?: number;
                method?: string;
            };

            if (msg.method === "initialize") {
                writeJson(
                    res,
                    {
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: {
                            protocolVersion: "2025-03-26",
                            capabilities: { tools: {} },
                            serverInfo: { name: "mock-mcp", version: "1.0.0" },
                        },
                    },
                    { "Mcp-Session-Id": "sess-456" }
                );
                return;
            }

            if (msg.method === "notifications/initialized") {
                res.writeHead(202);
                res.end();
                return;
            }

            if (msg.method === "tools/list") {
                writeJson(res, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        tools: [
                            {
                                name: "search_repositories",
                                description: "Search repositories",
                                inputSchema: {
                                    type: "object",
                                    properties: { query: { type: "string" } },
                                    required: ["query"],
                                },
                            },
                        ],
                    },
                });
                return;
            }

            res.writeHead(404);
            res.end();
        });

        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                    throw new Error("Failed to bind mock MCP server");
                }
                serverUrl = `http://127.0.0.1:${address.port}/mcp`;
                resolve();
            });
        });

        try {
            await mcpBridge.connect({
                name: "github",
                description: "用于搜索 GitHub 仓库和代码",
                transport: "streamable-http",
                url: serverUrl,
            });

            // The MCP bridge should publish exactly the connected server's tools as a
            // dynamic module entry. We assert against getMcpModuleEntries() (the bridge's
            // own contribution) rather than the fully merged cache, because the merged
            // cache also folds in builtin modules and workspace TS Skills, which may
            // coincidentally share a name (e.g. a local "github" skill) and inflate the
            // method count in a way that depends on the developer's workspace state.
            const mcpEntries = getMcpModuleEntries();
            const githubEntry = mcpEntries.find((entry) => entry.name === "github");
            assert.ok(githubEntry, "connected MCP server should be published as a dynamic module entry");
            assert.equal(githubEntry?.methods.length, 1);
            assert.equal(githubEntry?.methods[0]?.name, "search_repositories");
            assert.match(githubEntry?.description ?? "", /MCP Server \(1 tools\) via Streamable HTTP/);
            assert.match(githubEntry?.description ?? "", /用于搜索 GitHub 仓库和代码/);

            // The onRegistryChange → refreshModuleRegistryCache() wiring should make the
            // connected server visible in the merged cache too, with its tool present.
            const registry = getModuleRegistryCache();
            const githubModule = registry.find((entry) => entry.name === "github");
            assert.ok(githubModule, "connected MCP server should appear in module registry cache");
            assert.ok(
                githubModule?.methods.some((method) => method.name === "search_repositories"),
                "merged cache should include the connected MCP tool",
            );
            assert.deepEqual(getConnectionConfigs(), [{
                name: "github",
                description: "用于搜索 GitHub 仓库和代码",
                transport: "streamable-http",
                url: serverUrl,
            }]);
        } finally {
            await disconnectAll();
            await new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
        }
    });

    function writeJson(res: ServerResponse, body: unknown, headers?: Record<string, string>): void {
        res.writeHead(200, {
            "Content-Type": "application/json",
            ...(headers ?? {}),
        });
        res.end(JSON.stringify(body));
    }

    it("supports Streamable HTTP JSON-RPC with session headers and SSE responses", async () => {
        initMcpBridge({ persistPath: "" });

        let serverUrl = "";
        let deleteCalled = false;
        const seenSessionHeaders: string[] = [];
        const seenAuthHeaders: string[] = [];

        const server = createServer(async (req, res) => {
            const authHeader = req.headers.authorization;
            if (authHeader) seenAuthHeaders.push(String(authHeader));

            if (req.method === "DELETE") {
                deleteCalled = true;
                seenSessionHeaders.push(String(req.headers["mcp-session-id"] ?? ""));
                res.writeHead(204);
                res.end();
                return;
            }

            if (req.method !== "POST") {
                res.writeHead(405);
                res.end();
                return;
            }

            const body = await readBody(req);
            const msg = JSON.parse(body) as {
                id?: number;
                method?: string;
                params?: Record<string, unknown>;
            };

            if (msg.method !== "initialize") {
                seenSessionHeaders.push(String(req.headers["mcp-session-id"] ?? ""));
            }

            if (msg.method === "initialize") {
                writeJson(
                    res,
                    {
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: {
                            protocolVersion: "2025-03-26",
                            capabilities: { tools: {} },
                            serverInfo: { name: "mock-mcp", version: "1.0.0" },
                        },
                    },
                    { "Mcp-Session-Id": "sess-123" }
                );
                return;
            }

            if (msg.method === "notifications/initialized") {
                res.writeHead(202);
                res.end();
                return;
            }

            if (msg.method === "tools/list") {
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.write(
                    `event: message\nid: evt-1\ndata: ${JSON.stringify({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: {
                            tools: [
                                {
                                    name: "echo",
                                    description: "Echo input",
                                    inputSchema: {
                                        type: "object",
                                        properties: { value: { type: "string" } },
                                        required: ["value"],
                                    },
                                },
                            ],
                        },
                    })}\n\n`
                );
                res.end();
                return;
            }

            if (msg.method === "tools/call") {
                const toolArgs = (msg.params as { arguments?: { value?: unknown } } | undefined)?.arguments;
                writeJson(res, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        content: [
                            {
                                type: "text",
                                text: String(toolArgs?.value ?? ""),
                            },
                        ],
                    },
                });
                return;
            }

            res.writeHead(404);
            res.end();
        });

        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                    throw new Error("Failed to bind mock MCP server");
                }
                serverUrl = `http://127.0.0.1:${address.port}/mcp`;
                resolve();
            });
        });

        try {
            const remote = await mcpBridge.connect({
                name: "remote-http",
                transport: "streamable-http",
                url: serverUrl,
                headers: { Authorization: "Bearer test-token" },
            });

            assert.equal(remote.name, "remote-http");
            assert.deepEqual(remote.tools, [{ name: "echo", description: "Echo input" }]);

            const listed = mcpBridge.list();
            assert.equal(listed.length, 1);
            assert.equal(listed[0]?.transport, "streamable-http");
            assert.equal(listed[0]?.url, serverUrl);
            assert.equal(listed[0]?.running, true);

            const result = await mcpBridge.call("remote-http", "echo", { value: "hello http" });
            assert.equal(result, "hello http");

            await mcpBridge.disconnect("remote-http");
            assert.equal(mcpBridge.list().length, 0);

            assert.deepEqual(seenSessionHeaders, ["sess-123", "sess-123", "sess-123", "sess-123"]);
            assert.ok(seenAuthHeaders.every((header) => header === "Bearer test-token"));
            assert.equal(deleteCalled, true);
        } finally {
            await disconnectAll();
            await new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
        }
    });

    it("exports and replaces global MCP configs", async () => {
        initMcpBridge({ persistPath: "" });

        let serverUrl = "";

        const server = createServer(async (req, res) => {
            if (req.method !== "POST") {
                res.writeHead(405);
                res.end();
                return;
            }

            const body = await readBody(req);
            const msg = JSON.parse(body) as { id?: number; method?: string };

            if (msg.method === "initialize") {
                writeJson(res, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        protocolVersion: "2025-03-26",
                        capabilities: { tools: {} },
                        serverInfo: { name: "mock-mcp", version: "1.0.0" },
                    },
                }, { "Mcp-Session-Id": "sess-789" });
                return;
            }

            if (msg.method === "notifications/initialized") {
                res.writeHead(202);
                res.end();
                return;
            }

            if (msg.method === "tools/list") {
                writeJson(res, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        tools: [
                            { name: "ping", description: "Ping tool" },
                        ],
                    },
                });
                return;
            }

            res.writeHead(404);
            res.end();
        });

        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                    throw new Error("Failed to bind mock MCP server");
                }
                serverUrl = `http://127.0.0.1:${address.port}/mcp`;
                resolve();
            });
        });

        try {
            await mcpBridge.connect({
                name: "before-replace",
                transport: "streamable-http",
                url: serverUrl,
            });
            assert.equal(getConnectionConfigs().length, 1);

            await replaceConnectionConfigs([
                {
                    name: "after-replace",
                    transport: "streamable-http",
                    url: serverUrl,
                },
            ]);

            const configs = getConnectionConfigs();
            assert.deepEqual(configs, [
                {
                    name: "after-replace",
                    transport: "streamable-http",
                    url: serverUrl,
                },
            ]);
            assert.deepEqual(mcpBridge.list().map((server) => server.name), ["after-replace"]);
        } finally {
            await disconnectAll();
            await new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
        }
    });

    it("interpolates ${VAR} env placeholders in headers at request time (literal kept on disk)", async () => {
        initMcpBridge({ persistPath: "" });
        process.env.ZAI_TEST_KEY = "secret-zai-token";

        let serverUrl = "";
        const seenAuthHeaders: string[] = [];

        const server = createServer(async (req, res) => {
            const authHeader = req.headers.authorization;
            if (authHeader) seenAuthHeaders.push(String(authHeader));

            if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

            const body = await readBody(req);
            const msg = JSON.parse(body) as { id?: number; method?: string };

            if (msg.method === "initialize") {
                writeJson(res, {
                    jsonrpc: "2.0", id: msg.id,
                    result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "zai", version: "1.0.0" } },
                }, { "Mcp-Session-Id": "sess-zai" });
                return;
            }
            if (msg.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
            if (msg.method === "tools/list") {
                writeJson(res, { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "webSearchPrime", description: "search" }] } });
                return;
            }
            if (msg.method === "tools/call") {
                writeJson(res, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
                return;
            }
            res.writeHead(404); res.end();
        });

        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") throw new Error("Failed to bind mock MCP server");
                serverUrl = `http://127.0.0.1:${address.port}/mcp`;
                resolve();
            });
        });

        try {
            await mcpBridge.connect({
                name: "zai",
                transport: "streamable-http",
                url: serverUrl,
                headers: { Authorization: "Bearer ${ZAI_TEST_KEY}" },
            });
            await mcpBridge.call("zai", "webSearchPrime", { query: "x" });

            // The server must have received the RESOLVED token on every request (init, list, call).
            assert.ok(seenAuthHeaders.length > 0, "server should have seen Authorization headers");
            assert.ok(
                seenAuthHeaders.every((header) => header === "Bearer secret-zai-token"),
                `all auth headers should be resolved; saw ${JSON.stringify(seenAuthHeaders)}`,
            );

            // The persisted/exported config must keep the LITERAL ${VAR}, never the resolved secret.
            const configs = getConnectionConfigs();
            assert.equal(configs[0]?.headers?.Authorization, "Bearer ${ZAI_TEST_KEY}");
            assert.ok(!JSON.stringify(configs).includes("secret-zai-token"), "secret must not be persisted in config");
        } finally {
            delete process.env.ZAI_TEST_KEY;
            await disconnectAll();
            await new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
        }
    });

    it("keeps configs when a server fails to reconnect (restart / connect failure must not drop them)", async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), "cgm-mcp-persist-"));
        const persistPath = join(tmpDir, "mcp-connections.json");

        let serverUrl = "";

        // 一个可用的 mock server；另一个配置指向必然拒绝连接的端口（127.0.0.1:1）。
        const server = createServer(async (req, res) => {
            if (req.method !== "POST") {
                res.writeHead(405);
                res.end();
                return;
            }

            const body = await readBody(req);
            const msg = JSON.parse(body) as { id?: number; method?: string };

            if (msg.method === "initialize") {
                writeJson(res, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        protocolVersion: "2025-03-26",
                        capabilities: { tools: {} },
                        serverInfo: { name: "mock-mcp", version: "1.0.0" },
                    },
                }, { "Mcp-Session-Id": "sess-persist" });
                return;
            }
            if (msg.method === "notifications/initialized") {
                res.writeHead(202);
                res.end();
                return;
            }
            if (msg.method === "tools/list") {
                writeJson(res, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { tools: [{ name: "ping", description: "Ping tool" }] },
                });
                return;
            }
            res.writeHead(404);
            res.end();
        });

        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") throw new Error("Failed to bind mock MCP server");
                serverUrl = `http://127.0.0.1:${address.port}/mcp`;
                resolve();
            });
        });

        const readPersistedNames = (): string[] =>
            (JSON.parse(readFileSync(persistPath, "utf-8")) as Array<{ name?: string }>)
                .map((config) => String(config.name))
                .sort();

        try {
            // 模拟重启前落盘的配置：一个可用 + 一个暂时不可达。
            // 顺序刻意让"可用"排在前面——修复前它的成功重连会触发落盘，把后面尚未重连的配置覆盖删除。
            writeFileSync(persistPath, JSON.stringify([
                { name: "up-http", transport: "streamable-http", url: serverUrl },
                { name: "down-http", transport: "streamable-http", url: "http://127.0.0.1:1/mcp" },
            ], null, 2), "utf-8");

            initMcpBridge({ persistPath });
            await autoReconnect();

            // 关键回归：一个成功、一个失败，两个配置都必须留在持久化文件里。
            assert.deepEqual(readPersistedNames(), ["down-http", "up-http"]);
            assert.deepEqual(getConnectionConfigs().map((config) => config.name).sort(), ["down-http", "up-http"]);

            // 连接失败的 server 仍会出现在列表里（running: false），配置不"隐身"。
            const listed = mcpBridge.list();
            assert.equal(listed.find((entry) => entry.name === "up-http")?.running, true);
            assert.equal(listed.find((entry) => entry.name === "down-http")?.running, false);

            // 其他 server 成功连接触发的落盘，也不能冲掉失败的那条配置。
            await mcpBridge.connect({ name: "extra-http", transport: "streamable-http", url: serverUrl });
            assert.ok(readPersistedNames().includes("down-http"), "later saves must keep the failed server config");

            // 新增配置即使本次连接失败也必须保留（服务重新上线 / 重启后会继续重试）。
            await assert.rejects(mcpBridge.connect({
                name: "newly-down",
                transport: "streamable-http",
                url: "http://127.0.0.1:1/mcp",
            }));
            assert.ok(readPersistedNames().includes("newly-down"), "failed connect must still persist the config");

            // 只有显式 disconnect 才会移除配置。
            await mcpBridge.disconnect("down-http");
            assert.ok(!readPersistedNames().includes("down-http"), "explicit disconnect removes the config");
        } finally {
            await disconnectAll();
            try {
                rmSync(tmpDir, { recursive: true, force: true });
            } catch {
                // 临时目录清理失败不影响测试结论
            }
            await new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
        }
    });
});