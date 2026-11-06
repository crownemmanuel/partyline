// REST (PROTOCOL §2). The web client always talks to its own origin: browsers load it from
// the host, and the desktop app loads it from its loopback host/proxy.
import type { ErrorCode, InfoResponse, JoinRequest, JoinResponse, Message, SessionResponse } from "@partyline/protocol";

export const APP_VERSION = "0.1.0";

export class ApiError extends Error {
  constructor(public status: number, public code: ErrorCode | "network", message: string, public retryAfter?: number) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
      cache: "no-store",
    });
  } catch (e) {
    throw new ApiError(0, "network", "Cannot reach the server");
  }
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const ra = Number(r.headers.get("retry-after") ?? "") || undefined;
    throw new ApiError(r.status, body?.error?.code ?? "bad_request", body?.error?.message ?? `HTTP ${r.status}`, ra);
  }
  return body as T;
}

export const getInfo = () => call<InfoResponse & { localHost?: boolean }>("/api/info");
export const join = (req: Omit<JoinRequest, "appVersion" | "apiVersion">) =>
  call<JoinResponse>("/api/join", { method: "POST", body: JSON.stringify({ ...req, appVersion: APP_VERSION, apiVersion: 1 }) });
export const session = (token: string) =>
  call<SessionResponse>("/api/session", { method: "POST", body: JSON.stringify({ appVersion: APP_VERSION, apiVersion: 1 }) }, token);
export const messages = (token: string, since?: string) =>
  call<Message[]>(`/api/messages?limit=100${since ? `&since=${encodeURIComponent(since)}` : ""}`, {}, token);

export function wsUrl(path: string) {
  const u = new URL(path, location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}
