// How far a leftward drag shows the thread's times (ui/Reveal.tsx): as far as the finger goes up to REVEAL, then at a
// quarter of its pace, so it stretches rather than stops.

/** How far the thread slides to show the times. */
export const REVEAL = 64;
const STRETCH = 0.25;

/** How far the times are shown, from a drag `dx` points sideways (leftward is negative). */
export const revealOf = (dx: number): number => {
  "worklet";
  const d = Math.max(0, -dx);
  return d <= REVEAL ? d : REVEAL + (d - REVEAL) * STRETCH;
};
