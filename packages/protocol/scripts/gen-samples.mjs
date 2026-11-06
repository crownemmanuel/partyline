// Generates samples/*.json from one consistent fixture set (PROTOCOL.md §7).
// Run: node scripts/gen-samples.mjs   — the JSON files are committed; this is just how they were made.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "samples");
const ts = "2026-11-05T18:02:11Z";
const SERVER_ID = "6e2a1c4e-9b1f-4d3a-8c2e-1f0a9b7c5d31";
const ADMIN_ID = "a0d1e5f2-7c3b-4e8a-9f60-2b4c6d8e0a11";
const CAM2_ID = "0f3c8a72-5d14-4b9e-a6c3-7e21f9d04b58";
const FP = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const LK = "eyJhbGciOiJIUzI1NiJ9.SAMPLE.livekit-token";
const DEVICE_TOKEN = "q3J8v2mY0bXo5nQ1zR7tL4wK9eH6uA2sD8fG3jP0cVk";

const groups = [
  { id: "producer", name: "Producer", color: "#e11d48", sortOrder: 0, defaultTalkMode: "latch" },
  { id: "camera", name: "Camera", color: "#2563eb", sortOrder: 1, defaultTalkMode: null },
  { id: "backstage", name: "Backstage", color: "#16a34a", sortOrder: 2, defaultTalkMode: null },
];
const live = (o = {}) => ({
  online: true, rtcConnected: true, micLive: false, speakerMuted: false, talkMode: "ptt",
  talkTargets: [], speaking: false, battery: null, charging: null, headset: null,
  outputRoute: null, rttMs: null, ...o,
});
const admin = {
  id: ADMIN_ID, displayName: "Producer", platform: "desktop", appVersion: "0.1.0",
  groupId: "producer", listenGroupIds: ["producer", "camera", "backstage"],
  canTalkGroupIds: ["producer", "camera", "backstage"], isAdmin: true, forcedTalkMode: null,
  adminMuted: false, createdAt: "2026-11-04T09:00:00Z", lastSeenAt: ts,
  live: live({ talkMode: "latch", talkTargets: ["g:camera"] }),
};
const cam2 = {
  id: CAM2_ID, displayName: "Camera 2", platform: "ios", appVersion: "0.1.0",
  groupId: "camera", listenGroupIds: ["camera"], canTalkGroupIds: ["camera"], isAdmin: false,
  forcedTalkMode: null, adminMuted: false, createdAt: ts, lastSeenAt: ts,
  live: live({ online: false, rtcConnected: false, talkTargets: ["g:camera"] }),
};
const server = {
  serverId: SERVER_ID, name: "Emmanuel's MacBook", appVersion: "0.1.0", apiVersion: 1,
  joinCode: null, joinOpen: true, fingerprint: FP, failedJoinAttempts: 0,
};
const settings = {
  crewCanBroadcast: false, defaultTalkMode: "ptt",
  quickReplies: ["OK", "Standby", "Go", "Problem", "Can't hear"],
};
const msg = { id: "m-9", from: ADMIN_ID, to: "g:camera", kind: "text", text: "Cam 2 tighter please", ts };

const files = {
  "fixtures.json": { serverId: SERVER_ID, adminDeviceId: ADMIN_ID, sampleDeviceId: CAM2_ID, joinCode: "483920", deviceToken: DEVICE_TOKEN, fingerprint: FP },
  "rest/info.response.json": { apiVersion: 1, serverId: SERVER_ID, name: server.name, appVersion: "0.1.0", fingerprint: FP, joinOpen: true, livekitUrl: "/rtc", minClientVersion: "0.1.0" },
  "rest/join.request.json": { joinCode: "483920", deviceId: CAM2_ID, displayName: "Camera 2", platform: "ios", appVersion: "0.1.0", apiVersion: 1 },
  "rest/join.response.json": { deviceToken: DEVICE_TOKEN, livekitToken: LK, livekitUrl: "/rtc", roomName: "partyline", me: cam2, groups },
  "rest/session.request.json": { appVersion: "0.1.0", apiVersion: 1 },
  "rest/session.response.json": { livekitToken: LK, livekitUrl: "/rtc", roomName: "partyline", me: cam2, groups },
  "rest/messages.response.json": [msg],
  "rest/error.invalid_code.json": { error: { code: "invalid_code", message: "Wrong join code" } },
  "rest/error.rate_limited.json": { error: { code: "rate_limited", message: "Too many attempts, try again in 300 s" } },
  "rest/error.revoked.json": { error: { code: "revoked", message: "This device was removed by the admin" } },
  "ws/01-auth.json": { type: "auth", payload: { deviceToken: DEVICE_TOKEN, appVersion: "0.1.0" } },
  "ws/02-welcome.json": { type: "welcome", ts, payload: { me: { ...cam2, live: { ...cam2.live, online: true } }, devices: [admin, { ...cam2, live: { ...cam2.live, online: true } }], groups, server, settings, livekitToken: LK, roomName: "partyline", messages: [] } },
  "ws/03-state.set.json": { type: "state.set", id: "c-1", payload: { talkMode: "ptt", talkTargets: ["g:camera"], listenGroupIds: ["camera"] } },
  "ws/04-ack.json": { type: "ack", ts, payload: { replyTo: "c-1" } },
  "ws/05-device.upsert.json": { type: "device.upsert", ts, payload: { ...cam2, live: { ...cam2.live, online: true } } },
  "ws/06-state.set.micLive.json": { type: "state.set", payload: { micLive: true } },
  "ws/07-device.upsert.micLive.json": { type: "device.upsert", ts, payload: { ...cam2, live: { ...cam2.live, online: true, micLive: true } } },
  "ws/08-state.set.micOff.json": { type: "state.set", payload: { micLive: false } },
  "ws/09-message.json": { type: "message", ts, payload: msg },
  "ws/10-message.ack.json": { type: "message.ack", payload: { messageId: "m-9" } },
  "ws/ping.json": { type: "ping", payload: {} },
  "ws/pong.json": { type: "pong", ts, payload: {} },
  "ws/status.json": { type: "status", payload: { rtcConnected: true, speaking: false, battery: 82, charging: false, headset: true, rttMs: 12, outputRoute: "headset" } },
  "ws/message.send.quick.json": { type: "message.send", id: "c-2", payload: { to: `d:${ADMIN_ID}`, text: "OK", kind: "quick" } },
  "ws/signal.send.json": { type: "signal.send", payload: { to: `d:${ADMIN_ID}` } },
  "ws/signal.json": { type: "signal", ts, payload: { from: ADMIN_ID, to: "g:camera" } },
  "ws/error.json": { type: "error", ts, payload: { replyTo: "c-1", code: "bad_request", message: "talkTargets: not allowed to talk to g:backstage" } },
  "ws/groups.updated.json": { type: "groups.updated", ts, payload: { groups } },
  "ws/server.updated.json": { type: "server.updated", ts, payload: server },
  "ws/settings.updated.json": { type: "settings.updated", ts, payload: settings },
  "ws/device.removed.json": { type: "device.removed", ts, payload: { deviceId: CAM2_ID } },
  "ws/token.refreshed.json": { type: "token.refreshed", ts, payload: { livekitToken: LK } },
  "ws/admin.notice.muted.json": { type: "admin.notice", ts, payload: { kind: "muted", text: "The producer muted your mic" } },
  "ws/admin.notice.moved.json": { type: "admin.notice", ts, payload: { kind: "moved", text: "You were moved to Backstage" } },
  "ws/kicked.json": { type: "kicked", ts, payload: { reason: "removed_by_admin" } },
  "ws/server.shutdown.json": { type: "server.shutdown", ts, payload: { reconnectAfterMs: 3000 } },
  "ws/admin.device.mute.json": { type: "admin.device.mute", id: "c-3", payload: { deviceId: CAM2_ID, muted: true } },
  "ws/admin.device.update.json": { type: "admin.device.update", id: "c-4", payload: { deviceId: CAM2_ID, groupId: "backstage", listenGroupIds: ["backstage"], canTalkGroupIds: ["backstage"] } },
};
for (const [p, v] of Object.entries(files)) {
  const f = join(root, p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
}
console.log(`wrote ${Object.keys(files).length} samples`);
