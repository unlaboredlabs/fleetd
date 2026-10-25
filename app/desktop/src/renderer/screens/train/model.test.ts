import { describe, expect, it } from "vitest";
import type { Change, PrCheck } from "../../../shared/contracts";
import { effectsOf } from "../../src/data/effects";
import { trainFixture, TRAIN_REPO } from "./fixture";
import { checkLines, onTrain, RECENT_MAX, stageLine, trainViews, type Recent } from "./model";

const NOW = "2026-10-19T10:30:00.000Z";
const PROJECT = { machineId: "devbox", projectId: "storefront" };

const change = (n: number, state: Change["state"], extra: Partial<Change> = {}): Change => ({
  changeId: `X${n}`,
  projectRef: PROJECT,
  repo: TRAIN_REPO,
  prNumber: n,
  prUrl: `https://github.com/${TRAIN_REPO}/pull/${n}`,
  branch: `fleetd/b${n}`,
  headSha: "a".repeat(40),
  state,
  reviews: [],
  workstreamId: "W1",
  createdAt: `2026-10-19T09:${String(n).padStart(2, "0")}:00.000Z`,
  updatedAt: `2026-10-19T10:${String(n).padStart(2, "0")}:00.000Z`,
  ...extra,
});

const numbers = (r: Recent): number[] => (r.kind === "merged" ? r.prs.map((p) => p.number) : [r.pr.number]);

describe("the train pane's model", () => {
  it("reads the fixture as one train: a PR in CI, the line in order, then what landed lately", () => {
    const { changes, prs } = trainFixture(PROJECT, NOW);
    const [view, ...more] = trainViews(changes, prs);
    expect(more).toEqual([]);
    expect(view?.moving).toMatchObject({ stage: "ci", prs: [{ number: 20, title: "Bump the image CDN client" }] });
    expect(view?.queue.map((q) => [q.pr.number, q.state, q.place])).toEqual([
      [21, "ready", 1],
      [22, "reviewing", 2],
      [23, "blocked", 3],
      [24, "queued", 4],
      [19, "blocked", undefined],
    ]);
    expect(view?.recent.map((r) => [r.kind, numbers(r)])).toEqual([
      ["merged", [18]],
      ["merged", [15, 16, 17]],
      ["refused", [14]],
      ["merged", [12]],
    ]);
  });

  it("says why a PR is blocked: its hold without the train's tag, its conflicts, its failed checks", () => {
    const view = trainViews(
      [
        change(1, "ready", { position: 0, lastError: "held: the PR has the `hold` label; the train takes it once the label is gone" }),
        change(2, "needs_rebase", { lastError: "src/a.ts" }),
        change(3, "ci_failed", { lastError: "unit tests, e2e" }),
        change(4, "ci_failed"),
      ],
      undefined,
    )[0];
    expect(view?.queue.map((q) => q.why)).toEqual([
      "the PR has the hold label; the train takes it once the label is gone",
      "Checks failed; back with its writer",
      "Checks failed: unit tests, e2e",
      "Conflicts with the base: src/a.ts",
    ]);
    expect(view?.queue.map((q) => q.sentBack)).toEqual([undefined, true, true, true]);
  });

  it("shows PRs in flight together as one batch at the stage of the one furthest behind", () => {
    const { changes, prs } = trainFixture(PROJECT, NOW, true);
    const moving = trainViews(changes, prs)[0]?.moving;
    expect(moving?.prs.map((p) => p.number)).toEqual([25, 26, 27]);
    expect(moving?.stage).toBe("ci");
    expect(moving === undefined ? undefined : stageLine(moving)).toBe("One CI run for all 3; green, they land together.");
    const mixed = trainViews([change(1, "merging"), change(2, "ci")], undefined)[0]?.moving;
    expect(mixed?.stage).toBe("ci");
    expect(mixed?.since).toBe("2026-10-19T10:02:00.000Z");
  });

  it("groups merges by their landed commit, and keeps the newest few", () => {
    const merged = Array.from({ length: 12 }, (_, i) => change(i + 1, "merged", { mergedSha: `${i}`.repeat(40) }));
    const batch = [change(30, "merged", { mergedSha: "f".repeat(40) }), change(31, "merged", { mergedSha: "f".repeat(40) })];
    const recent = trainViews([...merged, ...batch], undefined)[0]?.recent ?? [];
    expect(recent).toHaveLength(RECENT_MAX);
    expect(recent.slice(0, 2).map(numbers)).toEqual([[30, 31], [12]]);
  });

  it("reads a PR by its branch when the PR list doesn't have it, and leaves out abandoned changes", () => {
    const view = trainViews([change(5, "queued", { position: 0 }), change(6, "abandoned")], [])[0];
    expect(view?.queue.map((q) => q.pr.title)).toEqual(["fleetd/b5"]);
    expect(view?.recent).toEqual([]);
    expect(trainViews([change(6, "abandoned")], undefined)).toEqual([]);
  });

  it("keeps each repo's train apart, the busiest first", () => {
    const views = trainViews([change(1, "merged"), change(2, "ready", { repo: "acme/admin", position: 0 }), change(3, "reviewing", { repo: "ACME/admin", position: 1 })], undefined);
    expect(views.map((v) => [v.repo, v.queue.length])).toEqual([
      ["acme/admin", 2],
      [TRAIN_REPO, 0],
    ]);
  });

  it("counts the PRs on the train: in flight and in line, not those sent back", () => {
    const { changes } = trainFixture(PROJECT, NOW);
    expect(onTrain(trainViews(changes, undefined))).toBe(5);
    expect(onTrain([])).toBe(0);
  });

  it("lists the head's checks failed, then running, then passed, the rest counted", () => {
    const c = (name: string, state: string, conclusion?: string): PrCheck => ({ name, state, ...(conclusion === undefined ? {} : { conclusion }) });
    const lines = checkLines([c("lint", "passing", "success"), c("e2e", "pending"), c("build", "failing", "timed_out"), c("docs", "passing", "skipped"), c("unit", "passing")], 3);
    expect(lines.shown.map((l) => [l.name, l.word, l.tone])).toEqual([
      ["build", "timed out", "failed"],
      ["e2e", "running", "working"],
      ["lint", "passed", "done"],
    ]);
    expect(lines.more).toBe(2);
    const running = checkLines([c("a", "pending"), c("b", "pending"), c("c", "pending")], 1);
    expect(running.shown).toHaveLength(3);
  });

  it("refetches the train on the hub's change and PR events", () => {
    const at = { seq: 1, at: NOW, summary: "" };
    for (const type of ["change.state", "change.queued", "pr.merged"]) {
      expect(effectsOf({ ...at, type }).invalidate).toContainEqual({ tool: "changes_list" });
    }
    expect(effectsOf({ ...at, type: "task.completed" }).invalidate).not.toContainEqual({ tool: "changes_list" });
  });
});
