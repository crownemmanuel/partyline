// Control WebSocket (PROTOCOL §3): auth, ping/pong, ack/error by id, reconnect with backoff.
import type { ClientPayloads, ClientType, ServerMessage } from "@partyline/protocol";
import { APP_VERSION, wsUrl } from "./api";

export type ControlStatus = "connecting" | "open" | "reconnecting" | "closed";
const BACKOFF = [1000, 2000, 4000, 8000, 15000];

export interface ControlHandlers {
  onMessage(m: ServerMessage): void;
  onStatus(s: ControlStatus, detail?: string): void;
  /** auth rejected (invalid_token / revoked) or kicked: do not reconnect */
  onFatal(code: string): void;
}

export class Control {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private seq = 0;
  private pending = new Map<string, { res: () => void; rej: (e: Error & { code?: string }) => void; t: number }>();
  private pingTimer = 0;
  private lastPong = 0;
  private retryTimer = 0;
  private stopped = false;
  private authed = false;

  constructor(private token: string, private h: ControlHandlers) {}

  start() {
    this.stopped = false;
    this.open();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close(1000, "leave");
    this.ws = null;
    this.h.onStatus("closed");
  }
  get isOpen() {
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Fire and forget, or await ack when `wantAck`. */
  send<T extends ClientType>(type: T, payload: ClientPayloads[T], wantAck = false): Promise<void> {
    const id = wantAck ? `c-${++this.seq}` : undefined;
    const msg = JSON.stringify({ type, ...(id ? { id } : {}), ts: new Date().toISOString(), payload });
    if (!this.isOpen) return wantAck ? Promise.reject(Object.assign(new Error("Not connected"), { code: "offline" })) : Promise.resolve();
    this.ws!.send(msg);
    if (!id) return Promise.resolve();
    return new Promise((res, rej) => {
      const t = window.setTimeout(() => {
        this.pending.delete(id);
        rej(Object.assign(new Error("No reply from server"), { code: "timeout" }));
      }, 5000);
      this.pending.set(id, { res, rej, t });
    });
  }

  private open() {
    clearTimeout(this.retryTimer);
    this.authed = false;
    this.h.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(wsUrl("/api/ws"));
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", payload: { deviceToken: this.token, appVersion: APP_VERSION } }));
    };
    ws.onmessage = (ev) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.lastPong = Date.now();
      if (m.type === "welcome") {
        this.authed = true;
        this.attempt = 0;
        this.h.onStatus("open");
        this.startPing();
      } else if (m.type === "ack") {
        const p = this.pending.get(m.payload.replyTo);
        if (p) clearTimeout(p.t), this.pending.delete(m.payload.replyTo), p.res();
        return;
      } else if (m.type === "error") {
        const id = m.payload.replyTo;
        const p = id ? this.pending.get(id) : undefined;
        if (p) {
          clearTimeout(p.t);
          this.pending.delete(id!);
          p.rej(Object.assign(new Error(m.payload.message), { code: m.payload.code }));
          return;
        }
        if (!this.authed && (m.payload.code === "invalid_token" || m.payload.code === "revoked")) {
          this.stopped = true;
          this.h.onFatal(m.payload.code);
          return;
        }
      } else if (m.type === "kicked") {
        this.stopped = true;
        this.h.onMessage(m);
        this.h.onFatal("kicked");
        return;
      } else if (m.type === "server.shutdown") {
        this.h.onMessage(m);
        this.attempt = 0;
        ws.onclose = null;
        ws.close();
        this.scheduleRetry(m.payload.reconnectAfterMs);
        return;
      }
      this.h.onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      for (const [, p] of this.pending) clearTimeout(p.t), p.rej(Object.assign(new Error("Disconnected"), { code: "offline" }));
      this.pending.clear();
      this.authed = false;
      if (this.ws !== ws) return;
      this.scheduleRetry();
    };
  }

  private scheduleRetry(ms?: number) {
    if (this.stopped) return;
    const delay = ms ?? BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt++;
    this.h.onStatus("reconnecting", `retry in ${Math.round(delay / 1000)} s`);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  private startPing() {
    clearInterval(this.pingTimer);
    this.lastPong = Date.now();
    this.pingTimer = window.setInterval(() => {
      if (Date.now() - this.lastPong > 30_000) {
        this.ws?.close();
        return;
      }
      this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: "ping", payload: {} }));
    }, 15_000);
  }

  /** Reconnect now (e.g. network came back / page visible again). */
  kick() {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) this.open();
  }
}
