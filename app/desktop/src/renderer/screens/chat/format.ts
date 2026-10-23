// Small formatters the chat shares. Times are shown in the viewer's zone; tests pin the zone.
import type { PrKey } from "../shell/routes";

/** "40s", "1m12s", "1h05m". */
export function shortElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A line split into text, `code` and app links (as prLinks writes them); an unclosed backtick stays text. */
export function codeRuns(line: string): Array<{ readonly code: boolean; readonly text: string; readonly href?: string }> {
  const out: Array<{ code: boolean; text: string; href?: string }> = [];
  const re = /`([^`]+)`|\[([^\]\n]+)\]\((#\/[^)\s]*)\)/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index > last) out.push({ code: false, text: line.slice(last, m.index) });
    out.push(m[3] === undefined ? { code: true, text: m[1] ?? "" } : { code: false, text: m[2] ?? "", href: m[3] });
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

// PR mentions: "#9" and "PR #9" (the project's), and a GitHub pull URL (its repo's). Not "issue#9", "&#9;" or "#0".
const PR_REF = /(?<![\w/&#])(?:PR )?#([1-9]\d{0,5})\b/g;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d{0,5})(?:[/?#][^\s)]*)?$/;
// machineCode's spans plus whole markdown links, so a link already written is never linked again.
const PR_PROTECT = new RegExp(`\\[[^\\]\\n]*\\]\\([^)\\n]*\\)|${PROTECT.source}`, "g");

/**
 * Markdown with its PR mentions as links to `href` (the PR in the panel). Code is left alone; a written link or URL to
 * a GitHub PR keeps its words and goes to the panel instead of the browser, where the PR's view has Open on GitHub.
 */
export function prLinks(md: string, href: (pr: PrKey) => string): string {
  const pull = (url: string): string | undefined => {
    const m = PR_URL.exec(url);
    return m === null ? undefined : href({ repo: m[1] ?? "", number: Number(m[2]) });
  };
  const kept = (span: string): string => {
    const link = /^\[([^\]\n]*)\]\(([^)\n]*)\)$/.exec(span);
    if (link !== null) {
      const to = pull(link[2] ?? "");
      return to === undefined ? span : `[${link[1] ?? ""}](${to})`;
    }
    const auto = /^<(https:[^>]*)>$/.exec(span)?.[1];
    if (auto !== undefined) {
      const to = pull(auto);
      return to === undefined ? span : `[${auto}](${to})`;
    }
    if (!span.startsWith("http")) return span;
    // A bare URL's sentence ends after it: "see …/pull/9." keeps its full stop outside the link.
    const url = span.replace(/[.,;:!?]+$/, "");
    const to = pull(url);
    return to === undefined ? span : `[${url}](${to})${span.slice(url.length)}`;
  };
  const refs = (text: string) => text.replace(PR_REF, (t, n: string) => `[${t}](${href({ repo: null, number: Number(n) })})`);
  let out = "";
  let last = 0;
  for (const m of md.matchAll(PR_PROTECT)) {
    out += refs(md.slice(last, m.index)) + kept(m[0]);
    last = m.index + m[0].length;
  }
  return out + refs(md.slice(last));
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
