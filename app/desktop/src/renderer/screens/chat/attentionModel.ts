// What the lead is waiting on you for, in a few words, for the quiet line above the composer: an open approval or
// secret first (the lead can't go on without it), else its newest message's questions. Pure.
import type { ChatItem } from "../../src/data/chat";
import { bubblesOf } from "./bubbles";
import { plural, shortClock } from "./format";
import { dayLabel } from "./model";

/** One place Show goes: an item, and in a lead message the bubble that asks. */
export interface WaitTarget {
  readonly id: string;
  /** The bubble's key (bubblesOf); absent for an approval or a secret, which are one card. */
  readonly part?: string | undefined;
}

export interface Waiting {
  /** "2 questions, asked at 09:02", "1 command to approve". */
  readonly what: string;
  /** Where Show goes, a press each, in the chat's order; none when it isn't loaded (paged away). */
  readonly targets: readonly WaitTarget[];
}

const openItem = (i: ChatItem): boolean => (i.kind === "secret" || i.kind === "gated") && i.message?.item?.state === "open";

/** Numbered items at the start of a line ("1. …", "2) …"): the lead asks its questions as a numbered list. */
export const countQuestions = (text: string): number => {
  const numbered = text.split("\n").filter((l) => /^ {0,3}\d{1,2}[.)]\s+\S/.test(l)).length;
  return numbered > 0 ? numbered : text.includes("?") ? 1 : 0;
};

const when = (iso: string, nowMs: number, timeZone?: string): string => {
  const clock = shortClock(iso, timeZone);
  const day = dayLabel(iso, nowMs, timeZone);
  if (day === "Today") return `at ${clock}`;
  return `${day === "Yesterday" ? "yesterday" : day} at ${clock}`;
};

export function waitingOn(items: readonly ChatItem[], nowMs: number, timeZone?: string): Waiting {
  const open = items.filter(openItem);
  if (open.length > 0) {
    const approvals = open.filter((i) => i.kind === "gated").length;
    const secrets = open.length - approvals;
    const parts = [approvals > 0 ? `${plural(approvals, "command")} to approve` : "", secrets > 0 ? `${plural(secrets, "secret")} to enter` : ""];
    return { what: parts.filter((p) => p !== "").join(", "), targets: open.map((i) => ({ id: i.id })) };
  }
  const ask = items.findLast((i) => i.author === "lead" && i.kind === "message");
  if (ask === undefined) return { what: "a reply", targets: [] };
  // Each bubble that asks (an ask block, or words with a question in them), else the message's last.
  const bubbles = bubblesOf(ask);
  const asking = bubbles.map((b) => ({ key: b.key, n: b.kind === "block" ? (b.block.kind === "ask" ? 1 : 0) : countQuestions(b.text) })).filter((b) => b.n > 0);
  const n = asking.length > 1 ? asking.reduce((sum, b) => sum + b.n, 0) : Math.max(countQuestions(ask.text), asking.length);
  const parts = asking.length > 0 ? asking.map((b) => b.key) : [bubbles.at(-1)?.key];
  return {
    what: n > 0 ? `${plural(n, "question")}, asked ${when(ask.at, nowMs, timeZone)}` : `a reply to its message ${when(ask.at, nowMs, timeZone)}`,
    targets: parts.map((part) => ({ id: ask.id, part })),
  };
}
