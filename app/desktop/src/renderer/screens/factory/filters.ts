// The Factory's one filter row and what it asks the hub (metrics_get): a range of calendar days ending now (7, 30 or
// 90, or custom), the project (in the route, so a Status row can link to it), and compare with the period before.
// The custom range's fields read and write like the time inspector's (time/filters.ts).
import type { MetricsGetInput } from "../../../shared/contracts";
import type { ProjectKey } from "../shell/routes";
import { isoOf } from "../time/filters";

export const RANGES = ["week", "month", "quarter", "custom"] as const;
export type Range = (typeof RANGES)[number];

export const RANGE_LABEL: Record<Range, string> = {
  week: "Last 7 days",
  month: "Last 30 days",
  quarter: "Last 90 days",
  custom: "Custom",
};

const RANGE_DAYS: Record<Exclude<Range, "custom">, number> = { week: 7, month: 30, quarter: 90 };

export interface Filters {
  readonly range: Range;
  /** The custom range, hub ms: since, and until (absent: now). */
  readonly custom?: { readonly since: number; readonly until?: number };
  readonly compare: boolean;
}

export const DEFAULT_FILTERS: Filters = { range: "month", compare: false };

const DAY = 86_400_000;

/** Local midnight `days - 1` days before today: "last 7 days" is today and the six before it, whole days. */
const daysBack = (days: number, nowMs: number): number => {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
};

/** [since, until] in hub ms; until undefined means now. */
export const period = (f: Filters, nowMs: number): [number, number | undefined] => {
  if (f.range !== "custom") return [daysBack(RANGE_DAYS[f.range], nowMs), undefined];
  return f.custom === undefined ? [daysBack(30, nowMs), undefined] : [f.custom.since, f.custom.until];
};

/** The viewer's zone, as the hub cuts days in it; UTC when the runtime doesn't say. */
export const viewerZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const queryOf = (f: Filters, project: ProjectKey | null, nowMs: number, tz: string = viewerZone()): MetricsGetInput => {
  const [since, until] = period(f, nowMs);
  return {
    since: isoOf(since),
    ...(until === undefined ? {} : { until: isoOf(until) }),
    tz,
    compare: f.compare,
    ...(project === null ? {} : { projectRef: { machineId: project.machineId, projectId: project.projectId } }),
  };
};

/** A count's words for the range: "in 30 days", "in this range". */
export const inRange = (f: Filters): string => (f.range === "custom" ? "in this range" : `in ${RANGE_DAYS[f.range]} days`);

/** The previous period's name, for a tile's delta: "vs the 30 days before". */
export const previousWords = (f: Filters, nowMs: number): string => {
  // A preset is its whole days, today's part included; a custom range, the days it touches.
  const [since, until] = period(f, nowMs);
  const days = f.range === "custom" ? Math.max(1, Math.ceil(((until ?? nowMs) - since) / DAY)) : RANGE_DAYS[f.range];
  return `vs the ${days === 1 ? "day" : `${days} days`} before`;
};

const STORAGE_KEY = "fleetd.factory.filters";

const isRange = (v: unknown): v is Range => typeof v === "string" && (RANGES as readonly string[]).includes(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Reads saved filters, dropping anything an older or newer app wrote that this one doesn't understand. */
export const decodeFilters = (raw: unknown): Filters => {
  if (typeof raw !== "object" || raw === null) return DEFAULT_FILTERS;
  const o = raw as Record<string, unknown>;
  const c = typeof o["custom"] === "object" && o["custom"] !== null ? (o["custom"] as Record<string, unknown>) : undefined;
  const since = num(c?.["since"]);
  const until = num(c?.["until"]);
  const range = isRange(o["range"]) ? o["range"] : DEFAULT_FILTERS.range;
  // A custom range with no dates is not one.
  if (range === "custom" && since === undefined) return { ...DEFAULT_FILTERS, compare: o["compare"] === true };
  return {
    range,
    compare: o["compare"] === true,
    ...(since === undefined ? {} : { custom: { since, ...(until === undefined ? {} : { until }) } }),
  };
};

export const loadFilters = (): Filters => {
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    return text === null ? DEFAULT_FILTERS : decodeFilters(JSON.parse(text));
  } catch {
    return DEFAULT_FILTERS;
  }
};

export const saveFilters = (f: Filters): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(f));
  } catch {
    // Storage full or disabled: the filters still apply for this session.
  }
};
