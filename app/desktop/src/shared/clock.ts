// The time of day, said one way across the app: the person's own locale's clock ("9:02 AM" on a US Mac, "09:02" on a
// British one), as the OS says it. Each formatter is made once: making one costs far more than using it.

const formats = new Map<string, Intl.DateTimeFormat>();

/** A 24-hour clock writes its hour in two digits ("09:02"), as macOS does; a 12-hour one doesn't ("9:02 AM"). */
const hourOf = (locale: string | undefined): "2-digit" | "numeric" => {
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h23" || cycle === "h24" ? "2-digit" : "numeric";
};

/**
 * The locale's clock, with `extra` fields (a weekday) before it, in `timeZone` (the person's own when absent).
 * `locale` only for tests: the app always says it in the person's own.
 */
export const clockFormat = (timeZone?: string, extra?: Intl.DateTimeFormatOptions, locale?: string): Intl.DateTimeFormat => {
  const key = `${locale ?? ""}|${timeZone ?? ""}|${extra === undefined ? "" : JSON.stringify(extra)}`;
  let f = formats.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(locale, { ...extra, hour: hourOf(locale), minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
    formats.set(key, f);
  }
  return f;
};

/** "9:02 AM" or "09:02", as the locale says it; "" for a time that can't be read. */
export const clock = (at: string | number | Date, timeZone?: string): string => {
  const ms = typeof at === "string" ? Date.parse(at) : typeof at === "number" ? at : at.getTime();
  return Number.isNaN(ms) ? "" : clockFormat(timeZone).format(ms);
};
