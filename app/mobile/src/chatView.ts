// A chat as the phone lays it out, iMessage's way: a lead message of several parts is several bubbles, and its blocks
// are cards (a pull request, a checklist, a table, an ask with its buttons; a chart, diff or clip is for the desktop,
// said in words). Messages from one side in a burst group, tight, with the tail on the last; a time line goes between
// bursts; and the desktop's turn line shows while the lead works. Pure, so it is unit-tested.
import type { ChatItem } from "./desktop";
import { previewText } from "./markdown";

export type Bubble =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ask"; readonly question: string; readonly options: readonly string[] }
  | { readonly kind: "pr"; readonly repo: string; readonly number: number; readonly title: string | undefined }
  | { readonly kind: "checklist"; readonly title: string | undefined; readonly items: ReadonlyArray<{ readonly done: boolean; readonly text: string }> }
  | { readonly kind: "table"; readonly title: string | undefined; readonly columns: readonly string[]; readonly rows: ReadonlyArray<readonly string[]> }
  | { readonly kind: "block"; readonly text: string }
  | { readonly kind: "image"; readonly attachmentId: string; readonly name: string; readonly caption?: string | undefined }
  | { readonly kind: "file"; readonly attachmentId: string; readonly name: string; readonly mime: string; readonly bytes: number };

const BLOCK_WORDS: Readonly<Record<string, string>> = {
  chart: "A chart",
  diff: "A diff",
  agent: "An agent",
  clip: "A clip",
};

export const bubbles = (item: Pick<ChatItem, "text" | "message">): readonly Bubble[] => {
  const parts = item.message?.parts;
  if (parts === undefined || parts.length === 0 || item.message?.state === "streaming") return item.text.trim() === "" ? [] : [{ kind: "text", text: item.text }];
  return parts.flatMap((p): Bubble[] => {
    const block = p.block;
    if (block === undefined) {
      const text = item.text.slice(p.start, p.end).trim();
      return text === "" ? [] : [{ kind: "text", text }];
    }
    switch (block.kind) {
      case "ask":
        return [{ kind: "ask", question: block.question, options: block.options ?? ["Approve", "Deny"] }];
      case "pr":
        return [{ kind: "pr", repo: block.repo, number: block.number, title: block.title }];
      case "checklist":
        return [{ kind: "checklist", title: block.title, items: block.items }];
      case "table":
        return [{ kind: "table", title: block.title, columns: block.columns, rows: block.rows }];
      case "image":
        return [{ kind: "image", attachmentId: block.attachmentId, name: block.caption ?? "Image", caption: block.caption }];
      default:
        return [{ kind: "block", text: `${BLOCK_WORDS[block.kind] ?? "Something"} the desktop app shows.` }];
    }
  });
};

/** A message's files, as bubbles of their own after its words: pictures shown, anything else as a file to open. */
export const attachmentBubbles = (item: Pick<ChatItem, "attachments">): readonly Bubble[] =>
  item.attachments.map((a): Bubble => (a.mime.startsWith("image/") ? { kind: "image", attachmentId: a.attachmentId, name: a.name } : { kind: "file", attachmentId: a.attachmentId, name: a.name, mime: a.mime, bytes: a.bytes }));

/** A file's size as Files words it. */
export const fileSize = (n: number): string => (n < 1024 ? `${String(n)} bytes` : n < 1_048_576 ? `${String(Math.round(n / 1024))} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

// Replies, as the desktop app writes them (screens/chat/bubbles.ts): the quoted bubble's first line as a markdown
// quote, a blank line, then your words, so every client shows it; chat_send's replyTo names the bubble for the lead.

const QUOTE_MAX = 90;

/** A bubble's first line as plain words, for its quote: markdown marks and fences out, cut to a line. */
export const quoteOf = (text: string): string => {
  const line =
    text
      .replace(/```[\s\S]*?(```|$)/gu, " ")
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d{1,2}[.)]\s+)/u, "")
          .replace(/[*_~`]/gu, "")
          .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
          .trim(),
      )
      .find((l) => l !== "") ?? "";
  return line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX - 1).trimEnd()}…` : line;
};

/** Your words as a reply to a bubble: its quote, a blank line, then what you wrote. */
export const replyText = (quote: string, text: string): string => (quote === "" ? text : `> ${quote}\n\n${text}`);

/** A message that replies to a bubble: the quote and the words under it; undefined for any other text. */
export const replyOf = (text: string): { readonly quote: string; readonly body: string } | undefined => {
  const m = /^> ([^\n]+)\n\n(?!>)([\s\S]*\S[\s\S]*)$/u.exec(text);
  return m === null ? undefined : { quote: m[1] ?? "", body: m[2] ?? "" };
};

/** What a row of the person's own says about where it is, or undefined once the hub has it. */
export const sendNote = (item: Pick<ChatItem, "state" | "error" | "leadWaiting">): string | undefined => {
  switch (item.state) {
    case "pending":
      return "Sending…";
    case "queued":
      return "Not connected: it goes when the hub is back.";
    case "reconnecting":
      return "The link dropped: it goes again when the hub is back.";
    case "unanswered":
      return "The hub didn't answer. Tap to send again.";
    case "failed":
      return `Not sent: ${item.error?.message ?? "the hub refused it"} Tap to send again.`;
    default:
      return item.leadWaiting;
  }
};

/** A message as the chats list's one line: its text without markdown, or what its card is. */
export const previewOf = (item: Pick<ChatItem, "text" | "message" | "author"> & Partial<Pick<ChatItem, "attachments">>): string => {
  const inline = item.message?.item;
  if (inline?.kind === "command_approval") return "Asks for your approval";
  if (inline?.kind === "secret_request") return "Asks for a secret";
  const reply = item.author === "human" ? replyOf(item.text) : undefined;
  const shown = reply === undefined ? item : { ...item, text: reply.body };
  const line = [...bubbles(shown), ...attachmentBubbles({ attachments: item.attachments ?? [] })]
    .map((b) => {
      switch (b.kind) {
        case "text":
          return previewText(b.text);
        case "ask":
          return b.question;
        case "pr":
          return `Pull request #${String(b.number)}${b.title === undefined ? "" : `: ${b.title}`}`;
        case "checklist":
        case "table":
          return b.title ?? (b.kind === "table" ? "A table" : "A checklist");
        case "block":
          return b.text;
        case "image":
          return b.caption ?? "Photo";
        case "file":
          return b.name;
      }
    })
    .filter((s) => s !== "")
    .join(" ");
  return item.author === "human" && line !== "" ? `You: ${line}` : line;
};

/** Which side a row sits on: the person's on the right, the lead's and agents' on the left, the rest centred. */
/** The message whose card answers an approval: where a tapped approval opens its chat. Undefined: not in what's read. */
export const cardOf = (items: readonly Pick<ChatItem, "message">[], requestId: string): string | undefined =>
  items.find((i) => i.message?.item?.kind === "command_approval" && i.message.item.requestId === requestId)?.message?.messageId;

export type Side = "me" | "them" | "center";

export const sideOf = (item: Pick<ChatItem, "author" | "kind">): Side =>
  item.kind !== "message" ? "center" : item.author === "human" ? "me" : item.author === "system" ? "center" : "them";

export type ThreadRow =
  /** A new day starts: "Today", "Yesterday", a date. */
  | { readonly t: "day"; readonly id: string; readonly at: string }
  | { readonly t: "item"; readonly id: string; readonly item: ChatItem; readonly side: Side; readonly first: boolean; readonly last: boolean }
  /** The lead is mid-turn: the turn line (screens/TurnLine.tsx), what it does now. */
  | { readonly t: "turn"; readonly id: string }
  /** Where what you haven't read starts, as Telegram's "Unread Messages" bar. */
  | { readonly t: "unread"; readonly id: string };

/**
 * Whether two rows draw the same: the thread makes its rows anew with each change (a streamed word), and a row that is
 * the same draws nothing again. A row's message is made anew too, from the same hub message and fields.
 */
export const sameRow = (a: ThreadRow, b: ThreadRow): boolean => {
  if (a === b) return true;
  if (a.t !== b.t || a.id !== b.id) return false;
  if (a.t === "item" && b.t === "item") return a.side === b.side && a.first === b.first && a.last === b.last && sameItem(a.item, b.item);
  if (a.t === "day" && b.t === "day") return a.at === b.at;
  return true;
};

const sameItem = (a: ChatItem, b: ChatItem): boolean => {
  if (a === b) return true;
  const keys = Object.keys(a) as Array<keyof ChatItem>;
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** Messages this close together are one burst. */
export const GROUP_MS = 5 * 60_000;

const msOf = (at: string): number => {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? 0 : ms;
};

/** Who wrote it, as grouping sees it: two agents' messages don't group, nor the lead's with an agent's. */
const voice = (item: ChatItem): string => `${item.author}:${item.author === "agent" ? (item.message?.by ?? "") : ""}`;

const joins = (a: ChatItem | undefined, b: ChatItem | undefined): boolean =>
  a !== undefined && b !== undefined && sideOf(a) !== "center" && sideOf(a) === sideOf(b) && voice(a) === voice(b) && msOf(b.at) - msOf(a.at) < GROUP_MS;

/**
 * The rows to draw, oldest first. `working`: the lead is mid-turn, so the turn line ends the thread, as on the desktop,
 * under its reply as it streams too. `readSeq`: what was read when the chat opened; the unread bar goes before the first message from
 * the other side after it. A day line goes where a new day starts, in the clock's zone, as Telegram's date chips.
 */
export const threadRows = (items: readonly ChatItem[], working = false, readSeq?: number, clock: Pick<Clock, "timeZone"> = {}): ThreadRow[] => {
  const rows: ThreadRow[] = [];
  let prev: ChatItem | undefined;
  const firstUnread = readSeq === undefined ? -1 : items.findIndex((i) => i.author !== "human" && i.kind === "message" && (i.message?.seq ?? 0) > readSeq);
  for (const [i, item] of items.entries()) {
    if (i === firstUnread) rows.push({ t: "unread", id: "unread" });
    const day = dayOf(msOf(item.at), clock);
    if (prev === undefined || day !== dayOf(msOf(prev.at), clock)) rows.push({ t: "day", id: `day:${String(day)}`, at: item.at });
    const side = sideOf(item);
    const next = items[i + 1];
    rows.push({ t: "item", id: item.clientRequestId ?? item.id, item, side, first: i === firstUnread || !joins(prev, item), last: i + 1 === firstUnread || !joins(item, next) });
    prev = item;
  }
  if (working) rows.push({ t: "turn", id: "turn" });
  return rows;
};

export interface Clock {
  readonly nowMs: number;
  readonly locale?: string | undefined;
  readonly timeZone?: string | undefined;
}

const DAY_MS = 86_400_000;

/**
 * Formatters, made once each: making one is slow on the phone, and a thread asks for two per message each time it
 * draws, which a streamed reply does with every word.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let made = formatters.get(key);
  if (made === undefined) {
    made = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, made);
  }
  return made;
};

/** The calendar day `ms` falls on in the clock's zone, as the UTC midnight of that date. */
const dayOf = (ms: number, clock: Pick<Clock, "timeZone">): number => {
  const parts = formatter("en-US", { timeZone: clock.timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(ms);
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"));
};

/** Days from `ms` to now, by the calendar in the clock's zone: 0 today, 1 yesterday. */
const daysAgo = (ms: number, clock: Clock): number => Math.round((dayOf(clock.nowMs, clock) - dayOf(ms, clock)) / DAY_MS);

const fmt = (ms: number, clock: Clock, options: Intl.DateTimeFormatOptions): string => formatter(clock.locale, { timeZone: clock.timeZone, ...options }).format(ms);

const clockTime = (ms: number, clock: Clock): string => fmt(ms, clock, { hour: "numeric", minute: "2-digit" });

/** A thread's time line, as iMessage words it: "Today 9:41", "Yesterday 18:02", "Tuesday 9:12", "12 Oct 2026 at 9:12". */
export const timeLine = (at: string, clock: Clock): string => {
  const ms = msOf(at);
  const days = daysAgo(ms, clock);
  const time = clockTime(ms, clock);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${fmt(ms, clock, { weekday: "long" })} ${time}`;
  return `${fmt(ms, clock, { day: "numeric", month: "short", year: "numeric" })} at ${time}`;
};

/** A day line in a thread, as Telegram's: "Today", "Yesterday", "Tuesday 27 October", with the year when it isn't this one. */
export const dayLine = (at: string, clock: Clock): string => {
  const ms = msOf(at);
  const days = daysAgo(ms, clock);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const thisYear = fmt(ms, clock, { year: "numeric" }) === fmt(clock.nowMs, clock, { year: "numeric" });
  return fmt(ms, clock, { weekday: "long", day: "numeric", month: "long", ...(thisYear ? {} : { year: "numeric" }) });
};

/** A bubble's own time, small in its corner: "9:41". */
export const bubbleTime = (at: string, clock: Clock): string => clockTime(msOf(at), clock);

/** When a message was sent, in full, for its menu: "Thursday, 29 October 2026 at 9:41". */
export const fullTime = (at: string, clock: Clock): string => `${fmt(msOf(at), clock, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} at ${clockTime(msOf(at), clock)}`;

/** A chats list row's time: the time today, then "Yesterday", the weekday this week, else the date. */
export const listTime = (at: string, clock: Clock): string => {
  const ms = msOf(at);
  const days = daysAgo(ms, clock);
  if (days <= 0) return clockTime(ms, clock);
  if (days === 1) return "Yesterday";
  if (days < 7) return fmt(ms, clock, { weekday: "long" });
  return fmt(ms, clock, { day: "numeric", month: "numeric", year: "2-digit" });
};
