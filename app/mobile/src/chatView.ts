// A chat as the phone lays it out, iMessage's way: a lead message of several parts is several bubbles, and its blocks
// are cards (a pull request, a checklist, a table, an ask with its buttons, a file; a chart, diff or clip is for the desktop,
// said in words). Messages from one side in a burst group, tight; a time line goes between
// bursts; and the desktop's turn line shows while the lead works. Pure, so it is unit-tested.
import { workedFor, type ChatItem } from "./desktop";
import { isBlockFence, parseMarkdown, previewText, UNSHOWN } from "./markdown";

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
      // A block that didn't show, alone in its part: a card saying so, as for a kind the phone doesn't draw.
      const [only, ...more] = parseMarkdown(text);
      if (only !== undefined && more.length === 0 && isBlockFence(only)) return [{ kind: "block", text: UNSHOWN }];
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
      case "file":
        return [{ kind: "file", attachmentId: block.attachmentId, name: block.name ?? block.caption ?? "File", mime: block.mime ?? "", bytes: block.bytes ?? 0 }];
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

/**
 * What a send carries: the words without blank lines or spaces at their ends (the first line's indent kept in a message
 * of more lines), under the quote of the bubble it replies to, and which bubble that is; null with nothing to send. A
 * photo goes with no words. A quick answer or a starter passes no reply: it never quotes what the composer's Reply
 * banner holds, which stays for the words being typed.
 */
export const outgoing = (
  body: string,
  files: number,
  reply: { readonly id: string; readonly part: number; readonly quote: string } | undefined,
): { readonly text: string; readonly replyTo: { readonly messageId: string; readonly part: number } | undefined } | null => {
  // Blank lines at either end go; in a message of more lines, its first line's indent (a code block's) stays.
  const lines = body.replace(/^\s*\n/u, "").trimEnd();
  const words = lines.includes("\n") ? lines : lines.trim();
  if (words === "" && files === 0) return null;
  if (reply === undefined) return { text: words, replyTo: undefined };
  return { text: words === "" ? replyText(reply.quote, "").trim() : replyText(reply.quote, words), replyTo: { messageId: reply.id, part: reply.part } };
};

/** A message that replies to a bubble: the quote and the words under it; undefined for any other text. */
export const replyOf = (text: string): { readonly quote: string; readonly body: string } | undefined => {
  const m = /^> ([^\n]+)\n\n(?!>)([\s\S]*\S[\s\S]*)$/u.exec(text);
  return m === null ? undefined : { quote: m[1] ?? "", body: m[2] ?? "" };
};

/**
 * The line under a row of the person's own, for what stays: a send that didn't go (its ! offers Try Again and Delete),
 * or a lead that can't take it yet. Nothing while it goes, as in Messages: a line that came and went under each send
 * would bounce the thread. A slow one has its mark beside the bubble instead (sendWait).
 */
export const sendNote = (item: Pick<ChatItem, "state" | "error" | "leadWaiting">): string | undefined => {
  switch (item.state) {
    case "pending":
    case "queued":
    case "reconnecting":
      return undefined;
    case "unanswered":
      return "Not sent: the hub didn't answer.";
    case "failed":
      return `Not sent: ${item.error?.message ?? "the hub refused it."}`;
    default:
      return item.leadWaiting;
  }
};

/** How long a send goes before it says so: one the hub takes sooner shows nothing at all. */
export const SLOW_SEND_MS = 1_000;

/**
 * A send still on its way: what its mark beside the bubble says (VoiceOver reads it), and how long until it shows, 0
 * once it has gone SLOW_SEND_MS. Undefined once the hub has it, or it failed. The mark sits out of the row's layout, so
 * neither its coming nor its going moves the thread; the bar under the chat's name says when the link is down.
 */
export const sendWait = (item: Pick<ChatItem, "state" | "at">, nowMs: number): { readonly words: string; readonly inMs: number } | undefined => {
  const words =
    item.state === "pending"
      ? "Sending…"
      : item.state === "queued"
        ? "Not connected: it goes when the hub is back."
        : item.state === "reconnecting"
          ? "The link dropped: it goes again when the hub is back."
          : undefined;
  return words === undefined ? undefined : { words, inMs: Math.max(0, msOf(item.at) + SLOW_SEND_MS - nowMs) };
};

/** Where a person's message came from when it wasn't typed in an app or the CLI, as the desktop says it. */
const VIA: Partial<Record<string, string>> = { share: "the Share Sheet", shortcuts: "Shortcuts" };

/** The quiet line under a person's message sent from outside the app: "via Shortcuts", "via the Share Sheet". */
export const viaNote = (item: Pick<ChatItem, "author" | "message">): string | undefined => {
  const via = item.author === "human" && item.message?.client !== undefined ? VIA[item.message.client] : undefined;
  return via === undefined ? undefined : `via ${via}`;
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
          return previewText(b.text, { blocks: item.author !== "human", streaming: item.message?.state === "streaming" });
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

/** The message whose card answers an approval: where a tapped approval opens its chat. Undefined: not in what's read. */
export const cardOf = (items: readonly Pick<ChatItem, "message">[], requestId: string): string | undefined =>
  items.find((i) => i.message?.item?.kind === "command_approval" && i.message.item.requestId === requestId)?.message?.messageId;

/**
 * Where a chat opened at a message (a search hit) or an approval (its notification) lands: the message, once it is
 * read; `older` while an approval's card is further back than the pages read, so one more is read; undefined when
 * there is nothing to land on (the card isn't in the chat, or its page can't be read now), so the chat opens as usual.
 */
export const landingOf = (
  items: readonly Pick<ChatItem, "message">[],
  want: { readonly messageId?: string | undefined; readonly requestId?: string | undefined },
  chat: { readonly hasOlder: boolean; readonly failed: boolean },
): string | "older" | undefined => {
  if (want.messageId !== undefined) return want.messageId;
  if (want.requestId === undefined) return undefined;
  const card = cardOf(items, want.requestId);
  if (card !== undefined) return card;
  return chat.hasOlder && !chat.failed ? "older" : undefined;
};

/** Which side a row sits on: the person's on the right, the lead's and agents' on the left, the rest centred. */
type Side = "me" | "them" | "center";

const sideOf = (item: Pick<ChatItem, "author" | "kind">): Side =>
  item.kind !== "message" ? "center" : item.author === "human" ? "me" : item.author === "system" ? "center" : "them";

export type ThreadRow =
  /** A new day starts: "Today", "Yesterday", a date. */
  | { readonly t: "day"; readonly id: string; readonly at: string }
  /** `worked`: the reply a turn ended with, how long the turn took ("Worked for 4s"), a quiet stamp under it. */
  | { readonly t: "item"; readonly id: string; readonly item: ChatItem; readonly side: Side; readonly first: boolean; readonly worked?: string }
  /** Where what you haven't read starts, as chat apps' "Unread Messages" bar. */
  | { readonly t: "unread"; readonly id: string };

/**
 * Whether two rows draw the same: the thread makes its rows anew with each change (a streamed word), and a row that is
 * the same draws nothing again. A row's message is made anew too, from the same hub message and fields.
 */
export const sameRow = (a: ThreadRow, b: ThreadRow): boolean => {
  if (a === b) return true;
  if (a.t !== b.t || a.id !== b.id) return false;
  if (a.t === "item" && b.t === "item") return a.side === b.side && a.first === b.first && a.worked === b.worked && sameItem(a.item, b.item);
  if (a.t === "day" && b.t === "day") return a.at === b.at;
  return true;
};

const sameItem = (a: ChatItem, b: ChatItem): boolean => {
  if (a === b) return true;
  const keys = Object.keys(a) as Array<keyof ChatItem>;
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** Messages this close together are one burst. */
const GROUP_MS = 5 * 60_000;

const msOf = (at: string): number => {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? 0 : ms;
};

/** Who wrote it, as grouping sees it: two agents' messages don't group, nor the lead's with an agent's. */
const voice = (item: ChatItem): string => `${item.author}:${item.author === "agent" ? (item.message?.by ?? "") : ""}`;

const joins = (a: ChatItem | undefined, b: ChatItem | undefined): boolean =>
  a !== undefined && b !== undefined && sideOf(a) !== "center" && sideOf(a) === sideOf(b) && voice(a) === voice(b) && msOf(b.at) - msOf(a.at) < GROUP_MS;

/** A turn's reply is written just before it ends; the hub may stamp the two a moment apart either way. */
const REPLY_SLACK_MS = 2_000;

/**
 * The rows to draw, oldest first. What the lead is doing is no row: it is a line over the composer (screens/TurnLine.tsx),
 * so the thread never moves for it. `worked`: the lead's latest turn seen to its end, whose reply (its newest message
 * written in it) wears how long it took. `readSeq`: what was read when the chat opened; the unread bar goes before the
 * first message from the other side after it. A day line goes where a new day starts, in the clock's zone, as chat
 * apps' date chips.
 */
export const threadRows = (
  items: readonly ChatItem[],
  worked?: { readonly since: number; readonly until: number },
  readSeq?: number,
  clock: Pick<Clock, "timeZone"> = {},
): ThreadRow[] => {
  const rows: ThreadRow[] = [];
  const reply =
    worked === undefined
      ? -1
      : items.findLastIndex((i) => i.author === "lead" && i.kind === "message" && i.state !== "streaming" && msOf(i.at) >= worked.since && msOf(i.at) <= worked.until + REPLY_SLACK_MS);
  const stamp = worked === undefined ? undefined : `Worked for ${workedFor(worked.until - worked.since)}`;
  let prev: ChatItem | undefined;
  let prevDay = 0;
  const firstUnread = readSeq === undefined ? -1 : items.findIndex((i) => i.author !== "human" && i.kind === "message" && (i.message?.seq ?? 0) > readSeq);
  for (const [i, item] of items.entries()) {
    if (i === firstUnread) rows.push({ t: "unread", id: "unread" });
    const day = dayAt(item.at, clock);
    if (prev === undefined || day !== prevDay) rows.push({ t: "day", id: `day:${String(day)}`, at: item.at });
    prevDay = day;
    const side = sideOf(item);
    rows.push({ t: "item", id: item.clientRequestId ?? item.id, item, side, first: i === firstUnread || !joins(prev, item), ...(i === reply && stamp !== undefined ? { worked: stamp } : {}) });
    prev = item;
  }
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

/** A message's day by its time as the hub wrote it, worked out once per zone: a thread asks for each with every word streamed. */
const days = new Map<string, number>();
const dayAt = (at: string, clock: Pick<Clock, "timeZone">): number => {
  const key = `${clock.timeZone ?? ""}|${at}`;
  let day = days.get(key);
  if (day === undefined) {
    if (days.size >= 10_000) days.clear();
    day = dayOf(msOf(at), clock);
    days.set(key, day);
  }
  return day;
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

/** A day line in a thread, as chat apps draw one: "Today", "Yesterday", "Tuesday 27 October", with the year when it isn't this one. */
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

// Where the thread lands and what counts as read. The list is upside down: its offset 0 is the newest end, and a row's
// offset is how far its newest edge is from there.

/**
 * scrollToIndex's viewOffset that puts a row at `viewPosition` (0 the newest end, 1 the oldest) of what shows between
 * the composer and the bar over the thread, rather than of the whole list: VirtualizedList subtracts it from the
 * offset, so a row at the far end goes `top` less far, under the bar, and one at the near end clears the composer.
 */
export const viewOffsetOf = (viewPosition: number, top: number, composer: number): number => (1 - viewPosition) * composer - viewPosition * top;

/**
 * scrollToIndex's viewPosition and viewOffset for a row: at `viewPosition` of what shows between the bar and the
 * composer (viewOffsetOf), or, once measured (`length`) and taller than that, starting just under the bar rather than
 * under it. Measured, the bar and the composer go into the viewPosition with no viewOffset: VirtualizedList keeps the
 * offset from going past the newest end before it takes the viewOffset off, so a row near the newest end lands there,
 * not a little older or past it.
 */
export const aimOf = (viewPosition: number, length: number | undefined, visible: number, top: number, composer: number): { viewPosition: number; viewOffset: number } => {
  const at = length !== undefined && length > visible - top - composer ? 1 : viewPosition;
  const viewOffset = viewOffsetOf(at, top, composer);
  if (length === undefined || Math.abs(visible - length) < 1) return { viewPosition: at, viewOffset };
  return { viewPosition: at + viewOffset / (visible - length), viewOffset: 0 };
};

/**
 * Where the status bar's tap takes the thread: most of a screen (`room`, what shows between the bar and the composer)
 * older than `y`, no further than the oldest end of `length`, in a list `height` tall.
 */
export const olderOffset = (y: number, length: number, room: number, height: number): number => Math.max(0, Math.min(y + room * 0.85, length - height));

/** The newest message among the rows on screen: read once seen, as chat apps mark it. */
export const seenSeq = (rows: readonly ThreadRow[]): number | undefined => {
  let seq: number | undefined;
  for (const r of rows) {
    const s = r.t === "item" ? r.item.message?.seq : undefined;
    if (s !== undefined && (seq === undefined || s > seq)) seq = s;
  }
  return seq;
};

/**
 * Where the reply streaming in sits among the rows, newest first, while it's the newest: the thread follows it until
 * its first line reaches the bar, then holds it there.
 */
export const streamingAt = (newestFirst: readonly ThreadRow[]): number | undefined => {
  const r = newestFirst[0];
  return r?.t === "item" && r.item.message?.state === "streaming" ? 0 : undefined;
};
