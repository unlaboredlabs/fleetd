// The Factory's words, figures and chart geometry, pure so they are tested on their own. Every number is the hub's
// (metrics_get); this lays them out: route and source names in their fixed order, the tiles' values and deltas, the
// days folded into columns, stacks with their surface gaps, the log axis of order to merged, and the merge list's
// sort and copy.
import type {
  HumanSource,
  KnownMergeRoute,
  MergeRoute,
  MetricsDay,
  MetricsMerge,
  RepoCoverage,
  RouteCounts,
  SparkPoint,
} from "../../../shared/contracts";
import { fmtDur } from "../time/format.ts";

// ---- names, in the fixed order every chart draws them bottom up ---------------------------------------------------

export const ROUTES = ["train", "fleetd_by_hand", "outside", "direct"] as const satisfies readonly KnownMergeRoute[];
export type Route = (typeof ROUTES)[number];

export const ROUTE_LABEL: Record<Route, string> = {
  train: "Through fleetd",
  fleetd_by_hand: "Made by fleetd, merged by you",
  outside: "Merged outside fleetd",
  direct: "Pushed straight",
};

/** Beside the plot, where the full name doesn't fit; the legend has the full one. */
export const ROUTE_SHORT: Record<Route, string> = {
  train: "Through fleetd",
  fleetd_by_hand: "Merged by you",
  outside: "Outside fleetd",
  direct: "Pushed straight",
};

/** Each route's series slot (Factory.module.css s1…s4), the same on every chart and never re-cycled. */
export const ROUTE_SLOT: Record<Route, 1 | 2 | 3 | 4> = { train: 1, fleetd_by_hand: 2, outside: 3, direct: 4 };

/** The route's field in the day counts. */
export const ROUTE_FIELD: Record<Route, keyof RouteCounts> = {
  train: "train",
  fleetd_by_hand: "fleetdByHand",
  outside: "outside",
  direct: "direct",
};

/** A route this app knows; a newer hub's route is undefined (counted nowhere it can't be named). */
export const knownRoute = (r: MergeRoute): Route | undefined => ROUTES.find((x) => x === r);

export const SOURCES = ["chat", "reviews", "app", "sessions", "other"] as const satisfies readonly HumanSource[];

export const SOURCE_LABEL: Record<HumanSource, string> = {
  chat: "Chat and approvals",
  reviews: "Reviews",
  app: "The app",
  sessions: "Your sessions",
  other: "Other",
};

export const SOURCE_SLOT: Record<HumanSource, 1 | 2 | 3 | 4 | 5> = { chat: 1, reviews: 2, app: 3, sessions: 4, other: 5 };

/** Its minutes come from a floor per act, not from watching: git hosts keep when a review was sent, not how long. */
export const ESTIMATED: ReadonlySet<HumanSource> = new Set(["reviews"]);

const SKIP_WORD: Record<string, [string, string]> = {
  bot: ["bot PR", "bot PRs"],
  other_base: ["PR into another branch", "PRs into other branches"],
  merge_back: ["merge-back", "merge-backs"],
};

/** "2 bot PRs not counted". */
export const skipLine = (why: string, n: number): string => {
  const [one, many] = SKIP_WORD[why] ?? ["other merge", "other merges"];
  return `${n} ${n === 1 ? one : many} not counted`;
};

// ---- figures ------------------------------------------------------------------------------------------------------

/** "4.3", "12", "1.3K": a rate or a count, compact. */
export const fmtCount = (v: number): string => {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 10_000) return `${(v / 1000).toFixed(0)}K`;
  if (a >= 1_000) return `${(v / 1000).toFixed(1).replace(/\.0$/u, "")}K`;
  if (a >= 10 || Number.isInteger(v)) return String(Math.round(v));
  return v.toFixed(1);
};

/** "64%". */
export const fmtPct = (v: number): string => `${Math.round(v)}%`;

/** "3h10m", "≈ 6m" for the person's minutes, which are always an estimate. */
export const fmtMs = (ms: number): string => fmtDur(ms);
export const fmtAbout = (ms: number): string => `≈ ${fmtDur(ms)}`;

export const plural = (n: number, one: string, many = `${one}s`): string => `${fmtCount(n)} ${n === 1 ? one : many}`;

export type Better = "up" | "down";

export interface Delta {
  readonly text: string;
  /** Good, bad or no change, by the direction and which way is better: never colour alone (the arrow and sign say it). */
  readonly tone: "good" | "bad" | "flat";
}

/**
 * The signed change against the previous period: "↑ 0.6", "↓ 40m", "↑ 12 pts". Absent when either side is
 * unknown: a first period has nothing to beat.
 */
export const delta = (now: number | undefined, before: number | undefined, better: Better, unit: "count" | "ms" | "pct"): Delta | undefined => {
  if (now === undefined || before === undefined) return undefined;
  const d = now - before;
  const size = unit === "ms" ? fmtDur(Math.abs(d)) : unit === "pct" ? `${Math.round(Math.abs(d))} ${Math.round(Math.abs(d)) === 1 ? "pt" : "pts"}` : fmtCount(Math.abs(d));
  const still = unit === "ms" ? Math.abs(d) < 60_000 : unit === "pct" ? Math.abs(d) < 0.5 : Math.abs(d) < 0.05;
  if (still) return { text: "→ no change", tone: "flat" };
  const up = d > 0;
  return { text: `${up ? "↑" : "↓"} ${size}`, tone: up === (better === "up") ? "good" : "bad" };
};

/** A tile's 12 points as numbers, a gap where a slice had nothing to measure. */
export const sparkValues = (spark: readonly SparkPoint[]): (number | undefined)[] => spark.map((p) => p.value);

/** The sparkline's path in a w×h box, broken across gaps; the last point is the current period. */
export const sparkPath = (values: readonly (number | undefined)[], w: number, h: number): { d: string; last?: { x: number; y: number } } => {
  const known = values.filter((v): v is number => v !== undefined);
  if (known.length === 0) return { d: "" };
  const max = Math.max(...known);
  const min = Math.min(0, ...known);
  const span = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  let d = "";
  let pen = false;
  let last: { x: number; y: number } | undefined;
  values.forEach((v, i) => {
    if (v === undefined) {
      pen = false;
      return;
    }
    const x = values.length > 1 ? i * step : w / 2;
    // A 2 px line stays inside the box at its extremes.
    const y = 1 + (h - 2) * (1 - (v - min) / span);
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
    last = { x, y };
  });
  return last === undefined ? { d } : { d, last };
};

// ---- days → columns -----------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Oct 12" for a "2026-10-12". */
export const dayLabel = (day: string): string => {
  const [, m, d] = day.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? ""} ${d ?? ""}`;
};

const two = (n: number) => String(n).padStart(2, "0");

/** The viewer's calendar day of a stamp, "2026-10-12": the hub cut its days in the same zone. */
export const localDay = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

/**
 * Where a stamp falls on the day axis, in day slots from the range's first day: its day's index plus how far into
 * that day it is. Equal slots per calendar day, as the columns are, so a dot sits over its day's column even when the
 * range ends partway through today or a day is 23 or 25 hours long. Before the range, 0; after it, its end.
 */
export const dayX = (iso: string, index: ReadonlyMap<string, number>): number => {
  const at = new Date(iso);
  const day = localDay(iso);
  const i = index.get(day);
  if (i === undefined) {
    const first = [...index.keys()][0];
    return first !== undefined && day < first ? 0 : index.size;
  }
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const end = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).getTime();
  return i + (at.getTime() - start) / (end - start);
};

export interface Column {
  /** Its first and last calendar day. */
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly label: string;
  readonly merged: RouteCounts;
  /** Merges not counted, by why. */
  readonly notCounted: ReadonlyMap<string, number>;
  readonly human: ReadonlyMap<HumanSource, { readonly ms: number; readonly touches: number }>;
}

/** Past this many days a column is a week (dataviz: ~30 columns at most before they read as noise). */
export const WEEKLY_OVER = 31;

const zero = (): RouteCounts => ({ train: 0, fleetdByHand: 0, outside: 0, direct: 0 });

/** Days as columns: one each, or one per 7 days (from the first day) on a long range. */
export const columnsOf = (days: readonly MetricsDay[]): Column[] => {
  const size = days.length > WEEKLY_OVER ? 7 : 1;
  const out: Column[] = [];
  for (let i = 0; i < days.length; i += size) {
    const chunk = days.slice(i, i + size);
    const first = chunk[0];
    const last = chunk.at(-1);
    if (first === undefined || last === undefined) continue;
    const merged = zero();
    const notCounted = new Map<string, number>();
    const human = new Map<HumanSource, { ms: number; touches: number }>();
    for (const d of chunk) {
      for (const r of ROUTES) merged[ROUTE_FIELD[r]] += d.merged[ROUTE_FIELD[r]];
      for (const s of d.notCounted) notCounted.set(s.why, (notCounted.get(s.why) ?? 0) + s.n);
      for (const h of d.human) {
        const was = human.get(h.source) ?? { ms: 0, touches: 0 };
        human.set(h.source, { ms: was.ms + h.ms, touches: was.touches + h.touches });
      }
    }
    out.push({
      from: first.day,
      to: last.day,
      days: chunk.length,
      label: size === 1 ? dayLabel(first.day) : `${dayLabel(first.day)} to ${dayLabel(last.day)}`,
      merged,
      notCounted,
      human,
    });
  }
  return out;
};

export const routeTotal = (c: RouteCounts): number => c.train + c.fleetdByHand + c.outside + c.direct;
export const humanTotal = (c: Column): number => [...c.human.values()].reduce((a, h) => a + h.ms, 0);

/** The ticks of a count or a duration axis from 0: 1, 2 or 5 × 10ⁿ apart, 3 to 5 of them, the last at or over max. */
export const niceTicks = (max: number, unit = 1): number[] => {
  const top = Math.max(max, unit);
  const raw = top / 4;
  const mag = 10 ** Math.floor(Math.log10(raw / unit));
  // Never finer than the unit: a count axis has no half merges.
  const step = Math.max(unit, [1, 2, 5, 10].map((k) => k * mag * unit).find((s) => s >= raw) ?? 10 * mag * unit);
  const ticks: number[] = [];
  for (let t = 0; t < top + step - 1e-9; t += step) ticks.push(t);
  return ticks;
};

/** Minute ticks for the minutes chart: whole minutes, hours past three. */
export const minuteTicks = (maxMs: number): number[] => (maxMs > 3 * 3_600_000 ? niceTicks(maxMs, 3_600_000) : niceTicks(maxMs, 60_000));

export interface Segment<K> {
  readonly key: K;
  readonly value: number;
  /** Top edge and height in px, y down. */
  readonly y: number;
  readonly h: number;
  /** The stack's top segment: the only one with rounded corners. */
  readonly top: boolean;
}

/** The surface gap between touching fills (dataviz: 2 px, the same everywhere). */
export const GAP = 2;

/**
 * One column's stack from the baseline up, in the given order: empty series take no room, and each segment above
 * another gives up a 2 px gap at its foot. A sliver keeps 1 px so a count of one never vanishes.
 */
export const stack = <K>(parts: readonly (readonly [K, number])[], px: (v: number) => number, baseline: number): Segment<K>[] => {
  const shown = parts.filter(([, v]) => v > 0);
  const out: Segment<K>[] = [];
  let at = 0;
  shown.forEach(([key, value], i) => {
    const y0 = baseline - px(at);
    at += value;
    const y1 = baseline - px(at);
    const foot = i === 0 ? 0 : GAP;
    const h = Math.max(1, y0 - y1 - foot);
    out.push({ key, value, y: y0 - foot - h, h, top: i === shown.length - 1 });
  });
  return out;
};

/** A column's path: square at the foot, 4 px rounded corners at the top when it is the top segment. */
export const columnPath = (x: number, y: number, w: number, h: number, round: boolean): string => {
  const r = round ? Math.min(4, w / 2, h) : 0;
  if (r <= 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
};

// ---- order to merged: a log time axis -------------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The log axis's named ticks; the axis shows those inside its domain. */
export const LOG_TICKS: readonly (readonly [number, string])[] = [
  [MIN, "1m"],
  [10 * MIN, "10m"],
  [HOUR, "1h"],
  [6 * HOUR, "6h"],
  [DAY, "1d"],
  [7 * DAY, "1w"],
  [28 * DAY, "4w"],
];

/** The y domain: 10 minutes to a day at least, widened to the data. */
export const logDomain = (values: readonly number[]): [number, number] => {
  const lo = Math.min(10 * MIN, ...values.map((v) => Math.max(MIN, v)));
  const hi = Math.max(DAY, ...values);
  return [lo, hi];
};

export const logScale = ([lo, hi]: [number, number], top: number, bottom: number) => {
  const a = Math.log(lo);
  const b = Math.log(hi);
  return (v: number): number => bottom - ((Math.log(Math.min(hi, Math.max(lo, v))) - a) / (b - a || 1)) * (bottom - top);
};

/** A landed change's stages, from what the hub stamped: requested → PR opened → review passed → merged. */
export const stages = (m: MetricsMerge): string[] => {
  const at = (s: string | undefined) => (s === undefined ? undefined : Date.parse(s));
  const points: [string, number | undefined][] = [
    ["requested", at(m.requestedAt)],
    ["PR opened", at(m.firstPrAt ?? m.prCreatedAt)],
    ["review passed", at(m.reviewPassedAt)],
    ["merged", at(m.mergedAt)],
  ];
  const known = points.filter((p): p is [string, number] => p[1] !== undefined);
  const out: string[] = [];
  for (let i = 1; i < known.length; i++) {
    const [from, a] = known[i - 1] ?? ["", 0];
    const [to, b] = known[i] ?? ["", 0];
    out.push(`${from} → ${to}: ${fmtDur(Math.max(0, b - a))}`);
  }
  return out;
};

// ---- the merge list -----------------------------------------------------------------------------------------------

/** "acme/web" on GitHub (the host most repos share), "team/api on gitlab.example.com" elsewhere. */
export const repoName = (repo: string): string => {
  const at = repo.indexOf("/");
  const [host, path] = at === -1 ? ["", repo] : [repo.slice(0, at), repo.slice(at + 1)];
  return host === "github.com" || host === "" ? path : `${path} on ${host}`;
};

/** "acme/web#249", or "pushed to main" for a commit with no PR. */
export const mergeName = (m: MetricsMerge, coverage: readonly RepoCoverage[]): string => {
  if (m.prNumber !== undefined) return `${repoName(m.repo)}#${m.prNumber}`;
  const branch = coverage.find((c) => c.repo === m.repo)?.defaultBranch;
  return `${repoName(m.repo)}, pushed to ${branch ?? "the default branch"}`;
};

export const SORTS = ["date", "change", "route", "order", "toMerged", "prOpen", "lines", "touches"] as const;
export type SortKey = (typeof SORTS)[number];
export interface Sort {
  readonly key: SortKey;
  readonly desc: boolean;
}
export const DEFAULT_SORT: Sort = { key: "date", desc: true };

const sortValue = (m: MetricsMerge, key: SortKey): number | string | undefined => {
  switch (key) {
    case "date":
      return m.mergedAt;
    case "change":
      return `${m.repo}#${String(m.prNumber ?? 0).padStart(10, "0")}`;
    case "route": {
      const r = knownRoute(m.route);
      return r === undefined ? ROUTES.length : ROUTES.indexOf(r);
    }
    case "order":
      return m.workstreamId === undefined ? undefined : Number(m.workstreamId.replace(/\D/gu, "")) || m.workstreamId;
    case "toMerged":
      return m.orderToMergedMs;
    case "prOpen":
      return m.prOpenToMergedMs;
    case "lines":
      return m.additions === undefined && m.deletions === undefined ? undefined : (m.additions ?? 0) + (m.deletions ?? 0);
    case "touches":
      return m.touches;
  }
};

/** Sorted by a column; rows with no value for it go last either way, then newest first. */
export const sortMerges = (merges: readonly MetricsMerge[], sort: Sort): MetricsMerge[] =>
  merges.toSorted((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === undefined || y === undefined) {
      if (x !== y) return x === undefined ? 1 : -1;
    } else if (x !== y) {
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return sort.desc ? -c : c;
    }
    return b.mergedAt.localeCompare(a.mergedAt);
  });

/** The merges within [from, to] (calendar days), for a click on a column. */
export const inDays = (merges: readonly MetricsMerge[], from: string, to: string): MetricsMerge[] =>
  merges.filter((m) => {
    const d = localDay(m.mergedAt);
    return d >= from && d <= to;
  });

/** "#249, #251, #252, #260, #261 +3 more", for a column's hover. */
export const prList = (merges: readonly MetricsMerge[]): string | undefined => {
  const named = merges.map((m) => (m.prNumber === undefined ? "a push" : `#${m.prNumber}`));
  if (named.length === 0) return undefined;
  const head = named.slice(0, 5).join(", ");
  return named.length > 5 ? `${head} +${named.length - 5} more` : head;
};

/**
 * One cell. Titles and repos come from outside fleetd, so text that a spreadsheet would read as a formula (=, +, -,
 * @, a tab or a carriage return first) gets a leading ' (OWASP's CSV injection advice); numbers stay numbers.
 */
export const csvCell = (v: string | number | undefined): string => {
  if (v === undefined) return "";
  const s = typeof v === "number" ? String(v) : /^[=+\-@\t\r]/u.test(v) ? `'${v}` : v;
  return /[",\n\r]/u.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** The list as CSV, every column the screen has, durations in minutes. */
export const mergesCsv = (merges: readonly MetricsMerge[]): string => {
  const mins = (ms: number | undefined) => (ms === undefined ? undefined : Math.round(ms / MIN));
  const rows: (string | number | undefined)[][] = [
    ["merged_at", "repo", "pr", "title", "route", "order", "order_to_merged_min", "pr_open_to_merged_min", "additions", "deletions", "touches"],
    ...merges.map((m) => [
      m.mergedAt,
      m.repo,
      m.prNumber,
      m.title,
      m.route,
      m.workstreamId,
      mins(m.orderToMergedMs),
      mins(m.prOpenToMergedMs),
      m.additions,
      m.deletions,
      m.touches,
    ]),
  ];
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
};
