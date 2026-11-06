import { useEffect, useState } from "react";
import { boot, isTauri, selectMe, useStore } from "./lib/session";
import { Join } from "./views/Join";
import { Crew } from "./views/Crew";
import { Admin } from "./views/Admin";
import { Home } from "./views/Home";
import { Install } from "./views/Install";
import { Toasts } from "./components/Toasts";

/** The bundled Tauri page (tauri://localhost) is the Home screen; everywhere else we are served by a host. */
const onTauriHome = isTauri() && !/^https?:$/.test(location.protocol);
/** /#install is a standalone page for getting the native apps; it never joins. */
const onInstall = !onTauriHome && location.hash.startsWith("#install");

export function App() {
  const phase = useStore((s) => s.phase);
  const me = useStore(selectMe);
  const flash = useStore((s) => s.signalFlash);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (!onTauriHome && !onInstall) boot();
  }, []);
  useEffect(() => {
    if (!flash) return;
    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), 1700);
    return () => clearTimeout(t);
  }, [flash]);

  let view;
  if (onTauriHome) view = <Home />;
  else if (onInstall) view = <Install />;
  else if (phase === "boot") view = <Center>Connecting…</Center>;
  else if (phase === "join" || phase === "kicked") view = <Join kicked={phase === "kicked"} />;
  else if (!me) view = <Center>Connecting…</Center>;
  else view = me.isAdmin ? <Admin /> : <Crew />;

  return (
    <div className={`h-full ${flashing ? "flash" : ""}`}>
      {view}
      <Toasts />
    </div>
  );
}

export function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-slate-400">{children}</div>;
}
