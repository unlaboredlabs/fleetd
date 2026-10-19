// Status is one row per project, straight from the hub's `status_projects` (H6): a state word, the two-tone
// progress bar, agents running, last merged. This only orders the rows and turns wire values into words; an unknown
// state from a newer hub reads as idle rather than breaking.

import type { ProjectStatusRow } from "../../../shared/contracts";

export type StateWord = "waiting_on_you" | "blocked" | "working" | "idle";

export const STATE_WORDS: Readonly<Record<StateWord, string>> = {
  waiting_on_you: "waiting on you",
  blocked: "blocked",
  working: "working",
  idle: "idle",
};

const RANK: Readonly<Record<StateWord, number>> = { waiting_on_you: 0, blocked: 1, working: 2, idle: 3 };

export const stateWord = (state: string): StateWord => (state in RANK ? (state as StateWord) : "idle");

/** The bar: solid = verified, lighter = credit for work in flight. Null when nothing can be counted (never 0%). */
export interface Bar {
  readonly pct: number;
  readonly verifiedPct: number;
  readonly inFlightPct: number;
}

const clamp = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

export const barOf = (row: ProjectStatusRow): { bar: Bar | null; planning: boolean } => {
  const p = row.progress;
  if (p === undefined) return { bar: null, planning: false };
  if (p.planning?.active === true) return { bar: null, planning: true };
  const verifiedPct = clamp(p.verifiedPct);
  // The lighter part never claims past 100, whatever rounding did.
  return { bar: { pct: clamp(p.pct), verifiedPct, inFlightPct: Math.min(clamp(p.inFlightPct), 100 - verifiedPct) }, planning: false };
};

/** What needs you first, then what's blocked, working, idle; by title within each. */
export const orderRows = (rows: readonly ProjectStatusRow[]): ProjectStatusRow[] =>
  [...rows].sort((a, b) => RANK[stateWord(a.state)] - RANK[stateWord(b.state)] || a.title.localeCompare(b.title));
