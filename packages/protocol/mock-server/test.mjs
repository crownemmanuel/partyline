// End-to-end protocol test against a running server (mock or real Tauri host).
// Usage: node test.mjs [baseUrl] [joinCode]     default https://127.0.0.1:8443 483920
// Starts its own mock on :18443 if no baseUrl is given.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
let base = process.argv[2];
let code = process.argv[3] ?? "483920";
let child;
if (!base) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plmock-"));
  child = spawn(process.execPath, ["server.mjs", "--port=18443", `--data=${dir}`, "--no-mdns", "--local-admin=false", "--code=483920"], { stdio: "inherit", cwd: path.dirname(new URL(import.meta.url).pathname) });
  base = "https://127.0.0.1:18443";
  await new Promise((r) => setTimeout(r, 600));
}
const promote = process.env.PROMOTE_URL ?? (child ? base : null);
let failures = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) failures++;
};
const api = async (p, opts = {}) => {
  const r = await fetch(base + p, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};
const ADMIN_BASE = process.env.ADMIN_BASE; // real host: admin joins via its loopback listener, no code
const join = (deviceId, displayName, joinCode = code, platform = "web", b = base) => fetch(b + "/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ joinCode, deviceId, displayName, platform, appVersion: "0.1.0", apiVersion: 1 }) }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
const _unusedJoin = (deviceId, displayName, joinCode = code, platform = "web") => api("/api/join", { method: "POST", body: JSON.stringify({ joinCode, deviceId, displayName, platform, appVersion: "0.1.0", apiVersion: 1 }) });

class Client {
  constructor(token) {
    this.inbox = [];
    this.waiters = [];
    this.ws = new WebSocket(base.replace("https", "wss") + "/api/ws");
    this.open = new Promise((r) => this.ws.on("open", r));
    this.ws.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      this.inbox.push(msg);
      this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.res(msg), false) : true));
    });
    this.closed = new Promise((r) => this.ws.on("close", (c) => r(c)));
    this.token = token;
  }
  send(type, payload = {}, id) {
    this.ws.send(JSON.stringify({ type, ...(id ? { id } : {}), payload }));
  }
  wait(pred, ms = 2000) {
    const hit = this.inbox.find(pred);
    if (hit) {
      this.inbox.splice(this.inbox.indexOf(hit), 1);
      return Promise.resolve(hit);
    }
    return new Promise((res, rej) => {
      const w = { pred, res: (m) => (this.inbox.splice(this.inbox.indexOf(m), 1), res(m)) };
      this.waiters.push(w);
      setTimeout(() => rej(new Error("timeout waiting")), ms);
    });
  }
  async auth() {
    await this.open;
    this.send("auth", { deviceToken: this.token, appVersion: "0.1.0" });
    return this.wait((m) => m.type === "welcome");
  }
}

try {
  const info = await api("/api/info");
  ok(info.status === 200 && info.body.apiVersion === 1 && /^[0-9a-f]{64}$/.test(info.body.fingerprint), "GET /api/info");
  ok((await fetch(base + "/healthz").then((r) => r.text())) === "ok", "GET /healthz");

  const adminId = crypto.randomUUID(), camId = crypto.randomUUID(), backId = crypto.randomUUID();
  const a = ADMIN_BASE ? await join(adminId, "Producer", "", "desktop", ADMIN_BASE) : await join(adminId, "Producer", code, "desktop");
  ok(a.status === 200 && a.body.deviceToken && a.body.livekitToken.split(".").length === 3, "join admin-to-be");
  if (promote) await fetch(`${promote}/mock/promote/${adminId}`, { method: "POST", body: "{}" });
  const c = await join(camId, "Camera 1");
  ok(c.status === 200 && c.body.me.groupId, "join crew");
  const s = await api("/api/session", { method: "POST", headers: { authorization: `Bearer ${c.body.deviceToken}` }, body: JSON.stringify({ appVersion: "0.1.0", apiVersion: 1 }) });
  ok(s.status === 200 && s.body.me.id === camId && !s.body.deviceToken, "POST /api/session");
  ok((await api("/api/session", { method: "POST", headers: { authorization: "Bearer nope" } })).status === 401, "session bad token -> 401");

  const A = new Client(a.body.deviceToken);
  const wa = await A.auth();
  ok(wa.payload.me.isAdmin && wa.payload.server.joinCode, "admin welcome has joinCode");
  const C = new Client(c.body.deviceToken);
  const wc = await C.auth();
  ok(wc.payload.server.joinCode === null && wc.payload.devices.length >= 2, "crew welcome hides joinCode");
  const camGroup = wc.payload.me.groupId;
  const other = wc.payload.groups.find((g) => g.id !== camGroup && g.id !== a.body.me.groupId) ?? wc.payload.groups.find((g) => g.id !== camGroup);

  C.send("ping", {});
  ok((await C.wait((m) => m.type === "pong")).type === "pong", "ping/pong");

  C.send("state.set", { talkMode: "ptt", talkTargets: [`g:${camGroup}`], listenGroupIds: [camGroup] }, "c-1");
  ok((await C.wait((m) => m.type === "ack" && m.payload.replyTo === "c-1")).type === "ack", "state.set ack");
  C.send("state.set", { talkTargets: [`g:${other.id}`] }, "c-2");
  const e = await C.wait((m) => m.type === "error" && m.payload.replyTo === "c-2");
  ok(e.payload.code === "bad_request", "state.set to forbidden group -> error");

  const t0 = Date.now();
  C.send("state.set", { micLive: true });
  const up = await A.wait((m) => m.type === "device.upsert" && m.payload.id === camId && m.payload.live.micLive);
  ok(up && Date.now() - t0 < 200, `admin sees crew micLive (${Date.now() - t0} ms)`);
  C.send("state.set", { micLive: false });

  A.send("message.send", { to: `g:${camGroup}`, text: "Cam 1 tighter please", kind: "text" }, "c-3");
  const m = await C.wait((x) => x.type === "message");
  ok(m.payload.text === "Cam 1 tighter please", "crew receives group message");
  C.send("message.ack", { messageId: m.payload.id });
  ok((await A.wait((x) => x.type === "message.acked")).payload.deviceId === camId, "admin sees ack");
  C.send("message.send", { to: `d:${adminId}`, text: "OK", kind: "quick" }, "c-4");
  ok((await A.wait((x) => x.type === "message" && x.payload.from === camId)).payload.kind === "quick", "crew quick reply to admin");
  C.send("message.send", { to: "all", text: "hi", kind: "text" }, "c-5");
  ok((await C.wait((x) => x.type === "error" && x.payload.replyTo === "c-5")).type === "error", "crew broadcast rejected");
  C.send("admin.join.rotate", {}, "c-6");
  ok((await C.wait((x) => x.type === "error" && x.payload.replyTo === "c-6")).payload.code === "not_admin", "crew admin cmd -> not_admin");

  A.send("signal.send", { to: `d:${camId}` });
  ok((await C.wait((x) => x.type === "signal")).payload.from === adminId, "signal delivered");

  A.send("admin.device.mute", { deviceId: camId, muted: true }, "c-7");
  ok((await C.wait((x) => x.type === "admin.notice")).payload.kind === "muted", "mute notice");
  await C.wait((x) => x.type === "device.upsert" && x.payload.id === camId && x.payload.adminMuted);
  C.send("state.set", { micLive: true }, "c-8");
  await C.wait((x) => x.type === "ack" && x.payload.replyTo === "c-8");
  const mu = await C.wait((x) => x.type === "device.upsert" && x.payload.id === camId, 1000).catch(() => null);
  ok(!mu || !mu.payload.live.micLive, "micLive ignored while adminMuted");
  A.send("admin.device.mute", { deviceId: camId, muted: false });

  A.send("admin.device.update", { deviceId: camId, groupId: other.id }, "c-9");
  const mv = await C.wait((x) => x.type === "admin.notice" && x.payload.kind === "moved");
  ok(mv, "move notice");
  const moved = await C.wait((x) => x.type === "device.upsert" && x.payload.id === camId && x.payload.groupId === other.id);
  ok(moved.payload.live.talkTargets[0] === `g:${other.id}` && moved.payload.listenGroupIds[0] === other.id, "move resets targets/listen");

  A.send("admin.group.create", { name: "Lighting" }, "c-10");
  const gu = await A.wait((x) => x.type === "groups.updated");
  ok(gu.payload.groups.some((g) => g.id === "lighting"), "group created");
  A.send("admin.group.delete", { groupId: "lighting", moveDevicesTo: other.id }, "c-11");
  ok(!(await A.wait((x) => x.type === "groups.updated")).payload.groups.some((g) => g.id === "lighting"), "group deleted");

  A.send("admin.join.rotate", {}, "c-12");
  const su = await A.wait((x) => x.type === "server.updated");
  ok(su.payload.joinCode && su.payload.joinCode !== code, "join code rotated");
  code = su.payload.joinCode;

  // remove
  A.send("admin.device.remove", { deviceId: camId }, "c-13");
  ok((await C.wait((x) => x.type === "kicked")).payload.reason === "removed_by_admin", "kicked");
  await C.closed;
  const s2 = await api("/api/session", { method: "POST", headers: { authorization: `Bearer ${c.body.deviceToken}` }, body: "{}" });
  ok(s2.status === 403 && s2.body.error.code === "revoked", "removed device session -> 403 revoked");
  await A.wait((x) => x.type === "device.removed" && x.payload.deviceId === camId);

  // rate limit (do last: it locks out this IP for 5 minutes)
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push(await join(backId, "Backstage 1", "000000"));
  ok(statuses.slice(0, 5).every((r) => r.status === 401) && statuses[5].status === 429 && Number(statuses[5].headers.get("retry-after")) > 0, `rate limit: ${statuses.map((r) => r.status).join(",")}`);
  const su2 = await A.wait((x) => x.type === "server.updated" && x.payload.failedJoinAttempts >= 5);
  ok(su2.payload.failedJoinAttempts >= 5, "admin sees failed attempts");
  A.ws.close();
} catch (e) {
  console.log("FAIL  exception:", e.message);
  failures++;
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
child?.kill();
process.exit(failures ? 1 : 0);
