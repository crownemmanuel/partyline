import { useStore } from "../lib/session";

const COLORS: Record<string, string> = {
  error: "bg-red-600",
  muted: "bg-red-600",
  signal: "bg-yellow-500 text-black",
  info: "bg-slate-700",
};

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-3">
      {toasts.map((t) => (
        <div key={t.id} className={`pointer-events-auto max-w-md rounded-lg px-4 py-2 text-sm font-medium shadow-lg ${COLORS[t.kind] ?? "bg-blue-600"}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
