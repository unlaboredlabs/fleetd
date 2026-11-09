// Pure wake-schedule math: IANA time-zone conversion, a 5-field cron parser,
// and "next run after". Local times that don't exist (the hour skipped when DST starts) move forward by the gap; local
// times that happen twice take the first occurrence. This is Temporal's "compatible".
import type { WakeSchedule } from "../../shared/contracts.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class ScheduleError extends Error {}

export type LocalTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formats = new Map<string, Intl.DateTimeFormat>();

/** The zone's formatter; throws ScheduleError for a name that is not an IANA time zone. */
function zone(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    throw new ScheduleError(`'${tz}' is not an IANA time zone`);
  }
  formats.set(tz, f);
  return f;
}

/** Wall-clock fields of the instant `ms` in `tz`. */
export function zonedParts(ms: number, tz: string): LocalTime {
  const parts = zone(tz).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

const asUtc = (t: LocalTime) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);

/** `tz`'s offset from UTC at the instant `ms`, in ms (New York in winter: -5 h). */
export function offsetMs(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return asUtc(zonedParts(whole, tz)) - whole;
}

/** The instant a wall-clock time in `tz` names. */
export function zonedToUtc(t: LocalTime, tz: string): number {
  const local = asUtc(t);
  const before = offsetMs(local - 15 * HOUR, tz);
  const after = offsetMs(local + 15 * HOUR, tz);
  const fits = [before, after].filter((o) => offsetMs(local - o, tz) === o).map((o) => local - o);
  return fits.length > 0 ? Math.min(...fits) : local - before;
}

// ---- cron ----

export type Cron = {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Vixie cron: when both day fields are restricted, a day matching either one runs. */
  anyDay: boolean;
};

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type FieldSpec = { name: string; min: number; max: number; names: string[]; nameBase: number };

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59, names: [], nameBase: 0 },
  { name: "hour", min: 0, max: 23, names: [], nameBase: 0 },
  { name: "day of month", min: 1, max: 31, names: [], nameBase: 0 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "day of week", min: 0, max: 7, names: WEEKDAYS, nameBase: 0 },
];

const allDigits = (s: string) => /^[0-9]+$/.test(s);

function parseValue(raw: string, spec: FieldSpec): number {
  const i = spec.names.indexOf(raw.toLowerCase());
  if (i >= 0) return i + spec.nameBase;
  if (!allDigits(raw)) throw new ScheduleError(`'${raw}' is not a valid ${spec.name}`);
  const n = Number(raw);
  if (n < spec.min || n > spec.max) throw new ScheduleError(`${spec.name} ${n} is outside ${spec.min}-${spec.max}`);
  return n;
}

function parseField(text: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const parts = item.split("/");
    const range = parts[0] ?? "";
    const stepText = parts[1];
    if (range === "" || parts.length > 2) throw new ScheduleError(`'${item}' is not a valid ${spec.name}`);
    let step = 1;
    if (stepText !== undefined) {
      if (!allDigits(stepText) || Number(stepText) < 1) {
        throw new ScheduleError(`step '${stepText}' in ${spec.name} must be a positive integer`);
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [spec.min, spec.max];
    else if (range.includes("-")) {
      const ends = range.split("-");
      if (ends.length !== 2) throw new ScheduleError(`'${range}' is not a valid ${spec.name} range`);
      [lo, hi] = [parseValue(ends[0] as string, spec), parseValue(ends[1] as string, spec)];
      if (lo > hi) throw new ScheduleError(`${spec.name} range ${range} runs backwards`);
    } else {
      lo = parseValue(range, spec);
      hi = stepText === undefined ? lo : spec.max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Standard 5-field cron (minute hour day-of-month month day-of-week) plus the @daily-style macros. */
export function parseCron(text: string): Cron {
  const trimmed = text.trim();
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(/\s+/).filter(Boolean);
  const count = fields.length === 0 ? 1 : fields.length;
  if (count !== 5) throw new ScheduleError(`cron needs 5 fields (minute hour day month weekday), got ${count}`);
  const sets = fields.map((f, i) => parseField(f, FIELDS[i] as FieldSpec));
  const [minutes, hours, days, months, weekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.delete(7)) weekdays.add(0);
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return {
    minutes: sorted(minutes),
    hours: sorted(hours),
    days,
    months,
    weekdays,
    anyDay: !(fields[2] as string).startsWith("*") && !(fields[4] as string).startsWith("*"),
  };
}

type Day = { year: number; month: number; day: number };

function dayMatches(cron: Cron, d: Day): boolean {
  if (!cron.months.has(d.month)) return false;
  const byDay = cron.days.has(d.day);
  const byWeekday = cron.weekdays.has(new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay());
  return cron.anyDay ? byDay || byWeekday : byDay && byWeekday;
}

function firstOnDay(cron: Cron, d: Day, afterMs: number, tz: string): number | undefined {
  if (!dayMatches(cron, d)) return undefined;
  let best: number | undefined;
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) {
      const t = zonedToUtc({ ...d, hour, minute, second: 0 }, tz);
      if (t > afterMs && (best === undefined || t < best)) best = t;
    }
  }
  return best;
}

/** Covers every Feb 29 pattern; a cron with no match in this window never matches. */
const SEARCH_DAYS = 366 * 8 + 1;

function addDays(d: Day, n: number): Day {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** The first firing strictly after `afterMs`, or undefined when the cron can never match (say, Feb 30). */
export function nextCron(cron: Cron, afterMs: number, tz: string): number | undefined {
  const start = zonedParts(afterMs, tz);
  const startDay = { year: start.year, month: start.month, day: start.day };
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const day = addDays(startDay, i);
    const found = firstOnDay(cron, day, afterMs, tz);
    if (found === undefined) continue;
    const next = firstOnDay(cron, addDays(day, 1), afterMs, tz);
    return next === undefined ? found : Math.min(next, found);
  }
  return undefined;
}

// ---- schedules ----

const AT_PATTERN =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$/;

function realDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** An ISO time with `Z` or an offset is absolute; one without names a wall-clock time in `tz`. */
export function parseAt(at: string, tz: string): number {
  const m = AT_PATTERN.exec(at.trim());
  if (!m) throw new ScheduleError(`'${at}' is not an ISO date-time such as 2026-10-18T09:00 or 2026-10-18T09:00:00Z`);
  const num = (i: number) => Number(m[i] ?? 0);
  const fields: LocalTime = { year: num(1), month: num(2), day: num(3), hour: num(4), minute: num(5), second: num(6) };
  if (!realDate(fields.year, fields.month, fields.day) || fields.hour > 23 || fields.minute > 59 || fields.second > 59) {
    throw new ScheduleError(`'${at}' is not a real date and time`);
  }
  const frac = m[7] === undefined ? 0 : Number(m[7]);
  const zoneText = m[8];
  if (zoneText !== undefined) {
    const ms = Math.trunc(frac * 1000);
    let offset = 0;
    if (zoneText !== "Z") {
      const sign = zoneText.startsWith("-") ? -1 : 1;
      const digits = zoneText.slice(1).replace(/[^0-9]/g, "");
      offset = sign * (Number(digits.slice(0, 2)) * HOUR + Number(digits.slice(2)) * MINUTE);
    }
    return asUtc(fields) + ms - offset;
  }
  zone(tz);
  return zonedToUtc(fields, tz) + Math.floor(frac * 1000 + 0.5);
}

/** Throws ScheduleError for a schedule that can never run. */
export function validate(schedule: WakeSchedule): void {
  if (schedule.kind === "at") parseAt(schedule.at, schedule.tz);
  else if (schedule.kind === "cron") {
    zone(schedule.tz);
    parseCron(schedule.cron);
  }
}

/** The first run strictly after `afterMs`, or undefined. `anchorMs` keeps an "every" wake's runs on one grid. */
export function nextRun(schedule: WakeSchedule, afterMs: number, anchorMs?: number): number | undefined {
  switch (schedule.kind) {
    case "at": {
      const at = parseAt(schedule.at, schedule.tz);
      return at > afterMs ? at : undefined;
    }
    case "every": {
      const every = schedule.everySec * 1000;
      return anchorMs === undefined ? afterMs + every : anchorMs + (Math.floor(Math.max(afterMs - anchorMs, 0) / every) + 1) * every;
    }
    case "cron":
      return nextCron(parseCron(schedule.cron), afterMs, (zone(schedule.tz), schedule.tz));
  }
  return undefined;
}
