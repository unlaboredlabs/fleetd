// The app's one stepped clock for its loops (ui/DESIGN.md): while something live is on screen (a working or thinking
// glyph, words being made, the lead writing, a PR in CI), the beat advances every BEAT_MS, 0 to BEATS - 1, and hands
// each loop the new beat to write onto its own elements: a glyph marks the cells whose light changes (data-lit), a
// scan or a band takes the beat as data-step for its CSS. So every loop steps together, and a beat restyles only the
// few cells that change, never the page. Between beats nothing moves and no frame is drawn (a running CSS animation
// would keep a frame every vsync, and a key would wait for the next).
//
// The beat keeps its tempo whatever you do: it steps on the clock, so typing, clicking or scrolling neither slows it
// nor makes it stutter. But while you type it draws no frame of its own: a key, click or wheel within RIDE_MS of a
// step, before or after, takes the step onto its own frame, as a beat's frame drawn just before a key keeps the key
// off the screen until that frame is out (keypress p95 10-13 ms on CI's runner, 7 riding). A step held up by a long
// task lands as soon as the thread is free; either way the next stays on the clock.
//
// :root carries data-beat while the beat runs; no beat while the window is hidden, or with reduced motion: then :root
// has no data-beat, and each loop shows its still shape.
import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

export const BEAT_MS = 120;
export const BEATS = 24;
/** How far a step moves to draw with a key, click or wheel: either way, a quarter beat at most. */
export const RIDE_MS = 30;

/** One loop's step: writes what the loop shows on `beat` onto its elements, touching only what changes. */
export type Step = (beat: number) => void;

const loops = new Set<{ step: Step }>();
let timer: number | undefined;
let beat = 0;
/** When beat 0 would have stepped, on performance.now()'s clock: beat n steps at `zero + n × BEAT_MS`. */
let zero = 0;
let inputAt = -Infinity;
/** A step fell due just after an input: it waits up to RIDE_MS for the next one. */
let held = false;

/** Steps to the beat the clock is on and waits for the next: a tick a long task held late doesn't slow the loops. */
const tick = (): void => {
  held = false;
  window.clearTimeout(timer);
  const now = performance.now();
  const n = Math.max(Math.round((now - zero) / BEAT_MS), 1);
  zero += n * BEAT_MS;
  beat = (beat + n) % BEATS;
  for (const loop of loops) loop.step(beat);
  timer = window.setTimeout(onDue, zero + BEAT_MS - now);
};

const onDue = (): void => {
  if (!held && performance.now() - inputAt < BEAT_MS) {
    held = true;
    timer = window.setTimeout(tick, RIDE_MS);
  } else tick();
};

const onInput = (): void => {
  inputAt = performance.now();
  if (timer !== undefined && (held || zero + BEAT_MS - inputAt <= RIDE_MS)) tick();
};

const reduced = (): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const sync = (): void => {
  const root = document.documentElement;
  const run = loops.size > 0 && !document.hidden && !reduced();
  if (run && timer === undefined) {
    root.dataset["beat"] = "";
    zero = performance.now();
    timer = window.setTimeout(onDue, BEAT_MS);
  } else if (!run && timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
    // A beat that starts again steps on the clock until your next input.
    held = false;
    inputAt = -Infinity;
    delete root.dataset["beat"];
  }
};

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", sync);
  // Capture, ahead of the app's own handlers: whatever they change draws on the same frame as the step.
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
