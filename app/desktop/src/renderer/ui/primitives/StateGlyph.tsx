// An agent's state as a small glyph that moves the way the state feels (tokens.css, the motion language): working
// breathes, thinking glows, waiting on you knocks twice, queued circles its ring, paused is two still bars, done lands
// a check and failed nudges once. With reduced motion each keeps a still form of its own, so the shape alone says it.
import { Check, X } from "lucide-react";
import s from "./StateGlyph.module.css";

export type GlyphState = "working" | "thinking" | "waiting" | "queued" | "paused" | "done" | "failed";

// Loops stop while the window is hidden or in the background: nothing draws frames no one sees.
if (typeof document !== "undefined") {
  const still = () => {
    document.documentElement.toggleAttribute("data-still", document.hidden || !document.hasFocus());
  };
  document.addEventListener("visibilitychange", still);
  window.addEventListener("blur", still);
  window.addEventListener("focus", still);
}

/** `settled`: a done or failed state from before you looked, shown without its landing. */
export function StateGlyph({ state, label, size = "md", settled = false }: { state: GlyphState; label?: string; size?: "sm" | "md"; settled?: boolean }) {
  return (
    <span className={settled ? `${s.glyph} ${s.settled}` : s.glyph} data-state={state} data-size={size} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      {state === "done" ? <Check className={s.icon} strokeWidth={3} aria-hidden /> : state === "failed" ? <X className={s.icon} strokeWidth={3} aria-hidden /> : null}
    </span>
  );
}
