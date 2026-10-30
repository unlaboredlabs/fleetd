// The state glyph's frames (renderer/ui/primitives/StateGlyph.tsx): which of its 3×3 cells are lit on each beat of
// the two live states, and each state's still shape. Pure, with no imports, so the phone app draws the same glyph from
// the same data (app/mobile/src/ui/StateGlyph.tsx, through its src/desktop.ts).

export type GlyphState = "working" | "thinking" | "waiting" | "queued" | "paused" | "done" | "failed";

export const CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

/**
 * Working's grain, by phase then cell (reading order): each cell's 24 beats, `#` where it is lit. Cells flick on a beat
 * or two at a time, out of step with each other, the way a dither crawls; a phase is another point of the same pattern.
 */
export const GRAIN = [
  [
    ".##....####..##......##.",
    "....####..########....##",
    "...##...................",
    "..##............##......",
    ".##......##..####....##.",
    "..##..........##..##....",
    "#..........######......#",
    "......##............##..",
    ".....########....####...",
  ],
  [
    ".####..##......##..##...",
    "##..########....##....##",
    ".....................##.",
    "..........##........##..",
    "...##..####....##..##...",
    "........##..##......##..",
    ".....######......##.....",
    "##............##........",
    "#######....####........#",
  ],
  [
    ".##......##..##....####.",
    "######....##....####..##",
    "...............##.......",
    "....##........##........",
    ".####....##..##......##.",
    "..##..##......##........",
    "#####......##..........#",
    "........##........##....",
    "#....####........#######",
  ],
  [
    "...##..##....####..##...",
    "....##....####..########",
    ".........##.............",
    "........##............##",
    "...##..##......##..####.",
    "##......##..........##..",
    ".....##..........######.",
    "..##........##..........",
    "###........########....#",
  ],
] as const;

/** A loop's length in beats: the grain's, which thinking's 8-step ring divides. */
export const GRAIN_BEATS = 24;

/** Thinking's ring, clockwise from the top-left cell; the centre stays dark. */
export const RING = [0, 1, 2, 5, 8, 7, 6, 3] as const;

/**
 * How a live glyph's `cell` is lit on `beat`: "on", "trail" (thinking's last step, a shade behind it) or not at all.
 * Thinking walks one cell round the ring a beat at a time (960 ms round), a phase starting it two cells further on.
 */
export const litOn = (state: "working" | "thinking", phase: number, cell: number, beat: number): "on" | "trail" | undefined => {
  if (state === "working") return GRAIN[phase % 4]?.[cell]?.[beat % GRAIN_BEATS] === "#" ? "on" : undefined;
  const at = (beat + 2 * phase) % RING.length;
  if (RING[at] === cell) return "on";
  return RING[(at + RING.length - 1) % RING.length] === cell ? "trail" : undefined;
};

/** Where a glyph seeded by `seed` (an agent, a chat) starts its loop, 0 to 3: a list of them never steps as one. */
export const phaseOf = (seed = ""): number => {
  let hash = 7;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 997;
  return hash % 4;
};

/** Each held state's shape: its lit cells, in reading order. */
export const SHAPES: Readonly<Record<Exclude<GlyphState, "working" | "thinking">, readonly number[]>> = {
  waiting: CELLS,
  queued: [0, 1, 2, 3, 5, 6, 7, 8],
  paused: [0, 3, 6, 2, 5, 8],
  done: [6, 7, 8],
  failed: [0, 2, 4, 6, 8],
};

/**
 * How bright a live glyph's cells are (StateGlyph.module.css draws the same): working's sit dim and flick on, thinking's
 * sit dimmer, its trail a shade behind the lit cell and its centre dark.
 */
export const LEVELS = {
  working: { dim: 0.3, on: 1 },
  thinking: { dim: 0.18, trail: 0.45, on: 1, centre: 0 },
} as const;

/**
 * A live glyph's still shape (no beat: off screen, reduced motion), each cell's opacity: working a diamond on a dim
 * field, thinking the ring's top row lit.
 */
export const stillOf = (state: "working" | "thinking"): number[] =>
  CELLS.map((cell) => {
    if (state === "working") return cell % 2 === 1 ? LEVELS.working.on : LEVELS.working.dim;
    return cell < 3 ? LEVELS.thinking.on : cell === 4 ? LEVELS.thinking.centre : LEVELS.thinking.dim;
  });

/** A live glyph's `cell` on each beat of its loop, as opacities: what the phone steps through on its UI thread. */
export const cellFrames = (state: "working" | "thinking", phase: number, cell: number): number[] =>
  Array.from({ length: GRAIN_BEATS }, (_, beat) => {
    const lit = litOn(state, phase, cell, beat);
    if (state === "working") return lit === "on" ? LEVELS.working.on : LEVELS.working.dim;
    if (cell === 4) return LEVELS.thinking.centre;
    return lit === "on" ? LEVELS.thinking.on : lit === "trail" ? LEVELS.thinking.trail : LEVELS.thinking.dim;
  });
