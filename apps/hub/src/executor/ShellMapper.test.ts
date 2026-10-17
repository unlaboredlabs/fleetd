import fs from "node:fs";
import { MachineId, type ThreadSummary } from "@fleetd/contracts";
import { OrchestrationV2ShellStreamItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { backoffMs } from "./Executors.ts";
import type { StoredThread } from "../store/HubStore.ts";
import {
  type Applied,
  type ApplyContext,
  applyShellItem,
  emptyShellState,
  phase,
  projectSummary,
  type ShellState,
  type Transition,
  transition,
  transitionEvent,
} from "./ShellMapper.ts";

// Recorded once from the S0 lab by test/record-fixtures.ts (lab-b, claude-haiku-5-5).
const decode = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellStreamItem));
const fixture = (name: string) => {
  const raw = JSON.parse(fs.readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8"));
  return { ...raw, items: (raw.items as unknown[]).map((i) => decode(i)) };
};
const live = fixture("shell-live.json");
const replay = fixture("shell-resume-replay.json");
const reset = fixture("shell-resume-snapshot.json");
const { a, c, d } = live.threads as Record<"a" | "c" | "d", string>;
type Item = typeof OrchestrationV2ShellStreamItem.Type;

const machineId = MachineId.make("lab-b");
const ctx = (over: Partial<ApplyContext> = {}): ApplyContext => ({
  machineId,
  now: "2026-10-17T11:00:00.000Z",
  stored: new Map(),
  baseline: false,
  ...over,
});
const isSnapshot = (i: Item) => i.kind === "snapshot";

/** Feeds items in order; returns the transitions as [type, which thread] plus the final state. */
const run = (items: ReadonlyArray<Item>, state: ShellState = emptyShellState(), c0: ApplyContext = ctx()) => {
  const names: Record<string, string> = { [a]: "a", [c]: "c", [d]: "d" };
  const events: Array<[string, string]> = [];
  for (const item of items) {
    for (const t of applyShellItem(state, item, c0).transitions) events.push([t.type, names[t.threadId] ?? t.threadId]);
  }
  return { state, events };
};

/** State as it stood when the recording began: the initial snapshot(s), before any turn ran. */
const beforeTurns = () => run(live.items.filter(isSnapshot), emptyShellState(), ctx({ baseline: true })).state;

describe("shell rows to events, live", () => {
  it("emits nothing for a machine's first (baseline) snapshot", () => {
    const { events, state } = run(live.items.filter(isSnapshot), emptyShellState(), ctx({ baseline: true }));
    expect(events).toEqual([]);
    expect(state.complete).toBe(true);
    expect(state.cursor).toBe(live.before);
  });

  it("emits each status transition once, in order", () => {
    const { events } = run(live.items.filter((i: Item) => !isSnapshot(i)), beforeTurns());
    expect(events).toEqual([
      ["thread.started", "a"], // run 3 (a follow-up message on a completed thread)
      ["thread.completed", "a"], // T3's own "waiting" without a pending request in between is not a wait on a human
      ["thread.started", "c"],
      ["thread.waiting", "c"], // approval request for `touch`
      ["thread.interrupted", "c"],
      ["thread.started", "d"],
      ["thread.failed", "d"],
    ]);
  });

  it("emits nothing for a row delivered again (T3 resends unchanged shells)", () => {
    const deltas: Item[] = live.items.filter((i: Item) => !isSnapshot(i));
    const once = run(deltas, beforeTurns()).events;
    expect(run(deltas.flatMap((i) => [i, i]), beforeTurns()).events).toEqual(once);
  });

  it("maps the failure class and message of a failed run", () => {
    const { state } = run(live.items, emptyShellState(), ctx({ baseline: true }));
    const failed = state.threads.get(d)!;
    expect(failed.summary).toMatchObject({
      status: "failed",
      lastError: { class: "provider_error", message: "Claude gave up after repeated API errors." },
      model: "claude-nonexistent-0",
      effort: "low",
    });
    expect(failed.summary.usageLimitResetAt).toBeUndefined();
    const event = transitionEvent({ type: "thread.failed", threadId: failed.summary.threadId }, failed, machineId);
    expect(event).toMatchObject({ type: "thread.failed", machineId, threadId: d, projectId: failed.summary.projectId });
    expect(event.summary).toBe(`"fixtures: bad model" on lab-b failed: provider_error: Claude gave up after repeated API errors.`);
  });
});

describe("resume", () => {
  const terminal = [
    ["thread.completed", "a"],
    ["thread.interrupted", "c"],
    ["thread.failed", "d"],
  ];

  it("replay: the leading project-only snapshot neither drops threads nor moves the cursor", () => {
    const state = beforeTurns();
    const threadsBefore = state.threads.size;
    const [first, ...rest] = replay.items as Item[];
    expect(first?.kind === "snapshot" && first.resolvedRepositoryIdentityRoots !== undefined).toBe(true);
    const applied = applyShellItem(state, first!, ctx());
    expect(applied.cursor).toBeUndefined();
    expect(state.cursor).toBe(live.before);
    expect(state.threads.size).toBe(threadsBefore);
    expect(run(rest, state).events.sort()).toEqual([...terminal].sort());
    expect(state.cursor).toBe(396);
  });

  it("snapshot (cursor past T3's head): diffs against what was known and reports what happened meanwhile", () => {
    const state = beforeTurns();
    expect(run(reset.items, state).events.sort()).toEqual([...terminal].sort());
    expect(state.cursor).toBe(396);
  });

  it("replay and snapshot resumes end in the same caches as the live stream", () => {
    const viaLive = run(live.items, emptyShellState(), ctx({ baseline: true })).state;
    const viaReplay = run(replay.items, beforeTurns()).state;
    const viaSnapshot = run(reset.items, beforeTurns()).state;
    const view = (s: ShellState) => ({
      threads: [...s.threads.values()].map((t) => ({ ...t.summary, asOf: "" })).sort((x, y) => x.threadId.localeCompare(y.threadId)),
      projects: [...s.projects.keys()].map((id) => projectSummary(s, machineId, id)),
    });
    expect(view(viaReplay)).toEqual(view(viaLive));
    expect(view(viaSnapshot)).toEqual(view(viaLive));
    const project = view(viaLive).projects[0]!;
    const statuses = view(viaLive).threads.map((t) => t.status);
    expect(project.threads).toEqual({
      running: 0,
      waiting: 0,
      failed: statuses.filter((s) => s === "failed").length,
      idle: statuses.filter((s) => s !== "failed").length,
    });
  });

  it("after a hub restart, a snapshot is diffed against rows stored before run tracking", () => {
    const before = beforeTurns();
    const stored = new Map([...before.threads].map(([id, t]) => [id, t.summary]));
    const { events } = run(reset.items, emptyShellState(), ctx({ stored }));
    // Such rows carry no run id, so run 3 of `a` (completed -> completed) is not visible here.
    expect(events.sort()).toEqual([
      ["thread.failed", "d"],
      ["thread.interrupted", "c"],
    ]);
  });

  it("after a hub restart, runs that ended while it was down are reported late, by run id", () => {
    const before = beforeTurns();
    const stored = new Map(
      [...before.threads].map(([id, t]) => [id, { ...t.summary, lastRunId: t.runId!, lastRunStatus: phase(t.summary) }]),
    );
    const state = emptyShellState();
    const applied = reset.items.map((item: Item) => applyShellItem(state, item, ctx({ stored })));
    const transitions = applied.flatMap((x: Applied) => x.transitions);
    expect(transitions.map((t: Transition) => [t.type, t.threadId, t.late]).sort()).toEqual(
      [
        ["thread.completed", a, true], // run 3 of `a`: same phase, new run id
        ["thread.failed", d, true],
        ["thread.interrupted", c, true],
      ].sort(),
    );
    const completed = transitions.find((t: Transition) => t.threadId === a)!;
    const event = transitionEvent(completed, state.threads.get(a)!, machineId);
    expect(event.data).toMatchObject({ status: "completed", late: true, runId: state.threads.get(a)!.runId });
    // Every changed row is written back with its run, so the next restart diffs against it.
    expect(applied.flatMap((x: Applied) => x.threads).findLast((t: StoredThread) => t.threadId === a)).toMatchObject({
      lastRunId: state.threads.get(a)!.runId,
      lastRunStatus: "completed",
    });
  });

  it("a hub restart with nothing new emits nothing", () => {
    const after = run(live.items, emptyShellState(), ctx({ baseline: true })).state;
    const stored = new Map([...after.threads].map(([id, t]) => [id, { ...t.summary, lastRunId: t.runId!, lastRunStatus: phase(t.summary) }]));
    expect(run(reset.items, emptyShellState(), ctx({ stored })).events).toEqual([]);
  });
});

describe("usage limits", () => {
  const failedRow = (live.items as Item[]).findLast((i) => i.kind === "thread.updated" && i.thread.id === d)!;
  if (failedRow.kind !== "thread.updated") throw new Error("fixture lacks d's failed row");
  const limited: Item = {
    ...failedRow,
    sequence: failedRow.sequence + 1,
    thread: { ...failedRow.thread, lastErrorClass: "usage_limit", lastError: "Usage limit reached.", usageLimitResetAt: "2026-10-17T15:00:00.000Z" },
  };

  it("a usage-limit failure is its own event and carries the reset time", () => {
    const state = beforeTurns();
    const { events } = run([limited], state);
    expect(events).toEqual([["thread.usage_limited", "d"]]);
    const tracked = state.threads.get(d)!;
    expect(tracked.summary).toMatchObject({ status: "failed", usageLimitResetAt: "2026-10-17T15:00:00.000Z" });
    expect(transitionEvent({ type: "thread.usage_limited", threadId: tracked.summary.threadId }, tracked, machineId).summary).toBe(
      `"fixtures: bad model" on lab-b hit the usage limit (resets 2026-10-17T15:00:00.000Z)`,
    );
  });

  it("a plain failure that turns into a usage limit on the same run is a transition", () => {
    const { state } = run(live.items, emptyShellState(), ctx({ baseline: true }));
    expect(run([limited], state).events).toEqual([["thread.usage_limited", "d"]]);
  });
});

describe("transition", () => {
  const s = (status: ThreadSummary["status"]) => ({ status }) as ThreadSummary;
  it("reports a whole run that happened between two observations", () => {
    expect(transition({ summary: s("completed"), runId: "r1" }, { summary: s("completed"), runId: "r2" })).toBe("thread.completed");
    expect(transition({ summary: s("completed"), runId: undefined }, { summary: s("completed"), runId: "r2" })).toBeUndefined();
  });
  it("does not call an answered approval a new start", () => {
    expect(transition({ summary: s("waiting"), runId: "r1" }, { summary: s("running"), runId: "r1" })).toBeUndefined();
    expect(transition({ summary: s("waiting"), runId: "r1" }, { summary: s("running"), runId: "r2" })).toBe("thread.started");
  });
  it("has no event for idle or cancelled (a restart continuation cancels the old run)", () => {
    expect(transition({ summary: s("running"), runId: "r1" }, { summary: s("cancelled"), runId: "r1" })).toBeUndefined();
    expect(transition({ summary: s("completed"), runId: "r1" }, { summary: s("idle"), runId: "r1" })).toBeUndefined();
  });
});

describe("backoffMs", () => {
  it("doubles from about 1 s to a 30 s cap, with jitter", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => backoffMs(n, 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(backoffMs(0, 0)).toBe(750);
    expect(backoffMs(0, 0.999)).toBeLessThanOrEqual(1250);
    expect(backoffMs(9, 0.999)).toBe(30000);
  });
});
