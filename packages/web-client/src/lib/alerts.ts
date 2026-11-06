// Tones, vibration, notifications, text-to-speech (PROTOCOL §6.7).
let ctx: AudioContext | null = null;
function ac() {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}
const TONES: Record<string, Array<[number, number]>> = {
  message: [[880, 0.08], [1320, 0.1]],
  signal: [[1000, 0.12], [0, 0.06], [1000, 0.12], [0, 0.06], [1000, 0.18]],
  reconnect: [[440, 0.12], [330, 0.16]],
  micOn: [[660, 0.06], [990, 0.09]],
  micOff: [[990, 0.06], [660, 0.09]],
  denied: [[220, 0.25]],
};
export function beep(kind: keyof typeof TONES) {
  try {
    const c = ac();
    let t = c.currentTime + 0.01;
    for (const [f, d] of TONES[kind]) {
      if (f) {
        const o = c.createOscillator();
        const g = c.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g).connect(c.destination);
        o.start(t);
        o.stop(t + d + 0.02);
      }
      t += d;
    }
  } catch {}
}
export function vibrate(p: number | number[]) {
  try {
    navigator.vibrate?.(p);
  } catch {}
}
export function notify(title: string, body: string) {
  try {
    if (document.visibilityState === "visible" || !("Notification" in window) || Notification.permission !== "granted") return;
    new Notification(title, { body, tag: "partyline", silent: false });
  } catch {}
}
export function askNotifications() {
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch {}
}
export function speak(text: string) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.1;
    speechSynthesis.speak(u);
  } catch {}
}
