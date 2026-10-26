// A 5-field cron in plain words, for the editor's preview: the hub's parser (hub/wakes/schedule.rs) decides what
// runs, and refuses on save what this one can't read, so the two read the same syntax: lists, ranges, steps, month and
// day names, 7 for Sunday and the @daily-style macros. Vixie cron: when both day fields are set, either one matches.

export type CronReading = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

const MACROS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface Spec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: ReadonlyArray<string>;
  readonly base?: number;
}

const FIELDS: ReadonlyArray<Spec> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, base: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, base: 0 },
];

function value(raw: string, spec: Spec): number {
  const named = spec.names?.indexOf(raw.toLowerCase()) ?? -1;
  if (named >= 0) return named + (spec.base ?? 0);
  if (!/^[0-9]+$/u.test(raw)) throw new Error(`'${raw}' is not a valid ${spec.name}`);
  const n = Number(raw);
  if (n < spec.min || n > spec.max) throw new Error(`${spec.name} ${n} is outside ${spec.min}-${spec.max}`);
  return n;
}

function field(text: string, spec: Spec): number[] {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const [range = "", step, extra] = item.split("/");
    if (range === "" || extra !== undefined) throw new Error(`'${item}' is not a valid ${spec.name}`);
    const by = step === undefined ? 1 : /^[0-9]+$/u.test(step) && Number(step) >= 1 ? Number(step) : NaN;
    if (Number.isNaN(by)) throw new Error(`'${step ?? ""}' is not a valid step for ${spec.name}`);
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [spec.min, spec.max];
    else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      [lo, hi] = [value(a, spec), value(b, spec)];
      if (lo > hi) throw new Error(`'${range}' runs backwards`);
    } else {
      lo = value(range, spec);
      hi = step === undefined ? lo : spec.max;
    }
    for (let n = lo; n <= hi; n += by) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "a, b and c". */
function list(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

/** The step of 0, n, 2n, … up to `max`, else null. */
function stepOf(values: ReadonlyArray<number>, max: number): number | null {
  if (values.length < 2 || values[0] !== 0) return null;
  const n = values[1] ?? 0;
  return values.every((v, i) => v === i * n) && (values[values.length - 1] ?? 0) + n > max ? n : null;
}

/** A run of consecutive values as one range, e.g. Monday to Friday. */
function run(values: ReadonlyArray<number>): [number, number] | null {
  const first = values[0];
  const last = values[values.length - 1];
  if (first === undefined || last === undefined || values.length < 3) return null;
  return last - first + 1 === values.length ? [first, last] : null;
}

function times(minutes: number[], hours: number[]): string {
  const everyHour = hours.length === 24;
  if (minutes.length === 60 && everyHour) return "every minute";
  const minuteStep = stepOf(minutes, 59);
  if (minuteStep !== null && everyHour) return `every ${minuteStep} minutes`;
  const hourStep = stepOf(hours, 23);
  if (minutes.length === 1) {
    const m = minutes[0] ?? 0;
    if (everyHour) return m === 0 ? "every hour" : `every hour at ${pad(m)} past`;
    if (hourStep !== null) return m === 0 ? `every ${hourStep} hours` : `every ${hourStep} hours at ${pad(m)} past`;
    if (hours.length <= 6) return `at ${list(hours.map((h) => `${pad(h)}:${pad(m)}`))}`;
    const r = run(hours);
    if (r) return `every hour from ${pad(r[0])}:${pad(m)} to ${pad(r[1])}:${pad(m)}`;
  }
  const at = minuteStep !== null ? `every ${minuteStep} minutes` : `at minute ${list(minutes.map(String))}`;
  if (everyHour) return at;
  const r = run(hours);
  return r ? `${at}, from ${pad(r[0])}:00 to ${pad(r[1])}:59` : `${at} past hour ${list(hours.map(String))}`;
}

function weekdays(days: number[]): string {
  const r = run(days);
  if (r) return `${DAY_NAMES[r[0]] ?? ""} to ${DAY_NAMES[r[1]] ?? ""}`;
  if (days.length === 2 && days[0] === 0 && days[1] === 6) return "on weekends";
  return `on ${list(days.map((d) => DAY_NAMES[d] ?? ""))}`;
}

const monthDays = (days: number[]) => (days.length === 1 ? `on day ${days[0] ?? ""} of the month` : `on days ${list(days.map(String))} of the month`);

/** The cron in words with its time zone, or why it doesn't read. */
export function describeCron(cron: string, tz: string): CronReading {
  const text = cron.trim();
  const expanded = MACROS[text.toLowerCase()] ?? text;
  const parts = expanded.split(/\s+/u).filter(Boolean);
  if (parts.length !== 5) return { ok: false, error: "Give five fields: minute, hour, day of month, month, day of week." };
  try {
    const [m, h, dom, mon, dow] = parts.map((p, i) => field(p, FIELDS[i] as Spec)) as [number[], number[], number[], number[], number[]];
    const dowSet = [...new Set(dow.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
    const domSet = (parts[2] ?? "").startsWith("*") ? null : dom;
    const dowRestricted = !(parts[4] ?? "").startsWith("*");
    const when = times(m, h);
    const days =
      domSet && dowRestricted
        ? `${monthDays(domSet)} or ${weekdays(dowSet)}`
        : domSet
          ? monthDays(domSet)
          : dowRestricted && dowSet.length < 7
            ? weekdays(dowSet)
            : null;
    const months = mon.length === 12 ? null : `in ${list(mon.map((n) => MONTH_NAMES[n - 1] ?? ""))}`;
    const daily = days === null && months === null && when.startsWith("at ");
    const sentence = [daily ? `every day ${when}` : when, days, months].filter(Boolean).join(", ");
    const zone = tz.trim() === "" ? "" : ` (${tz.trim()})`;
    return { ok: true, text: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}${zone}` };
  } catch (e) {
    return { ok: false, error: `${e instanceof Error ? e.message : String(e)}.` };
  }
}
