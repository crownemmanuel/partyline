// Session controller + store: control WS → roster → routing → audio engine (PROTOCOL §6).
import { create } from "zustand";
import type { Device, Group, Message, ServerInfo, ServerMessage, Settings, TalkMode, TargetRef, AdminNoticeKind } from "@partyline/protocol";
import * as api from "./api";
import { Control, type ControlStatus } from "./control";
import { LiveKitEngine, type AudioEngine, type NoiseState, type RtcState } from "./audio";
import { allowedListeners, playback, producerTarget, talkableGroups } from "./routing";
import * as id from "./identity";
import { beep, vibrate, notify, speak } from "./alerts";
import { setHeadsetControl, updateHeadsetState } from "./headset";

export type Phase = "boot" | "join" | "live" | "kicked";

export interface Toast {
  id: number;
  text: string;
  kind: AdminNoticeKind | "info" | "error" | "signal";
}

export interface State {
  phase: Phase;
  serverId: string | null;
  info: api.ApiError | null;
  meId: string | null;
  devices: Record<string, Device>;
  groups: Group[];
  server: ServerInfo | null;
  settings: Settings | null;
  messages: Message[];
  unread: number;
  /** live messages from others waiting in the pop-up (oldest first) */
  incoming: Message[];
  msgOpen: boolean;
  /** composer target to preselect when the panel opens (Reply) */
  replyTo: TargetRef | null;
  ws: ControlStatus;
  wsDetail: string;
  rtc: RtcState;
  micError: string | null;
  noise: NoiseState;
  noiseDetail: string | null;
  playbackBlocked: boolean;
  activeSpeakers: string[];
  localMute: Record<string, boolean>;
  localVolume: Record<string, number>;
  groupVolume: Record<string, number>;
  solo: string[];
  toasts: Toast[];
  signalFlash: number;
  replyHeld: boolean;
}

export const useStore = create<State>(() => ({
  phase: "boot",
  serverId: null,
  info: null,
  meId: null,
  devices: {},
  groups: [],
  server: null,
  settings: null,
  messages: [],
  unread: 0,
  incoming: [],
  msgOpen: false,
  replyTo: null,
  ws: "closed",
  wsDetail: "",
  rtc: "disconnected",
  micError: null,
  noise: id.prefs().noiseFilter ? "loading" : "off",
  noiseDetail: null,
  playbackBlocked: false,
  activeSpeakers: [],
  localMute: {},
  localVolume: {},
  groupVolume: {},
  solo: [],
  toasts: [],
  signalFlash: 0,
  replyHeld: false,
}));

const set = useStore.setState;
const get = useStore.getState;

export const selectMe = (s: State): Device | null => (s.meId ? s.devices[s.meId] ?? null : null);

let toastSeq = 0;
export function toast(text: string, kind: Toast["kind"] = "info", ms = 4000) {
  const t = { id: ++toastSeq, text, kind };
  set((s) => ({ toasts: [...s.toasts, t] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), ms);
}

// ------------------------------------------------------------------ controller

let control: Control | null = null;
let engine: AudioEngine | null = null;
let livekitToken: string | null = null;
let livekitUrl = "/rtc";
let rtcConnecting = false;
let wakeLock: any = null;
/** targets to restore after "reply to producer" is released */
let savedTargets: TargetRef[] | null = null;

export function connection() {
  return { control, engine };
}

/** Boot: §6.1 — known token → session, else join screen. */
export async function boot() {
  let info;
  try {
    info = await api.getInfo();
  } catch (e) {
    set({ phase: "join", info: e as api.ApiError });
    setTimeout(boot, 3000);
    return;
  }
  set({ serverId: info.serverId, info: null });
  const t = id.tokenFor(info.serverId);
  if (!t) {
    // the host's own console (loopback) needs no code and no questions
    if (info.localHost) {
      try {
        return await doJoin("", id.savedName() || "Producer");
      } catch {}
    }
    return set({ phase: "join" });
  }
  try {
    const s = await api.session(t);
    start(t, s.livekitToken, s.livekitUrl);
  } catch (e) {
    const err = e as api.ApiError;
    if (err.code === "revoked" || err.code === "invalid_token") {
      id.forgetToken(info.serverId);
      set({ phase: "join" });
      if (err.code === "revoked") toast("This device was removed by the producer. Join again with a code.", "error", 8000);
    } else {
      // server reachable but erroring: keep trying in the background
      set({ phase: "join", info: err });
      setTimeout(boot, 3000);
    }
  }
}

export async function doJoin(joinCode: string, displayName: string) {
  const info = await api.getInfo();
  const r = await api.join({ joinCode, deviceId: id.deviceId(), displayName, platform: isTauri() ? "desktop" : "web" });
  id.saveToken(info.serverId, { token: r.deviceToken, name: info.name, fingerprint: info.fingerprint });
  id.saveName(displayName);
  set({ serverId: info.serverId });
  start(r.deviceToken, r.livekitToken, r.livekitUrl);
}

function start(t: string, lkToken: string, lkUrl: string) {
  livekitToken = lkToken;
  livekitUrl = lkUrl;
  set({ phase: "live", meId: id.deviceId() });
  control?.stop();
  control = new Control(t, {
    onMessage,
    onStatus: (ws, detail) => {
      set({ ws, wsDetail: detail ?? "" });
      if (ws === "reconnecting") beep("reconnect");
    },
    onFatal: (code) => {
      if (code === "kicked") {
        leave(true);
        set({ phase: "kicked" });
      } else {
        leave(true);
        set({ phase: "join" });
        if (code === "revoked") toast("This device was removed by the producer.", "error", 8000);
      }
    },
  });
  control.start();
  watchEnvironment();
}

export async function leave(forget = false) {
  control?.stop();
  control = null;
  await engine?.disconnect().catch(() => {});
  engine = null;
  rtcConnecting = false;
  wakeLock?.release?.().catch?.(() => {});
  wakeLock = null;
  if (forget && get().serverId) id.forgetToken(get().serverId!);
  set({ rtc: "disconnected", devices: {}, messages: [], unread: 0, incoming: [], msgOpen: false, replyTo: null });
}

function onMessage(m: ServerMessage) {
  switch (m.type) {
    case "welcome": {
      const p = m.payload;
      livekitToken = p.livekitToken;
      const devices: Record<string, Device> = {};
      for (const d of p.devices) devices[d.id] = d;
      devices[p.me.id] = { ...p.me, ...(devices[p.me.id] ?? {}) };
      const prevMe = selectMe(get());
      set({ meId: p.me.id, devices, groups: p.groups, server: p.server, settings: p.settings, messages: p.messages });
      // restore local intent after a reconnect: talk mode, and mic off (never come back live)
      const restoredMode = id.savedTalkMode();
      const me = devices[p.me.id];
      const patch: Record<string, unknown> = { micLive: false, speakerMuted: prevMe?.live.speakerMuted ?? me.live.speakerMuted };
      if (restoredMode && !me.forcedTalkMode && restoredMode !== me.live.talkMode) patch.talkMode = restoredMode;
      stateSet(patch);
      engine?.setMicLive(false);
      ensureRtc();
      reroute();
      return;
    }
    case "device.upsert": {
      const d = m.payload;
      const prev = get().devices[d.id];
      const meId = get().meId;
      if (d.id === meId && prev) {
        // keep my optimistic local mic/targets; the server echo can lag a held PTT
        const merged = { ...d, live: { ...d.live } };
        if (d.adminMuted) merged.live.micLive = false;
        else if (pendingLocal > 0) merged.live.micLive = prev.live.micLive;
        if (get().replyHeld) merged.live.talkTargets = prev.live.talkTargets;
        set((s) => ({ devices: { ...s.devices, [d.id]: merged } }));
        if (d.adminMuted && prev.live.micLive) engine?.setMicLive(false);
      } else {
        set((s) => ({ devices: { ...s.devices, [d.id]: d } }));
      }
      reroute();
      return;
    }
    case "device.removed":
      set((s) => {
        const devices = { ...s.devices };
        delete devices[m.payload.deviceId];
        return { devices };
      });
      reroute();
      return;
    case "groups.updated":
      set({ groups: m.payload.groups });
      reroute();
      return;
    case "server.updated":
      set({ server: m.payload });
      return;
    case "settings.updated":
      set({ settings: m.payload });
      reroute();
      return;
    case "message": {
      const msg = m.payload;
      const mine = msg.from === get().meId;
      const seen = mine || get().msgOpen;
      set((s) => ({
        messages: [...s.messages.filter((x) => x.id !== msg.id), msg].slice(-300),
        unread: seen ? s.unread : s.unread + 1,
        incoming: seen ? s.incoming : [...s.incoming.filter((x) => x.id !== msg.id), msg],
      }));
      if (!mine && seen) ackMessages([msg]);
      if (!mine) {
        beep("message");
        vibrate([80, 60, 80]);
        const from = get().devices[msg.from]?.displayName ?? "Producer";
        notify(`${from}`, msg.text);
        if (id.prefs().tts) speak(`${from} says ${msg.text}`);
      }
      return;
    }
    case "message.acked":
      set((s) => ({
        messages: s.messages.map((x) => (x.id === m.payload.messageId ? { ...x, ackedBy: [...new Set([...(x.ackedBy ?? []), m.payload.deviceId])] } : x)),
      }));
      return;
    case "signal": {
      const from = get().devices[m.payload.from]?.displayName ?? "Someone";
      beep("signal");
      vibrate([200, 100, 200, 100, 200]);
      set({ signalFlash: Date.now() });
      toast(`${from} is calling you`, "signal", 5000);
      notify("PartyLine", `${from} is calling you`);
      return;
    }
    case "token.refreshed":
      livekitToken = m.payload.livekitToken;
      return;
    case "admin.notice":
      toast(m.payload.text, m.payload.kind, 6000);
      notify("PartyLine", m.payload.text);
      beep("message");
      return;
    case "kicked":
      toast("You were removed by the producer.", "error", 10000);
      return;
    case "server.shutdown":
      toast("The host is restarting. Reconnecting…", "info", 5000);
      return;
    case "error":
      toast(m.payload.message, "error");
      return;
    default:
      return;
  }
}

async function ensureRtc() {
  if (engine || rtcConnecting || !livekitToken) return;
  rtcConnecting = true;
  const p = id.prefs();
  const e = new LiveKitEngine(
    {
      state: (rtc) => {
        set({ rtc });
        sendStatus(true);
      },
      localSpeaking: (speaking) => {
        localSpeaking = speaking;
        sendStatus(true);
      },
      activeSpeakers: (ids) => set({ activeSpeakers: ids }),
      tracksChanged: () => applyPlayback(),
      playbackBlocked: (b) => set({ playbackBlocked: b }),
      micError: (msg) => {
        set({ micError: msg });
        toast(`Microphone: ${msg}`, "error", 8000);
      },
      noiseState: (noise, detail) => {
        if (detail && detail !== get().noiseDetail) toast(detail, "info", 6000);
        set({ noise, noiseDetail: detail ?? null });
      },
    },
    p.inputDeviceId,
    p.outputDeviceId,
    p.noiseFilter,
  );
  engine = e;
  try {
    await e.connect(livekitUrl, livekitToken);
    reroute();
    requestWakeLock();
    setHeadsetControl(id.prefs().headsetButton, toggleMicFromHeadset);
    refreshHeadsetCard(true);
  } catch (err: any) {
    toast(`Audio connection failed: ${err?.message ?? err}`, "error", 6000);
    engine = null;
    setTimeout(ensureRtc, 3000);
  } finally {
    rtcConnecting = false;
  }
}

/** Recompute publisher permissions and receiver playback (PROTOCOL §5.1). */
export function reroute() {
  const s = get();
  const me = selectMe(s);
  if (!me || !engine) return;
  engine.setAllowedListeners(allowedListeners(me, Object.values(s.devices), s.settings ?? undefined));
  applyPlayback();
}
function applyPlayback() {
  const s = get();
  const me = selectMe(s);
  if (!me || !engine) return;
  const mix = { speakerMuted: me.live.speakerMuted, localMute: s.localMute, localVolume: s.localVolume, solo: s.solo, groupVolume: s.groupVolume };
  for (const ident of engine.remoteIdentities()) {
    const p = playback(me, s.devices[ident], mix);
    engine.setPlayback(ident, p.enabled, p.volume);
  }
}

// ------------------------------------------------------------------ actions

/** number of local state changes not yet echoed by the server */
let pendingLocal = 0;

/** Optimistic local update + state.set (PROTOCOL §6.3: do not wait for the ack). */
function stateSet(patch: Partial<Device["live"]> & { listenGroupIds?: string[] }) {
  const s = get();
  const me = selectMe(s);
  if (!me) return;
  const { listenGroupIds, ...livePatch } = patch;
  const next: Device = { ...me, ...(listenGroupIds ? { listenGroupIds } : {}), live: { ...me.live, ...livePatch } };
  set({ devices: { ...s.devices, [me.id]: next } });
  reroute();
  pendingLocal++;
  control
    ?.send("state.set", patch as any, true)
    .catch((e) => {
      if (e.code !== "offline") toast(e.message, "error");
    })
    .finally(() => {
      pendingLocal = Math.max(0, pendingLocal - 1);
    });
}

export function setMicLive(live: boolean) {
  const me = selectMe(get());
  if (!me) return;
  if (live && me.adminMuted) {
    toast("The producer muted your mic", "muted");
    return;
  }
  if (me.live.micLive === live) return;
  engine?.setMicLive(live);
  stateSet({ micLive: live });
  vibrate(live ? 25 : 15);
}

/** Headset / lock-screen button: tap to talk, tap again to stop (whatever the talk mode). */
export function toggleMicFromHeadset() {
  const me = selectMe(get());
  if (!me) return;
  const live = !me.live.micLive;
  if (live && me.adminMuted) {
    beep("denied");
    return toast("The producer muted your mic", "muted");
  }
  if (live && me.isAdmin && !me.live.talkTargets.length) {
    beep("denied");
    return toast("Pick who to talk to first", "error");
  }
  setMicLive(live);
  beep(live ? "micOn" : "micOff");
}
export function setHeadsetButton(on: boolean) {
  id.savePrefs({ headsetButton: on });
  setHeadsetControl(on, toggleMicFromHeadset);
  if (on) refreshHeadsetCard(true);
}

// keep the lock-screen card in step with the mic and group
let headsetCard = "";
function refreshHeadsetCard(force = false) {
  const s = get();
  const me = selectMe(s);
  if (!me) return;
  const group = s.groups.find((g) => g.id === me.groupId)?.name ?? "";
  const key = `${me.live.micLive}|${group}|${s.server?.name}`;
  if (!force && key === headsetCard) return;
  headsetCard = key;
  updateHeadsetState(me.live.micLive, group, s.server?.name ?? "");
}
useStore.subscribe(() => refreshHeadsetCard());

export function setTalkTargets(targets: TargetRef[], micLive?: boolean) {
  const me = selectMe(get());
  if (!me) return;
  const patch: Partial<Device["live"]> = { talkTargets: targets };
  if (micLive !== undefined && !(micLive && me.adminMuted)) {
    patch.micLive = micLive;
    engine?.setMicLive(micLive);
  }
  stateSet(patch);
}

export function setSpeakerMuted(muted: boolean) {
  stateSet({ speakerMuted: muted });
}
export function setTalkMode(mode: TalkMode) {
  id.saveTalkMode(mode);
  const me = selectMe(get());
  if (me?.live.micLive) setMicLive(false);
  stateSet({ talkMode: mode });
}
export function setListenGroups(groupIds: string[]) {
  stateSet({ listenGroupIds: groupIds });
}

/** "Reply to producer" (§6.4): hold → talk only to the first online admin; release → restore. */
export function replyToProducer(held: boolean) {
  const s = get();
  const me = selectMe(s);
  if (!me) return;
  if (held) {
    const t = producerTarget(me, Object.values(s.devices));
    if (!t) return toast("No producer online", "error");
    savedTargets = me.live.talkTargets;
    set({ replyHeld: true });
    setTalkTargets([t], true);
  } else if (s.replyHeld) {
    set({ replyHeld: false });
    setTalkTargets(savedTargets ?? [`g:${me.groupId}` as TargetRef], false);
    savedTargets = null;
  }
}

export function defaultTargets(me: Device, groups: Group[]): TargetRef[] {
  const ok = talkableGroups(me, groups.map((g) => g.id));
  return ok.includes(me.groupId) ? [`g:${me.groupId}`] : ok.slice(0, 1).map((g) => `g:${g}` as TargetRef);
}

export const send = <T extends Parameters<Control["send"]>[0]>(type: T, payload: Parameters<Control["send"]>[1] & {}, wantAck = true) =>
  (control?.send(type, payload as any, wantAck) ?? Promise.reject(new Error("Not connected"))).catch((e) => {
    toast(e.message, "error");
    throw e;
  });

export function setLocalMute(deviceId: string, muted: boolean) {
  set((s) => ({ localMute: { ...s.localMute, [deviceId]: muted } }));
  applyPlayback();
}
export function setLocalVolume(deviceId: string, v: number) {
  set((s) => ({ localVolume: { ...s.localVolume, [deviceId]: v } }));
  applyPlayback();
}
export function setGroupVolume(groupId: string, v: number) {
  set((s) => ({ groupVolume: { ...s.groupVolume, [groupId]: v } }));
  applyPlayback();
}
export function toggleSolo(deviceId: string) {
  set((s) => ({ solo: s.solo.includes(deviceId) ? s.solo.filter((x) => x !== deviceId) : [...s.solo, deviceId] }));
  applyPlayback();
}
export function markRead() {
  set({ unread: 0 });
}

/** Read receipts (ARCHITECTURE §7): sent once a message has actually been shown and dismissed/opened. */
function ackMessages(msgs: Message[]) {
  const me = get().meId;
  for (const m of msgs) if (m.from !== me && !m.ackedBy?.includes(me ?? "")) send("message.ack", { messageId: m.id }, false).catch(() => {});
}

/** Who a reply goes to, within what this device may message (PROTOCOL §3 message.send). */
export function replyTarget(m: Message): TargetRef {
  const s = get();
  const me = selectMe(s);
  const from = s.devices[m.from];
  if (me?.isAdmin || from?.isAdmin) return `d:${m.from}` as TargetRef;
  if (m.to.startsWith("g:")) return m.to as TargetRef;
  if (m.to === "all" && s.settings?.crewCanBroadcast) return "all";
  return (me && producerTarget(me, Object.values(s.devices))) ?? (`g:${me?.groupId}` as TargetRef);
}

/** Open the in-place messages panel; everything shown counts as read. */
export function openMessages(replyTo: TargetRef | null = null) {
  ackMessages(get().messages);
  set({ msgOpen: true, replyTo, unread: 0, incoming: [] });
}
export function closeMessages() {
  set({ msgOpen: false, replyTo: null });
}
/** Close the pop-up for the front message (or all of them). */
export function dismissIncoming(all = false) {
  const q = get().incoming;
  const gone = all ? q : q.slice(0, 1);
  ackMessages(gone);
  set((s) => ({ incoming: s.incoming.slice(gone.length), unread: Math.max(0, s.unread - gone.length) }));
}
export async function startAudio() {
  await engine?.startAudio();
}
/** Voice isolation button. Remembered per device; applies to the live mic immediately. */
export function setNoiseFilter(on: boolean) {
  id.savePrefs({ noiseFilter: on });
  set({ noise: on ? "loading" : "off", noiseDetail: null });
  void engine?.setNoiseFilter(on);
}
export async function switchDevice(kind: "audioinput" | "audiooutput", deviceId: string) {
  id.savePrefs(kind === "audioinput" ? { inputDeviceId: deviceId } : { outputDeviceId: deviceId });
  if (kind === "audioinput") await engine?.setInputDevice(deviceId);
  else await engine?.setOutputDevice(deviceId);
  detectHeadset();
}
export async function inboundPackets() {
  return (await engine?.inboundPackets()) ?? {};
}

// ------------------------------------------------------------------ status reporting (§6.8)

let localSpeaking = false;
let battery: { level: number; charging: boolean } | null = null;
let headset: boolean | null = null;
let lastStatus = 0;
let statusTimer = 0;
let lastSent = "";

function sendStatus(immediate = false) {
  const payload = {
    rtcConnected: get().rtc === "connected",
    speaking: localSpeaking && !!selectMe(get())?.live.micLive,
    ...(battery ? { battery: Math.round(battery.level * 100), charging: battery.charging } : {}),
    ...(headset !== null ? { headset } : {}),
    ...(engine?.rttMs() != null ? { rttMs: engine!.rttMs()! } : {}),
  };
  const key = JSON.stringify(payload);
  if (key === lastSent) return;
  const wait = immediate ? 0 : Math.max(0, 2000 - (Date.now() - lastStatus));
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    if (!control?.isOpen) return;
    lastStatus = Date.now();
    lastSent = key;
    control.send("status", payload);
  }, wait);
}

let watching = false;
function watchEnvironment() {
  if (watching) return;
  watching = true;
  (navigator as any).getBattery?.().then((b: any) => {
    const upd = () => {
      battery = { level: b.level, charging: b.charging };
      sendStatus();
    };
    upd();
    b.addEventListener("levelchange", upd);
    b.addEventListener("chargingchange", upd);
  });
  navigator.mediaDevices?.addEventListener?.("devicechange", detectHeadset);
  detectHeadset();
  setInterval(() => sendStatus(), 10_000); // rtt refresh
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      control?.kick();
      requestWakeLock();
    }
  });
  window.addEventListener("online", () => control?.kick());
}

/** Best-effort headset detection from the output device label (ARCHITECTURE §4.4). */
async function detectHeadset() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const outId = id.prefs().outputDeviceId ?? "default";
    const out = devs.find((d) => d.kind === "audiooutput" && d.deviceId === outId) ?? devs.find((d) => d.kind === "audiooutput");
    const label = (out?.label ?? "").toLowerCase();
    if (!label) return;
    headset = /head|ear|airpod|buds|bluetooth|usb|jabra|plantronics|poly|sennheiser|bose|sony wh|beats/.test(label) && !/speaker/.test(label);
    sendStatus();
  } catch {}
}

async function requestWakeLock() {
  try {
    if (document.visibilityState !== "visible" || wakeLock) return;
    wakeLock = await (navigator as any).wakeLock?.request("screen");
    wakeLock?.addEventListener?.("release", () => (wakeLock = null));
  } catch {
    wakeLock = null;
  }
}

// ------------------------------------------------------------------ Tauri

export function isTauri() {
  return typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
}
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (window as any).__TAURI_INTERNALS__.invoke(cmd, args);
}

// debugging handle for acceptance tests (getStats inbound packets)
(window as any).partyline = { get: () => get(), inboundPackets, reroute, send: (t: any, p: any) => control?.send(t, p, true), setMicLive, setNoiseFilter, setTalkTargets };
