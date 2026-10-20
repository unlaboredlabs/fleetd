/** Epoch ms of an RFC 3339 timestamp, or undefined when it isn't one. */
export const parseMs = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
};

/** `m:ss` under an hour, then `1h 05m`. */
export const fmtElapsed = (ms: number): string => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};

/** `840`, `3.1k`, `48k`, `1.2M`, `12M`. */
export const fmtTokens = (n: number): string => {
  const scaled = (unit: number, suffix: string) => {
    const tenths = Math.floor((n * 10 + unit / 2) / unit);
    return tenths < 100 ? `${Math.floor(tenths / 10)}.${tenths % 10}${suffix}` : `${Math.floor((n + unit / 2) / unit)}${suffix}`;
  };
  if (n < 1000) return String(n);
  if (n < 999_500) return scaled(1000, "k");
  return scaled(1_000_000, "M");
};

/** Cuts `s` to `max` characters by replacing its middle with "…", so a command keeps its program and its target. */
export const middleEllipsis = (s: string, max: number): string => {
  const chars = Array.from(s);
  if (chars.length <= max || max < 3) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (keep - head)).join("")}`;
};

/** "claude-haiku-5-5" → "haiku"; anything unfamiliar is shown whole. */
export const shortModel = (model: string): string =>
  ["haiku", "sonnet", "opus", "fable"].find((f) => model.split(/[-_.]/u).includes(f)) ?? model;
