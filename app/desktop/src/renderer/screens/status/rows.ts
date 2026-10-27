// Status is one row per project, from the hub's `status_get` (H6): a state word, its work in groups (waiting on you,
// in review, working, landing, idle, done), agents running, last merged. The state word is the one the sidebar dot shows, and the one
// the chat's top bar follows when it says waiting on you or blocked (projectStateWord over the data layer's project row): "waiting on you" comes only from the hub's chat state, and
// this row adds only "blocked" and a working its agents can't show. An unknown state reads as idle.

import type { ProjectStatusRow, StatusGroup, StatusItem } from "../../../shared/contracts";
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

/** The groups in the hub's order; a group a newer hub sends reads as idle. */
export const GROUPS = ["waiting_on_you", "in_review", "working", "landing", "idle", "done"] as const;
export type Group = (typeof GROUPS)[number];

export const GROUP_WORDS: Readonly<Record<Group, string>> = {
  waiting_on_you: "waiting on you",
  in_review: "in review",
  working: "working",
  landing: "landing",
  idle: "idle",
  done: "done",
};

const COUNT_KEY = {
  waiting_on_you: "waitingOnYou",
  in_review: "inReview",
  working: "working",
  landing: "landing",
  idle: "idle",
  done: "done",
} as const satisfies Record<Group, keyof ProjectStatusRow["counts"]>;

const groupOf = (g: StatusGroup): Group => GROUPS.find((x) => x === g) ?? "idle";

export interface GroupView {
  readonly group: Group;
  readonly count: number;
  /** The newest of the group, as many as the hub listed. */
  readonly items: readonly StatusItem[];
}

/** The row's groups that have work, in order, with their counts and listed items. */
export const groupsOf = (row: ProjectStatusRow): GroupView[] =>
  GROUPS.map((group) => ({
    group,
    count: row.counts[COUNT_KEY[group]],
    items: row.items.filter((i) => groupOf(i.group) === group),
  })).filter((g) => g.count > 0);

/** "1 waiting on you · 2 working · 3 done"; empty when nothing is in any group. */
export const countsLine = (row: ProjectStatusRow): string =>
  groupsOf(row)
    .map((g) => `${String(g.count)} ${GROUP_WORDS[g.group]}`)
    .join(" · ");

/** Where an item opens: its agent in the project's panel, else its PR there, else the project's chat. */
export const itemHref = (ref: ProjectStatusRow["projectRef"], item: StatusItem): string => {
  const chat = `#/project/${encodeURIComponent(ref.machineId)}/${encodeURIComponent(ref.projectId)}`;
  if (item.taskId !== undefined) return `${chat}/agents/${encodeURIComponent(item.taskId)}`;
  if (item.pr !== undefined) return `${chat}/prs/${item.pr.repo.split("/", 2).map(encodeURIComponent).join("/")}/${String(item.pr.number)}`;
  return chat;
};

/** "T4 · #212 · CI failed": what names the item beside its title. */
export const itemRefs = (item: StatusItem): string =>
  [item.taskId, item.pr === undefined ? undefined : `#${String(item.pr.number)}`, item.why].filter((p) => p !== undefined).join(" · ");

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
