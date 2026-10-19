// The one 1 Hz clock for every elapsed label on the board: they all change on the same frame, once a second, and
// only while something with a running clock is mounted and the window is visible. Nothing ticks when idle.
import { createContext, useContext, useSyncExternalStore } from "react";

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

/** The clock's last reading, without subscribing: enough to decide whether to subscribe. */
export const peekNow = (): number => now;
const read = () => now;

/**
 * Local epoch ms, re-rendering once a second while `running`. When not running it returns the time of the last
 * tick and never re-renders on its own.
 */
export const useNow = (running: boolean): number => {
  const fixed = useContext(FixedNow);
  const live = useSyncExternalStore(fixed === undefined && running ? subscribe : noop, read);
  return fixed ?? live;
};

/** A frozen clock for fixtures and screenshots, so every elapsed label is the same on every run. */
export const FixedNow = createContext<number | undefined>(undefined);
