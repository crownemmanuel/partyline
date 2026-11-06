import { useEffect, useState } from "react";
import type { InfoResponse } from "@partyline/protocol";
import { getInfo } from "../lib/api";
import { ChevronDownIcon } from "../components/icons";
import { isStandalone, platform, useInstallPrompt, type OS } from "../lib/pwa";

type Info = InfoResponse & { localHost?: boolean };
const TESTFLIGHT_APP = "https://apps.apple.com/app/testflight/id899247664";

/** /#install: put PartyLine on the Home Screen (recommended), or get a native app (APK / TestFlight). */
export function Install() {
  const [info, setInfo] = useState<Info | null>(null);
  const [failed, setFailed] = useState(false);
  const os = platform();
  useEffect(() => {
    getInfo().then(setInfo, () => setFailed(true));
  }, []);
  const join = location.hash.replace(/^#install&?/, "");
  // a path change (not just the hash) so the app reloads out of the install page
  const webAppHref = join ? `/?web#join?${join}` : "/?web";

  const android = <AndroidCard key="a" info={info} open={false} />;
  const ios = <IosCard key="i" info={info} open={false} webAppHref={webAppHref} />;
  return (
    <div className="min-h-full bg-black">
      <div className="mx-auto flex max-w-lg flex-col gap-4 px-5 pb-10 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <header className="flex items-center gap-3">
          <img src="/apple-touch-icon.png?v=2" alt="" className="h-14 w-14 rounded-2xl" />
          <div>
            <h1 className="text-2xl font-extrabold">Get PartyLine</h1>
            <div className="text-sm text-slate-400">{info?.name ?? (failed ? "Can't reach the host" : "…")}</div>
          </div>
        </header>
        <p className="text-slate-300">Your phone must be on the same Wi‑Fi as the host. No app store needed: add PartyLine to your Home Screen and it opens like an app.</p>
        <Card title="Add to Home Screen" subtitle="Recommended · works on iPhone and Android" open>
          <HomeScreenSteps os={os} webAppHref={webAppHref} />
        </Card>
        <div className="pt-2 text-sm font-semibold uppercase tracking-wider text-slate-500">Prefer a native app?</div>
        {os === "ios" ? [ios, android] : [android, ios]}
        <a href={webAppHref} className="rounded-2xl bg-neutral-900 p-4 text-center font-semibold text-[#6fa3ea]">
          Skip: use PartyLine in this browser instead
        </a>
      </div>
    </div>
  );
}

/** Platform-specific "Add to Home Screen" steps (also used by the in-app tip). */
export function HomeScreenSteps({ os, webAppHref }: { os: OS; webAppHref: string }) {
  const install = useInstallPrompt();
  if (isStandalone()) return <p className="text-emerald-400">PartyLine is already running from your Home Screen.</p>;
  const tail = [
    <>Open <b>PartyLine</b> from your Home Screen and enter the join code (it opens separately from the browser, so it asks once).</>,
    <>Allow the <b>Microphone</b>. With the screen locked, use the <b>play/pause</b> control on the lock screen or your headset button to talk and mute.</>,
  ];
  if (os === "android")
    return (
      <>
        {install && (
          <button onClick={() => install()} className={`${big} w-full bg-[#3a7bd5] text-white`}>
            Install PartyLine
          </button>
        )}
        <Steps
          items={[
            install ? <>Tap <b>Install PartyLine</b> above, then <b>Install</b>.</> : <>In Chrome, tap the <b>⋮</b> menu (top right), then <b>Add to Home screen</b> (or <b>Install app</b>).</>,
            <>Tap <b>Add</b> / <b>Install</b> to confirm.</>,
            ...tail,
          ]}
        />
      </>
    );
  if (os === "ios")
    return (
      <>
      <Steps
        items={[
          <>This page must be open in <b>Safari</b> (other browsers on iPhone can't add web apps on older iOS).</>,
          <>Tap the <b>Share</b> button (square with an arrow), scroll down and tap <b>Add to Home Screen</b>.</>,
          <>Keep <b>Open as Web App</b> on, then tap <b>Add</b>.</>,
          ...tail,
        ]}
      />
      <p className="text-sm text-slate-400">
        iPhone asks for the microphone each time the Home Screen app opens (Apple doesn't let web apps remember it). To avoid that, use PartyLine in a <b>Safari</b> tab instead and set{" "}
        <b>aA → Website Settings → Microphone → Allow</b>; Safari remembers it, and the lock-screen controls work there too.
      </p>
    </>
    );
  return (
    <Steps
      items={[
        <>Open this page on your phone (scan the producer's QR code).</>,
        <>Or keep using it here: <a href={webAppHref} className="font-semibold text-[#6fa3ea]">open PartyLine</a>.</>,
      ]}
    />
  );
}

function Card({ title, subtitle, open, children }: { title: string; subtitle: string; open: boolean; children: React.ReactNode }) {
  return (
    <details open={open} className="group rounded-2xl border border-white/[0.06] bg-neutral-900 p-4 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div>
          <div className="text-lg font-bold">{title}</div>
          <div className="text-sm text-slate-400">{subtitle}</div>
        </div>
        <ChevronDownIcon className="h-5 w-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </details>
  );
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {items.map((it, i) => (
        <li key={i} className="flex gap-3 text-[15px] leading-snug text-slate-200">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-xs font-bold">{i + 1}</span>
          <span>{it}</span>
        </li>
      ))}
    </ol>
  );
}

const big = "block rounded-2xl py-4 text-center text-lg font-bold";

function AndroidCard({ info, open }: { info: Info | null; open: boolean }) {
  const apk = info?.androidApk;
  return (
    <Card title="Android" subtitle="Download the app straight from the host" open={open}>
      {apk ? (
        <>
          <a href={apk.url} download="PartyLine.apk" className={`${big} bg-[#3a7bd5] text-white`}>
            Download for Android · {(apk.size / 1048576).toFixed(0)} MB
          </a>
          <Steps
            items={[
              <>Tap <b>Download</b>. If Chrome says the file might be harmful, tap <b>Download anyway</b>.</>,
              <>Open the downloaded file (from the notification, or <b>Files → Downloads</b>).</>,
              <>
                If Android says your browser isn't allowed to install apps, tap <b>Settings</b>, turn on <b>Allow from this source</b>, then go back.
                <span className="block pt-1 text-sm text-slate-400">Elsewhere this is Settings → Apps → Special app access → Install unknown apps.</span>
              </>,
              <>Tap <b>Install</b>. If Play Protect warns about an unknown developer, tap <b>More details → Install anyway</b>.</>,
              <>Open <b>PartyLine</b>. It finds this host on the Wi‑Fi by itself; tap it, check the name, and enter the join code (or scan the join QR).</>,
              <>Allow <b>Microphone</b> and <b>Notifications</b> when asked, so you can talk and hear calls with the screen off.</>,
            ]}
          />
          <p className="text-sm text-slate-500">You can turn "Install unknown apps" back off for your browser afterwards.</p>
        </>
      ) : (
        <p className="text-slate-400">{info ? "This host doesn't have the Android app bundled yet. Use PartyLine in your browser for now." : "Loading…"}</p>
      )}
    </Card>
  );
}

function IosCard({ info, open, webAppHref }: { info: Info | null; open: boolean; webAppHref: string }) {
  const url = info?.iosInstallUrl;
  return (
    <Card title="iPhone & iPad" subtitle={url ? "Install through Apple's TestFlight" : "Use the web app from your Home Screen"} open={open}>
      {url ? (
        <>
          <Steps
            items={[
              <>
                Install <b>TestFlight</b> from the App Store (free, made by Apple).
                <a href={TESTFLIGHT_APP} className="mt-2 block rounded-xl bg-white/[0.08] py-2.5 text-center font-semibold">Get TestFlight</a>
              </>,
              <>
                Come back here and tap <b>Install PartyLine</b>.
                <a href={url} className={`${big} mt-2 bg-[#3a7bd5] text-white`}>Install PartyLine</a>
              </>,
              <>In TestFlight, tap <b>Accept</b>, then <b>Install</b>.</>,
              <>Open <b>PartyLine</b>, allow <b>Local Network</b> (so it can find the host), <b>Microphone</b> and <b>Notifications</b>.</>,
              <>Pick this host, trust its name, and enter the join code (or scan the join QR with the Camera app).</>,
            ]}
          />
          <p className="text-sm text-slate-500">TestFlight builds stop working after 90 days; when that happens, open TestFlight and install the update.</p>
        </>
      ) : (
        <Steps
          items={[
            <>
              Open the web app in <b>Safari</b>:
              <a href={webAppHref} className="mt-2 block rounded-xl bg-white/[0.08] py-2.5 text-center font-semibold">Open PartyLine</a>
            </>,
            <>Tap the <b>Share</b> button, then <b>Add to Home Screen</b>.</>,
            <>Open PartyLine from your Home Screen. It runs full screen like an app. Keep it open during the show.</>,
          ]}
        />
      )}
    </Card>
  );
}
