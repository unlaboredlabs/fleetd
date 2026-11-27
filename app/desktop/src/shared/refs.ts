// fleetd's numbered ids as agents and leads write them in text a person reads ("T5945 finished W890"): the apps show
// each as a chip with the thing's name (the renderer's RefChip, the phone's RefName), never the id. Shared by both.

/** What a numbered id names. */
export type RefKind = "agent" | "order" | "decision" | "request" | "ask" | "message" | "steer" | "change" | "claim" | "file";

const KIND: Readonly<Record<string, RefKind>> = {
  T: "agent",
  W: "order",
  D: "decision",
  Q: "request",
  N: "ask",
  M: "message",
  S: "steer",
  X: "change",
  C: "claim",
  F: "file",
};

/** The plain word for one whose name isn't known, or that is gone. */
export const REF_WORD: Readonly<Record<RefKind, string>> = {
  agent: "an agent",
  order: "an order",
  decision: "a decision",
  request: "a request",
  ask: "a question",
  message: "a message",
  steer: "a steer",
  change: "a change",
  claim: "a claim",
  file: "a file",
};

/** A chip's word for its kind, in its tooltip beside the id: "Agent T12". */
export const REF_NOUN: Readonly<Record<RefKind, string>> = {
  agent: "Agent",
  order: "Order",
  decision: "Decision",
  request: "Request",
  ask: "Question",
  message: "Message",
  steer: "Steer",
  change: "Change",
  claim: "Claim",
  file: "File",
};

export interface Ref {
  readonly id: string;
  readonly kind: RefKind;
  /** It opens a sentence: its plain word is capitalized ("An agent finished"). */
  readonly opens: boolean;
}

// A whole token: not inside a branch (fleetd/T12-x), a path, a hash (#T1), a mention or a longer word. T, W, D and F
// are ours from one digit (a young workspace's D5 or F2); the rest also name everyday things at one digit (an M1 Mac,
// Q4, S3, R2), so they need two.
const REF = /(?<![\w#@/.\\-])([TWDQNMSXCF])([1-9]\d{0,7})(?![\w-]|\.\w)/gu;
// Two-digit tokens that are something else first: the X11 display server. (F12 is a file far more often than a key in
// what agents write: the lead names attachments so.)
const NOT_OURS = new Set(["X11"]);

const FROM_ONE: ReadonlySet<RefKind> = new Set(["agent", "order", "decision", "file"]);

const kindOf = (letter: string, digits: string): RefKind | undefined => {
  const kind = KIND[letter];
  if (kind === undefined) return undefined;
  if (!FROM_ONE.has(kind) && digits.length < 2) return undefined;
  return NOT_OURS.has(`${letter}${digits}`) ? undefined : kind;
};

/** The id's kind when `text` is exactly one id (an inline code span of one), else undefined. */
export const refOf = (text: string): RefKind | undefined => {
  const m = /^([TWDQNMSXCF])([1-9]\d{0,7})$/u.exec(text.trim());
  return m === null ? undefined : kindOf(m[1] ?? "", m[2] ?? "");
};

// A person fleetd names in a line of its own, as a mention (the hub's people/mention.ts): `[Ada](person:p_1)`.
// It reads as the name alone, and nothing in the name is an id: "Check T6168" is a person, not an agent.
const MENTION = /\[((?:\\[\\[\]]|[^\\[\]\n])*)\]\(person:[\w-]*\)/gu;
const unescaped = (name: string) => name.replace(/\\([\\[\]])/gu, "$1");

/** The person's mention `text` starts with: their name, and how long the mention is. */
export const mentionAt = (text: string): { name: string; length: number } | undefined => {
  const m = new RegExp(`^${MENTION.source}`, "u").exec(text);
  return m === null ? undefined : { name: unescaped(m[1] ?? ""), length: m[0].length };
};

/**
 * `text` as runs of words and ids, in order; text with no id is one run, itself. A person's mention is in the words as
 * their name.
 */
export function splitRefs(text: string): Array<string | Ref> {
  const named = [...text.matchAll(MENTION)].map((m) => ({ start: m.index, end: m.index + m[0].length, name: unescaped(m[1] ?? "") }));
  const out: Array<string | Ref> = [];
  const say = (words: string) => {
    if (words === "") return;
    const at = out.length - 1;
    if (typeof out[at] === "string") out[at] += words;
    else out.push(words);
  };
  let last = 0;
  // The words from `last` to `end`, each mention in them as its name.
  const wordsTo = (end: number) => {
    for (const n of named) {
      if (n.start < last || n.start >= end) continue;
      say(text.slice(last, n.start));
      say(n.name);
      last = n.end;
    }
    say(text.slice(last, end));
    last = end;
  };
  for (const m of text.matchAll(REF)) {
    if (named.some((n) => m.index >= n.start && m.index < n.end)) continue;
    const kind = kindOf(m[1] ?? "", m[2] ?? "");
    if (kind === undefined) continue;
    wordsTo(m.index);
    // What comes just before it: nothing, or the end of a sentence or line.
    const near = text.slice(Math.max(0, m.index - 8), m.index);
    const opens = (m.index <= 8 && near.trim() === "") || /(?:[.!?:]\s+|\n\s*)$/u.test(near);
    out.push({ id: m[0], kind, opens });
    last = m.index + m[0].length;
  }
  wordsTo(text.length);
  return out.length === 0 ? [text] : out;
}

/** `text`'s words as the apps read them: each person's mention as their name, ids as written. */
export const shownWords = (text: string): string => splitRefs(text).map((r) => (typeof r === "string" ? r : r.id)).join("");

/** Whether `text` holds an id the apps would show as a chip. */
export const hasRefs = (text: string): boolean => splitRefs(text).some((r) => typeof r !== "string");

/** The plain word for `ref`, capitalized where it opens a sentence. */
export const refWord = (ref: Ref): string => {
  const word = REF_WORD[ref.kind];
  return ref.opens ? word.charAt(0).toUpperCase() + word.slice(1) : word;
};
