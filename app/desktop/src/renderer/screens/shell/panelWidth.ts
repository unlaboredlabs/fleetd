// How wide the panel beside the chat is. You set it by dragging its edge or with the arrow keys on that edge; a
// double-click goes back to the default, which follows the window. Its two widths (its own, and the wide one it takes
// while you read a PR's changes) are set apart and kept across launches in this window's storage. Whatever was saved,
// it stays within bounds that leave the sidebar and the chat their room, so a narrowed window never squeezes the
// chat out.
import { useCallback, useEffect, useState } from "react";

export type PanelMode = "normal" | "wide";

export interface WidthBounds {
  readonly min: number;
  readonly max: number;
  /** Where a double-click puts it back. */
  readonly initial: number;
}

/** What the chat keeps beside a panel at its widest, past the sidebar. */
export const CHAT_MIN_PX = 360;
const SIDEBAR_PX = 240;
/** An arrow key's step; with Shift, four of them. */
export const STEP_PX = 16;

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** The same figures as tokens.css had for the fixed widths, with a max that leaves the chat its room. */
export const widthBounds = (mode: PanelMode, windowPx: number): WidthBounds => {
  const room = windowPx - SIDEBAR_PX - CHAT_MIN_PX;
  const [min, cap, share, initialCap] = mode === "normal" ? [320, 800, 0.3, 520] : [480, 1400, 0.55, 1040];
  const max = Math.max(min, Math.min(cap, room));
  return { min, max, initial: Math.round(clamp(Math.min(windowPx * share, initialCap), min, max)) };
};

/** The width it shows: the one you set, within bounds, else its default. */
export const shownWidth = (set: number | null, bounds: WidthBounds): number => Math.round(set === null ? bounds.initial : clamp(set, bounds.min, bounds.max));

/** An arrow key, Home or End on its edge: the width it moves to, or null for a key it doesn't take. The edge is on the
 *  panel's left, so Left widens it. */
export const keyedWidth = (key: string, shift: boolean, now: number, bounds: WidthBounds): number | null => {
  const step = shift ? STEP_PX * 4 : STEP_PX;
  switch (key) {
    case "ArrowLeft":
      return clamp(now + step, bounds.min, bounds.max);
    case "ArrowRight":
      return clamp(now - step, bounds.min, bounds.max);
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    default:
      return null;
  }
};

export type SavedWidths = Readonly<Record<PanelMode, number | null>>;

const KEY = "fleetd.panel.width";
const NONE: SavedWidths = { normal: null, wide: null };

const asWidth = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);

export const readWidths = (): SavedWidths => {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    if (typeof v === "object" && v !== null) {
      const o = v as Record<string, unknown>;
      return { normal: asWidth(o["normal"]), wide: asWidth(o["wide"]) };
    }
  } catch {
    // Unreadable: the defaults, as on a first launch.
  }
  return NONE;
};

/** The window's width, as its resizes move it. */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(window.innerWidth));
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return width;
}

/** The widths you set, and setting one (null resets it). Saved as each change lands, not on every drag frame. */
export function usePanelWidths(): [SavedWidths, (mode: PanelMode, width: number | null) => void] {
  const [widths, setWidths] = useState(readWidths);
  const set = useCallback((mode: PanelMode, width: number | null) => {
    setWidths((w) => {
      const next = { ...w, [mode]: width };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Without storage it keeps the width until the app quits.
      }
      return next;
    });
  }, []);
  return [widths, set];
}
