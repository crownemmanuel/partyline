import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { UpdateNotice } from "../components/UpdateNotice";
import type { Device, Group, TargetRef, TalkMode } from "@partyline/protocol";
import {
  isTauri,
  invoke,
  selectMe,
  send,
  setGroupVolume,
  setListenGroups,
  setLocalMute,
  setMicLive,
  setSpeakerMuted,
  setTalkMode,
  setTalkTargets,
  toast,
  toggleSolo,
  useStore,
} from "../lib/session";
import { TalkButton } from "../components/TalkButton";
import { AudioUnlock, Badge, ConnDot, VoiceIsolationButton, groupName, useTalkingToMe } from "../components/common";
import {
  BatteryIcon,
  BellIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  ExpandIcon,
  GearIcon,
  HeadphonesIcon,
  LayersIcon,
  LockIcon,
  MegaphoneIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  PhoneIcon,
  PowerIcon,
  RefreshIcon,
  SignalIcon,
  SpeakerIcon,
  SpeakerOffIcon,
  TargetIcon,
  UnlockIcon,
  WaveIcon,
} from "../components/icons";
import { MessagesButton, MessagesDock, targetLabel } from "./Messages";
import { SettingsSheet, Row } from "./Settings";
import { Sheet } from "../components/Sheet";

// shared look: neutral cards, flat icon buttons (matches the crew screen and native apps)
const card = "rounded-2xl border border-white/[0.06] bg-neutral-900/80";
const btnBase = "inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const ghost = "bg-white/[0.06] text-slate-200 hover:bg-white/[0.1]";
const sm = "px-2.5 py-1.5 text-xs";
const icon = "h-4 w-4";

/** Producer / admin console (ARCHITECTURE §10, DESKTOP.md screen 4). */
export function Admin() {
  const s = useStore();
  const me = selectMe(s)!;
  const [sheet, setSheet] = useState<"settings" | "server" | null>(null);
  const talking = useTalkingToMe();

  return (
    <div className="flex min-h-full flex-col bg-neutral-950">
      <AudioUnlock />
      <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-white/[0.06] px-5 py-4">
        <div className="mr-auto flex min-w-0 items-center gap-3">
          <img src="/favicon.png?v=2" alt="" className="h-10 w-10 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold">{s.server?.name}</div>
            <div className="flex items-center gap-3 text-xs">
              <ConnDot />
              <span className={`flex min-w-0 items-center gap-1 ${talking.length ? "text-emerald-400" : "text-slate-500"}`}>
                <WaveIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{talking.length ? talking.map((d) => d.displayName).join(", ") : "Quiet"}</span>
              </span>
            </div>
          </div>
        </div>
        <JoinPanel />
        <div className="flex items-center gap-2">
          <MessagesButton className={`${btnBase} ${ghost} px-3 py-2 text-sm sm:hidden`} />
          <button onClick={() => setSheet("server")} className={`${btnBase} ${ghost} px-3 py-2 text-sm`}>
            <LayersIcon className={icon} />
            Groups & server
          </button>
          <button onClick={() => setSheet("settings")} className={`${btnBase} ${ghost} px-3 py-2 text-sm`} title="Your settings">
            <GearIcon className={icon} />
            {me.displayName}
          </button>
        </div>
      </header>
      {isTauri() && <HostPanel />}
      <main className="grid flex-1 grid-cols-1 gap-4 p-4 sm:p-5 sm:pb-24 lg:grid-cols-[minmax(340px,420px)_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <TalkPanel />
        </div>
        <DevicesPanel />
      </main>
      {sheet === "settings" && <SettingsSheet onClose={() => setSheet(null)} />}
      {sheet === "server" && <ServerSheet onClose={() => setSheet(null)} />}
      <MessagesDock bubble="desktop" />
    </div>
  );
}

// ------------------------------------------------------------------ join code + QR

function useLanBase() {
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    if (!/^(localhost|127\.|\[::1\])/.test(location.hostname)) return setBase(location.origin);
    // On the host machine: the server lists its LAN URLs to loopback callers; refresh so an IP change updates the QR.
    const load = async () => {
      let urls: string[] = [];
      try {
        urls = (await fetch("/api/info", { cache: "no-store" }).then((r) => r.json())).lanUrls ?? [];
      } catch {}
      if (!urls.length && isTauri()) urls = await invoke<{ lanUrls: string[] }>("get_local_info").then((i) => i.lanUrls).catch(() => []);
      setBase(urls[0] ?? null);
    };
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  return base;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // older WebKit / no clipboard permission: classic selection copy
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) return toast("Couldn't copy. Select the link and copy it by hand.", "error");
  }
  toast("Join link copied", "info", 2500);
}

function CopyLinkButton({ link, className = "" }: { link: string; className?: string }) {
  return (
    <button onClick={() => copyText(link)} title={link} className={`${btnBase} ${ghost} ${sm} ${className}`}>
      <CopyIcon className={icon} />
      Copy link
    </button>
  );
}

function JoinPanel() {
  const server = useStore((s) => s.server);
  const [qr, setQr] = useState(false);
  const [appQr, setAppQr] = useState(false);
  const base = useLanBase();
  if (!server) return null;
  const params = server.joinCode ? `code=${server.joinCode}&fp=${server.fingerprint}&id=${server.serverId}` : null;
  const link = base && params ? `${base}/#join?${params}` : null;
  const installLink = base && params ? `${base}/#install&${params}` : null;
  return (
    <div className={`${card} flex items-center gap-4 p-2.5 pr-4`}>
      {link && server.joinOpen ? (
        <button onClick={() => setQr(true)} title="Scan with a phone camera to join. Click to enlarge." className="rounded-lg bg-white p-1.5 transition-transform hover:scale-105">
          <QRCodeSVG value={link} size={76} />
        </button>
      ) : (
        <div className="flex h-[88px] w-[88px] items-center justify-center rounded-lg bg-white/[0.04] text-slate-600">
          <LockIcon className="h-8 w-8" />
        </div>
      )}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{server.joinOpen ? "Join code" : "Joining closed"}</div>
            <div className={`font-mono text-3xl font-bold tabular-nums tracking-[0.15em] ${server.joinOpen ? "" : "text-slate-600 line-through"}`}>{server.joinCode}</div>
          </div>
          <span className={`text-[11px] ${server.failedJoinAttempts ? "text-amber-400" : "text-slate-600"}`} title="Failed join attempts in the last hour">
            {server.failedJoinAttempts} failed
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {link && <CopyLinkButton link={link} />}
          <button onClick={() => setQr(true)} className={`${btnBase} ${ghost} ${sm}`} title="Show a big QR code">
            <ExpandIcon className={icon} />
            Big QR
          </button>
          <button onClick={() => setAppQr(true)} className={`${btnBase} ${ghost} ${sm}`} title="QR and link for installing the phone app">
            <PhoneIcon className={icon} />
            Get the app
          </button>
          <button onClick={() => send("admin.join.rotate", {})} className={`${btnBase} ${ghost} ${sm}`} title="Make a new join code (devices already joined stay)">
            <RefreshIcon className={icon} />
            New code
          </button>
          <button
            onClick={() => send("admin.join.setOpen", { open: !server.joinOpen })}
            className={`${btnBase} ${sm} ${server.joinOpen ? ghost : "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"}`}
            title={server.joinOpen ? "Stop new devices joining" : "Let new devices join"}
          >
            {server.joinOpen ? <LockIcon className={icon} /> : <UnlockIcon className={icon} />}
            {server.joinOpen ? "Close joining" : "Open joining"}
          </button>
        </div>
      </div>
      {appQr && <AppSheet link={installLink} onClose={() => setAppQr(false)} />}
      {qr && (
        <Sheet title="Scan to join" onClose={() => setQr(false)}>
          <div className="flex flex-col items-center gap-4">
            {link ? (
              <>
                <div className="rounded-2xl bg-white p-4">
                  <QRCodeSVG value={link} size={260} />
                </div>
                <div className="font-mono text-4xl font-bold tracking-[0.15em]">{server.joinCode}</div>
                <div className="flex w-full items-center gap-2">
                  <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 font-mono text-xs" aria-label="Join link" />
                  <CopyLinkButton link={link} className="shrink-0 py-2" />
                </div>
                <div className="text-center text-xs text-slate-500">
                  Send this link to anyone on the same Wi-Fi; it opens the join page with the code filled in.
                </div>
                <div className="text-center text-sm text-slate-400">
                  Phones: open the camera and scan. The browser warns about the certificate once; tap through to continue.
                </div>
              </>
            ) : (
              <div className="text-slate-400">No LAN address found. Connect this computer to the show's Wi-Fi.</div>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** QR + link to the /#install page (Android APK from this host, iPhone via TestFlight). */
function AppSheet({ link, onClose }: { link: string | null; onClose(): void }) {
  const [info, setInfo] = useState<{ androidApk?: { size: number } | null; iosInstallUrl?: string | null } | null>(null);
  useEffect(() => {
    fetch("/api/info", { cache: "no-store" })
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {});
  }, []);
  const row = (ok: boolean, label: string, detail: string) => (
    <div className="flex items-start gap-2 text-sm">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ok ? "bg-emerald-400" : "bg-amber-400"}`} />
      <span>
        <b className="font-semibold">{label}</b> <span className="text-slate-400">{detail}</span>
      </span>
    </div>
  );
  return (
    <Sheet title="Get the phone app" onClose={onClose}>
      <div className="flex flex-col items-center gap-4">
        {link ? (
          <>
            <div className="rounded-2xl bg-white p-4">
              <QRCodeSVG value={link} size={240} />
            </div>
            <div className="flex w-full items-center gap-2">
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 font-mono text-xs" aria-label="Install link" />
              <CopyLinkButton link={link} className="shrink-0 py-2" />
            </div>
            <div className="text-center text-sm text-slate-400">Scan with the phone's camera. The page shows install steps for Android and iPhone, with the join code already filled in.</div>
          </>
        ) : (
          <div className="text-slate-400">No LAN address found. Connect this computer to the show's Wi-Fi.</div>
        )}
        {info && (
          <div className="flex w-full flex-col gap-2 rounded-xl bg-black/40 p-3">
            {row(!!info.androidApk, "Android:", info.androidApk ? `app bundled (${(info.androidApk.size / 1048576).toFixed(0)} MB), downloads straight from this computer` : "no app bundled with this build; phones get the web app")}
            {row(!!info.iosInstallUrl, "iPhone:", info.iosInstallUrl ? "TestFlight link set" : "no TestFlight link yet (add one in Groups & server); iPhones get the web app")}
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ host status (Tauri host mode)

interface LocalInfo {
  role: "host" | "join" | "none";
  lanUrls: string[];
  livekit: { running: boolean; restarts: number; lastError: string | null };
  mdns: boolean;
  dataDir: string;
}
function HostPanel() {
  const [info, setInfo] = useState<LocalInfo | null>(null);
  useEffect(() => {
    const load = () => invoke<LocalInfo>("get_local_info").then(setInfo).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  if (!info || info.role !== "host") return null;
  const dot = (ok: boolean) => <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400"}`} />;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-white/[0.06] bg-neutral-900/50 px-5 py-2 text-xs text-slate-400">
        <span className="flex items-center gap-1.5">
          {dot(!!info.lanUrls[0])}Hosting at <b className="font-medium text-slate-200">{info.lanUrls[0] ?? "no LAN address"}</b>
        </span>
        <span className="flex items-center gap-1.5">
          {dot(info.livekit.running)}Audio server {info.livekit.running ? "running" : "down"}
          {info.livekit.restarts > 0 && ` (restarted ${info.livekit.restarts}×)`}
        </span>
        {info.livekit.lastError && <span className="text-red-400">{info.livekit.lastError}</span>}
        <span className="flex items-center gap-1.5">
          {dot(info.mdns)}
          {info.mdns ? "Discoverable on the network" : "mDNS off"}
        </span>
        <span className="hidden text-slate-600 xl:inline">If your firewall asks, allow PartyLine to accept incoming connections.</span>
        <button
          className={`${btnBase} ${sm} ml-auto border border-red-500/30 text-red-300 hover:bg-red-500/10`}
          onClick={() => confirm("Stop hosting? Everyone will be disconnected.") && invoke("host_stop").catch(() => {})}
        >
          <PowerIcon className="h-3.5 w-3.5" />
          Stop hosting
        </button>
      </div>
      <UpdateNotice hosting className="mx-5 mt-3" />
    </>
  );
}

// ------------------------------------------------------------------ talk / listen

/** Admin talk logic: PTT = hold a target; latch = tap targets on/off, mic live while any is on. */
function useTalk() {
  const me = useStore(selectMe)!;
  const mode: TalkMode = me.forcedTalkMode ?? me.live.talkMode;
  const targets = me.live.talkTargets;
  const isOn = (t: TargetRef[]) => me.live.micLive && t.length > 0 && t.every((x) => targets.includes(x));
  const press = (t: TargetRef[], active: boolean) => {
    if (mode === "ptt") {
      if (active) setTalkTargets(t, true);
      else setMicLive(false);
      return;
    }
    if (!me.live.micLive) return active && setTalkTargets(t, true);
    if (isOn(t)) {
      const rest = targets.filter((x) => !t.includes(x));
      if (rest.length) setTalkTargets(rest);
      else setMicLive(false);
    } else setTalkTargets([...new Set([...targets, ...t])]);
  };
  return { mode, isOn, press, targets, me };
}

const live = (on: boolean) => (on ? "bg-red-600 text-white shadow-[0_0_24px_rgba(220,38,38,.45)] hover:bg-red-600" : ghost);

function TalkPanel() {
  const groups = useStore((s) => s.groups);
  const devices = useStore((s) => s.devices);
  const groupVolume = useStore((s) => s.groupVolume);
  const { mode, isOn, press, me, targets } = useTalk();
  const all = groups.map((g) => `g:${g.id}` as TargetRef);

  return (
    <section className={`${card} p-4`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-base font-semibold">Talk & listen</div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setSpeakerMuted(!me.live.speakerMuted)}
            className={`${btnBase} ${sm} ${me.live.speakerMuted ? "bg-red-600 text-white" : ghost}`}
            title={me.live.speakerMuted ? "Speaker off: you hear nobody" : "Speaker on"}
          >
            {me.live.speakerMuted ? <SpeakerOffIcon className={icon} /> : <SpeakerIcon className={icon} />}
            {me.live.speakerMuted ? "Speaker off" : "Speaker"}
          </button>
          <VoiceIsolationButton className={`rounded-xl ${sm}`} />
        </div>
      </div>
      <div className="mb-3 grid grid-cols-2 rounded-xl bg-black/40 p-1" role="radiogroup" aria-label="Talk mode">
        {(["ptt", "latch"] as const).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={mode === m}
            disabled={!!me.forcedTalkMode}
            onClick={() => setTalkMode(m)}
            className={`rounded-lg py-1.5 text-xs font-semibold transition-colors ${mode === m ? "bg-white/[0.12] text-white" : "text-slate-500 hover:text-slate-300"}`}
          >
            {m === "ptt" ? "Hold to talk" : "Tap on / off"}
          </button>
        ))}
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <TalkButton mode={mode} active={isOn(all)} onChange={(a) => press(all, a)} disabled={me.adminMuted} className={`${btnBase} ${live(isOn(all))} py-4 text-base`}>
          <MegaphoneIcon className="h-5 w-5" />
          Talk to all
        </TalkButton>
        <TalkButton
          mode={mode}
          spaceBar
          active={me.live.micLive}
          disabled={me.adminMuted || targets.length === 0}
          onChange={setMicLive}
          className={`${btnBase} ${live(me.live.micLive)} py-4 text-base`}
          title="Space bar"
        >
          {me.live.micLive ? <MicIcon className="h-5 w-5" /> : <MicOffIcon className="h-5 w-5" />}
          {me.live.micLive ? "Live" : "Mic"}
          <kbd className="rounded-md border border-white/15 px-1.5 py-0.5 font-sans text-[10px] font-normal opacity-70">Space</kbd>
        </TalkButton>
      </div>
      <div className="mb-1 flex items-center gap-1.5 truncate text-xs text-slate-500">
        <MicIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Voice goes to: <span className="text-slate-300">{targets.length ? targets.map((t) => targetLabel(t, useStore.getState())).join(", ") : "nobody"}</span></span>
      </div>
      <div className="flex flex-col divide-y divide-white/[0.05]">
        {groups.map((g) => {
          const t = [`g:${g.id}` as TargetRef];
          const listening = me.listenGroupIds.includes(g.id);
          const count = Object.values(devices).filter((d) => d.groupId === g.id && d.live.online).length;
          return (
            <div key={g.id} className="flex items-center gap-2.5 py-2.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: g.color }} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{g.name}</div>
                <div className="text-[11px] text-slate-500">{count} online</div>
              </div>
              <label className="hidden items-center gap-1 text-slate-500 sm:flex" title="Listen volume">
                <SpeakerIcon className="h-3.5 w-3.5" />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={groupVolume[g.id] ?? 1}
                  onChange={(e) => setGroupVolume(g.id, Number(e.target.value))}
                  className="w-16 border-0 bg-transparent p-0 accent-[#3a7bd5]"
                />
              </label>
              <button
                onClick={() => setListenGroups(listening ? me.listenGroupIds.filter((x) => x !== g.id) : [...me.listenGroupIds, g.id])}
                aria-pressed={listening}
                className={`${btnBase} px-3 py-2 text-sm ${listening ? "bg-emerald-600/90 text-white hover:bg-emerald-600" : "bg-white/[0.04] text-slate-500 hover:bg-white/[0.08]"}`}
                title={listening ? "Listening to this group (click to stop)" : "Not listening (click to listen)"}
              >
                <HeadphonesIcon className={icon} />
                {listening ? "Listen" : "Off"}
              </button>
              <TalkButton mode={mode} active={isOn(t)} disabled={me.adminMuted} onChange={(a) => press(t, a)} className={`${btnBase} ${live(isOn(t))} px-3 py-2 text-sm`}>
                <MicIcon className={icon} />
                Talk
              </TalkButton>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ devices

function DevicesPanel() {
  const groups = useStore((s) => s.groups);
  const devices = useStore((s) => s.devices);
  const meId = useStore((s) => s.meId);
  const byGroup = useMemo(() => {
    const m = new Map<string, Device[]>();
    for (const g of groups) m.set(g.id, []);
    for (const d of Object.values(devices)) {
      if (!m.has(d.groupId)) m.set(d.groupId, []);
      m.get(d.groupId)!.push(d);
    }
    for (const l of m.values()) l.sort((a, b) => Number(b.live.online) - Number(a.live.online) || a.displayName.localeCompare(b.displayName));
    return m;
  }, [groups, devices]);

  return (
    <section className="flex min-w-0 flex-col gap-4">
      {[...byGroup.entries()].map(([gid, list]) => {
        const g = groups.find((x) => x.id === gid);
        const online = list.filter((d) => d.live.online).length;
        return (
          <div key={gid} className={`${card} p-4`}>
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: g?.color ?? "#666" }} />
              {groupName(groups, gid)}
              <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-slate-400">
                {online}/{list.length} online
              </span>
            </div>
            {list.length === 0 && <div className="py-3 text-sm text-slate-600">No devices</div>}
            <div className="flex flex-col divide-y divide-white/[0.05]">
              {list.map((d) => (
                <DeviceRow key={d.id} d={d} self={d.id === meId} groups={groups} color={g?.color ?? "#666"} />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

const PLATFORM: Record<string, string> = { ios: "iPhone", android: "Android", web: "Browser", desktop: "Desktop" };
const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

function DeviceRow({ d, self, groups, color }: { d: Device; self: boolean; groups: Group[]; color: string }) {
  const s = useStore();
  const { mode, isOn, press, me } = useTalk();
  const [menu, setMenu] = useState(false);
  const speaking = (d.live.speaking || s.activeSpeakers.includes(d.id)) && d.live.micLive;
  const t = [`d:${d.id}` as TargetRef];
  const localMuted = !!s.localMute[d.id];
  const solo = s.solo.includes(d.id);
  const lastSeen = new Date(d.lastSeenAt);
  const ring = speaking ? "ring-2 ring-emerald-400 shadow-[0_0_12px_rgba(52,211,153,.6)]" : d.live.micLive ? "ring-2 ring-amber-400" : "";
  const meta = "flex items-center gap-1";

  return (
    <div className={`py-3 ${d.live.online ? "" : "opacity-50"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${ring}`}
          style={{ background: `${color}33`, color }}
          title={speaking ? "speaking" : d.live.micLive ? "mic live" : d.live.online ? "online" : "offline"}
        >
          {initials(d.displayName)}
          <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-neutral-900 ${d.live.online ? "bg-emerald-400" : "bg-slate-600"}`} />
        </div>
        <div className="min-w-[11rem] flex-1">
          <div className="flex items-center gap-1.5 truncate">
            <span className="truncate font-medium">{d.displayName}</span>
            {self && <Badge>you</Badge>}
            {d.isAdmin && <Badge className="bg-[#3a7bd5]/20 text-[#8fb8f0]">admin</Badge>}
            {d.adminMuted && (
              <Badge className="flex items-center gap-1 bg-red-500/20 text-red-300">
                <LockIcon className="h-3 w-3" />
                muted
              </Badge>
            )}
            {d.forcedTalkMode && <Badge>forced hold</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-0.5 text-[11px] text-slate-500">
            <span>{PLATFORM[d.platform] ?? d.platform}</span>
            {d.live.online ? (
              <>
                {!d.live.rtcConnected && <span className="text-amber-400">no audio link</span>}
                <span>{d.live.talkMode === "ptt" ? "Hold" : "Tap"}</span>
                {d.live.speakerMuted && (
                  <span className={`${meta} text-red-400`}>
                    <SpeakerOffIcon className="h-3 w-3" />
                    speaker off
                  </span>
                )}
                {d.live.battery != null && (
                  <span className={`${meta} ${d.live.battery <= 15 && !d.live.charging ? "text-red-400" : ""}`}>
                    <BatteryIcon level={d.live.battery} charging={!!d.live.charging} className="h-3.5 w-3.5" />
                    {d.live.battery}%
                  </span>
                )}
                {d.live.headset != null && (
                  <span className={meta}>
                    <HeadphonesIcon className="h-3 w-3" />
                    {d.live.headset ? "headset" : "no headset"}
                  </span>
                )}
                {d.live.rttMs != null && (
                  <span className={meta}>
                    <SignalIcon className="h-3 w-3" />
                    {d.live.rttMs} ms
                  </span>
                )}
                <span>v{d.appVersion}</span>
              </>
            ) : (
              <span>last seen {lastSeen.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            )}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!self && (
            <>
              <TalkButton
                mode={mode}
                active={isOn(t)}
                disabled={me.adminMuted || !d.live.online}
                onChange={(a) => press(t, a)}
                className={`${btnBase} ${sm} ${live(isOn(t))}`}
                title="Talk to this device only"
              >
                <MicIcon className="h-3.5 w-3.5" />
                Talk
              </TalkButton>
              <button onClick={() => toggleSolo(d.id)} aria-pressed={solo} className={`${btnBase} ${sm} ${solo ? "bg-[#3a7bd5] text-white" : ghost}`} title="Solo: only hear soloed devices">
                <TargetIcon className="h-3.5 w-3.5" />
                Solo
              </button>
              <button
                onClick={() => setLocalMute(d.id, !localMuted)}
                aria-pressed={!localMuted}
                className={`${btnBase} ${sm} ${localMuted ? "bg-white/[0.03] text-slate-500 line-through" : ghost}`}
                title={localMuted ? "You've stopped hearing this device (click to hear again)" : "Stop hearing this device (only for you)"}
              >
                {localMuted ? <SpeakerOffIcon className="h-3.5 w-3.5" /> : <HeadphonesIcon className="h-3.5 w-3.5" />}
                Hear
              </button>
              <button
                onClick={() => send("admin.device.mute", { deviceId: d.id, muted: !d.adminMuted })}
                className={`${btnBase} ${sm} ${d.adminMuted ? "bg-red-600 text-white hover:bg-red-500" : ghost}`}
                title={d.adminMuted ? "Let this device talk again" : "Mute this device's microphone (enforced)"}
              >
                {d.adminMuted ? <MicIcon className="h-3.5 w-3.5" /> : <MicOffIcon className="h-3.5 w-3.5" />}
                {d.adminMuted ? "Unmute" : "Mute"}
              </button>
            </>
          )}
          <button onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="More" className={`${btnBase} ${ghost} h-7 w-8 ${menu ? "bg-white/[0.14]" : ""}`}>
            <MoreIcon className={icon} />
          </button>
        </div>
      </div>
      {menu && <DeviceMenu d={d} self={self} groups={groups} onDone={() => setMenu(false)} />}
    </div>
  );
}

function DeviceMenu({ d, self, groups, onDone }: { d: Device; self: boolean; groups: Group[]; onDone(): void }) {
  const [name, setName] = useState(d.displayName);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const upd = (p: Record<string, unknown>) => send("admin.device.update", { deviceId: d.id, ...p });
  const label = "mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500";
  const chip = (on: boolean, onColor: string) => `${btnBase} px-2.5 py-1 text-xs ${on ? onColor : "bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]"}`;
  return (
    <div className="mt-3 grid gap-4 rounded-xl border border-white/[0.06] bg-black/40 p-4 text-sm sm:grid-cols-2">
      <div>
        <div className={label}>Name</div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            upd({ displayName: name.trim() });
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="min-w-0 flex-1" />
          <button className={`${btnBase} ${ghost} px-3`}>Rename</button>
        </form>
      </div>
      <div>
        <div className={label}>Group</div>
        <select value={d.groupId} onChange={(e) => upd({ groupId: e.target.value })} className="w-full">
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
      {!d.isAdmin && (
        <>
          <div>
            <div className={label}>Hears</div>
            <div className="flex flex-wrap gap-1.5">
              {groups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => upd({ listenGroupIds: toggle(d.listenGroupIds, g.id), canTalkGroupIds: d.canTalkGroupIds.includes(g.id) || g.id === d.groupId ? d.canTalkGroupIds : [...d.canTalkGroupIds, g.id] })}
                  className={chip(d.listenGroupIds.includes(g.id), "bg-emerald-600/90 text-white")}
                >
                  <HeadphonesIcon className="h-3 w-3" />
                  {g.name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className={label}>May talk to</div>
            <div className="flex flex-wrap gap-1.5">
              {groups.map((g) => (
                <button key={g.id} onClick={() => upd({ canTalkGroupIds: toggle(d.canTalkGroupIds, g.id) })} className={chip(d.canTalkGroupIds.includes(g.id), "bg-[#3a7bd5] text-white")}>
                  <MicIcon className="h-3 w-3" />
                  {g.name}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      <div className="flex flex-wrap gap-2 border-t border-white/[0.06] pt-3 sm:col-span-2">
        <button onClick={() => upd({ forcedTalkMode: d.forcedTalkMode ? null : "ptt" })} className={`${btnBase} ${ghost} px-3 py-1.5`}>
          {d.forcedTalkMode ? "Allow tap on / off" : "Force hold to talk"}
        </button>
        {!self && (
          <>
            <button onClick={() => send("signal.send", { to: `d:${d.id}` })} className={`${btnBase} bg-amber-500 px-3 py-1.5 text-black hover:bg-amber-400`}>
              <BellIcon className={icon} />
              Call
            </button>
            <button onClick={() => upd({ isAdmin: !d.isAdmin })} className={`${btnBase} ${ghost} px-3 py-1.5`}>
              {d.isAdmin ? "Remove admin" : "Make admin"}
            </button>
            {d.live.online ? (
              <button
                onClick={() => confirm(`Remove ${d.displayName}? It will need a join code to come back.`) && send("admin.device.remove", { deviceId: d.id }).then(onDone)}
                className={`${btnBase} ml-auto border border-red-500/40 px-3 py-1.5 text-red-300 hover:bg-red-500/10`}
              >
                Remove
              </button>
            ) : (
              <button onClick={() => send("admin.device.forget", { deviceId: d.id }).then(onDone)} className={`${btnBase} ml-auto border border-red-500/40 px-3 py-1.5 text-red-300 hover:bg-red-500/10`}>
                Forget
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ messages

// ------------------------------------------------------------------ groups editor + server settings

function ServerSheet({ onClose }: { onClose(): void }) {
  const s = useStore();
  const [newGroup, setNewGroup] = useState("");
  const [serverName, setServerName] = useState(s.server?.name ?? "");
  return (
    <Sheet title="Groups & server" onClose={onClose} wide>
      <div className="flex flex-col gap-6">
        <Row label="Groups">
          <div className="flex flex-col gap-2">
            {s.groups.map((g, i) => (
              <GroupEditor key={g.id} g={g} index={i} groups={s.groups} />
            ))}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newGroup.trim()) send("admin.group.create", { name: newGroup.trim() }).then(() => setNewGroup(""));
              }}
            >
              <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group name" maxLength={40} className="flex-1" />
              <button className="rounded-lg bg-blue-600 px-4">Add</button>
            </form>
          </div>
        </Row>
        <Row label="Server name">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send("admin.settings.update", { serverName: serverName.trim() });
            }}
          >
            <input value={serverName} onChange={(e) => setServerName(e.target.value)} maxLength={60} className="flex-1" />
            <button className="rounded-lg bg-slate-700 px-4">Save</button>
          </form>
        </Row>
        <label className="flex items-center justify-between">
          <span>Crew can message everyone</span>
          <input type="checkbox" checked={!!s.settings?.crewCanBroadcast} onChange={(e) => send("admin.settings.update", { crewCanBroadcast: e.target.checked })} />
        </label>
        <IosLinkRow current={s.settings?.iosInstallUrl ?? ""} />
        <Row label="Default talk mode for crew">
          <select value={s.settings?.defaultTalkMode} onChange={(e) => send("admin.settings.update", { defaultTalkMode: e.target.value as TalkMode })}>
            <option value="ptt">Hold to talk</option>
            <option value="latch">Tap on / off</option>
          </select>
        </Row>
      </div>
    </Sheet>
  );
}

function IosLinkRow({ current }: { current: string }) {
  const [url, setUrl] = useState(current);
  useEffect(() => setUrl(current), [current]);
  const valid = url.trim() === "" || url.trim().startsWith("https://");
  return (
    <Row label="iPhone app link (TestFlight)">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) send("admin.settings.update", { iosInstallUrl: url.trim() || null }).then(() => toast(url.trim() ? "iPhone link saved" : "iPhone link removed", "info", 2500));
        }}
      >
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://testflight.apple.com/join/…" className="min-w-0 flex-1" />
        <button disabled={!valid} className={`${btnBase} ${ghost} px-4`}>
          Save
        </button>
      </form>
      <div className="mt-1 text-xs text-slate-500">Shown to iPhones on the Get the app page. Leave empty to offer the web app instead.</div>
    </Row>
  );
}

function GroupEditor({ g, index, groups }: { g: Group; index: number; groups: Group[] }) {
  const [name, setName] = useState(g.name);
  const [deleting, setDeleting] = useState(false);
  const others = groups.filter((x) => x.id !== g.id);
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");
  const swap = (j: number) => {
    const o = groups[j];
    if (!o) return;
    send("admin.group.update", { groupId: g.id, sortOrder: o.sortOrder });
    send("admin.group.update", { groupId: o.id, sortOrder: g.sortOrder });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-black/30 p-2">
      <input type="color" value={g.color} onChange={(e) => send("admin.group.update", { groupId: g.id, color: e.target.value })} className="h-9 w-10 p-0.5" />
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== g.name && send("admin.group.update", { groupId: g.id, name: name.trim() })} className="min-w-0 flex-1" />
      <select
        value={g.defaultTalkMode ?? ""}
        onChange={(e) => send("admin.group.update", { groupId: g.id, defaultTalkMode: (e.target.value || null) as TalkMode | null })}
        title="Default talk mode"
      >
        <option value="">Device default</option>
        <option value="ptt">Hold to talk</option>
        <option value="latch">Latch</option>
      </select>
      <button onClick={() => swap(index - 1)} disabled={index === 0} aria-label="Move up" className={`${btnBase} ${ghost} h-9 w-9`}>
        <ChevronUpIcon className={icon} />
      </button>
      <button onClick={() => swap(index + 1)} disabled={index === groups.length - 1} aria-label="Move down" className={`${btnBase} ${ghost} h-9 w-9`}>
        <ChevronDownIcon className={icon} />
      </button>
      {others.length > 0 && !deleting && (
        <button onClick={() => setDeleting(true)} className="rounded bg-red-900 px-2 py-1">
          Delete
        </button>
      )}
      {deleting && (
        <div className="flex w-full items-center gap-2 text-sm">
          Move its devices to
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button onClick={() => send("admin.group.delete", { groupId: g.id, moveDevicesTo: moveTo })} className="rounded bg-red-700 px-3 py-1">
            Delete {g.name}
          </button>
          <button onClick={() => setDeleting(false)} className="rounded bg-slate-800 px-3 py-1">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
