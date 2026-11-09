// How wide the sidebar is. You set it by dragging its right edge or with the arrow keys on that edge; a double-click
// goes back to the default (tokens.css --sidebar-w). It never goes under SIDEBAR_MIN_PX, where rows, avatars and
// unread dots still read, nor past SIDEBAR_MAX_PX or SIDEBAR_SHARE of the window, whichever is smaller, so a narrowed
// window takes it in too. Kept across launches in this window's storage.
import { useCallback, useState, useSyncExternalStore } from "react";
import { shownWidth, type WidthBounds } from "./panelWidth";

export const SIDEBAR_MIN_PX = 200;
export const SIDEBAR_MAX_PX = 420;
/** Of the window, at most. */
export const SIDEBAR_SHARE = 0.4;
/** As tokens.css has it. */
export const SIDEBAR_DEFAULT_PX = 264;

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

export const sidebarBounds = (windowPx: number): WidthBounds => {
  const max = Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, Math.floor(windowPx * SIDEBAR_SHARE)));
  return { min: SIDEBAR_MIN_PX, max, initial: clamp(SIDEBAR_DEFAULT_PX, SIDEBAR_MIN_PX, max) };
};

/** The width it shows in this window: the one you set, within bounds, else the default. */
export const sidebarWidth = (set: number | null, windowPx: number): number => shownWidth(set, sidebarBounds(windowPx));

const KEY = "fleetd.sidebar.width";

export const readSidebarWidth = (): number | null => {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  } catch {
    // Unreadable: the default, as on a first launch.
    return null;
  }
};

const onResize = (change: () => void) => {
  window.addEventListener("resize", change);
  return () => window.removeEventListener("resize", change);
};

/**
 * The width it shows and setting it (null resets it), saved as each change lands, not on every drag frame. A resize
 * of the window renders again only when it moves the width shown: in most windows the max is past it.
 */
export function useSidebarWidth(): [number, (width: number | null) => void] {
  const [set, setSet] = useState(readSidebarWidth);
  const shown = useSyncExternalStore(onResize, () => sidebarWidth(set, window.innerWidth));
  const save = useCallback((width: number | null) => {
    setSet(width);
    try {
      if (width === null) window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, JSON.stringify(width));
    } catch {
      // Without storage it keeps the width until the app quits.
    }
  }, []);
  return [shown, save];
}
