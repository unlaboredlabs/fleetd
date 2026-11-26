// What the Usage page draws from `workspace_usage`: the period's columns (a day each, a week each past a month), the
// figures as the page writes them, and the changes against the period before. Pure, so the phone reads the same.
import type { WorkspaceUsageCounts, WorkspaceUsageDay, WorkspaceUsageOutput } from "./contracts";

export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "1,284": a count in full, grouped. */
export const count = (n: number): string => Math.round(n).toLocaleString("en-US");

/** Agent or computer time: "42m", "6.5h", "412h". */
export const hours = (ms: number): string => {
  if (ms <= 0) return "0h";
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))}m`;
  const h = ms / HOUR;
  return h < 10 ? `${h.toFixed(1).replace(/\.0$/u, "")}h` : `${count(h)}h`;
};

/** A wait: "48m", "3h 10m", "2d 4h". */
export const wait = (ms: number): string => {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))}m`;
  if (ms < DAY) {
    const m = Math.round(ms / MIN);
    const h = Math.floor(m / 60);
    return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  }
  const h = Math.round(ms / HOUR);
  return h % 24 === 0 ? `${h / 24}d` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

/** "$1,240" or "€86.50": cents in the team's currency, whole once it is past a hundred. */
export const money = (cents: number, currency: string): string => {
  const whole = Math.abs(cents) >= 10_000;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: whole ? 0 : 2, minimumFractionDigits: whole ? 0 : 2 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(whole ? 0 : 2)} ${currency}`;
  }
};

export type Better = "up" | "down" | "none";

export interface Change {
  /** "↑ 12%", "↓ 40m". */
  readonly text: string;
  /** By the direction and which way is better: never colour alone, the arrow says it too. */
  readonly tone: "success" | "danger" | "quiet";
}

/**
 * The change against the period before, as a share for a count or a time spent, and as a time for a wait. Absent when
 * the period before had nothing to compare with (a new workspace).
 */
export const change = (now: number | undefined, before: number | undefined, better: Better, as: "share" | "wait" = "share"): Change | undefined => {
  if (now === undefined || before === undefined || before <= 0) return undefined;
  const d = now - before;
  const still = as === "wait" ? Math.abs(d) < MIN : Math.abs(d) / before < 0.005;
  if (still) return { text: "→ same", tone: "quiet" };
  const up = d > 0;
  const size = as === "wait" ? wait(Math.abs(d)) : `${Math.round((Math.abs(d) / before) * 100)}%`;
  const tone = better === "none" ? "quiet" : up === (better === "up") ? "success" : "danger";
  return { text: `${up ? "↑" : "↓"} ${size}`, tone };
};

/** A column of the charts: one day, or one week of days from the period's first. */
export interface Column {
  readonly from: string;
  readonly to: string;
  /** "Nov 26", or "Nov 20 to Nov 26" for a week. */
  readonly label: string;
  readonly orders: number;
  readonly merged: number;
  readonly failed: number;
  readonly agentMs: number;
  readonly spendCents?: number;
}

/** Past a month, a column is a week: 13 of them for 90 days, rather than 90 slivers. */
export const WEEKLY_OVER = 31;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-26" → "Nov 26". */
export const dayLabel = (date: string): string => {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? ""} ${d ?? ""}`;
};

export const columnsOf = (days: readonly WorkspaceUsageDay[]): Column[] => {
  const size = days.length > WEEKLY_OVER ? 7 : 1;
  const out: Column[] = [];
  for (let i = 0; i < days.length; i += size) {
    const chunk = days.slice(i, i + size);
    const first = chunk[0];
    const last = chunk.at(-1);
    if (first === undefined || last === undefined) continue;
    const spend = chunk.some((d) => d.spendCents !== undefined) ? chunk.reduce((a, d) => a + (d.spendCents ?? 0), 0) : undefined;
    out.push({
      from: first.date,
      to: last.date,
      label: size === 1 ? dayLabel(first.date) : `${dayLabel(first.date)} to ${dayLabel(last.date)}`,
      orders: chunk.reduce((a, d) => a + d.orders, 0),
      merged: chunk.reduce((a, d) => a + d.merged, 0),
      failed: chunk.reduce((a, d) => a + d.failed, 0),
      agentMs: chunk.reduce((a, d) => a + d.agentMs, 0),
      ...(spend === undefined ? {} : { spendCents: spend }),
    });
  }
  return out;
};

/** The ticks of an axis from 0: 1, 2 or 5 × 10ⁿ apart, the last at or over max; `unit` the smallest step. */
export const ticks = (max: number, unit = 1): number[] => {
  const top = Math.max(max, unit);
  const raw = top / 4;
  const mag = 10 ** Math.floor(Math.log10(raw / unit));
  const step = Math.max(unit, [1, 2, 5, 10].map((k) => k * mag * unit).find((s) => s >= raw) ?? 10 * mag * unit);
  const out: number[] = [];
  for (let t = 0; t < top + step - 1e-9; t += step) out.push(t);
  return out;
};

/** Whether the answer is a fleetd cloud team's, with time on fleetd's computers and what it cost. */
export const onCloud = (u: Pick<WorkspaceUsageOutput, "total" | "currency">): boolean => u.currency !== undefined && u.total.spendCents !== undefined;

/** Its share of the largest, 0 to 1, for a row's bar. */
export const share = (v: number, max: number): number => (max <= 0 ? 0 : Math.min(1, Math.max(0, v / max)));

/**
 * A row with nothing in the period: listed quiet, after those that did something. On the cloud, time on fleetd's
 * computers counts too: the "No one" row often holds only that, the leads' own boxes.
 */
export const idle = (c: WorkspaceUsageCounts): boolean =>
  c.messages + c.orders + c.agents + c.agentMs + c.merged + c.approvals + c.failed + (c.computerMs ?? 0) + (c.spendCents ?? 0) === 0;

/** "the 30 days before". */
export const before = (days: Period): string => `the ${days} days before`;

/** "in the last 7 days" for the page's words. */
export const periodWords = (days: Period): string => `the last ${days} days`;
