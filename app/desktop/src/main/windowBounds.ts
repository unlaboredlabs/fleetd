// Where the window reopens. Pure, so it is unit-tested; windowState.ts reads and writes the file.
import { z } from "zod";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const SavedWindow = z.object({
  x: z.int(),
  y: z.int(),
  width: z.int().positive(),
  height: z.int().positive(),
  maximized: z.boolean(),
  fullScreen: z.boolean(),
});
export type SavedWindow = z.infer<typeof SavedWindow>;

export interface Placement {
  /** No position means centred on the primary display. */
  readonly bounds: Rect | { readonly width: number; readonly height: number };
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

export interface Limits {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

/** How much of the window's top strip must be on a screen for it to be grabbed and moved back. */
const GRAB_WIDTH = 120;
const GRAB_HEIGHT = 32;

const overlap = (a: Rect, b: Rect): { width: number; height: number } => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
});

/** Anything unreadable (a missing or hand-edited file) is no saved state. */
export const parseSaved = (raw: unknown): SavedWindow | null => {
  const parsed = SavedWindow.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/**
 * The saved place when it is still on a screen (a display may have been unplugged since), clamped to fit that
 * screen; otherwise the saved size, centred on the primary display. `workAreas[0]` is the primary display.
 */
export const placeWindow = (saved: SavedWindow | null, workAreas: ReadonlyArray<Rect>, limits: Limits): Placement => {
  const primary = workAreas[0];
  const fit = (width: number, height: number, area: Rect | undefined) => ({
    width: Math.max(limits.minWidth, Math.min(width, area?.width ?? width)),
    height: Math.max(limits.minHeight, Math.min(height, area?.height ?? height)),
  });
  if (saved === null) return { bounds: fit(limits.width, limits.height, primary), maximized: false, fullScreen: false };
  const state = { maximized: saved.maximized, fullScreen: saved.fullScreen };
  const grab: Rect = { x: saved.x, y: saved.y, width: saved.width, height: GRAB_HEIGHT };
  const home = workAreas.find((area) => {
    const o = overlap(grab, area);
    return o.width >= Math.min(GRAB_WIDTH, saved.width) && o.height >= Math.min(GRAB_HEIGHT, saved.height);
  });
  if (home === undefined) return { bounds: fit(saved.width, saved.height, primary), ...state };
  const size = fit(saved.width, saved.height, home);
  // Pull it fully onto its screen, keeping the top-left where it was when it already fits.
  const x = Math.min(Math.max(saved.x, home.x), home.x + home.width - size.width);
  const y = Math.min(Math.max(saved.y, home.y), home.y + home.height - size.height);
  return { bounds: { x, y, ...size }, ...state };
};
