/**
 * modules/mcp-bridge.ts — MCP Server 连接器
 *
 * 在 Sandbox Worker 内管理 MCP Server 连接。
 * 当前支持两种传输：
 * - stdio：启动本地 MCP Server 子进程，通过 stdin/stdout 进行 JSON-RPC
 * - Streamable HTTP：对远端 MCP endpoint 发起 HTTP POST，请求结果可为 JSON 或 SSE
 *
 * 连接信息全局持久化到 workspace/mcp-connections.json（所有 sandbox / subagent 共享），
 * 进程重启时自动重连。
 *
 * 持久化语义：落盘的是「期望安装的配置」（desiredConfigs），与连接状态解耦——
 * 连接失败 / 重连失败都不会删除配置（下次启动继续重试），
 * 只有显式 disconnect()（或全量替换配置）才会移除。避免一次网络抖动导致 MCP 永久失效。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModuleEntry, MethodDoc } from "../module-registry.js";

// ─── 类型定义 ───

export type McpTransportKind = "stdio" | "streamable-http";

export interface McpServerConfig {
    /** 显示名称（用于 LLM 上下文，也是 tool 命名空间） */
    name: string;
    /** 服务器用途描述，会透传给模块名册和 mcp.list() */
    description?: string;
    /** 传输方式。未指定时：有 url 则视为 streamable-http，否则视为 stdio */
    transport?: McpTransportKind;
    /** stdio 启动命令 */
    command?: string;
    /** stdio 命令参数 */
    args?: string[];
    /** stdio 环境变量（如 API keys） */
    env?: Record<string, string>;
    /** Streamable HTTP endpoint */
    url?: string;
    /** Streamable HTTP 附加请求头（如 Authorization） */
    headers?: Record<string, string>;
}

interface McpToolSchema {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

interface JsonRpcErrorObject {
    code?: number;
    message?: string;
    data?: unknown;
}

interface JsonRpcMessage {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: JsonRpcErrorObject;
}

interface McpConnection {
    config: McpServerConfig;
    transportKind: McpTransportKind;
    tools: McpToolSchema[];
    /** stdio child process（仅 stdio transport 使用） */
    process?: ChildProcess;
    /** JSON-RPC 请求计数器 */
    requestId: number;
    /** stdio 待处理的 JSON-RPC 响应 */
    pendingRequests?: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
    /** stdio 输出缓冲 */
    outputBuffer?: string;
    /** Streamable HTTP 会话 ID */
    sessionId?: string;
    /** 在途的会话重建。并发请求共享同一个恢复过程，避免互相作废对方刚拿到的新会话 */
    sessionRecovery?: Promise<void>;
    /** SSE 最后一个 event id（用于后续可恢复扩展） */
    lastEventId?: string;
}

interface ParsedSseEvent {
    event: string;
    data: string;
    id?: string;
}

interface McpProxyCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

export interface McpServerInfo {
    name: string;
    description?: string;
    transport: "stdio" | "streamable-http";
    url?: string;
    tools: string[];
    running: boolean;
}

// ─── 全局状态 ───

const connections = new Map<string, McpConnection>();

/**
 * 期望配置（用户意图）：持久化文件与 getConnectionConfigs() 的唯一来源，与运行状态解耦。
 * 只有这些操作会修改它：
 * - connect(config)：新增 / 更新
 * - 显式 disconnect(name)：移除
 * - replaceConnectionConfigs(configs)：全量替换
 * 连接失败、重连失败都不动它，避免配置被误删导致 MCP 永久失效。
 */
const desiredConfigs = new Map<string, McpServerConfig>();

/** 持久化路径（由外部设置） */
let persistPath = "";

/** registry 变更回调（通知 code-act-executor 刷新缓存） */
let onRegistryChange: (() => void) | null = null;

/** Worker 代理回调：启用后所有操作转发到 Host 全局 MCP 管理器 */
let proxyCallbacks: McpProxyCallbacks | null = null;

/** Worker 侧缓存的全局 MCP 列表快照，用于同步 mcp.list() */
let cachedServerList: McpServerInfo[] = [];

const MCP_PROTOCOL_VERSION = "2024-11-05";
const HTTP_ACCEPT = "application/json, text/event-stream";
const SSE_CONTENT_TYPE = "text/event-stream";

// ─── 持久化 ───

function loadPersistedConnections(): McpServerConfig[] {
    if (!persistPath || !existsSync(persistPath)) return [];
    try {
        const parsed = JSON.parse(readFileSync(persistPath, "utf-8"));
        // 文件被手工改坏时按空处理，避免启动重连直接抛错。
        return Array.isArray(parsed) ? parsed as McpServerConfig[] : [];
    } catch {
        return [];
    }
}

function saveConnectionConfigs(): void {
    if (!persistPath) return;
    // 落盘的是期望配置而非当前活连接：连接失败不会导致配置从文件里消失。
    const configs = Array.from(desiredConfigs.values());
    try {
        const dir = dirname(persistPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(persistPath, JSON.stringify(configs, null, 2), "utf-8");
    } catch (err) {
        process.stderr.write(`[mcp-bridge] 持久化失败: ${err}\n`);
    }
}

function listConnectionsLocal(): McpServerInfo[] {
    const result: McpServerInfo[] = Array.from(connections.entries()).map(([name, conn]) => ({
        name,
        description: conn.config.description,
        transport: conn.transportKind,
        url: conn.config.url,
        tools: conn.tools.map((tool) => tool.name),
        running: conn.transportKind === "streamable-http" ? true : !!conn.process,
    }));
    // 已配置但当前未连接的 server 也列出（running: false），配置不"隐身"：
    // 连接失败时用户仍能在 dashboard 看到、编辑或卸载它。
    for (const [name, config] of desiredConfigs) {
        if (connections.has(name)) continue;
        result.push({
            name,
            description: config.description,
            transport: getTransportKind(config),
            url: config.url,
            tools: [],
            running: false,
        });
    }
    return result;
}

function cloneServerList(list: McpServerInfo[]): McpServerInfo[] {
    return list.map((server) => ({
        ...server,
        tools: [...server.tools],
    }));
}

// ─── 配置 / transport 判定 ───

/**
 * 把字符串里的 `${VAR}` 占位符替换为 `process.env[VAR]`。
 *
 * VAR 由 cgm 的环境变量注入器（buildEnvPlan，scope=host/both）写入 host 进程的 process.env，
 * 而 MCP 预配置连接 / 工具调用都跑在 host 进程，所以这里能取到。
 * 在请求/连接时（而非解析时）解析：
 *   - 持久化的 mcp-connections.json 仍只保存字面量 `${VAR}`，密钥不落盘；
 *   - dashboard 热改 env 后，下一次请求即生效，无需重连。
 * 未定义的变量替换为空串；非 `${...}` 文本原样保留。
 */
function interpolateEnv(value: string): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function getTransportKind(config: McpServerConfig): McpTransportKind {
    if (config.transport) return config.transport;
    return config.url ? "streamable-http" : "stdio";
}

function validateConfig(config: McpServerConfig): void {
    const transportKind = getTransportKind(config);
    if (!config.name?.trim()) {
        throw new Error("MCP Server 配置缺少 name");
    }
    if (transportKind === "stdio" && !config.command) {
        throw new Error(`MCP Server "${config.name}" 使用 stdio transport 时必须提供 command`);
    }
    if (transportKind === "streamable-http" && !config.url) {
        throw new Error(`MCP Server "${config.name}" 使用 Streamable HTTP transport 时必须提供 url`);
    }
}

function createConnection(config: McpServerConfig): McpConnection {
    validateConfig(config);
    return {
        config,
        transportKind: getTransportKind(config),
        tools: [],
        requestId: 0,
        pendingRequests: new Map(),
    };
}

function nextRequestId(conn: McpConnection): number {
    conn.requestId += 1;
    return conn.requestId;
}

function initializeParams(): Record<string, unknown> {
    return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "CyberGroupmate", version: "1.0.0" },
    };
}

// ─── JSON-RPC over stdio ───

function sendJsonRpcStdioRequest(conn: McpConnection, method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        if (!conn.process?.stdin?.writable) {
            reject(new Error(`MCP Server "${conn.config.name}" is not running`));
            return;
        }

        const id = nextRequestId(conn);
        conn.pendingRequests ??= new Map();
        conn.pendingRequests.set(id, { resolve, reject });

        conn.process.stdin.write(
            JSON.stringify({
                jsonrpc: "2.0",
                id,
                method,
                params: params ?? {},
            }) + "\n"
        );

        setTimeout(() => {
            if (conn.pendingRequests?.has(id)) {
                conn.pendingRequests.delete(id);
                reject(new Error(`MCP call "${method}" timed out after 30s`));
            }
        }, 30_000);
    });
}

function sendJsonRpcStdioNotification(conn: McpConnection, method: string, params?: unknown): void {
    if (!conn.process?.stdin?.writable) {
        throw new Error(`MCP Server "${conn.config.name}" is not running`);
    }
    conn.process.stdin.write(
        JSON.stringify({
            jsonrpc: "2.0",
            method,
            ...(params !== undefined ? { params } : {}),
        }) + "\n"
    );
}

function setupStdoutHandler(conn: McpConnection): void {
    if (!conn.process?.stdout) return;
    conn.outputBuffer = "";

    conn.process.stdout.on("data", (data: Buffer) => {
        conn.outputBuffer = (conn.outputBuffer ?? "") + data.toString();
        const lines = conn.outputBuffer.split("\n");
        conn.outputBuffer = lines.pop() ?? "";

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line) as JsonRpcMessage;
                if (typeof msg.id === "number" && conn.pendingRequests?.has(msg.id)) {
                    const pending = conn.pendingRequests.get(msg.id)!;
                    conn.pendingRequests.delete(msg.id);
                    if (msg.error) {
                        pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
                    } else {
                        pending.resolve(msg.result);
                    }
                }
            } catch {
                // 非 JSON 行忽略
            }
        }
    });
}

// ─── Streamable HTTP ───

function buildHttpHeaders(
    conn: McpConnection,
    options?: { includeContentType?: boolean; skipSessionId?: boolean; accept?: string }
): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: options?.accept ?? HTTP_ACCEPT,
    };
    // config.headers 的值支持 `${VAR}` 环境变量插值（如 Authorization: "Bearer ${ZAI_API_KEY}"）。
    // 放在 Accept 之后写入，保留"配置项可覆盖 Accept"的原有语义。
    for (const [key, value] of Object.entries(conn.config.headers ?? {})) {
        headers[key] = interpolateEnv(value);
    }
    if (options?.includeContentType !== false) {
        headers["Content-Type"] = "application/json";
    }
    if (!options?.skipSessionId && conn.sessionId) {
        headers["Mcp-Session-Id"] = conn.sessionId;
    }
    return headers;
}

async function buildHttpError(response: Response): Promise<Error> {
    let details = "";
    try {
        details = (await response.text()).trim();
    } catch {
        details = "";
    }
    return buildHttpErrorFromBody(response, details);
}

/** 与 buildHttpError 相同，但复用已读取的 body 文本（Response body 只能读一次）。 */
function buildHttpErrorFromBody(response: Response, body: string): Error {
    const details = body.trim();
    return new Error(`HTTP ${response.status} ${response.statusText}${details ? `: ${details}` : ""}`);
}

/**
 * 判断 401 响应体属于「会话失效」还是「鉴权失败」。
 * 部分网关（如 ModelScope 推理端点）会话过期返回 401 + {"Code":"SessionExpired"} 而不是 404 ——
 * 这种情况重新 initialize 拿新会话即可恢复；token 错误的 401 响应体里不含 session 字样，
 * 换会话没用，必须原样抛给调用方，否则会变成无意义的重试循环。
 */
function isSessionExpiredBody(body: string): boolean {
    return /session/i.test(body) && /expired|invalid|not\s+found|unknown|missing/i.test(body);
}

/**
 * 会话丢失统一判定（请求与通知两条路径共用）。
 *
 * - 主判定是 404：MCP Streamable HTTP 规范明确服务端以 404 表示会话过期/终止，
 *   厂商无关、确定性判定 —— 状态码 + 会话能力守卫即可，无需读响应体。
 * - 401 是从属的非标准信号：401 状态码无法区分鉴权失败与会话过期，
 *   必须 body 嗅探佐证（见 isSessionExpiredBody）；措辞不含会话失效含义的 401
 *   是真鉴权失败，原样抛出，不能靠重开会话硬扛。
 * - 守卫：仅当连接具备会话能力（已有会话，或有在途恢复）时才可能发生会话丢失。
 *   无会话服务器的 404/401 与会话无关，恢复必然无效，直接交回上层报错；
 *   `|| conn.sessionRecovery` 覆盖恢复窗口内的并发请求 —— 此时 sessionId 已被清空，
 *   但应加入在途共享恢复而不是误判为不可恢复。
 */
async function shouldRecoverSession(
    conn: McpConnection,
    response: Response,
    options?: { skipSessionId?: boolean; retryOnSessionReset?: boolean }
): Promise<boolean> {
    if (options?.skipSessionId === true || options?.retryOnSessionReset === false) return false;
    if (!conn.sessionId && !conn.sessionRecovery) return false;
    if (response.status === 404) return true;
    if (response.status === 401) {
        const body = await response.text().catch(() => "");
        if (!isSessionExpiredBody(body)) {
            throw buildHttpErrorFromBody(response, body);
        }
        return true;
    }
    return false;
}

function extractJsonRpcResult(payload: unknown, expectedId: number): { found: boolean; value?: unknown } {
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        const rpc = message as JsonRpcMessage;
        if (rpc.id !== expectedId) continue;
        if (rpc.error) {
            throw new Error(rpc.error.message ?? JSON.stringify(rpc.error));
        }
        return { found: true, value: rpc.result };
    }
    return { found: false };
}

async function parseSseStream(response: Response, onEvent: (event: ParsedSseEvent) => void): Promise<void> {
    if (!response.body) {
        throw new Error("SSE response body is empty");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let eventId: string | undefined;
    let dataLines: string[] = [];

    const flushEvent = () => {
        if (dataLines.length === 0 && !eventId) {
            eventName = "message";
            eventId = undefined;
            return;
        }
        onEvent({
            event: eventName,
            data: dataLines.join("\n"),
            id: eventId,
        });
        eventName = "message";
        eventId = undefined;
        dataLines = [];
    };

    while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        let lineBreakIndex = buffer.search(/\r?\n/);
        while (lineBreakIndex >= 0) {
            const rawLine = buffer.slice(0, lineBreakIndex);
            const delimiterLength = buffer[lineBreakIndex] === "\r" && buffer[lineBreakIndex + 1] === "\n" ? 2 : 1;
            buffer = buffer.slice(lineBreakIndex + delimiterLength);

            if (rawLine === "") {
                flushEvent();
            } else if (!rawLine.startsWith(":")) {
                const colonIndex = rawLine.indexOf(":");
                const field = colonIndex >= 0 ? rawLine.slice(0, colonIndex) : rawLine;
                const rawValue = colonIndex >= 0 ? rawLine.slice(colonIndex + 1) : "";
                const fieldValue = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

                if (field === "event") eventName = fieldValue || "message";
                if (field === "data") dataLines.push(fieldValue);
                if (field === "id") eventId = fieldValue;
            }

            lineBreakIndex = buffer.search(/\r?\n/);
        }

        if (done) {
            if (buffer.length > 0) {
                if (buffer.startsWith("data:")) {
                    dataLines.push(buffer.slice(5).trimStart());
                }
                buffer = "";
            }
            flushEvent();
            return;
        }
    }
}

async function extractHttpResponseResult(conn: McpConnection, response: Response, expectedId: number): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    const maybeSessionId = response.headers.get("Mcp-Session-Id");
    if (maybeSessionId) conn.sessionId = maybeSessionId;

    if (contentType.includes(SSE_CONTENT_TYPE)) {
        let matched = false;
        let matchedValue: unknown;

        await parseSseStream(response, (event) => {
            if (event.id) conn.lastEventId = event.id;
            if (!event.data) return;
            try {
                const parsed = JSON.parse(event.data);
                const result = extractJsonRpcResult(parsed, expectedId);
                if (result.found) {
                    matched = true;
                    matchedValue = result.value;
                }
            } catch {
                // 忽略非 JSON 事件，例如兼容模式 endpoint event
            }
        });

        if (!matched) {
            throw new Error(`MCP Server "${conn.config.name}" 未在 SSE 流中返回请求 ${expectedId} 的响应`);
        }
        return matchedValue;
    }

    const text = await response.text();
    if (!text.trim()) {
        throw new Error(`MCP Server "${conn.config.name}" 返回了空响应`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`MCP Server "${conn.config.name}" 返回了非 JSON 响应: ${text}`);
    }

    const result = extractJsonRpcResult(parsed, expectedId);
    if (!result.found) {
        throw new Error(`MCP Server "${conn.config.name}" 返回中缺少请求 ${expectedId} 的响应`);
    }
    return result.value;
}

/** 解析 streamable-http 目标 URL，支持 `${VAR}` 环境变量插值。 */
function resolveHttpUrl(conn: McpConnection): string {
    return interpolateEnv(conn.config.url!);
}

async function postHttpMessage(conn: McpConnection, payload: JsonRpcMessage, options?: { skipSessionId?: boolean }): Promise<Response> {
    return fetch(resolveHttpUrl(conn), {
        method: "POST",
        headers: buildHttpHeaders(conn, { skipSessionId: options?.skipSessionId }),
        body: JSON.stringify(payload),
    });
}

async function sendJsonRpcHttpRequest(
    conn: McpConnection,
    method: string,
    params?: unknown,
    options?: { skipSessionId?: boolean; retryOnSessionReset?: boolean }
): Promise<unknown> {
    const id = nextRequestId(conn);
    const response = await postHttpMessage(
        conn,
        {
            jsonrpc: "2.0",
            id,
            method,
            params: params ?? {},
        },
        { skipSessionId: options?.skipSessionId }
    );

    if (await shouldRecoverSession(conn, response, options)) {
        await recoverHttpSession(conn);
        return sendJsonRpcHttpRequest(conn, method, params, { retryOnSessionReset: false });
    }

    if (!response.ok) {
        throw await buildHttpError(response);
    }

    return extractHttpResponseResult(conn, response, id);
}

async function sendJsonRpcHttpNotification(
    conn: McpConnection,
    method: string,
    params?: unknown,
    options?: { skipSessionId?: boolean; retryOnSessionReset?: boolean }
): Promise<void> {
    const response = await postHttpMessage(
        conn,
        {
            jsonrpc: "2.0",
            method,
            ...(params !== undefined ? { params } : {}),
        },
        { skipSessionId: options?.skipSessionId }
    );

    if (await shouldRecoverSession(conn, response, options)) {
        await recoverHttpSession(conn);
        await sendJsonRpcHttpNotification(conn, method, params, { retryOnSessionReset: false });
        return;
    }

    if (response.status === 202 || response.status === 204) return;
    if (!response.ok) {
        throw await buildHttpError(response);
    }
    await response.text().catch(() => {});
}

/**
 * 重建会话：清掉旧 sessionId 并重新 initialize。
 *
 * 并发场景下多个请求可能同时撞上会话过期 —— 若各自独立 re-initialize，
 * 服务端通常只保留最新会话，后完成的一方会把先完成一方刚拿到的新会话作废，
 * 导致那次重试再次 401。因此共享同一个在途恢复，让并发请求一起等同一个新会话。
 */
function recoverHttpSession(conn: McpConnection): Promise<void> {
    if (!conn.sessionRecovery) {
        conn.sessionRecovery = (async () => {
            conn.sessionId = undefined;
            await initializeHttpConnection(conn);
        })().finally(() => {
            conn.sessionRecovery = undefined;
        });
    }
    return conn.sessionRecovery;
}

async function initializeHttpConnection(conn: McpConnection): Promise<void> {
    conn.sessionId = undefined;
    const initializeResult = await sendJsonRpcHttpRequest(conn, "initialize", initializeParams(), {
        skipSessionId: true,
        retryOnSessionReset: false,
    });
    if (!initializeResult || typeof initializeResult !== "object") {
        throw new Error(`MCP Server "${conn.config.name}" initialize 返回了无效结果`);
    }
    // retryOnSessionReset: false —— 重初始化过程中若再遇到会话失效必须直接失败，
    // 否则「initialize → 通知 401 → 再 initialize」会形成无界循环。
    await sendJsonRpcHttpNotification(conn, "notifications/initialized", undefined, {
        retryOnSessionReset: false,
    });
}

async function closeHttpConnection(conn: McpConnection): Promise<void> {
    if (!conn.sessionId) return;
    try {
        const response = await fetch(resolveHttpUrl(conn), {
            method: "DELETE",
            headers: buildHttpHeaders(conn, { includeContentType: false, accept: "application/json" }),
        });
        if (!response.ok && response.status !== 404 && response.status !== 405) {
            throw await buildHttpError(response);
        }
    } finally {
        conn.sessionId = undefined;
    }
}

// ─── transport 抽象 ───

async function sendJsonRpc(conn: McpConnection, method: string, params?: unknown): Promise<unknown> {
    if (conn.transportKind === "streamable-http") {
        return sendJsonRpcHttpRequest(conn, method, params);
    }
    return sendJsonRpcStdioRequest(conn, method, params);
}

async function sendJsonRpcNotification(conn: McpConnection, method: string, params?: unknown): Promise<void> {
    if (conn.transportKind === "streamable-http") {
        await sendJsonRpcHttpNotification(conn, method, params);
        return;
    }
    sendJsonRpcStdioNotification(conn, method, params);
}

async function initializeConnection(conn: McpConnection): Promise<void> {
    if (conn.transportKind === "streamable-http") {
        await initializeHttpConnection(conn);
        return;
    }

    await sendJsonRpc(conn, "initialize", initializeParams());
    await sendJsonRpcNotification(conn, "notifications/initialized");
}

// ─── 核心功能 ───

async function connectServer(config: McpServerConfig): Promise<McpConnection> {
    if (connections.has(config.name)) {
        // 同名重连：只关活连接，不动期望配置（失败也不能丢配置）。
        await closeLiveConnection(config.name);
    }

    const conn = createConnection(config);

    if (conn.transportKind === "stdio") {
        const env: Record<string, string> = { ...(process.env as Record<string, string>) };
        // command / args / env 的值同样支持 `${VAR}` 环境变量插值。
        if (config.env) {
            for (const [key, value] of Object.entries(config.env)) env[key] = interpolateEnv(value);
        }

        const child = spawn(interpolateEnv(config.command!), (config.args ?? []).map(interpolateEnv), {
            stdio: ["pipe", "pipe", "pipe"],
            env,
        });

        conn.process = child;
        setupStdoutHandler(conn);

        child.on("exit", (code) => {
            process.stderr.write(`[mcp-bridge] MCP Server "${config.name}" exited (code ${code})\n`);
            conn.process = undefined;
        });

        child.stderr?.on("data", (data: Buffer) => {
            process.stderr.write(`[mcp:${config.name}] ${data.toString()}`);
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        if (child.exitCode !== null) {
            throw new Error(`MCP Server "${config.name}" failed to start (exit code ${child.exitCode})`);
        }
    }

    try {
        await initializeConnection(conn);
    } catch (err) {
        if (conn.process) conn.process.kill();
        throw new Error(`MCP initialize failed for "${config.name}": ${err}`);
    }

    try {
        const result = (await sendJsonRpc(conn, "tools/list", {})) as { tools?: McpToolSchema[] };
        conn.tools = result?.tools ?? [];
    } catch (err) {
        process.stderr.write(`[mcp-bridge] tools/list failed for "${config.name}": ${err}\n`);
        conn.tools = [];
    }

    connections.set(config.name, conn);
    onRegistryChange?.();

    return conn;
}

/** 仅关闭活连接（不触碰期望配置，不落盘）。 */
async function closeLiveConnection(name: string): Promise<void> {
    const conn = connections.get(name);
    if (!conn) return;

    if (conn.transportKind === "streamable-http") {
        await closeHttpConnection(conn).catch((err) => {
            process.stderr.write(`[mcp-bridge] Streamable HTTP 关闭失败 "${name}": ${err}\n`);
        });
    }

    if (conn.process) {
        conn.process.kill();
        conn.process = undefined;
    }

    if (conn.pendingRequests) {
        for (const [, pending] of conn.pendingRequests) {
            pending.reject(new Error("MCP Server disconnected"));
        }
        conn.pendingRequests.clear();
    }

    connections.delete(name);
    onRegistryChange?.();
}

/** 用户显式卸载：关闭连接并从期望配置中移除（移除会落盘）。 */
async function disconnectServer(name: string): Promise<void> {
    desiredConfigs.delete(name);
    saveConnectionConfigs();
    await closeLiveConnection(name);
}

async function callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = connections.get(serverName);
    if (!conn) throw new Error(`MCP Server "${serverName}" is not connected`);
    if (conn.transportKind === "stdio" && !conn.process) {
        throw new Error(`MCP Server "${serverName}" process is not running`);
    }

    const result = (await sendJsonRpc(conn, "tools/call", {
        name: toolName,
        arguments: args,
    })) as { content?: Array<{ type: string; text?: string }> };

    if (result?.content) {
        const texts = result.content
            .filter((content) => content.type === "text" && content.text)
            .map((content) => content.text);
        return texts.length === 1 ? texts[0] : texts.length > 1 ? texts.join("\n") : result;
    }
    return result;
}

// ─── 动态注入 Module Registry ───

export function getMcpModuleEntries(): ModuleEntry[] {
    const entries: ModuleEntry[] = [];

    for (const [name, conn] of connections) {
        if (conn.tools.length === 0) continue;

        const methods: MethodDoc[] = conn.tools.map((tool) => ({
            name: tool.name,
            brief: tool.description ?? tool.name,
            fullDoc: tool.inputSchema
                ? `/**\n * ${tool.description ?? tool.name}\n * @param args ${JSON.stringify(tool.inputSchema, null, 2)}\n */\n${tool.name}(args: ${formatSchemaAsType(tool.inputSchema)}): Promise<unknown>`
                : `/** ${tool.description ?? tool.name} */\n${tool.name}(args: Record<string, unknown>): Promise<unknown>`,
        }));

        entries.push({
            name,
            description: `MCP Server (${conn.tools.length} tools)` +
                (conn.transportKind === "streamable-http" ? " via Streamable HTTP" : " via stdio") +
                (conn.config.description?.trim() ? ` - ${conn.config.description.trim()}` : ""),
            methods,
        });
    }

    return entries;
}

function formatSchemaAsType(schema: Record<string, unknown>): string {
    if (!schema || schema.type !== "object" || !schema.properties) {
        return "Record<string, unknown>";
    }

    const props = schema.properties as Record<string, { type?: string; description?: string }>;
    const required = new Set((schema.required as string[]) ?? []);
    const lines: string[] = ["{"];

    for (const [key, prop] of Object.entries(props)) {
        const opt = required.has(key) ? "" : "?";
        const tsType = prop.type === "string"
            ? "string"
            : prop.type === "number" || prop.type === "integer"
                ? "number"
                : prop.type === "boolean"
                    ? "boolean"
                    : prop.type === "array"
                        ? "unknown[]"
                        : "unknown";
        const comment = prop.description ? ` /** ${prop.description} */` : "";
        lines.push(`  ${comment}`);
        lines.push(`  ${key}${opt}: ${tsType};`);
    }

    lines.push("}");
    return lines.join("\n");
}

// ─── 公共 API（暴露给 LLM） ───

export const mcpBridge = {
    connect: async (config: McpServerConfig) => {
        if (proxyCallbacks) {
            const connected = await proxyCallbacks.callHost("mcp.connect", [config]) as {
                name: string;
                tools: Array<{ name: string; description: string }>;
            };
            const latest = await proxyCallbacks.callHost("mcp.list", []) as McpServerInfo[];
            cachedServerList = cloneServerList(latest ?? []);
            return {
                name: connected.name,
                tools: connected.tools ?? [],
                call: (toolName: string, args: Record<string, unknown> = {}) =>
                    proxyCallbacks!.callHost("mcp.call", [connected.name, toolName, args]),
            };
        }
        validateConfig(config);
        // 期望配置先落盘（意图优先）：即使本次连接失败，配置也保留并会在下次启动重连，
        // 不会因为一次网络抖动 / 服务未就绪就被从 config 里删掉。
        desiredConfigs.set(config.name, config);
        saveConnectionConfigs();
        const conn = await connectServer(config);
        return {
            name: conn.config.name,
            tools: conn.tools.map((tool) => ({
                name: tool.name,
                description: tool.description ?? "",
            })),
            call: (toolName: string, args: Record<string, unknown> = {}) =>
                callTool(conn.config.name, toolName, args),
        };
    },

    disconnect: async (name: string) => {
        if (proxyCallbacks) {
            await proxyCallbacks.callHost("mcp.disconnect", [name]);
            const latest = await proxyCallbacks.callHost("mcp.list", []) as McpServerInfo[];
            cachedServerList = cloneServerList(latest ?? []);
            return;
        }
        await disconnectServer(name);
    },

    list: () => proxyCallbacks ? cloneServerList(cachedServerList) : listConnectionsLocal(),

    call: (serverName: string, toolName: string, args: Record<string, unknown> = {}) => {
        if (proxyCallbacks) {
            return proxyCallbacks.callHost("mcp.call", [serverName, toolName, args]);
        }
        return callTool(serverName, toolName, args);
    },
};

// ─── 初始化 ───

export function initMcpBridge(options: {
    persistPath: string;
    onRegistryChange?: () => void;
}): void {
    persistPath = options.persistPath;
    onRegistryChange = options.onRegistryChange ?? null;
    // 重新初始化视为全新运行时（进程启动 / 测试重置）：清空内存态，配置以 persistPath 文件为准。
    connections.clear();
    desiredConfigs.clear();
}

export function setMcpProxyCallbacks(callbacks: McpProxyCallbacks | null): void {
    proxyCallbacks = callbacks;
}

export function setMcpListSnapshot(servers: McpServerInfo[]): void {
    cachedServerList = cloneServerList(servers);
}

export function getConnectionConfigs(): McpServerConfig[] {
    // 导出期望配置（含连接失败的），与持久化文件保持一致——dashboard JSON 编辑以此为准。
    return Array.from(desiredConfigs.values()).map((config) => ({
        name: config.name,
        ...(config.description ? { description: config.description } : {}),
        ...(config.transport ? { transport: config.transport } : {}),
        ...(config.command ? { command: config.command } : {}),
        ...(config.args ? { args: [...config.args] } : {}),
        ...(config.env ? { env: { ...config.env } } : {}),
        ...(config.url ? { url: config.url } : {}),
        ...(config.headers ? { headers: { ...config.headers } } : {}),
    }));
}

export async function replaceConnectionConfigs(configs: McpServerConfig[]): Promise<void> {
    // 期望配置先落盘（意图优先）：单个 server 连接失败不能连累其他配置被删。
    desiredConfigs.clear();
    for (const config of configs) {
        if (!config?.name?.trim()) continue;
        desiredConfigs.set(config.name, config);
    }
    saveConnectionConfigs();

    // 关闭不再包含在期望配置里的活连接（仍保留的会在下面按新配置重连）。
    for (const name of Array.from(connections.keys())) {
        if (!desiredConfigs.has(name)) await closeLiveConnection(name);
    }

    // 逐个连接：单个失败只记日志，不抛错、不影响其他 server。
    for (const config of desiredConfigs.values()) {
        try {
            await connectServer(config);
        } catch (err) {
            process.stderr.write(`[mcp-bridge] ❌ 连接 "${config.name}" 失败: ${err}\n`);
        }
    }
}

export async function autoReconnect(): Promise<void> {
    const configs = loadPersistedConnections();
    for (const config of configs) {
        if (!config?.name?.trim()) continue; // 损坏条目（无 name）跳过
        // 先把文件里的配置登记为期望配置：重连失败时它仍是期望配置，不会被后续落盘清掉。
        desiredConfigs.set(config.name, config);
        try {
            await connectServer(config);
            process.stderr.write(`[mcp-bridge] ✅ 重连 "${config.name}" 成功\n`);
        } catch (err) {
            // 只记日志：失败的配置保留在期望配置中，下次启动继续重试，绝不从持久化文件里删除。
            process.stderr.write(`[mcp-bridge] ❌ 重连 "${config.name}" 失败: ${err}\n`);
        }
    }
}

export async function disconnectAll(): Promise<void> {
    for (const name of Array.from(connections.keys())) {
        await disconnectServer(name);
    }
}
