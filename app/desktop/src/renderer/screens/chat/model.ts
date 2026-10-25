// The chat as rows: day dividers, a quiet time where the conversation picked up again after a pause, messages as
// bubbles grouped by author (a run from one author within a few minutes draws as one stack; an agent's names it once),
// event one-liners (fleetd's own messages among them), inline items, the live
// strip under the lead's newest message (and the field that answers it), where you stopped reading, and the top of the
// history.
import type { ChatItem } from "../../src/data/chat";
import { askAnswer, bubblesOf, quoted, replyOf } from "./bubbles";
import { shortClock } from "./format";

export type Row =
  /**
   * `held`: older messages exist, but the chat shown is from before this connection, so none load yet: offline, or
   * `reread` once connected, until this connection's latest page lands.
   */
  | { readonly kind: "top"; readonly key: "top"; readonly state: TopState }
  | { readonly kind: "day"; readonly key: string; readonly label: string }
  /** The clock time over a message that comes after a long pause on the same day. */
  | { readonly kind: "time"; readonly key: string; readonly label: string }
  /**
   * `history`: written before the chat existed (an old order, a note, a steer), shown as the conversation it was.
   * `run`: it starts a run (the space above it); `end`: it ends one (the stack's last bubble); `head`: its author
   * could show, which yours never do.
   */
  | {
      readonly kind: "message";
      readonly key: string;
      readonly item: ChatItem;
      readonly run: boolean;
      readonly end: boolean;
      readonly head: boolean;
      readonly history: boolean;
      /** Yours, answering a bubble: its quote, your words, and the message it is in when that is loaded. */
      readonly reply?: { readonly quote: string; readonly body: string; readonly target: string | undefined } | undefined;
      /** The lead's asks in it that you answered: the button's words, by bubble key. */
      readonly answered?: Readonly<Record<string, string>> | undefined;
    }
  /** Above the first message from before the chat existed. */
  | { readonly kind: "history"; readonly key: string }
  | { readonly kind: "event"; readonly key: string; readonly item: ChatItem }
  | { readonly kind: "inline"; readonly key: string; readonly item: ChatItem }
  /** Above the first message you hadn't seen when the chat opened. */
  | { readonly kind: "new"; readonly key: "new" }
  | { readonly kind: "strip"; readonly key: "strip" }
  /**
   * What the lead is doing while its turn runs (under the newest item), and once it is over how long it worked
   * (under the reply it ended with).
   */
  | { readonly kind: "activity"; readonly key: "activity" };

export type TopState = "more" | "loading" | "start" | "held" | "reread";

/** The header's chip on a held chat: it is never shown as current, connected or not. */
export const heldLabel = (offline: boolean, asOf: string | undefined): string => {
  const state = offline ? "Offline" : "Last known";
  return asOf === undefined ? state : `${state}, ${asOf}`;
};

/** Messages from one author this close together read as one turn: the name and time show once. */
const GROUP_MS = 5 * 60_000;
/** A pause this long on one day puts the time over the message that ends it, as a messaging app does. */
const PAUSE_MS = 60 * 60_000;

/** Who a message's header names, from the key that wrote it: an agent by its name. */
export const authorLabel = (item: ChatItem): string =>
  item.author === "human"
    ? "You"
    : item.author === "agent"
      ? `Agent · ${item.message?.by ?? "unnamed"}`
      : item.author === "lead"
        ? "Lead"
        : "fleetd";

/**
 * `iso` in ms, or `nowMs` when it doesn't parse. Intl throws a RangeError on an invalid date, and one row without a
 * time (a reply streaming ahead of its message once had "") took the whole window down; the newest row is the likeliest.
 */
const msOf = (iso: string, nowMs: number): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? nowMs : ms;
};

const dayKey = (iso: string, nowMs: number, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(msOf(iso, nowMs));

/** "Today", "Yesterday", or "Mon 19 Oct" (with the year when it isn't this year's). */
export function dayLabel(iso: string, nowMs: number, timeZone?: string): string {
  const day = dayKey(iso, nowMs, timeZone);
  if (day === dayKey(new Date(nowMs).toISOString(), nowMs, timeZone)) return "Today";
  if (day === dayKey(new Date(nowMs - 86_400_000).toISOString(), nowMs, timeZone)) return "Yesterday";
  const sameYear = day.slice(0, 4) === dayKey(new Date(nowMs).toISOString(), nowMs, timeZone).slice(0, 4);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    ...(timeZone ? { timeZone } : {}),
  })
    .format(msOf(iso, nowMs))
    .replace(",", "");
}

export interface RowsInput {
  readonly items: readonly ChatItem[];
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** The chat is held from before this connection (ChatView.held). */
  readonly held?: boolean;
  /** No fresh connection (ChatView.offline). */
  readonly offline?: boolean;
  /** Show the live strip (the project has agents at work, or the strip has something to say). */
  readonly strip: boolean;
  /** The lead's turn runs: its activity line shows after the newest item. */
  readonly activity?: boolean;
  /**
   * The lead's last turn is over and began at this time (epoch ms): "Worked for" shows after its reply, the lead's
   * newest message when it was written during that turn.
   */
  readonly workedSince?: number | undefined;
  /** The newest seq you had seen when the chat opened, when there was more since (data/seen.ts). */
  readonly seenSeq?: number | undefined;
  readonly nowMs: number;
  readonly timeZone?: string;
}

/** From before the chat existed: the layer shows these as one-liners, this view as the conversation they were. */
const isHistory = (item: ChatItem): boolean => item.message?.history !== undefined;

export function chatRows(i: RowsInput): Row[] {
  const top: TopState = i.loadingOlder ? "loading" : !i.hasOlder ? "start" : i.held !== true ? "more" : i.offline === false ? "reread" : "held";
  const out: Row[] = [{ kind: "top", key: "top", state: top }];
  let lastDay: string | undefined;
  let prev: ChatItem | undefined;
  // The strip goes under the lead's newest message, or at the end when the lead hasn't said anything yet. A secret
  // or command field right after that message answers it, so the strip goes after the field, never between them.
  let leadLast = -1;
  i.items.forEach((item, n) => {
    if (item.author === "lead" && item.kind === "message") leadLast = n;
  });
  for (let n = leadLast + 1; leadLast !== -1 && n < i.items.length; n++) {
    const kind = i.items[n]?.kind;
    if (kind === "secret" || kind === "gated") leadLast = n;
    else if (kind !== "event") break;
  }
  let inHistory = false;
  // Not under a reply still streaming, which says "Still writing" itself.
  const activity = i.activity === true && i.items.at(-1)?.state !== "streaming";
  const reply = i.items.findLastIndex((item) => item.author === "lead" && item.kind === "message");
  const replyAt = i.items[reply];
  const worked =
    i.activity !== true &&
    i.workedSince !== undefined &&
    replyAt !== undefined &&
    replyAt.state !== "streaming" &&
    Date.parse(replyAt.at) >= i.workedSince;
  const day = (iso: string) => {
    const d = dayKey(iso, i.nowMs, i.timeZone);
    if (d === lastDay) return;
    out.push({ kind: "day", key: `day:${d}`, label: dayLabel(iso, i.nowMs, i.timeZone) });
    lastDay = d;
    prev = undefined;
  };
  // The first message from someone else after what you'd seen; only when the loaded pages reach back to what you saw.
  const seen = i.seenSeq;
  const unseen =
    seen === undefined || (i.hasOlder && !i.items.some((item) => (item.message?.seq ?? Infinity) <= seen))
      ? -1
      : i.items.findIndex((item) => item.author !== "human" && (item.message?.seq ?? -Infinity) > seen);
  i.items.forEach((item, n) => {
    const history = isHistory(item);
    if (history && !inHistory) out.push({ kind: "history", key: `history:${item.id}` });
    inHistory = history;
    const before = i.items[n - 1];
    day(item.at);
    const clock = shortClock(item.at, i.timeZone);
    if (before !== undefined && clock !== "" && lastDay === dayKey(before.at, i.nowMs, i.timeZone) && msOf(item.at, i.nowMs) - msOf(before.at, i.nowMs) > PAUSE_MS) {
      out.push({ kind: "time", key: `time:${item.id}`, label: clock });
      prev = undefined;
    }
    if (n === unseen) {
      out.push({ kind: "new", key: "new" });
      prev = undefined;
    }
    if (history && item.author !== "system") {
      const run = prev === undefined || authorLabel(prev) !== authorLabel(item) || Date.parse(item.at) - Date.parse(prev.at) > GROUP_MS;
      out.push({ kind: "message", key: item.id, item, run, end: true, head: run && item.author !== "human", history: true });
    } else if (item.kind === "event") out.push({ kind: "event", key: item.id, item });
    else if (item.kind === "secret" || item.kind === "gated") out.push({ kind: "inline", key: item.id, item });
    else {
      const run =
        prev === undefined || prev.kind !== "message" || authorLabel(prev) !== authorLabel(item) || Date.parse(item.at) - Date.parse(prev.at) > GROUP_MS;
      out.push({ kind: "message", key: item.id, item, run, end: true, head: run && item.author !== "human", history: false, ...extras(i.items, n) });
    }
    prev = item;
    if ((activity && n === i.items.length - 1) || (worked && n === reply)) out.push({ kind: "activity", key: "activity" });
    if (i.strip && n === leadLast) out.push({ kind: "strip", key: "strip" });
  });
  if (activity && i.items.length === 0) out.push({ kind: "activity", key: "activity" });
  if (i.strip && leadLast === -1) out.push({ kind: "strip", key: "strip" });
  // A bubble ends its stack unless the next row is the next bubble of the same run.
  out.forEach((r, n) => {
    const next = out[n + 1];
    if (r.kind === "message" && next?.kind === "message" && !next.run) out[n] = { ...r, end: false };
  });
  return out;
}

/** A message's reply (yours) or answered asks (the lead's). */
function extras(items: readonly ChatItem[], n: number): Pick<Extract<Row, { kind: "message" }>, "reply" | "answered"> {
  const item = items[n];
  if (item === undefined) return {};
  if (item.author === "human") {
    const r = replyOf(item.text);
    // The bubble the hub was told it answers; an older app's reply is found by its quote.
    return r === undefined ? {} : { reply: { ...r, target: item.message?.replyTo?.messageId ?? quoted(items, n, r.quote) } };
  }
  if (item.author !== "lead") return {};
  const answered: Record<string, string> = {};
  for (const b of bubblesOf(item)) {
    if (b.kind !== "block" || b.block.kind !== "ask") continue;
    const a = askAnswer(items, n, b.block.options);
    if (a !== undefined) answered[b.key] = a;
  }
  return Object.keys(answered).length === 0 ? {} : { answered };
}

/** The row to open at for a message id (a notification's ?message=), or undefined when it isn't loaded. */
export const rowIndexOf = (rows: readonly Row[], messageId: string): number | undefined => {
  const i = rows.findIndex((r) => (r.kind === "message" || r.kind === "event" || r.kind === "inline") && r.item.id === messageId);
  return i === -1 ? undefined : i;
};

const hasItem = (r: Row): r is Extract<Row, { item: ChatItem }> => r.kind === "message" || r.kind === "event" || r.kind === "inline";

/** The newest row with a message in it: where "new below" counts from once the reader scrolls up. */
export const newestKey = (rows: readonly Row[]): string => rows.findLast(hasItem)?.key ?? "top";

/**
 * The way back to the newest message while scrolled up from `from` (newestKey then): how many arrived below since,
 * yours aside. Undefined at the end. Older pages loading above don't count.
 */
export function latestLabel(rows: readonly Row[], from: string | undefined): string | undefined {
  if (from === undefined) return undefined;
  const at = rows.findIndex((r) => r.key === from);
  const n = at === -1 ? 0 : rows.slice(at + 1).filter((r) => hasItem(r) && r.item.author !== "human").length;
  return n === 0 ? "Latest" : `${String(n)} new`;
}

/** How long after it came in a message still enters as its row mounts: its motion and the stagger, with room. */
export const ENTER_MS = 1000;

/** A message that came in while the chat was open: it enters once, `step` places after the others that came with it. */
export interface Arrival {
  /** When it came in (epoch ms). A bubble mounted much later (scrolled back to) shows still. */
  readonly at: number;
  readonly step: number;
}

/**
 * Which messages enter with motion, carried from one chat update to the next. Only what arrives while the chat is
 * open and current does: a lead reply, your send, a streamed reply's text once it is written. What the chat opened
 * with, older pages loading above, and what a held chat (a drop, a reconnect not yet read back) and the page that
 * replaces it bring all show still.
 */
export interface Arrivals {
  readonly items: readonly ChatItem[];
  readonly live: boolean;
  /** Every message shown so far, by id, and by `id~` while it streamed. */
  readonly known: ReadonlySet<string>;
  /** The newest hub seq shown so far: an unknown message older than it is from an older page. */
  readonly newest: number;
  /** By row key. */
  readonly entering: ReadonlyMap<string, Arrival>;
}

/** A message streaming is a different shape from the one it ends as: the typing dots, then its bubbles. */
const phaseKey = (i: ChatItem): string => (i.state === "streaming" ? `${i.id}~` : i.id);
const enters = (i: ChatItem): boolean => i.kind !== "event" && !isHistory(i);

export function arrivalsOf(prev: Arrivals | undefined, items: readonly ChatItem[], live: boolean, nowMs: number): Arrivals {
  const known = new Set(prev?.known);
  const entering = new Map([...(prev?.entering ?? [])].filter(([, a]) => nowMs - a.at < ENTER_MS));
  // Only while it was current before and still is: the first view, a held one and the page after it come in still.
  const still = prev === undefined || !prev.live || !live;
  let newest = prev?.newest ?? -Infinity;
  let step = 0;
  for (const i of items) {
    const key = phaseKey(i);
    const seq = i.message?.seq;
    // Your send, once the hub echoes it, is the bubble already shown under a new id.
    const seen = known.has(key) || (i.clientRequestId !== undefined && known.has(i.clientRequestId));
    const newer = seq === undefined || seq > (prev?.newest ?? -Infinity) || known.has(`${i.id}~`);
    const sent = i.clientRequestId === undefined ? undefined : entering.get(i.clientRequestId);
    if (sent !== undefined && i.id !== i.clientRequestId) entering.set(i.id, sent);
    else if (!still && !seen && newer && enters(i)) entering.set(i.id, { at: nowMs, step: step++ });
    known.add(key);
    if (seq !== undefined && seq > newest) newest = seq;
  }
  return { items, live, known, newest, entering };
}
