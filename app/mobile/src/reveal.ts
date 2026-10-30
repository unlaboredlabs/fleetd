// How far a leftward drag shows the thread's times (ui/Reveal.tsx): as far as the finger has gone since the drag took
// hold, up to the time column's width, then at a quarter of its pace, so it stretches rather than stops. The column is
// as wide as the longest time at the person's text size.

/** The longest time ("12:59 PM") in caption type at the default text size, and the column's padding either side. */
const TIME_TEXT = 56;
const TIME_PAD = 6;
/** The time's Text grows with Dynamic Type up to this (its maxFontSizeMultiplier). */
export const TIME_SCALE = 1.2;
const STRETCH = 0.25;

/** The time column's width, and so how far the thread slides, at text size `fontScale`. */
export const revealWidth = (fontScale: number): number => Math.ceil(TIME_TEXT * Math.min(fontScale, TIME_SCALE)) + 2 * TIME_PAD;

/**
 * How far the times are shown: the drag's sideways travel `dx` (leftward is negative) past `from`, where it was when
 * the drag took hold, so the thread doesn't jump by the distance it takes to start; up to `width`, then stretching.
 */
export const revealOf = (dx: number, from: number, width: number): number => {
  "worklet";
  const d = Math.max(0, from - dx);
  return d <= width ? d : width + (d - width) * STRETCH;
};
