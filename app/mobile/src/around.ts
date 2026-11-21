// A chat opened at a message far back (a search hit, a pin), as Telegram opens one: the hub's page around it
// (chat_history `around`), not every page down to it. That page is a window of its own beside the chat, which keeps
// its newest messages and live ones as always: the thread shows the window while it is open, pages older and newer
// from its ends, and once it reaches the chat's oldest held message (or the newest end) it joins the chat and goes, so
// one thread scrolls on down to the newest. Back to the newest (the button down, a send) closes it. Pure, so it is
// unit-tested.
import { emptyChat, mergeMessages, type Chat, type ChatHistoryOutput, type ChatMessage, type HubError } from "./desktop";

export interface ChatWindow {
  /** The message it was opened at. */
  readonly anchor: string;
  /** Oldest first, by seq. */
  readonly messages: readonly ChatMessage[];
  readonly moreBefore: boolean;
  readonly moreAfter: boolean;
  /** A page on its way, at one end at a time; null while none is. */
  readonly loading: "around" | "older" | "newer" | null;
  readonly error?: HubError | undefined;
}

/** Whether a chat holds the message: a jump to it needs no window. */
export const holds = (chat: Pick<Chat, "messages">, messageId: string): boolean => chat.messages.some((m) => m.messageId === messageId);

/** A window asked for at `anchor`, before its page comes: nothing shown yet. */
export const openingWindow = (anchor: string): ChatWindow => ({ anchor, messages: [], moreBefore: false, moreAfter: false, loading: "around" });

/** A page folded into the window: the one around its message, one before its oldest, or one after its newest. */
export const withPage = (w: ChatWindow, page: ChatHistoryOutput, end: "around" | "older" | "newer"): ChatWindow => {
  const byId = new Map(w.messages.map((m) => [m.messageId, m]));
  for (const m of page.messages) byId.set(m.messageId, m);
  const messages = [...byId.values()].sort((a, b) => a.seq - b.seq);
  return {
    anchor: w.anchor,
    messages,
    moreBefore: end === "newer" ? w.moreBefore : page.moreBefore,
    moreAfter: end === "older" ? w.moreAfter : page.moreAfter,
    loading: null,
  };
};

/** A page that didn't come: said where it would be; the window's messages stay. */
export const withError = (w: ChatWindow, error: HubError): ChatWindow => ({ ...w, loading: null, error });

/** Where the next page goes from: the seq before the oldest (`before`) or after the newest (`after`). */
export const pageFrom = (w: ChatWindow, end: "older" | "newer"): number | undefined => {
  if (w.loading !== null || (end === "older" ? !w.moreBefore : !w.moreAfter)) return undefined;
  return end === "older" ? w.messages[0]?.seq : w.messages.at(-1)?.seq;
};

/**
 * Whether the window has met the chat: its newest message reaches the chat's oldest held one, or nothing is after it
 * (the chat's own newest are then all in it or after it).
 */
export const meets = (w: ChatWindow, chat: Pick<Chat, "messages" | "loaded">): boolean => {
  if (w.loading === "around" || w.messages.length === 0) return false;
  if (!w.moreAfter) return true;
  const oldest = chat.messages[0]?.seq;
  const newest = w.messages.at(-1)?.seq ?? 0;
  return chat.loaded && oldest !== undefined && newest + 1 >= oldest;
};

/**
 * The window joined into its chat: every message of both, the window's older end the chat's own; of a message both
 * hold, the newer copy (desktop.ts mergeMessages).
 */
export const joined = (chat: Chat, w: ChatWindow): Chat => {
  const merged = mergeMessages({ ...chat, messages: w.messages, streams: {} }, chat.messages, true);
  return { ...chat, messages: merged.messages, hasOlder: w.moreBefore };
};

/**
 * A live message that is also in the window (an edit, a retag, a stream's end): the window's copy follows, so the
 * thread shows it as it is now.
 */
export const followLive = (w: ChatWindow, message: ChatMessage): ChatWindow => {
  const at = w.messages.findIndex((m) => m.messageId === message.messageId);
  if (at < 0) return w;
  return { ...w, messages: w.messages.map((m, i) => (i === at ? message : m)) };
};

/** The window as a chat the thread draws (desktop.ts chatItems): its messages alone, nothing streaming or on its way. */
export const windowChat = (w: ChatWindow): Chat => ({ ...emptyChat, messages: w.messages, hasOlder: w.moreBefore, loadingOlder: w.loading === "older", loaded: w.loading !== "around" });

/** The window the thread draws: one with messages in it. One still reading its first page, or whose page failed, isn't. */
export const shownWindow = (w: ChatWindow | undefined): ChatWindow | undefined => (w !== undefined && w.messages.length > 0 ? w : undefined);

/**
 * What a landing or a jump does with a message, as the thread shows it (`shown`): lands on it; closes the window, when
 * the chat's own messages hold it; reads the page around it; waits for that page; or, the page come or failed without
 * it, says it didn't open.
 */
export const farStep = (chat: Pick<Chat, "messages">, w: ChatWindow | undefined, messageId: string, shown: boolean): "land" | "close" | "open" | "wait" | "failed" => {
  if (shown) return "land";
  if (holds(chat, messageId)) return w === undefined ? "land" : "close";
  if (w?.anchor !== messageId) return "open";
  if (w.loading === "around") return "wait";
  return "failed";
};

/** Why a message far back didn't open, as its alert says. */
export const farFailure = (w: ChatWindow | undefined): string => (w?.error === undefined || w.error.code === "not_found" ? "It isn't in the chat any more." : w.error.message);
