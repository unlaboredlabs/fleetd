// A chat search's rules, with no hub behind them, so fleetd's cloud finds and shows hits exactly as a hub does: how
// `words` reads into terms, how text folds for matching (SQLite's unicode61 tokenizer with remove_diacritics 2),
// what a message holds for `has`, and a hit's one line with its marks.
import type { AttachmentRef, ChatFindHas } from "../../shared/contracts.ts";

/** The hits a page holds unless told, and at most. */
export const FIND_LIMIT = 20;
export const FIND_LIMIT_MAX = 50;
/** A first page counts its query's hits up to this many (`countMore` past it). */
export const FIND_COUNT_CAP = 10_000;
/** The characters of a hit's or a pin's line. */
export const LINE_CHARS = 160;

/** One term of a search: its folded tokens in a row; `prefix`: the last one matches a word's start. */
export type Term = { tokens: string[]; prefix: boolean };

const TOKEN = /[\p{L}\p{N}]+/gu;

/** A block's words in a line, as the apps' previews say them: its caption, title or question, else what it is. */
export function blockWords(json: string): string {
  let b: { kind?: unknown; caption?: unknown; title?: unknown; question?: unknown; name?: unknown; number?: unknown };
  try {
    b = JSON.parse(json) as typeof b;
  } catch {
    return "";
  }
  const own = [b.caption, b.title, b.question, b.name].find((w): w is string => typeof w === "string" && w.trim() !== "");
  if (b.kind === "pr") return `Pull request #${String(b.number ?? "")}${own === undefined ? "" : `: ${own}`}`;
  if (own !== undefined) return own;
  const what: Record<string, string> = { diff: "A diff", agent: "An agent", image: "Photo", clip: "Clip", file: "File", table: "A table", checklist: "A checklist", chart: "A chart" };
  return typeof b.kind === "string" ? (what[b.kind] ?? "") : "";
}

/**
 * A message's text as the chat shows it: each fleetd block by its words, a link by its label, no bold or italic marks.
 * A hit's line, a pin's line and the index read this, never the JSON of a block or a link's target.
 */
export function shownText(text: string): string {
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[ \t]*fleetd-block[^\n]*\n([\s\S]*?)(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gmu, (_all, _fence: string, json: string) => `${blockWords(json)}\n`)
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/gu, "$1")
    // Bold marks go, but never inside code (`__init__.py` stays) nor `__` within a word, which Markdown keeps too.
    .split(/(`+[^`]*?`+)/u)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, (_all, a?: string, b?: string) => a ?? b ?? "")))
    .join("");
}

/** What the index holds of a message: its text as the chat shows it. */
export const indexedText = (m: { text: string }) => shownText(m.text);
/** Whether a message is in the index: once its text is final. */
export const indexed = (m: { state: string }) => m.state !== "streaming";

/** `s` as the index compares it: accents and other marks removed, lower case. */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The folded words of `s`: its runs of letters and numbers. */
export const tokensOf = (s: string) => fold(s).match(TOKEN) ?? [];

/**
 * `words` as terms: a bare word matches the start of a word (`deplo` finds "deployed"), a "quoted phrase" its words
 * in a row, exactly. A bare word with marks inside (`chat_find`) is the phrase of its parts, the last one a start.
 * A term with no letters or numbers is dropped; an unclosed quote runs to the end.
 */
export function parseWords(words: string): Term[] {
  const out: Term[] = [];
  for (const m of words.matchAll(/"([^"]*)"?|([^\s"]+)/gu)) {
    const phrase = m[1] !== undefined;
    const tokens = tokensOf(phrase ? m[1]! : m[2]!);
    if (tokens.length > 0) out.push({ tokens, prefix: !phrase });
  }
  return out;
}

/** What `m` holds, of what `has` asks for; `pinned` is the chat's to say. */
export function holds(m: { text: string; attachments?: AttachmentRef[] }): ChatFindHas[] {
  const out: ChatFindHas[] = [];
  if (/https?:\/\//i.test(m.text)) out.push("link");
  const files = m.attachments ?? [];
  if (files.some((a) => a.mime.startsWith("image/"))) out.push("image");
  if (files.some((a) => !a.mime.startsWith("image/"))) out.push("file");
  if (/\/pull\/[0-9]|#[0-9]/.test(m.text)) out.push("pr");
  return out;
}

/** `text` folded, with the span in `text` of the character each folded code unit came from. */
function folded(text: string): { s: string; from: number[]; to: number[] } {
  let s = "";
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) {
      from.push(i);
      to.push(i + ch.length);
    }
    s += f;
    i += ch.length;
  }
  return { s, from, to };
}

/** Where `terms` are in `text`: `[start, end)` in UTF-16 code units of `text`, sorted, merged where they meet. */
export function marksOf(text: string, terms: Term[]): [number, number][] {
  const { s, from, to } = folded(text);
  const found: [number, number][] = [];
  for (const term of terms) {
    const body = term.tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}${term.prefix ? "" : "(?![\\p{L}\\p{N}])"}`, "gu");
    for (const m of s.matchAll(re)) found.push([from[m.index]!, to[m.index + m[0].length - 1]!]);
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [start, end] of found) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** A message's first line with text, else its first attachment's name, at most LINE_CHARS characters. */
export function firstLine(m: { text: string; attachments?: AttachmentRef[] }): string {
  const line = shownText(m.text).split("\n").map((l) => l.trim()).find((l) => l !== "") ?? m.attachments?.[0]?.name ?? "";
  return cut(line, LINE_CHARS);
}

/** `text` at most `max` characters (code points), `…` in place of the rest. */
export function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * A hit's line: the message on one line (whitespace folded), at most LINE_CHARS characters starting a little before
 * its first mark (shorter near the message's end), `…` where cut; a message with no text shows its first attachment's name. Its marks are in that line.
 */
export function hitText(text: string, attachments: AttachmentRef[] | undefined, terms: Term[]): { text: string; marks: [number, number][] } {
  const line = shownText(text).replace(/\s+/gu, " ").trim() || (attachments?.[0]?.name ?? "");
  const marks = marksOf(line, terms);
  const chars = [...line];
  if (chars.length <= LINE_CHARS) return { text: line, marks };
  // Code points, for the window; UTF-16 offsets of each, for the marks.
  const at: number[] = [];
  let u = 0;
  for (const c of chars) {
    at.push(u);
    u += c.length;
  }
  at.push(u);
  const firstCp = marks.length === 0 ? 0 : at.findIndex((x) => x >= marks[0]![0]);
  // Never pulled back from the message's end for more words before: the match stays near the line's start, where an
  // app that shows two lines of it (the phone's search) still shows it, and is never cut by the end's `…`.
  const start = Math.max(0, firstCp - Math.floor(LINE_CHARS / 3));
  // Room for the `…`s inside the line's characters.
  const head = start > 0 ? 1 : 0;
  let take = Math.min(LINE_CHARS - head, chars.length - start);
  if (start + take < chars.length) take -= 1;
  const lo = at[start]!;
  const hi = at[start + take]!;
  const lead = head ? "…" : "";
  const out = lead + line.slice(lo, hi) + (start + take < chars.length ? "…" : "");
  const shift = lead.length - lo;
  const inside = marks
    .filter(([s, e]) => e > lo && s < hi)
    .map(([s, e]): [number, number] => [Math.max(s, lo) + shift, Math.min(e, hi) + shift]);
  return { text: out, marks: inside };
}
