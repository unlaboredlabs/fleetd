// The desktop's state glyph, as the phone draws it (ui/StateGlyph.tsx): each of its 3×3 cells either holds an opacity
// or steps through one per beat of the loop, from the desktop's own frames (desktop.ts, its shared/glyph.ts). Working is
// grain, thinking walks its ring; off screen or with Reduce Motion they hold the desktop's still shapes. Pure, so it is
// unit-tested.
import { cellFrames, CELLS, GRAIN_BEATS, SHAPES, stillOf, type GlyphState } from "./desktop";
import type { Palette } from "./theme";

export type { GlyphState };

/** A cell: a fixed opacity, or its opacity on each beat of the loop. */
export type GlyphCell = number | readonly number[];

/** The desktop's beat (ui/lib/beat): its loops step every this many ms. */
export const BEAT_MS = 120;

/** The loop's length in beats: every moving cell steps through this many. */
export const LOOP_BEATS = GRAIN_BEATS;

/** A glyph's 9 cells in reading order. `moving`: on screen with motion allowed; else a live state holds still. */
export const glyphCells = (state: GlyphState, phase: number, moving: boolean): GlyphCell[] => {
  if (state === "working" || state === "thinking") {
    const turn = Math.abs(Math.round(phase)) % 4;
    return moving ? CELLS.map((cell) => cellFrames(state, turn, cell)) : stillOf(state);
  }
  const lit = SHAPES[state];
  return CELLS.map((cell) => (lit.includes(cell) ? 1 : 0));
};

/** Its color, as the desktop's (StateGlyph.module.css): live and done in the success green, waiting amber, failed red. */
export const glyphColor = (t: Pick<Palette, "success" | "warning" | "danger" | "secondary" | "tertiary">, state: GlyphState): string => {
  switch (state) {
    case "working":
    case "thinking":
    case "done":
      return t.success;
    case "waiting":
      return t.warning;
    case "failed":
      return t.danger;
    case "paused":
      return t.secondary;
    case "queued":
      return t.tertiary;
  }
};
