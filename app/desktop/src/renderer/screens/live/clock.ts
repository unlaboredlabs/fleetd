// The one 1 Hz clock for every elapsed label: they all change on the same frame, once a second, and only while
// something with a running clock is mounted and the window is visible. Nothing ticks when idle.
import { type RefObject, useEffect, useState, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let now = Date.now();
let timer: number | undefined;

const tick = () => {
  now = Date.now();
  for (const l of listeners) l();
  schedule();
};

const schedule = () => {
  window.clearTimeout(timer);
  timer = undefined;
  if (listeners.size === 0 || document.visibilityState === "hidden") return;
  // Lands just after the second turns, so every label flips together.
  timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 2);
};

const onVisibility = () => (document.visibilityState === "hidden" ? schedule() : tick());

const subscribe = (l: () => void) => {
  if (listeners.size === 0) document.addEventListener("visibilitychange", onVisibility);
  listeners.add(l);
  now = Date.now();
  schedule();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onVisibility);
      schedule();
    }
  };
};

const noop = () => () => undefined;
const read = () => now;
const reads = new Map<number, () => number>();
const reader = (stepMs: number | undefined): (() => number) => {
  if (stepMs === undefined) return read;
  let stepped = reads.get(stepMs);
  if (stepped === undefined) {
    stepped = () => {
      // First read after an idle spell: the last tick may be hours old, and a day word must not show it for a frame.
      if (listeners.size === 0) now = Date.now();
      return now - (now % stepMs);
    };
    reads.set(stepMs, stepped);
  }
  return stepped;
};

/**
 * Local epoch ms, re-rendering once a second while `running`, or once per `stepMs` (rounded down to it, so a
 * minute step re-renders as the minute turns). When not running it returns the time of the last tick and never
 * re-renders on its own.
 */
export const useNow = (running: boolean, stepMs?: number): number => useSyncExternalStore(running ? subscribe : noop, reader(stepMs));

/** Whether `ref` is in the viewport: a clock stops once its label scrolls out of view. */
export const useOnScreen = (ref: RefObject<Element | null>): boolean => {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setOn(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
};
