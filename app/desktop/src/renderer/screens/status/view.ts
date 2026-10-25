// The few words Status's rows and hovers say, as pure functions. Times are measured (an age, when something
// merged), never estimated.

import type { ProgressPoint, StaleMark } from "./contracts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** An age: "<1m", "4m", "3h", "2d". */
export const age = (ms: number): string => {
  const m = Math.floor(Math.max(0, ms) / MIN);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  if (m < 2880) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const two = (n: number): string => String(n).padStart(2, "0");

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

/**
 * A time in the viewer's zone, always with its day: "today 14:02", "yesterday 16:40", "Thu 14:02" within the week,
 * then "Oct 12", and "Oct 12, 2025" from another year. A bare "08:18" can't say which day it was.
 */
export const when = (iso: string, nowMs: number): string => {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const now = new Date(nowMs);
  const hm = `${two(t.getHours())}:${two(t.getMinutes())}`;
  if (sameDay(t, now)) return `today ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(t, yesterday)) return `yesterday ${hm}`;
  if (Math.abs(t.getTime() - nowMs) < 6 * DAY) return `${DAYS[t.getDay()] ?? ""} ${hm}`;
  const date = `${MONTHS[t.getMonth()] ?? ""} ${t.getDate()}`;
  return t.getFullYear() === now.getFullYear() ? date : `${date}, ${t.getFullYear()}`;
};

/** The whole stamp for a hover: "Thu Oct 22, 14:02". */
export const fullWhen = (iso: string): string => {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return `${DAYS[t.getDay()] ?? ""} ${MONTHS[t.getMonth()] ?? ""} ${t.getDate()}, ${two(t.getHours())}:${two(t.getMinutes())}`;
};

/** "Out of date for 11m: no heartbeat from buildbox". */
export const staleWords = (mark: StaleMark, nowMs: number): string => {
  const at = Date.parse(mark.since);
  return `${Number.isNaN(at) ? "Out of date" : `Out of date for ${age(nowMs - at)}`}: ${mark.reason}`;
};

/**
 * While the figure holds because the work in flight paused (an agent waiting for an answer or for a usage limit), the
 * hub marks the newest point: "Held at 64% (paused: an agent hit a usage limit)". A marker, not a drop.
 */
export const heldLine = (series: readonly ProgressPoint[]): string | undefined => {
  const last = series.at(-1);
  return last?.paused === undefined ? undefined : `Held at ${last.pct}% (${last.paused})`;
};

/** Why the figure last fell, newest first, at most three: "↓ 80% → 74%: +3 items: currency export added". */
export const dropLines = (series: readonly ProgressPoint[]): string[] =>
  series
    .flatMap((p) => (p.drop ? [`↓ ${p.drop.fromPct}% → ${p.pct}%: ${p.drop.text}`] : []))
    .reverse()
    .slice(0, 3);

/**
 * The row's 7-day fact: "12 merged in 7 days · 64% through fleetd". Undefined while the hub's metrics know none of the
 * project's repos: no count is shown as if it were a zero.
 */
export const weekLine = (merged: number | undefined, throughPct: number | undefined): string | undefined =>
  merged === undefined ? undefined : `${merged} merged in 7 days${throughPct === undefined ? "" : ` · ${Math.round(throughPct)}% through fleetd`}`;
