import type { Device, Group } from "@partyline/protocol";
import { useStore, selectMe, setNoiseFilter, startAudio } from "../lib/session";
import { routedToMe } from "../lib/routing";
import { SparklesIcon, WaveIcon } from "./icons";

export function ConnDot() {
  const ws = useStore((s) => s.ws);
  const rtc = useStore((s) => s.rtc);
  const ok = ws === "open" && rtc === "connected";
  const label = ws !== "open" ? (ws === "reconnecting" ? "reconnecting" : "connecting") : rtc === "connected" ? "live" : rtc === "reconnecting" ? "audio reconnecting" : "audio connecting";
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-400">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? "bg-green-500" : "animate-pulse bg-amber-500"}`} />
      {label}
    </span>
  );
}

/** Names of devices I can hear talking right now. */
export function useTalkingToMe(): Device[] {
  const s = useStore();
  const me = selectMe(s);
  if (!me) return [];
  return Object.values(s.devices).filter(
    (d) => d.id !== me.id && (d.live.speaking || s.activeSpeakers.includes(d.id)) && d.live.micLive && routedToMe(me, d),
  );
}

export function AudioUnlock() {
  const blocked = useStore((s) => s.playbackBlocked);
  if (!blocked) return null;
  return (
    <button onClick={() => startAudio()} className="w-full bg-amber-500 py-3 font-semibold text-black">
      Tap to turn on audio
    </button>
  );
}

export function groupName(groups: Group[], id: string) {
  return groups.find((g) => g.id === id)?.name ?? id;
}

export function Badge({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`rounded-full bg-white/[0.08] px-2 py-0.5 text-[11px] font-medium text-slate-300 ${className}`}>{children}</span>;
}

/**
 * One obvious on/off switch for on-device voice isolation (DeepFilterNet3).
 * "chip" = bright pill (admin header); "bar" = full-width dark bar like the native apps.
 */
export function VoiceIsolationButton({ className = "", variant = "chip" }: { className?: string; variant?: "chip" | "bar" }) {
  const noise = useStore((s) => s.noise);
  const detail = useStore((s) => s.noiseDetail);
  const on = noise !== "off";
  const label = noise === "off" ? "Voice isolation OFF" : noise === "loading" ? "Voice isolation: starting…" : "Voice isolation ON";
  const tone =
    variant === "bar"
      ? { on: "bg-[#1f3a1f] text-white", loading: "animate-pulse bg-[#1f3a1f] text-emerald-100", basic: "bg-[#1f3a1f] text-white", off: "bg-neutral-900 text-slate-400" }[noise]
      : { on: "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25", loading: "animate-pulse bg-emerald-500/10 text-emerald-200", basic: "bg-emerald-500/15 text-emerald-300", off: "bg-white/[0.06] text-slate-400 hover:bg-white/[0.1]" }[noise];
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => setNoiseFilter(!on)}
      title={detail ?? "Removes background noise from your mic, on this device. Tap to turn " + (on ? "off" : "on") + "."}
      className={`flex items-center justify-center gap-2 font-semibold transition-colors ${tone} ${className}`}
    >
      {on ? <SparklesIcon className="h-[1.15em] w-[1.15em]" /> : <WaveIcon className="h-[1.15em] w-[1.15em]" />}
      {label}
      {noise === "basic" && <span className="rounded-full border border-current px-1.5 text-[0.75em] leading-tight" title={detail ?? undefined}>basic</span>}
    </button>
  );
}
