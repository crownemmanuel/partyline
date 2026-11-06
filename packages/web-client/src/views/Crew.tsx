import { useState } from "react";
import { selectMe, setMicLive, setSpeakerMuted, setTalkMode, useStore } from "../lib/session";
import { TalkButton } from "../components/TalkButton";
import { AudioUnlock, ConnDot, VoiceIsolationButton, groupName, useTalkingToMe } from "../components/common";
import { GearIcon, LockIcon, MicIcon, MicOffIcon, SpeakerIcon, SpeakerOffIcon, WaveIcon } from "../components/icons";
import { MessagesButton, MessagesDock } from "./Messages";
import { SettingsSheet } from "./Settings";
import { HomeScreenSteps } from "./Install";
import { Sheet } from "../components/Sheet";
import { isStandalone, platform } from "../lib/pwa";
import { prefs, savePrefs } from "../lib/identity";
import { PhoneIcon, XIcon } from "../components/icons";

/** ARCHITECTURE §10 crew main screen, laid out like the native apps. Nothing more. */
export function Crew() {
  const me = useStore(selectMe)!;
  const groups = useStore((s) => s.groups);
  const server = useStore((s) => s.server);
  const micError = useStore((s) => s.micError);
  const talking = useTalkingToMe();
  const [sheet, setSheet] = useState<"settings" | "home" | null>(null);
  const [homeTip, setHomeTip] = useState(() => platform() !== "other" && !isStandalone() && !prefs().homeTipDismissed);
  const mode = me.forcedTalkMode ?? me.live.talkMode;
  const live = me.live.micLive;
  const locked = me.adminMuted;
  const color = groups.find((g) => g.id === me.groupId)?.color ?? "#2563eb";
  const tile = "flex flex-col items-center justify-center gap-1 rounded-2xl py-3 text-sm font-semibold transition-colors";

  return (
    <div className="min-h-full bg-black">
      {/* min-h (not h): on short screens the page scrolls instead of the talk button overlapping */}
      <div className="mx-auto flex min-h-full max-w-md flex-col px-5 pb-5 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <AudioUnlock />
        <header className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="truncate text-4xl font-extrabold uppercase tracking-tight" style={{ color }}>
              {groupName(groups, me.groupId)}
            </div>
            <div className="truncate text-slate-300">{server?.name}</div>
            <div className="truncate text-sm text-slate-500">{me.displayName}</div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <ConnDot />
            <button onClick={() => setSheet("settings")} aria-label="Settings" className="rounded-full p-1 text-blue-400 active:bg-white/10">
              <GearIcon className="h-8 w-8" />
            </button>
          </div>
        </header>

        <div className="flex items-center gap-2 pt-4 text-xl font-semibold" aria-live="polite">
          <WaveIcon className={`h-6 w-6 shrink-0 ${talking.length ? "text-green-400" : "text-slate-500"}`} />
          {talking.length > 0 ? <span className="truncate text-green-400">{talking.map((d) => d.displayName).join(", ")}</span> : <span>Quiet</span>}
        </div>

        {homeTip && (
          <div className="mt-3 flex items-center gap-2 rounded-2xl bg-[#3a7bd5]/15 py-1.5 pl-3 pr-1.5 text-sm text-[#9cc0f2]">
            <PhoneIcon className="h-4 w-4 shrink-0" />
            <button onClick={() => setSheet("home")} className="flex-1 text-left font-semibold">
              Add PartyLine to your Home Screen
            </button>
            <button
              aria-label="Dismiss"
              onClick={() => {
                savePrefs({ homeTipDismissed: true });
                setHomeTip(false);
              }}
              className="rounded-full p-1.5 hover:bg-white/10"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 rounded-full bg-neutral-900 p-1" role="radiogroup" aria-label="Talk mode">
          {(["ptt", "latch"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              disabled={!!me.forcedTalkMode}
              onClick={() => setTalkMode(m)}
              className={`rounded-full py-2 text-sm font-semibold transition-colors ${mode === m ? "bg-neutral-700 text-white" : "text-slate-400"} disabled:opacity-60`}
            >
              {m === "ptt" ? "Hold to talk" : "Tap on / off"}
            </button>
          ))}
        </div>
        {me.forcedTalkMode && <div className="pt-1 text-center text-xs text-slate-500">Talk mode set by the producer</div>}

        <div className="flex min-h-0 flex-1 flex-col justify-end pt-4">
          <TalkButton
            mode={mode}
            active={live}
            disabled={locked}
            spaceBar
            onChange={setMicLive}
            className={`flex h-full max-h-80 min-h-44 w-full flex-col items-center justify-center gap-3 rounded-[2rem] text-3xl font-extrabold transition-colors ${
              locked ? "bg-neutral-800 text-slate-500" : live ? "bg-red-600 text-white shadow-[0_0_40px_rgba(220,38,38,.6)]" : "bg-[#3a7bd5] text-white active:bg-[#336cbb]"
            }`}
          >
            {locked ? <LockIcon className="h-14 w-14" /> : <MicIcon className="h-14 w-14" />}
            {locked ? "MUTED BY PRODUCER" : mode === "ptt" ? (live ? "TALKING" : "HOLD TO TALK") : live ? "TALK ON" : "TAP TO TALK"}
          </TalkButton>
        </div>
        {micError && <div className="pt-2 text-sm text-red-400">Microphone problem: {micError}</div>}

        <div className="grid grid-cols-2 gap-3 pt-3">
          <button
            onClick={() => setMicLive(false)}
            disabled={!me.live.micLive}
            aria-label={me.live.micLive ? "Live, tap to mute" : "Muted"}
            className={`${tile} ${locked ? "bg-red-900 text-red-200" : me.live.micLive ? "bg-red-600 text-white" : "bg-neutral-900 text-white"}`}
          >
            {locked ? <LockIcon /> : me.live.micLive ? <MicIcon /> : <MicOffIcon />}
            {locked ? "Muted by producer" : me.live.micLive ? "Live · tap to mute" : "Muted"}
          </button>
          <button
            onClick={() => setSpeakerMuted(!me.live.speakerMuted)}
            className={`${tile} ${me.live.speakerMuted ? "bg-red-600 text-white" : "bg-neutral-900 text-white"}`}
          >
            {me.live.speakerMuted ? <SpeakerOffIcon /> : <SpeakerIcon />}
            {me.live.speakerMuted ? "Speaker off" : "Speaker on"}
          </button>
          <VoiceIsolationButton variant="bar" className="col-span-2 rounded-2xl py-3" />
          <MessagesButton className="col-span-2 rounded-full bg-neutral-800 py-4 text-lg text-blue-400" />
        </div>
        <MessagesDock bubble="never" />
        {sheet === "settings" && <SettingsSheet onClose={() => setSheet(null)} />}
        {sheet === "home" && (
          <Sheet title="Add to Home Screen" onClose={() => setSheet(null)}>
            <HomeScreenSteps os={platform()} webAppHref="/" />
          </Sheet>
        )}
      </div>
    </div>
  );
}
