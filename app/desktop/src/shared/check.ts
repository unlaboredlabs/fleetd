// Small runtime checks for what comes over the wire before the web app's first chat (the hub's frames, the session):
// zod's core was ~26 KB of that first load for these few shapes. Each is a type guard; a value passes or it doesn't.

export type Fields = Readonly<Record<string, unknown>>;

export const isFields = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);

/** A string of `min` to `max` UTF-16 units, as zod's string().min().max() counts. */
export const isText = (v: unknown, min = 0, max = Number.POSITIVE_INFINITY): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;

/** A safe integer, at least `min`, as zod's int(). */
export const isInt = (v: unknown, min = Number.NEGATIVE_INFINITY): v is number => Number.isSafeInteger(v) && (v as number) >= min;

/** An array of at most `max` items, each passing `each`. */
export const isList = <T>(v: unknown, max: number, each: (x: unknown) => x is T): v is T[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => each(x));

/** Absent, or passing `check`. */
export const isOptional = <T>(v: unknown, check: (x: unknown) => x is T): v is T | undefined => v === undefined || check(v);
