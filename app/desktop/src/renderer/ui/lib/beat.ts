// The app's one stepped clock for its loops (ui/DESIGN.md): while something live is on screen (a working or thinking
// glyph, words being made, the lead writing, a PR in CI), :root carries data-beat, 0 to BEATS - 1, advanced every
// BEAT_MS; the loops' CSS reads it, so every loop steps together and the page renders only on a beat. Between beats
// nothing moves and no frame is drawn, so a key press is drawn at once (a running CSS animation would keep a frame
// every vsync and make a key wait for the next). The beat yields to input: while you type, click or scroll, and for
// INPUT_HOLD_MS after, it skips its steps, so what you do is all that draws. No beat while the window is hidden, or
// with reduced motion: then :root has no data-beat, and each loop shows its still shape.
import { useEffect } from "react";

export const BEAT_MS = 120;
export const BEATS = 24;
/** How long after a key, click or wheel the beat holds still. */
export const INPUT_HOLD_MS = 600;

let users = 0;
let timer: number | undefined;
let beat = 0;
let heldUntil = 0;

const hold = (): void => {
  heldUntil = performance.now() + INPUT_HOLD_MS;
};

const reduced = (): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const sync = (): void => {
  const root = document.documentElement;
  const run = users > 0 && !document.hidden && !reduced();
  if (run && timer === undefined) {
    root.dataset["beat"] = String(beat);
    timer = window.setInterval(() => {
      if (performance.now() < heldUntil) return;
      beat = (beat + 1) % BEATS;
      root.dataset["beat"] = String(beat);
    }, BEAT_MS);
  } else if (!run && timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
    delete root.dataset["beat"];
  }
};

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", sync);
  for (const type of ["keydown", "pointerdown", "wheel"] as const) window.addEventListener(type, hold, { capture: true, passive: true });
  if (typeof window.matchMedia === "function") window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", sync);
}

/** Keeps the beat going while `live` and mounted. */
export function useBeat(live: boolean): void {
  useEffect(() => {
    if (!live) return undefined;
    users++;
    sync();
    return () => {
      users--;
      sync();
    };
  }, [live]);
}
