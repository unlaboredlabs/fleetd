// JSON as the Rust binary writes it: serde_json without `preserve_order` keeps an object's keys in a BTreeMap, so
// every object comes out with its keys sorted by their bytes, at every depth, and compact. JSON.stringify keeps
// insertion order (and puts integer-like keys first), so the bytes would differ.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `serde_json::to_string(&value)` for a `serde_json::Value`. */
export function rustJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(rustJson).join(",")}]`;
  const entries = Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort(byBytes)
    .map((key) => `${JSON.stringify(key)}:${rustJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

/** Rust's `{:?}` of a string: quoted, with `"`, `\` and control characters escaped as Rust escapes them. */
export function rustDebug(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code === 0) out += "\\0";
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/** `value["key"]` on a `serde_json::Value`: anything that isn't an object has no keys. */
export function at(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A `Value`'s Display (`{}`), as `format!` prints `result["startMs"]`: JSON, `null` when absent. */
export const display = (value: unknown) => rustJson(value === undefined ? null : value);
