import { useEffect, useRef } from "react";

/**
 * Hold-to-talk (PTT) or tap-to-toggle (latch). Pointer events so mouse, touch and pen behave
 * the same; `spaceBar` also binds the Space key (desktop).
 */
export function TalkButton(props: {
  mode: "ptt" | "latch";
  active: boolean;
  disabled?: boolean;
  onChange(active: boolean): void;
  spaceBar?: boolean;
  className?: string;
  children: React.ReactNode;
  title?: string;
}) {
  const { mode, active, disabled, onChange, spaceBar } = props;
  const held = useRef(false);
  const ref = useRef({ mode, active, onChange, disabled });
  ref.current = { mode, active, onChange, disabled };

  useEffect(() => {
    if (!spaceBar) return;
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e) || e.repeat || ref.current.disabled) return;
      e.preventDefault();
      if (ref.current.mode === "ptt") ref.current.onChange(true);
      else ref.current.onChange(!ref.current.active);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e)) return;
      e.preventDefault();
      if (ref.current.mode === "ptt") ref.current.onChange(false);
    };
    const blur = () => ref.current.mode === "ptt" && ref.current.onChange(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [spaceBar]);

  const release = () => {
    if (held.current) {
      held.current = false;
      onChange(false);
    }
  };
  return (
    <button
      type="button"
      title={props.title}
      disabled={disabled}
      className={`talk ${props.className ?? ""}`}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        if (mode === "ptt") {
          e.currentTarget.setPointerCapture(e.pointerId);
          held.current = true;
          onChange(true);
        } else onChange(!active);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      {props.children}
    </button>
  );
}
