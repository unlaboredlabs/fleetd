// The composer's rules, pure: where an order goes, which type it is, the @ menu's query, and why it can't be sent.
// Ported from the GPUI composer (composer.rs); the hub reads prefixes the same way (intake/prefix.rs).
import type { IntakeRef, PlaybookName } from "./contracts";

/** The hub's limit on an order's text (IntakeText), in UTF-8 bytes. */
export const MAX_BYTES = 4000;
/** A paste longer than this becomes a `pasted-N.txt` attachment (T3 Code's large-paste rule, under the limit). */
export const PASTE_AS_FILE = 3500;
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const TEMPLATES: readonly PlaybookName[] = ["feature", "bugfix", "research", "finish-all"];

export const TEMPLATE_LABEL: Record<PlaybookName, string> = {
  feature: "Feature",
  bugfix: "Bug",
  research: "Research",
  "finish-all": "Finish everything",
};

export const TEMPLATE_HINT: Record<PlaybookName, string> = {
  feature: "build something",
  bugfix: "fix: prefix",
  research: "research: prefix",
  "finish-all": "finish: prefix",
};

/** The type a `fix:`/`bug:`/`research:`/`finish:` prefix asks for; the prefix stays in the text. */
export const templateFromPrefix = (text: string): PlaybookName | undefined => {
  const colon = text.trimStart().indexOf(":");
  if (colon < 0) return undefined;
  switch (text.trimStart().slice(0, colon).trim().toLowerCase()) {
    case "fix":
    case "bug":
    case "bugfix":
      return "bugfix";
    case "research":
      return "research";
    case "finish":
      return "finish-all";
    case "feature":
    case "feat":
      return "feature";
    default:
      return undefined;
  }
};

/**
 * The `@query` the caret is in, if any: an `@` at the start or after whitespace, then no whitespace up to the
 * caret. Returns the `@`'s offset and the query.
 */
export const mentionAt = (text: string, caret: number): { start: number; query: string } | undefined => {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return undefined;
  const query = before.slice(at + 1);
  const startsWord = at === 0 || /\s$/u.test(before.slice(0, at));
  return startsWord && !/\s/u.test(query) ? { start: at, query } : undefined;
};

export interface Target {
  readonly key: string;
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
  readonly machine: string;
  readonly offline: boolean;
}

/** A leading `@<project> ` picks the project, as the hub's prefix parser does. */
export const projectPrefix = (text: string, targets: readonly Target[]): Target | undefined => {
  const m = /^@(\S+)\s/u.exec(text);
  return m ? targets.find((t) => t.projectId === m[1] || t.title === m[1]) : undefined;
};

/** Where the project picker's choice came from; the label says it. */
export type Source = "chosen" | "prefix" | "selected" | "guess" | "last" | "any";

export interface TargetInputs {
  /** The user's pick: a project key, `null` for "Any project: the hub picks", undefined when not picked. */
  readonly chosen: string | null | undefined;
  readonly text: string;
  readonly targets: readonly Target[];
  /** The project selected on the board (a sidebar click): the default. */
  readonly selected: string | undefined;
  /** The router's guess for this text. */
  readonly guess: string | undefined;
  readonly lastUsed: string | undefined;
}

/** The project the order goes to, and why. */
export const resolveTarget = (i: TargetInputs): { key: string | undefined; source: Source } => {
  if (i.chosen !== undefined) return i.chosen === null ? { key: undefined, source: "any" } : { key: i.chosen, source: "chosen" };
  const prefix = projectPrefix(i.text, i.targets);
  if (prefix) return { key: prefix.key, source: "prefix" };
  if (i.selected !== undefined) return { key: i.selected, source: "selected" };
  if (i.guess !== undefined) return { key: i.guess, source: "guess" };
  if (i.lastUsed !== undefined) return { key: i.lastUsed, source: "last" };
  return { key: undefined, source: "any" };
};

const utf8 = new TextEncoder();

/** The trimmed text, or why it can't be sent as typed. */
export const checkText = (text: string): { ok: true; text: string } | { ok: false; reason: string } => {
  const t = text.trim();
  if (t === "") return { ok: false, reason: "Write the order first." };
  const bytes = utf8.encode(t).length;
  if (bytes > MAX_BYTES) {
    return { ok: false, reason: `Orders are at most ${MAX_BYTES} bytes; this one is ${bytes}. Attach the detail as a file.` };
  }
  return { ok: true, text: t };
};

/** How many characters differ between two texts, ignoring their common start and end. */
export const changedChars = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  return Math.max(x.length, y.length) - pre - suf;
};

/** The router guess is asked for after a pause, for text this long that changed this much since the last guess. */
export const PREVIEW_PAUSE_MS = 600;
export const wantsPreview = (text: string, lastPreview: string): boolean =>
  Array.from(text.trim()).length >= 12 && changedChars(text.trim(), lastPreview) >= 8;

/** The mime type the hub takes for a file; undefined when it isn't an image, text or PDF. */
export const mimeFor = (name: string, looksText: boolean): string | undefined => {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const known: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
  };
  return known[ext] ?? (looksText ? "text/plain" : undefined);
};

export const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.floor(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`;

export type MentionItem =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "order"; readonly id: string; readonly title: string }
  | { readonly kind: "pr"; readonly number: number; readonly url: string; readonly title: string };

/** What the @ inserts in the text: readable for the lead, the ref carries the exact target. */
export const mentionText = (m: MentionItem): string =>
  m.kind === "file" ? `\`${m.path}\`` : m.kind === "order" ? m.id : `#${m.number}`;

export const mentionRef = (m: MentionItem): IntakeRef =>
  m.kind === "file" ? { kind: "file", path: m.path } : m.kind === "order" ? { kind: "order", workstreamId: m.id } : { kind: "pr", url: m.url };

/** A loose in-order character match, so "ctt" finds "cart/total.ts". */
export const fuzzy = (query: string, s: string): boolean => {
  let i = 0;
  const q = query.toLowerCase();
  for (const c of s.toLowerCase()) if (c === q[i]) i++;
  return i === q.length;
};

/** The @ menu: up to 5 files (the hub's best matches), then 4 open orders and 4 PRs that match. */
export const mentionItems = (
  query: string,
  files: readonly string[],
  orders: readonly { id: string; title: string }[],
  prs: readonly { number: number; url: string; title: string }[],
): MentionItem[] => [
  ...files.slice(0, 5).map((path): MentionItem => ({ kind: "file", path })),
  ...orders
    .filter((o) => fuzzy(query, `${o.id} ${o.title}`))
    .slice(0, 4)
    .map((o): MentionItem => ({ kind: "order", ...o })),
  ...prs
    .filter((p) => fuzzy(query, `#${p.number} ${p.title}`))
    .slice(0, 4)
    .map((p): MentionItem => ({ kind: "pr", ...p })),
];
