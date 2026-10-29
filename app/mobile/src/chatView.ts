// A chat as the phone lays it out, iMessage's way: a lead message of several parts is several bubbles, and its blocks
// are cards (a pull request, a checklist, a table, an ask with its buttons; a chart, diff or clip is for the desktop,
// said in words). Messages from one side in a burst group, tight, with the tail on the last; a time line goes between
// bursts; and a typing bubble shows while the lead works. Pure, so it is unit-tested.
import type { ChatItem } from "./desktop";
import { previewText } from "./markdown";

export type Bubble =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ask"; readonly question: string; readonly options: readonly string[] }
  | { readonly kind: "pr"; readonly repo: string; readonly number: number; readonly title: string | undefined }
  | { readonly kind: "checklist"; readonly title: string | undefined; readonly items: ReadonlyArray<{ readonly done: boolean; readonly text: string }> }
  | { readonly kind: "table"; readonly title: string | undefined; readonly columns: readonly string[]; readonly rows: ReadonlyArray<readonly string[]> }
  | { readonly kind: "block"; readonly text: string };

const BLOCK_WORDS: Readonly<Record<string, string>> = {
  chart: "A chart",
  diff: "A diff",
  agent: "An agent",
  image: "An image",
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
      default:
        return [{ kind: "block", text: `${BLOCK_WORDS[block.kind] ?? "Something"} the desktop app shows.` }];
    }
  });
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
export const previewOf = (item: Pick<ChatItem, "text" | "message" | "author">): string => {
  const inline = item.message?.item;
  if (inline?.kind === "command_approval") return "Asks for your approval";
  if (inline?.kind === "secret_request") return "Asks for a secret";
  const line = bubbles(item)
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
      }
    })
    .filter((s) => s !== "")
    .join(" ");
  return item.author === "human" && line !== "" ? `You: ${line}` : line;
};

/** Which side a row sits on: the person's on the right, the lead's and agents' on the left, the rest centred. */
export type Side = "me" | "them" | "center";

export const sideOf = (item: Pick<ChatItem, "author" | "kind">): Side =>
  item.kind !== "message" ? "center" : item.author === "human" ? "me" : item.author === "system" ? "center" : "them";

export type ThreadRow =
  | { readonly t: "time"; readonly id: string; readonly at: string }
  | { readonly t: "item"; readonly id: string; readonly item: ChatItem; readonly side: Side; readonly first: boolean; readonly last: boolean }
  | { readonly t: "typing"; readonly id: string };

/** Messages this close together are one burst. */
export const GROUP_MS = 5 * 60_000;
/** A quiet this long gets a time line. */
export const TIME_GAP_MS = 30 * 60_000;

const msOf = (at: string): number => {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? 0 : ms;
};

/** Who wrote it, as grouping sees it: two agents' messages don't group, nor the lead's with an agent's. */
const voice = (item: ChatItem): string => `${item.author}:${item.author === "agent" ? (item.message?.by ?? "") : ""}`;

const joins = (a: ChatItem | undefined, b: ChatItem | undefined): boolean =>
  a !== undefined && b !== undefined && sideOf(a) !== "center" && sideOf(a) === sideOf(b) && voice(a) === voice(b) && msOf(b.at) - msOf(a.at) < GROUP_MS;

/** The rows to draw, oldest first. `working`: the lead is mid-turn, so a typing bubble ends the thread unless its text already streams. */
export const threadRows = (items: readonly ChatItem[], working = false): ThreadRow[] => {
  const rows: ThreadRow[] = [];
  let prev: ChatItem | undefined;
  for (const [i, item] of items.entries()) {
    const at = msOf(item.at);
    const gap = prev === undefined || at - msOf(prev.at) >= TIME_GAP_MS;
    if (gap) rows.push({ t: "time", id: `time:${item.id}`, at: item.at });
    const side = sideOf(item);
    const next = items[i + 1];
    rows.push({ t: "item", id: item.id, item, side, first: !joins(prev, item), last: !joins(item, next) });
    prev = item;
  }
  const streaming = items.at(-1)?.state === "streaming";
  if (working && !streaming) rows.push({ t: "typing", id: "typing" });
  return rows;
};

export interface Clock {
  readonly nowMs: number;
  readonly locale?: string | undefined;
  readonly timeZone?: string | undefined;
}

const DAY_MS = 86_400_000;

/** Days from `ms` to now, by the calendar in the clock's zone: 0 today, 1 yesterday. */
const daysAgo = (ms: number, clock: Clock): number => {
  const day = (t: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: clock.timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(t);
    const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Date.UTC(n("year"), n("month") - 1, n("day"));
  };
  return Math.round((day(clock.nowMs) - day(ms)) / DAY_MS);
};

const fmt = (ms: number, clock: Clock, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(clock.locale, { timeZone: clock.timeZone, ...options }).format(ms);

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

/** A chats list row's time: the time today, then "Yesterday", the weekday this week, else the date. */
export const listTime = (at: string, clock: Clock): string => {
  const ms = msOf(at);
  const days = daysAgo(ms, clock);
  if (days <= 0) return clockTime(ms, clock);
  if (days === 1) return "Yesterday";
  if (days < 7) return fmt(ms, clock, { weekday: "long" });
  return fmt(ms, clock, { day: "numeric", month: "numeric", year: "2-digit" });
};
