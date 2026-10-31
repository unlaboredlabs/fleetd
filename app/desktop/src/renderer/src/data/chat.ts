// Each project's lead chat: its history pages, the live messages and streamed text, and the person's own messages
// on their way to the hub. Pure reducers over DataState; the layer (chat-layer.ts) does the calls.
//
// One message, one row. History, `chat.message` events and send answers can all carry the same message, in any
// order: rows merge by messageId, and the newer copy (updatedAt, then a final over a streaming one) wins, so an
// older answer never overwrites a newer one.
//
// The person's sends keep the steer rules (screens/order/sending.ts): one clientRequestId per composed message,
// reused on every resend, so the hub (which dedupes on it) never stores it twice. A call cut off by the link may
// have reached the hub: it waits and goes again on reconnect, and is never called "not sent". A message written
// with no hub to send it to is queued under its id and goes when the link is back.
//
// A chat outlives its connection: after a drop or a reconnect it is `cached`, still shown, until this connection's
// latest page replaces it (or, at launch, it came from the disk cache, cache.ts).
import type { HubError } from "../../../shared/hub";
import type { AttachmentRef, ChatDelta, ChatHistoryOutput, ChatMessage, ChatReplyTo, KnownChatAuthor } from "./chat-contract";

/**
 * How many messages a chat keeps as live ones arrive; older ones are paged back in from history. Paging back only
 * adds: the newest messages are never evicted, so there is one direction to page and live messages always land.
 */
export const CHAT_KEEP = 2000;
export const CHAT_PAGE = 50;

/** A lead message's streamed text so far. */
export interface Stream {
  readonly text: string;
  /** When its first frame arrived, on the hub's clock: the row's time while its message isn't listed yet. */
  readonly at: string;
}

export interface Chat {
  /** Oldest first, by seq. */
  readonly messages: readonly ChatMessage[];
  readonly streams: Readonly<Record<string, Stream>>;
  /** Why the lead doesn't have a sent message yet, from chat_send, by messageId. */
  readonly leadWaiting: Readonly<Record<string, string>>;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** A cached chat's live messages, kept aside for the latest page that starts it over (mergeLive). */
  readonly held: readonly ChatMessage[];
  /** The latest page landed this generation. */
  readonly loaded: boolean;
  readonly error?: HubError | undefined;
  /** A delta skipped a frame: some text went missing, so the latest page is read again. */
  readonly gap?: boolean | undefined;
  /** Messages an event named but didn't carry (over its 2 KB): read one by one, by seq. */
  readonly missing: readonly number[];
  /** From an earlier connection or the disk: shown as it was until this connection's latest page replaces it. */
  readonly cached?: boolean | undefined;
}

export const emptyChat: Chat = {
  messages: [],
  streams: {},
  leadWaiting: {},
  hasOlder: false,
  loadingOlder: false,
  held: [],
  loaded: false,
  missing: [],
};

/**
 * A chat kept past its connection (a drop, then a new snapshot): what it showed, with nothing in flight. The next
 * latest page starts it over. Undefined when it never showed anything.
 */
export const heldChat = (chat: Chat): Chat | undefined =>
  chat.loaded || chat.cached === true
    ? { ...chat, loaded: false, cached: true, loadingOlder: false, error: undefined, gap: false, missing: [] }
    : undefined;

const streaming = (m: ChatMessage): boolean => m.state === "streaming";
const stamp = (m: ChatMessage): string => m.updatedAt ?? m.createdAt;

/** Whether `incoming` should replace `current` (same messageId). */
const newer = (incoming: ChatMessage, current: ChatMessage): boolean => {
  const a = stamp(incoming);
  const b = stamp(current);
  if (a !== b) return a > b;
  return streaming(current) && !streaming(incoming);
};

const without = <T>(map: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> =>
  key in map ? Object.fromEntries(Object.entries(map).filter(([k]) => k !== key)) : map;

/**
 * Messages folded into a chat. A final message ends its stream. Past CHAT_KEEP (or what paging back has grown it to)
 * the oldest go; an older page is kept whole.
 */
export const mergeMessages = (chat: Chat, incoming: readonly ChatMessage[], older = false): Chat => {
  if (incoming.length === 0) return chat;
  const byId = new Map(chat.messages.map((m) => [m.messageId, m]));
  let streams = chat.streams;
  for (const m of incoming) {
    const current = byId.get(m.messageId);
    if (current === undefined || newer(m, current)) byId.set(m.messageId, m);
    const kept = byId.get(m.messageId);
    const streamed = streams[m.messageId];
    // A final message ends its stream; a streaming copy with more text than streamed so far replaces it.
    if (streamed !== undefined && (kept === undefined || !streaming(kept) || kept.text.length > streamed.text.length)) {
      streams = without(streams, m.messageId);
    }
  }
  const sorted = [...byId.values()].sort((a, b) => a.seq - b.seq);
  const keep = older ? Infinity : Math.max(CHAT_KEEP, chat.messages.length);
  const trimmed = sorted.length > keep;
  const got = new Set(incoming.map((m) => m.seq));
  return {
    ...chat,
    missing: chat.missing.some((seq) => got.has(seq)) ? chat.missing.filter((seq) => !got.has(seq)) : chat.missing,
    messages: trimmed ? sorted.slice(sorted.length - keep) : sorted,
    streams,
    hasOlder: chat.hasOlder || trimmed,
  };
};

/**
 * A live message, folded in. A cached chat (kept past its connection, or from the disk cache) keeps it aside: the
 * latest page starts the chat over, and they join that page, newer copy winning, so a reply finished while the page
 * was out isn't lost to the page's older copy.
 */
export const mergeLive = (chat: Chat, message: ChatMessage): Chat =>
  chat.cached !== true
    ? mergeMessages(chat, [message])
    : { ...chat, held: [...chat.held.filter((m) => m.messageId !== message.messageId || !newer(message, m)), message] };

/**
 * The person's own line (a send, a Stop): a held chat shows it at once, so their words never vanish into a chat that
 * can't place them, and keeps it aside too, for the latest page that starts the chat over.
 */
export const mergeOwn = (chat: Chat, message: ChatMessage): Chat =>
  chat.cached === true ? mergeMessages(mergeLive(chat, message), [message]) : mergeLive(chat, message);

/**
 * A history page: the latest one, or one before the oldest message held. The latest page starts a cached chat over:
 * the page is the truth now, and what it showed may not join up with it. Its live messages kept aside then go in.
 */
export const applyHistory = (chat: Chat, page: ChatHistoryOutput, direction: "latest" | "older"): Chat => {
  const restart = direction === "latest" && chat.cached === true;
  const base = restart ? { ...chat, messages: [], streams: {}, hasOlder: false, cached: false } : chat;
  const merged = mergeMessages(base, page.messages, direction === "older");
  const fresh = !chat.loaded || restart;
  const next = {
    ...merged,
    // The latest page says nothing about what's older than messages already held from an earlier page.
    hasOlder: direction === "older" ? page.moreBefore : fresh ? page.moreBefore || merged.hasOlder : merged.hasOlder,
    loadingOlder: direction === "older" ? false : chat.loadingOlder,
    loaded: true,
    error: undefined,
    gap: false,
  };
  return next.held.length === 0 ? next : { ...mergeMessages(next, next.held), held: [] };
};

/**
 * One streamed frame, placed by its offset (the text's UTF-16 length before it): it extends the text when it starts
 * at its end, a repeat (or the part already held) is skipped, and one starting past the end marks a gap (the latest
 * page is read again). A final message takes no more. A chat joined mid-message goes on from history's text.
 * `hubNowMs` stamps a new stream with its arrival.
 */
export const applyDelta = (chat: Chat, d: ChatDelta, hubNowMs: number): Chat => {
  const message = chat.messages.find((m) => m.messageId === d.messageId);
  if (message !== undefined && !streaming(message)) return chat;
  const text = chat.streams[d.messageId]?.text ?? message?.text ?? "";
  if (d.offset > text.length) return { ...chat, gap: true };
  if (d.offset + d.append.length <= text.length) return chat;
  const next = text + d.append.slice(text.length - d.offset);
  const at = chat.streams[d.messageId]?.at ?? new Date(hubNowMs).toISOString();
  return { ...chat, streams: { ...chat.streams, [d.messageId]: { text: next, at } } };
};

// The person's messages on their way.

export type SendState =
  | { readonly t: "sending" }
  /** Written with no hub to send it to: it goes, under its own id, when the link is back. */
  | { readonly t: "queued" }
  /** The link dropped with it in flight: resent with the same id when it is back. */
  | { readonly t: "reconnecting" }
  /** The call timed out twice: the hub may have it. Resent on the next reconnect, or by hand. */
  | { readonly t: "unanswered" }
  /** The hub refused it. */
  | { readonly t: "failed"; readonly error: HubError };

export interface ChatSend {
  readonly clientRequestId: string;
  readonly text: string;
  readonly attachments: readonly AttachmentRef[];
  readonly at: string;
  readonly state: SendState;
  /** Sent with ⌘Enter: chat_send's `now`, kept for every resend. */
  readonly now?: boolean;
  /** A reply: the lead's bubble it answers, kept for every resend. */
  readonly replyTo?: ChatReplyTo;
  /** The skills named with `$name`, which the lead's copy lists. */
  readonly skills?: readonly string[];
  /** An earlier call was cut off: the hub may hold it, so it is never called "not sent". */
  readonly reached?: boolean;
}

export type CallResult = { readonly ok: true; readonly message: ChatMessage } | { readonly ok: false; readonly error: HubError };

/**
 * What a chat_send answer does to its row: the hub's message removes it, a cut-off keeps it for a resend, and no
 * hub at all queues it.
 */
export const afterCall = (row: ChatSend, r: CallResult): ChatSend | undefined => {
  if (r.ok) return undefined;
  const code = r.error.code;
  if (code === "disconnected" || (code === "offline" && row.reached === true)) {
    return { ...row, state: { t: "reconnecting" }, reached: true };
  }
  if (code === "offline") return { ...row, state: { t: "queued" } };
  if (code === "timeout") return { ...row, state: { t: "unanswered" }, reached: true };
  return { ...row, state: { t: "failed", error: r.error } };
};

/** Upsert by clientRequestId: a resend is the same row, in its place, and remembers an earlier cut-off. */
export const upsertSend = (rows: readonly ChatSend[], row: ChatSend): readonly ChatSend[] => {
  const at = rows.findIndex((r) => r.clientRequestId === row.clientRequestId);
  if (at === -1) return [...rows, row];
  const next = rows[at]?.reached === true ? { ...row, reached: true } : row;
  return rows.map((r, i) => (i === at ? next : r));
};

/** Rows to send again, under their own ids, once the link is back after it was really lost. */
export const toResend = (rows: readonly ChatSend[]): readonly ChatSend[] =>
  rows.filter((r) => r.state.t === "queued" || r.state.t === "reconnecting" || r.state.t === "unanswered");

/** Rows that go as soon as there is a connection, whether or not one was lost first. */
export const queued = (rows: readonly ChatSend[]): readonly ChatSend[] => rows.filter((r) => r.state.t === "queued");

/**
 * The clientRequestId a message's chat_send carried. The hub keeps it under the key that sent it, "key_…:<id>" (one
 * message per key and id), and gives it back that way.
 */
export const sentAs = (m: ChatMessage): string | undefined => m.clientRequestId?.slice(m.clientRequestId.indexOf(":") + 1);

/** A message the hub now has settles its row (echo or answer, whichever comes first); a failed row stays. */
export const settleSends = (rows: readonly ChatSend[], messages: readonly ChatMessage[]): readonly ChatSend[] => {
  const echoed = new Set(messages.flatMap((m) => sentAs(m) ?? []));
  if (echoed.size === 0) return rows;
  const next = rows.filter((r) => r.state.t === "failed" || !echoed.has(r.clientRequestId));
  return next.length === rows.length ? rows : next;
};

// What the chat view lists.

export type ChatItemState = "sent" | "streaming" | "pending" | "queued" | "reconnecting" | "unanswered" | "failed";
/** A message; a PR / merge one-liner, system line or migrated history line; or one of the two inline items. */
export type ChatItemKind = "message" | "event" | "secret" | "gated";

export interface ChatItem {
  /** The messageId; the clientRequestId while the hub doesn't have it yet. */
  readonly id: string;
  /** A newer hub's author shows as a system line. */
  readonly author: KnownChatAuthor;
  readonly kind: ChatItemKind;
  /** Markdown; while streaming, the text so far. Empty on inline items: they read `message.item`. */
  readonly text: string;
  readonly at: string;
  /** Each with its name, type and size; attachment_get reads its bytes. */
  readonly attachments: readonly AttachmentRef[];
  readonly state: ChatItemState;
  readonly error?: HubError | undefined;
  readonly clientRequestId?: string | undefined;
  /** How a human message reached the lead (turn, steer, queued). */
  readonly delivery?: ChatMessage["delivery"] | undefined;
  /** Why the lead doesn't have it yet, with the fix (chat_send's answer). */
  readonly leadWaiting?: string | undefined;
  /** The hub's message: inline items, migrated history and the rest of its fields. */
  readonly message?: ChatMessage | undefined;
}

const noAttachments: readonly AttachmentRef[] = [];

const authorOf = (a: ChatMessage["author"]): KnownChatAuthor =>
  a === "human" ? "human" : a === "lead" ? "lead" : a === "agent" ? "agent" : "system";

const kindOf = (m: ChatMessage): ChatItemKind => {
  if (m.item?.kind === "secret_request") return "secret";
  if (m.item?.kind === "command_approval") return "gated";
  return m.history !== undefined || authorOf(m.author) === "system" ? "event" : "message";
};

const messageItem = (m: ChatMessage, chat: Chat): ChatItem => ({
  id: m.messageId,
  author: authorOf(m.author),
  kind: kindOf(m),
  text: chat.streams[m.messageId]?.text ?? m.text,
  at: m.createdAt,
  attachments: m.attachments ?? noAttachments,
  state: streaming(m) ? "streaming" : "sent",
  clientRequestId: sentAs(m),
  delivery: m.delivery,
  leadWaiting: chat.leadWaiting[m.messageId],
  message: m,
});

const sendItem = (r: ChatSend): ChatItem => ({
  id: r.clientRequestId,
  author: "human",
  kind: "message",
  text: r.text,
  at: r.at,
  attachments: r.attachments,
  state: r.state.t === "sending" ? "pending" : r.state.t,
  error: r.state.t === "failed" ? r.state.error : undefined,
  clientRequestId: r.clientRequestId,
});

/**
 * The rows, oldest first: the hub's messages, a stream with no message yet as the lead's (deltas are pushed at once,
 * while its `chat.message` event can wait behind a burst of events or a reconnect's backlog), then the person's sends.
 */
export const chatItems = (chat: Chat, sends: readonly ChatSend[]): readonly ChatItem[] => {
  const items = chat.messages.map((m) => messageItem(m, chat));
  const known = new Set(chat.messages.map((m) => m.messageId));
  for (const [id, s] of Object.entries(chat.streams)) {
    if (known.has(id)) continue;
    items.push({ id, author: "lead", kind: "message", text: s.text, at: s.at, attachments: noAttachments, state: "streaming" });
  }
  // A send the hub has (a failed row stays) is its message: one row, as the list keys rows by it.
  const sent = new Set(items.flatMap((i) => i.clientRequestId ?? []));
  return [...items, ...sends.filter((r) => !sent.has(r.clientRequestId)).map(sendItem)];
};
