// Headset / lock-screen button → mic toggle via the Media Session API. Browsers never expose the
// phone's volume keys, but a headset's play/pause (and the lock-screen play/pause on iOS) reach
// the page's media session. A looping silent track keeps PartyLine the "now playing" session.

let el: HTMLAudioElement | null = null;
let onToggle: (() => void) | null = null;
let armed = false;

export const headsetSupported = () => typeof navigator !== "undefined" && "mediaSession" in navigator;

/** 1 s of 8 kHz 16-bit mono silence as a WAV blob URL. */
function silence(): string {
  const n = 8000;
  const b = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  b.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); // PCM
  b.setUint16(22, 1, true); // mono
  b.setUint32(24, 8000, true);
  b.setUint32(28, 16000, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  str(36, "data");
  b.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}

function handlers(on: boolean) {
  const ms = navigator.mediaSession;
  // iOS stops our silent track on "pause", which lets the page sleep and miss the next press;
  // a media-session action counts as a user gesture, so restart it every time
  const h = on
    ? () => {
        void play();
        onToggle?.();
      }
    : null;
  // "togglemicrophone" is Chrome's call-app action; play/pause covers headsets and the iOS lock screen
  for (const a of ["play", "pause", "togglemicrophone"]) {
    try {
      ms.setActionHandler(a as MediaSessionAction, h);
    } catch {}
  }
}

async function play() {
  if (!el) return false;
  try {
    await el.play();
    return true;
  } catch {
    return false;
  }
}

/**
 * Enable/disable the headset button. Playing audio needs a user gesture on iOS, so if the first
 * attempt is blocked it retries on the next tap or key press.
 */
export function setHeadsetControl(enabled: boolean, toggle: () => void) {
  if (!headsetSupported()) return;
  onToggle = toggle;
  if (!enabled) {
    handlers(false);
    el?.pause();
    return;
  }
  if (!el) {
    el = new Audio(silence());
    el.loop = true;
    el.setAttribute("playsinline", "");
    // the OS pausing us (call, Siri) drops the session; take it back on the next interaction
    el.addEventListener("pause", () => onToggle && arm());
  }
  handlers(true);
  play().then((ok) => ok || arm());
}

function arm() {
  if (armed) return;
  armed = true;
  const go = () => {
    play().then((ok) => {
      if (!ok) return;
      armed = false;
      window.removeEventListener("pointerdown", go, true);
      window.removeEventListener("keydown", go, true);
    });
  };
  window.addEventListener("pointerdown", go, true);
  window.addEventListener("keydown", go, true);
}

/** Lock-screen / Now Playing card: shows mic state and which group you're on. */
export function updateHeadsetState(live: boolean, group: string, server: string) {
  if (!headsetSupported() || !el) return;
  const ms = navigator.mediaSession;
  try {
    ms.metadata = new MediaMetadata({
      title: live ? "Mic LIVE · tap to mute" : "Muted · tap to talk",
      artist: `PartyLine · ${group}`,
      album: server,
      artwork: [{ src: "/icon-512.png?v=2", sizes: "512x512", type: "image/png" }],
    });
    // always "playing": the lock screen then shows one button whose every press toggles (a
    // "paused" card's play press doesn't reach a sleeping page on iOS); the title says which state
    ms.playbackState = "playing";
    (ms as MediaSession & { setMicrophoneActive?(a: boolean): Promise<void> }).setMicrophoneActive?.(live)?.catch?.(() => {});
  } catch {}
}
