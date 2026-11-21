// How long a hosted box whose work didn't come back as its session ended is kept, and how often it is tried again,
// with nothing of the machine's: the node keeps its boxes by them (./hosted.ts `KEPT`), and a service with no node
// keeps its own the same way.

/**
 * A box whose work didn't come back as its session ended is kept, not deleted with the only copy of that work: tried
 * again at once, then every `KEPT_EVERY_MS` for `KEPT_FOR_MS` from then, within the hour its life is set to when it is
 * kept. boat.dev erases a stopped box's disk, so a kept box runs, and costs as one does, until its work is back or the
 * last try; then it is deleted without it and the lead is told.
 */
export const KEPT_FOR_MS = 50 * 60_000;
/** How often a kept box is tried again. */
export const KEPT_EVERY_MS = 10 * 60_000;
