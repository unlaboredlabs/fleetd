// What a time read works out from spans it already has, without the database (reads.ts loads them): the bounds and
// filter of a scope, agent time per category and profile, top commands, repeats, CI checks, human waits, and a span
// as the tools show it.
import type {
  Category,
  CategoryTotal,
  CiCheckStat,
  CommandStat,
  CriticalPath,
  HumanWait,
  ProfileTotal,
  RepeatStat,
  Span,
  SpanKind,
  TimeFilters,
  TimeScope,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { parseMs } from "../store/time.ts";
import { CATEGORIES, categoryOf, kindCode } from "./kinds.ts";
import { dur, isDetail, type Row } from "./model.ts";
import { DAY, type Filter, headUtf16, type Meta } from "./spans.ts";

/** Spans loaded per period for a breakdown or the rules. */
export const MAX_ROWS = 200_000;
/** How long a running order's `change.ci` segments the hub worked out stand in for its path (upkeep.ts). */
export const LIVE_CI_MS = 60_000;
/** Spans of one order read for its critical path. */
export const PATH_ROWS = 100_000;
/** Running orders whose path a read computes, newest first. */
export const RUNNING_PATHS = 20;
export const PROFILES_MAX = 50;

export const invalid = (message: string, fix?: string) => new ToolError("invalid", message, fix);

export function msOf(t: string): number {
  const ms = parseMs(t);
  if (ms === undefined) throw invalid(`${t} is not an ISO time`);
  return ms;
}

export function filterOf(scope: TimeScope, since: number, until: number): Filter {
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

export type Loaded = { rows: Row[]; metas: Meta[]; weights: number[]; truncated: boolean };

/** The roll-up row a scope adds to, if it has one. */
export function rollupScope(scope: TimeScope): [string, string] | undefined {
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

export const mod = (a: number, b: number) => ((a % b) + b) % b;

/** The whole UTC days inside the period, which the daily roll-ups give a scope's totals for; none for a role filter. */
export function wholeDays(scope: TimeScope, role: string | undefined, since: number, until: number): [number, number] | undefined {
  const fromDay = Math.floor(since / DAY) + (mod(since, DAY) !== 0 ? 1 : 0);
  const toDay = Math.floor(until / DAY);
  return rollupScope(scope) && role === undefined && toDay > fromDay ? [fromDay * DAY, toDay * DAY] : undefined;
}

export type Add = (cat: Category, kind: SpanKind, ms: number, n: number) => void;

export function p50(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] as number;
}

/** Each profile's agent time, model time and output tokens over the period's spans, most agent time first. */
export function byProfile(l: Loaded, since: number, until: number): ProfileTotal[] {
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
  return profilesOut(sums);
}

export function profilesOut(sums: Map<string, [number, number, number]>): ProfileTotal[] {
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

export function topCommands(rows: Row[]): CommandStat[] {
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

export function repeated(rows: Row[]): RepeatStat[] {
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

/** An order's `change.ci` segments on its critical path, as `[start, end]`. */
export type CiSegments = [number, number][];

export const ciOf = (p: CriticalPath): CiSegments => p.segments.filter((s) => s.kind === "change.ci").map((s) => [s.startMs, s.endMs]);

export function ciChecks(rows: Row[], paths: [string, CiSegments][]): CiCheckStat[] {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    if (r.kind !== "ci.check") continue;
    const name = r.extra.check ?? "";
    const list = by.get(name) ?? [];
    list.push(dur(r));
    by.set(name, list);
  }
  // The excess of the last check over the one before, on `change.ci` segments of the paths. Each order's checks are
  // gathered once: filtering every row for every segment took most of a fleet breakdown.
  const ofOrder = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.kind !== "ci.check" || r.workstreamId === undefined) continue;
    const list = ofOrder.get(r.workstreamId) ?? [];
    list.push(r);
    ofOrder.set(r.workstreamId, list);
  }
  const excess = new Map<string, number>();
  for (const [w, segs] of paths) {
    const own = ofOrder.get(w) ?? [];
    for (const [segStart, segEnd] of segs) {
      const checks = own.filter((r) => r.startMs < segEnd && r.endMs > segStart).sort((a, b) => a.endMs - b.endMs);
      const last = checks[checks.length - 1];
      if (!last) continue;
      const before = checks.length >= 2 ? (checks[checks.length - 2] as Row).endMs : segStart;
      const e = Math.min(last.endMs, segEnd) - Math.max(before, segStart);
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

export function humanWait(rows: Row[]): HumanWait {
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

/** The union of the intervals, in ms. */
export function unionMs(spans: [number, number][]): number {
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

/** A node span's item id in its thread: a tool call's `tool_use_id`, a message's id, a prompt's permission item. */
export function itemId(srcKey: string, kind: SpanKind): string | undefined {
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

export function toSpan(r: Row, m: Meta): Span {
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

export function period(since: string, until: string | undefined, now: number): [number, number] {
  const s = msOf(since);
  const u = until === undefined ? now : msOf(until);
  if (u <= s) throw invalid("until must be after since", "Give since earlier than until.");
  return [s, u];
}

/** Filters narrow a fleet scope to a project or a machine. */
export function narrow(scope: TimeScope, f: TimeFilters | undefined): TimeScope {
  if (scope.kind !== "fleet" || !f) return scope;
  if (f.projectRef) return { kind: "project", projectRef: f.projectRef };
  if (f.machineId !== undefined) return { kind: "machine", machineId: f.machineId };
  return scope;
}

/** Agent time per category and kind, as `add` is given each span's or day's: `out` sums it, categories in order. */
export function totalsFold(): { add: Add; out: () => { agent: number; cats: CategoryTotal[] } } {
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
  const out = () => {
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
  };
  return { add, out };
}
