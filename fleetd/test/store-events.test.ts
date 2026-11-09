// The event log (its event log tests).
import { expect, test } from "bun:test";
import { EventLog, type NewEvent } from "../src/hub/store/events.ts";
import { HubDb } from "../src/hub/store/db.ts";
import type { HubEventType } from "../src/shared/contracts.ts";

const DAY = 86_400_000;

function manual(at = 0) {
  const clock = { ms: at, now: () => clock.ms };
  return clock;
}

const event = (type: HubEventType, machine: string, extra: Partial<NewEvent> = {}): NewEvent => ({
  at: "2026-10-17T10:00:00.000Z",
  type,
  machineId: machine,
  summary: `${type} on ${machine}`,
  ...extra,
});

function newLog() {
  const clock = manual();
  return { log: new EventLog(HubDb.memory(), clock), clock };
}

const waitNow = (log: EventLog, cursor?: number) => log.wait({ timeoutSec: 0, ...(cursor === undefined ? {} : { cursor }) });

test("returns events after the cursor at once and nothing at head", async () => {
  const { log } = newLog();
  const appended = ["thread.started", "thread.completed"].map((t) => log.append(event(t, "lab-a")));
  expect(appended.map((e) => e.seq)).toEqual([1, 2]);
  expect(await waitNow(log, 0)).toEqual({ events: appended, cursor: 2, more: false });
  expect(await waitNow(log, 1)).toEqual({ events: [appended[1]!], cursor: 2, more: false });
  expect(await waitNow(log)).toEqual({ events: [], cursor: 2, more: false });
});

test("without a cursor, waits from the end and wakes on the next append", async () => {
  const { log } = newLog();
  log.append(event("thread.started", "lab-a"));
  const waiting = log.wait({ timeoutSec: 30 });
  await Bun.sleep(5);
  const next = log.append(event("thread.failed", "lab-a"));
  expect(await waiting).toEqual({ events: [next], cursor: 2, more: false });
});

test("keeps waiting past filtered events and moves the cursor past them", async () => {
  const { log } = newLog();
  const waiting = log.wait({ cursor: 0, timeoutSec: 30, types: ["thread.failed"], machineId: "lab-a" });
  await Bun.sleep(5);
  log.append(event("thread.started", "lab-a"));
  log.append(event("thread.failed", "lab-b"));
  await Bun.sleep(5);
  const hit = log.append(event("thread.failed", "lab-a"));
  expect(await waiting).toEqual({ events: [hit], cursor: 3, more: false });
});

test("a wait times out with the cursor at head, and stops on its signal", async () => {
  const log = new EventLog(HubDb.memory(), { now: () => Date.now() });
  log.append(event("thread.started", "lab-a"));
  const started = Date.now();
  expect(await log.wait({ cursor: 1, timeoutSec: 0.05 })).toEqual({ events: [], cursor: 1, more: false });
  expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  const stop = new AbortController();
  const waiting = log.wait({ cursor: 1, timeoutSec: 60 }, stop.signal);
  stop.abort();
  expect(await waiting).toEqual({ events: [], cursor: 1, more: false });
});

test("pages at 100 events with more set", async () => {
  const { log } = newLog();
  for (let i = 0; i < 150; i++) log.append(event("thread.started", "lab-a"));
  const first = await waitNow(log, 0);
  expect([first.events.length, first.cursor, first.more]).toEqual([100, 100, true]);
  const second = await waitNow(log, first.cursor);
  expect([second.events.length, second.events[0]?.seq, second.cursor, second.more]).toEqual([50, 101, 150, false]);
});

test("treats a cursor past head as head", async () => {
  const { log } = newLog();
  log.append(event("thread.started", "lab-a"));
  expect(await waitNow(log, 99)).toEqual({ events: [], cursor: 1, more: false });
});

test("trims long summaries and oversized data", async () => {
  const { log } = newLog();
  const small = log.append(event("thread.failed", "lab-a", { summary: "x".repeat(300), data: { ok: 1 } }));
  const big = log.append(event("thread.failed", "lab-a", { data: { blob: "y".repeat(3000) } }));
  expect([...small.summary].length).toBe(200);
  expect(small.summary.endsWith("…")).toBe(true);
  expect(small.data).toEqual({ ok: 1 });
  expect(big.data).toEqual({ truncated: true });
  expect((await waitNow(log, 0)).events).toEqual([small, big]);
  // A surrogate pair is two units: the cut never splits one.
  const wide = log.append(event("thread.failed", "lab-a", { summary: "😀".repeat(150) }));
  expect(wide.summary).toBe(`${"😀".repeat(99)}…`);
});

test("drops events older than 30 days without reusing their seq, even across a restart", async () => {
  const db = HubDb.memory();
  const clock = manual();
  const log = new EventLog(db, clock);
  log.append(event("thread.started", "lab-a"));
  log.append(event("thread.completed", "lab-a"));
  clock.ms += 29 * DAY;
  log.append(event("thread.failed", "lab-a"));
  expect((await waitNow(log, 0)).events.length).toBe(3);
  clock.ms += 2 * DAY;
  expect(log.append(event("thread.interrupted", "lab-a")).seq).toBe(4);
  expect((await waitNow(log, 0)).events.map((e) => e.seq)).toEqual([3, 4]);

  // A restarted hub prunes on start and keeps counting from the database's sequence.
  clock.ms += 31 * DAY;
  const restarted = new EventLog(db, clock);
  expect([restarted.head(), (await waitNow(restarted, 0)).events.length]).toEqual([4, 0]);
  expect(restarted.append(event("thread.started", "lab-a")).seq).toBe(5);
});

test("a row's data is the event without its seq, as the Rust hub stores it", () => {
  const { log } = newLog();
  log.append(event("decision.recorded", "devbox", { projectId: "app", data: { decisionId: "D1" } }));
  const row = log.db.conn.query<{ type: string; machine_id: string; data: string }, []>("SELECT type, machine_id, data FROM events").get();
  expect(row?.type).toBe("decision.recorded");
  expect(row?.machine_id).toBe("devbox");
  expect(JSON.parse(row?.data ?? "")).toEqual({
    at: "2026-10-17T10:00:00.000Z",
    type: "decision.recorded",
    machineId: "devbox",
    projectId: "app",
    summary: "decision.recorded on devbox",
    data: { decisionId: "D1" },
  });
});

test("subscribers get each stored event in order", () => {
  const { log } = newLog();
  const seen: number[] = [];
  const stop = log.subscribe((e) => seen.push(e.seq));
  log.append(event("thread.started", "lab-a"));
  log.append(event("thread.started", "lab-a"));
  stop();
  log.append(event("thread.started", "lab-a"));
  expect(seen).toEqual([1, 2]);
});

test("a project's page walks newest first, with the hub-wide events when asked, and its index", () => {
  const { log } = newLog();
  log.append(event("thread.started", "devbox", { projectId: "app" }));
  log.append({ at: "2026-10-17T10:00:00.000Z", type: "hub.updated", summary: "hub-wide" });
  log.append(event("thread.started", "devbox", { projectId: "other" }));
  log.append(event("thread.failed", "devbox", { projectId: "app" }));
  const app = { machineId: "devbox", projectId: "app" };
  expect(log.projectPage(app, undefined, undefined, false, 10).events.map((e) => e.seq)).toEqual([4, 1]);
  expect(log.projectPage(app, undefined, undefined, true, 10).events.map((e) => e.seq)).toEqual([4, 2, 1]);
  expect(log.projectPage(app, 4, undefined, true, 1)).toEqual({ events: [expect.objectContaining({ seq: 2 })], more: true });
  expect(log.projectPage(app, undefined, ["thread.failed"], true, 10).events.map((e) => e.seq)).toEqual([4]);

  const plan = log.db.conn
    .query<{ detail: string }, never[]>(
      `EXPLAIN QUERY PLAN SELECT seq, data FROM (
         SELECT seq, data FROM events
          WHERE machine_id = 'devbox' AND json_extract(data, '$.projectId') = 'app' AND seq < 9223372036854775807
          ORDER BY seq DESC LIMIT 51)`,
    )
    .all()
    .map((r) => r.detail);
  expect(plan.some((d) => d.startsWith("SEARCH events USING INDEX events_by_project"))).toBe(true);
});
