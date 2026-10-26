// The PR list's model: which rows a filter keeps, in what order and under which headings, what a row says under its
// title, and what an empty filter says instead. No React here, so the tests read it directly.
import type { PrRow } from "../../../shared/contracts";
import { checksShort, isOpen, placeWord, reviewsWord, stateLine, type StateLine, type Tone } from "./words";

export type PrFilter = "open" | "merged" | "all";

export const PR_FILTERS: readonly { readonly value: PrFilter; readonly label: string }[] = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "all", label: "All" },
];

export const inFilter = (row: Pick<PrRow, "state">, filter: PrFilter): boolean =>
  filter === "all" || (filter === "open" ? isOpen(row) : row.state === "merged");

export const filterCounts = (rows: readonly Pick<PrRow, "state">[]): Readonly<Record<PrFilter, number>> => ({
  open: rows.filter(isOpen).length,
  merged: rows.filter((r) => r.state === "merged").length,
  all: rows.length,
});

export type Item =
  | { readonly kind: "group"; readonly label: string; readonly count: number }
  | { readonly kind: "pr"; readonly row: PrRow }
  | { readonly kind: "cut"; readonly count: number };

/** Where an open PR stands, for its group: it needs a look (failed, or changes asked for), the train has it, or neither. */
export const openGroup = (row: PrRow): "look" | "train" | "open" => {
  const meta = rowMeta(row);
  if (meta.state.tone === "failed" || meta.checks?.tone === "failed" || meta.review?.tone === "failed") return "look";
  return row.queue !== undefined ? "train" : "open";
};

const OPEN_GROUPS = [
  ["look", "Needs a look"],
  ["train", "On the merge train"],
  ["open", "Open"],
] as const;

/**
 * The rows a filter keeps, in the hub's order within a group. Open PRs by where they stand: those that need a look
 * first, then those on the merge train, then the rest (drafts too); one group needs no heading. All adds the merged and
 * closed ones after, under their own. `cut`: the hub sent only these, said last.
 */
export const listItems = (rows: readonly PrRow[], filter: PrFilter = "all", cut = false): Item[] => {
  const tail = cut ? [{ kind: "cut" as const, count: rows.length }] : [];
  const kept = rows.filter((r) => inFilter(r, filter));
  if (kept.length === 0) return [];
  const prs = (list: readonly PrRow[]) => list.map((row) => ({ kind: "pr" as const, row }));
  const open = kept.filter(isOpen);
  const rest = kept.filter((r) => !isOpen(r));
  const groups = OPEN_GROUPS.map(([id, label]) => ({ label, rows: open.filter((r) => openGroup(r) === id) })).filter((g) => g.rows.length > 0);
  const headed = groups.length > 1 || (filter === "all" && rest.length > 0);
  const openItems = groups.flatMap((g) => [...(headed ? [{ kind: "group" as const, label: g.label, count: g.rows.length }] : []), ...prs(g.rows)]);
  if (filter !== "all") return [...(filter === "open" ? openItems : prs(kept)), ...tail];
  return [...openItems, ...(rest.length > 0 ? [{ kind: "group" as const, label: "Merged or closed", count: rest.length }, ...prs(rest)] : []), ...tail];
};

export interface Hint {
  readonly text: string;
  readonly tone: Tone;
}

/** What a row says under its title, each part quiet unless it failed. */
export interface RowMeta {
  /** "storefront#11": the repo's own name; the project names its owner. */
  readonly ref: string;
  readonly state: StateLine;
  /** Its place in line to merge. */
  readonly place: string | undefined;
  readonly checks: Hint | undefined;
  readonly review: Hint | undefined;
}

export const rowMeta = (row: PrRow): RowMeta => {
  const open = isOpen(row);
  // The state word already says the checks failed or are running for the merge; a closed PR's checks don't matter.
  const checksSaid = row.queue?.state === "ci_failed" || row.queue?.state === "ci";
  return {
    ref: `${row.repo.slice(row.repo.lastIndexOf("/") + 1)}#${row.number}`,
    state: stateLine(row),
    place: open ? placeWord(row.queue) : undefined,
    checks: row.checks === undefined || checksSaid || !open ? undefined : checksShort(row.checks),
    review: open ? reviewsWord(row.review) : undefined,
  };
};

/** What a filter with nothing in it says, and the filter it offers instead. */
export const emptyWords = (
  filter: PrFilter,
  counts: Readonly<Record<PrFilter, number>>,
): { readonly title: string; readonly body: string; readonly offer: { readonly filter: PrFilter; readonly label: string } | undefined } => {
  if (counts.all === 0) return { title: "No pull requests yet", body: "Open PRs show here, and those merged or closed.", offer: undefined };
  if (filter === "open") {
    return counts.merged > 0
      ? { title: "Nothing open", body: `${counts.merged} merged.`, offer: { filter: "merged", label: "Show merged" } }
      : { title: "Nothing open", body: "Nothing merged either.", offer: { filter: "all", label: "Show all" } };
  }
  return counts.open > 0
    ? { title: "Nothing merged", body: "Nothing merged yet.", offer: { filter: "open", label: "Show open" } }
    : { title: "Nothing merged", body: "Nothing merged yet.", offer: { filter: "all", label: "Show all" } };
};
