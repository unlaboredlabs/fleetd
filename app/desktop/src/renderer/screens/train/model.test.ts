import { describe, expect, it } from "vitest";
import type { Change, PrCheck } from "../../../shared/contracts";
import { effectsOf } from "../../src/data/effects";
import { trainFixture, TRAIN_REPO } from "./fixture";
import { changesOf, checkLines, LINE_STATES, lineReads, movingNow, stageLine } from "./model";

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

describe("what merges now", () => {
  it("reads the fixture as one train with one PR in CI, titled from the PR list", () => {
    const { changes, prs } = trainFixture(PROJECT, NOW);
    expect(movingNow(changes, prs)).toMatchObject([{ repo: TRAIN_REPO, moving: { stage: "ci", prs: [{ number: 20, title: "Bump the image CDN client" }] } }]);
  });

  it("shows PRs in flight together as one batch at the stage of the one furthest behind", () => {
    const { changes, prs } = trainFixture(PROJECT, NOW, true);
    const moving = movingNow(changes, prs)[0]?.moving;
    expect(moving?.prs.map((p) => p.number)).toEqual([25, 26, 27]);
    expect(moving?.stage).toBe("ci");
    expect(moving === undefined ? undefined : stageLine(moving)).toBe("One CI run for all 3; green, they land together.");
    const mixed = movingNow([change(1, "merging"), change(2, "ci")], undefined)[0]?.moving;
    expect(mixed?.stage).toBe("ci");
    expect(mixed?.since).toBe("2026-10-19T10:02:00.000Z");
  });

  it("reads a PR by its branch when the PR list doesn't have it, and is nothing while none is in flight", () => {
    expect(movingNow([change(5, "rebasing", { position: 0 })], [])[0]?.moving.prs.map((p) => p.title)).toEqual(["fleetd/b5"]);
    expect(movingNow([change(5, "queued", { position: 0 }), change(6, "ready", { position: 1 }), change(7, "merged"), change(8, "abandoned")], undefined)).toEqual([]);
  });

  it("keeps each repo's train apart, the biggest batch first", () => {
    const now = movingNow([change(1, "ci"), change(2, "ci", { repo: "acme/admin", position: 0 }), change(3, "ci", { repo: "ACME/admin", position: 1 })], undefined);
    expect(now.map((m) => [m.repo, m.moving.prs.map((p) => p.number)])).toEqual([
      ["acme/admin", [2, 3]],
      [TRAIN_REPO, [1]],
    ]);
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

  it("reads the line, each state whole", () => {
    expect(lineReads(PROJECT)).toEqual(LINE_STATES.map((state) => ({ projectRef: PROJECT, state, limit: 100 })));
  });

  it("joins the reads' answers, a change that moved between two reads once and as it is now", () => {
    const before = change(7, "ci");
    const after = change(7, "merging", { updatedAt: "2026-10-19T10:30:00.000Z" });
    expect(changesOf([{ changes: [before] }, { changes: [after, change(8, "ready")] }]).map((c) => [c.prNumber, c.state])).toEqual([
      [7, "merging"],
      [8, "ready"],
    ]);
  });

  it("refetches the train on the hub's change and PR events", () => {
    const at = { seq: 1, at: NOW, summary: "" };
    for (const type of ["change.state", "change.queued", "pr.merged"]) {
      expect(effectsOf({ ...at, type }).invalidate).toContainEqual({ tool: "changes_list" });
    }
    expect(effectsOf({ ...at, type: "task.completed" }).invalidate).not.toContainEqual({ tool: "changes_list" });
  });
});
