/**
 * exporter.ts — Prometheus Metrics HTTP Server
 *
 * 使用 node:http 创建轻量级 HTTP 端点（无 Express 依赖），
 * 默认仅绑定 127.0.0.1 以防止数据意外暴露到公网。
 *
 * 端点：
 *   GET /metrics  → Prometheus 文本格式（application/openmetrics-text）
 *   GET /healthz  → 200 OK（liveness probe）
 *   其他          → 404
 */

import { createServer, type Server } from "node:http";
import { registry } from "./registry.js";
import type { GroupCollector } from "./collectors/group-collector.js";
import type { SystemCollector } from "./collectors/system-collector.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("metrics:exporter");

export interface MetricsExporterConfig {
    /**
     * 绑定地址。
     * ⚠️ 默认且强烈推荐保持 "127.0.0.1"（仅本机可访问）。
     * 若需要远端 Prometheus 抓取，请使用反向代理并加 IP allowlist。
     */
    host?: string;
    /** HTTP 监听端口，默认 9091 */
    port?: number;
    /** scrape 路径，默认 "/metrics" */
    path?: string;
}

export class MetricsExporter {
    private server: Server;
    private config: Required<MetricsExporterConfig>;
    private groupCollector: GroupCollector;
    private systemCollector: SystemCollector;

    constructor(
        groupCollector: GroupCollector,
        systemCollector: SystemCollector,
        config: MetricsExporterConfig = {},
    ) {
        this.groupCollector = groupCollector;
        this.systemCollector = systemCollector;
        this.config = {
            host: config.host ?? "127.0.0.1",
            port: config.port ?? 9091,
            path: config.path ?? "/metrics",
        };

        this.server = createServer((req, res) => {
            const url = req.url ?? "/";
            // Normalize: strip query string
            const pathname = url.split("?")[0];

            if (pathname === this.config.path) {
                this.handleMetrics(res);
            } else if (pathname === "/healthz") {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("OK\n");
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("404 Not Found\n");
            }
        });

        this.server.on("error", (err) => {
            log.error("Metrics HTTP 服务器错误", { error: String(err) });
        });
    }

    private handleMetrics(res: import("node:http").ServerResponse): void {
        try {
            // Pull-mode: collect fresh data before rendering
            this.groupCollector.collect();
            this.systemCollector.collect();

            const body = registry.render();
            res.writeHead(200, {
                // OpenMetrics / Prometheus compatible content type
                "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
            });
            res.end(body);
        } catch (err) {
            log.error("Metrics scrape 失败", { error: String(err) });
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`500 Internal Server Error: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }

    /**
     * 实际监听的端口。
     * 配置 port=0 时由系统分配端口，只有 start() 之后读这个才能拿到真实值。
     */
    get boundPort(): number {
        const address = this.server.address();
        return address && typeof address === "object" ? address.port : this.config.port;
    }

    /** 启动 HTTP server */
    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server.listen(this.config.port, this.config.host, () => {
                const port = this.boundPort;
                log.info(`Metrics exporter 已启动`, {
                    url: `http://${this.config.host}:${port}${this.config.path}`,
                    binding: `${this.config.host}:${port}`,
                    note: this.config.host === "127.0.0.1"
                        ? "仅本机可访问（localhost-only）"
                        : `⚠️ 绑定到 ${this.config.host}，请确认网络安全策略`,
                });
                resolve();
            });
            this.server.once("error", reject);
        });
    }

    /** 关闭 HTTP server */
    stop(): void {
        this.server.close((err) => {
            if (err) {
                log.warn("Metrics exporter 关闭时出错", { error: String(err) });
            } else {
                log.info("Metrics exporter 已关闭");
            }
        });
    }

    getConfig(): Readonly<Required<MetricsExporterConfig>> {
        return this.config;
    }
}
