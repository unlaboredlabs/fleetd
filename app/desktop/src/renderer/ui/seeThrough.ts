import { useCallback, useState } from "react";

// The see-through sidebar (macOS vibrancy, main/index.ts): on by default, a choice kept on this device. Off, the page
// sets data-solid-sidebar on <html> and the sidebar paints its own --sidebar tone over the window's material, as on
// Linux and with Reduce transparency (layout.module.css). The window keeps its material either way, so the switch
// takes at once, with no window made again.

const STORAGE_KEY = "fleetd.sidebar";

/**
 * Whether this window can show the sidebar see-through at all: only the Mac desktop app's, whose page main.tsx marks
 * data-vibrancy from preload's vibrancy (and QA's stand-in for that window marks too).
 */
export const canSeeThrough = (): boolean => document.documentElement.dataset["vibrancy"] !== undefined;

/** The saved choice; on when there is none. */
export function storedSeeThrough(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "solid";
  } catch {
    return true;
  }
}

/** Sets or clears data-solid-sidebar on <html>. Call before the first render so the first paint is already right. */
export function applySeeThrough(on: boolean = storedSeeThrough()): void {
  if (on) delete document.documentElement.dataset["solidSidebar"];
  else document.documentElement.dataset["solidSidebar"] = "";
}

/** The switch's state: setting it applies at once and keeps the choice. */
export function useSeeThrough(): { on: boolean; setOn: (on: boolean) => void } {
  const [on, setState] = useState(storedSeeThrough);
  const setOn = useCallback((next: boolean) => {
    setState(next);
    applySeeThrough(next);
    try {
      if (next) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, "solid");
    } catch {
      // Storage can be unavailable (a locked profile); the choice still holds for this run.
    }
  }, []);
  return { on, setOn };
}
