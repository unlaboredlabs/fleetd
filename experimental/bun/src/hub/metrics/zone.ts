// Calendar days in an IANA time zone, as chrono_tz reads them (crates/fleetd/src/hub/metrics/compute.rs local_date,
// day_start; hub/status/rows.rs clock): from Intl, with one cached formatter per zone.

/** A calendar date: year, month 1-12, day 1-31. */
export type LocalDate = { y: number; m: number; d: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone `name` names, case-insensitively, as chrono_tz's from_str_insensitive; UTC for anything else. */
export function zone(name: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

type Wall = LocalDate & { h: number; min: number; s: number; weekday: string };

/** The wall clock in `tz` at `ms`. */
export function wall(ms: number, tz: string): Wall {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(ms)) out[p.type] = p.value;
  return {
    y: Number(out.year),
    m: Number(out.month),
    d: Number(out.day),
    h: Number(out.hour),
    min: Number(out.minute),
    s: Number(out.second),
    weekday: out.weekday ?? "",
  };
}

/** `tz`'s offset from UTC at `ms`, whole seconds. */
function offsetMs(ms: number, tz: string): number {
  const w = wall(ms, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

export function localDate(ms: number, tz: string): LocalDate {
  const { y, m, d } = wall(ms, tz);
  return { y, m, d };
}

export const sameDate = (a: LocalDate, b: LocalDate) => a.y === b.y && a.m === b.m && a.d === b.d;

/** The date `days` after (or before) `date`. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const dateText = (date: LocalDate) => `${pad(date.y, 4)}-${pad(date.m)}-${pad(date.d)}`;

/** The earliest instant whose wall clock in `tz` reads `date` at `h`:00, or undefined in a DST gap. */
function earliest(date: LocalDate, h: number, tz: string): number | undefined {
  const guess = Date.UTC(date.y, date.m - 1, date.d, h);
  const offsets = new Set([offsetMs(guess - 86_400_000, tz), offsetMs(guess, tz), offsetMs(guess + 86_400_000, tz)]);
  let best: number | undefined;
  for (const off of offsets) {
    const t = guess - off;
    const w = wall(t, tz);
    if (w.y === date.y && w.m === date.m && w.d === date.d && w.h === h && w.min === 0 && w.s === 0) {
      if (best === undefined || t < best) best = t;
    }
  }
  return best;
}

/** When `date` starts in `tz`: its midnight, or the first hour that exists where a DST gap swallows midnight. */
export function dayStart(date: LocalDate, tz: string): number {
  for (let h = 0; h < 24; h++) {
    const t = earliest(date, h, tz);
    if (t !== undefined) return t;
  }
  return Date.UTC(date.y, date.m - 1, date.d);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** "14:05" today in `tz`, "Mon 14:05" within six days, else "Oct 3 14:05" (status rows `clock`). */
export function clock(ms: number, now: number, tz: string): string {
  const t = wall(ms, tz);
  const hm = `${pad(t.h)}:${pad(t.min)}`;
  if (sameDate(t, localDate(now, tz))) return hm;
  if (Math.abs(ms - now) < 6 * DAY_MS) return `${t.weekday} ${hm}`;
  return `${MONTHS[t.m - 1]} ${t.d} ${hm}`;
}
