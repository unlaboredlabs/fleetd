// Each project's lead chat: its history pages, the live messages and streamed text, and the person's own messages
// on their way to the hub. Pure reducers over DataState; the layer (queries.ts) does the calls.
//
// One message, one row. History, `chat.message` events and send answers can all carry the same message, in any
// order: rows merge by messageId, and the newer copy (updatedAt, then a finished stream over a streaming one) wins,
// so an older answer never overwrites a newer one.
//
// The person's sends keep the steer rules (screens/order/sending.ts): one clientRequestId per composed message,
// reused on every resend, so the hub (which dedupes on it) never stores it twice. A call cut off by the link may
// have reached the hub: it waits and goes again on reconnect, and is never called "not sent".
import type { HubError } from "../../../shared/hub";
import type { ChatAttachment, ChatDeltaData, ChatHistoryOutput, ChatMessage } from "./chat-contract";

/** How many messages a chat keeps in memory; older ones are paged back in from history. */
export const CHAT_KEEP = 2000;
export const CHAT_PAGE = 50;

export interface Chat {
  /** Oldest first, by seq. */
  readonly messages: readonly ChatMessage[];
  /** The text streamed so far per lead message, until its finished copy arrives. */
  readonly streams: Readonly<Record<string, string>>;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** The latest page landed this generation. */
  readonly loaded: boolean;
  readonly error?: HubError | undefined;
  /** A delta arrived past the end of its stream: some text went missing, so the latest page is read again. */
  readonly gap?: boolean | undefined;
}

export const emptyChat: Chat = { messages: [], streams: {}, hasOlder: false, loadingOlder: false, loaded: false };

const stamp = (m: ChatMessage): string => m.updatedAt ?? m.createdAt;

/** Whether `incoming` should replace `current` (same messageId). */
const newer = (incoming: ChatMessage, current: ChatMessage): boolean => {
  const a = stamp(incoming);
  const b = stamp(current);
  if (a !== b) return a > b;
  return current.streaming === true && incoming.streaming !== true;
};

/** Messages folded into a chat. A finished message ends its stream; the chat keeps its newest CHAT_KEEP. */
export const mergeMessages = (chat: Chat, incoming: readonly ChatMessage[]): Chat => {
  if (incoming.length === 0) return chat;
  const byId = new Map(chat.messages.map((m) => [m.messageId, m]));
  let streams = chat.streams;
  for (const m of incoming) {
    const current = byId.get(m.messageId);
    if (current === undefined || newer(m, current)) byId.set(m.messageId, m);
    const kept = byId.get(m.messageId);
    const streamed = streams[m.messageId];
    // A finished message ends its stream; a streaming copy at least as long as what streamed so far replaces it.
    if (streamed !== undefined && (kept?.streaming !== true || (kept.text.length >= streamed.length))) {
      streams = Object.fromEntries(Object.entries(streams).filter(([id]) => id !== m.messageId));
    }
  }
  const sorted = [...byId.values()].sort((a, b) => a.seq - b.seq || a.messageId.localeCompare(b.messageId));
  const trimmed = sorted.length > CHAT_KEEP;
  return {
    ...chat,
    messages: trimmed ? sorted.slice(sorted.length - CHAT_KEEP) : sorted,
    streams,
    hasOlder: chat.hasOlder || trimmed,
  };
};

/** A history page: the latest one (`older` false) or one before the oldest message held. */
export const applyHistory = (chat: Chat, page: ChatHistoryOutput, older: boolean): Chat => {
  const merged = mergeMessages(chat, page.messages);
  return {
    ...merged,
    // The latest page says nothing about what's older than the messages already held from an earlier page.
    hasOlder: older ? page.hasOlder : chat.loaded ? merged.hasOlder : page.hasOlder,
    loadingOlder: older ? false : chat.loadingOlder,
    loaded: true,
    error: undefined,
    gap: false,
  };
};

/**
 * Streamed text, idempotent: a delta repeating text already held is ignored, one overlapping its end adds only the
 * rest, and one past the end marks a gap (the latest page is read again). A finished message takes no deltas.
 */
export const applyDelta = (chat: Chat, d: ChatDeltaData): Chat => {
  const message = chat.messages.find((m) => m.messageId === d.messageId);
  if (message !== undefined && message.streaming !== true) return chat;
  const text = chat.streams[d.messageId] ?? message?.text ?? "";
  if (d.offset > text.length) return { ...chat, gap: true };
  const end = d.offset + d.append.length;
  if (end <= text.length) return chat;
  const next = text + d.append.slice(text.length - d.offset);
  return { ...chat, streams: { ...chat.streams, [d.messageId]: next } };
};

// The person's messages on their way.

export type SendState =
  | { readonly t: "sending" }
  /** The link dropped with it in flight: resent with the same id when it is back. */
  | { readonly t: "reconnecting" }
  /** The call timed out twice: the hub may have it. Resent on the next reconnect, or by hand. */
  | { readonly t: "unanswered" }
  /** The hub never stored it: it refused it, or (a resend) there was no hub to ask. */
  | { readonly t: "failed"; readonly error: HubError; readonly offline?: boolean };

export interface ChatSend {
  readonly clientRequestId: string;
  readonly text: string;
  readonly attachments: readonly ChatAttachment[];
  readonly at: string;
  readonly state: SendState;
  /** An earlier call was cut off: the hub may hold it, so it is never called "not sent". */
  readonly reached?: boolean;
}

export type CallResult = { readonly ok: true; readonly message: ChatMessage } | { readonly ok: false; readonly error: HubError };

/** What a chat_send answer does to its row: the hub's message removes it, a cut-off keeps it for a resend. */
export const afterCall = (row: ChatSend, r: CallResult): ChatSend | undefined => {
  if (r.ok) return undefined;
  const code = r.error.code;
  if (code === "disconnected" || (code === "offline" && row.reached === true)) {
    return { ...row, state: { t: "reconnecting" }, reached: true };
  }
  if (code === "timeout") return { ...row, state: { t: "unanswered" }, reached: true };
  return { ...row, state: { t: "failed", error: r.error, ...(code === "offline" ? { offline: true } : {}) } };
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
  rows.filter((r) => r.state.t === "reconnecting" || r.state.t === "unanswered");

/** A message the hub now has settles its row (echo or answer, whichever comes first); a failed row stays. */
export const settleSends = (rows: readonly ChatSend[], messages: readonly ChatMessage[]): readonly ChatSend[] => {
  const echoed = new Set(messages.flatMap((m) => (m.clientRequestId === undefined ? [] : [m.clientRequestId])));
  if (echoed.size === 0) return rows;
  const next = rows.filter((r) => r.state.t === "failed" || !echoed.has(r.clientRequestId));
  return next.length === rows.length ? rows : next;
};

// What the chat view lists.

export type ChatItemState = "sent" | "streaming" | "pending" | "reconnecting" | "unanswered" | "failed";

export interface ChatItem {
  /** The messageId; the clientRequestId while the hub doesn't have it yet. */
  readonly id: string;
  readonly author: ChatMessage["author"];
  readonly kind: ChatMessage["kind"];
  /** Markdown; while streaming, the text so far. */
  readonly text: string;
  readonly at: string;
  readonly attachments: readonly ChatAttachment[];
  readonly state: ChatItemState;
  readonly error?: HubError | undefined;
  /** Failed for want of a hub, not refused by one. */
  readonly offline?: boolean | undefined;
  readonly clientRequestId?: string | undefined;
  /** The hub's message, for the inline items' own fields. */
  readonly message?: ChatMessage | undefined;
}

const noAttachments: readonly ChatAttachment[] = [];

const messageItem = (m: ChatMessage, streamed: string | undefined): ChatItem => ({
  id: m.messageId,
  author: m.author,
  kind: m.kind,
  text: streamed ?? m.text,
  at: m.createdAt,
  attachments: m.attachments ?? noAttachments,
  state: m.streaming === true ? "streaming" : "sent",
  clientRequestId: m.clientRequestId,
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
  offline: r.state.t === "failed" ? r.state.offline : undefined,
  clientRequestId: r.clientRequestId,
});

/** The rows, oldest first: the hub's messages, a stream with no message yet as the lead's, then the person's sends. */
export const chatItems = (chat: Chat, sends: readonly ChatSend[]): readonly ChatItem[] => {
  const items = chat.messages.map((m) => messageItem(m, chat.streams[m.messageId]));
  const known = new Set(chat.messages.map((m) => m.messageId));
  for (const [id, text] of Object.entries(chat.streams)) {
    if (known.has(id)) continue;
    items.push({ id, author: "lead", kind: "message", text, at: "", attachments: noAttachments, state: "streaming" });
  }
  return [...items, ...sends.map(sendItem)];
};
