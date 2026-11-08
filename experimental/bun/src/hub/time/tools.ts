// `time_spans`, `time_breakdown` and `time_insights` (crates/fleetd/src/hub/time/tools.rs). Reads are bounded: at most
// MAX_ROWS spans per period are loaded, and a read that hits the bound says so in coverage. `thread_window` reads a
// session's transcript around one item through the executor's thread view.
import type { Database } from "bun:sqlite";
import type {
  Category,
  CategoryTotal,
  CiCheckStat,
  CommandStat,
  Coverage,
  CriticalPath,
  Gap,
  HumanWait,
  ProfileTotal,
  RepeatStat,
  Role,
  Span,
  SpanKind,
  TimeFilters,
  TimeScope,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import type { Hub } from "../api/hub.ts";
import { requireRole } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { executors } from "../executor/index.ts";
import { fromExecutor } from "../executor/tools.ts";
import { others } from "../navi/owner.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { time } from "./index.ts";
import { CATEGORIES, categoryOf, kindCode } from "./kinds.ts";
import { dur, isDetail, type Row, type RuleInput } from "./model.ts";
import { criticalPath, decodeStored, forOutput } from "./path.ts";
import { compare as compareRules, insights as findInsights, MAX_INSIGHTS, ruleSpans } from "./rules.ts";
import { DAY, type Filter, headUtf16, type Meta, read, readMeta, retentionDays, rollupTotals } from "./store.ts";

/** Spans loaded per period for a breakdown or the rules. */
export const MAX_ROWS = 200_000;
/** Spans of one order read for its critical path. */
const PATH_ROWS = 100_000;
/** Running orders whose path a read computes, newest first. */
const RUNNING_PATHS = 20;
const PROFILES_MAX = 50;

const invalid = (message: string, fix?: string) => new ToolError("invalid", message, fix);

function msOf(t: string): number {
  const ms = parseMs(t);
  if (ms === undefined) throw invalid(`${t} is not an ISO time`);
  return ms;
}

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

function filterOf(scope: TimeScope, since: number, until: number): Filter {
  const f: Filter = { sinceMs: since, untilMs: until };
  switch (scope.kind) {
    case "machine":
      f.machineId = scope.machineId;
      break;
    case "project":
      f.project = [scope.projectRef.machineId, scope.projectRef.projectId];
      break;
    case "lead":
      f.lead = [scope.projectRef.machineId, scope.projectRef.projectId];
      break;
    case "order":
      f.workstreamId = scope.workstreamId;
      break;
    case "task":
      f.taskIds = [scope.taskId];
      break;
    case "thread":
      f.thread = [scope.machineId, scope.threadId];
      break;
  }
  return f;
}

/** An order's start (intake submit, else `workstream.created`) and end (`workstream.done`, else none). */
export function orderBounds(c: Database, w: string): [number, number | undefined] | undefined {
  const row = c.query<{ start_ms: number; end_ms: number | null }, [string]>("SELECT start_ms, end_ms FROM time_orders WHERE workstream_id = ?1").get(w);
  const intake = c
    .query<{ s: number | null }, [string, number]>("SELECT MIN(start_ms) AS s FROM time_spans WHERE workstream_id = ?1 AND kind = ?2")
    .get(w, kindCode("intake.route"))?.s;
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

type Loaded = { rows: Row[]; metas: Meta[]; weights: number[]; truncated: boolean };

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

/** The roll-up row a scope adds to, if it has one. */
function rollupScope(scope: TimeScope): [string, string] | undefined {
  switch (scope.kind) {
    case "fleet":
      return ["fleet", ""];
    case "machine":
      return ["machine", scope.machineId];
    case "project":
      return ["project", `${scope.projectRef.machineId}/${scope.projectRef.projectId}`];
    case "lead":
      return ["lead", `${scope.projectRef.machineId}/${scope.projectRef.projectId}`];
    case "order":
      return ["order", scope.workstreamId];
    case "task":
      return ["task", scope.taskId];
  }
  return undefined;
}

const mod = (a: number, b: number) => ((a % b) + b) % b;

/**
 * Agent time per category and kind. Whole UTC days inside the period come from the daily roll-ups, the partial days
 * at its edges, and scopes without a roll-up (a thread, a role filter), from spans. Every span counts in the day it
 * started.
 */
function totals(c: Database, scope: TimeScope, role: string | undefined, l: Loaded, since: number, until: number): { agent: number; cats: CategoryTotal[] } {
  const by = new Map<Category, { ms: number; n: number; kinds: Map<SpanKind, [number, number]> }>();
  const add = (cat: Category, kind: SpanKind, ms: number, n: number) => {
    const e = by.get(cat) ?? { ms: 0, n: 0, kinds: new Map() };
    by.set(cat, e);
    e.ms += ms;
    e.n += n;
    const k = e.kinds.get(kind) ?? [0, 0];
    e.kinds.set(kind, k);
    k[0] += ms;
    k[1] += n;
  };
  const fromDay = Math.floor(since / DAY) + (mod(since, DAY) !== 0 ? 1 : 0);
  const toDay = Math.floor(until / DAY);
  const sc = rollupScope(scope);
  let whole: [number, number] | undefined;
  if (sc && role === undefined && toDay > fromDay) {
    for (const [cat, kind, ms, n] of rollupTotals(c, sc[0], sc[1], fromDay, toDay)) if (!isDetail(kind)) add(cat, kind, ms, n);
    whole = [fromDay * DAY, toDay * DAY];
  }
  l.rows.forEach((r, i) => {
    if (r.startMs < since || r.startMs >= until || isDetail(r.kind)) return;
    if (whole && r.startMs >= whole[0] && r.startMs < whole[1]) return;
    add(categoryOf(r.kind), r.kind, r.exclMs * (l.weights[i] as number), 1);
  });
  let agent = 0;
  const cats: CategoryTotal[] = CATEGORIES.flatMap((cat) => {
    const e = by.get(cat);
    if (!e) return [];
    agent += Math.round(e.ms);
    return [
      {
        cat,
        ms: Math.max(Math.round(e.ms), 0),
        n: e.n,
        kinds: [...e.kinds.entries()].sort(([a], [b]) => kindCode(a) - kindCode(b)).map(([kind, [ms, n]]) => ({ kind, ms: Math.max(Math.round(ms), 0), n })),
      },
    ];
  });
  return { agent, cats };
}

function p50(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] as number;
}

/** Each profile's agent time, model time and output tokens over the period's spans, most agent time first. */
function byProfile(l: Loaded, since: number, until: number): ProfileTotal[] {
  const sums = new Map<string, [number, number, number]>();
  l.rows.forEach((r, i) => {
    if (r.startMs < since || r.startMs >= until || r.profile === undefined) return;
    const w = l.weights[i] as number;
    const sum = sums.get(r.profile) ?? [0, 0, 0];
    sums.set(r.profile, sum);
    sum[2] += Math.round((r.extra.outputTokens ?? 0) * w);
    if (isDetail(r.kind)) return;
    const ms = r.exclMs * w;
    sum[0] += ms;
    if (categoryOf(r.kind) === "model") sum[1] += ms;
  });
  return [...sums.entries()]
    .map(([profile, [agent, model, tokens]]) => ({
      profile,
      agentMs: Math.max(Math.round(agent), 0),
      modelMs: Math.max(Math.round(model), 0),
      outputTokens: Math.max(tokens, 0),
    }))
    .sort((a, b) => b.agentMs - a.agentMs || (a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0))
    .slice(0, PROFILES_MAX);
}

function topCommands(rows: Row[]): CommandStat[] {
  const by = new Map<string, { family: string; durs: number[]; failed: number }>();
  for (const r of rows) {
    if ((r.kind !== "tool.bash" && r.kind !== "git") || r.label === undefined) continue;
    const e = by.get(r.label) ?? { family: r.family ?? "", durs: [], failed: 0 };
    by.set(r.label, e);
    e.durs.push(dur(r));
    if ((r.exitCode !== undefined && r.exitCode !== 0) || r.status === "failed") e.failed += 1;
  }
  return [...by.entries()]
    .map(([label, e]) => ({
      label,
      family: headUtf16(e.family, 120),
      n: e.durs.length,
      totalMs: e.durs.reduce((a, b) => a + b, 0),
      p50Ms: p50(e.durs),
      maxMs: Math.max(0, ...e.durs),
      failed: e.failed,
    }))
    .sort((a, b) => b.totalMs - a.totalMs || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, 20);
}

function repeated(rows: Row[]): RepeatStat[] {
  const byThread = new Map<string, Row[]>();
  for (const r of rows) {
    if ((r.kind === "tool.bash" || r.kind === "git" || r.kind === "tool.edit") && r.threadId !== undefined) {
      const list = byThread.get(r.threadId) ?? [];
      list.push(r);
      byThread.set(r.threadId, list);
    }
  }
  const out: RepeatStat[] = [];
  for (const [thread, rs] of [...byThread.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    rs.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
    let i = 0;
    while (i < rs.length) {
      if ((rs[i] as Row).kind === "tool.edit") {
        i++;
        continue;
      }
      const label = (rs[i] as Row).label ?? "";
      let j = i;
      let total = 0;
      while (j < rs.length && (rs[j] as Row).kind !== "tool.edit" && (rs[j] as Row).label === label) {
        total += dur(rs[j] as Row);
        j++;
      }
      if (j - i >= 3) {
        const task = (rs[i] as Row).taskId;
        out.push({ label, threadId: thread, ...(task === undefined ? {} : { taskId: task }), n: j - i, totalMs: total });
      }
      i = Math.max(j, i + 1);
    }
  }
  // A stable sort, as Rust's sort_by_key keeps equal totals in thread order.
  return out.sort((a, b) => b.totalMs - a.totalMs).slice(0, 10);
}

function ciChecks(rows: Row[], paths: [string, CriticalPath][]): CiCheckStat[] {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    if (r.kind !== "ci.check") continue;
    const name = r.extra.check ?? "";
    const list = by.get(name) ?? [];
    list.push(dur(r));
    by.set(name, list);
  }
  // The excess of the last check over the one before, on `change.ci` segments of the paths.
  const excess = new Map<string, number>();
  for (const [w, p] of paths) {
    for (const seg of p.segments.filter((s) => s.kind === "change.ci")) {
      const checks = rows
        .filter((r) => r.kind === "ci.check" && r.workstreamId === w && r.startMs < seg.endMs && r.endMs > seg.startMs)
        .sort((a, b) => a.endMs - b.endMs);
      const last = checks[checks.length - 1];
      if (!last) continue;
      const before = checks.length >= 2 ? (checks[checks.length - 2] as Row).endMs : seg.startMs;
      const e = Math.min(last.endMs, seg.endMs) - Math.max(before, seg.startMs);
      const name = last.extra.check ?? "";
      excess.set(name, (excess.get(name) ?? 0) + Math.max(e, 0));
    }
  }
  return [...by.entries()]
    .filter(([n]) => n !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, d]) => ({
      criticalExcessMs: excess.get(name) ?? 0,
      name: headUtf16(name, 200),
      n: d.length,
      totalMs: d.reduce((a, b) => a + b, 0),
      p50Ms: p50(d),
      maxMs: Math.max(0, ...d),
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 20);
}

function humanWait(rows: Row[]): HumanWait {
  const waits = rows.filter((r) => r.kind === "wait.request" || (r.kind === "wait.permission" && r.extra.decidedBy === "human"));
  let longest: Row | undefined;
  for (const r of waits) {
    if (!longest || dur(r) > dur(longest) || (dur(r) === dur(longest) && r.id < longest.id)) longest = r;
  }
  const label = longest ? (longest.extra.key !== undefined ? headUtf16(longest.extra.key, 200) : longest.extra.tool) : undefined;
  return {
    totalMs: waits.reduce((n, r) => n + dur(r), 0),
    n: waits.length,
    ...(longest ? { longest: { spanId: longest.id, ms: dur(longest), ...(label === undefined ? {} : { label }) } } : {}),
  };
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

/** The union of the intervals, in ms. */
function unionMs(spans: [number, number][]): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let cur: [number, number] | undefined;
  for (const [s, e] of sorted) {
    if (cur && s <= cur[1]) cur = [cur[0], Math.max(cur[1], e)];
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [s, e];
    }
  }
  return total + (cur ? cur[1] - cur[0] : 0);
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

const caches = new WeakMap<Hub, PathCache>();
const pathCache = (hub: Hub) => {
  let cache = caches.get(hub);
  if (!cache) {
    cache = new PathCache();
    caches.set(hub, cache);
  }
  return cache;
};

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

/** A node span's item id in its thread: a tool call's `tool_use_id`, a message's id, a prompt's permission item. */
function itemId(srcKey: string, kind: SpanKind): string | undefined {
  const at = srcKey.indexOf("/");
  if (at < 0) return undefined;
  const rest = srcKey.slice(at + 1);
  switch (kind) {
    case "model.message":
      return rest.startsWith("msg/") ? rest.slice(4) : undefined;
    case "model.first_token":
    case "model.thinking":
    case "model.output": {
      if (!rest.startsWith("msg/")) return undefined;
      const m = rest.slice(4);
      const cut = m.lastIndexOf("/");
      return cut < 0 ? undefined : m.slice(0, cut);
    }
    case "wait.permission":
      return rest.startsWith("perm/") ? `permission-${rest.slice(5)}` : undefined;
    case "tool.bash":
    case "tool.read":
    case "tool.edit":
    case "tool.web":
    case "tool.mcp":
    case "tool.other":
    case "git":
      return rest.includes("/") ? undefined : rest;
  }
  return undefined;
}

function toSpan(r: Row, m: Meta): Span {
  const item = itemId(m.srcKey, r.kind);
  const span: Span = {
    id: r.id,
    kind: r.kind,
    cat: categoryOf(r.kind),
    lane: r.lane || "?",
    startMs: r.startMs,
    status: r.status,
  };
  if (!m.open) {
    span.endMs = r.endMs;
    span.exclMs = r.exclMs;
  }
  if (r.machineId !== undefined) span.machineId = r.machineId;
  if (r.projectId !== undefined) span.projectId = r.projectId;
  if (r.workstreamId !== undefined) span.workstreamId = r.workstreamId;
  if (r.taskId !== undefined) span.taskId = r.taskId;
  if (r.threadId !== undefined) span.threadId = r.threadId;
  if (m.runId) span.runId = m.runId;
  if (r.parentId !== undefined) span.parent = r.parentId;
  if (r.label !== undefined) span.label = r.label;
  if (r.family !== undefined) span.family = headUtf16(r.family, 120);
  if (r.exitCode !== undefined) span.exitCode = r.exitCode;
  if (r.outBytes !== undefined) span.outBytes = r.outBytes;
  if (item) span.itemId = item;
  if (Object.keys(r.extra).length > 0) span.extra = r.extra;
  return span;
}

function period(since: string, until: string | undefined, now: number): [number, number] {
  const s = msOf(since);
  const u = until === undefined ? now : msOf(until);
  if (u <= s) throw invalid("until must be after since", "Give since earlier than until.");
  return [s, u];
}

/** Whether the key may read `r`: on a machine it has a grant on, and not of another person's Only me project. */
function mayRead(caller: Caller, navis: ReturnType<typeof others>, r: Row): boolean {
  const ofNavi = r.machineId !== undefined && r.projectId !== undefined && navis.has({ machineId: r.machineId, projectId: r.projectId });
  return !ofNavi && (r.machineId === undefined || allows(caller, "read", r.machineId));
}

function readable(hub: Hub, caller: Caller, l: Loaded): Loaded {
  const navis = others(hub.db, caller);
  if (navis.size === 0 && allowsEverywhere(caller, "read")) return l;
  const keep = l.rows.map((r) => mayRead(caller, navis, r));
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

/** Filters narrow a fleet scope to a project or a machine. */
function narrow(scope: TimeScope, f: TimeFilters | undefined): TimeScope {
  if (scope.kind !== "fleet" || !f) return scope;
  if (f.projectRef) return { kind: "project", projectRef: f.projectRef };
  if (f.machineId !== undefined) return { kind: "machine", machineId: f.machineId };
  return scope;
}

function periodBreakdown(hub: Hub, caller: Caller, scope: TimeScope, since: number, until: number, role?: string) {
  const c = hub.db.conn;
  const l = readable(hub, caller, load(c, scope, since, until, role));
  const { agent, cats } = totals(c, scope, role, l, since, until);
  return { l, wall: wall(c, scope, l, since, until), agent, cats };
}

export function register(tools: Registry): void {
  tools.add("thread_window", async (hub, caller, input) => {
    requireRole(caller, "read", input.machineId);
    const r = { machineId: input.machineId, threadId: input.threadId };
    let rows;
    let focus;
    try {
      [rows, focus] = await executors(hub).views.window(r, input.itemId, input.before ?? 10, input.after ?? 10);
    } catch (error) {
      throw fromExecutor(error);
    }
    return {
      ...(focus === undefined ? {} : { focus: Math.max(0, focus) }),
      items: rows.slice(0, 51) as never,
      next: "thread_tail shows the newest entries.",
    };
  });
  tools.add("time_spans", (hub, caller, input) => {
    const now = time(hub).nowMs();
    const [since, until] = period(input.since, input.until, now);
    const limit = input.limit ?? 200;
    const c = hub.db.conn;
    check(c, caller, input.scope);
    const f = filterOf(input.scope, since, until);
    if (input.kinds) f.kinds = input.kinds;
    if (input.afterId !== undefined) f.afterId = input.afterId;
    let rows: [Row, Meta][];
    if (input.rule !== undefined) {
      const l = readable(hub, caller, load(c, input.scope, since, until));
      const { input: ri, metas } = ruleInput(c, l, since, until);
      const after = f.afterId ?? 0;
      const wanted = new Set(ruleSpans(ri, input.rule).filter((i) => i > after));
      rows = ri.rows.map((r, i): [Row, Meta] => [r, metas[i] as Meta]).filter(([r]) => wanted.has(r.id)).slice(0, limit + 1);
    } else rows = readMeta(c, f, limit + 1);
    const navis = others(hub.db, caller);
    rows = rows.filter(([r]) => mayRead(caller, navis, r));
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
  });

  tools.add("time_breakdown", (hub, caller, input) => {
    const now = time(hub).nowMs();
    const [since, until] = period(input.since, input.until, now);
    const cmp = input.compare ? period(input.compare.since, input.compare.until, now) : undefined;
    const role = input.filters?.role;
    const scope = narrow(input.scope, input.filters);
    const c = hub.db.conn;
    check(c, caller, scope);
    // The compared period first, so its spans are gone before this period's load.
    let compare: { since: string; until: string; wallMs: number; agentMs: number; byCategory: CategoryTotal[] } | undefined;
    if (cmp) {
      const p = periodBreakdown(hub, caller, scope, cmp[0], cmp[1], role);
      compare = { since: isoMs(cmp[0]), until: isoMs(cmp[1]), wallMs: Math.max(p.wall, 0), agentMs: Math.max(p.agent, 0), byCategory: p.cats };
    }
    const { l, wall: wallMs, agent, cats } = periodBreakdown(hub, caller, scope, since, until, role);
    const inPeriod = l.rows.filter((r) => r.startMs >= since && r.startMs < until);
    const ps = paths(c, scope, since, until, now, pathCache(hub));
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
      ciChecks: ciChecks(inPeriod, ps),
      humanWait: humanWait(inPeriod),
      ...(path ? { criticalPath: forOutput(path) } : {}),
      retentionDays: retentionDays(c),
      storedBytes: time(hub).storedBytes(now),
      coverage: cov,
      ...(compare ? { compare } : {}),
      next: "time_insights reads the same spans for findings; time_spans lists them.",
      ...(l.truncated ? { truncated: true } : {}),
    };
  });

  tools.add("time_insights", (hub, caller, input) => {
    const now = time(hub).nowMs();
    const [since, until] = period(input.since, input.until, now);
    const cmp = input.compare ? period(input.compare.since, input.compare.until, now) : undefined;
    const c = hub.db.conn;
    check(c, caller, input.scope);
    const cur = ruleInput(c, readable(hub, caller, load(c, input.scope, since, until)), since, until).input;
    const found = cmp
      ? compareRules(cur, ruleInput(c, readable(hub, caller, load(c, input.scope, cmp[0], cmp[1])), cmp[0], cmp[1]).input)
      : findInsights(cur);
    return { next: "time_spans with rule lists every span a finding links to.", insights: found.slice(0, MAX_INSIGHTS) };
  });
}
