// The Shipping list's model: the project's pull requests in one list, in what order and under which labels, with what
// merges now among them, and what a row says under its title. No React here, so the tests read it directly.
import type { PrRow } from "../../../shared/contracts";
import type { Moving } from "../train/model";
import { checksShort, isOpen, reviewsWord, stateLine, type StateLine, type Tone } from "./words";

export type Item =
  | { readonly kind: "group"; readonly label: string; readonly count: number }
  /** What merges now on one repo's train: a card, not a row. `repo` names it when the project has more than one. */
  | { readonly kind: "moving"; readonly moving: Moving; readonly repo?: string }
  | { readonly kind: "pr"; readonly row: PrRow }
  /** The merged and closed ones, folded under their count until opened. */
  | { readonly kind: "fold"; readonly label: string; readonly count: number }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "cut" };

/** The train's prefix on a hold it keeps a ready PR under (the `hold` label, a base rule): it waits for a person. */
const HELD = "held: ";
const held = (row: PrRow): boolean => row.queue?.state === "ready" && row.queue.reason?.startsWith(HELD) === true;

/** Why the train holds a PR or sent it back, as a person reads it: without the "held: " tag or markdown code marks. */
const whyOf = (row: PrRow): string | undefined => {
  const said = row.queue?.reason?.trim().replaceAll(/`([^`]*)`/gu, "$1");
  if (said === undefined || said === "") return undefined;
  return said.startsWith(HELD) ? said.slice(HELD.length) : said;
};

/** Where an open PR stands, for its group: it needs a look (failed, held, or changes asked for), the train has it, or neither. */
export const openGroup = (row: PrRow): "look" | "train" | "open" => {
  const meta = rowMeta(row);
  if (held(row) || meta.state.tone === "failed" || meta.checks?.tone === "failed" || meta.review?.tone === "failed") return "look";
  return row.queue !== undefined ? "train" : "open";
};

const keyOf = (pr: { readonly repo: string; readonly number: number }): string => `${pr.repo.toLowerCase()}#${pr.number}`;
const byPlace = (a: PrRow, b: PrRow): number => (a.queue?.position ?? Number.MAX_SAFE_INTEGER) - (b.queue?.position ?? Number.MAX_SAFE_INTEGER);

export interface ListOptions {
  /** What merges now, one per repo with something moving (train/model): each shows as a card, its PRs not as rows. */
  readonly moving?: readonly { readonly repo: string; readonly moving: Moving }[];
  /** The merged and closed ones are unfolded. */
  readonly rest?: boolean;
  /** The hub sent only these: a Load more, last. */
  readonly cut?: boolean;
}

/**
 * The whole list, top to bottom in the order someone acts on it: the PRs that need a look, what merges now, the line
 * behind it in the train's order, the other open ones (drafts too), then the merged and closed ones folded under their
 * count. Each group under its label, in the hub's order unless said. Nothing at all is an empty list.
 */
export const listItems = (rows: readonly PrRow[], { moving = [], rest = false, cut = false }: ListOptions = {}): Item[] => {
  if (rows.length === 0 && moving.length === 0) return [];
  const inCard = new Set(moving.flatMap((m) => m.moving.prs.map(keyOf)));
  const open = rows.filter((r) => isOpen(r) && !inCard.has(keyOf(r)));
  const done = rows.filter((r) => !isOpen(r));
  const of = (id: ReturnType<typeof openGroup>) => open.filter((r) => openGroup(r) === id);
  const group = (label: string, list: readonly PrRow[]): Item[] =>
    list.length === 0 ? [] : [{ kind: "group", label, count: list.length }, ...list.map((row): Item => ({ kind: "pr", row }))];
  const cards = moving.map((m): Item => ({ kind: "moving", moving: m.moving, ...(moving.length > 1 ? { repo: m.repo } : {}) }));
  return [
    ...group("Needs a look", of("look")),
    ...(cards.length === 0 ? [] : [{ kind: "group" as const, label: "Merging now", count: 0 }, ...cards]),
    ...group("In line", of("train").toSorted(byPlace)),
    ...group("Open", of("open")),
    ...(open.length === 0 && cards.length === 0 ? [{ kind: "note" as const, text: "Nothing open." }] : []),
    ...(done.length === 0 ? [] : [{ kind: "fold" as const, label: done.some((r) => r.state !== "merged") ? "Merged and closed" : "Merged", count: done.length }]),
    ...(rest ? done.map((row): Item => ({ kind: "pr", row })) : []),
    ...(cut ? [{ kind: "cut" as const }] : []),
  ];
};

export interface Hint {
  readonly text: string;
  readonly tone: Tone;
}

/** What a row says under its title, each part quiet unless it failed. */
export interface RowMeta {
  /** "storefront#11": the repo's own name; the project names its owner. The row's hover says it, not the row. */
  readonly ref: string;
  /** Why the train holds it or sent it back, for the hover too: the conflict, the failing checks, the hold. */
  readonly why: string | undefined;
  readonly state: StateLine;
  readonly checks: Hint | undefined;
  readonly review: Hint | undefined;
}

export const rowMeta = (row: PrRow): RowMeta => {
  const open = isOpen(row);
  // The state word already says the checks failed or are running for the merge; a closed PR's checks don't matter.
  const review = reviewsWord(row.review);
  const checksSaid = row.queue?.state === "ci_failed" || row.queue?.state === "ci";
  return {
    ref: `${row.repo.slice(row.repo.lastIndexOf("/") + 1)}#${row.number}`,
    why: open ? whyOf(row) : undefined,
    // A held PR is ready, and waits for a person rather than its turn: it says so.
    state: held(row) ? { word: "held", sentence: "Held until someone lets it merge.", tone: "needs-you" } : stateLine(row),
    checks: row.checks === undefined || checksSaid || !open ? undefined : checksShort(row.checks),
    // On the train, its state word already says it passed review.
    review: !open || (row.queue !== undefined && review?.tone === "done") ? undefined : review,
  };
};
