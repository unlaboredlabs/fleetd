// What the lead is waiting on you for, in a few words, for the quiet line above the composer: an open approval or
// secret first (the lead can't go on without it), loaded or not, else the questions of its newest message since you last wrote that
// asks any; nothing when it asks nothing. Below all of that, what there is to look at: the messages the lead nudged
// you about (a showcase, something to try, a risk) and agents' Try it suggestions, until seen. Pure.
import type { ChatOpenItem, ChatOpenNudge } from "../../../shared/contracts";
import type { ChatItem } from "../../src/data/chat";
import { bubblesOf } from "./bubbles";
import { plural, shortClock } from "./format";
import { dayLabel, isMine } from "./model";

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

/** What the chat knows beyond its loaded items. */
export interface Unloaded {
  /** Older pages aren't loaded. */
  readonly older: boolean;
  /** The hub's open items (ProjectChatState.openItems), on any page. */
  readonly open?: readonly ChatOpenItem[] | undefined;
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

export function waitingOn(items: readonly ChatItem[], { older, open: away = [] }: Unloaded, nowMs: number, timeZone?: string, me?: string): Waiting | undefined {
  // A loaded item goes by its own state, which may be newer than the hub's list; the rest by the list, oldest first,
  // which comes before what's loaded.
  const loaded = new Set(items.map((i) => i.id));
  const unloaded = away.filter((o) => !loaded.has(o.messageId) && (o.kind === "command_approval" || o.kind === "secret_request"));
  // A proposed Try it setting is an approval too, said as what it is once its page is loaded.
  const kindOf = (i: ChatItem) => (i.kind !== "gated" ? "secret" : i.message?.item?.kind === "command_approval" && i.message.item.previewConfig !== undefined ? "setting" : "command");
  const open = [...unloaded.map((o) => ({ id: o.messageId, kind: o.kind === "command_approval" ? "command" : "secret" })), ...items.filter(openItem).map((i) => ({ id: i.id, kind: kindOf(i) }))];
  if (open.length > 0) {
    const count = (kind: string) => open.filter((i) => i.kind === kind).length;
    const [approvals, settings, secrets] = [count("command"), count("setting"), count("secret")];
    const parts = [
      approvals > 0 ? `${plural(approvals, "command")} to approve` : "",
      settings > 0 ? `${plural(settings, "Try it setting")} to approve` : "",
      secrets > 0 ? `${plural(secrets, "secret")} to enter` : "",
    ];
    return { what: parts.filter((p) => p !== "").join(", "), targets: open.map((i) => ({ id: i.id })) };
  }
  // The newest lead message since you last wrote that asks something: a later status line doesn't answer it, nor
  // does a teammate's message (`me`: the person this app acts as).
  const since = items.findLastIndex((i) => isMine(i, me) && i.kind === "message") + 1;
  for (const ask of items.slice(since).reverse()) {
    if (ask.author !== "lead" || ask.kind !== "message") continue;
    // Each bubble that asks: an ask block, or words with a question in them.
    const asking = bubblesOf(ask)
      .map((b) => ({ key: b.key, n: b.kind === "block" ? (b.block.kind === "ask" ? 1 : 0) : countQuestions(b.text) }))
      .filter((b) => b.n > 0);
    if (asking.length === 0) continue;
    const n = asking.length > 1 ? asking.reduce((sum, b) => sum + b.n, 0) : Math.max(countQuestions(ask.text), 1);
    return { what: `${plural(n, "question")}, asked ${when(ask.at, nowMs, timeZone)}`, targets: asking.map((b) => ({ id: ask.id, part: b.key })) };
  }
  // A plain status line asks nothing; only a page not loaded can hold the wait, and only if you haven't written since.
  return older && since === 0 ? { what: "a reply", targets: [] } : undefined;
}

/** A message worth a look, still waiting: where Show goes, and what to look at there. */
export interface LookAt extends WaitTarget {
  readonly reason: string;
  /** This flag of it (`id` and when it was flagged): one flagged again after it was seen is a new one. */
  readonly key: string;
}

/** A flag's key: its message, and when it was flagged. */
export const lookKey = (id: string, at: string): string => `${id} ${at}`;

/** How long a nudge waits to be seen (contracts CHAT_NUDGE_MS); past it, it fades on its own. */
export const NUDGE_MS = 24 * 60 * 60_000;

/** Whether two lists say the same: the same flags, going to the same bubbles, for the same reasons. */
export const sameLooks = (a: readonly LookAt[], b: readonly LookAt[]): boolean =>
  a.length === b.length && a.every((l, i) => l.key === b[i]?.key && l.part === b[i].part && l.reason === b[i].reason);

/**
 * What there is to look at, oldest first: the hub's waiting nudges, less those this app cleared since (seen or
 * dismissed, by their key), those a loaded message says no longer wait (that same flag of it), and those a day old.
 * Show goes to a lead message's first bubble, and to a Try it line as it is.
 */
export function lookingAt(nudges: readonly ChatOpenNudge[] | undefined, items: readonly ChatItem[] | undefined, cleared: ReadonlySet<string>, nowMs: number): readonly LookAt[] {
  if (nudges === undefined) return [];
  const loaded = new Map((items ?? []).map((i) => [i.id, i]));
  return nudges.flatMap((n) => {
    const item = loaded.get(n.messageId);
    const key = lookKey(n.messageId, n.at);
    const flag = item?.message?.nudge;
    const done = cleared.has(key) || (flag?.at === n.at && flag.cleared !== undefined) || nowMs - Date.parse(n.at) >= NUDGE_MS;
    if (done) return [];
    const part = item?.kind === "message" ? bubblesOf(item)[0]?.key : undefined;
    return [{ id: n.messageId, part, reason: n.reason, key }];
  });
}
