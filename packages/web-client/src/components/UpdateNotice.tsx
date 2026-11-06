import { useEffect, useState } from "react";
import { invoke, isTauri } from "../lib/session";

interface UpdateStatus {
  current: string;
  available: { version: string; notes: string | null; date: string | null } | null;
  checkedAt: number | null;
  error: string | null;
  installing: boolean;
  dev: boolean;
}

/**
 * Desktop app only: shows that a new version is published (the app checks GitHub after start
 * and every six hours) and installs it when the operator presses Update. Nothing installs on its own.
 * `full`: also show the current version and a Check button (Settings).
 */
export function UpdateNotice({ full = false, hosting = false, className = "" }: { full?: boolean; hosting?: boolean; className?: string }) {
  const [s, setS] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const load = () => invoke<UpdateStatus>("update_status").then(setS, () => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!isTauri() || !s) return null;
  const a = s.available;
  if (!a && !full) return null;

  async function check() {
    setBusy("check");
    setError(null);
    try {
      setS(await invoke<UpdateStatus>("update_check"));
    } catch (e) {
      setError(String(e));
    }
    setBusy(null);
  }
  async function install() {
    if (!a) return;
    const warn = hosting ? "\n\nEveryone is disconnected for a few seconds while PartyLine restarts, then reconnects on their own." : "";
    if (!confirm(`Install PartyLine ${a.version} and restart?${warn}`)) return;
    setBusy("install");
    setError(null);
    try {
      await invoke("update_install", { version: a.version });
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  return (
    <div className={`${a ? "rounded-xl bg-emerald-900/40 p-3 text-sm" : "text-sm text-slate-400"} ${className}`}>
      {a ? (
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold text-emerald-200">PartyLine {a.version} is available</div>
            <div className="text-xs text-slate-400">This computer has {s.current}</div>
          </div>
          <button onClick={install} disabled={!!busy || s.dev} className="shrink-0 rounded-lg bg-emerald-600 px-3 py-2 font-semibold disabled:opacity-50">
            {busy === "install" ? "Updating…" : "Update"}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span>
            PartyLine {s.current}
            {s.checkedAt && !s.error ? " · up to date" : ""}
          </span>
          <button onClick={check} disabled={!!busy} className="rounded bg-slate-800 px-3 py-1 disabled:opacity-50">
            {busy === "check" ? "Checking…" : "Check for updates"}
          </button>
        </div>
      )}
      {a?.notes && full && <div className="mt-2 whitespace-pre-line text-xs text-slate-300">{a.notes}</div>}
      {s.dev && a && <div className="mt-1 text-xs text-slate-400">Development build: update it from git.</div>}
      {(error || (full && s.error)) && <div className="mt-1 text-xs text-red-300">{error ?? s.error}</div>}
    </div>
  );
}
