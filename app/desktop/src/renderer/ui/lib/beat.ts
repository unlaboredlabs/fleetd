// The app's one stepped clock for its loops (ui/DESIGN.md): while something live is on screen (a working or thinking
// glyph, words being made, the lead writing, a PR in CI), the beat advances every BEAT_MS, 0 to BEATS - 1, and hands
// each loop the new beat to write onto its own elements: a glyph marks the cells whose light changes (data-lit), a
// scan or a band takes the beat as data-step for its CSS. So every loop steps together, and a beat restyles only the
// few cells that change, never the page. Between beats nothing moves and no frame is drawn (a running CSS animation
// would keep a frame every vsync, and a key would wait for the next).
//
// The beat keeps stepping while you type, click or scroll, but on your frames: a beat that falls due within
// INPUT_RIDE_MS of a key, click or wheel waits for the next one and steps with it, so the two draw on one frame and a
// key never waits out a frame of the beat's own. If nothing comes within a beat, it steps by itself.
//
// :root carries data-beat while the beat runs; no beat while the window is hidden, or with reduced motion: then :root
// has no data-beat, and each loop shows its still shape.
import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

export const BEAT_MS = 120;
export const BEATS = 24;
/** How long after a key, click or wheel a beat that falls due waits to step with the next one. */
export const INPUT_RIDE_MS = 600;

/** One loop's step: writes what the loop shows on `beat` onto its elements, touching only what changes. */
export type Step = (beat: number) => void;

const loops = new Set<{ step: Step }>();
let timer: number | undefined;
let beat = 0;
let inputAt = -Infinity;
/** A beat fell due while you were typing, clicking or scrolling: it steps with your next input. */
let due = false;

const advance = (): void => {
  due = false;
  beat = (beat + 1) % BEATS;
  for (const loop of loops) loop.step(beat);
};

const onBeat = (): void => {
  if (!due && performance.now() - inputAt < INPUT_RIDE_MS) due = true;
  else advance();
};

const onInput = (): void => {
  inputAt = performance.now();
  if (due && timer !== undefined) advance();
};

const reduced = (): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const sync = (): void => {
  const root = document.documentElement;
  const run = loops.size > 0 && !document.hidden && !reduced();
  if (run && timer === undefined) {
    root.dataset["beat"] = "";
    timer = window.setInterval(onBeat, BEAT_MS);
  } else if (!run && timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
    // A beat that starts again steps by itself until your next input.
    due = false;
    inputAt = -Infinity;
    delete root.dataset["beat"];
  }
};

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", sync);
  // Capture, ahead of the app's own handlers: whatever they change draws on the same frame as the beat.
  for (const type of ["keydown", "pointerdown", "wheel"] as const) window.addEventListener(type, onInput, { capture: true, passive: true });
  if (typeof window.matchMedia === "function") window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", sync);
}

/**
 * Keeps the beat going while `live` and mounted, calling `step` with each beat, and with the current one at once so
 * the loop shows the right frame before it paints. A new `step` (its state changed) takes over from the old one.
 */
export function useBeat(live: boolean, step: Step): void {
  useLayoutEffect(() => {
    if (!live) return undefined;
    // An entry of its own, so two loops sharing one function both count.
    const loop = { step };
    loops.add(loop);
    sync();
    step(beat);
    return () => {
      loops.delete(loop);
      sync();
    };
  }, [live, step]);
}

/** A ref for an element whose CSS steps on the beat: while `live` it carries the beat as data-step. */
export function useBeatRef<E extends HTMLElement>(live: boolean): RefObject<E | null> {
  const ref = useRef<E>(null);
  const step = useCallback((b: number) => ref.current?.setAttribute("data-step", String(b)), []);
  useBeat(live, step);
  return ref;
}
