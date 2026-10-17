// Pure wake-schedule math: IANA time-zone conversion through Intl, a 5-field cron parser, and "next run after".
// Local times that don't exist (the hour skipped when DST starts) move forward by the gap; local times that
// happen twice (the hour repeated when DST ends) take the first occurrence. This is Temporal's "compatible".
import type { WakeSchedule } from "@fleetd/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface LocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (tz: string) => {
  let f = formatters.get(tz);
  if (f === undefined) {
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
    formatters.set(tz, f);
  }
  return f;
};

/** Wall-clock fields of the instant `ms` in `tz`. */
export const zonedParts = (ms: number, tz: string): LocalTime => {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
};

const asUtc = (t: LocalTime) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);

/** `tz`'s offset from UTC at the instant `ms`, in ms (New York in winter: -5 h). */
export const offsetMs = (ms: number, tz: string) => {
  const whole = Math.floor(ms / 1000) * 1000;
  return asUtc(zonedParts(whole, tz)) - whole;
};

/** The instant a wall-clock time in `tz` names. */
export const zonedToUtc = (t: LocalTime, tz: string): number => {
  const local = asUtc(t);
  // Offsets range over [-12 h, +14 h], so these sample the zone before and after any transition near `local`.
  const before = offsetMs(local - 15 * HOUR, tz);
  const after = offsetMs(local + 15 * HOUR, tz);
  const valid = [before, after].filter((o) => offsetMs(local - o, tz) === o).map((o) => local - o);
  return valid.length > 0 ? Math.min(...valid) : local - before;
};

// ---- cron ----------------------------------------------------------------------------------------

export interface Cron {
  readonly minutes: ReadonlyArray<number>;
  readonly hours: ReadonlyArray<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  /** Vixie cron: when both day fields are restricted, a day matching either one runs. */
  readonly anyDay: boolean;
  readonly daysRestricted: boolean;
  readonly weekdaysRestricted: boolean;
}

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

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: ReadonlyArray<string>;
  /** First value the names map to. */
  readonly nameBase?: number;
}
const FIELDS: ReadonlyArray<FieldSpec> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "day of week", min: 0, max: 7, names: WEEKDAYS, nameBase: 0 },
];

export class CronError extends Error {}

const parseValue = (raw: string, spec: FieldSpec): number => {
  const named = spec.names?.indexOf(raw.toLowerCase()) ?? -1;
  if (named >= 0) return named + spec.nameBase!;
  if (!/^\d+$/u.test(raw)) throw new CronError(`'${raw}' is not a valid ${spec.name}`);
  const n = Number(raw);
  if (n < spec.min || n > spec.max) throw new CronError(`${spec.name} ${n} is outside ${spec.min}-${spec.max}`);
  return n;
};

const parseField = (text: string, spec: FieldSpec): Set<number> => {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const [range, stepText, extra] = item.split("/");
    if (range === undefined || range === "" || extra !== undefined) throw new CronError(`'${item}' is not a valid ${spec.name}`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || (stepText !== undefined && !/^\d+$/u.test(stepText))) {
      throw new CronError(`step '${stepText}' in ${spec.name} must be a positive integer`);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (a === undefined || b === undefined || more !== undefined) throw new CronError(`'${range}' is not a valid ${spec.name} range`);
      lo = parseValue(a, spec);
      hi = parseValue(b, spec);
      if (lo > hi) throw new CronError(`${spec.name} range ${range} runs backwards`);
    } else {
      lo = parseValue(range, spec);
      hi = stepText === undefined ? lo : spec.max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
};

/** Standard 5-field cron (minute hour day-of-month month day-of-week) plus the @daily-style macros. */
export const parseCron = (text: string): Cron => {
  const expanded = MACROS[text.trim().toLowerCase()] ?? text.trim();
  const fields = expanded.split(/\s+/u);
  if (fields.length !== 5) throw new CronError(`cron needs 5 fields (minute hour day month weekday), got ${fields.length}`);
  const [minutes, hours, days, months, weekdays] = fields.map((f, i) => parseField(f, FIELDS[i]!)) as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (weekdays.delete(7)) weekdays.add(0);
  const daysRestricted = !fields[2]!.startsWith("*");
  const weekdaysRestricted = !fields[4]!.startsWith("*");
  return {
    minutes: [...minutes].toSorted((a, b) => a - b),
    hours: [...hours].toSorted((a, b) => a - b),
    days,
    months,
    weekdays,
    anyDay: daysRestricted && weekdaysRestricted,
    daysRestricted,
    weekdaysRestricted,
  };
};

const dayMatches = (cron: Cron, year: number, month: number, day: number) => {
  if (!cron.months.has(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const byDay = cron.days.has(day);
  const byWeekday = cron.weekdays.has(weekday);
  return cron.anyDay ? byDay || byWeekday : byDay && byWeekday;
};

/** Earliest firing on the local calendar day `dayMs` (a UTC-midnight stand-in) that is after `afterMs`. */
const firstOnDay = (cron: Cron, dayMs: number, afterMs: number, tz: string): number | undefined => {
  const d = new Date(dayMs);
  const [year, month, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  if (!dayMatches(cron, year, month, day)) return undefined;
  let best: number | undefined;
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) {
      const t = zonedToUtc({ year, month, day, hour, minute, second: 0 }, tz);
      if (t > afterMs && (best === undefined || t < best)) best = t;
    }
  }
  return best;
};

/** Covers every Feb 29 pattern; a cron with no match in this window never matches. */
const SEARCH_DAYS = 366 * 8 + 1;

/** The first firing strictly after `afterMs`, or undefined when the cron can never match (say, Feb 30). */
export const nextCron = (cron: Cron, afterMs: number, tz: string): number | undefined => {
  const start = zonedParts(afterMs, tz);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const found = firstOnDay(cron, startDay + i * DAY, afterMs, tz);
    if (found === undefined) continue;
    // A late-evening time pushed forward across midnight by a DST gap can land after the next day's first one.
    const next = firstOnDay(cron, startDay + (i + 1) * DAY, afterMs, tz);
    return next === undefined ? found : Math.min(found, next);
  }
  return undefined;
};

// ---- schedules -----------------------------------------------------------------------------------

export class ScheduleError extends Error {}

const AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/u;

/** An ISO time with `Z` or an offset is absolute; one without names a wall-clock time in `tz`. */
export const parseAt = (at: string, tz: string): number => {
  const m = AT_PATTERN.exec(at.trim());
  if (m === null) throw new ScheduleError(`'${at}' is not an ISO date-time such as 2026-10-18T09:00 or 2026-10-18T09:00:00Z`);
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const fields = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s ?? 0) };
  const probe = new Date(Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second));
  if (probe.getUTCMonth() + 1 !== fields.month || probe.getUTCDate() !== fields.day || fields.hour > 23 || fields.minute > 59 || fields.second > 59) {
    throw new ScheduleError(`'${at}' is not a real date and time`);
  }
  if (zone !== undefined) return Date.parse(at.trim().replace(" ", "T"));
  return zonedToUtc(fields, tz) + Math.round(Number(frac ?? 0) * 1000);
};

/** Throws ScheduleError for a schedule that can never run. */
export const validate = (schedule: WakeSchedule): void => {
  if (schedule.kind === "at") parseAt(schedule.at, schedule.tz);
  if (schedule.kind === "cron") {
    try {
      parseCron(schedule.cron);
    } catch (error) {
      throw new ScheduleError(error instanceof Error ? error.message : String(error));
    }
  }
};

/**
 * The first run strictly after `afterMs`, or undefined when there is none. `anchorMs` is the previous scheduled
 * run of an "every" wake, so its runs stay on one grid however late each firing was.
 */
export const nextRun = (schedule: WakeSchedule, afterMs: number, anchorMs?: number): number | undefined => {
  switch (schedule.kind) {
    case "at": {
      const at = parseAt(schedule.at, schedule.tz);
      return at > afterMs ? at : undefined;
    }
    case "every": {
      const every = schedule.everySec * 1000;
      if (anchorMs === undefined) return afterMs + every;
      return anchorMs + (Math.floor(Math.max(0, afterMs - anchorMs) / every) + 1) * every;
    }
    case "cron":
      return nextCron(parseCron(schedule.cron), afterMs, schedule.tz);
  }
};
