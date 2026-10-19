// The one 1 Hz clock for every elapsed label: they all change on the same frame, once a second, and only while
// something with a running clock is mounted and the window is visible. Nothing ticks when idle.
import { useSyncExternalStore } from "react";

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

/**
 * Local epoch ms, re-rendering once a second while `running`. When not running it returns the time of the last
 * tick and never re-renders on its own.
 */
export const useNow = (running: boolean): number => useSyncExternalStore(running ? subscribe : noop, read);
