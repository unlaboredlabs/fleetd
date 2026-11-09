// The Time breakdown and insights read hourly digests (src/hub/time/hours.ts) instead of every span: a month's fleet
// view read 200k spans and took seconds. Their answer must be the one the spans give, whatever was written since the
// hours were built, so each answer here is held to the same read span by span.
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { answer, orderPath, type TimeJob } from "../src/hub/time/reads.ts";
import { DAY, HOUR, type NewSpan, prune, resetHours, write } from "../src/hub/time/store.ts";
import { saveUpkeep, upkeep } from "../src/hub/time/upkeep.ts";
import type { SpanKind, TimeScope } from "../src/shared/contracts.ts";
import { caller, testHub } from "./hub-helpers.ts";

const MIN = 60_000;
const P1 = { machineId: "devbox", projectId: "p1" };
const P2 = { machineId: "devbox", projectId: "p2" };
const P3 = { machineId: "lab", projectId: "p3" };

/** A small deterministic generator, so a failure shows the same spans again. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

type Thread = { id: string; ref: typeof P1; role?: string; task?: string; profile?: string };
const THREADS: Thread[] = [
  { id: "t1", ref: P1, role: "implementer", task: "T1", profile: "high" },
  { id: "t2", ref: P1, role: "reviewer", task: "T2", profile: "medium" },
  { id: "t3", ref: P1, role: "lead", profile: "high" },
  { id: "t4", ref: P2, role: "implementer", task: "T4", profile: "high" },
  { id: "t5", ref: P2 },
  { id: "t6", ref: P3, role: "implementer", task: "T6" },
  { id: "t7", ref: P3, role: "lead", profile: "medium" },
];
const LABELS = ["cargo test", "cargo test -p crate1", "git status", "ls", "grep -n x src", "bun test", "cargo build"];

let seq = 0;
function span(t: Thread, kind: SpanKind, start: number, ms: number | undefined, more: Partial<NewSpan> = {}): NewSpan {
  return {
    src: `n:${t.ref.machineId}`,
    srcKey: `${t.id}/s${seq++}`,
    kind,
    startMs: start,
    ...(ms === undefined ? {} : { endMs: start + ms }),
    ids: {
      machineId: t.ref.machineId,
      projectId: t.ref.projectId,
      threadId: t.id,
      ...(t.role === undefined ? {} : { role: t.role }),
      ...(t.task === undefined ? {} : { taskId: t.task }),
      ...(t.profile === undefined ? {} : { profile: t.profile }),
    },
    lane: `thread:${t.ref.machineId}/${t.id}`,
    status: "ok",
    ...more,
  };
}

/** Three days of each thread's work: model output, commands (some back to back), edits, waits, CI checks and gaps. */
function seed(c: Database, now: number): void {
  const r = rng(7);
  const from = now - 3 * DAY;
  for (const t of THREADS) {
    let at = from + Math.floor(r() * 30 * MIN);
    while (at < now - 5 * MIN) {
      const x = r();
      if (x < 0.35) write(c, span(t, "model.output", at, Math.floor(r() * 90_000), { extra: { outputTokens: Math.floor(r() * 4000) } }));
      else if (x < 0.75) {
        // Runs of one command, often three or more in a row, sometimes across the hour.
        const label = r() < 0.15 ? `echo ${seq}` : (LABELS[Math.floor(r() * LABELS.length)] as string);
        const n = 1 + Math.floor(r() * 4);
        for (let i = 0; i < n && at < now; i++) {
          const ms = label.startsWith("cargo") ? 2 * MIN + Math.floor(r() * 4 * MIN) : Math.floor(r() * 20_000);
          write(c, span(t, label === "git status" ? "git" : "tool.bash", at, ms, { label, exitCode: r() < 0.1 ? 1 : 0 }));
          at += ms + Math.floor(r() * 30_000);
        }
      } else if (x < 0.85) write(c, span(t, "tool.edit", at, 2_000, { label: `src/f${Math.floor(r() * 5)}.rs` }));
      else if (x < 0.88) write(c, span(t, "wait.request", at, Math.floor(r() * 20 * MIN), { extra: { key: `key${Math.floor(r() * 3)}` } }));
      else if (x < 0.91) write(c, span(t, "wait.permission", at, Math.floor(r() * 5 * MIN), { extra: { tool: "Bash", decidedBy: r() < 0.5 ? "human" : "policy" } }));
      else if (x < 0.96) {
        const w = `W${1 + Math.floor(r() * 4)}`;
        write(c, span(t, "change.ci", at, 8 * MIN, { ids: { ...span(t, "idle", 0, 0).ids, workstreamId: w } }));
        for (const check of ["rust", "bun", "site"]) {
          write(c, span(t, "ci.check", at + Math.floor(r() * MIN), Math.floor(r() * 7 * MIN), { ids: { ...span(t, "idle", 0, 0).ids, workstreamId: w }, extra: { check } }));
        }
      } else write(c, { ...span(t, "gap", at, 3 * MIN, { extra: { count: 2 } }), srcKey: `node/${t.id}/g${seq++}` });
      at += Math.floor(r() * 6 * MIN);
    }
  }
  // A thread that worked in two projects within one hour, and a span that ends before it starts.
  const both = { id: "tx", ref: P1, role: "implementer" };
  for (let i = 0; i < 4; i++) write(c, span({ ...both, ref: i % 2 ? P2 : P1 }, "tool.bash", now - 30 * HOUR + i * MIN, 10_000, { label: "git status" }));
  write(c, span(THREADS[0] as Thread, "tool.bash", now - 20 * HOUR, -5_000, { label: "ls" }));
  // Spans still open: a wait since yesterday, a command running now.
  write(c, span(THREADS[1] as Thread, "wait.request", now - 26 * HOUR, undefined, { srcKey: "open-wait", extra: { key: "k" } }));
  write(c, span(THREADS[0] as Thread, "tool.bash", now - 40 * MIN, undefined, { srcKey: "open-cmd", label: "cargo test" }));
  // Orders: two done with stored paths, two running.
  for (const [w, done] of [["W1", true], ["W2", true], ["W3", false], ["W4", false]] as const) {
    c.query("INSERT INTO time_orders (workstream_id, machine_id, project_id, start_ms, end_ms) VALUES (?1, 'devbox', 'p1', ?2, ?3)").run(w, from, done ? now - HOUR : null);
    const path = done ? orderPath(c, w, now - HOUR) : undefined;
    if (path) c.query("INSERT INTO time_paths (workstream_id, computed_ms, data) VALUES (?1, ?2, ?3)").run(w, now - HOUR, JSON.stringify(path));
  }
}

/** Builds every hour that is due, as the hub's upkeep does between reads. */
function build(c: Database, now: number): void {
  for (;;) {
    const got = upkeep(c, { now, ci: true, bytes: true });
    c.transaction(() => saveUpkeep(c, got, now))();
    if (!got.more) return;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

function jobs(now: number): TimeJob[] {
  const scopes: TimeScope[] = [
    { kind: "fleet" },
    { kind: "machine", machineId: "devbox" },
    { kind: "project", projectRef: P1 },
    { kind: "lead", projectRef: P1 },
  ];
  // Whole days and edges; a period that ends in the past; compared with the one before.
  const wide = { since: iso(now - 2 * DAY - 17 * MIN), compare: { since: iso(now - 4 * DAY), until: iso(now - 2 * DAY - 17 * MIN) } };
  const periods = [
    wide,
    { since: iso(now - 7 * HOUR - 5 * MIN) },
    { since: iso(now - 50 * HOUR + 7 * MIN), until: iso(now - 20 * HOUR - 13 * MIN) },
  ];
  const admin = caller("admin");
  const out: TimeJob[] = [];
  for (const scope of scopes) {
    for (const p of periods) {
      out.push({ tool: "time_insights", input: { scope, ...p }, caller: admin, now });
      for (const role of [undefined, "implementer", "lead"]) {
        out.push({ tool: "time_breakdown", input: { scope, ...p, ...(role ? { filters: { role: role as never } } : {}) }, caller: admin, now });
      }
    }
  }
  // A fleet view narrowed to a project, and a key that reads one machine.
  out.push({ tool: "time_breakdown", input: { scope: { kind: "fleet" }, ...wide, filters: { projectRef: P2 } }, caller: admin, now });
  out.push({ tool: "time_breakdown", input: { scope: { kind: "machine", machineId: "lab" }, ...wide }, caller: caller("read", false), now });
  return out;
}

function expectSame(c: Database, list: TimeJob[]): void {
  for (const job of list) {
    const spans = answer(c, job, true);
    expect({ job, out: answer(c, job) }).toEqual({ job, out: spans } as never);
  }
}

test("breakdowns and insights from the hourly digests equal those read span by span", () => {
  const t = testHub(Date.parse("2026-11-08T10:23:45Z"));
  try {
    const c = t.hub.db.conn;
    const now = t.clock.ms;
    c.transaction(() => seed(c, now))();
    build(c, now);
    expect(c.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM time_digests").get()?.n).toBeGreaterThan(100);
    const later = now + 30_000;
    expectSame(c, jobs(later));
    // Half a day not built yet (a backfill under way) is read from its spans.
    const h = Math.floor((now - 30 * HOUR) / HOUR);
    c.query("UPDATE time_hours SET built_version = NULL WHERE hour >= ?1 AND hour < ?2").run(h, h + 12);
    expectSame(c, jobs(later));
    build(c, later);

    // Spans written into built hours since (one in a thread the hour's digest folded), and the open command closing.
    c.transaction(() => {
      const t1 = THREADS[0] as Thread;
      for (let i = 0; i < 3; i++) write(c, span(t1, "tool.bash", now - 30 * HOUR + 20 * MIN + i * 1000, 500, { label: "git status" }));
      write(c, span(THREADS[3] as Thread, "wait.permission", now - 5 * HOUR, 4 * MIN, { extra: { decidedBy: "human", tool: "Edit" } }));
      write(c, span(t1, "tool.bash", now - 40 * MIN, 39 * MIN, { srcKey: "open-cmd", label: "cargo test" }));
    })();
    expectSame(c, jobs(later));

    // A span moved to another project, its hour reset: read from spans until built again, then from its digest.
    const moved = c.query<{ id: number; start_ms: number }, []>("SELECT id, start_ms FROM time_spans WHERE thread_id = 't5' ORDER BY id LIMIT 1").get();
    if (!moved) throw new Error("no span of t5");
    c.transaction(() => {
      c.query("UPDATE time_spans SET project_id = 'p1' WHERE id = ?1").run(moved.id);
      resetHours(c, [Math.floor(moved.start_ms / HOUR)]);
    })();
    expectSame(c, jobs(later));
    build(c, later + 2 * 60_000);
    expectSame(c, jobs(later + 2 * 60_000));
  } finally {
    t.done();
  }
}, 30_000);

test("a breakdown of built hours reads their digests, not their spans", () => {
  const t = testHub(Date.parse("2026-11-08T10:23:45Z"));
  try {
    const c = t.hub.db.conn;
    const now = t.clock.ms;
    c.transaction(() => seed(c, now))();
    build(c, now);
    const job: TimeJob = { tool: "time_breakdown", input: { scope: { kind: "fleet" }, since: iso(now - 2 * DAY) }, caller: caller("admin"), now: now + 30_000 };
    const before = answer(c, job) as { agentMs: number; byProfile: unknown };
    // The model spans of every hour but the edges go; read span by span the answer drops, from digests it stays.
    c.query("DELETE FROM time_spans WHERE kind = 5 AND start_ms >= ?1 AND start_ms < ?2").run(now - 2 * DAY + 2 * HOUR, now - 2 * HOUR);
    const after = answer(c, job) as { agentMs: number; byProfile: unknown };
    expect(after.agentMs).toBe(before.agentMs);
    expect(after.byProfile).toEqual(before.byProfile);
    expect((answer(c, job, true) as { agentMs: number }).agentMs).toBeLessThan(before.agentMs);
  } finally {
    t.done();
  }
}, 30_000);

test("a prune drops the digests of the hours it empties, and the hour it cuts is built again", () => {
  const t = testHub(Date.parse("2026-11-08T10:23:45Z"));
  try {
    const c = t.hub.db.conn;
    const now = t.clock.ms;
    c.transaction(() => seed(c, now))();
    build(c, now);
    // Two days' retention, so the prune cuts the seeded three days in the middle of an hour.
    c.query("INSERT INTO time_settings (key, value) VALUES ('retention_days', 2)").run();
    while (c.transaction(() => prune(c, now))()) {}
    const cut = Math.floor((now - 2 * DAY) / HOUR);
    expect(c.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM time_digests WHERE hour <= ?1").get(cut)?.n).toBe(0);
    expectSame(c, jobs(now + 30_000));
    build(c, now + 30_000);
    expect(c.query<{ b: number | null }, [number]>("SELECT built_version AS b FROM time_hours WHERE hour = ?1").get(cut)?.b).not.toBeNull();
    expectSame(c, jobs(now + 30_000));
  } finally {
    t.done();
  }
}, 30_000);
