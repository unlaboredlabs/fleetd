// How far a leftward drag shows the thread's times (ui/Reveal.tsx): as far as the finger has gone since the drag took
// hold, up to the time column's width, then at a quarter of its pace, so it stretches rather than stops. The column is
// as wide as the longest time at the person's text size. Under the time of the reply a turn ended with, dimmer, is how
// long the turn took ("4m 12s"): out of the row's flow as the time is, so the row is as tall with it as without, and off
// the screen until the drag. Its styles are plain ones here, which ui/Reveal.tsx draws with and reveal.test.ts lays out.

/** The longest time ("12:59 PM") in caption type at the default text size, and the column's padding either side. */
const TIME_TEXT = 56;
const TIME_PAD = 6;
/** The column's Texts grow with Dynamic Type up to this (their maxFontSizeMultiplier). */
export const TIME_SCALE = 1.2;
const STRETCH = 0.25;

/** The time column's width, and so how far the thread slides, at text size `fontScale`. */
export const revealWidth = (fontScale: number): number => Math.ceil(TIME_TEXT * Math.min(fontScale, TIME_SCALE)) + 2 * TIME_PAD;

/**
 * The column in its row: past the row's right end and the thread's `margin`, so off the screen until the thread
 * slides, and as tall as the row, its lines in the middle. The percent is the row's own width only because the row is
 * stretched to it (a view as wide as its content takes the percent of the width it was offered).
 */
export const timeColumn = (margin: number, width: number) => ({ position: "absolute", top: 0, bottom: 0, left: "100%", justifyContent: "center", marginLeft: margin, width }) as const;

/** A line of the column: the time, or how long the turn took. One line each, a longer one cut short. */
export const timeLine = { paddingLeft: TIME_PAD } as const;

/**
 * How far the times are shown: the drag's sideways travel `dx` (leftward is negative) past `from`, where it was when
 * the drag took hold, so the thread doesn't jump by the distance it takes to start; up to `width`, then stretching.
 */
export const revealOf = (dx: number, from: number, width: number): number => {
  "worklet";
  const d = Math.max(0, from - dx);
  return d <= width ? d : width + (d - width) * STRETCH;
};
