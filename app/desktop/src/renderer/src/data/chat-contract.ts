// STUB of H1's chat contracts (EFF-A, feat/chat-contracts), until they are generated into shared/contracts. Every
// chat shape the layer reads is here, so swapping in the generated types is one import change.
import type { ProjectRef } from "../../../shared/contracts";

export interface ChatAttachment {
  readonly attachmentId: string;
  readonly name: string;
  readonly mime: string;
  readonly bytes?: number | undefined;
}

export type ChatAuthor = "human" | "lead" | "system";
/** A message; a PR / merge one-liner or migrated history line; or one of the two inline items chat can't carry. */
export type ChatMessageKind = "message" | "event" | "secret" | "gated";

export interface ChatMessage {
  readonly messageId: string;
  readonly projectRef: ProjectRef;
  /** Per project, monotonic: history order and the paging cursor. */
  readonly seq: number;
  readonly author: ChatAuthor;
  readonly kind: ChatMessageKind;
  /** Markdown. A lead message still streaming has its text so far. */
  readonly text: string;
  readonly createdAt: string;
  /** Bumped when a message changes (a stream finishing, an inline item resolved): the newer copy wins. */
  readonly updatedAt?: string | undefined;
  readonly attachments?: readonly ChatAttachment[] | undefined;
  /** Echoed on the person's own messages. */
  readonly clientRequestId?: string | undefined;
  /** The lead is still writing it. */
  readonly streaming?: boolean | undefined;
}

export interface ChatHistoryInput {
  readonly projectRef: ProjectRef;
  /** Messages before this seq; absent: the latest page. */
  readonly beforeSeq?: number | undefined;
  readonly limit?: number | undefined;
}

export interface ChatHistoryOutput {
  /** Oldest first. */
  readonly messages: readonly ChatMessage[];
  readonly hasOlder: boolean;
  /** The lead is waiting for the person's reply. */
  readonly needsYou: boolean;
}

export interface ChatSendInput {
  readonly projectRef: ProjectRef;
  readonly text: string;
  readonly attachments?: readonly string[] | undefined;
  readonly clientRequestId: string;
}

export interface ChatSendOutput {
  readonly message: ChatMessage;
}

/** `chat.message` event data: a message, new or changed. */
export interface ChatMessageData {
  readonly message: ChatMessage;
}

/** `chat.delta` event data: `append` goes at `offset` (UTF-16 units) of the streaming message's text. */
export interface ChatDeltaData {
  readonly projectRef: ProjectRef;
  readonly messageId: string;
  readonly offset: number;
  readonly append: string;
}

/** `chat.needs_you` event data. */
export interface ChatNeedsYouData {
  readonly projectRef: ProjectRef;
  readonly needsYou: boolean;
}

export const CHAT_EVENTS = { message: "chat.message", delta: "chat.delta", needsYou: "chat.needs_you" } as const;
