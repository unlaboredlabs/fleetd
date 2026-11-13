// The chat as rows: day dividers, a quiet time where the conversation picked up again after a pause, messages as
// bubbles grouped by author (a run from one author within a few minutes draws as one stack; an agent's names it once),
// event one-liners (fleetd's own messages among them), inline items, where you stopped reading, and the top of the
// history. The live strip isn't a row: it floats over the composer (live/LiveStrip.tsx), and neither is what the lead
// is doing, a line beside it (TurnLine.tsx), so nothing in the list moves for either.
import type { ChatItem } from "../../src/data/chat";
import { askAnswer, bubblesOf, quoted, replyOf } from "./bubbles";
import { shortClock } from "./format";
import { workedFor } from "../../../shared/turnWords";
import { nameNow, type PersonNames } from "../admin/names";
import type { ChatFold } from "../../../shared/contracts";
import { aboutOf, stepsOf, tagKey, tagOf, type Step, type Tag, type Tags } from "./lens/tags";

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
   * could show, which yours never do. `by`: another person's, by their name: it draws as theirs, under that name.
   */
  | {
      readonly kind: "message";
      readonly key: string;
      readonly item: ChatItem;
      readonly run: boolean;
      readonly end: boolean;
      readonly head: boolean;
      readonly history: boolean;
      readonly by?: string | undefined;
      /** Yours, answering a bubble: its quote, your words, and the message it is in when that is loaded. */
      readonly reply?: { readonly quote: string; readonly body: string; readonly target: string | undefined } | undefined;
      /** The lead's asks in it that you answered: the button's words, by bubble key. */
      readonly answered?: Readonly<Record<string, string>> | undefined;
      /** The reply a turn ended with: how long the turn took ("Worked for 4s"), a quiet stamp beside it. */
      readonly worked?: string | undefined;
      /** The tagged chat's line over a run: its order and whom it is for (lens/tags.ts). */
      readonly tag?: Tag | undefined;
      /** In a lens, of a message about several orders, the bubbles shown, by key. */
      readonly parts?: readonly string[] | undefined;
    }
  /** A closed order's messages, folded into one line where its landing was said; `open`: they show under it. */
  | { readonly kind: "fold"; readonly key: string; readonly fold: ChatFold; readonly open: boolean }
  /** Above the first message from before the chat existed. */
  | { readonly kind: "history"; readonly key: string }
  | { readonly kind: "event"; readonly key: string; readonly item: ChatItem }
  | { readonly kind: "inline"; readonly key: string; readonly item: ChatItem }
  /** Above the first message you hadn't seen when the chat opened. */
  | { readonly kind: "new"; readonly key: "new" };

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
/** A turn's reply is written just before it ends; the hub may stamp the two a moment apart either way. */
const REPLY_SLACK_MS = 2_000;

/**
 * Another person's message, in a project chat the team shares: the person who wrote it, when the hub names one and
 * it isn't `me`, the person this app acts as, under the name they go by now (`names`; the message's own, the one they
 * had then, when the hub no longer lists them). Undefined for yours, and on a hub from before people.
 */
export const otherPerson = (item: ChatItem, me: string | undefined, names?: PersonNames): string | undefined => {
  const person = item.author === "human" ? item.message?.person : undefined;
  return person !== undefined && me !== undefined && person.personId !== me ? nameNow(person, names) : undefined;
};

/** Yours: a human message no other person wrote. On a hub from before people, every human message. */
export const isMine = (item: ChatItem, me: string | undefined): boolean => item.author === "human" && otherPerson(item, me) === undefined;

/** A row of yours: a message row isMine says is yours (its `by` is otherPerson's). */
export const isMineRow = (r: Row): boolean => r.kind === "message" && r.item.author === "human" && r.by === undefined;

/** Who a message's header names: another person by their name, an agent by the key that wrote it. */
export const authorLabel = (item: ChatItem, me?: string, names?: PersonNames): string =>
  item.author === "human"
    ? (otherPerson(item, me, names) ?? "You")
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

/**
 * One formatter per kind and time zone, made once (as format.ts's shortClock does): making one costs ~45 times what
 * formatting with it does, and chatRows asks for a day twice per message each time the chat changes, a streamed
 * delta included. In a chat of 500 messages, a reply streaming in took the renderer to 100% and GBs of memory.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (kind: "day" | "label" | "labelYear", timeZone: string | undefined): Intl.DateTimeFormat => {
  const key = `${kind} ${timeZone ?? ""}`;
  let f = formatters.get(key);
  if (f === undefined) {
    const zone = timeZone ? { timeZone } : {};
    f =
      kind === "day"
        ? new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...zone })
        : new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", ...(kind === "labelYear" ? { year: "numeric" } : {}), ...zone });
    formatters.set(key, f);
  }
  return f;
};

const dayKey = (iso: string, nowMs: number, timeZone?: string): string => formatter("day", timeZone).format(msOf(iso, nowMs));

/** A message's time in ms, its day and its clock. */
interface Stamp {
  readonly ms: number;
  readonly day: string;
  readonly clock: string;
}

/**
 * Stamps by time zone and time, kept: chatRows reads every message's on each change to the chat, an arrival or a
 * streamed delta, and formatting them anew was most of its cost. 1,500 messages arriving into a long chat kept the
 * renderer busy past perf's streaming round on a slow runner. More than a few long chats' worth, then dropped.
 */
const stamps = new Map<string, Stamp>();
const STAMPS_KEPT = 10_000;
const stampOf = (iso: string, nowMs: number, timeZone?: string): Stamp => {
  const key = `${timeZone ?? ""} ${iso}`;
  const kept = stamps.get(key);
  if (kept !== undefined) return kept;
  const ms = msOf(iso, nowMs);
  const stamp = { ms, day: formatter("day", timeZone).format(ms), clock: shortClock(iso, timeZone) };
  // Unparseable: its day is now's, which moves.
  if (Number.isNaN(Date.parse(iso))) return stamp;
  if (stamps.size >= STAMPS_KEPT) stamps.clear();
  stamps.set(key, stamp);
  return stamp;
};

/** "Today", "Yesterday", or "Mon 19 Oct" (with the year when it isn't this year's). */
export function dayLabel(iso: string, nowMs: number, timeZone?: string): string {
  const day = dayKey(iso, nowMs, timeZone);
  const today = dayKey(new Date(nowMs).toISOString(), nowMs, timeZone);
  if (day === today) return "Today";
  if (day === dayKey(new Date(nowMs - 86_400_000).toISOString(), nowMs, timeZone)) return "Yesterday";
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return formatter(sameYear ? "label" : "labelYear", timeZone)
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
  /**
   * The lead's latest finished turn, epoch ms at each end: "Worked for" goes beside its reply, the lead's newest
   * message written during it, and stays there while the next turn runs.
   */
  readonly worked?: { readonly since: number; readonly until: number } | undefined;
  /** The newest seq you had seen when the chat opened, when there was more since (data/seen.ts). */
  readonly seenSeq?: number | undefined;
  /** The person this app acts as (hub_info's me): someone else's messages show their name. */
  readonly me?: string | undefined;
  /** The names the hub's people go by now (admin/names.ts): a message someone wrote under an older name shows this one. */
  readonly names?: PersonNames | undefined;
  readonly nowMs: number;
  readonly timeZone?: string;
  /** The project's chat is tagged (its trial is on): tags, folds and the lens, as lens/tags.ts lays them out. */
  readonly tags?: Tags | undefined;
}

/**
 * A message's row, the same from your send to the hub's copy of it: by the clientRequestId it went under, else its
 * id. Under a new key the row would mount again, and the list measure it again from a guess: a jump as it confirms.
 */
export const rowKeyOf = (item: ChatItem): string => item.clientRequestId ?? item.id;

/** From before the chat existed: the layer shows these as one-liners, this view as the conversation they were. */
const isHistory = (item: ChatItem): boolean => item.message?.history !== undefined;

export function chatRows(i: RowsInput): Row[] {
  const top: TopState = i.loadingOlder ? "loading" : !i.hasOlder ? "start" : i.held !== true ? "more" : i.offline === false ? "reread" : "held";
  const out: Row[] = [{ kind: "top", key: "top", state: top }];
  let lastDay: string | undefined;
  let prev: ChatItem | undefined;
  let inHistory = false;
  const turn = i.worked;
  const inTurn = (item: ChatItem) => {
    const at = Date.parse(item.at);
    return turn !== undefined && at >= turn.since && at <= turn.until + REPLY_SLACK_MS;
  };
  const reply = i.items.findLastIndex((item) => item.author === "lead" && item.kind === "message" && item.state !== "streaming" && inTurn(item));
  const worked = turn === undefined ? undefined : `Worked for ${workedFor(turn.until - turn.since)}`;
  const day = (iso: string, d: string) => {
    if (d === lastDay) return;
    out.push({ kind: "day", key: `day:${d}`, label: dayLabel(iso, i.nowMs, i.timeZone) });
    lastDay = d;
    prev = undefined;
  };
  let before: Stamp | undefined;
  // The first message from someone else after what you'd seen; only when the loaded pages reach back to what you saw.
  const seen = i.seenSeq;
  const unseen =
    seen === undefined || (i.hasOlder && !i.items.some((item) => (item.message?.seq ?? Infinity) <= seen))
      ? -1
      : i.items.findIndex((item) => !isMine(item, i.me) && (item.message?.seq ?? -Infinity) > seen);
  const tags = i.tags;
  const steps: readonly Step[] = tags === undefined ? i.items.map((item, n) => ({ kind: "item", item, n })) : stepsOf(i.items, tags, (item) => isMine(item, i.me));
  const nameOf = (p: { personId: string; name: string }) => nameNow(p, i.names);
  // Under an opened fold's line, a closed order's messages from whenever: no day or time over them, and no New.
  let inFold = false;
  /** Whom the lead's last run was to, in a lens. */
  let lensFor: string | undefined;
  steps.forEach((step) => {
    if (step.kind === "fold") {
      const at = stampOf(step.at, i.nowMs, i.timeZone);
      day(step.at, at.day);
      before = at;
      out.push({ kind: "fold", key: `fold:${step.fold.workstreamId}`, fold: step.fold, open: step.open });
      prev = undefined;
      inFold = step.open;
      return;
    }
    const { item, n } = step;
    const folded = step.folded === true;
    if (inFold && !folded) prev = undefined;
    inFold = folded;
    if (folded) {
      const run = prev === undefined || authorLabel(prev, i.me, i.names) !== authorLabel(item, i.me, i.names) || tagKey(prev) !== tagKey(item);
      const by = otherPerson(item, i.me, i.names);
      if (item.kind === "secret" || item.kind === "gated") out.push({ kind: "inline", key: item.id, item });
      else if (item.kind === "event") out.push({ kind: "event", key: item.id, item });
      else {
        // Under its fold's line, which names the order already.
        const tag = run && tags !== undefined ? tagOf(item, { ...tags, lens: aboutOf(item) }, i.me, nameOf) : undefined;
        out.push({ kind: "message", key: rowKeyOf(item), item, run, end: true, head: run && !isMine(item, i.me), history: isHistory(item), ...(by === undefined ? {} : { by }), ...extras(i.items, n), ...(tag === undefined ? {} : { tag }) });
      }
      prev = item.kind === "message" ? item : undefined;
      return;
    }
    const history = isHistory(item);
    if (history && !inHistory) out.push({ kind: "history", key: `history:${item.id}` });
    inHistory = history;
    const at = stampOf(item.at, i.nowMs, i.timeZone);
    day(item.at, at.day);
    if (before !== undefined && at.clock !== "" && lastDay === before.day && at.ms - before.ms > PAUSE_MS) {
      out.push({ kind: "time", key: `time:${rowKeyOf(item)}`, label: at.clock });
      prev = undefined;
    }
    before = at;
    if (n === unseen) {
      out.push({ kind: "new", key: "new" });
      prev = undefined;
    }
    const by = otherPerson(item, i.me, i.names);
    const theirs = !isMine(item, i.me);
    const label = authorLabel(item, i.me, i.names);
    if (history && item.author !== "system") {
      const run = prev === undefined || authorLabel(prev, i.me, i.names) !== label || Date.parse(item.at) - Date.parse(prev.at) > GROUP_MS;
      out.push({ kind: "message", key: item.id, item, run, end: true, head: run && theirs, history: true, ...(by === undefined ? {} : { by }) });
    } else if (item.kind === "event") out.push({ kind: "event", key: item.id, item });
    else if (item.kind === "secret" || item.kind === "gated") out.push({ kind: "inline", key: item.id, item });
    else {
      const run =
        prev === undefined ||
        prev.kind !== "message" ||
        authorLabel(prev, i.me, i.names) !== label ||
        Date.parse(item.at) - Date.parse(prev.at) > GROUP_MS ||
        (tags?.named === true && tagKey(prev) !== tagKey(item));
      const named = run && tags !== undefined ? tagOf(item, tags, i.me, nameOf) : undefined;
      // In a lens, whom the lead writes to shows once, and again only when that changes: its runs are mostly to one person.
      const whom = item.author === "lead" ? (item.message?.for?.personId ?? "") : undefined;
      const tag = tags?.lens !== undefined && whom !== undefined && run && whom === lensFor ? (named?.order === undefined ? undefined : { order: named.order }) : named;
      if (whom !== undefined && run) lensFor = whom;
      const parts = step.parts;
      out.push({
        kind: "message",
        key: rowKeyOf(item),
        item,
        run,
        end: true,
        head: run && theirs,
        history: false,
        ...(by === undefined ? {} : { by }),
        ...extras(i.items, n),
        ...(n === reply ? { worked } : {}),
        ...(tag === undefined ? {} : { tag }),
        ...(parts === undefined ? {} : { parts }),
      });
    }
    prev = item;
  });
  // A bubble ends its stack unless the next row is the next bubble of the same run.
  out.forEach((r, n) => {
    const next = out[n + 1];
    if (r.kind === "message" && next?.kind === "message" && !next.run) out[n] = { ...r, end: false };
  });
  return out;
}

/** The same values, key by key; one level of plain objects (a row's item, reply or answers) compared the same way. */
const same = (a: unknown, b: unknown, depth = 1): boolean => {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) || Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth - 1));
};

/**
 * `next`, with each row that says what it said in `prev` kept as that same object. The chat's items are made anew
 * on every streamed word, so without this each row would be new, and every bubble in the list drawn again for one
 * word of the reply streaming at its end.
 */
export function keepRows(prev: readonly Row[] | undefined, next: readonly Row[]): readonly Row[] {
  if (prev === undefined) return next;
  const before = new Map(prev.map((r) => [r.key, r]));
  return next.map((r) => {
    const old = before.get(r.key);
    return old !== undefined && same(old, r, 2) ? old : r;
  });
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
  const n = at === -1 ? 0 : rows.slice(at + 1).filter((r) => hasItem(r) && !isMineRow(r)).length;
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
 * open and current does: a lead reply, your send, a streamed reply as the lead starts writing (once: its text then
 * takes the dots' place without entering again, and the list glides to make room for it). What the chat opened
 * with, older pages loading above, and what a held chat (a drop, a reconnect not yet read back) and the page that
 * replaces it bring all show still.
 */
export interface Arrivals {
  readonly items: readonly ChatItem[];
  readonly live: boolean;
  /** Every message shown so far, by row key (rowKeyOf), and by `key~` while it streamed. */
  readonly known: ReadonlySet<string>;
  /** The newest hub seq shown so far: an unknown message older than it is from an older page. */
  readonly newest: number;
  /** By row key. */
  readonly entering: ReadonlyMap<string, Arrival>;
}

/** A message streaming is a different shape from the one it ends as: the typing dots, then its bubbles. */
const phaseKey = (i: ChatItem): string => (i.state === "streaming" ? `${rowKeyOf(i)}~` : rowKeyOf(i));
const enters = (i: ChatItem): boolean => i.kind !== "event" && !isHistory(i);

export function arrivalsOf(prev: Arrivals | undefined, items: readonly ChatItem[], live: boolean, nowMs: number): Arrivals {
  const known = new Set(prev?.known);
  const entering = new Map([...(prev?.entering ?? [])].filter(([, a]) => nowMs - a.at < ENTER_MS));
  // Only while it was current before and still is: the first view, a held one and the page after it come in still.
  const still = prev === undefined || !prev.live || !live;
  let newest = prev?.newest ?? -Infinity;
  let step = 0;
  for (const i of items) {
    // Your send, once the hub echoes it, is the bubble already shown: the same key.
    const key = phaseKey(i);
    const seq = i.message?.seq;
    const newer = seq === undefined || seq > (prev?.newest ?? -Infinity);
    // Its dots entered: written, it is the same message, growing.
    const written = key !== `${rowKeyOf(i)}~` && known.has(`${rowKeyOf(i)}~`);
    if (!still && !known.has(key) && !written && newer && enters(i)) entering.set(rowKeyOf(i), { at: nowMs, step: step++ });
    known.add(key);
    if (seq !== undefined && seq > newest) newest = seq;
  }
  return { items, live, known, newest, entering };
}

/** Where a person's message came from when it wasn't typed in an app or the CLI, as its line says it. */
const VIA: Partial<Record<string, string>> = { share: "the Share Sheet", shortcuts: "Shortcuts" };

/**
 * Where a person's message was written, when not here: "via Shortcuts" (a shortcut or one of their phone's automations)
 * or "via the Share Sheet".
 */
export const viaOf = (item: ChatItem): string | undefined => {
  const m = item.message;
  if (m === undefined || item.author !== "human" || m.client === undefined) return undefined;
  const via = VIA[m.client];
  return via === undefined ? undefined : `via ${via}`;
};
