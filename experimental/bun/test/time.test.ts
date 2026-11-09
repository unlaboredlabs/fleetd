// The time area (crates/fleetd/src/hub/time/tests.rs, ingest.rs, store.rs, project.rs and src/tiles.rs tests).
import { expect, test } from "bun:test";
import { registerAll } from "../src/gen/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { events } from "../src/hub/store/events.ts";
import { time } from "../src/hub/time/index.ts";
import { closePrefix, ingestFrame, ingestNode, type SpanWire, writeHub } from "../src/hub/time/ingest.ts";
import type { Row, RuleInput } from "../src/hub/time/model.ts";
import { criticalPath } from "../src/hub/time/path.ts";
import { busyMs, projectSome, startProjector } from "../src/hub/time/project.ts";
import { compare, fmtDur, insights, ruleSpans } from "../src/hub/time/rules.ts";
import { cursor, DAY, family, normalize, read, write } from "../src/hub/time/store.ts";
import { exclusive, tile } from "../src/shared/tiles.ts";
import type { Category, CriticalPath, InsightRule, SpanKind } from "../src/shared/contracts.ts";
import { caller, testHub } from "./hub-helpers.ts";

const MIN = 60_000;

const row = (id: number, kind: SpanKind, lane: string, start: number, end: number, extra: Partial<Row> = {}): Row => ({
  id,
  kind,
  startMs: start,
  endMs: end,
  exclMs: end - start,
  lane,
  threadId: lane,
  status: "ok",
  extra: {},
  ...extra,
});
const cmd = (id: number, lane: string, start: number, end: number, label: string) =>
  row(id, "tool.bash", lane, start, end, { label, family: label.split(/\s+/).slice(0, 2).join(" ") });
const path = (start: number, end: number, rows: Row[], waitsOn = new Map<string, string[]>()) => criticalPath({ startMs: start, endMs: end, rows, waitsOn });
const segs = (p: CriticalPath) => p.segments.map((s) => [s.lane, s.kind, s.startMs, s.endMs]);
const pathLen = (p: CriticalPath) => p.segments.reduce((n, s) => n + s.endMs - s.startMs, 0);
const total = (p: CriticalPath, cat: Category) => p.totals.find((t) => t.cat === cat)?.ms ?? 0;

test("tiles cover the window exactly; the higher rank, then the inner span, owns", () => {
  const claims = [
    { start: 10, end: 50, rank: 1 },
    { start: 20, end: 30, rank: 2 },
    { start: 40, end: 80, rank: 1 },
    { start: 90, end: 95, rank: 1 },
  ];
  expect(tile(claims, 0, 100)).toEqual([
    { start: 0, end: 10 },
    { owner: 0, start: 10, end: 20 },
    { owner: 1, start: 20, end: 30 },
    { owner: 0, start: 30, end: 40 },
    { owner: 2, start: 40, end: 80 },
    { start: 80, end: 90 },
    { owner: 3, start: 90, end: 95 },
    { start: 95, end: 100 },
  ]);
  expect(exclusive(claims, 0, 100)).toEqual({ excl: [20, 10, 40, 5], uncovered: 25 });
});

test("critical paths: serial, parallel, waits, gaps, ties, tiles, determinism", () => {
  let p = path(0, 30, [row(1, "tool.bash", "a", 0, 10), row(2, "model.output", "b", 10, 30)]);
  expect(segs(p)).toEqual([
    ["a", "tool.bash", 0, 10],
    ["b", "model.output", 10, 30],
  ]);
  expect(p.offPathMs).toBe(0);
  p = path(0, 30, [row(1, "tool.bash", "a", 0, 20), row(2, "tool.bash", "b", 0, 30)]);
  expect(segs(p)).toEqual([["b", "tool.bash", 0, 30]]);
  expect(p.offPathMs).toBe(20);
  p = path(0, 20, [row(1, "queue.slot", "a", 0, 10), row(2, "queue.slot", "b", 0, 10), row(3, "tool.bash", "a", 10, 20), row(4, "tool.bash", "b", 10, 20)]);
  expect([total(p, "queue"), pathLen(p), p.offPathMs]).toEqual([10, 20, 20]);
  p = path(0, 40, [row(1, "tool.bash", "a", 0, 10), row(2, "tool.bash", "b", 20, 30)]);
  expect(segs(p)).toEqual([
    ["a", "tool.bash", 0, 10],
    ["none", "gap", 10, 20],
    ["b", "tool.bash", 20, 30],
    ["none", "gap", 30, 40],
  ]);
  expect(p.nothingRunningMs).toBe(20);
  expect(segs(path(0, 10, [row(5, "model.output", "a", 0, 10), row(6, "wait.request", "b", 0, 10)]))[0]?.[1]).toBe("wait.request");
  expect(segs(path(0, 10, [row(8, "tool.bash", "a", 0, 10), row(7, "tool.read", "b", 0, 10)]))[0]?.[0]).toBe("b");
  const causal = path(0, 20, [row(1, "model.output", "lead", 0, 10), row(2, "wait.request", "other", 0, 10), row(3, "tool.bash", "task", 10, 20)], new Map([["task", ["lead"]]]));
  expect(segs(causal)[0]?.[0]).toBe("lead");
  p = path(0, 20, [row(1, "run", "a", 0, 20, { exclMs: 0 }), row(2, "tool.bash", "a", 2, 12), row(3, "wait.permission", "a", 4, 8)]);
  expect(segs(p)).toEqual([
    ["a", "runner.other", 0, 2],
    ["a", "tool.bash", 2, 4],
    ["a", "wait.permission", 4, 8],
    ["a", "tool.bash", 8, 12],
    ["a", "runner.other", 12, 20],
  ]);
  expect(total(p, "human")).toBe(4);
  const rows: Row[] = [];
  for (let i = 0; i < 200; i++) rows.push(row(i, "tool.bash", `l${i % 7}`, (i * 13) % 900, ((i * 13) % 900) + 50 + (i % 11)));
  const a = path(5, 1000, rows);
  expect(path(5, 1000, [...rows].reverse())).toEqual(a);
  expect(pathLen(a)).toBe(995);
  let t = 5;
  for (const s of a.segments) {
    expect(s.startMs).toBe(t);
    t = s.endMs;
  }
  expect(t).toBe(1000);
});

const input = (rows: Row[], titles: [string, string][] = []): RuleInput => ({ rows, taskTitles: new Map(titles) });
const fired = (i: RuleInput, rule: InsightRule) => {
  const a = insights(i);
  expect(insights(i)).toEqual(a);
  return a.filter((x) => x.rule === rule);
};
const num = (i: { numbers: { name: string; value: number }[] }, name: string) => i.numbers.find((n) => n.name === name)?.value;
function suiteRuns(n: number, each: number, editBetween: boolean): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const s = i * 10 * MIN;
    rows.push(cmd(i + 1, "t1", s, s + each, "cargo test --workspace"));
    if (editBetween) rows.push(row(100 + i, "tool.edit", "t1", s + each + 1, s + each + 2));
  }
  return rows;
}

test("the insight rules fire at their thresholds, with their numbers", () => {
  const found = fired(input(suiteRuns(5, 2 * MIN, false)), "full_suite_repeat");
  expect(found.map((f) => f.message)).toEqual([
    "agents ran the full test suite `cargo test --workspace` 5× (10m); 4 runs followed no edit since the previous run",
  ]);
  expect(fired(input(suiteRuns(4, 3 * MIN, false)), "full_suite_repeat")).toEqual([]);
  expect(fired(input(suiteRuns(5, 2 * MIN - 1000, false)), "full_suite_repeat")).toEqual([]);
  expect(num(fired(input(suiteRuns(5, 2 * MIN, true)), "full_suite_repeat")[0] as never, "no_edit")).toBe(0);
  const filtered = Array.from({ length: 6 }, (_, i) => cmd(i, "t1", i * 10 * MIN, i * 10 * MIN + 3 * MIN, "cargo test -p fleetd"));
  expect(fired(input(filtered), "full_suite_repeat")).toEqual([]);
  const repeat = input(
    suiteRuns(3, MIN, false).map((r) => ({ ...r, taskId: "T88" })),
    [["T88", "add the login page"]],
  );
  expect(fired(repeat, "repeat_no_change")[0]?.message).toBe(
    "`cargo test --workspace` ran 3× in a row in T88 add the login page with nothing changed between runs (3m)",
  );
  expect(fired(input(suiteRuns(2, MIN, false)), "repeat_no_change")).toEqual([]);
  expect(fired(input(suiteRuns(3, MIN, true)), "repeat_no_change")).toEqual([]);
  const slow = fired(input([cmd(1, "t1", 0, MIN, "npm run build"), cmd(2, "t2", 0, MIN, "npm run build"), cmd(3, "t1", 2 * MIN, 2 * MIN + 119_000, "ls -la")]), "slow_commands");
  expect(slow.map((f) => f.message)).toEqual(["`npm run build`: 2×, 2m, median 1m"]);
  const cmp = compare(input(suiteRuns(2, 2 * MIN, false)), input(suiteRuns(6, 2 * MIN, false)));
  const suite = cmp.find((i) => i.rule === "full_suite_repeat");
  expect(suite?.firedIn).toBe("compare");
  expect(num(suite as never, "runs")).toBe(2);
  expect(suite?.compare?.find((n) => n.name === "runs")?.value).toBe(6);
  expect(ruleSpans(input(suiteRuns(6, 2 * MIN, false)), "full_suite_repeat")).toEqual([1, 2, 3, 4, 5, 6]);
  expect([34_000, 130_000, 51 * MIN, 72 * MIN, 60 * MIN].map(fmtDur)).toEqual(["34s", "2m10s", "51m", "1h12m", "1h"]);
});

test("families and worktree paths", () => {
  expect(family("tool.bash", "Bash", "cd x && cargo test --workspace")).toBe("cargo test");
  expect(family("git", "Bash", "git -C /a push origin")).toBe("git push");
  expect(family("tool.bash", "Bash", "pytest -q")).toBe("pytest");
  expect(family("tool.read", "Read", "/x/y")).toBe("Read");
  expect(normalize("cd /home/u/.fleetd/worktrees/p1/T4-abc && cargo test")).toBe("cd <wt> && cargo test");
});

const wire = (key: string, kind: SpanKind, run: string, start: number, end: number, excl: number): SpanWire => ({
  key,
  kind,
  sessionId: "lead-1",
  runId: run,
  startMs: start,
  endMs: end,
  exclMs: excl,
  status: "ok",
});

const rollup = (db: HubDb, scope: string, id: string) =>
  db.all<{ ms: number; n: number }>("SELECT COALESCE(SUM(ms), 0) AS ms, COALESCE(SUM(n), 0) AS n FROM time_rollups WHERE scope = ?1 AND scope_id = ?2", [scope, id])[0];

test("a lead turn splits over the orders its wake served, and a resend counts nothing", () => {
  const db = HubDb.memory();
  const day = 20_000 * DAY;
  db.conn.query("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'storefront', 'lead-1', 't', 1)").run();
  db.conn.query(`INSERT INTO time_wakes (machine_id, thread_id, at_ms, workstreams) VALUES ('devbox', 'lead-1', ?1, '["W1","W2"]')`).run(day + 1_000);
  const spans = [
    wire("lead-1/r1/run", "run", "r1", day + 1_500, day + 11_500, 0),
    wire("lead-1/msg/m1/output", "model.output", "r1", day + 1_500, day + 7_500, 6_000),
    wire("lead-1/t1", "tool.bash", "r1", day + 7_500, day + 11_500, 4_000),
  ];
  for (let i = 0; i < 2; i++) db.transaction((c) => ingestNode(c, "devbox", 0, spans));
  expect(rollup(db, "lead", "devbox/storefront")).toEqual({ ms: 10_000, n: 3 });
  expect(rollup(db, "order", "W1")).toEqual({ ms: 5_000, n: 3 });
  expect(rollup(db, "order", "W2")).toEqual({ ms: 5_000, n: 3 });
  expect(rollup(db, "fleet", "")).toEqual({ ms: 10_000, n: 3 });
});

test("a hub span counts once when it closes, and node stamps move onto the hub clock", () => {
  const db = HubDb.memory();
  db.transaction((c) => {
    writeHub(c, { src: "h", srcKey: "change/X1/reviewing/5", kind: "change.review", startMs: 5_000, ids: {}, lane: "change:acme/storefront#3", status: "ok" });
    expect(rollup(db, "fleet", "")).toEqual({ ms: 0, n: 0 });
    closePrefix(c, "change/X1/", 65_000);
    closePrefix(c, "change/X1/", 99_000);
    expect(rollup(db, "fleet", "")).toEqual({ ms: 60_000, n: 1 });
    ingestNode(c, "buildbox", 250, [wire("lead-1/t9", "tool.read", "r9", 1_000, 2_000, 1_000)]);
  });
  const stored = db.all<{ start_ms: number; extra: string }>("SELECT start_ms, extra FROM time_spans WHERE src_key = 'lead-1/t9'")[0];
  expect(stored?.start_ms).toBe(1_250);
  expect(stored?.extra).toContain('"nodeStartMs":1000');
});

test("a frame after a lost one rewinds instead of acking past the hole", () => {
  const db = HubDb.memory();
  const frame = (from: number, to: number) => ({ fromRid: from, toRid: to, spans: [wire(`lead-1/t${to}`, "tool.read", "r1", to, to + 1, 1)] });
  const ack = (f: ReturnType<typeof frame>) => db.transaction((c) => ingestFrame(c, "devbox", 0, f));
  const stored = () => db.all<{ n: number }>("SELECT COUNT(*) AS n FROM time_spans WHERE src_key = 'lead-1/t12'")[0]?.n;
  expect(ack(frame(1, 4))).toEqual({ upto: 4, rewind: false });
  expect(ack(frame(9, 12))).toEqual({ upto: 4, rewind: true });
  expect(stored()).toBe(0);
  expect(ack(frame(3, 12))).toEqual({ upto: 12, rewind: false });
  expect(stored()).toBe(1);
  expect(ack(frame(1, 2))).toEqual({ upto: 2, rewind: false });
});

test("a wake counts only the time its lead was not running", () => {
  const db = HubDb.memory();
  const event = (at: number, type: string, thread: string) =>
    db.conn.query("INSERT INTO events (created_ms, type, machine_id, data) VALUES (?1, ?2, 'devbox', ?3)").run(at, type, JSON.stringify({ type, machineId: "devbox", threadId: thread }));
  event(1_000, "thread.started", "lead-1");
  event(41_000, "thread.completed", "lead-1");
  event(45_000, "thread.started", "other");
  expect(busyMs(db.conn, "devbox", "lead-1", 20_000, 60_000)).toBe(21_000);
  event(70_000, "thread.started", "lead-1");
  expect(busyMs(db.conn, "devbox", "lead-1", 60_000, 80_000)).toBe(10_000);
  expect(busyMs(db.conn, "devbox", "lead-1", 42_000, 60_000)).toBe(0);
});

test("an order's read includes its share of lead turns", () => {
  const db = HubDb.memory();
  db.transaction((c) => {
    for (const [key, ws, role, run] of [
      ["a", "W1", undefined, undefined],
      ["b", undefined, "lead", "r1"],
      ["c", undefined, "lead", "r2"],
    ] as const) {
      write(c, {
        src: "h",
        srcKey: key,
        kind: "tool.bash",
        startMs: 10,
        endMs: 20,
        ids: { machineId: "devbox", threadId: "t", ...(ws ? { workstreamId: ws } : {}), ...(role ? { role } : {}), ...(run ? { runId: run } : {}) },
        lane: "thread:devbox/t",
        status: "ok",
      });
    }
    c.query("INSERT INTO time_lead_runs VALUES ('devbox', 't', 'r1', 'W1', 2, 10), ('devbox', 't', 'r1', 'W2', 2, 10)").run();
  });
  expect(read(db.conn, { sinceMs: 0, untilMs: 100, machineId: "devbox", workstreamId: "W1", kinds: ["tool.bash"] }, 10).map((r) => r.id)).toEqual([1, 2]);
});

test("time_breakdown: whole days from the roll-ups past retention, the edges from spans; time_spans pages", async () => {
  const day = DAY;
  const now = 400 * day + day / 2;
  const { hub, done } = testHub(now);
  const span = (key: string, start: number, ms: number) => ({
    src: "h",
    srcKey: key,
    kind: "tool.bash" as const,
    startMs: start,
    endMs: start + ms,
    ids: { machineId: "devbox" },
    lane: "thread:devbox/t",
    status: "ok" as const,
  });
  hub.db.transaction((c) => {
    write(c, span("old", 300 * day + 1_000, 7_000));
    write(c, span("edge", 399 * day + day / 2, 3_000));
    write(c, span("today", 400 * day + 1_000, 2_000));
    c.query("DELETE FROM time_spans WHERE src_key = 'old'").run();
  });
  const tools = new Registry();
  registerAll(tools);
  const since = new Date(299 * day + day / 2).toISOString();
  const out = (await tools.call(hub, caller("read"), "time_breakdown", { scope: { kind: "fleet" }, since })) as { output: Record<string, any> };
  expect(out.output.agentMs).toBe(12_000);
  expect(out.output.byCategory[0].n).toBe(3);
  expect(out.output.coverage.complete).toBe(false);
  expect(out.output.coverage.detailSince).toBe(new Date(now - 30 * day).toISOString());
  const page = (await tools.call(hub, caller("read"), "time_spans", { scope: { kind: "fleet" }, since, limit: 1 })) as { output: Record<string, any> };
  expect(page.output.spans.map((s: { id: number }) => s.id)).toEqual([2]);
  expect(page.output.nextAfterId).toBe(2);
  const insightsOut = (await tools.call(hub, caller("read"), "time_insights", { scope: { kind: "fleet" }, since })) as { output: Record<string, any> };
  expect(insightsOut.output.insights).toEqual([]);
  expect(await tools.call(hub, caller("read", false), "time_spans", { scope: { kind: "order", workstreamId: "W9" }, since })).toMatchObject({
    error: { error: { code: "not_found" } },
  });
  expect(time(hub).nodeCursor("devbox")).toBe(0);
  done();
});

test("thread_window needs read on the machine, and says why it can't reach an offline one", async () => {
  const { hub, done } = testHub();
  const tools = new Registry();
  registerAll(tools);
  const input = { machineId: "lab-a", threadId: "t1", itemId: "i1" };
  const none = { ...caller("read"), grants: [{ role: "read" as const, machines: ["lab-b"] }] };
  const refused = (await tools.call(hub, none, "thread_window", input)) as { error?: { kind: string; error?: { code: string } } };
  expect(refused.error?.error?.code).toBe("forbidden");
  const offline = (await tools.call(hub, caller("read"), "thread_window", input)) as { error?: { kind: string; error?: { code: string } } };
  expect(offline.error?.kind).toBe("tool");
  expect(offline.error?.error?.code).not.toBe("failed");
  done();
});

const queued = (hub: ReturnType<typeof testHub>["hub"], n: number, type = "task.queued") => {
  for (let i = 1; i <= n; i++) {
    events(hub).append({ at: "2026-11-08T10:00:00.000Z", type: type as never, summary: type, data: { taskId: `T${i}` } });
  }
};
const openQueues = (hub: ReturnType<typeof testHub>["hub"]) =>
  (hub.db.conn.query("SELECT count(*) AS n FROM time_spans WHERE src = 'h' AND end_ms IS NULL").get() as { n: number }).n;

test("one projector step is at least one event and at most a page, the cursor at the last event applied", () => {
  const { hub, done } = testHub();
  queued(hub, 150);
  const seqs = (hub.db.conn.query("SELECT seq FROM events ORDER BY seq").all() as { seq: number }[]).map((r) => r.seq);
  // A budget already spent still applies one event.
  expect(projectSome(hub, 0)).toBe(true);
  expect(cursor(hub.db.conn, "events")).toBe(seqs[0]);
  expect(openQueues(hub)).toBe(1);
  expect(projectSome(hub, Number.POSITIVE_INFINITY)).toBe(true);
  expect(cursor(hub.db.conn, "events")).toBe(seqs[100]);
  expect(projectSome(hub, Number.POSITIVE_INFINITY)).toBe(false);
  expect(cursor(hub.db.conn, "events")).toBe(seqs[149]);
  expect(openQueues(hub)).toBe(150);
  expect(projectSome(hub, Number.POSITIVE_INFINITY)).toBe(false);
  done();
});

test("the projector catches up behind the hub's start, then follows appends in order", async () => {
  const { hub, done } = testHub();
  queued(hub, 450);
  const running = startProjector(hub);
  // Nothing ran inside the start: the hub goes on to serve.
  expect(cursor(hub.db.conn, "events")).toBeUndefined();
  const caughtUp = async () => {
    while ((cursor(hub.db.conn, "events") ?? 0) < events(hub).head()) await Bun.sleep(1);
  };
  await caughtUp();
  expect(openQueues(hub)).toBe(450);
  // Each start closes its own task's wait.
  queued(hub, 2, "task.started");
  await caughtUp();
  expect(openQueues(hub)).toBe(448);
  hub.shutdown.abort();
  await running;
  queued(hub, 3, "task.completed");
  await Bun.sleep(5);
  expect(openQueues(hub)).toBe(448);
  done();
});
