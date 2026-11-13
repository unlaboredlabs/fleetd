// Session rows to events, over one machine's day in the node's machine-stream shape:
// three sessions on one project, a completed turn (a), an
// approval then an interrupt (c) and a failure (d), first live, then resumed by replay and by snapshot.
import { expect, test } from "bun:test";
import {
  applyMachineEvent,
  knownRun,
  newShellState,
  phase,
  projectSummary,
  removedProjects,
  type ShellState,
  type StoredThread,
  transitionEvent,
} from "../src/hub/executor/shell_mapper.ts";
import { backoffMs } from "../src/hub/executor/index.ts";
import { parkedOf } from "../src/hub/usage/classify.ts";
import { type ParkedKind, UsageState } from "../src/hub/usage/state.ts";
import { classify, evidence } from "../src/node/runner/host/failure.ts";
import type { HubEvent } from "../src/shared/contracts.ts";
import type { MachineEvent, SessionSummary } from "../src/shared/sessions.ts";

const MACHINE = "lab-b";
const NOW = "2026-10-17T11:00:00.000Z";
const T0 = "2026-10-17T10:00:00.000Z";
const BEFORE = 10;
const AFTER = 17;

const at = (minute: number) => `2026-10-17T10:${String(minute).padStart(2, "0")}:00.000Z`;
const run = (id: string, status: string, ordinal: number, extra: Record<string, unknown> = {}) => ({ id, status, ordinal, ...extra });

function row(name: string, minute: number, latestRun: unknown, extra: Record<string, unknown> = {}): SessionSummary {
  return {
    sessionId: `s-${name}`,
    projectId: "p1",
    title: `fixtures: ${name}`,
    status: "idle",
    model: "claude-haiku-5-5",
    effort: "low",
    runtimeMode: "full-access",
    createdAt: T0,
    updatedAt: at(minute),
    ...(latestRun ? { latestRun } : {}),
    ...extra,
  } as SessionSummary;
}

const running = (name: string, minute: number, runId: string, ordinal: number) =>
  row(name, minute, run(runId, "running", ordinal), { status: "running", activeRunId: runId });
const aDoneBefore = () => row("a", 1, run("a1", "completed", 1), { latestAssistantTail: "OK\nsecond line" });
const aDone = () => row("a", 3, run("a2", "completed", 2), { latestAssistantTail: "TWO" });
const cWaiting = (request: string) =>
  row("c", 5, run("c1", "waiting", 1), {
    status: "waiting",
    activeRunId: "c1",
    pendingPermission: { requestId: request, toolName: "Bash", summary: "rm -rf build" },
  });
const cInterrupted = () => row("c", 6, run("c1", "interrupted", 1), { status: "interrupted" });
const dFailed = (failure: unknown) => row("d", 8, run("d1", "failed", 1, { failure }), { status: "failed" });
const plainFailure = () => ({ class: "other", message: "Claude gave up after repeated API errors." });
const project = () => ({ projectId: "p1", title: "fixtures", workspaceRoot: "/work/project", updatedAt: T0 });
const snapshot = (sessions: SessionSummary[]): MachineEvent => ({ type: "snapshot", projects: [project()], sessions });
const updated = (s: SessionSummary): MachineEvent => ({ type: "session_updated", ...s });

const baseline = (): [number, MachineEvent] => [BEFORE, snapshot([aDoneBefore(), row("c", 0, undefined), row("d", 0, undefined)])];
const live = (): [number, MachineEvent][] =>
  [running("a", 2, "a2", 2), aDone(), running("c", 4, "c1", 1), cWaiting("q1"), cInterrupted(), running("d", 7, "d1", 1), dFailed(plainFailure())].map(
    (s, i) => [BEFORE + 1 + i, updated(s)],
  );
const finals = () => [aDone(), cInterrupted(), dFailed(plainFailure())];

function feed(events: [number, MachineEvent][], state: ShellState, stored = new Map<string, StoredThread>(), isBaseline = false): [string, string][] {
  const out: [string, string][] = [];
  for (const [seq, event] of events) {
    for (const t of applyMachineEvent(state, seq, event, { machineId: MACHINE, now: NOW, stored, baseline: isBaseline }).transitions) {
      out.push([`thread.${t.kind}`, t.threadId.replace(/^s-/, "")]);
    }
  }
  return out;
}

const sorted = (v: [string, string][]) => [...v].sort((a, b) => (a.join() < b.join() ? -1 : 1));

function beforeTurns(): ShellState {
  const state = newShellState();
  feed([baseline()], state, new Map(), true);
  return state;
}

function afterTurns(): ShellState {
  const state = beforeTurns();
  feed(live(), state);
  return state;
}

const TERMINAL: [string, string][] = [
  ["thread.completed", "a"],
  ["thread.interrupted", "c"],
  ["thread.failed", "d"],
];

test("the resubscribe backoff doubles from 1 s to a 30 s cap", () => {
  expect([0, 1, 2, 5, 9].map((n) => backoffMs(n, 0.5))).toEqual([1000, 2000, 4000, 30000, 30000]);
  expect(backoffMs(0, 0)).toBe(750);
  expect(backoffMs(0, 1)).toBe(1250);
});

test("a baseline snapshot emits nothing", () => {
  const state = newShellState();
  expect(feed([baseline()], state, new Map(), true)).toEqual([]);
  expect(state.complete).toBe(true);
  expect(state.cursor).toBe(BEFORE);
  expect(state.threads.get("s-a")?.summary.status).toBe("completed");
  expect(state.threads.get("s-a")?.summary.headline).toBe("OK");
  expect(state.threads.get("s-c")?.summary.status).toBe("idle");
});

test("live transitions once, in order", () => {
  expect(feed(live(), beforeTurns())).toEqual([
    ["thread.started", "a"],
    ["thread.completed", "a"],
    ["thread.started", "c"],
    ["thread.waiting", "c"],
    ["thread.interrupted", "c"],
    ["thread.started", "d"],
    ["thread.failed", "d"],
  ]);
});

test("rows delivered again emit nothing", () => {
  const once = feed(live(), beforeTurns());
  const twice = live().flatMap((e) => [e, e]);
  expect(feed(twice, beforeTurns())).toEqual(once);
});

test("a finished turn's armed Monitor reaches the stored thread, and goes with it once it ends", () => {
  const state = beforeTurns();
  const stored: StoredThread[] = [];
  const apply = (s: SessionSummary) => stored.push(...applyMachineEvent(state, AFTER, updated(s), { machineId: MACHINE, now: NOW, stored: new Map(), baseline: false }).threads);
  apply({ ...aDone(), watchingUntil: "2026-10-17T10:33:00Z" });
  expect(state.threads.get("s-a")?.summary.watchingUntil).toBe("2026-10-17T10:33:00.000Z");
  expect(stored.at(-1)?.summary.watchingUntil).toBe("2026-10-17T10:33:00.000Z");
  apply(aDone());
  expect(stored.at(-1)?.summary.watchingUntil).toBeUndefined();
});

test("a queued run is starting, so a send waits behind it", () => {
  const state = beforeTurns();
  feed([[11, updated(row("c", 4, run("c1", "queued", 1), { status: "running", activeRunId: "c1" }))]], state);
  const c = state.threads.get("s-c");
  expect([c?.activeRunId, c?.activeRunStarting, c?.summary.status]).toEqual(["c1", true, "running"]);
});

test("a failed run maps class, message and event", () => {
  const state = afterTurns();
  const failed = state.threads.get("s-d")!;
  expect(failed.summary).toMatchObject({
    status: "failed",
    lastError: { class: "other", message: "Claude gave up after repeated API errors." },
    model: "claude-haiku-5-5",
    effort: "low",
    lastProgressAt: at(8),
  });
  expect(failed.summary.usageLimitResetAt).toBeUndefined();
  const event = transitionEvent({ kind: "failed", threadId: "s-d", late: false }, failed, MACHINE);
  expect([event.type, event.threadId, event.projectId]).toEqual(["thread.failed", "s-d", "p1"]);
  expect(event.summary).toBe(`"fixtures: d" on lab-b failed: other: Claude gave up after repeated API errors.`);
  expect((event.data as Record<string, unknown>).runId).toBe("d1");
});

test("a waiting event carries the prompt, and a second prompt waits again", () => {
  const state = beforeTurns();
  expect(feed([[11, updated(running("c", 4, "c1", 1))], [12, updated(cWaiting("q1"))]], state)).toEqual([
    ["thread.started", "c"],
    ["thread.waiting", "c"],
  ]);
  const data = transitionEvent({ kind: "waiting", threadId: "s-c", late: false }, state.threads.get("s-c")!, MACHINE).data as Record<string, unknown>;
  expect(data.permission).toEqual({ requestId: "q1", toolName: "Bash", summary: "rm -rf build" });
  // q1 answered and q2 raised between two rows the hub saw: still a new wait.
  const second: [number, MachineEvent][] = [[13, updated(cWaiting("q2"))]];
  expect(feed(second, state)).toEqual([["thread.waiting", "c"]]);
  // The same prompt again is nothing new.
  expect(feed(second, state)).toEqual([]);
});

test("a replay of the final rows reports what happened meanwhile", () => {
  const state = beforeTurns();
  const replay = finals().map((s, i): [number, MachineEvent] => [BEFORE + 5 + i, updated(s)]);
  expect(sorted(feed(replay, state))).toEqual(sorted(TERMINAL));
  expect(state.cursor).toBe(BEFORE + 7);
});

test("a snapshot resume reports what happened meanwhile, and ends in the live caches", () => {
  const state = beforeTurns();
  expect(sorted(feed([[AFTER, snapshot(finals())]], state))).toEqual(sorted(TERMINAL));
  expect(state.cursor).toBe(AFTER);
  const view = (s: ShellState) => ({
    threads: [...s.threads.values()].map((t) => ({ ...t.summary, asOf: "" })).sort((x, y) => (x.threadId < y.threadId ? -1 : 1)),
    projects: [...s.projects.keys()].map((id) => projectSummary(s, MACHINE, id)),
  });
  const viaLive = view(afterTurns());
  expect(view(state)).toEqual(viaLive);
  expect(viaLive.projects[0]?.threads).toEqual({ running: 0, waiting: 0, failed: 1, idle: viaLive.threads.length - 1 });
  expect(viaLive.projects[0]?.lastActivityAt).toBe(at(8));
});

function storedFrom(state: ShellState, withRuns: boolean): Map<string, StoredThread> {
  return new Map(
    [...state.threads].map(([id, t]) => {
      const run = knownRun(t);
      return [id, { summary: t.summary, ...(withRuns && run ? { lastRunId: run } : {}), ...(withRuns ? { lastRunStatus: phase(t.summary) } : {}) }];
    }),
  );
}

test("a restart diffs rows stored before run tracking", () => {
  // Such rows carry no run id, so run 2 of `a` (completed -> completed) is not visible here.
  expect(sorted(feed([[AFTER, snapshot(finals())]], newShellState(), storedFrom(beforeTurns(), false)))).toEqual([
    ["thread.failed", "d"],
    ["thread.interrupted", "c"],
  ]);
});

test("a restart reports runs that ended meanwhile, late, by run id", () => {
  const stored = storedFrom(beforeTurns(), true);
  const state = newShellState();
  const applied = applyMachineEvent(state, AFTER, snapshot(finals()), { machineId: MACHINE, now: NOW, stored, baseline: false });
  expect(applied.transitions.map((t) => [t.kind, t.threadId, t.late]).sort()).toEqual([
    // Run 2 of `a`: same phase, new run id.
    ["completed", "s-a", true],
    ["failed", "s-d", true],
    ["interrupted", "s-c", true],
  ]);
  const completed = applied.transitions.find((t) => t.threadId === "s-a")!;
  const data = transitionEvent(completed, state.threads.get("s-a")!, MACHINE).data as Record<string, unknown>;
  expect([data.status, data.late, data.runId]).toEqual(["completed", true, "a2"]);
  // Every changed row is written back with its run, so the next restart diffs against it.
  const last = applied.threads.findLast((t) => t.summary.threadId === "s-a");
  expect([last?.lastRunId, last?.lastRunStatus]).toEqual(["a2", "completed"]);
  expect([...(applied.present ?? [])].sort()).toEqual(["s-a", "s-c", "s-d"]);
});

test("a restart with nothing new emits nothing", () => {
  expect(feed([[AFTER, snapshot(finals())]], newShellState(), storedFrom(afterTurns(), true))).toEqual([]);
});

test("removed projects, by event and by snapshot", () => {
  const ctx = { machineId: MACHINE, now: NOW, stored: new Map(), baseline: false };
  const full = snapshot(finals());
  const state = newShellState();
  applyMachineEvent(state, 1, full, ctx);
  expect(removedProjects(state, full, ["p1", "gone"])).toEqual(["gone"]);
  expect(removedProjects(state, full, ["p1"])).toEqual([]);
  const removed: MachineEvent = { type: "project_removed", projectId: "p1" };
  const before = beforeTurns();
  applyMachineEvent(before, 99, removed, ctx);
  expect(before.projects.has("p1")).toBe(false);
  expect(before.cursor).toBe(99);
  expect(removedProjects(before, removed, ["p1", "other"])).toEqual(["p1"]);
  expect(removedProjects(before, updated(aDone()), ["p1", "other"])).toEqual([]);
});

test("a usage limit is its own event, with the reset", () => {
  const state = beforeTurns();
  feed(
    [
      [11, updated(running("d", 7, "d1", 1))],
      [12, updated(dFailed({ class: "usage_limit", message: "You've hit your limit · resets 3pm (UTC)", resetAt: "2026-10-17T15:00:00.000Z" }))],
    ],
    state,
  );
  const d = state.threads.get("s-d")!;
  expect(phase(d.summary)).toBe("usage_limited");
  const event = transitionEvent({ kind: "usage_limited", threadId: "s-d", late: false }, d, MACHINE);
  expect(event.type).toBe("thread.usage_limited");
  expect(event.summary).toBe(`"fixtures: d" on lab-b hit the usage limit (resets 2026-10-17T15:00:00.000Z)`);
  expect(event.data).toMatchObject({ usageClass: "usage_limit", resumeAt: "2026-10-17T15:00:00.000Z", usageLimitResetAt: "2026-10-17T15:00:00.000Z" });
});

/** 2026-11-12 00:17 UTC, verbatim: classed invalid_request then, so writers and reviewers failed instead of parking. */
test("a gateway cooldown with its reset parks a lead, a reviewer and a writer, and each is continued at the reset", () => {
  const text =
    "API Error: Request rejected (429) · All credentials for model claude-fable-5-2 are cooling down (last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.) (reset after 4m15s)";
  const failedAt = Date.parse(at(8));
  const failure = classify(
    evidence({
      isError: true,
      assistantError: "rate_limit",
      apiErrorStatus: 429,
      text,
      stderr: '[claude-code:unrecognized_model] {"model":"claude-fable-5-2","query_source":"sdk"}\n',
      nowMs: failedAt,
    }),
  )!;
  const resetAt = "2026-10-17T10:12:15.000Z";
  const state = beforeTurns();
  feed(
    [
      [11, updated(running("d", 7, "d1", 1))],
      [12, updated(dFailed(failure))],
    ],
    state,
  );
  const d = state.threads.get("s-d")!;
  expect(phase(d.summary)).toBe("usage_limited");
  const event = transitionEvent({ kind: "usage_limited", threadId: "s-d", late: false }, d, MACHINE);
  expect(event.data).toMatchObject({ usageClass: "rate_limit", resumeAt: resetAt, model: "claude-fable-5-2" });
  const usage = new UsageState();
  const kinds: ParkedKind[] = ["write", "review", "lead"];
  kinds.forEach((kind, i) => {
    const e = { ...event, seq: i + 1, at: at(8), threadId: `s-${kind}` } as HubEvent;
    expect(parkedOf(e)).toEqual({ class: "rate_limit", since: at(8), resumeAt: resetAt, proxy: true });
    usage.apply(e, { kind, ...(kind !== "lead" ? { taskId: `T${i}` } : {}) }, undefined);
  });
  expect(usage.due(Date.parse(resetAt) - 1)).toEqual([]);
  const due = usage.due(Date.parse(resetAt));
  expect(usage.takeInOrder(due.flatMap((x) => x.threads)).map((p) => p.thread.threadId)).toEqual(["s-lead", "s-review", "s-write"]);
});
