// Small formatters the chat shares. Times are shown in the viewer's zone; tests pin the zone.

/** "40s", "1m12s", "1h05m". */
export function shortElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A line split into text and `code` runs; an unclosed backtick stays text. */
export function codeRuns(line: string): Array<{ readonly code: boolean; readonly text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index > last) out.push({ code: false, text: line.slice(last, m.index) });
    out.push({ code: true, text: m[1] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ code: false, text: line.slice(last) });
  return out;
}

// Machine tokens in agent text (ids, hashes, keys): set as code, the machine voice, so they never read as prose.
// Mirrors the QA gate's raw-text detectors (qa/dom/text-rules.ts).
const PROTECT = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\]\([^)\n]*\)|<[^>\s]+>|https?:\/\/[^\s)]+|(?:^|\n)(?: {4}|\t)[^\n]*/g;
// Ids and hashes count anywhere (as the gate's \\b rules do); keys only as whole tokens.
const TOKEN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{7,}\b|(?<![\w./`-])(?:[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z0-9]+(?:-[a-z0-9]+){2,})(?![\w/`-])/gi;
const FILE_OR_HOST = new Set(["json", "md", "ts", "tsx", "js", "rs", "toml", "yaml", "yml", "png", "jpg", "sh", "txt", "log", "com", "dev", "io", "org", "net", "app", "local"]);
const HYPHENATED = new Set(["up-to-date", "out-of-date", "end-to-end", "day-to-day", "side-by-side", "step-by-step", "one-to-one", "all-in-one", "state-of-the-art"]);

function isMachine(t: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(t)) return true;
  if (/^[0-9a-f]{7,}$/i.test(t)) return /[0-9]/.test(t) && /[a-f]/i.test(t);
  if (t.includes(".")) {
    const parts = t.split(".");
    if (parts.some((p) => p.length < 2) || parts.slice(1).every((p) => /^\d+$/.test(p))) return false;
    return !FILE_OR_HOST.has((parts.at(-1) ?? "").toLowerCase()) && /^[a-z]/.test(t);
  }
  if (t.includes("_")) return /^[a-z]/.test(t);
  return t.split("-").length >= 3 && /[a-z]/.test(t) && !HYPHENATED.has(t) && t === t.toLowerCase();
}

/** Markdown with bare ids, hashes and keys wrapped as inline code; code, links and URLs are left as they are. */
export function machineCode(md: string): string {
  let out = "";
  let last = 0;
  const wrap = (s: string) => s.replace(TOKEN, (t) => (isMachine(t) ? `\`${t}\`` : t));
  for (const m of md.matchAll(PROTECT)) {
    // "<id>" in prose is a placeholder, not an autolink or HTML: shown as code, never dropped.
    const kept = m[0].startsWith("<") && !/[:@]/.test(m[0]) ? `\`${m[0]}\`` : m[0];
    out += wrap(md.slice(last, m.index)) + kept;
    last = m.index + m[0].length;
  }
  return out + wrap(md.slice(last));
}

const shortClocks = new Map<string, Intl.DateTimeFormat>();

/** "16:02": a chat message's time (its day is the divider above it). */
export function shortClock(iso: string, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const key = timeZone ?? "";
  let f = shortClocks.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) });
    shortClocks.set(key, f);
  }
  return f.format(ms);
}
