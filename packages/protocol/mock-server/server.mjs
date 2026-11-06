#!/usr/bin/env node
// PartyLine mock server — an in-memory implementation of docs/PROTOCOL.md v1 for the phone
// and web clients to test against until the Tauri host runs. See README.md.
//
// HTTPS (self-signed, stable fingerprint) on :8443 with /api/info, /api/join, /api/session,
// /api/messages, /api/ws, /healthz, static web client at /, and /rtc proxied to a local
// `livekit-server --dev` on 127.0.0.1:7880 (keys devkey/secret).

import https from "node:https";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const PORT = Number(args.port ?? process.env.PORT ?? 8443);
const DATA_DIR = path.resolve(args.data ?? process.env.MOCK_DATA ?? path.join(HERE, ".mock-data"));
const LIVEKIT_HTTP = args.livekit ?? process.env.LIVEKIT_URL ?? "http://127.0.0.1:7880";
const LK_KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const LK_SECRET = process.env.LIVEKIT_API_SECRET ?? "secret";
const STATIC_DIR = path.resolve(args.static ?? path.join(HERE, "..", "..", "web-client", "dist"));
const START_LIVEKIT = args["start-livekit"] === "true";
const NO_MDNS = args["no-mdns"] === "true";
const APP_VERSION = "0.1.0";
const ROOM = args.room ?? "partyline";
const TOKEN_TTL_S = Number(args["token-ttl"] ?? 3600);
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- TLS

function lanIPv4s() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address)
    .sort((a, b) => ipRank(a) - ipRank(b));
}
// prefer real LAN ranges over VPN/CGNAT (Tailscale 100.64/10) and link-local
function ipRank(ip) {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  if (ip.startsWith("169.254.")) return 9;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 8;
  return 5;
}

function ensureCert() {
  const keyFile = path.join(DATA_DIR, "key.pem");
  const certFile = path.join(DATA_DIR, "cert.pem");
  // iOS hard-rejects (no "visit anyway") server certs valid > 825 days or without serverAuth EKU.
  const compliant = () => {
    try {
      const c = new crypto.X509Certificate(fs.readFileSync(certFile));
      const days = (Date.parse(c.validTo) - Date.parse(c.validFrom)) / 86_400_000;
      return days <= 825 && Date.parse(c.validTo) - Date.now() > 30 * 86_400_000 && (c.keyUsage ?? []).includes("1.3.6.1.5.5.7.3.1");
    } catch {
      return false;
    }
  };
  if (!fs.existsSync(keyFile) || !compliant()) {
    const host = os.hostname().replace(/\.local$/, "");
    const sans = ["DNS:partyline.local", "DNS:localhost", `DNS:${host}`, `DNS:${host}.local`, "IP:127.0.0.1", ...lanIPv4s().map((ip) => `IP:${ip}`)];
    log("generating self-signed cert, SANs:", sans.join(","));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", keyFile, "-out", certFile, "-days", "820", "-subj", "/CN=PartyLine mock",
      "-addext", `subjectAltName=${sans.join(",")}`,
      "-addext", "basicConstraints=critical,CA:FALSE",
      "-addext", "keyUsage=critical,digitalSignature",
      "-addext", "extendedKeyUsage=serverAuth",
    ], { stdio: "ignore" });
  }
  const cert = fs.readFileSync(certFile);
  const fp = new crypto.X509Certificate(cert).fingerprint256.replace(/:/g, "").toLowerCase();
  return { key: fs.readFileSync(keyFile), cert, fp };
}
const tls = ensureCert();

// ---------------------------------------------------------------- state (persisted to state.json)

const STATE_FILE = path.join(DATA_DIR, "state.json");
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

let db = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : null;
if (!db) {
  db = {
    server: { serverId: crypto.randomUUID(), name: args.name ?? `${os.hostname().replace(/\.local$/, "")} (mock)`, joinCode: args.code ?? "483920", joinOpen: true },
    settings: { crewCanBroadcast: false, defaultTalkMode: "ptt", quickReplies: ["OK", "Standby", "Go", "Problem", "Can't hear"], adminsHearEverything: false },
    groups: [
      { id: "producer", name: "Producer", color: "#e11d48", sortOrder: 0, defaultTalkMode: "latch" },
      { id: "camera", name: "Camera", color: "#2563eb", sortOrder: 1, defaultTalkMode: null },
      { id: "backstage", name: "Backstage", color: "#16a34a", sortOrder: 2, defaultTalkMode: null },
    ],
    devices: {}, // id -> persisted Device fields + tokenHash + revoked
    messages: [],
  };
}
if (args.code) db.server.joinCode = args.code;
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(STATE_FILE, JSON.stringify(db, null, 2)), 200);
}
save();

/** in-memory live state, deviceId -> live */
const live = new Map();
/** deviceId -> Session */
const sessions = new Map();
const joinAttempts = new Map(); // ip -> {fails: [ts], lockedUntil}
const failedLog = []; // ts of failed attempts (last hour reported)

const groupById = (id) => db.groups.find((g) => g.id === id);
const sortedGroups = () => [...db.groups].sort((a, b) => a.sortOrder - b.sortOrder);

function defaultTalkMode(d) {
  if (d.forcedTalkMode) return d.forcedTalkMode;
  const g = groupById(d.groupId);
  if (g?.defaultTalkMode) return g.defaultTalkMode;
  return d.isAdmin ? "latch" : db.settings.defaultTalkMode;
}

function liveOf(d) {
  let l = live.get(d.id);
  if (!l) {
    l = { online: false, rtcConnected: false, micLive: false, speakerMuted: false, talkMode: defaultTalkMode(d), talkTargets: [`g:${d.groupId}`], speaking: false, battery: null, charging: null, headset: null, outputRoute: null, rttMs: null };
    live.set(d.id, l);
  }
  if (d.forcedTalkMode) l.talkMode = d.forcedTalkMode;
  return l;
}

function deviceView(d) {
  const { tokenHash, revoked, ...rest } = d;
  return { ...rest, live: { ...liveOf(d) } };
}
const activeDevices = () => Object.values(db.devices).filter((d) => !d.revoked);

function serverInfo(forAdmin) {
  const hourAgo = Date.now() - 3600_000;
  return {
    serverId: db.server.serverId, name: db.server.name, appVersion: APP_VERSION, apiVersion: 1,
    joinCode: forAdmin ? db.server.joinCode : null, joinOpen: db.server.joinOpen, fingerprint: tls.fp,
    failedJoinAttempts: forAdmin ? failedLog.filter((t) => t > hourAgo).length : 0,
  };
}

// ---------------------------------------------------------------- LiveKit tokens + RoomService

const b64u = (buf) => Buffer.from(buf).toString("base64url");
function signJwt(claims) {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  const s = crypto.createHmac("sha256", LK_SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
function livekitToken(d) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: LK_KEY, sub: d.id, name: d.displayName, nbf: now - 10, exp: now + TOKEN_TTL_S, jti: d.id,
    metadata: JSON.stringify({ groupId: d.groupId, isAdmin: d.isAdmin }),
    video: { roomJoin: true, room: ROOM, canPublish: true, canPublishSources: ["microphone"], canSubscribe: true, canPublishData: false },
  });
}
async function roomService(method, body) {
  const now = Math.floor(Date.now() / 1000);
  const tok = signJwt({ iss: LK_KEY, nbf: now - 10, exp: now + 60, video: { roomAdmin: true, room: ROOM, roomList: true } });
  try {
    const r = await fetch(`${LIVEKIT_HTTP}/twirp/livekit.RoomService/${method}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) log(`livekit ${method} -> ${r.status}`, j.msg ?? "");
    return r.ok ? j : null;
  } catch (e) {
    log(`livekit ${method} failed: ${e.message}`);
    return null;
  }
}
async function livekitMute(identity, muted) {
  const p = await roomService("GetParticipant", { room: ROOM, identity });
  for (const t of p?.tracks ?? []) {
    if (t.type === "AUDIO" || t.type === 0 || t.source === "MICROPHONE") {
      await roomService("MutePublishedTrack", { room: ROOM, identity, track_sid: t.sid, muted });
    }
  }
}
async function livekitUpdateMetadata(d) {
  await roomService("UpdateParticipant", { room: ROOM, identity: d.id, name: d.displayName, metadata: JSON.stringify({ groupId: d.groupId, isAdmin: d.isAdmin }) });
}

// ---------------------------------------------------------------- broadcast

function send(sess, type, payload, extra = {}) {
  if (sess.ws.readyState !== 1) return;
  sess.ws.send(JSON.stringify({ type, ts: nowIso(), ...extra, payload }));
}
function broadcast(type, payloadFn) {
  for (const s of sessions.values()) if (s.authed) send(s, type, typeof payloadFn === "function" ? payloadFn(s) : payloadFn);
}
const pendingUpsert = new Map(); // id -> timer
const lastUpsert = new Map();
function upsert(d, immediate = false) {
  const fire = () => {
    pendingUpsert.delete(d.id);
    lastUpsert.set(d.id, Date.now());
    const cur = db.devices[d.id];
    if (cur && !cur.revoked) broadcast("device.upsert", deviceView(cur));
  };
  const since = Date.now() - (lastUpsert.get(d.id) ?? 0);
  if (immediate || since >= 250) {
    clearTimeout(pendingUpsert.get(d.id));
    fire();
  } else if (!pendingUpsert.has(d.id)) {
    pendingUpsert.set(d.id, setTimeout(fire, 250 - since));
  }
}
function broadcastServer() {
  broadcast("server.updated", (s) => serverInfo(db.devices[s.deviceId]?.isAdmin));
}

// ---------------------------------------------------------------- routing / validation (PROTOCOL §4)

const talkableGroups = (d) => (d.isAdmin ? db.groups.map((g) => g.id) : d.canTalkGroupIds.filter(groupById));
const listenableGroups = (d) => (d.isAdmin ? db.groups.map((g) => g.id) : [...new Set([d.groupId, ...d.canTalkGroupIds])]);

function validateTargets(d, targets) {
  if (!Array.isArray(targets)) throw ["bad_request", "talkTargets must be an array"];
  const out = new Set();
  for (const t of targets) {
    if (t === "all") talkableGroups(d).forEach((g) => out.add(`g:${g}`));
    else if (typeof t === "string" && t.startsWith("g:")) {
      const g = t.slice(2);
      if (!groupById(g)) throw ["not_found", `no group ${g}`];
      if (!talkableGroups(d).includes(g)) throw ["bad_request", `talkTargets: not allowed to talk to ${t}`];
      out.add(t);
    } else if (typeof t === "string" && t.startsWith("d:")) {
      const target = db.devices[t.slice(2)];
      if (!target || target.revoked) throw ["not_found", `no device ${t}`];
      if (!(d.isAdmin || target.isAdmin || talkableGroups(d).includes(target.groupId))) throw ["bad_request", `talkTargets: not allowed to talk to ${t}`];
      out.add(t);
    } else throw ["bad_request", `bad target ${t}`];
  }
  return [...out];
}

function visibleTo(msg, d) {
  if (d.isAdmin || msg.from === d.id || msg.to === "all") return true;
  if (msg.to === `d:${d.id}`) return true;
  if (msg.to.startsWith("g:")) {
    const g = msg.to.slice(2);
    return g === d.groupId || d.listenGroupIds.includes(g);
  }
  return false;
}
function messageView(m, forAdmin) {
  const { ackedBy, ...rest } = m;
  return forAdmin ? { ...rest, ackedBy: ackedBy ?? [] } : rest;
}
function canAddress(d, to) {
  if (to === "all") return d.isAdmin || db.settings.crewCanBroadcast;
  if (typeof to !== "string") return false;
  if (d.isAdmin) return to.startsWith("g:") ? !!groupById(to.slice(2)) : to.startsWith("d:") && !!db.devices[to.slice(2)];
  if (to.startsWith("g:")) return listenableGroups(d).includes(to.slice(2));
  if (to.startsWith("d:")) return !!db.devices[to.slice(2)]?.isAdmin;
  return false;
}
function recipients(to) {
  return activeDevices().filter((d) => {
    if (to === "all") return true;
    if (to === `d:${d.id}`) return true;
    if (to.startsWith("g:")) {
      const g = to.slice(2);
      return d.groupId === g || d.listenGroupIds.includes(g);
    }
    return false;
  });
}

// ---------------------------------------------------------------- REST

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
const err = (res, status, code, message, headers) => json(res, status, { error: { code, message } }, headers);
async function readJson(req) {
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 64_000) throw new Error("too big");
  }
  return s ? JSON.parse(s) : {};
}
function sessionBody(d) {
  return { livekitToken: livekitToken(d), livekitUrl: "/rtc", roomName: ROOM, me: deviceView(d), groups: sortedGroups() };
}
function authDevice(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return [null, "invalid_token"];
  const h = sha256(m[1]);
  const d = Object.values(db.devices).find((x) => x.tokenHash === h);
  if (!d) return [null, "invalid_token"];
  if (d.revoked) return [null, "revoked"];
  return [d, null];
}
const clientIp = (req) => (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
const isLoopback = (ip) => ip === "127.0.0.1" || ip === "::1";

function rateCheck(ip) {
  const a = joinAttempts.get(ip) ?? { fails: [], lockedUntil: 0 };
  joinAttempts.set(ip, a);
  if (a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 1000);
  return 0;
}
function rateFail(ip) {
  const a = joinAttempts.get(ip);
  const now = Date.now();
  failedLog.push(now);
  a.fails = a.fails.filter((t) => t > now - 60_000);
  a.fails.push(now);
  if (a.fails.length >= 5) {
    a.lockedUntil = now + 5 * 60_000;
    a.fails = [];
  }
  broadcast("server.updated", (s) => serverInfo(db.devices[s.deviceId]?.isAdmin));
}

async function handleJoin(req, res) {
  const ip = clientIp(req);
  const wait = rateCheck(ip);
  if (wait) return err(res, 429, "rate_limited", `Too many attempts, try again in ${wait} s`, { "retry-after": String(wait) });
  let b;
  try {
    b = await readJson(req);
  } catch {
    return err(res, 400, "bad_request", "invalid JSON");
  }
  if (b.apiVersion !== undefined && b.apiVersion !== 1) return err(res, 400, "version_unsupported", "apiVersion 1 required");
  if (!/^[0-9a-f-]{36}$/i.test(b.deviceId ?? "") || !b.displayName || !["ios", "android", "web", "desktop"].includes(b.platform)) {
    return err(res, 400, "bad_request", "deviceId (uuid), displayName and platform are required");
  }
  if (!db.server.joinOpen) return err(res, 403, "join_closed", "Joining is closed");
  if (String(b.joinCode) !== db.server.joinCode) {
    rateFail(ip);
    log(`join: wrong code from ${ip}`);
    return err(res, 401, "invalid_code", "Wrong join code");
  }
  const token = crypto.randomBytes(32).toString("base64url");
  let d = db.devices[b.deviceId];
  const now = nowIso();
  if (d) {
    // re-pairing: keep group and permissions, new token
    d.tokenHash = sha256(token);
    d.revoked = false;
    d.displayName = String(b.displayName).slice(0, 40);
    d.platform = b.platform;
    d.appVersion = b.appVersion ?? d.appVersion;
    d.lastSeenAt = now;
  } else {
    const firstGroup = sortedGroups().find((g) => g.id !== "producer") ?? sortedGroups()[0];
    const admin = (isLoopback(ip) && args["local-admin"] !== "false") || args["all-admin"] === "true";
    const home = admin ? groupById("producer")?.id ?? firstGroup.id : firstGroup.id;
    d = db.devices[b.deviceId] = {
      id: b.deviceId, displayName: String(b.displayName).slice(0, 40), platform: b.platform, appVersion: b.appVersion ?? "0.0.0",
      groupId: home, listenGroupIds: admin ? db.groups.map((g) => g.id) : [home], canTalkGroupIds: admin ? db.groups.map((g) => g.id) : [home],
      isAdmin: admin, forcedTalkMode: null, adminMuted: false, createdAt: now, lastSeenAt: now, tokenHash: sha256(token), revoked: false,
    };
  }
  // the previous token is invalid now: close any session on it
  sessions.get(d.id)?.ws.close(4001, "re-paired");
  save();
  log(`join: ${d.displayName} (${d.platform}) ${d.id} from ${ip}${d.isAdmin ? " [admin]" : ""}`);
  upsert(d, true);
  json(res, 200, { deviceToken: token, ...sessionBody(d) });
}

async function handleSession(req, res) {
  const [d, code] = authDevice(req);
  if (!d) return code === "revoked" ? err(res, 403, "revoked", "This device was removed by the admin") : err(res, 401, "invalid_token", "Unknown device token");
  try {
    await readJson(req);
  } catch {}
  d.lastSeenAt = nowIso();
  save();
  json(res, 200, sessionBody(d));
}

function handleMessages(req, res, url) {
  const [d, code] = authDevice(req);
  if (!d) return code === "revoked" ? err(res, 403, "revoked", "removed") : err(res, 401, "invalid_token", "Unknown device token");
  const since = url.searchParams.get("since");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
  const list = db.messages.filter((m) => visibleTo(m, d) && (!since || m.ts > since)).slice(-limit);
  json(res, 200, list.map((m) => messageView(m, d.isAdmin)));
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".mp3": "audio/mpeg", ".wav": "audio/wav" };
function serveStatic(req, res, url) {
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let f = path.join(STATIC_DIR, p);
  if (!f.startsWith(STATIC_DIR)) return err(res, 404, "not_found", "not found");
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(STATIC_DIR, "index.html");
  if (!fs.existsSync(f)) {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("PartyLine mock server. Web client not built (packages/web-client/dist missing).\n");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream", "cache-control": f.endsWith("index.html") ? "no-store" : "max-age=3600" });
  fs.createReadStream(f).pipe(res);
}

// mock-only helpers for the phone teams
async function handleMock(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // mock, <cmd>, ...
  const b = req.method === "POST" ? await readJson(req).catch(() => ({})) : {};
  const admin = activeDevices().find((d) => d.isAdmin);
  switch (parts[1]) {
    case "state":
      return json(res, 200, { server: { ...db.server, fingerprint: tls.fp }, settings: db.settings, groups: sortedGroups(), devices: activeDevices().map(deviceView), sessions: [...sessions.keys()] });
    case "promote": {
      const d = db.devices[parts[2]];
      if (!d) return err(res, 404, "not_found", "no device");
      d.isAdmin = b.isAdmin ?? true;
      save();
      upsert(d, true);
      return json(res, 200, deviceView(d));
    }
    case "message": {
      // POST /mock/message {to, text, from?}
      const m = { id: `m-${crypto.randomUUID().slice(0, 8)}`, from: b.from ?? admin?.id ?? "00000000-0000-4000-8000-000000000000", to: b.to ?? "all", kind: "text", text: String(b.text ?? "Test message"), ts: nowIso(), ackedBy: [] };
      deliverMessage(m);
      return json(res, 200, m);
    }
    case "signal": {
      const to = b.to ?? "all";
      for (const r of recipients(to)) {
        const s = sessions.get(r.id);
        if (s?.authed) send(s, "signal", { from: b.from ?? admin?.id ?? "", to });
      }
      return json(res, 200, { ok: true });
    }
    case "notice": {
      const s = sessions.get(b.deviceId);
      if (s) send(s, "admin.notice", { kind: b.kind ?? "moved", text: b.text ?? "Test notice" });
      return json(res, 200, { ok: !!s });
    }
    case "shutdown": {
      broadcast("server.shutdown", { reconnectAfterMs: 3000 });
      for (const s of sessions.values()) s.ws.close(1001, "shutdown");
      return json(res, 200, { ok: true });
    }
    case "talk": {
      // POST /mock/talk {deviceId, micLive, talkTargets?} — fake another device talking (roster only)
      const d = db.devices[b.deviceId] ?? admin;
      if (!d) return err(res, 404, "not_found", "no device");
      const l = liveOf(d);
      if (b.talkTargets) l.talkTargets = b.talkTargets;
      l.micLive = !!b.micLive;
      l.speaking = !!b.micLive;
      upsert(d, true);
      return json(res, 200, deviceView(d));
    }
    default:
      return err(res, 404, "not_found", "mock commands: GET /mock/state, POST /mock/promote/<id>, /mock/message, /mock/signal, /mock/notice, /mock/talk, /mock/shutdown");
  }
}

const server = https.createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host ?? "localhost"}`);
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  try {
    if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (url.pathname === "/api/info" && req.method === "GET") {
      return json(res, 200, { apiVersion: 1, serverId: db.server.serverId, name: db.server.name, appVersion: APP_VERSION, fingerprint: tls.fp, joinOpen: db.server.joinOpen, livekitUrl: "/rtc", minClientVersion: "0.1.0" });
    }
    if (url.pathname === "/api/join" && req.method === "POST") return await handleJoin(req, res);
    if (url.pathname === "/api/session" && req.method === "POST") return await handleSession(req, res);
    if (url.pathname === "/api/messages" && req.method === "GET") return handleMessages(req, res, url);
    if (url.pathname.startsWith("/rtc")) return proxyHttp(req, res, url);
    if (url.pathname.startsWith("/mock/")) return await handleMock(req, res, url);
    if (url.pathname.startsWith("/api/")) return err(res, 404, "not_found", "no such endpoint");
    return serveStatic(req, res, url);
  } catch (e) {
    log("error", e);
    if (!res.headersSent) err(res, 500, "bad_request", e.message);
  }
});

// ---------------------------------------------------------------- /rtc proxy → LiveKit

// SDKs append "/rtc" (or "/rtc/v1", "/rtc/validate") to the URL they are given, so a client
// given wss://host:8443/rtc requests /rtc/rtc…; strip our /rtc prefix once.
function rtcPath(pathnameAndQuery) {
  const stripped = pathnameAndQuery.replace(/^\/rtc/, "");
  return /^\/rtc(\/|\?|$)/.test(stripped) ? stripped : pathnameAndQuery;
}
const lk = new URL(LIVEKIT_HTTP);
function proxyHttp(req, res, url) {
  const p = http.request({ host: lk.hostname, port: lk.port || 80, method: req.method, path: rtcPath(url.pathname + url.search), headers: { ...req.headers, host: lk.host } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  p.on("error", () => err(res, 502, "bad_request", "LiveKit is not running"));
  req.pipe(p);
}
function proxyUpgrade(req, socket, head) {
  const upstream = net.connect(Number(lk.port || 80), lk.hostname, () => {
    const hdrs = Object.entries({ ...req.headers, host: lk.host }).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    upstream.write(`GET ${rtcPath(req.url)} HTTP/1.1\r\n${hdrs}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const end = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", end);
  socket.on("error", end);
  upstream.setNoDelay(true);
  socket.setNoDelay?.(true);
}

// ---------------------------------------------------------------- WebSocket /api/ws

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "https://x");
  if (u.pathname === "/api/ws") wss.handleUpgrade(req, socket, head, (ws) => onWs(ws, req));
  else if (u.pathname.startsWith("/rtc")) proxyUpgrade(req, socket, head);
  else socket.destroy();
});

function deliverMessage(m) {
  db.messages.push(m);
  if (db.messages.length > 2000) db.messages.splice(0, db.messages.length - 2000);
  save();
  for (const s of sessions.values()) {
    const d = db.devices[s.deviceId];
    if (s.authed && d && visibleTo(m, d)) send(s, "message", messageView(m, d.isAdmin));
  }
}

function welcome(s) {
  const d = db.devices[s.deviceId];
  const isAdmin = d.isAdmin;
  send(s, "welcome", {
    me: deviceView(d), devices: activeDevices().map(deviceView), groups: sortedGroups(), server: serverInfo(isAdmin), settings: db.settings,
    livekitToken: livekitToken(d), roomName: ROOM, messages: db.messages.filter((m) => visibleTo(m, d)).slice(-50).map((m) => messageView(m, isAdmin)),
  });
  scheduleRefresh(s);
}
function scheduleRefresh(s) {
  clearTimeout(s.refreshTimer);
  s.refreshTimer = setTimeout(() => {
    const d = db.devices[s.deviceId];
    if (d && !d.revoked) send(s, "token.refreshed", { livekitToken: livekitToken(d) });
    scheduleRefresh(s);
  }, Math.max(10, TOKEN_TTL_S - 300) * 1000);
}

function onWs(ws, req) {
  const s = { ws, authed: false, deviceId: null, ip: clientIp(req), lastPing: Date.now() };
  const authTimer = setTimeout(() => !s.authed && ws.close(4000, "auth timeout"), 5000);
  const idle = setInterval(() => Date.now() - s.lastPing > 45_000 && ws.close(4002, "ping timeout"), 5000);
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(s, "error", { code: "bad_request", message: "invalid JSON" });
    }
    const reply = (code, message) => send(s, "error", { ...(msg.id ? { replyTo: msg.id } : {}), code, message });
    const ack = () => msg.id && send(s, "ack", { replyTo: msg.id });
    s.lastPing = Date.now();
    if (!s.authed) {
      if (msg.type !== "auth") return reply("invalid_token", "auth must be first"), ws.close(4003, "auth first");
      const h = sha256(String(msg.payload?.deviceToken ?? ""));
      const d = Object.values(db.devices).find((x) => x.tokenHash === h);
      if (!d) return reply("invalid_token", "Unknown device token"), ws.close(4001, "invalid_token");
      if (d.revoked) return reply("revoked", "removed by admin"), ws.close(4004, "revoked");
      clearTimeout(authTimer);
      const old = sessions.get(d.id);
      if (old && old !== s) {
        old.replaced = true;
        old.ws.close(4005, "replaced");
      }
      s.authed = true;
      s.deviceId = d.id;
      sessions.set(d.id, s);
      if (msg.payload?.appVersion) d.appVersion = msg.payload.appVersion;
      d.lastSeenAt = nowIso();
      liveOf(d).online = true;
      save();
      log(`ws: ${d.displayName} online`);
      welcome(s);
      upsert(d, true);
      return ack();
    }
    const d = db.devices[s.deviceId];
    if (!d || d.revoked) return ws.close(4004, "revoked");
    try {
      handle(s, d, msg, ack);
    } catch (e) {
      if (Array.isArray(e)) reply(e[0], e[1]);
      else {
        log("handler error", e);
        reply("bad_request", String(e.message ?? e));
      }
    }
  });
  ws.on("close", () => {
    clearTimeout(authTimer);
    clearInterval(idle);
    clearTimeout(s.refreshTimer);
    if (s.deviceId && sessions.get(s.deviceId) === s) {
      sessions.delete(s.deviceId);
      const d = db.devices[s.deviceId];
      if (d) {
        const l = liveOf(d);
        Object.assign(l, { online: false, rtcConnected: false, micLive: false, speaking: false });
        d.lastSeenAt = nowIso();
        save();
        log(`ws: ${d.displayName} offline`);
        upsert(d, true);
      }
    }
  });
}

const requireAdmin = (d) => {
  if (!d.isAdmin) throw ["not_admin", "admin only"];
};
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "group";
function notice(id, kind, text) {
  const s = sessions.get(id);
  if (s?.authed) send(s, "admin.notice", { kind, text });
}

function handle(s, d, msg, ack) {
  const p = msg.payload ?? {};
  const l = liveOf(d);
  switch (msg.type) {
    case "ping":
      return send(s, "pong", {}, msg.id ? { id: msg.id } : {});
    case "state.set": {
      // validate everything first, then apply (state unchanged on error)
      const next = {};
      if (p.talkTargets !== undefined) next.talkTargets = validateTargets(d, p.talkTargets);
      if (p.listenGroupIds !== undefined) {
        if (!Array.isArray(p.listenGroupIds)) throw ["bad_request", "listenGroupIds must be an array"];
        const ok = listenableGroups(d);
        for (const g of p.listenGroupIds) if (!ok.includes(g)) throw ["bad_request", `listenGroupIds: not allowed to listen to ${g}`];
        next.listenGroupIds = [...new Set(p.listenGroupIds)];
      }
      if (p.talkMode !== undefined && !["ptt", "latch"].includes(p.talkMode)) throw ["bad_request", "talkMode must be ptt or latch"];
      let immediate = false;
      if (next.talkTargets) l.talkTargets = next.talkTargets, (immediate = true);
      if (next.listenGroupIds) (d.listenGroupIds = next.listenGroupIds), save(), (immediate = true);
      if (p.micLive !== undefined) {
        const v = !!p.micLive && !d.adminMuted;
        if (v !== l.micLive) immediate = true;
        l.micLive = v;
      }
      if (p.speakerMuted !== undefined) l.speakerMuted = !!p.speakerMuted;
      if (p.talkMode !== undefined) l.talkMode = d.forcedTalkMode ?? p.talkMode;
      ack();
      return upsert(d, immediate);
    }
    case "status": {
      for (const k of ["rtcConnected", "speaking", "charging", "headset"]) if (typeof p[k] === "boolean") l[k] = p[k];
      if (typeof p.battery === "number") l.battery = Math.max(0, Math.min(100, Math.round(p.battery)));
      if (typeof p.rttMs === "number") l.rttMs = Math.round(p.rttMs);
      if (typeof p.outputRoute === "string") l.outputRoute = p.outputRoute;
      ack();
      return upsert(d, false);
    }
    case "message.send": {
      const text = String(p.text ?? "").trim();
      const kind = p.kind === "quick" ? "quick" : "text";
      if (!text || text.length > 500) throw ["bad_request", "text must be 1-500 chars"];
      if (kind === "quick" && !db.settings.quickReplies.includes(text)) throw ["bad_request", "not a quick reply"];
      if (!canAddress(d, p.to)) throw ["bad_request", `not allowed to message ${p.to}`];
      const m = { id: `m-${crypto.randomUUID()}`, from: d.id, to: p.to, kind, text, ts: nowIso(), ackedBy: [] };
      deliverMessage(m);
      return ack();
    }
    case "message.ack": {
      const m = db.messages.find((x) => x.id === p.messageId);
      if (!m) throw ["not_found", "no such message"];
      if (!m.ackedBy.includes(d.id)) m.ackedBy.push(d.id), save();
      const ts = nowIso();
      for (const o of sessions.values()) if (o.authed && db.devices[o.deviceId]?.isAdmin) send(o, "message.acked", { messageId: m.id, deviceId: d.id, ts });
      return ack();
    }
    case "signal.send": {
      if (!canAddress(d, p.to) || p.to === "all" && !d.isAdmin) throw ["bad_request", `not allowed to signal ${p.to}`];
      for (const r of recipients(p.to)) {
        const o = sessions.get(r.id);
        if (o?.authed && r.id !== d.id) send(o, "signal", { from: d.id, to: p.to });
      }
      return ack();
    }
    case "token.refresh":
      send(s, "token.refreshed", { livekitToken: livekitToken(d) });
      scheduleRefresh(s);
      return ack();

    // ---------------- admin
    case "admin.device.update": {
      requireAdmin(d);
      const t = db.devices[p.deviceId];
      if (!t || t.revoked) throw ["not_found", "no such device"];
      if (p.groupId !== undefined && !groupById(p.groupId)) throw ["not_found", `no group ${p.groupId}`];
      for (const k of ["listenGroupIds", "canTalkGroupIds"]) if (p[k] !== undefined && (!Array.isArray(p[k]) || p[k].some((g) => !groupById(g)))) throw ["bad_request", `${k}: unknown group`];
      if (p.forcedTalkMode !== undefined && ![null, "ptt", "latch"].includes(p.forcedTalkMode)) throw ["bad_request", "forcedTalkMode"];
      const tl = liveOf(t);
      if (p.displayName !== undefined && p.displayName !== t.displayName) {
        t.displayName = String(p.displayName).slice(0, 40);
        notice(t.id, "renamed", `You were renamed to ${t.displayName}`);
      }
      if (p.groupId !== undefined && p.groupId !== t.groupId) {
        t.groupId = p.groupId;
        t.listenGroupIds = p.listenGroupIds ?? (t.isAdmin ? t.listenGroupIds : [p.groupId]);
        t.canTalkGroupIds = p.canTalkGroupIds ?? (t.isAdmin ? t.canTalkGroupIds : [p.groupId]);
        tl.talkTargets = [`g:${p.groupId}`];
        if (!t.forcedTalkMode) tl.talkMode = defaultTalkMode(t);
        notice(t.id, "moved", `You were moved to ${groupById(p.groupId).name}`);
      } else {
        if (p.listenGroupIds !== undefined) t.listenGroupIds = p.listenGroupIds;
        if (p.canTalkGroupIds !== undefined) {
          t.canTalkGroupIds = p.canTalkGroupIds;
          tl.talkTargets = tl.talkTargets.filter((x) => !x.startsWith("g:") || t.isAdmin || p.canTalkGroupIds.includes(x.slice(2)));
        }
      }
      if (p.isAdmin !== undefined) t.isAdmin = !!p.isAdmin;
      if (p.forcedTalkMode !== undefined && p.forcedTalkMode !== t.forcedTalkMode) {
        t.forcedTalkMode = p.forcedTalkMode;
        if (p.forcedTalkMode) {
          tl.talkMode = p.forcedTalkMode;
          notice(t.id, "forcedPtt", "The producer set you to hold-to-talk");
        }
      }
      save();
      livekitUpdateMetadata(t);
      ack();
      upsert(t, true);
      // a changed admin flag changes what that device's welcome would contain
      if (p.isAdmin !== undefined && sessions.get(t.id)) welcome(sessions.get(t.id));
      return;
    }
    case "admin.device.mute": {
      requireAdmin(d);
      const t = db.devices[p.deviceId];
      if (!t || t.revoked) throw ["not_found", "no such device"];
      t.adminMuted = !!p.muted;
      if (t.adminMuted) liveOf(t).micLive = false;
      save();
      // LiveKit only allows server-side *mute*; unmute is the client's own next PTT press
      if (t.adminMuted) livekitMute(t.id, true);
      notice(t.id, t.adminMuted ? "muted" : "unmuted", t.adminMuted ? "The producer muted your mic" : "The producer unmuted your mic");
      ack();
      return upsert(t, true);
    }
    case "admin.device.remove": {
      requireAdmin(d);
      const t = db.devices[p.deviceId];
      if (!t) throw ["not_found", "no such device"];
      t.revoked = true;
      save();
      const o = sessions.get(t.id);
      if (o) {
        send(o, "kicked", { reason: "removed_by_admin" });
        setTimeout(() => o.ws.close(4004, "removed"), 100);
      }
      roomService("RemoveParticipant", { room: ROOM, identity: t.id });
      live.delete(t.id);
      broadcast("device.removed", { deviceId: t.id });
      return ack();
    }
    case "admin.device.forget": {
      requireAdmin(d);
      const t = db.devices[p.deviceId];
      if (!t) throw ["not_found", "no such device"];
      if (sessions.get(t.id)) throw ["bad_request", "device is online; remove it first"];
      delete db.devices[t.id];
      live.delete(t.id);
      save();
      broadcast("device.removed", { deviceId: t.id });
      return ack();
    }
    case "admin.group.create": {
      requireAdmin(d);
      const name = String(p.name ?? "").trim().slice(0, 40);
      if (!name) throw ["bad_request", "name required"];
      let id = slug(name);
      for (let i = 2; groupById(id); i++) id = `${slug(name).slice(0, 29)}-${i}`;
      db.groups.push({ id, name, color: p.color ?? "#64748b", sortOrder: Math.max(-1, ...db.groups.map((g) => g.sortOrder)) + 1, defaultTalkMode: p.defaultTalkMode ?? null });
      // admins may address and hear every group
      for (const a of activeDevices().filter((x) => x.isAdmin)) {
        a.canTalkGroupIds.push(id);
        a.listenGroupIds.push(id);
        upsert(a, true);
      }
      save();
      ack();
      return broadcast("groups.updated", { groups: sortedGroups() });
    }
    case "admin.group.update": {
      requireAdmin(d);
      const g = groupById(p.groupId);
      if (!g) throw ["not_found", "no such group"];
      if (p.name !== undefined) g.name = String(p.name).slice(0, 40);
      if (p.color !== undefined) g.color = p.color;
      if (p.sortOrder !== undefined) g.sortOrder = Number(p.sortOrder);
      if (p.defaultTalkMode !== undefined) g.defaultTalkMode = p.defaultTalkMode;
      save();
      ack();
      return broadcast("groups.updated", { groups: sortedGroups() });
    }
    case "admin.group.delete": {
      requireAdmin(d);
      const g = groupById(p.groupId);
      if (!g) throw ["not_found", "no such group"];
      if (!groupById(p.moveDevicesTo) || p.moveDevicesTo === p.groupId) throw ["bad_request", "moveDevicesTo must be another existing group"];
      if (db.groups.length <= 1) throw ["bad_request", "cannot delete the last group"];
      db.groups = db.groups.filter((x) => x.id !== g.id);
      for (const t of Object.values(db.devices)) {
        const tl = liveOf(t);
        if (t.groupId === g.id) {
          t.groupId = p.moveDevicesTo;
          tl.talkTargets = [`g:${p.moveDevicesTo}`];
          notice(t.id, "moved", `You were moved to ${groupById(p.moveDevicesTo).name}`);
        }
        t.listenGroupIds = t.listenGroupIds.filter((x) => x !== g.id);
        t.canTalkGroupIds = t.canTalkGroupIds.filter((x) => x !== g.id);
        if (!t.listenGroupIds.includes(t.groupId) && !t.isAdmin) t.listenGroupIds.push(t.groupId);
        if (!t.canTalkGroupIds.includes(t.groupId)) t.canTalkGroupIds.push(t.groupId);
        tl.talkTargets = tl.talkTargets.filter((x) => x !== `g:${g.id}`);
      }
      save();
      ack();
      broadcast("groups.updated", { groups: sortedGroups() });
      for (const t of activeDevices()) upsert(t, true);
      return;
    }
    case "admin.join.rotate":
      requireAdmin(d);
      db.server.joinCode = newCode();
      save();
      ack();
      return broadcastServer();
    case "admin.join.setOpen":
      requireAdmin(d);
      db.server.joinOpen = !!p.open;
      save();
      ack();
      return broadcastServer();
    case "admin.settings.update":
      requireAdmin(d);
      if (p.serverName !== undefined) db.server.name = String(p.serverName).slice(0, 60);
      if (p.crewCanBroadcast !== undefined) db.settings.crewCanBroadcast = !!p.crewCanBroadcast;
      if (p.defaultTalkMode !== undefined) db.settings.defaultTalkMode = p.defaultTalkMode === "latch" ? "latch" : "ptt";
      save();
      ack();
      broadcast("settings.updated", db.settings);
      if (p.serverName !== undefined) {
        broadcastServer();
        advertise();
      }
      return;
    default:
      if (msg.type === "auth") throw ["bad_request", "already authenticated"];
      throw ["bad_request", `unknown type ${msg.type}`];
  }
}

// ---------------------------------------------------------------- mDNS (macOS dns-sd / Linux avahi-publish)

let mdnsProc = null;
function advertise() {
  if (NO_MDNS) return;
  mdnsProc?.kill();
  const txt = [`v=1`, `id=${db.server.serverId}`, `name=${db.server.name}`, `fp=${tls.fp}`];
  const cmd = process.platform === "darwin" ? ["dns-sd", ["-R", db.server.name, "_partyline._tcp", "local", String(PORT), ...txt]] : ["avahi-publish", ["-s", db.server.name, "_partyline._tcp", String(PORT), ...txt]];
  try {
    mdnsProc = spawn(cmd[0], cmd[1], { stdio: "ignore" });
    mdnsProc.on("error", () => log("mDNS advertising unavailable (no dns-sd/avahi-publish)"));
  } catch {}
}

// ---------------------------------------------------------------- optional: start livekit-server --dev

let lkProc = null;
function startLivekit() {
  const ip = lanIPv4s()[0] ?? "127.0.0.1";
  log(`starting livekit-server --dev --bind 127.0.0.1 --node-ip ${ip}`);
  lkProc = spawn("livekit-server", ["--dev", "--bind", "127.0.0.1", "--node-ip", ip], { stdio: ["ignore", "inherit", "inherit"] });
  lkProc.on("error", (e) => log(`could not start livekit-server: ${e.message} (brew install livekit)`));
}

// ---------------------------------------------------------------- go

if (START_LIVEKIT) startLivekit();
server.listen(PORT, "0.0.0.0", () => {
  const ips = lanIPv4s();
  log(`PartyLine mock server "${db.server.name}"  id=${db.server.serverId}`);
  log(`  https://${ips[0] ?? "localhost"}:${PORT}   join code ${db.server.joinCode}`);
  log(`  fingerprint ${tls.fp}`);
  log(`  join link   https://${ips[0] ?? "localhost"}:${PORT}/#join?code=${db.server.joinCode}&fp=${tls.fp}&id=${db.server.serverId}`);
  log(`  /rtc -> ${LIVEKIT_HTTP}   data ${DATA_DIR}`);
  advertise();
});
function shutdown() {
  broadcast("server.shutdown", { reconnectAfterMs: 3000 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(db, null, 2));
  mdnsProc?.kill();
  lkProc?.kill();
  setTimeout(() => process.exit(0), 150);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
