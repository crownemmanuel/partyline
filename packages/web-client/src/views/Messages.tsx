import { useEffect, useRef, useState } from "react";
import type { Message, TargetRef } from "@partyline/protocol";
import { closeMessages, dismissIncoming, openMessages, replyTarget, selectMe, send, useStore } from "../lib/session";
import { producerTarget } from "../lib/routing";
import { groupName } from "../components/common";
import { BellIcon, ChatIcon, ReplyIcon, XIcon } from "../components/icons";

export function targetLabel(to: string, s: ReturnType<typeof useStore.getState>) {
  if (to === "all") return "Everyone";
  if (to.startsWith("g:")) return groupName(s.groups, to.slice(2));
  return s.devices[to.slice(2)]?.displayName ?? "device";
}

export function MessageList({ messages, showAcks }: { messages: Message[]; showAcks?: boolean }) {
  const s = useStore();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);
  const recipients = (to: string) =>
    Object.values(s.devices).filter((d) => d.id !== s.meId && (to === "all" || to === `d:${d.id}` || (to.startsWith("g:") && (d.groupId === to.slice(2) || d.listenGroupIds.includes(to.slice(2)))))).length;
  return (
    <div className="flex flex-col gap-2">
      {messages.length === 0 && <div className="text-center text-sm text-slate-500">No messages yet</div>}
      {messages.map((m) => {
        const mine = m.from === s.meId;
        return (
          <div key={m.id} className={`max-w-[85%] rounded-xl px-3 py-2 ${mine ? "self-end bg-[#3a7bd5] text-white" : "self-start bg-white/[0.07]"}`}>
            <div className="text-[11px] text-slate-300">
              {mine ? "You" : s.devices[m.from]?.displayName ?? "Unknown"} → {targetLabel(m.to, s)} ·{" "}
              {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
            <div className={m.kind === "quick" ? "font-semibold" : ""}>{m.text}</div>
            {showAcks && mine && (
              <div className="text-right text-[11px] text-slate-300" title={(m.ackedBy ?? []).map((i) => s.devices[i]?.displayName ?? i).join(", ")}>
                ✓ {(m.ackedBy ?? []).length}/{recipients(m.to)}
              </div>
            )}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

/**
 * Messages panel (opens in place) + new-message pop-up, and on desktop-sized screens a floating
 * chat bubble bottom-left. Phones open the panel from an inline <MessagesButton> instead.
 * `bubble`: "desktop" = only from the sm breakpoint up, "never" = inline button only.
 */
export function MessagesDock({ bubble }: { bubble: "desktop" | "never" }) {
  const open = useStore((s) => s.msgOpen);
  const unread = useStore((s) => s.unread);
  return (
    <>
      <IncomingPopup />
      {open && <MessagesPanel above={bubble === "desktop"} />}
      {bubble === "desktop" && <button
        onClick={() => (open ? closeMessages() : openMessages())}
        aria-label={open ? "Close messages" : `Messages${unread ? `, ${unread} unread` : ""}`}
        className={`fixed bottom-5 left-5 z-40 hidden h-14 w-14 items-center sm:flex justify-center rounded-full text-2xl shadow-lg shadow-black/50 transition-colors ${
          open ? "bg-neutral-700 text-white" : "bg-[#3a7bd5] text-white hover:bg-[#4686e0]"
        }`}
      >
        {open ? <XIcon className="h-6 w-6" /> : <ChatIcon className="h-6 w-6" />}
        {!open && unread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-6 rounded-full bg-red-600 px-1.5 text-center text-sm font-bold leading-6">{unread > 99 ? "99+" : unread}</span>
        )}
      </button>}
    </>
  );
}

/** Inline "Messages" button with unread count (phone layouts). */
export function MessagesButton({ className = "" }: { className?: string }) {
  const unread = useStore((s) => s.unread);
  const open = useStore((s) => s.msgOpen);
  return (
    <button onClick={() => (open ? closeMessages() : openMessages())} className={`flex items-center justify-center gap-2 font-semibold ${className}`}>
      <ChatIcon className="h-[1.2em] w-[1.2em]" />
      Messages {unread > 0 && <span className="rounded-full bg-red-600 px-2 py-0.5 text-sm leading-none text-white">{unread}</span>}
    </button>
  );
}

/** New message pops up on top of whatever is on screen until closed or answered. */
function IncomingPopup() {
  const s = useStore();
  const m = s.incoming[0];
  useEffect(() => {
    if (!m) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dismissIncoming();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [m?.id]);
  if (!m) return null;
  const more = s.incoming.length - 1;
  return (
    <div role="alertdialog" aria-label="New message" className="fixed inset-x-3 top-3 z-50 mx-auto max-w-md rounded-2xl border border-[#3a7bd5]/60 bg-neutral-900 p-4 shadow-2xl shadow-black/60">
      <div className="flex items-baseline justify-between gap-2 text-sm text-blue-300">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChatIcon className="h-4 w-4 shrink-0" /> <b>{s.devices[m.from]?.displayName ?? "Unknown"}</b> → {targetLabel(m.to, s)}
        </span>
        <span className="shrink-0 text-xs text-slate-400">{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <div className={`mt-2 break-words text-xl ${m.kind === "quick" ? "font-bold" : ""}`}>{m.text}</div>
      {more > 0 && <div className="mt-1 text-xs text-slate-400">+{more} more</div>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button onClick={() => openMessages(replyTarget(m))} className="flex items-center justify-center gap-2 rounded-xl bg-[#3a7bd5] py-3 text-lg font-semibold text-white">
          <ReplyIcon className="h-5 w-5" />
          Reply
        </button>
        <button onClick={() => dismissIncoming()} className="rounded-xl bg-white/[0.1] py-3 text-lg font-semibold">
          {more > 0 ? "Next" : "Close"}
        </button>
      </div>
      {more > 0 && (
        <button onClick={() => dismissIncoming(true)} className="mt-2 w-full text-sm text-slate-400 underline">
          Close all
        </button>
      )}
    </div>
  );
}

/** In-place panel: history, quick replies (crew), target, attention signal, free text. */
function MessagesPanel({ above }: { above: boolean }) {
  const s = useStore();
  const me = selectMe(s)!;
  const producer = producerTarget(me, Object.values(s.devices));
  const [to, setTo] = useState<TargetRef>(s.replyTo ?? (me.isAdmin ? "all" : producer ?? (`g:${me.groupId}` as TargetRef)));
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (s.replyTo) {
      setTo(s.replyTo);
      input.current?.focus();
    }
  }, [s.replyTo]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !s.incoming.length && closeMessages();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.incoming.length]);

  const others = Object.values(s.devices).filter((d) => d.id !== me.id);
  const targets: Array<[TargetRef, string]> = me.isAdmin
    ? [["all", "Everyone"], ...s.groups.map((g) => [`g:${g.id}`, g.name] as [TargetRef, string]), ...others.map((d) => [`d:${d.id}`, d.displayName] as [TargetRef, string])]
    : [
        ...(producer ? [[producer, "Producer"] as [TargetRef, string]] : []),
        [`g:${me.groupId}` as TargetRef, groupName(s.groups, me.groupId)],
        ...(s.settings?.crewCanBroadcast ? [["all", "Everyone"] as [TargetRef, string]] : []),
      ];
  if (!targets.some(([v]) => v === to)) targets.unshift([to, targetLabel(to, s)]);
  const sendText = (t: string, kind: "text" | "quick") => send("message.send", { to, text: t, kind }).then(() => kind === "text" && setText(""));

  return (
    <div
      role="dialog"
      aria-label="Messages"
      className={`fixed inset-x-3 bottom-3 z-40 flex ${above ? "sm:bottom-24" : ""} max-h-[min(75vh,640px)] flex-col rounded-2xl border border-white/[0.08] bg-neutral-900 shadow-2xl shadow-black/60 sm:right-auto sm:left-5 sm:w-[420px]`}
    >
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
        <div className="font-semibold">Messages</div>
        <button onClick={closeMessages} className="rounded px-3 py-1 text-slate-400 hover:bg-slate-800">
          Close
        </button>
      </div>
      <div className="min-h-32 flex-1 overflow-y-auto p-3">
        <MessageList messages={s.messages} showAcks={me.isAdmin} />
      </div>
      <div className="flex flex-col gap-2 border-t border-white/[0.06] p-3">
        {!me.isAdmin && (s.settings?.quickReplies ?? []).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {(s.settings?.quickReplies ?? []).map((q) => (
              <button key={q} onClick={() => sendText(q, "quick")} className="rounded-full bg-white/[0.08] px-3 py-1.5 text-sm font-semibold">
                {q}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <select value={to} onChange={(e) => setTo(e.target.value as TargetRef)} className="min-w-0 flex-1">
            {targets.map(([v, l]) => (
              <option key={v} value={v}>
                To: {l}
              </option>
            ))}
          </select>
          <button
            onClick={() => to !== "all" && send("signal.send", { to })}
            disabled={to === "all"}
            className="flex items-center rounded-lg bg-amber-500 px-3 text-black disabled:opacity-40"
            title="Attention signal: buzz + tone"
            aria-label="Call (attention signal)"
          >
            <BellIcon className="h-5 w-5" />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) sendText(text.trim(), "text");
          }}
          className="flex gap-2"
        >
          <input ref={input} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Message" className="min-w-0 flex-1" />
          <button className="rounded-lg bg-[#3a7bd5] px-4 font-semibold text-white">Send</button>
        </form>
      </div>
    </div>
  );
}
