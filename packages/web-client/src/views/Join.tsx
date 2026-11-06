import { useEffect, useState } from "react";
import type { InfoResponse } from "@partyline/protocol";
import * as api from "../lib/api";
import { doJoin, isTauri, useStore } from "../lib/session";
import { savedName } from "../lib/identity";
import { askNotifications } from "../lib/alerts";

/** Parses `#join?code=…&fp=…&id=…` (PROTOCOL §1). */
function linkParams() {
  const m = /#join\?(.*)$/.exec(location.hash);
  return m ? new URLSearchParams(m[1]) : null;
}

export function Join({ kicked }: { kicked?: boolean }) {
  const link = linkParams();
  const [code, setCode] = useState(link?.get("code") ?? "");
  const [name, setName] = useState(savedName());
  const [info, setInfo] = useState<(InfoResponse & { localHost?: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bootErr = useStore((s) => s.info);

  useEffect(() => {
    api.getInfo().then(setInfo, () => setInfo(null));
  }, [bootErr]);

  const fpMismatch = !!(info && link?.get("fp") && link.get("fp") !== info.fingerprint);
  const local = !!info?.localHost;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    askNotifications();
    try {
      await doJoin(local ? "" : code.trim(), name.trim());
      if (link) history.replaceState(null, "", location.pathname);
    } catch (err) {
      const a = err as api.ApiError;
      setError(
        a.code === "invalid_code" ? "That code is not right. Check the number on the producer's screen."
        : a.code === "rate_limited" ? `Too many wrong codes. Try again in ${Math.ceil((a.retryAfter ?? 300) / 60)} min.`
        : a.code === "join_closed" ? "Joining is closed. Ask the producer to open it."
        : a.message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-6 p-6">
      <div className="text-center">
        <div className="text-3xl font-bold tracking-tight">PartyLine</div>
        <div className="mt-1 text-slate-400">{info ? info.name : bootErr ? "Looking for the server…" : " "}</div>
      </div>
      {kicked && <div className="rounded-lg bg-red-900/50 p-3 text-sm">You were removed by the producer. Join again with a new code.</div>}
      {fpMismatch && (
        <div className="rounded-lg bg-red-900/60 p-3 text-sm">
          Warning: this server's certificate does not match the QR code you scanned. Do not join unless the producer confirms.
        </div>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4">
        {!local && (
          <label className="flex flex-col gap-1">
            <span className="text-sm text-slate-400">Join code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="text-center font-mono text-3xl tracking-[0.4em]"
              placeholder="000000"
            />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-sm text-slate-400">Your name</span>
          <input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="Camera 2" className="text-lg" />
        </label>
        {error && <div className="text-sm text-red-400">{error}</div>}
        <button disabled={busy || !info} className="rounded-xl bg-blue-600 py-4 text-lg font-semibold disabled:opacity-50">
          {busy ? "Joining…" : local ? "Start" : "Join"}
        </button>
      </form>
      {!isTauri() && (
        <details className="text-sm text-slate-400">
          <summary className="cursor-pointer">About the certificate warning</summary>
          <p className="mt-2">
            PartyLine runs only on your local network, so it uses its own certificate instead of one from the internet. Your browser warns
            about it once; that is expected. Keep this tab open and the screen on: browsers stop audio in the background.
          </p>
          {info && <p className="mt-2 break-all font-mono text-xs">Fingerprint {info.fingerprint}</p>}
        </details>
      )}
    </div>
  );
}
