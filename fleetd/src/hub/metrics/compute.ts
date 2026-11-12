// The figures, pure: stored rows + range + zone → tiles, calendar days, the
// merge list and per-repo rows. Days are calendar days in the viewer's zone and empty ones count. Medians and p90
// don't add across days, so everything is computed from rows on each read.
import type {
  ActorKind,
  MergeRoute,
  MetricsDay,
  MetricsMerge,
  MetricsRepoRow,
  MetricsTiles,
  ProjectRef,
  RequestedBasis,
  RouteCounts,
  SkipWhy,
  SparkPoint,
} from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";
import * as human from "./human.ts";
import { type MergeRow, SKIPPED, type TouchRow } from "./rows.ts";
import { addDays, dateText, dayStart, type LocalDate, localDate } from "./zone.ts";

/** The day list's bound: a range is clamped to this many calendar days in its zone. */
export const MAX_DAYS = 400;
export const SPARK_POINTS = 12;
const HOUR_MS = 3_600_000;

export const ROUTES: MergeRoute[] = ["train", "fleetd_by_hand", "outside", "direct"];
const madeByFleetd = (r: MergeRoute) => r === "train" || r === "fleetd_by_hand";

/** One calendar day of a range, cut to the range: `[start, end)`; `len` is the whole day's (23, 24 or 25 hours). */
export type Day = { date: LocalDate; start: number; end: number; len: number };

/** The `since` that keeps `[since, until)` within MAX_DAYS calendar days in `tz`. */
export function clampSince(since: number, until: number, tz: string): number {
  const last = localDate(until - 1, tz);
  return Math.max(since, dayStart(addDays(last, -(MAX_DAYS - 1)), tz));
}

/** The calendar days of `[since, until)` in `tz`, oldest first, each cut to the range. */
export function days(since: number, until: number, tz: string): Day[] {
  const out: Day[] = [];
  let date = localDate(since, tz);
  let start = dayStart(date, tz);
  while (out.length < MAX_DAYS) {
    const next = addDays(date, 1);
    const end = dayStart(next, tz);
    if (start >= until || end <= start) break;
    out.push({ date, start: Math.max(start, since), end: Math.min(end, until), len: end - start });
    date = next;
    start = end;
  }
  return out;
}

/** How many days a run of days is worth for a rate: whole days 1 each, a cut one its share, at least an hour. */
const dayWeight = (ds: Day[]) => ds.reduce((sum, d) => sum + Math.min(Math.max(d.end - d.start, HOUR_MS) / Math.max(d.len, 1), 1), 0);

export const routeOf = (row: MergeRow): MergeRoute | undefined => (ROUTES as string[]).includes(row.route) ? (row.route as MergeRoute) : undefined;

const SKIPS = new Set(["bot", "other_base", "merge_back"]);
const skipOf = (row: MergeRow): SkipWhy | undefined => (row.route === SKIPPED && row.skipWhy !== undefined && SKIPS.has(row.skipWhy) ? row.skipWhy : undefined);
const ACTORS = new Set(["human", "bot", "train", "unknown"]);
const actorOf = (s?: string): ActorKind | undefined => (s !== undefined && ACTORS.has(s) ? (s as ActorKind) : undefined);
const BASES = new Set(["source", "chat", "opened"]);
const basisOf = (s?: string): RequestedBasis | undefined => (s !== undefined && BASES.has(s) ? (s as RequestedBasis) : undefined);

const count = (n: number) => Math.max(n, 0);
const ts = (ms: number) => isoMs(ms);
const num = (v: number) => (Number.isFinite(v) ? Math.max(v, 0) : 0);

/** The middle value; the mean of the two middle ones when even (integer division, as Rust's i64). */
export function median(sorted: number[]): number | undefined {
  const n = sorted.length;
  if (n === 0) return undefined;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : Math.trunc((sorted[n / 2 - 1]! + sorted[n / 2]!) / 2);
}

/** Nearest rank: the smallest value with at least `p` of the values at or under it. */
export function percentile(sorted: number[], p: number): number | undefined {
  const n = sorted.length;
  return n > 0 ? sorted[Math.min(Math.max(Math.ceil(p * n), 1), n) - 1] : undefined;
}

/** Time from order to merged of a landed change that belongs to an order. */
export function orderMs(row: MergeRow): number | undefined {
  const route = routeOf(row);
  return route && madeByFleetd(route) && row.requestedMs !== undefined ? Math.max(row.mergedMs - row.requestedMs, 0) : undefined;
}

const prOpenMs = (row: MergeRow) => (row.prCreatedMs === undefined ? undefined : Math.max(row.mergedMs - row.prCreatedMs, 0));

const byNumber = (a: number, b: number) => a - b;

/** The four routes' figures over a set of rows. */
export class Stats {
  byRoute = [0, 0, 0, 0];
  orderMs: number[] = [];
  fromOpened = 0;
  prOpenMs: number[] = [];
  /** (additions, deletions, rows with lines) per route. */
  lines: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  static of(rows: Iterable<MergeRow>): Stats {
    const s = new Stats();
    for (const row of rows) {
      const route = routeOf(row);
      if (!route) continue;
      const i = ROUTES.indexOf(route);
      s.byRoute[i]!++;
      const ms = orderMs(row);
      if (ms !== undefined) {
        s.orderMs.push(ms);
        if (row.requestedBasis === "opened") s.fromOpened++;
      }
      const open = prOpenMs(row);
      if (open !== undefined) s.prOpenMs.push(open);
      if (row.additions !== undefined || row.deletions !== undefined) {
        const l = s.lines[i]!;
        l[0] += row.additions ?? 0;
        l[1] += row.deletions ?? 0;
        l[2] += 1;
      }
    }
    s.orderMs.sort(byNumber);
    s.prOpenMs.sort(byNumber);
    return s;
  }

  n(): number {
    return this.byRoute[0]! + this.byRoute[1]! + this.byRoute[2]! + this.byRoute[3]!;
  }
  madeByFleetd(): number {
    return this.byRoute[0]! + this.byRoute[1]!;
  }
  noOrder(): number {
    return this.byRoute[2]! + this.byRoute[3]!;
  }
  pct(): number | undefined {
    return this.n() > 0 ? (100 * this.byRoute[0]!) / this.n() : undefined;
  }
  madePct(): number | undefined {
    return this.n() > 0 ? (100 * this.madeByFleetd()) / this.n() : undefined;
  }
  counts(): RouteCounts {
    return {
      train: count(this.byRoute[0]!),
      fleetdByHand: count(this.byRoute[1]!),
      outside: count(this.byRoute[2]!),
      direct: count(this.byRoute[3]!),
    };
  }
}

function inDays(rows: MergeRow[], ds: Day[]): MergeRow[] {
  const from = ds[0]?.start ?? 0;
  const to = ds[ds.length - 1]?.end ?? 0;
  return rows.filter((r) => r.mergedMs >= from && r.mergedMs < to);
}

/** Up to SPARK_POINTS runs of whole days, as even as they divide. */
function slices(ds: Day[]): Day[][] {
  const k = Math.min(ds.length, SPARK_POINTS);
  const out: Day[][] = [];
  for (let i = 0; i < k; i++) out.push(ds.slice(Math.floor((i * ds.length) / k), Math.floor(((i + 1) * ds.length) / k)));
  return out;
}

const point = (since: number, value: number | undefined): SparkPoint =>
  value === undefined ? { since: ts(since) } : { since: ts(since), value: num(value) };

function spark(rows: MergeRow[], ds: Day[], value: (s: Stats, d: Day[]) => number | undefined): SparkPoint[] {
  return slices(ds).map((slice) => point(slice[0]!.start, value(Stats.of(inDays(rows, slice)), slice)));
}

function perDay(s: Stats, ds: Day[]): number {
  const w = dayWeight(ds);
  return w > 0 ? s.n() / w : 0;
}

/** A range's rows (landed and skipped), the person's touches around it, and its days. */
export type Period = { rows: MergeRow[]; touches: TouchRow[]; days: Day[] };

function bounds(p: Period): [number, number] {
  return [p.days[0]?.start ?? 0, p.days[p.days.length - 1]?.end ?? 0];
}

/** The spans of the touches `keep` admits, cut to the period. */
function spans(p: Period, keep: (t: TouchRow) => boolean): human.Span[] {
  const [from, to] = bounds(p);
  return human.clip(
    p.touches.filter(keep).map(human.span),
    from,
    to,
  );
}

export type HumanMinutes = { fleetd: human.Minutes; outside: human.Minutes; fleetdPieces: human.Span[] };

export function humanMinutes(p: Period): HumanMinutes {
  const fleetd = spans(p, (t) => !t.outside);
  return {
    fleetd: human.minutes(fleetd),
    outside: human.minutes(spans(p, (t) => t.outside)),
    fleetdPieces: human.sessions(fleetd, human.BRIDGE_MS),
  };
}

/** Minutes over landed changes; none when there are no changes. */
const perPr = (ms: number, prs: number) => (prs > 0 ? count(Math.trunc(ms / prs)) : undefined);

const opt = <K extends string, V>(key: K, v: V | undefined) => (v === undefined ? {} : ({ [key]: v } as { [P in K]: V }));

/** The KPI row. `previous` is the period of the same length before, when its merges were known. */
export function tiles(cur: Period, previous?: Period): MetricsTiles {
  const s = Stats.of(cur.rows);
  const prev = previous ? { s: Stats.of(previous.rows), days: previous.days } : undefined;
  const h = humanMinutes(cur);
  const prevPerPr = previous ? perPr(humanMinutes(previous).fleetd.totalMs, Stats.of(previous.rows).madeByFleetd()) : undefined;
  const prevPct = prev?.s.pct();
  return {
    merged: {
      perDay: num(perDay(s, cur.days)),
      n: count(s.n()),
      byRoute: s.counts(),
      ...opt("previousPerDay", prev ? num(perDay(prev.s, prev.days)) : undefined),
      spark: spark(cur.rows, cur.days, (x, d) => perDay(x, d)),
    },
    orderToMerged: {
      ...opt("medianMs", median(s.orderMs)),
      ...opt("p90Ms", percentile(s.orderMs, 0.9)),
      n: count(s.orderMs.length),
      fromOpened: count(s.fromOpened),
      noOrder: count(s.noOrder()),
      ...opt("prOpenMedianMs", median(s.prOpenMs)),
      ...opt("previousMedianMs", prev ? median(prev.s.orderMs) : undefined),
      spark: spark(cur.rows, cur.days, (x) => median(x.orderMs)),
    },
    human: {
      ...opt("perPrMs", perPr(h.fleetd.totalMs, s.madeByFleetd())),
      totalMs: count(h.fleetd.totalMs),
      lowMs: count(h.fleetd.lowMs),
      prs: count(s.madeByFleetd()),
      ...opt("outsidePerPrMs", perPr(h.outside.totalMs, s.noOrder())),
      outsideTotalMs: count(h.outside.totalMs),
      outsidePrs: count(s.noOrder()),
      ...opt("previousPerPrMs", prevPerPr),
      spark: slices(cur.days).map((slice) => {
        const from = slice[0]!.start;
        const to = slice[slice.length - 1]!.end;
        const ms = human.within(h.fleetdPieces, from, to);
        const prs = Stats.of(inDays(cur.rows, slice)).madeByFleetd();
        return point(from, perPr(ms, prs));
      }),
    },
    throughFleetd: {
      ...opt("pct", s.pct() === undefined ? undefined : num(s.pct()!)),
      ...opt("madeByFleetdPct", s.madePct() === undefined ? undefined : num(s.madePct()!)),
      n: count(s.n()),
      lines: ROUTES.flatMap((route, i) => {
        const l = s.lines[i]!;
        return l[2] > 0 ? [{ route, additions: count(l[0]), deletions: count(l[1]) }] : [];
      }),
      ...opt("previousPct", prevPct === undefined ? undefined : num(prevPct)),
      spark: spark(cur.rows, cur.days, (x) => x.pct()),
    },
  };
}

/** The rows by day: each day's rows, in one pass over rows sorted any way. */
function rowsByDay(rows: MergeRow[], ds: Day[]): MergeRow[][] {
  const out: MergeRow[][] = ds.map(() => []);
  for (const r of rows) {
    let lo = 0;
    let hi = ds.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const d = ds[mid]!;
      if (r.mergedMs < d.start) hi = mid - 1;
      else if (r.mergedMs >= d.end) lo = mid + 1;
      else {
        out[mid]!.push(r);
        break;
      }
    }
  }
  return out;
}

const SKIP_ORDER: SkipWhy[] = ["bot", "other_base", "merge_back"];

/** Every day of the period, empty ones too: merges by route, merges not counted by why, the minutes by source. */
export function dayList(p: Period): MetricsDay[] {
  const pieces = human.sessions(spans(p, () => true), human.BRIDGE_MS);
  const bySource = new Map(human.HUMAN_SOURCES.map((s) => [s, pieces.filter((x) => x.source === s)]));
  const perDayRows = rowsByDay(p.rows, p.days);
  return p.days.map((d, i) => {
    const rows = perDayRows[i]!;
    const skipped = new Map<SkipWhy, number>();
    for (const r of rows) {
      const why = skipOf(r);
      if (why !== undefined) skipped.set(why, (skipped.get(why) ?? 0) + 1);
    }
    const dayTouches = p.touches.filter((t) => t.atMs >= d.start && t.atMs < d.end);
    return {
      day: dateText(d.date),
      merged: Stats.of(rows).counts(),
      notCounted: SKIP_ORDER.filter((w) => skipped.has(w)).map((why) => ({ why, n: count(skipped.get(why)!) })),
      human: human.HUMAN_SOURCES.flatMap((source) => {
        const ms = human.within(bySource.get(source)!, d.start, d.end);
        const touches = dayTouches.filter((t) => human.span(t).source === source).length;
        return ms > 0 || touches > 0 ? [{ source, ms: count(ms), touches: count(touches) }] : [];
      }),
    };
  });
}

const MACHINE_ID = /^[a-z0-9-]{1,32}$/;
const projectRef = (m: string, p: string): ProjectRef | undefined =>
  MACHINE_ID.test(m) && p !== "" ? ({ machineId: m, projectId: p } as ProjectRef) : undefined;

/** The person's touches on each PR: "repo#pr" → touches. */
export type PrTouches = Map<string, number>;

export function prTouches(touches: TouchRow[]): PrTouches {
  const out: PrTouches = new Map();
  for (const t of touches) {
    if (t.repo !== undefined && t.prNumber !== undefined) {
      const key = `${t.repo}#${t.prNumber}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

/** A remote repository as `projects::short_remote` writes it: host, then path, no scheme, user or `.git`. */
export function isRemoteRepo(repo: string): boolean {
  const slash = repo.indexOf("/");
  if (slash < 0) return false;
  const host = repo.slice(0, slash);
  const path = repo.slice(slash + 1);
  return (
    repo.length <= 300 &&
    host !== "" &&
    path !== "" &&
    !path.endsWith("/") &&
    !repo.includes("://") &&
    !repo.includes("//") &&
    !repo.includes("@") &&
    !/[\s\p{Cc}]/u.test(repo)
  );
}

/** At most `max` UTF-16 units, never inside a character (node/util.rs head_utf16). */
export function headUtf16(text: string, max: number): string {
  let units = 0;
  let out = "";
  for (const ch of text) {
    units += ch.length;
    if (units > max) return out;
    out += ch;
  }
  return text;
}

/** A Line<1, max>: one line, 1..=max UTF-16 units. */
export const line = (s: string | undefined, max: number) =>
  s !== undefined && s.length >= 1 && s.length <= max && !/[\r\n]/.test(s) ? s : undefined;

const positive = (n?: number) => (n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined);
const matching = (re: RegExp, s?: string) => (s !== undefined && re.test(s) ? s : undefined);

/** One landed change for the list; undefined for a skipped merge or a row this build can't name. */
export function mergeItem(row: MergeRow, touches: PrTouches): MetricsMerge | undefined {
  const route = routeOf(row);
  if (!route || !isRemoteRepo(row.repo)) return undefined;
  const made = madeByFleetd(route);
  const ref = row.machineId !== undefined && row.projectId !== undefined ? projectRef(row.machineId, row.projectId) : undefined;
  const url = row.url !== undefined && row.url.length >= 1 && row.url.length <= 500 ? row.url : undefined;
  const item = {
    repo: row.repo,
    ...opt("prNumber", positive(row.prNumber)),
    ...opt("sha", matching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, row.mergedSha)),
    ...opt("title", row.title === undefined ? undefined : line(headUtf16(row.title, 200), 200)),
    ...opt("url", url),
    route,
    mergedAt: ts(row.mergedMs),
    ...opt("projectRef", ref),
    ...opt("workstreamId", matching(/^W[1-9][0-9]*$/, row.workstreamId)),
    ...opt("taskId", matching(/^T[1-9][0-9]*$/, row.taskId)),
    ...opt("changeId", matching(/^X[1-9][0-9]*$/, row.changeId)),
    ...opt("batchPr", positive(row.batchPr)),
    ...opt("requestedAt", made && row.requestedMs !== undefined ? ts(row.requestedMs) : undefined),
    ...opt("requestedBasis", made ? basisOf(row.requestedBasis) : undefined),
    ...opt("firstPrAt", row.firstPrMs === undefined ? undefined : ts(row.firstPrMs)),
    ...opt("reviewPassedAt", row.reviewPassedMs === undefined ? undefined : ts(row.reviewPassedMs)),
    ...opt("orderToMergedMs", orderMs(row)),
    ...opt("prCreatedAt", row.prCreatedMs === undefined ? undefined : ts(row.prCreatedMs)),
    ...opt("prOpenToMergedMs", prOpenMs(row)),
    ...opt("author", actorOf(row.authorKind)),
    ...opt("mergedBy", actorOf(row.mergedByKind)),
    ...opt("additions", row.additions === undefined ? undefined : count(row.additions)),
    ...opt("deletions", row.deletions === undefined ? undefined : count(row.deletions)),
    touches: count(row.prNumber === undefined ? 0 : (touches.get(`${row.repo}#${row.prNumber}`) ?? 0)),
    ...opt("seenClaim", line(row.seenClaim, 120)),
  };
  return item as MetricsMerge;
}

/** Projects by repo: each repo with its "machine\0project" pairs, in order. */
export type Projects = Map<string, Set<string>>;
export const pairKey = (m: string, p: string) => `${m}\u0000${p}`;
export const pairOf = (key: string): [string, string] => key.split("\u0000") as [string, string];

/** One row per repo, every repo in `projects` included even with no merges, for the cross-fleet table. */
export function repoRows(p: Period, projects: Projects): MetricsRepoRow[] {
  const byRepo = new Map<string, MergeRow[]>();
  for (const r of p.rows) {
    let list = byRepo.get(r.repo);
    if (!list) byRepo.set(r.repo, (list = []));
    list.push(r);
  }
  const out: MetricsRepoRow[] = [];
  for (const repo of [...projects.keys()].sort()) {
    const refs = projects.get(repo)!;
    if (!isRemoteRepo(repo)) continue;
    const rows = byRepo.get(repo) ?? [];
    const s = Stats.of(rows);
    // A touch on the repo, or one with no repo in a project that has it checked out.
    const own = spans(p, (t) =>
      !t.outside &&
      (t.repo !== undefined
        ? t.repo === repo
        : t.machineId !== undefined && t.projectId !== undefined && refs.has(pairKey(t.machineId, t.projectId))),
    );
    out.push({
      repo,
      projects: [...refs]
        .sort()
        .flatMap((k) => {
          const ref = projectRef(...pairOf(k));
          return ref ? [ref] : [];
        })
        .slice(0, 20),
      mergedPerDay: num(perDay(s, p.days)),
      n: count(s.n()),
      ...opt("orderToMergedMedianMs", median(s.orderMs)),
      ...opt("humanPerPrMs", perPr(human.minutes(own).totalMs, s.madeByFleetd())),
      ...opt("throughFleetdPct", s.pct() === undefined ? undefined : num(s.pct()!)),
      spark: spark(rows, p.days, (x, d) => perDay(x, d)),
    });
  }
  return out;
}
