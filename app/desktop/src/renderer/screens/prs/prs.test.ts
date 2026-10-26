import { describe, expect, it } from "vitest";
import type { DiffLine, PrFile, PrReviewEntry, PrRow } from "../../../shared/contracts";
import { DIFF_PAGE, diffRows, fileRowIndex, toPairs, type Page } from "./diffModel";
import { emptyWords, filterCounts, inFilter, listItems, rowMeta, type Item } from "./listModel";
import { resolvePr } from "./PrsPane";
import { checksShort, checksWord, findingsWord, githubLine, movedWords, openCount, placeWord, reviewsWord, sortChecks, stat, stateLine, when } from "./words";

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

  it("gives a place in line in the row and the PR's sentence alike, and only while it waits in one", () => {
    const reviewing = row({ queue: queue("reviewing", { position: 1 }) });
    expect(stateLine(reviewing).sentence).toBe("In review, 2nd of 3 in line. It merges once its reviews and checks pass.");
    expect(rowMeta(reviewing).place).toBe("2nd in line");
    const alone = row({ queue: queue("queued", { position: 0, length: 1 }) });
    expect(stateLine(alone).sentence).toBe("Waiting to merge, next in line.");
    expect(rowMeta(alone).place).toBe("next in line");
    const conflicted = row({ queue: queue("needs_rebase", { position: 1 }) });
    expect(stateLine(conflicted).sentence).not.toMatch(/in line/u);
    expect(rowMeta(conflicted).place).toBeUndefined();
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

const words = (list: readonly Item[]) => list.map((i) => (i.kind === "group" ? `${i.label} ${i.count}` : i.kind === "cut" ? `cut ${i.count}` : i.row.number));

describe("the list", () => {
  const rows = [row({ number: 8, state: "merged" }), row({ number: 11 }), row({ number: 12, state: "draft" }), row({ number: 7, state: "closed" })];

  it("shows all of them with open PRs (drafts too) under one heading before merged and closed ones", () => {
    expect(words(listItems(rows, "all"))).toEqual(["Open 2", 11, 12, "Merged or closed 2", 8, 7]);
    expect(listItems([], "all")).toEqual([]);
  });

  it("filters to the open or the merged ones, in the hub's order and without a heading", () => {
    expect(words(listItems(rows, "open"))).toEqual([11, 12]);
    expect(words(listItems(rows, "merged"))).toEqual([8]);
    expect(rows.filter((r) => inFilter(r, "merged")).map((r) => r.number)).toEqual([8]);
    // A state from a newer hub is in All, never lost.
    expect(inFilter(row({ state: "queued" }), "all")).toBe(true);
    expect(inFilter(row({ state: "queued" }), "open")).toBe(false);
  });

  it("groups open PRs by where they stand: a look needed, on the merge train, the rest", () => {
    const failed = row({ number: 10, checks: { state: "failing", passed: 4, failed: 2, pending: 0 } });
    const queued = row({ number: 9, queue: queue("queued", { position: 1 }) });
    const open = [row({ number: 14 }), queued, failed];
    expect(words(listItems(open, "open"))).toEqual(["Needs a look 1", 10, "On the merge train 1", 9, "Open 1", 14]);
    expect(words(listItems([...open, row({ number: 8, state: "merged" })], "all"))).toEqual([
      "Needs a look 1",
      10,
      "On the merge train 1",
      9,
      "Open 1",
      14,
      "Merged or closed 1",
      8,
    ]);
  });

  it("counts each filter's rows", () => {
    expect(filterCounts(rows)).toEqual({ open: 2, merged: 1, all: 4 });
    expect(filterCounts([])).toEqual({ open: 0, merged: 0, all: 0 });
  });

  it("says what an empty filter has instead, and offers the filter that has something", () => {
    const merged = [row({ number: 8, state: "merged" })];
    expect(listItems(merged, "open")).toEqual([]);
    expect(emptyWords("open", filterCounts(merged))).toEqual({ title: "Nothing open", body: "1 merged.", offer: { filter: "merged", label: "Show merged" } });
    expect(emptyWords("open", filterCounts([row({ state: "closed" })])).offer?.filter).toBe("all");
    expect(emptyWords("merged", filterCounts([row()])).offer).toEqual({ filter: "open", label: "Show open" });
    expect(emptyWords("all", filterCounts([]))).toMatchObject({ title: "No pull requests yet", offer: undefined });
  });

  it("says under each title its repo and number, state, place in line, checks and reviews, quietly", () => {
    const passing = { state: "passing", passed: 6, failed: 0, pending: 0 } as const;
    const meta = rowMeta(row({ checks: passing, review: { state: "approved", done: 1, needed: 1 }, queue: queue("queued", { position: 1 }) }));
    expect(meta).toMatchObject({ ref: "storefront#11", state: { word: "waiting to merge" }, place: "2nd in line", checks: { text: "6 passed", tone: "done" }, review: { text: "Approved" } });
    expect(rowMeta(row({ queue: queue("ready", { position: 0 }) })).place).toBe("next in line");
    // The state word says the checks failed already; a merged PR's checks and reviews are history.
    expect(rowMeta(row({ checks: { ...passing, failed: 2 }, queue: queue("ci_failed") })).checks).toBeUndefined();
    expect(rowMeta(row({ state: "merged", checks: passing, queue: queue("merged", { position: 0 }) }))).toMatchObject({ checks: undefined, review: undefined, place: undefined });
    expect(rowMeta(row({ repo: "solo", number: 3 })).ref).toBe("solo#3");
  });

  it("words a row's checks and place in line short", () => {
    expect(checksShort({ state: "failing", passed: 7, failed: 2, pending: 1 })).toEqual({ text: "2 failed", tone: "failed" });
    expect(checksShort({ state: "pending", passed: 7, failed: 0, pending: 1 })?.text).toBe("1 running");
    expect(checksShort({ state: "none", passed: 0, failed: 0, pending: 0 })).toBeUndefined();
    expect(placeWord(queue("queued", { position: 2 }))).toBe("3rd in line");
    expect(placeWord(queue("reviewing"))).toBeUndefined();
    expect(placeWord(queue("needs_rebase", { position: 1 }))).toBeUndefined();
    expect(placeWord(undefined)).toBeUndefined();
  });

  it("counts drafts as open in the header", () => {
    expect(openCount([row(), row({ state: "draft" }), row({ state: "merged" }), row({ state: "closed" })])).toBe(2);
  });

  it("says a list GitHub didn't answer is fleetd's own, or GitHub's last answer when the hub kept one", () => {
    expect(githubLine([row(), row({ state: "merged" })])).toMatch(/^GitHub couldn’t be reached, so these are only the PRs fleetd made/u);
    // A rate limit: the hub answers with what GitHub said last, checks included.
    expect(githubLine([row(), row({ checks: { state: "passing", passed: 3, failed: 0, pending: 0 } })])).toMatch(/may be out of date\.$/u);
  });

  it("says so last when the hub sent only the most recent", () => {
    const items = listItems([row({ number: 11 }), row({ number: 8, state: "merged" })], "open", true);
    expect(items.at(-1)).toEqual({ kind: "cut", count: 2 });
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
