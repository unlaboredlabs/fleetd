// The chat as rows: day dividers, messages grouped by author (a run from one author within a few minutes shows its
// name and time once; yours show none), your steers to the lead at their time, event one-liners (fleetd's own
// messages among them), inline items, the live strip under the lead's newest message (and the field that answers it),
// where you stopped reading, and the top of the history.
import type { Steer, Workstream } from "../../../shared/contracts";
import type { ChatItem } from "../../src/data/chat";

export type Row =
  /**
   * `held`: older messages exist, but the chat shown is from before this connection, so none load yet: offline, or
   * `reread` once connected, until this connection's latest page lands.
   */
  | { readonly kind: "top"; readonly key: "top"; readonly state: TopState }
  | { readonly kind: "day"; readonly key: string; readonly label: string }
  /**
   * `history`: written before the chat existed (an old order, a note, a steer), shown as the conversation it was.
   * `run`: it starts a run (the space above it); `head`: its author and time show, which yours never do.
   */
  | {
      readonly kind: "message";
      readonly key: string;
      readonly item: ChatItem;
      readonly run: boolean;
      readonly head: boolean;
      readonly history: boolean;
    }
  /** Above the first message from before the chat existed. */
  | { readonly kind: "history"; readonly key: string }
  /**
   * Your steer to the lead (⌘Enter, or `fleetd steer`): the hub keeps steers apart from the chat, so the chat shows
   * them from order_get, as your words with their receipt.
   */
  | { readonly kind: "steer"; readonly key: string; readonly steer: Steer; readonly head: boolean }
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
  /** Your steers to the lead, oldest first (leadSteers); those outside the loaded pages wait for theirs. */
  readonly steers?: readonly Steer[];
  /** The newest seq you had seen when the chat opened, when there was more since (data/seen.ts). */
  readonly seenSeq?: number | undefined;
  readonly nowMs: number;
  readonly timeZone?: string;
}

/** From before the chat existed: the layer shows these as one-liners, this view as the conversation they were. */
const isHistory = (item: ChatItem): boolean => item.message?.history !== undefined;

/**
 * The steers to show with these items: the ones within the loaded pages (none above a page with older ones before
 * it), apart from those the chat already holds as history from before it existed.
 */
const steersShown = (i: RowsInput): readonly Steer[] => {
  const steers = i.steers ?? [];
  if (steers.length === 0) return steers;
  const from = i.hasOlder && i.items[0] !== undefined ? msOf(i.items[0].at, i.nowMs) : -Infinity;
  const copied = new Set(i.items.filter((item) => item.message?.history === "steer").map((item) => `${String(msOf(item.at, i.nowMs))} ${item.text}`));
  return steers.filter((st) => {
    const at = msOf(st.queuedAt, i.nowMs);
    return at >= from && !copied.has(`${String(at)} ${st.text.trim()}`);
  });
};

export function chatRows(i: RowsInput): Row[] {
  const top: TopState = i.loadingOlder ? "loading" : !i.hasOlder ? "start" : i.held !== true ? "more" : i.offline === false ? "reread" : "held";
  const out: Row[] = [{ kind: "top", key: "top", state: top }];
  let lastDay: string | undefined;
  let prev: ChatItem | undefined;
  /** When the steer just before was sent: a run of steers shows its header once, as messages do. */
  let prevSteer: number | undefined;
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
    prevSteer = undefined;
  };
  const steers = steersShown(i);
  let next = 0;
  /** Your steers sent before `ms`, in their place. */
  const steersUntil = (ms: number) => {
    for (let st = steers[next]; st !== undefined && msOf(st.queuedAt, i.nowMs) < ms; st = steers[++next]) {
      const at = msOf(st.queuedAt, i.nowMs);
      day(st.queuedAt);
      out.push({ kind: "steer", key: `steer:${st.id}`, steer: st, head: prevSteer === undefined || at - prevSteer > GROUP_MS });
      prevSteer = at;
      prev = undefined;
    }
  };
  // The first message from someone else after what you'd seen; only when the loaded pages reach back to what you saw.
  const seen = i.seenSeq;
  const unseen =
    seen === undefined || (i.hasOlder && !i.items.some((item) => (item.message?.seq ?? Infinity) <= seen))
      ? -1
      : i.items.findIndex((item) => item.author !== "human" && (item.message?.seq ?? -Infinity) > seen);
  const lastAt = i.items.at(-1)?.at;
  // Steers after every item go last, and the lead's activity under them, as under the newest item.
  const steersAfter = lastAt === undefined ? steers.length : steers.filter((st) => msOf(st.queuedAt, i.nowMs) >= msOf(lastAt, i.nowMs)).length;
  i.items.forEach((item, n) => {
    steersUntil(msOf(item.at, i.nowMs));
    const history = isHistory(item);
    if (history && !inHistory) out.push({ kind: "history", key: `history:${item.id}` });
    inHistory = history;
    day(item.at);
    if (n === unseen) {
      out.push({ kind: "new", key: "new" });
      prev = undefined;
    }
    if (history && item.author !== "system") {
      const run = prev === undefined || authorLabel(prev) !== authorLabel(item) || Date.parse(item.at) - Date.parse(prev.at) > GROUP_MS;
      out.push({ kind: "message", key: item.id, item, run, head: run && item.author !== "human", history: true });
    } else if (item.kind === "event") out.push({ kind: "event", key: item.id, item });
    else if (item.kind === "secret" || item.kind === "gated") out.push({ kind: "inline", key: item.id, item });
    else {
      const run =
        prev === undefined || prev.kind !== "message" || authorLabel(prev) !== authorLabel(item) || Date.parse(item.at) - Date.parse(prev.at) > GROUP_MS;
      out.push({ kind: "message", key: item.id, item, run, head: run && item.author !== "human", history: false });
    }
    prev = item;
    prevSteer = undefined;
    if ((activity && steersAfter === 0 && n === i.items.length - 1) || (worked && n === reply)) out.push({ kind: "activity", key: "activity" });
    if (i.strip && n === leadLast) out.push({ kind: "strip", key: "strip" });
  });
  steersUntil(Infinity);
  if (activity && (i.items.length === 0 || steersAfter > 0)) out.push({ kind: "activity", key: "activity" });
  if (i.strip && leadLast === -1) out.push({ kind: "strip", key: "strip" });
  return out;
}

/**
 * The project's orders that can hold a steer from `from` on (all of them without older pages): every open one
 * (the board's), and each listed one that was open after `from`.
 * Sorted, so the reads keep their order.
 */
export function ordersInView(open: readonly string[], listed: readonly Workstream[] | undefined, from: string | undefined): readonly string[] {
  const ids = new Set(open);
  for (const w of listed ?? []) {
    if (from !== undefined && w.state !== "open" && Date.parse(w.updatedAt) < Date.parse(from)) continue;
    ids.add(w.workstreamId);
  }
  return [...ids].toSorted();
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
