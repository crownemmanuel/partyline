export function Sheet({ title, onClose, children, wide }: { title: string; onClose(): void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[90%] w-full flex-col rounded-t-2xl border border-white/[0.08] bg-neutral-900 sm:rounded-2xl ${wide ? "sm:max-w-2xl" : "sm:max-w-md"}`}
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
          <div className="text-lg font-semibold">{title}</div>
          <button onClick={onClose} className="rounded px-3 py-1 text-slate-400 hover:bg-white/[0.08]">
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
