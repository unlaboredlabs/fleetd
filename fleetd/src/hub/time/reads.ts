// What `time_spans`, `time_breakdown` and `time_insights` answer, read from any
// connection to hub.sqlite: tools.ts runs them on the read worker (store/read-worker.ts), off the event loop, as Rust
// ran them on its read-only connection. A fleet breakdown reads 200k spans and takes seconds; on the main connection
// every other call waited behind it. Reads are bounded: at most MAX_ROWS spans per period are loaded, and a read that
// hits the bound says so in coverage. A breakdown or insights of the fleet, a machine, a project or its lead reads the
// hourly digests instead (hours.ts), which give the same answer from a few thousand digests and the spans around them,
// unbounded. Nothing here may need the hub itself, only the database and the job's fields.
import type { Database } from "bun:sqlite";
import type {
  CategoryTotal,
  Coverage,
  CriticalPath,
  Gap,
  RepeatStat,
  Role,
  TimeScope,
  ToolMap,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import { requireRole } from "../api/grants.ts";
import type { Caller } from "../api/registry.ts";
import { Refs, who } from "../navi/owner.ts";
import * as navis from "../navi/store.ts";
import { isoMs } from "../store/time.ts";
import { type Digest, runsOf } from "./digest.ts";
import { ANY_ROLE, built, digestRead, type Merged, type Selection } from "./hours.ts";
import { categoryOf, kindCode, kindOf } from "./kinds.ts";
import { isDetail, type Row, type RuleInput } from "./model.ts";
import { criticalPath, decodeStored, forOutput } from "./path.ts";
import { compare as compareRules, FULL_SUITE_MIN_RUNS, insights as findInsights, MAX_INSIGHTS, REPEAT_MIN_RUNS, ruleSpans, SLOW_TOP } from "./rules.ts";
import {
  type Add,
  byProfile,
  ciChecks,
  ciOf,
  type CiSegments,
  filterOf,
  humanWait,
  itemId,
  LIVE_CI_MS,
  type Loaded,
  MAX_ROWS,
  narrow,
  PATH_ROWS,
  period,
  profilesOut,
  repeated,
  rollupScope,
  RUNNING_PATHS,
  topCommands,
  toSpan,
  totalsFold,
  unionMs,
  wholeDays,
} from "./stats.ts";
import { DAY, type Meta, read, readMeta, retentionDays, rollupTotals, storedBytes } from "./store.ts";

export { type CiSegments, ciOf, LIVE_CI_MS, MAX_ROWS } from "./stats.ts";

/** Every span of a read by label or kind: those come to a few thousand. */
const ALL = 10_000_000;

const numberOf = (id: string) => (/^[A-Z][0-9]+$/.test(id) ? Number(id.slice(1)) : -1);

const allowsEverywhere = (caller: Caller, role: Role) => caller.grants.some((g) => g.machines === "*" && allows({ ...caller, grants: [g] }, role));

/** The machine a scope needs a read grant on; undefined for the fleet. */
function scopeMachine(c: Database, scope: TimeScope): string | undefined {
  switch (scope.kind) {
    case "fleet":
      return undefined;
    case "machine":
    case "thread":
      return scope.machineId;
    case "project":
    case "lead":
      return scope.projectRef.machineId;
    case "order":
      return c.query<{ machine_id: string }, [number]>("SELECT machine_id FROM workstreams WHERE n = ?1").get(numberOf(scope.workstreamId))?.machine_id;
    case "task":
      return c.query<{ machine_id: string }, [number]>("SELECT machine_id FROM tasks WHERE n = ?1").get(numberOf(scope.taskId))?.machine_id;
  }
  return undefined;
}

function check(c: Database, caller: Caller, scope: TimeScope): void {
  const m = scopeMachine(c, scope);
  if (m !== undefined) return requireRole(caller, "read", m);
  if (scope.kind !== "fleet") throw new ToolError("not_found", "No such work or task.");
  if (!allowsEverywhere(caller, "read")) {
    throw new ToolError("forbidden", "The fleet scope needs read on every machine.", "Ask for a machine, project or order scope instead.");
  }
}

/** An order's start (intake submit, else `workstream.created`) and end (`workstream.done`, else none). */
export function orderBounds(c: Database, w: string): [number, number | undefined] | undefined {
  const row = c.query<{ start_ms: number; end_ms: number | null }, [string]>("SELECT start_ms, end_ms FROM time_orders WHERE workstream_id = ?1").get(w);
  const intake = c
    // The kind as a literal, so the intake index answers it; else the read walks every span of the order.
    .query<{ s: number | null }, [string]>(`SELECT MIN(start_ms) AS s FROM time_spans WHERE workstream_id = ?1 AND kind = ${kindCode("intake.route")}`)
    .get(w)?.s;
  if (!row) return undefined;
  return [intake == null ? row.start_ms : Math.min(intake, row.start_ms), row.end_ms ?? undefined];
}

/** Which lane each lane waits on: a task on the lead that spawned it, a change on its writer, a review on its change. */
function waitsOn(c: Database, rows: Row[]): Map<string, string[]> {
  const leadLanes = [...new Set(rows.filter((r) => r.lane.startsWith("thread:") && r.taskId === undefined && r.workstreamId === undefined).map((r) => r.lane))].sort();
  const taskLanes = new Map<string, string>();
  for (const r of rows) if (r.taskId !== undefined && r.lane.startsWith("thread:")) taskLanes.set(r.taskId, r.lane);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (out.has(r.lane)) continue;
    const on: string[] = [];
    if (r.taskId !== undefined) {
      const review = c
        .query<{ repo: string; pr_number: number }, [string]>(
          `SELECT ch.repo, ch.pr_number FROM review_tasks rt
           JOIN changes ch ON 'X' || ch.n = rt.change_id WHERE rt.task_id = ?1`,
        )
        .get(r.taskId);
      if (review) on.push(`change:${review.repo}#${review.pr_number}`);
      else on.push(...leadLanes);
    }
    if (r.lane.startsWith("change:") && r.taskId !== undefined) {
      const l = taskLanes.get(r.taskId);
      if (l !== undefined) on.push(l);
    }
    out.set(r.lane, on);
  }
  return out;
}

/** The order's critical path from its start to `end` (its done time, or now). */
export function orderPath(c: Database, w: string, end: number): CriticalPath | undefined {
  const bounds = orderBounds(c, w);
  if (!bounds) return undefined;
  const [start, done] = bounds;
  const stop = Math.max(done ?? end, start);
  const rows = read(c, { sinceMs: start, untilMs: stop, workstreamId: w }, PATH_ROWS);
  return criticalPath({ startMs: start, endMs: stop, rows, waitsOn: waitsOn(c, rows) });
}

/** Lead rows of an order count once over the orders their wake served. */
function weightsOf(c: Database, rows: Row[], metas: Meta[], order: string | undefined): number[] {
  if (order === undefined) return rows.map(() => 1);
  const cache = new Map<string, number>();
  return rows.map((r, i) => {
    const m = metas[i] as Meta;
    if (r.workstreamId === order || m.role !== "lead") return 1;
    const key = `${r.machineId ?? ""}\u0000${r.threadId ?? ""}\u0000${m.runId ?? ""}`;
    let w = cache.get(key);
    if (w === undefined) {
      const n = c
        .query<{ n: number }, [string, string, string]>("SELECT n FROM time_lead_runs WHERE machine_id = ?1 AND thread_id = ?2 AND run_id = ?3 LIMIT 1")
        .get(r.machineId ?? "", r.threadId ?? "", m.runId ?? "")?.n;
      w = 1 / Math.max(n ?? 1, 1);
      cache.set(key, w);
    }
    return w;
  });
}

function load(c: Database, scope: TimeScope, since: number, until: number, role?: string): Loaded {
  const f = filterOf(scope, since, until);
  if (role !== undefined) f.role = role;
  // Spans that start a day before the period at most: keeps the read on the start index.
  f.startFrom = since - DAY;
  f.newest = true;
  const got = readMeta(c, f, MAX_ROWS + 1);
  const truncated = got.length > MAX_ROWS;
  const kept = got.slice(0, MAX_ROWS);
  const rows = kept.map(([r]) => r);
  const metas = kept.map(([, m]) => m);
  return { rows, metas, weights: weightsOf(c, rows, metas, scope.kind === "order" ? scope.workstreamId : undefined), truncated };
}

/**
 * Agent time per category and kind. Whole UTC days inside the period come from the daily roll-ups; `rest` adds the
 * partial days at its edges, and scopes without a roll-up (a thread, a role filter). Every span counts in the day it
 * started.
 */
function totals(c: Database, scope: TimeScope, whole: [number, number] | undefined, rest: (add: Add) => void): { agent: number; cats: CategoryTotal[] } {
  const { add, out } = totalsFold();
  const sc = rollupScope(scope);
  if (sc && whole) {
    for (const [cat, kind, ms, n] of rollupTotals(c, sc[0], sc[1], whole[0] / DAY, whole[1] / DAY)) if (!isDetail(kind)) add(cat, kind, ms, n);
  }
  rest(add);
  return out();
}

/** Orders whose span overlaps the period, with their bounds clipped to it: (order, start, end, done). */
function ordersIn(c: Database, scope: TimeScope, since: number, until: number): [string, number, number, boolean][] {
  let clause = "1";
  const args: string[] = [];
  if (scope.kind === "machine") {
    clause = "machine_id = ?3";
    args.push(scope.machineId);
  } else if (scope.kind === "project" || scope.kind === "lead") {
    clause = "machine_id = ?3 AND project_id = ?4";
    args.push(scope.projectRef.machineId, scope.projectRef.projectId);
  } else if (scope.kind === "order") {
    clause = "workstream_id = ?3";
    args.push(scope.workstreamId);
  } else if (scope.kind !== "fleet") return [];
  const rows = c
    .query<{ workstream_id: string; start_ms: number; end_ms: number | null }, (string | number)[]>(
      `SELECT workstream_id, start_ms, end_ms FROM time_orders
       WHERE start_ms < ?2 AND COALESCE(end_ms, ?2) > ?1 AND ${clause} ORDER BY start_ms DESC LIMIT 5000`,
    )
    .all(since, until, ...args);
  return rows.map((row) => {
    const b = orderBounds(c, row.workstream_id);
    const s = b ? Math.min(b[0], row.start_ms) : row.start_ms;
    const e = b ? (b[1] ?? row.end_ms ?? undefined) : (row.end_ms ?? undefined);
    return [row.workstream_id, s, e ?? until, e !== undefined];
  });
}

function wall(c: Database, scope: TimeScope, l: Loaded, since: number, until: number): number {
  if (scope.kind === "task" || scope.kind === "thread") {
    const s = Math.max(l.rows.length ? Math.min(...l.rows.map((r) => r.startMs)) : since, since);
    const e = Math.min(l.rows.length ? Math.max(...l.rows.map((r) => r.endMs)) : since, until);
    return Math.max(e - s, 0);
  }
  return unionMs(
    ordersIn(c, scope, since, until)
      .map(([, s, e]): [number, number] => [Math.max(s, since), Math.min(e, until)])
      .filter(([s, e]) => e > s),
  );
}

/** Paths of running orders, kept until a span is written or a minute passes. */
export class PathCache {
  private readonly map = new Map<string, [head: number, minute: number, path: CriticalPath]>();

  getOr(c: Database, w: string, now: number): CriticalPath | undefined {
    const head = c.query<{ h: number }, []>("SELECT COALESCE(MAX(id), 0) AS h FROM time_spans").get()?.h ?? 0;
    const minute = Math.floor(now / 60_000);
    const hit = this.map.get(w);
    if (hit && hit[0] === head && hit[1] === minute) return hit[2];
    const path = orderPath(c, w, now);
    if (path) {
      if (this.map.size > 200) this.map.clear();
      this.map.set(w, [head, minute, path]);
    }
    return path;
  }
}

const caches = new WeakMap<Database, PathCache>();
const pathCache = (c: Database) => {
  let cache = caches.get(c);
  if (!cache) {
    cache = new PathCache();
    caches.set(c, cache);
  }
  return cache;
};

/** How long a breakdown's `storedBytes` may be reused. */
const STORED_FOR_MS = 60_000;
const stored = new WeakMap<Database, [at: number, bytes: number]>();

/**
 * The bytes the time tables take on disk: as the hub last measured them (upkeep.ts; measuring takes a few hundred ms),
 * else measured at most STORED_FOR_MS ago on this connection.
 */
function storedBytesOf(c: Database, now: number): number {
  const kept = c.query<{ value: number }, []>("SELECT value FROM time_settings WHERE key = 'stored_bytes'").get()?.value;
  if (kept !== undefined) return kept;
  const hit = stored.get(c);
  if (hit && now - hit[0] >= 0 && now - hit[0] < STORED_FOR_MS) return hit[1];
  const bytes = storedBytes(c);
  stored.set(c, [now, bytes]);
  return bytes;
}

/** Critical paths of the orders in the period: stored for finished orders, computed for running ones. */
function paths(c: Database, scope: TimeScope, since: number, until: number, now: number, cache: PathCache): [string, CriticalPath][] {
  const out: [string, CriticalPath][] = [];
  let running = 0;
  for (const [w, , , done] of ordersIn(c, scope, since, until).slice(0, 500)) {
    const stored = done ? c.query<{ data: string }, [string]>("SELECT data FROM time_paths WHERE workstream_id = ?1").get(w)?.data : undefined;
    let path = stored === undefined ? undefined : decodeStored(stored);
    if (!path) {
      if (running >= RUNNING_PATHS) continue;
      running += 1;
      path = cache.getOr(c, w, now);
    }
    if (path) out.push([w, path]);
  }
  return out;
}

/**
 * `paths`, as only their `change.ci` segments: a done order's from its stored path, a running one's as the hub last
 * worked them out (within LIVE_CI_MS, as PathCache keeps a path a minute), else as `paths` finds them.
 */
function ciPaths(c: Database, scope: TimeScope, since: number, until: number, now: number, cache: PathCache): [string, CiSegments][] {
  const out: [string, CiSegments][] = [];
  const keptCi = c.query<{ done: number; computed_ms: number; ci: string }, [string]>("SELECT done, computed_ms, ci FROM time_order_ci WHERE workstream_id = ?1");
  let running = 0;
  for (const [w, , , done] of ordersIn(c, scope, since, until).slice(0, 500)) {
    const kept = keptCi.get(w);
    if (done) {
      const at = c.query<{ computed_ms: number }, [string]>("SELECT computed_ms FROM time_paths WHERE workstream_id = ?1").get(w)?.computed_ms;
      if (at !== undefined && kept?.done === 1 && kept.computed_ms === at) {
        out.push([w, JSON.parse(kept.ci) as CiSegments]);
        continue;
      }
      const stored = at === undefined ? undefined : c.query<{ data: string }, [string]>("SELECT data FROM time_paths WHERE workstream_id = ?1").get(w)?.data;
      const path = stored === undefined ? undefined : decodeStored(stored);
      if (path) {
        out.push([w, ciOf(path)]);
        continue;
      }
    }
    if (running >= RUNNING_PATHS) continue;
    running += 1;
    if (!done && kept?.done === 0 && now - kept.computed_ms >= 0 && now - kept.computed_ms < LIVE_CI_MS) {
      out.push([w, JSON.parse(kept.ci) as CiSegments]);
      continue;
    }
    const path = cache.getOr(c, w, now);
    if (path) out.push([w, ciOf(path)]);
  }
  return out;
}

function coverage(c: Database, scope: TimeScope, l: Loaded, path: CriticalPath | undefined, since: number, now: number): Coverage {
  const gaps: Gap[] = [];
  l.rows.forEach((r, i) => {
    if (r.kind !== "gap" || gaps.length >= 50) return;
    const m = l.metas[i] as Meta;
    gaps.push({
      why: m.srcKey.startsWith("node/") || r.lane.startsWith("thread:") ? "node_dropped" : "hub_dropped",
      ...(r.lane ? { lane: r.lane } : {}),
      ...(r.machineId === undefined ? {} : { machineId: r.machineId }),
      fromMs: r.startMs,
      toMs: r.endMs,
      ...(r.extra.count === undefined ? {} : { count: r.extra.count }),
    });
  });
  // Sessions of the scope's tasks that started but sent no node spans: an older node, or a node restart mid-run.
  let tasks: { machine_id: string; thread_id: string }[] = [];
  if (scope.kind === "order") {
    tasks = c
      .query<{ machine_id: string; thread_id: string }, [string]>(
        "SELECT machine_id, thread_id FROM tasks WHERE workstream_id = ?1 AND thread_id IS NOT NULL LIMIT 200",
      )
      .all(scope.workstreamId);
  } else if (scope.kind === "task") {
    tasks = c
      .query<{ machine_id: string; thread_id: string }, [number]>("SELECT machine_id, thread_id FROM tasks WHERE n = ?1 AND thread_id IS NOT NULL")
      .all(numberOf(scope.taskId));
  }
  for (const t of tasks) {
    const has = c
      .query<{ one: number }, [string, string]>("SELECT 1 AS one FROM time_spans WHERE machine_id = ?1 AND thread_id = ?2 AND src LIKE 'n:%' LIMIT 1")
      .get(t.machine_id, t.thread_id);
    if (!has && gaps.length < 50) {
      gaps.push({ why: "no_node_spans", lane: `thread:${t.machine_id}/${t.thread_id}`, machineId: t.machine_id, fromMs: 0, toMs: 0 });
    }
  }
  if (path && path.nothingRunningMs > 0) {
    for (const s of path.segments.filter((s) => s.spanId === undefined)) {
      if (gaps.length >= 50) break;
      gaps.push({ why: "nothing_running", fromMs: s.startMs, toMs: s.endMs });
    }
  }
  const keptFrom = now - retentionDays(c) * DAY;
  const detailSince = since < keptFrom ? isoMs(keptFrom) : undefined;
  return {
    complete: gaps.length === 0 && !l.truncated && detailSince === undefined,
    gaps,
    ...(detailSince === undefined ? {} : { detailSince }),
    ...(l.truncated ? { capped: true } : {}),
  };
}

/** Whether the key may read `r`: on a machine it has a grant on, and not of another person's Only me project. */
function mayRead(caller: Caller, others: Refs, r: Row): boolean {
  const ofNavi = r.machineId !== undefined && r.projectId !== undefined && others.has({ machineId: r.machineId, projectId: r.projectId });
  return !ofNavi && (r.machineId === undefined || allows(caller, "read", r.machineId));
}

function readable(j: Reading, l: Loaded): Loaded {
  if (j.others.size === 0 && allowsEverywhere(j.caller, "read")) return l;
  const keep = l.rows.map((r) => mayRead(j.caller, j.others, r));
  return {
    rows: l.rows.filter((_, i) => keep[i]),
    metas: l.metas.filter((_, i) => keep[i]),
    weights: l.weights.filter((_, i) => keep[i]),
    truncated: l.truncated,
  };
}

/** The rules' input over the period's spans of `l`, with those spans' metas in the same order. */
function ruleInput(c: Database, l: Loaded, since: number, until: number): { input: RuleInput; metas: Meta[] } {
  const titles = new Map<string, string>();
  const ids = [...new Set(l.rows.flatMap((r) => (r.taskId === undefined ? [] : [r.taskId])))].sort().slice(0, 2000);
  for (const t of ids) {
    const title = c.query<{ t: string | null }, [number]>("SELECT json_extract(data, '$.title') AS t FROM tasks WHERE n = ?1").get(numberOf(t))?.t;
    if (title) titles.set(t, title);
  }
  const rows: Row[] = [];
  const metas: Meta[] = [];
  l.rows.forEach((r, i) => {
    if (r.startMs >= since && r.startMs < until) {
      rows.push(r);
      metas.push(l.metas[i] as Meta);
    }
  });
  return { input: { rows, taskTitles: titles }, metas };
}

function periodBreakdown(j: Reading, scope: TimeScope, since: number, until: number, role?: string) {
  const c = j.c;
  const l = readable(j, load(c, scope, since, until, role));
  const whole = wholeDays(scope, role, since, until);
  const { agent, cats } = totals(c, scope, whole, (add) =>
    l.rows.forEach((r, i) => {
      if (r.startMs < since || r.startMs >= until || isDetail(r.kind)) return;
      if (whole && r.startMs >= whole[0] && r.startMs < whole[1]) return;
      add(categoryOf(r.kind), r.kind, r.exclMs * (l.weights[i] as number), 1);
    }),
  );
  return { l, wall: wall(c, scope, l, since, until), agent, cats };
}

/** The digests and spans a breakdown of `scope` reads (hours.ts); none for an order, a task or a thread. */
function selectionOf(j: Reading, scope: TimeScope, role: string | undefined): Selection | undefined {
  const mayRead = (machineId: string | undefined, projectId: string | undefined) =>
    !(machineId !== undefined && projectId !== undefined && j.others.has({ machineId, projectId })) &&
    (machineId === undefined || allows(j.caller, "read", machineId));
  let s: Selection;
  switch (scope.kind) {
    case "fleet":
      s = { role: ANY_ROLE, filter: {}, mayRead };
      break;
    case "machine":
      s = { machineId: scope.machineId, role: ANY_ROLE, filter: { machineId: scope.machineId }, mayRead };
      break;
    case "project":
    case "lead": {
      const { machineId, projectId } = scope.projectRef;
      const ref: [string, string] = [machineId, projectId];
      s = scope.kind === "lead" ? { machineId, projectId, role: "lead", filter: { lead: ref }, mayRead } : { machineId, projectId, role: ANY_ROLE, filter: { project: ref }, mayRead };
      break;
    }
    default:
      return undefined;
  }
  if (role !== undefined) {
    s.filter.role = role;
    // A lead scope filtered to another role has no spans; no digest has that role.
    s.role = s.role === ANY_ROLE || s.role === role ? role : "\u0000";
  }
  return s;
}

/** Label ids whose ms reach the `k`th largest: the top `k` labels, ties at the cut included. */
function topLabels(labels: Digest["labels"], k: number): number[] {
  // The k largest so far, ascending: a month holds 100k labels, too many to sort for twenty.
  const top: number[] = [];
  for (const [, ms] of labels.values()) {
    if (top.length === k && ms <= (top[0] as number)) continue;
    let i = 0;
    while (i < top.length && (top[i] as number) < ms) i++;
    top.splice(i, 0, ms);
    if (top.length > k) top.shift();
  }
  const cut = top.length === k ? (top[0] as number) : Number.NEGATIVE_INFINITY;
  const out: number[] = [];
  for (const [id, [, ms]] of labels) if (ms >= cut) out.push(id);
  return out;
}

/** The spans of these labels that a selection reads in the period: commands only. */
function labelRows(c: Database, sel: Selection, ids: number[], since: number, until: number): [Row, Meta][] {
  if (ids.length === 0) return [];
  return readMeta(c, { ...sel.filter, sinceMs: since, untilMs: until, startFrom: since, labelIds: ids }, ALL).filter(
    ([r]) => (r.kind === "tool.bash" || r.kind === "git") && sel.mayRead(r.machineId, r.projectId),
  );
}

/** A period's wall and agent time per category, from the digests. */
function digestTotals(j: Reading, scope: TimeScope, sel: Selection, role: string | undefined, since: number, until: number) {
  const whole = wholeDays(scope, role, since, until);
  const m = digestRead(j.c, sel, since, until, whole);
  const { agent, cats } = totals(j.c, scope, whole, (add) => {
    for (const [code, [ms, n]] of m.d.kinds) {
      const kind = kindOf(code);
      if (kind !== undefined && !isDetail(kind)) add(categoryOf(kind), kind, ms, n);
    }
  });
  return { m, wall: wall(j.c, scope, NO_SPANS, since, until), agent, cats };
}

const NO_SPANS: Loaded = { rows: [], metas: [], weights: [], truncated: false };

/** `repeated`, from the threads' folded commands. */
function repeatedOf(c: Database, m: Merged): RepeatStat[] {
  // Most time first, then by thread and place in it, as `repeated` lists them.
  const runs = [...m.seqs]
    .flatMap(([thread, s]) => runsOf(s).map((r) => ({ thread, r })))
    .sort((a, b) => b.r.ms - a.r.ms || (a.thread < b.thread ? -1 : a.thread > b.thread ? 1 : 0) || a.r.start - b.r.start || a.r.id - b.r.id)
    .slice(0, 10);
  const text = c.query<{ text: string }, [number]>("SELECT text FROM time_labels WHERE id = ?1");
  return runs.map(({ thread, r }) => ({
    label: text.get(r.label)?.text ?? "",
    threadId: thread,
    ...(r.task === undefined ? {} : { taskId: r.task }),
    n: r.n,
    totalMs: r.ms,
  }));
}

/** `breakdown` from the digests: the same answer, without reading each span of the period. */
function digestBreakdown(j: Reading, scope: TimeScope, sel: Selection, input: ToolMap["time_breakdown"]["input"], role: string | undefined) {
  const { c, now } = j;
  const [since, until] = period(input.since, input.until, now);
  const cmp = input.compare ? period(input.compare.since, input.compare.until, now) : undefined;
  let compare: { since: string; until: string; wallMs: number; agentMs: number; byCategory: CategoryTotal[] } | undefined;
  if (cmp) {
    const p = digestTotals(j, scope, sel, role, cmp[0], cmp[1]);
    compare = { since: isoMs(cmp[0]), until: isoMs(cmp[1]), wallMs: Math.max(p.wall, 0), agentMs: Math.max(p.agent, 0), byCategory: p.cats };
  }
  const { m, wall: wallMs, agent, cats } = digestTotals(j, scope, sel, role, since, until);
  const commands = labelRows(c, sel, topLabels(m.d.labels, 20), since, until).map(([r]) => r);
  const gaps = readMeta(c, { ...sel.filter, sinceMs: since, untilMs: until, startFrom: since - DAY, kind: "gap" }, ALL).filter(([r]) =>
    sel.mayRead(r.machineId, r.projectId),
  );
  const cov = coverage(c, scope, { rows: gaps.map(([r]) => r), metas: gaps.map(([, mt]) => mt), weights: gaps.map(() => 1), truncated: false }, undefined, since, now);
  const profiles = profilesOut(m.d.profiles);
  return {
    wallMs: Math.max(wallMs, 0),
    agentMs: Math.max(agent, 0),
    byCategory: cats,
    ...(profiles.length > 0 ? { byProfile: profiles } : {}),
    topCommands: topCommands(commands),
    repeated: repeatedOf(c, m),
    ciChecks: ciChecks(
      m.d.rows.filter((r) => r.kind === "ci.check"),
      ciPaths(c, scope, since, until, now, pathCache(c)),
    ),
    humanWait: humanWait(m.d.rows),
    retentionDays: retentionDays(c),
    storedBytes: storedBytesOf(c, now),
    coverage: cov,
    ...(compare ? { compare } : {}),
    next: "time_insights reads the same spans for findings; time_spans lists them.",
  };
}

/** The rules' input from the digests: every span of the labels that can fire or that `want` names, and the edits. */
function digestRuleInput(c: Database, sel: Selection, m: Merged, want: number[], since: number, until: number): RuleInput {
  const rows = [...labelRows(c, sel, want, since, until).map(([r]) => r), ...m.d.rows.filter((r) => r.kind === "tool.edit")].sort((a, b) => a.id - b.id);
  return ruleInput(c, { rows, metas: rows.map(() => NO_META), weights: rows.map(() => 1), truncated: false }, since, until).input;
}

const NO_META: Meta = { srcKey: "", open: false };

/**
 * The labels the rules need spans of: a finding needs a label run REPEAT_MIN_RUNS times (FULL_SUITE_MIN_RUNS for a
 * suite), or among the SLOW_TOP slowest.
 */
function ruleLabels(m: Merged): number[] {
  const runs = Math.min(REPEAT_MIN_RUNS, FULL_SUITE_MIN_RUNS);
  const out = new Set(topLabels(m.d.labels, SLOW_TOP));
  for (const [id, [n]] of m.d.labels) if (n >= runs) out.add(id);
  return [...out];
}

/** `insightsOf` from the digests: the rules run on the spans that can make a finding, which are the same findings. */
function digestInsights(j: Reading, sel: Selection, input: ToolMap["time_insights"]["input"]): ToolMap["time_insights"]["output"] {
  const { c, now } = j;
  const [since, until] = period(input.since, input.until, now);
  const cmp = input.compare ? period(input.compare.since, input.compare.until, now) : undefined;
  const cur = digestRead(c, sel, since, until);
  const prev = cmp ? digestRead(c, sel, cmp[0], cmp[1]) : undefined;
  // Both periods read the same labels, so a finding of one has its numbers in the other.
  const want = [...new Set([...ruleLabels(cur), ...(prev ? ruleLabels(prev) : [])])].sort((a, b) => a - b);
  const a = digestRuleInput(c, sel, cur, want, since, until);
  const found = cmp && prev ? compareRules(a, digestRuleInput(c, sel, prev, want, cmp[0], cmp[1])) : findInsights(a);
  return { next: "time_spans with rule lists every span a finding links to.", insights: found.slice(0, MAX_INSIGHTS) };
}

/** One read's job, as the read worker gets it: the tool, its decoded input, the key it is for and the hub's now. */
export type TimeJob =
  | { tool: "time_spans"; input: ToolMap["time_spans"]["input"]; caller: Caller; now: number }
  | { tool: "time_breakdown"; input: ToolMap["time_breakdown"]["input"]; caller: Caller; now: number }
  | { tool: "time_insights"; input: ToolMap["time_insights"]["input"]; caller: Caller; now: number };

/** What a read has to hand: its connection, its key, the Only me projects that key may not see, and now. */
type Reading = { c: Database; caller: Caller; others: Refs; now: number; spansOnly: boolean };

/**
 * The job's answer, read on `c`; throws the ToolError the tool answers with. `spansOnly` reads every span instead of
 * the hourly digests, as the test that holds the two answers equal does.
 */
export function answer(c: Database, job: TimeJob, spansOnly = false): unknown {
  const j: Reading = { c, caller: job.caller, others: new Refs(navis.others(c, who(c, job.caller))), now: job.now, spansOnly };
  switch (job.tool) {
    case "time_spans":
      return spans(j, job.input);
    case "time_breakdown":
      return breakdown(j, job.input);
    case "time_insights":
      return insightsOf(j, job.input);
  }
}

function spans(j: Reading, input: ToolMap["time_spans"]["input"]): ToolMap["time_spans"]["output"] {
  const { c, caller, now } = j;
  const [since, until] = period(input.since, input.until, now);
  const limit = input.limit ?? 200;
  check(c, caller, input.scope);
  const f = filterOf(input.scope, since, until);
  if (input.kinds) f.kinds = input.kinds;
  if (input.afterId !== undefined) f.afterId = input.afterId;
  let rows: [Row, Meta][];
  if (input.rule !== undefined) {
    const l = readable(j, load(c, input.scope, since, until));
    const { input: ri, metas } = ruleInput(c, l, since, until);
    const after = f.afterId ?? 0;
    const wanted = new Set(ruleSpans(ri, input.rule).filter((i) => i > after));
    rows = ri.rows.map((r, i): [Row, Meta] => [r, metas[i] as Meta]).filter(([r]) => wanted.has(r.id)).slice(0, limit + 1);
  } else rows = readMeta(c, f, limit + 1);
  rows = rows.filter(([r]) => mayRead(caller, j.others, r));
  const cov = coverage(c, input.scope, { rows: rows.map(([r]) => r), metas: rows.map(([, m]) => m), weights: rows.map(() => 1), truncated: false }, undefined, since, now);
  const more = rows.length > limit;
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return {
    ...(more && last ? { nextAfterId: last[0].id } : {}),
    spans: shown.map(([r, m]) => toSpan(r, m)),
    coverage: cov,
    next: more ? "More spans: call again with afterId." : "time_breakdown sums these; thread_window opens a span's transcript by its itemId.",
    ...(more ? { truncated: true } : {}),
  };
}

function breakdown(j: Reading, input: ToolMap["time_breakdown"]["input"]): ToolMap["time_breakdown"]["output"] {
  const { c, caller, now } = j;
  const [since, until] = period(input.since, input.until, now);
  const cmp = input.compare ? period(input.compare.since, input.compare.until, now) : undefined;
  const role = input.filters?.role;
  const scope = narrow(input.scope, input.filters);
  check(c, caller, scope);
  const sel = j.spansOnly || !built(c, since, until, now) || (cmp && !built(c, cmp[0], cmp[1], now)) ? undefined : selectionOf(j, scope, role);
  if (sel) return digestBreakdown(j, scope, sel, input, role);
  // The compared period first, so its spans are gone before this period's load.
  let compare: { since: string; until: string; wallMs: number; agentMs: number; byCategory: CategoryTotal[] } | undefined;
  if (cmp) {
    const p = periodBreakdown(j, scope, cmp[0], cmp[1], role);
    compare = { since: isoMs(cmp[0]), until: isoMs(cmp[1]), wallMs: Math.max(p.wall, 0), agentMs: Math.max(p.agent, 0), byCategory: p.cats };
  }
  const { l, wall: wallMs, agent, cats } = periodBreakdown(j, scope, since, until, role);
  const inPeriod = l.rows.filter((r) => r.startMs >= since && r.startMs < until);
  const ps = paths(c, scope, since, until, now, pathCache(c));
  const path = scope.kind === "order" ? ps.find(([w]) => w === scope.workstreamId)?.[1] : undefined;
  const cov = coverage(c, scope, l, path, since, now);
  const profiles = byProfile(l, since, until);
  return {
    wallMs: Math.max(wallMs, 0),
    agentMs: Math.max(agent, 0),
    byCategory: cats,
    ...(profiles.length > 0 ? { byProfile: profiles } : {}),
    topCommands: topCommands(inPeriod),
    repeated: repeated(inPeriod),
    ciChecks: ciChecks(inPeriod, ps.map(([w, p]) => [w, ciOf(p)])),
    humanWait: humanWait(inPeriod),
    ...(path ? { criticalPath: forOutput(path) } : {}),
    retentionDays: retentionDays(c),
    storedBytes: storedBytesOf(c, now),
    coverage: cov,
    ...(compare ? { compare } : {}),
    next: "time_insights reads the same spans for findings; time_spans lists them.",
    ...(l.truncated ? { truncated: true } : {}),
  };
}

function insightsOf(j: Reading, input: ToolMap["time_insights"]["input"]): ToolMap["time_insights"]["output"] {
  const { c, caller, now } = j;
  const [since, until] = period(input.since, input.until, now);
  const cmp = input.compare ? period(input.compare.since, input.compare.until, now) : undefined;
  check(c, caller, input.scope);
  const sel = j.spansOnly || !built(c, since, until, now) || (cmp && !built(c, cmp[0], cmp[1], now)) ? undefined : selectionOf(j, input.scope, undefined);
  if (sel) return digestInsights(j, sel, input);
  const cur = ruleInput(c, readable(j, load(c, input.scope, since, until)), since, until).input;
  const found = cmp
    ? compareRules(cur, ruleInput(c, readable(j, load(c, input.scope, cmp[0], cmp[1])), cmp[0], cmp[1]).input)
    : findInsights(cur);
  return { next: "time_spans with rule lists every span a finding links to.", insights: found.slice(0, MAX_INSIGHTS) };
}
