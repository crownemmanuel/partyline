import { useEffect, useState } from "react";
import { invoke } from "../lib/session";
import { UpdateNotice } from "../components/UpdateNotice";

interface Found {
  id: string;
  name: string;
  address: string;
  port: number;
  fingerprint: string;
}
interface Probe {
  serverId: string;
  name: string;
  fingerprint: string;
  address: string;
}

/** Tauri only (DESKTOP.md screen 1): Host or Join. The webview then moves to the loopback page. */
export function Home() {
  const [found, setFound] = useState<Found[]>([]);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<Probe | null>(null);

  useEffect(() => {
    let alive = true;
    const scan = () => invoke<Found[]>("discover").then((f) => alive && setFound(f), () => {});
    scan();
    const t = setInterval(scan, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  async function host() {
    setBusy("host");
    setError(null);
    try {
      const { url } = await invoke<{ url: string }>("host_start");
      location.href = url;
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }
  async function join(address: string, fingerprint: string | null) {
    setBusy(address);
    setError(null);
    try {
      if (!fingerprint) {
        // manual address: show the fingerprint and ask before trusting (TOFU, ARCHITECTURE §5.3)
        const p = await invoke<Probe>("probe_server", { address });
        setTrust(p);
        setBusy(null);
        return;
      }
      const { url } = await invoke<{ url: string }>("join_remote", { address, fingerprint });
      location.href = url;
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col justify-center gap-8 p-8">
      <div className="text-center">
        <div className="text-4xl font-bold tracking-tight">PartyLine</div>
        <div className="mt-1 text-slate-400">Intercom for your team on this Wi-Fi</div>
      </div>
      <UpdateNotice />
      <button onClick={host} disabled={!!busy} className="rounded-2xl bg-red-600 py-6 text-xl font-semibold disabled:opacity-50">
        {busy === "host" ? "Starting…" : "Host a PartyLine"}
        <div className="text-sm font-normal opacity-80">This computer becomes the server and the producer console</div>
      </button>
      <div className="flex flex-col gap-3">
        <div className="text-sm uppercase tracking-wide text-slate-400">Join</div>
        {found.length === 0 && <div className="text-slate-500">Looking for PartyLine servers…</div>}
        {found.map((f) => (
          <button key={f.id} onClick={() => join(`${f.address}:${f.port}`, f.fingerprint)} disabled={!!busy} className="flex justify-between rounded-xl bg-slate-800 px-4 py-4 text-left disabled:opacity-50">
            <span className="font-semibold">{f.name}</span>
            <span className="text-sm text-slate-400">{busy === `${f.address}:${f.port}` ? "Connecting…" : f.address}</span>
          </button>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) join(manual.trim(), null);
          }}
        >
          <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Address, e.g. 192.168.1.20" className="flex-1" />
          <button className="rounded-lg bg-slate-700 px-4">Join</button>
        </form>
      </div>
      {error && <div className="rounded-lg bg-red-900/50 p-3 text-sm">{error}</div>}
      {trust && (
        <div className="rounded-xl bg-slate-800 p-4">
          <div className="font-semibold">Trust “{trust.name}”?</div>
          <div className="mt-1 break-all font-mono text-xs text-slate-400">{trust.fingerprint}</div>
          <div className="mt-2 text-sm text-slate-400">Check this matches the fingerprint in the host's settings. PartyLine will refuse any other certificate for this server.</div>
          <div className="mt-3 flex gap-2">
            <button onClick={() => join(trust.address, trust.fingerprint)} className="rounded-lg bg-blue-600 px-4 py-2">
              Trust and join
            </button>
            <button onClick={() => setTrust(null)} className="rounded-lg bg-slate-700 px-4 py-2">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
