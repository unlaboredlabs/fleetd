// When a machine offline is down, and the lines that say so (index.ts runs the sweep).
import { durationText } from "../link/duration.ts";

/** How long a machine stays offline before its admins are paged. */
export const DOWN_AFTER_MS = 10 * 60_000;
/** How often the sweep looks. */
export const SWEEP_EVERY_MS = 30_000;

/** `machine.down`'s summary: `away` ms offline. */
export const downSummary = (name: string, away: number) => `${name} has been offline for ${durationText(away)}`;
/** `machine.back`'s summary, after `away` ms offline. */
export const backSummary = (name: string, away: number) => `${name} is back online after ${durationText(away)}`;
