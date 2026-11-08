// Ports crates/fleetd/src/hub/executor/activity.rs's tests.
import { expect, test } from "bun:test";
import { activityOf, ActivityTracker, TEXT_TAIL_CHARS, WRITING_FOR_MS } from "../src/hub/executor/activity.ts";
import { isoMs } from "../src/hub/auth/index.ts";
import { SPARK_BUCKETS } from "../src/shared/contracts.ts";
import type { ItemKind, ThreadEvent } from "../src/shared/sessions.ts";

const T0 = 1_760_000_000_000;
const run = (status: string): ThreadEvent =>
  ({
    type: "run",
    id: "r1",
    status,
    ordinal: 1,
    ...(status === "completed"
      ? { usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 0 } }
      : {}),
  }) as ThreadEvent;
const item = (id: string, status: string, kind: unknown): ThreadEvent =>
  ({ type: "item", id, runId: "r1", status, title: "", startedAt: "2026-10-18T10:00:00.000Z", updatedAt: "2026-10-18T10:00:00.000Z", kind }) as ThreadEvent;
const delta = (text: string): ThreadEvent => ({ type: "delta", messageId: "m1", runId: "r1", append: text });
const message = (id: string, text: string): ThreadEvent =>
  ({ type: "message", id, runId: "r1", role: "assistant", text, createdAt: "2026-10-18T10:00:00.000Z" }) as ThreadEvent;
const usage = (out: number, input = 40): ThreadEvent => ({
  type: "usage",
  runId: "r1",
  usage: { inputTokens: input, outputTokens: out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
});

test("keeps the run's complete messages whatever deltas went missing", () => {
  const t = new ActivityTracker();
  t.apply(message("m0", "before any run"), T0);
  t.apply(run("running"), T0);
  t.apply(delta("Reading the proposal and the"), T0 + 10);
  t.apply(message("m1", "Reading the proposal and the current app code."), T0 + 20);
  expect(t.text()?.total).toBe(28);
  expect(t.done()).toEqual([{ messageId: "m1", text: "Reading the proposal and the current app code." }]);
  for (let n = 0; n < 10; n++) t.apply(message(`n${n}`, "more"), T0 + 30);
  expect(t.done()).toHaveLength(8);
  expect(t.done().at(-1)?.messageId).toBe("n9");
  t.apply(run("completed"), T0 + 40);
  expect(t.done()).toEqual([]);
  const said = (id: string, runId: string) => ({ id, runId, role: "assistant", text: id, createdAt: "2026-10-18T10:00:00.000Z" });
  t.apply(
    {
      type: "snapshot",
      summary: { sessionId: "s1", projectId: "p1", title: "t", status: "running", activeRunId: "r2" },
      messages: [said("old", "r1"), said("new", "r2")],
      items: [],
      runs: [
        { id: "r1", status: "completed", ordinal: 1 },
        { id: "r2", status: "running", ordinal: 2 },
      ],
      truncated: false,
    } as unknown as ThreadEvent,
    T0 + 50,
  );
  expect(t.done().map((d) => d.messageId)).toEqual(["new"]);
});

test("a tool reads by its class, never its name", () => {
  const tool = (toolName: string, input: unknown, cls?: unknown) =>
    activityOf({ type: "tool", toolName, input, ...(cls ? { class: cls } : {}) } as ItemKind, "/w/p");
  expect(tool("open_file", {}, { type: "read", path: "/w/p/src/a.rs" })).toEqual({ kind: "read", path: "src/a.rs" });
  expect(tool("find", {}, { type: "search", pattern: "fn main" })).toEqual({ kind: "read", pattern: "fn main" });
  expect(tool("browse", {}, { type: "web", url: "https://docs.rs/x?y" })).toEqual({ kind: "web", detail: "docs.rs" });
  expect(tool("todo", {}, { type: "plan" })).toEqual({ kind: "planning" });
  expect(tool("mcp__fleetd__report", { description: "done" }, { type: "mcp", server: "fleetd", tool: "report" })).toEqual({
    kind: "tool",
    name: "report",
    detail: "done",
    server: "fleetd",
  });
  expect(tool("Read", { file_path: "/w/p/a" })).toEqual({ kind: "tool", name: "Read", detail: "/w/p/a" });
});

test("says what the thread is doing now", () => {
  const t = new ActivityTracker();
  t.setRoot("/w/fleetd/.fleetd/worktrees/T31/");
  expect(t.now(T0)).toBeUndefined();
  t.apply(run("running"), T0);
  expect(t.now(T0 + 10)?.activity).toEqual({ kind: "thinking" });
  t.apply(item("i1", "running", { type: "command", command: "cd /w && cargo test -p fleetd\nmore" }), T0 + 100);
  expect(t.now(T0 + 200)?.activity).toEqual({ kind: "command", text: "cargo test -p fleetd" });
  t.apply(item("i2", "running", { type: "file_change", toolName: "Edit", path: "/w/fleetd/.fleetd/worktrees/T31/src/lib.rs" }), T0 + 300);
  expect(t.now(T0 + 400)?.activity).toEqual({ kind: "edit", path: "src/lib.rs" });
  t.apply(item("i2", "completed", { type: "file_change", toolName: "Edit", path: "x" }), T0 + 500);
  t.apply(item("i1", "completed", { type: "command", command: "cargo test" }), T0 + 600);
  t.apply(delta("Done."), T0 + 700);
  const writing = t.now(T0 + 1000);
  expect(writing?.activity).toEqual({ kind: "writing" });
  expect(writing?.since).toBe(isoMs(T0 + 700));
  expect(t.now(T0 + 700 + WRITING_FOR_MS + 1)?.activity).toEqual({ kind: "thinking" });
  t.apply(run("completed"), T0 + 5000);
  expect(t.now(T0 + 5001)).toBeUndefined();
  expect(t.tokens()).toEqual({ input: 100, output: 20, cacheRead: 5, live: false });
});

test("live usage counts until the run reports its own", () => {
  const t = new ActivityTracker();
  t.apply(run("running"), T0);
  expect(t.tokens()).toBeUndefined();
  t.apply(usage(3), T0 + 1);
  expect(t.tokens()).toMatchObject({ input: 40, live: true });
  t.apply(run("completed"), T0 + 2);
  expect(t.tokens()).toMatchObject({ input: 100, live: false });
});

test("the sparkline counts real work per two-second bucket", () => {
  const t = new ActivityTracker();
  t.apply(run("running"), T0);
  const start = T0 - (T0 % 2000);
  t.apply(item("a", "running", { type: "command", command: "ls" }), start + 10);
  t.apply(item("b", "running", { type: "command", command: "ls" }), start + 20);
  t.apply(delta("x".repeat(64)), start + 2_100);
  const spark = t.spark(start + 4_000);
  expect(spark.samples).toHaveLength(SPARK_BUCKETS);
  expect(spark.samples.slice(-2)).toEqual([32, 2]);
  expect(spark.samples.slice(0, -2).every((v) => v === 0)).toBe(true);
  expect(spark.endAt).toBe(isoMs(start + 4_000));
  expect(t.spark(start + 70_000).samples.every((v) => v === 0)).toBe(true);
});

test("output that did not stream as text counts once per report", () => {
  const t = new ActivityTracker();
  t.apply(run("running"), T0);
  const start = T0 - (T0 % 2000);
  t.apply(usage(5_000), start + 10);
  t.apply(usage(5_800), start + 2_010);
  t.apply(delta("y".repeat(400)), start + 4_010);
  t.apply(usage(5_960), start + 4_500);
  const s = t.spark(start + 6_000).samples;
  expect(s[SPARK_BUCKETS - 3]).toBe(0);
  expect(s[SPARK_BUCKETS - 2]).toBe(100);
  expect(s[SPARK_BUCKETS - 1]).toBe(12 + 7);
});

test("streamed text keeps a bounded tail and counts everything", () => {
  const t = new ActivityTracker();
  t.apply(run("running"), T0);
  t.apply(delta("a".repeat(1500)), T0);
  t.apply(delta("b".repeat(1500)), T0 + 100);
  const text = t.text();
  expect(text?.total).toBe(3000);
  expect(text?.tail.length).toBe(TEXT_TAIL_CHARS);
  expect(text?.since(2990)).toBe("b".repeat(10));
  expect(text?.since(0).length).toBe(TEXT_TAIL_CHARS);
});

test("a tracker idle past its time with no run going is dropped, whoever ends its follow", () => {
  let now = T0;
  const { activity: activityArea, TRACKER_IDLE_MS } = require("../src/hub/executor/activity.ts");
  const hub = { clock: { now: () => now }, area: (_: string, make: (h: unknown) => unknown) => (cached ??= make(hub)) } as never;
  let cached: unknown;
  const a = activityArea(hub);
  const frame = (sessionId: string, event: ThreadEvent) => ({ sessionId, at: isoMs(now), event });
  a.onThreadEvent("devbox", frame("done", run("completed")));
  a.onThreadEvent("devbox", frame("busy", run("running")));
  now += TRACKER_IDLE_MS + 61_000;
  a.onThreadEvent("devbox", frame("fresh", run("running")));
  expect(a.size()).toBe(2);
});
