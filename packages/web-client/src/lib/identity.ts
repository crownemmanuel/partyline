// Device identity (ARCHITECTURE §3): uuid generated once, token per server, both in
// localStorage (best effort on the web: clearing site data makes a "new" device).
const K = { deviceId: "pl.deviceId", servers: "pl.servers", name: "pl.name", talkMode: "pl.talkMode", prefs: "pl.prefs" };

function get<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function set(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

export function deviceId(): string {
  let id = get<string | null>(K.deviceId, null);
  if (!id) {
    id = crypto.randomUUID?.() ?? fallbackUuid();
    set(K.deviceId, id);
  }
  return id;
}
function fallbackUuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface ServerEntry {
  token: string;
  name: string;
  fingerprint: string;
}
export function tokenFor(serverId: string): string | null {
  return get<Record<string, ServerEntry>>(K.servers, {})[serverId]?.token ?? null;
}
export function saveToken(serverId: string, e: ServerEntry) {
  const all = get<Record<string, ServerEntry>>(K.servers, {});
  all[serverId] = e;
  set(K.servers, all);
}
export function forgetToken(serverId: string) {
  const all = get<Record<string, ServerEntry>>(K.servers, {});
  delete all[serverId];
  set(K.servers, all);
}
export function knownFingerprint(serverId: string): string | null {
  return get<Record<string, ServerEntry>>(K.servers, {})[serverId]?.fingerprint ?? null;
}

export const savedName = () => get<string>(K.name, "");
export const saveName = (n: string) => set(K.name, n);
export const savedTalkMode = () => get<"ptt" | "latch" | null>(K.talkMode, null);
export const saveTalkMode = (m: "ptt" | "latch") => set(K.talkMode, m);

export interface Prefs {
  tts: boolean;
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  /** on-device voice isolation (DeepFilterNet3); on unless the user turns it off */
  noiseFilter: boolean;
  /** headset / lock-screen play-pause toggles the mic */
  headsetButton: boolean;
  /** "Add to Home Screen" tip dismissed */
  homeTipDismissed: boolean;
}
export const prefs = (): Prefs => ({ tts: false, inputDeviceId: null, outputDeviceId: null, noiseFilter: true, headsetButton: true, homeTipDismissed: false, ...get<Partial<Prefs>>(K.prefs, {}) });
export const savePrefs = (p: Partial<Prefs>) => set(K.prefs, { ...prefs(), ...p });
