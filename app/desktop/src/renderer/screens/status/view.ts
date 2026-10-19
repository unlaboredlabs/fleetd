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

/** A time in the viewer's zone: "14:02" today, "Thu 14:02" within a week, else "Oct 21 14:02". */
export const when = (iso: string, nowMs: number): string => {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const now = new Date(nowMs);
  const hm = `${two(t.getHours())}:${two(t.getMinutes())}`;
  if (t.toDateString() === now.toDateString()) return hm;
  if (Math.abs(t.getTime() - nowMs) < 6 * DAY) return `${DAYS[t.getDay()] ?? ""} ${hm}`;
  return `${MONTHS[t.getMonth()] ?? ""} ${t.getDate()} ${hm}`;
};

/** "stale 4m: no heartbeat from buildbox since 09:55". */
export const staleWords = (mark: StaleMark, nowMs: number): string => {
  const at = Date.parse(mark.since);
  return `${Number.isNaN(at) ? "stale" : `stale ${age(nowMs - at)}`}: ${mark.reason}`;
};

/** Why the figure last fell, newest first, at most three: "↓ 80% → 74%: +3 items: currency export added". */
export const dropLines = (series: readonly ProgressPoint[]): string[] =>
  series
    .flatMap((p) => (p.drop ? [`↓ ${p.drop.fromPct}% → ${p.pct}%: ${p.drop.text}`] : []))
    .reverse()
    .slice(0, 3);
