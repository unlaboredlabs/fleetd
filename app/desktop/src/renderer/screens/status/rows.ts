// Status is one row per project, from the hub's `status_projects` (H6): a state word, the two-tone progress bar,
// agents running, last merged. The state word is the one the sidebar dot and the chat header show
// (projectStateWord over the data layer's project row): "waiting on you" comes only from the hub's chat state, and
// this row adds only "blocked" and a working its agents can't show. An unknown state reads as idle.

import type { ProjectStatusRow } from "../../../shared/contracts";
import { projectStateWord, type ProjectRow } from "../../src/data/selectors";

export type StateWord = "waiting_on_you" | "blocked" | "working" | "idle";

export const STATE_WORDS: Readonly<Record<StateWord, string>> = {
  waiting_on_you: "waiting on you",
  blocked: "blocked",
  working: "working",
  idle: "idle",
};

const RANK: Readonly<Record<StateWord, number>> = { waiting_on_you: 0, blocked: 1, working: 2, idle: 3 };

const key = (row: ProjectStatusRow): string => `${row.projectRef.machineId}/${row.projectRef.projectId}`;

/** The row's word: the project's chat state (needs you, working) with the row's own "blocked" and PR/CI working. */
export const stateWord = (row: ProjectStatusRow, project: Pick<ProjectRow, "needsYou" | "working"> | undefined): StateWord =>
  projectStateWord(project?.needsYou ?? false, project?.working ?? false, row.state);

/** The bar: solid = verified, lighter = credit for work in flight. Null when nothing can be counted (never 0%). */
export interface Bar {
  readonly pct: number;
  readonly verifiedPct: number;
  readonly inFlightPct: number;
}

const clamp = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

export const barOf = (row: ProjectStatusRow): Bar | null => {
  const p = row.progress;
  if (p === undefined) return null;
  const verifiedPct = clamp(p.verifiedPct);
  // The lighter part never claims past 100, whatever rounding did.
  return { pct: clamp(p.pct), verifiedPct, inFlightPct: Math.min(clamp(p.inFlightPct), 100 - verifiedPct) };
};

export interface WordedRow {
  readonly row: ProjectStatusRow;
  readonly word: StateWord;
}

/** Each row with its word, what needs you first, then blocked, working, idle; by title within each. */
export const orderRows = (rows: readonly ProjectStatusRow[], projects: readonly ProjectRow[] | undefined): WordedRow[] => {
  const byKey = new Map((projects ?? []).map((p) => [p.key, p]));
  return rows
    .map((row) => ({ row, word: stateWord(row, byKey.get(key(row))) }))
    .sort((a, b) => RANK[a.word] - RANK[b.word] || a.row.title.localeCompare(b.row.title));
};
