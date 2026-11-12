// The tasks' PR pick and limits (hub/tasks/pr.ts) and the sweep's and breaker's pure parts (hub/tasks/sweep.ts), as
// the package exports them for fleetd cloud.
import { expect, test } from "bun:test";
import { openElseMerged, PR_LOOKUP_GIVE_UP_MS, PR_LOOKUP_TIMEOUT_MS } from "../src/hub/tasks/pr.ts";
import { clockTime, END_EVENTS, list, ORPHAN_MS, pausedLines, RUN_EVENTS, syntheticEnd, type ThreadRow } from "../src/hub/tasks/sweep.ts";
import type { Task, ThreadRef } from "../src/shared/contracts.ts";
import { exported, findings, line, readRepo } from "./pkg/purity.ts";

test("the PR lookup's rules and the sweep's are the package's, with no hub behind them", () => {
  for (const [name, path] of [
    ["./hub/tasks/pr", "fleetd/src/hub/tasks/pr.ts"],
    ["./hub/tasks/sweep", "fleetd/src/hub/tasks/sweep.ts"],
  ] as const) {
    expect(exported()).toContainEqual({ name, path });
    expect(findings(path, readRepo).map(line)).toEqual([]);
  }
});

test("a branch's PR is its open one, else a merged one; a closed one isn't", () => {
  expect(openElseMerged("acme/web", [])).toBeUndefined();
  expect(openElseMerged("acme/web", [{ number: 3, state: "closed", merged_at: null }])).toBeUndefined();
  expect(openElseMerged("acme/web", [{ number: 3, state: "closed", merged_at: "2031-01-01T00:00:00Z" }, { number: 4, state: "open" }])).toBe(
    "https://github.com/acme/web/pull/4",
  );
  expect(openElseMerged("acme/web", [{ number: 3, state: "closed", merged: true }])).toBe("https://github.com/acme/web/pull/3");
  expect([PR_LOOKUP_TIMEOUT_MS, PR_LOOKUP_GIVE_UP_MS]).toEqual([60_000, 24 * 3600_000]);
});

test("the breaker's lines name the machine, the dead, who waits and when it resumes", () => {
  const at = Date.UTC(2031, 0, 2, 10, 42);
  expect(clockTime(at)).toBe("10:42 UTC");
  expect(list(["T1", "T2"])).toBe("T1, T2");
  const lines = pausedLines("devbox", ["T1", "T2", "T3"], at, ["T2"]);
  expect(lines).toStartWith("- Automatic recovery is paused on devbox: 3 agents died there within ");
  expect(lines).toContain("(T1, T2, T3)");
  expect(lines).toContain("\n  > T2 waits to resume; dead agents there resume again at 10:42 UTC");
  expect(pausedLines("devbox", ["T1"], at, [])).toContain("> None of yours waits on it;");
  expect(pausedLines("devbox", ["T1"], at, ["T4", "T5"])).toContain("> T4, T5 wait to resume;");
});

test("the sweep's orphan limit, its event lists, and a run's end made from the thread's row", () => {
  expect(ORPHAN_MS).toBe(2 * 60_000);
  expect(RUN_EVENTS).toEqual(["thread.started", "thread.waiting", ...END_EVENTS]);
  const thread: ThreadRef = { machineId: "devbox", threadId: "th1" };
  const task = { projectRef: { machineId: "devbox", projectId: "p1" } } as Task;
  const at = Date.UTC(2031, 0, 2, 10, 42);
  const row = (status: string, more: Partial<ThreadRow> = {}) => ({ thread: { status } as ThreadRow["thread"], ...more }) as ThreadRow;
  const ended = syntheticEnd(task, thread, row("completed", { lastRunId: "r1" }), at);
  expect([ended.type, ended.at, ended.machineId, ended.projectId, ended.threadId]).toEqual(["thread.completed", "2031-01-02T10:42:00.000Z", "devbox", "p1", "th1"]);
  expect(ended.data).toEqual({ status: "completed", runId: "r1", reconciled: true });
  expect(syntheticEnd(task, thread, row("failed"), at).type).toBe("thread.failed");
  expect(syntheticEnd(task, thread, row("idle", { lastRunStatus: "usage_limited" }), at).type).toBe("thread.usage_limited");
  expect(syntheticEnd(task, thread, row("idle"), at).type).toBe("thread.interrupted");
});
