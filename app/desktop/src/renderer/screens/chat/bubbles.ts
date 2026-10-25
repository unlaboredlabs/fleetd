// A message as the bubbles it shows, and the two things you add to a lead's bubble: a reply, and a tapback. Pure.
//
// A lead message the hub split (`parts`) is one bubble per part, a block where the part has one this build knows;
// any other text is one bubble. A reply travels as plain chat text, a one-line quote of the bubble then a blank line,
// so the lead reads exactly what you answered and every client (the CLI too) shows it as it is. Tapbacks stay on this
// device: a heart or a laugh isn't worth a lead's turn. Only 👍 on something waiting for you is sent: as the ask's
// Approve when the bubble asks, as a 👍 reply to the bubble the lead waits on otherwise.
import type { ChatBlock } from "../../../shared/contracts";
import type { ChatItem } from "../../src/data/chat";

/** The block schema this build reads (the hub's BLOCK_VERSION). A newer one shows as its text. */
export const BLOCK_VERSION = 1;

export type Bubble =
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | { readonly kind: "block"; readonly key: string; readonly block: ChatBlock; readonly text: string };

const KINDS = new Set(["chart", "table", "diff", "pr", "agent", "checklist", "image", "clip", "ask"]);

const isStrings = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Whether this build can draw the block: a kind and version it knows, with the fields its renderer reads. The hub
 * checked it against its own schema, but a newer hub's schema may differ, and a block that fails here shows as text.
 */
export function readable(block: ChatBlock): boolean {
  if (block.v !== BLOCK_VERSION || !KINDS.has(block.kind)) return false;
  switch (block.kind) {
    case "chart":
      return (
        isStrings(block.x) &&
        block.x.length > 0 &&
        Array.isArray(block.series) &&
        block.series.length > 0 &&
        block.series.every((s) => Array.isArray(s.values) && s.values.length === block.x.length && s.values.every(Number.isFinite))
      );
    case "table":
      return isStrings(block.columns) && Array.isArray(block.rows) && block.rows.every(isStrings);
    case "diff":
      return (block.files !== undefined) !== (block.pr !== undefined) && (block.files ?? []).every((f) => typeof f.path === "string" && isStrings(f.hunks));
    case "pr":
      return typeof block.repo === "string" && Number.isInteger(block.number);
    case "agent":
      return (block.taskId !== undefined) !== (block.threadRef !== undefined);
    case "checklist":
      return Array.isArray(block.items) && block.items.every((i) => typeof i.text === "string");
    case "image":
    case "clip":
      return typeof block.attachmentId === "string";
    case "ask":
      return typeof block.question === "string" && (block.options === undefined || (isStrings(block.options) && block.options.length > 0));
  }
  return false;
}

/** The bubbles of a message, in order; none while it streams (the typing bubble stands in). */
export function bubblesOf(item: ChatItem): readonly Bubble[] {
  if (item.state === "streaming") return [];
  const parts = item.message?.parts;
  if (parts === undefined || parts.length === 0) return item.text.trim() === "" ? [] : [{ kind: "text", key: "0", text: item.text }];
  const out: Bubble[] = [];
  parts.forEach((p, n) => {
    const text = item.text.slice(p.start, p.end).trim();
    if (p.block !== undefined && readable(p.block)) out.push({ kind: "block", key: String(n), block: p.block, text });
    else if (text !== "") out.push({ kind: "text", key: String(n), text });
  });
  return out;
}

/** Blocks that take the column's width rather than a bubble's. */
export const isWide = (b: Bubble): boolean => b.kind === "block" && (b.block.kind === "chart" || b.block.kind === "table" || b.block.kind === "diff");

// ---- replies ----

const QUOTE_MAX = 90;

/** A bubble's first line as plain words, for its quote: markdown marks and fences out, cut to a line. */
export function quoteOf(text: string): string {
  const line =
    text
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d{1,2}[.)]\s+)/, "")
          .replace(/[*_~`]/g, "")
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .trim(),
      )
      .find((l) => l !== "") ?? "";
  return line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX - 1).trimEnd()}…` : line;
}

/** Your words as a reply to a bubble: its quote, a blank line, then what you wrote. */
export const replyText = (quote: string, text: string): string => `> ${quote}\n\n${text}`;

/** A message that replies to a bubble: the quote and the words under it. Undefined for any other text. */
export function replyOf(text: string): { readonly quote: string; readonly body: string } | undefined {
  const m = /^> ([^\n]+)\n\n(?!>)([\s\S]*\S[\s\S]*)$/.exec(text);
  if (m === null) return undefined;
  return { quote: m[1] ?? "", body: m[2] ?? "" };
}

/** The bubble a quote names: the newest lead bubble before `before` whose first line it is. */
export function quoted(items: readonly ChatItem[], before: number, quote: string): string | undefined {
  const words = quote.endsWith("…") ? quote.slice(0, -1) : quote;
  for (let n = before - 1; n >= 0; n--) {
    const item = items[n];
    if (item === undefined || item.author !== "lead" || item.kind !== "message") continue;
    if (bubblesOf(item).some((b) => b.kind === "text" && quoteOf(b.text).startsWith(words))) return item.id;
  }
  return undefined;
}

// ---- tapbacks ----

export const TAPBACKS = ["👍", "👎", "❤️", "😂", "‼️", "❓"] as const;
export type Tapback = (typeof TAPBACKS)[number];

/** A tapback's name, for its button and the badge's label. */
export const TAPBACK_WORD: Readonly<Record<Tapback, string>> = {
  "👍": "Like",
  "👎": "Dislike",
  "❤️": "Love",
  "😂": "Laugh",
  "‼️": "Emphasize",
  "❓": "Question",
};

/** What a tapback on a lead bubble sends, if anything: only 👍, on an open ask or the bubble the lead waits on. */
export type TapbackSend = { readonly t: "answer"; readonly text: string } | { readonly t: "reply"; readonly text: string } | undefined;

export function tapbackSend(t: Tapback, bubble: Bubble, waitedOn: boolean, askOpen: boolean): TapbackSend {
  if (t !== "👍") return undefined;
  if (bubble.kind === "block" && bubble.block.kind === "ask") return askOpen && bubble.block.options === undefined ? { t: "answer", text: "Approve" } : undefined;
  if (!waitedOn) return undefined;
  const quote = quoteOf(bubble.text);
  return { t: "reply", text: quote === "" ? "👍" : replyText(quote, "👍") };
}

// ---- asks ----

/** An ask's answer: the first message of yours after it whose words are one of its buttons. */
export function askAnswer(items: readonly ChatItem[], at: number, options: readonly string[] | undefined): string | undefined {
  const labels = options ?? ["Approve", "Deny"];
  for (let n = at + 1; n < items.length; n++) {
    const item = items[n];
    if (item?.author !== "human" || item.state === "failed") continue;
    const words = (replyOf(item.text)?.body ?? item.text).trim();
    const hit = labels.find((l) => l.toLowerCase() === words.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return undefined;
}
