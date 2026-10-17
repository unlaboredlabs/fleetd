import type { Change, TrainState } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { humanTrainLines, leadTrainLines, type TrainFacts } from "./digest.ts";

const change = (n: number, over: Partial<Change>): Change =>
  ({
    changeId: `X${n}`,
    projectRef: { machineId: "lab-a", projectId: "p1" },
    repo: "wynn-dev/testbed",
    prNumber: 10 + n,
    prUrl: `https://github.com/wynn-dev/testbed/pull/${10 + n}`,
    branch: `fleetd/T${n}-x`,
    taskId: `T${n}`,
    workstreamId: "W1",
    serves: `done:${n}`,
    tier: "M",
    headSha: "a".repeat(40),
    state: "queued",
    reviews: [],
    createdAt: "2026-10-17T09:00:00.000Z",
    updatedAt: "2026-10-17T09:00:00.000Z",
    ...over,
  }) as Change;

const facts = (trains: ReadonlyArray<TrainState>, changes: ReadonlyArray<Change>, waivers: Record<string, string> = {}): TrainFacts => ({
  trains,
  changes,
  waivers: new Map(Object.entries(waivers)),
});

describe("train digest lines", () => {
  const changes = [
    change(4, { state: "ci_failed", lastError: "CI failed on aaaaaaaaaaaa: ci (failure)" }),
    change(3, { state: "ready" }),
    change(2, { state: "merged", mergedSha: "b".repeat(40), updatedAt: "2026-10-17T11:00:00.000Z" }),
    change(1, { state: "merged", mergedSha: "c".repeat(40), updatedAt: "2026-10-17T08:00:00.000Z" }),
  ];
  const trains: ReadonlyArray<TrainState> = [{ repo: "wynn-dev/testbed", frozen: true, queue: ["X3" as never] }];

  it("gives the lead its trains, merges since its last wake, PRs back with their authors and waivers", () => {
    expect(leadTrainLines(facts(trains, changes, { X3: "review waived by the polish-loop rule: two clean rounds" }), "2026-10-17T10:00:00.000Z")).toEqual([
      "- wynn-dev/testbed: frozen; queue X3 ready",
      `- X2 merged since your last wake: wynn-dev/testbed#12 as ${"b".repeat(12)} (serves done:2, by T2)`,
      "- X4 ci_failed: wynn-dev/testbed#14, by T4; CI failed on aaaaaaaaaaaa: ci (failure). The train told its author and retries the next push by itself.",
      "- X3 wynn-dev/testbed#13 (ready): review waived by the polish-loop rule: two clean rounds",
    ]);
  });

  it("gives the human merges since the last digest and only busy or frozen trains", () => {
    const since = Date.parse("2026-10-17T10:00:00.000Z");
    expect(humanTrainLines(facts(trains, changes), since)).toEqual([
      "Merged: wynn-dev/testbed#12 (X2, W1, tier M)",
      "Train wynn-dev/testbed: frozen; queue X3 ready",
      "Back with its author: wynn-dev/testbed#14 (X4) ci_failed",
    ]);
    expect(humanTrainLines(facts([{ repo: "wynn-dev/testbed", frozen: false, queue: [] }], []), since)).toEqual([]);
  });
});
