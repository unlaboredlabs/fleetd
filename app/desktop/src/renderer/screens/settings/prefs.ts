// This device's own choices, kept in the renderer's storage (they are per install, like the theme E2 keeps there).
import { useSyncExternalStore } from "react";

export type MotionPref = "system" | "reduce" | "full";

export const MOTION_PREFS: ReadonlyArray<{ value: MotionPref; label: string }> = [
  { value: "system", label: "Match system" },
  { value: "reduce", label: "Reduced" },
  { value: "full", label: "Full" },
];

const KEY = { motion: "fleetd.motion", collapsed: "fleetd.settings.promptGroups" } as const;

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
let collapsed: ReadonlySet<string> = parseCollapsed(read(KEY.collapsed));

export function parseMotion(raw: string | null): MotionPref {
  return raw === "reduce" || raw === "full" ? raw : "system";
}

/** The stored list of collapsed groups, or the first-run default: everything but the lead's and the tasks'. */
export function parseCollapsed(raw: string | null): ReadonlySet<string> {
  if (raw !== null) {
    try {
      const v: unknown = JSON.parse(raw);
      if (Array.isArray(v)) return new Set(v.filter((x): x is string => typeof x === "string"));
    } catch {
      // A damaged value falls back to the default below.
    }
  }
  return new Set(["orders", "task-news", "reviews", "train", "digest", "keep-going", "one-shots", "playbooks", "other"]);
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

export function toggleGroup(key: string) {
  const next = new Set(collapsed);
  if (!next.delete(key)) next.add(key);
  collapsed = next;
  write(KEY.collapsed, JSON.stringify([...next]));
  notify();
}

export const useMotion = () => useSyncExternalStore(subscribe, () => motion);
export const useCollapsed = () => useSyncExternalStore(subscribe, () => collapsed);
