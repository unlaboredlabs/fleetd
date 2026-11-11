import { describe, expect, it } from "vitest";
import type { DiffLine, PrFile, PrReviewEntry, PrRow } from "../../../shared/contracts";
import { DIFF_PAGE, diffRows, fileRowIndex, toPairs, type Page } from "./diffModel";
import { listItems, openGroup, rowMeta, type Item } from "./listModel";
import { resolvePr } from "./PrsPane";
import { checksShort, checksWord, findingsWord, githubLine, movedWords, openCount, reviewsWord, sortChecks, stat, stateLine, when } from "./words";

const row = (over: Partial<PrRow> = {}): PrRow => ({
  repo: "acme/storefront",
  number: 11,
  url: "https://github.com/acme/storefront/pull/11",
  title: "Receipts show the shop's local time",
  state: "open",
  review: { state: "pending", done: 1, needed: 3 },
  author: { role: "implementer", profile: "high" },
  createdAt: "2026-10-19T08:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
  ...over,
});

const queue = (state: NonNullable<PrRow["queue"]>["state"], over: Partial<NonNullable<PrRow["queue"]>> = {}) => ({ changeId: "X1", state, length: 3, paused: false, ...over });

describe("where a PR is on its way to main", () => {
  it("says the merge queue's place in plain words, never its name or raw state", () => {
    expect(stateLine(row({ queue: queue("queued", { position: 1 }) })).sentence).toBe("Waiting to merge, 2nd of 3 in line.");
    expect(stateLine(row({ queue: queue("ready", { position: 0 }) }))).toMatchObject({ word: "ready to merge", tone: "working" });
    expect(stateLine(row({ queue: queue("ci_failed") }))).toMatchObject({ word: "checks failed", tone: "failed" });
    expect(stateLine(row({ queue: queue("needs_rebase") })).word).toBe("conflicts");
    for (const s of ["queued", "reviewing", "ready", "rebasing", "ci", "merging", "merged", "needs_rebase", "ci_failed", "refused", "abandoned"] as const) {
      const line = stateLine(row({ queue: queue(s) }));
      expect(`${line.word} ${line.sentence}`).not.toMatch(/train|queue|_/u);
    }
  });

  it("gives a place in line in the PR's sentence, and only while it waits in one", () => {
    expect(stateLine(row({ queue: queue("reviewing", { position: 1 }) })).sentence).toBe("In review, 2nd of 3 in line. It merges once its reviews and checks pass.");
    expect(stateLine(row({ queue: queue("queued", { position: 0, length: 1 }) })).sentence).toBe("Waiting to merge, next in line.");
    expect(stateLine(row({ queue: queue("needs_rebase", { position: 1 }) })).sentence).not.toMatch(/in line/u);
  });

  it("puts GitHub's state first, and reads a state from a newer hub as plain open", () => {
    expect(stateLine(row({ state: "merged", queue: queue("ci_failed") })).word).toBe("merged");
    expect(stateLine(row({ state: "closed" })).sentence).toBe("Closed without merging.");
    expect(stateLine(row({ state: "draft" })).word).toBe("draft");
    expect(stateLine(row()).word).toBe("open");
    expect(stateLine(row({ queue: { ...queue("queued"), state: "teleporting" as never } })).word).toBe("open");
    expect(movedWords("ci_failed")).toBe("Checks failed");
    expect(movedWords("teleporting")).toBeUndefined();
  });
});

describe("checks and reviews", () => {
  it("leads with what failed, then what runs", () => {
    expect(checksWord({ state: "failing", passed: 7, failed: 2, pending: 1 })).toEqual({ text: "2 checks failed", tone: "failed" });
    expect(checksWord({ state: "pending", passed: 7, failed: 0, pending: 1 })?.text).toBe("1 check running");
    expect(checksWord({ state: "passing", passed: 9, failed: 0, pending: 0 })?.text).toBe("All 9 checks passed");
    expect(checksWord({ state: "none", passed: 0, failed: 0, pending: 0 })).toBeUndefined();
    const names = sortChecks([
      { name: "lint", state: "passing" },
      { name: "docs", state: "none" },
      { name: "e2e", state: "pending" },
      { name: "rust", state: "failing" },
    ]).map((c) => c.name);
    expect(names).toEqual(["rust", "e2e", "lint", "docs"]);
  });

  it("counts reviews against what the work needs, and a review's open findings", () => {
    expect(reviewsWord({ state: "pending", done: 1, needed: 3 })?.text).toBe("Reviews 1 of 3");
    expect(reviewsWord({ state: "approved", done: 3, needed: 3 })?.text).toBe("Approved");
    expect(reviewsWord({ state: "changes_requested", done: 2, needed: 3 })?.tone).toBe("failed");
    expect(reviewsWord({ state: "none", done: 0, needed: 0 })).toBeUndefined();
    const review = (blocking?: number, nonBlocking?: number): PrReviewEntry => ({
      verdict: "changes_requested",
      text: "",
      current: true,
      at: "2026-10-19T10:00:00.000Z",
      ...(blocking === undefined ? {} : { blocking }),
      ...(nonBlocking === undefined ? {} : { nonBlocking }),
    });
    expect(findingsWord(review(2, 1))).toBe("2 blocking, 1 suggestion");
    expect(findingsWord(review(0, 3))).toBe("3 suggestions");
    expect(findingsWord(review())).toBe("");
  });

  it("formats figures and times compactly, in the viewer's zone", () => {
    expect([stat(48), stat(1234), stat(12_600)]).toEqual(["48", "1.2k", "13k"]);
    const now = Date.parse("2026-10-19T10:30:00.000Z");
    expect(when("2026-10-19T08:57:00.000Z", now, "UTC")).toBe("08:57");
    expect(when("2026-10-18T09:03:00.000Z", now, "UTC")).toBe("Sun 09:03");
    expect(when("2026-10-02T09:03:00.000Z", now, "UTC")).toBe("2 Oct");
  });
});

/** A list as words: a label with its count, a card by its PRs, a row by its number. */
const words = (list: readonly Item[]) =>
  list.map((i) =>
    i.kind === "group" || i.kind === "fold" ? `${i.label} ${i.count}` : i.kind === "moving" ? `card ${i.moving.prs.map((p) => p.number).join()}` : i.kind === "pr" ? i.row.number : i.kind === "note" ? i.text : "cut",
  );

const HOLD = "held: the PR has the `hold` label; the train takes it once the label is gone";

describe("the list", () => {
  const rows = [row({ number: 8, state: "merged" }), row({ number: 11 }), row({ number: 12, state: "draft" }), row({ number: 7, state: "closed" })];
  const card = (...numbers: number[]) => ({
    repo: "acme/storefront",
    moving: { stage: "ci" as const, since: "2026-10-19T10:00:00.000Z", prs: numbers.map((number) => ({ changeId: `X${number}`, repo: "acme/storefront", number, title: `PR ${number}`, at: "2026-10-19T10:00:00.000Z" })) },
  });

  it("is one list: the open PRs (drafts too) under Open, then the merged and closed ones folded under their count", () => {
    expect(words(listItems(rows))).toEqual(["Open 2", 11, 12, "Merged and closed 2"]);
    expect(words(listItems(rows, { rest: true }))).toEqual(["Open 2", 11, 12, "Merged and closed 2", 8, 7]);
    expect(words(listItems([row({ number: 8, state: "merged" }), row({ number: 11 })]))).toEqual(["Open 1", 11, "Merged 1"]);
    expect(listItems([])).toEqual([]);
  });

  it("says nothing is open above the fold when only merged ones are left", () => {
    expect(words(listItems([row({ number: 8, state: "merged" })]))).toEqual(["Nothing open.", "Merged 1"]);
  });

  it("orders the open PRs as someone acts on them: a look needed, what merges now, the line in the train's order, the rest", () => {
    const failed = row({ number: 10, checks: { state: "failing", passed: 4, failed: 2, pending: 0 } });
    const open = [
      row({ number: 14 }),
      row({ number: 9, queue: queue("queued", { position: 2 }) }),
      row({ number: 13, queue: queue("ready", { position: 0 }) }),
      failed,
      row({ number: 20, queue: queue("ci") }),
      row({ number: 23, queue: queue("ready", { position: 1, reason: HOLD }) }),
      row({ number: 19, queue: queue("needs_rebase") }),
      row({ number: 8, state: "merged" }),
    ];
    // What merges now is the card: its PR is not a row too.
    expect(words(listItems(open, { moving: [card(20)] }))).toEqual(["Needs a look 3", 10, 23, 19, "Merging now 0", "card 20", "In line 2", 13, 9, "Open 1", 14, "Merged 1"]);
    // Until the train is read, its head waits with the line.
    expect(words(listItems(open))).toEqual(["Needs a look 3", 10, 23, 19, "In line 3", 13, 9, 20, "Open 1", 14, "Merged 1"]);
    expect(open.map(openGroup)).toEqual(["open", "train", "train", "look", "train", "look", "look", "open"]);
  });

  it("names each repo's card when more than one train moves, and lists a card with no rows at all", () => {
    const two = listItems([], { moving: [card(20), { ...card(31), repo: "acme/admin" }] });
    expect(two.map((i) => (i.kind === "moving" ? i.repo : i.kind))).toEqual(["group", "acme/storefront", "acme/admin"]);
    expect(listItems([], { moving: [card(20)] })[1]).not.toHaveProperty("repo");
  });

  it("says under each title its state, checks and reviews, quietly; its repo, number and why it waits are its hover's", () => {
    const passing = { state: "passing", passed: 6, failed: 0, pending: 0 } as const;
    const approved = { state: "approved", done: 1, needed: 1 } as const;
    const meta = rowMeta(row({ checks: passing, review: approved }));
    expect(meta).toMatchObject({ ref: "storefront#11", why: undefined, state: { word: "open" }, checks: { text: "6 passed", tone: "done" }, review: { text: "Approved" } });
    // In line, its state word already says it passed review; a review still asked for, or failed, stays.
    expect(rowMeta(row({ checks: passing, review: approved, queue: queue("queued", { position: 1 }) }))).toMatchObject({ state: { word: "waiting to merge" }, review: undefined });
    expect(rowMeta(row({ queue: queue("reviewing", { position: 1 }) })).review?.text).toBe("Reviews 1 of 3");
    expect(rowMeta(row({ review: { state: "changes_requested", done: 1, needed: 1 }, queue: queue("reviewing") })).review?.tone).toBe("failed");
    // The state word says the checks failed already; a merged PR's checks and reviews are history.
    expect(rowMeta(row({ checks: { ...passing, failed: 2 }, queue: queue("ci_failed") })).checks).toBeUndefined();
    expect(rowMeta(row({ state: "merged", checks: passing, queue: queue("merged", { position: 0, reason: "old" }) }))).toMatchObject({ checks: undefined, review: undefined, why: undefined });
    expect(rowMeta(row({ repo: "solo", number: 3 })).ref).toBe("solo#3");
  });

  it("says a held PR is held, and why the train holds one or sent it back, without its tag or code marks", () => {
    const held = rowMeta(row({ queue: queue("ready", { position: 1, reason: HOLD }) }));
    expect(held.state).toMatchObject({ word: "held", tone: "needs-you" });
    expect(held.why).toBe("the PR has the hold label; the train takes it once the label is gone");
    expect(rowMeta(row({ queue: queue("needs_rebase", { reason: "src/shipping/zones.ts, src/shipping/rates.ts" }) }))).toMatchObject({ state: { word: "conflicts" }, why: "src/shipping/zones.ts, src/shipping/rates.ts" });
    expect(rowMeta(row({ queue: queue("ready", { position: 0 }) }))).toMatchObject({ state: { word: "ready to merge" }, why: undefined });
  });

  it("words a row's checks short", () => {
    expect(checksShort({ state: "failing", passed: 7, failed: 2, pending: 1 })).toEqual({ text: "2 failed", tone: "failed" });
    expect(checksShort({ state: "pending", passed: 7, failed: 0, pending: 1 })?.text).toBe("1 running");
    expect(checksShort({ state: "none", passed: 0, failed: 0, pending: 0 })).toBeUndefined();
  });

  it("counts drafts as open in the header", () => {
    expect(openCount([row(), row({ state: "draft" }), row({ state: "merged" }), row({ state: "closed" })])).toBe(2);
  });

  it("says a list GitHub didn't answer is fleetd's own, or GitHub's last answer when the hub kept one", () => {
    expect(githubLine([row(), row({ state: "merged" })])).toMatch(/^GitHub couldn’t be reached, so these are only the PRs fleetd made/u);
    // A rate limit: the hub answers with what GitHub said last, checks included.
    expect(githubLine([row(), row({ checks: { state: "passing", passed: 3, failed: 0, pending: 0 } })])).toMatch(/may be out of date\.$/u);
  });

  it("ends with Load more when the hub sent only the most recent, under the fold too", () => {
    const items = listItems([row({ number: 11 }), row({ number: 8, state: "merged" })], { cut: true });
    expect(words(items)).toEqual(["Open 1", 11, "Merged 1", "cut"]);
  });

  it("finds a PR a link names by number alone in the project's list", () => {
    const rows = [row({ number: 11 }), row({ number: 4, repo: "acme/docs" })];
    expect(resolvePr({ repo: null, number: 4 }, rows)).toEqual({ repo: "acme/docs", number: 4 });
    expect(resolvePr({ repo: null, number: 99 }, rows)).toBe("unknown");
    expect(resolvePr({ repo: null, number: 4 }, undefined)).toBeUndefined();
    expect(resolvePr({ repo: "acme/web", number: 4 }, undefined)).toEqual({ repo: "acme/web", number: 4 });
    expect(resolvePr(null, rows)).toBeUndefined();
  });
});

const file = (path: string, diffLines: number | undefined, over: Partial<PrFile> = {}): PrFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 1,
  ...(diffLines === undefined ? {} : { diffLines }),
  ...over,
});
const line = (kind: DiffLine["kind"], text: string): DiffLine => ({ kind, text });

describe("the diff's rows", () => {
  it("holds one row per line of every page not loaded yet, so a page landing moves nothing below it", () => {
    const files = [file("a.ts", DIFF_PAGE + 5), file("b.png", undefined)];
    const before = diffRows({ files, total: 2, pages: new Map(), mode: "unified", folded: new Set() });
    expect(before).toHaveLength(1 + DIFF_PAGE + 5 + 2);
    expect(before.filter((r) => r.kind === "pending" && r.first).map((r) => (r.kind === "pending" ? r.offset : -1))).toEqual([0, DIFF_PAGE]);

    const lines = [line("hunk", "fn main"), ...Array.from({ length: DIFF_PAGE - 1 }, (_, i) => line("context", `l${i}`))];
    const page: Page = { path: "a.ts", offset: 0, lines };
    const after = diffRows({ files, total: 2, pages: new Map([["a.ts", new Map([[0, page]])]]), mode: "unified", folded: new Set() });
    expect(after).toHaveLength(before.length);
    expect(after[1]?.kind).toBe("hunk");
    expect(after.at(-1)).toMatchObject({ kind: "note" });
  });

  it("folds a file to its header, and ends with a row that loads more files", () => {
    const rows = diffRows({ files: [file("a.ts", 3), file("b.ts", 2)], total: 150, pages: new Map(), mode: "unified", folded: new Set(["a.ts"]) });
    expect(rows.map((r) => r.kind)).toEqual(["file", "file", "pending", "pending", "more"]);
    expect(rows.at(-1)).toMatchObject({ kind: "more", left: 148 });
    expect(fileRowIndex(rows)).toEqual(new Map([[0, 0], [1, 1]]));
  });

  it("pairs a run of deletions with the additions after it, side by side", () => {
    const pairs = toPairs([line("hunk", ""), line("context", "a"), line("del", "b"), line("del", "c"), line("add", "B"), line("context", "d")]);
    expect(pairs.map((p) => ("hunk" in p ? "hunk" : `${p.left?.text ?? "·"}|${p.right?.text ?? "·"}`))).toEqual(["hunk", "a|a", "b|B", "c|·", "d|d"]);
  });
});
