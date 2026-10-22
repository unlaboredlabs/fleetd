// What the lead is waiting on you for, in a few words, for the quiet line above the composer: an open approval or
// secret first (the lead can't go on without it), else its newest message's questions. Pure.
import type { ChatItem } from "../../src/data/chat";
import { plural, shortClock } from "./format";
import { dayLabel } from "./model";

export interface Waiting {
  /** "2 questions, asked at 09:02", "1 command to approve". */
  readonly what: string;
  /** The item Show jumps to; absent when it isn't loaded (paged away). */
  readonly target?: string | undefined;
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
    return { what: parts.filter((p) => p !== "").join(", "), target: open[0]?.id };
  }
  const ask = items.findLast((i) => i.author === "lead" && i.kind === "message");
  if (ask === undefined) return { what: "a reply" };
  const n = countQuestions(ask.text);
  return { what: n > 0 ? `${plural(n, "question")}, asked ${when(ask.at, nowMs, timeZone)}` : `a reply to its message ${when(ask.at, nowMs, timeZone)}`, target: ask.id };
}
