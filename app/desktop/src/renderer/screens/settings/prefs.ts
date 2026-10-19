// This device's own choices, kept in the renderer's storage (they are per install, like the theme E2 keeps there).
import { useSyncExternalStore } from "react";

export type MotionPref = "system" | "reduce" | "full";

export const MOTION_PREFS: ReadonlyArray<{ value: MotionPref; label: string }> = [
  { value: "system", label: "Match system" },
  { value: "reduce", label: "Reduced" },
  { value: "full", label: "Full" },
];

const KEY = { motion: "fleetd.motion" } as const;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (a locked profile); the choice still holds for this run.
  }
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

let motion: MotionPref = parseMotion(read(KEY.motion));

export function parseMotion(raw: string | null): MotionPref {
  return raw === "reduce" || raw === "full" ? raw : "system";
}

/**
 * Sets <html data-motion> for tokens.css: `reduce` zeroes every duration, `full` keeps motion even when the OS asks
 * for less, and no attribute follows the OS. The shell calls it once before the first paint.
 */
export function applyMotion(pref: MotionPref = motion) {
  if (pref === "system") delete document.documentElement.dataset["motion"];
  else document.documentElement.dataset["motion"] = pref;
}

export function setMotion(pref: MotionPref) {
  motion = pref;
  write(KEY.motion, pref);
  applyMotion(pref);
  notify();
}

export const useMotion = () => useSyncExternalStore(subscribe, () => motion);
