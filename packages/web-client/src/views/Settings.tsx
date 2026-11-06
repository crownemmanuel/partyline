import { useEffect, useState } from "react";
import type { TalkMode } from "@partyline/protocol";
import { inboundPackets, isTauri, invoke, leave, selectMe, send, setHeadsetButton, setTalkMode, switchDevice, useStore } from "../lib/session";
import { headsetSupported } from "../lib/headset";
import { prefs, savePrefs } from "../lib/identity";
import { Sheet } from "../components/Sheet";
import { UpdateNotice } from "../components/UpdateNotice";

export function SettingsSheet({ onClose }: { onClose(): void }) {
  const s = useStore();
  const me = selectMe(s)!;
  const [name, setName] = useState(me.displayName);
  const [devs, setDevs] = useState<MediaDeviceInfo[]>([]);
  const [p, setP] = useState(prefs());
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const mode: TalkMode = me.forcedTalkMode ?? me.live.talkMode;

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then(setDevs).catch(() => {});
  }, []);
  const inputs = devs.filter((d) => d.kind === "audioinput");
  const outputs = devs.filter((d) => d.kind === "audiooutput");

  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <Row label="Name">
          {me.isAdmin ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                send("admin.device.update", { deviceId: me.id, displayName: name.trim() });
              }}
            >
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="flex-1" />
              <button className="rounded-lg bg-slate-700 px-3">Save</button>
            </form>
          ) : (
            <div>
              {me.displayName} <span className="text-sm text-slate-500">(the producer can rename you)</span>
            </div>
          )}
        </Row>
        <Row label="Talk mode">
          <div className="flex gap-2">
            {(["ptt", "latch"] as const).map((m) => (
              <button
                key={m}
                disabled={!!me.forcedTalkMode}
                onClick={() => setTalkMode(m)}
                className={`flex-1 rounded-lg py-2 ${mode === m ? "bg-blue-600" : "bg-slate-800"} disabled:opacity-60`}
              >
                {m === "ptt" ? "Hold to talk" : "Tap on / off"}
              </button>
            ))}
          </div>
          {me.forcedTalkMode && <div className="mt-1 text-sm text-slate-500">Set by the producer</div>}
        </Row>
        <Row label="Microphone">
          <select
            className="w-full"
            value={p.inputDeviceId ?? "default"}
            onChange={(e) => {
              switchDevice("audioinput", e.target.value);
              setP({ ...p, inputDeviceId: e.target.value });
            }}
          >
            {inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || "Microphone"}
              </option>
            ))}
          </select>
        </Row>
        {outputs.length > 0 && (
          <Row label="Speaker / headset">
            <select
              className="w-full"
              value={p.outputDeviceId ?? "default"}
              onChange={(e) => {
                switchDevice("audiooutput", e.target.value);
                setP({ ...p, outputDeviceId: e.target.value });
              }}
            >
              {outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Output"}
                </option>
              ))}
            </select>
          </Row>
        )}
        {me.live.headset === false && <div className="rounded-lg bg-amber-900/50 p-3 text-sm">No headset detected. Use headphones to avoid echo.</div>}
        {headsetSupported() && (
          <label className="flex items-center justify-between gap-4">
            <span>
              Headset button toggles mic
              <span className="block text-xs text-slate-500">Press play/pause on your headset (or the lock screen) to talk; press again to mute.</span>
            </span>
            <input
              type="checkbox"
              checked={p.headsetButton}
              onChange={(e) => {
                setHeadsetButton(e.target.checked);
                setP({ ...p, headsetButton: e.target.checked });
              }}
            />
          </label>
        )}
        <label className="flex items-center justify-between">
          <span>Read messages aloud</span>
          <input
            type="checkbox"
            checked={p.tts}
            onChange={(e) => {
              savePrefs({ tts: e.target.checked });
              setP({ ...p, tts: e.target.checked });
            }}
          />
        </label>
        <Row label="Server">
          <div className="text-sm text-slate-400">
            {s.server?.name} · v{s.server?.appVersion}
            <div className="break-all font-mono text-[11px]">{s.server?.fingerprint}</div>
          </div>
        </Row>
        {/* the host's own console is the loopback listener on :8442 (apps/desktop/README.md) */}
        <UpdateNotice full hosting={location.port === "8442"} />
        <details className="text-sm text-slate-400">
          <summary className="cursor-pointer">Diagnostics</summary>
          <button className="mt-2 rounded bg-slate-800 px-3 py-1" onClick={async () => setStats(await inboundPackets())}>
            Inbound audio packets per device
          </button>
          {stats && (
            <ul className="mt-2 font-mono text-xs">
              {Object.entries(stats).map(([k, v]) => (
                <li key={k}>
                  {s.devices[k]?.displayName ?? k}: {v}
                </li>
              ))}
            </ul>
          )}
        </details>
        <div className="flex gap-2">
          <button
            onClick={async () => {
              await leave(false);
              if (isTauri()) await invoke("go_home").catch(() => location.reload());
              else location.reload();
            }}
            className="flex-1 rounded-lg bg-slate-800 py-3"
          >
            Leave
          </button>
          <button
            onClick={async () => {
              if (!confirm("Forget this server? You will need a join code to come back.")) return;
              await leave(true);
              location.reload();
            }}
            className="flex-1 rounded-lg bg-red-900 py-3"
          >
            Forget server
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm text-slate-400">{label}</div>
      {children}
    </div>
  );
}
