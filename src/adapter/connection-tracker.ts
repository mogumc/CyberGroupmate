/**
 * connection-tracker.ts — 平台连接状态追踪
 *
 * 三个 adapter（telegram / discord / onebot）共用的状态记录，
 * 供 dashboard 展示和手动重连使用。只记录状态，不参与实际连接逻辑。
 */

import type { AdapterConnectionState, AdapterConnectionStatus } from "./platform-adapter.js";

export class ConnectionTracker {
    private state: AdapterConnectionState = "stopped";
    private since = new Date().toISOString();
    private attempts = 0;
    private nextRetryAt: string | null = null;
    private lastConnectedAt: string | null = null;
    private lastError: string | undefined;
    private detail: string | undefined;
    private qrCodeUrl: string | undefined;

    constructor(private readonly platform: string) {}

    /** 已连接成功：清空重连计数与错误 */
    markConnected(detail?: string): void {
        this.attempts = 0;
        this.nextRetryAt = null;
        this.lastError = undefined;
        this.lastConnectedAt = new Date().toISOString();
        if (detail !== undefined) this.detail = detail;
        this.transition("connected");
    }

    /** 正在建连 / 重连 */
    markConnecting(detail?: string): void {
        this.nextRetryAt = null;
        if (detail !== undefined) this.detail = detail;
        this.transition("connecting");
    }

    /** 已断开，等待自动重连 */
    markDisconnected(error?: string): void {
        if (error) this.lastError = error;
        this.transition("disconnected");
    }

    /** 连接失败且没有后续重连计划 */
    markError(error: string): void {
        this.lastError = error;
        this.nextRetryAt = null;
        this.transition("error");
    }

    /** 主动停止 */
    markStopped(): void {
        this.nextRetryAt = null;
        this.transition("stopped");
    }

    /** 记录一次已安排的自动重连 */
    markRetryScheduled(attempt: number, delayMs: number): void {
        this.attempts = attempt;
        this.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        this.transition("disconnected");
    }

    /** 手动重连时重置退避计数 */
    resetAttempts(): void {
        this.attempts = 0;
        this.nextRetryAt = null;
    }

    setDetail(detail: string): void {
        this.detail = detail;
    }

    /** 设置/清除待扫码二维码（Data URL）。扫码登录平台在等待扫码时设置，登录成功后清除。 */
    setQrCodeUrl(url?: string): void {
        this.qrCodeUrl = url;
    }

    /** 记录错误但不改变连接状态（如库内部可自恢复的错误） */
    noteError(error: string): void {
        this.lastError = error;
    }

    get currentState(): AdapterConnectionState {
        return this.state;
    }

    snapshot(): AdapterConnectionStatus {
        return {
            platform: this.platform,
            state: this.state,
            detail: this.detail,
            since: this.since,
            reconnectAttempts: this.attempts,
            nextRetryAt: this.nextRetryAt,
            lastConnectedAt: this.lastConnectedAt,
            lastError: this.lastError,
            qrCodeUrl: this.qrCodeUrl,
        };
    }

    private transition(state: AdapterConnectionState): void {
        if (this.state === state) return;
        this.state = state;
        this.since = new Date().toISOString();
    }
}
