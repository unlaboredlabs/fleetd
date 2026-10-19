// Small formatters the order view shares. Times are shown in the viewer's zone; tests pin the zone.

const clocks = new Map<string, Intl.DateTimeFormat>();

/** "2026-10-18T14:02:07.120Z" → "16:02:07" in `timeZone` (default: the viewer's). The input itself when unparseable. */
export function clock(iso: string, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const key = timeZone ?? "";
  let f = clocks.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
    });
    clocks.set(key, f);
  }
  return f.format(ms);
}

/** At most `max` characters, ending in "…" when cut. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : text;
}

/** "40s", "1m12s", "1h05m". */
export function shortElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "claude-haiku-5-5" → "haiku". */
export function shortModel(model: string): string {
  return ["haiku", "sonnet", "opus", "fable"].find((m) => model.includes(m)) ?? model;
}
