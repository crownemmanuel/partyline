// "Add to Home Screen": PartyLine runs as an installed web app, no app store or APK needed.
import { useEffect, useState } from "react";

export type OS = "android" | "ios" | "other";
export const platform = (): OS => {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  return "other";
};

/** Already running from the Home Screen (not in a browser tab). */
export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
// Chrome fires this once, early; keep it for the Install button
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

/** One-tap install where the browser supports it (Android Chrome/Edge); null otherwise. */
export function useInstallPrompt(): (() => Promise<boolean>) | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  if (!deferred) return null;
  return async () => {
    const e = deferred;
    if (!e) return false;
    deferred = null;
    await e.prompt();
    return (await e.userChoice).outcome === "accepted";
  };
}
