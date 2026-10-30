// Detectors for machine text that must never be primary UI text (the APP-WIDE TEXT RULE): internal ids, hashes and
// keys go behind a copy/details control, and markdown is rendered, never shown as syntax. They run inside the page
// (bundled into the checks) and in unit tests, so this file has no imports and no DOM.

export type RawTextKind = "uuid" | "hash" | "slug" | "markdown";

export interface RawTextHit {
  kind: RawTextKind;
  match: string;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Seven or more hex characters with at least one digit and one letter: commit shas, brief hashes, prompt refs.
// Pure-digit runs are numbers and pure-letter runs are words ("defaced"), so both are left alone.
const HASH = /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi;
// share.public_link, prompt ids like lead.wake.answers_since_last
const DOTTED = /(?<![\w./-])[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+(?![\w/-])/g;
// waiting_on_you, pay_comparison: English never uses underscores between words.
const SNAKE = /(?<![\w./-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w/-])/g;
// a-monthly-vs-week: three or more lowercase segments, none of them a bare number (2026-10-19 is a date,
// last-7-days is English). Two-segment words ("follow-up") are too often English.
const KEBAB = /(?<![\w./-])[a-z0-9]+(?:-[a-z0-9]+){2,}(?![\w/-])/g;

// Explicit and small: dotted tokens that are file names or hostnames, and hyphenated English words. A last part of two
// letters is a country's domain (example.com.au).
const FILE_OR_HOST_SUFFIXES = new Set([
  "json",
  "md",
  "ts",
  "tsx",
  "js",
  "rs",
  "py",
  "go",
  "swift",
  "toml",
  "yaml",
  "yml",
  "html",
  "css",
  "csv",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "mp4",
  "mov",
  "zip",
  "sh",
  "txt",
  "log",
  "com",
  "dev",
  "io",
  "org",
  "net",
  "app",
  "local",
]);
const ENGLISH_HYPHENATED = new Set([
  "up-to-date",
  "out-of-date",
  "end-to-end",
  "day-to-day",
  "side-by-side",
  "step-by-step",
  "one-to-one",
  "all-in-one",
  "state-of-the-art",
]);

function isAllowedDotted(token: string) {
  const parts = token.split(".");
  if (parts.some((p) => p.length < 2)) return true; // e.g., i.e., a.m.
  if (parts.slice(1).every((p) => /^\d+$/.test(p))) return true; // v1.2.3
  const last = parts[parts.length - 1] ?? "";
  return FILE_OR_HOST_SUFFIXES.has(last) || /^[a-z]{2}$/.test(last);
}

function collect(re: RegExp, text: string, keep: (m: string) => boolean, kind: RawTextKind, out: RawTextHit[]) {
  for (const m of text.matchAll(re)) if (keep(m[0])) out.push({ kind, match: m[0] });
}

// Markdown that a renderer would have consumed. Line-start forms only count at the start of a line of the block's
// own text, so " - " inside a sentence is fine.
const MARKDOWN: readonly RegExp[] = [
  /(?:^|\n)[ \t]*#{1,6}[ \t]+\S[^\n]*/,
  /(?:^|\n)[ \t]*[-*+][ \t]+\S[^\n]*/,
  /(?:^|\n)[ \t]*>[ \t]+\S[^\n]*/,
  /(?:^|\n)[ \t]*```/,
  /\*\*[^*\n]+\*\*/,
  /(?:^|[\s(])__[^_\n]+__/,
  /`[^`\n]+`/,
  /\[[^\]\n]+\]\([^)\s]+\)/,
];

export function findRawText(text: string): RawTextHit[] {
  const out: RawTextHit[] = [];
  collect(UUID, text, () => true, "uuid", out);
  const withoutUuids = text.replace(UUID, " ");
  collect(HASH, withoutUuids, () => true, "hash", out);
  collect(DOTTED, withoutUuids, (m) => !isAllowedDotted(m), "slug", out);
  collect(SNAKE, withoutUuids, () => true, "slug", out);
  collect(KEBAB, withoutUuids, (m) => /[a-z]/.test(m) && !/(^|-)\d+(-|$)/.test(m) && !ENGLISH_HYPHENATED.has(m), "slug", out);
  for (const re of MARKDOWN) {
    const m = re.exec(text);
    if (m) out.push({ kind: "markdown", match: m[0].trim() });
  }
  return out;
}
