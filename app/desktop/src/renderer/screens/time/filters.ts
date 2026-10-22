// The filter bar's state and what it asks the hub. On an order the range is the order's own, so range and compare
// step aside; elsewhere the scope narrows from the fleet to a machine to a project.
import type { AgentRole, Period, TimeBreakdownInput, TimeInsightsInput, TimeScope, TimeSpansInput } from "./types";

export const RANGES = ["hour", "today", "week", "month", "custom"] as const;
export type Range = (typeof RANGES)[number];

export const RANGE_LABEL: Record<Range, string> = {
  hour: "Last hour",
  today: "Today",
  week: "Last 7 days",
  month: "Last 30 days",
  custom: "Custom",
};

export interface Filters {
  readonly range: Range;
  /** The custom range, hub ms: since, and until (absent: now). */
  readonly custom?: { readonly since: number; readonly until?: number };
  // Clearable: a cleared filter is set to undefined, which saving drops.
  readonly project?: { readonly machineId: string; readonly projectId: string } | undefined;
  readonly machine?: string | undefined;
  readonly role?: AgentRole | undefined;
  readonly compare: boolean;
}

export const DEFAULT_FILTERS: Filters = { range: "week", compare: false };

const DAY = 86_400_000;
const ROLES: readonly AgentRole[] = ["lead", "implementer", "reader", "reviewer", "verifier", "qa"];
export { ROLES };

/** [since, until] in hub ms for a range ending now; until undefined means now. */
export const period = (f: Pick<Filters, "range" | "custom">, nowMs: number): [number, number | undefined] => {
  switch (f.range) {
    case "hour":
      return [nowMs - 3_600_000, undefined];
    case "today": {
      // Since midnight where the viewer is.
      const d = new Date(nowMs);
      return [new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), undefined];
    }
    case "week":
      return [nowMs - 7 * DAY, undefined];
    case "month":
      return [nowMs - 30 * DAY, undefined];
    case "custom":
      return f.custom === undefined ? [nowMs - 7 * DAY, undefined] : [f.custom.since, f.custom.until];
  }
};

/** "2026-10-12" or "2026-10-12 09:30", in the viewer's zone → hub ms. Anything else is undefined. */
export const parseWhen = (text: string): number | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/u.exec(text.trim());
  if (m === null) return undefined;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0"].map(Number) as [number, number, number, number, number];
  const at = new Date(y, mo - 1, d, h, mi);
  // Date rolls "2026-02-31" over into March; a date that isn't on the calendar is not read.
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d || at.getHours() !== h || at.getMinutes() !== mi) return undefined;
  return at.getTime();
};

export const isoOf = (ms: number): string => new Date(ms).toISOString();

const two = (n: number): string => String(n).padStart(2, "0");

/** "2026-10-12 09:30" in the viewer's zone: what the custom range's fields hold, and what parseWhen reads back. */
export const fieldWhen = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** The lookback for an order's own spans: everything the hub can still have. */
const ORDER_LOOKBACK_MS = 365 * DAY;

export interface TimeQuery {
  readonly scope: TimeScope;
  readonly breakdown: TimeBreakdownInput;
  readonly insights: TimeInsightsInput;
  /** Set for an order: its timeline needs every span; other scopes show totals only. */
  readonly spans: boolean;
}

/** The scope the filters and the open order make: an order, else a project, else a machine, else the fleet. */
export const scopeOf = (f: Filters, order: string | undefined): TimeScope => {
  if (order !== undefined) return { kind: "order", workstreamId: order };
  if (f.project !== undefined) return { kind: "project", projectRef: f.project };
  if (f.machine !== undefined) return { kind: "machine", machineId: f.machine };
  return { kind: "fleet" };
};

export const queryOf = (f: Filters, order: string | undefined, nowMs: number): TimeQuery => {
  const scope = scopeOf(f, order);
  const [since, until] = order !== undefined ? [nowMs - ORDER_LOOKBACK_MS, undefined] : period(f, nowMs);
  const end = until ?? nowMs;
  // The compare period is the one just before, of the same length.
  const compare: Period | undefined =
    f.compare && order === undefined ? { since: isoOf(since - (end - since)), until: isoOf(since) } : undefined;
  // The scope already carries its project or machine; a machine narrows a project, and the role narrows any scope.
  const filters = {
    ...(f.machine !== undefined && scope.kind === "project" ? { machineId: f.machine } : {}),
    ...(f.role !== undefined ? { role: f.role } : {}),
  };
  const window = { since: isoOf(since), ...(until === undefined ? {} : { until: isoOf(until) }) };
  return {
    scope,
    breakdown: { scope, ...window, ...(compare ? { compare } : {}), filters },
    insights: { scope, ...window, ...(compare ? { compare } : {}) },
    spans: order !== undefined,
  };
};

export const spansInput = (q: TimeQuery, afterId: number | undefined): TimeSpansInput => ({
  scope: q.scope,
  since: q.breakdown.since,
  ...(q.breakdown.until === undefined ? {} : { until: q.breakdown.until }),
  ...(afterId === undefined ? {} : { afterId }),
  limit: 500,
});

const STORAGE_KEY = "fleetd.time.filters";

const isRange = (v: unknown): v is Range => typeof v === "string" && (RANGES as readonly string[]).includes(v);
const isRole = (v: unknown): v is AgentRole => typeof v === "string" && (ROLES as readonly string[]).includes(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Reads saved filters, dropping anything an older or newer app wrote that this one doesn't understand. */
export const decodeFilters = (raw: unknown): Filters => {
  if (typeof raw !== "object" || raw === null) return DEFAULT_FILTERS;
  const o = raw as Record<string, unknown>;
  const c = typeof o["custom"] === "object" && o["custom"] !== null ? (o["custom"] as Record<string, unknown>) : undefined;
  const since = num(c?.["since"]);
  const until = num(c?.["until"]);
  const p = typeof o["project"] === "object" && o["project"] !== null ? (o["project"] as Record<string, unknown>) : undefined;
  const pm = str(p?.["machineId"]);
  const pp = str(p?.["projectId"]);
  const machine = str(o["machine"]);
  return {
    range: isRange(o["range"]) ? o["range"] : DEFAULT_FILTERS.range,
    compare: o["compare"] === true,
    ...(since === undefined ? {} : { custom: { since, ...(until === undefined ? {} : { until }) } }),
    ...(pm !== undefined && pp !== undefined ? { project: { machineId: pm, projectId: pp } } : {}),
    ...(machine === undefined ? {} : { machine }),
    ...(isRole(o["role"]) ? { role: o["role"] } : {}),
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
