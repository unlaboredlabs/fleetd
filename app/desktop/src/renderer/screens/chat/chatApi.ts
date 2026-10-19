// The chat contract this composer sends with, until H1's generated types (feat/chat-contracts) land; then these
// names come from shared/contracts and this file shrinks to the one call. Field names as proposed to H1.

import type { AttachmentId } from "../../../shared/contracts";
import type { DataLayer } from "../../src/data/queries";
import type { HubError } from "../../../shared/hub";

export interface ChatProject {
  readonly machineId: string;
  readonly projectId: string;
}

export interface ChatSendInput {
  readonly project: ChatProject;
  readonly text: string;
  readonly attachments?: readonly AttachmentId[];
  /** One per composed message: the hub stores one message per id, however often it is sent. */
  readonly clientRequestId: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly text: string;
  readonly at: string;
  readonly clientRequestId?: string;
  /** Whether the lead has it: "sent" is stored by the hub, "delivered" is in the lead's context. */
  readonly delivery?: "sent" | "delivered";
  /** It reached the lead mid-turn, as a steer, rather than starting a turn. */
  readonly steer?: boolean;
}

export type ChatSendResult = { readonly ok: true; readonly output: { readonly message: ChatMessage } } | { readonly ok: false; readonly error: HubError };

/** The one chat_send call. */
export const chatSend = (call: DataLayer["call"], input: ChatSendInput): Promise<ChatSendResult> =>
  // The tool isn't in the generated contracts yet.
  (call as unknown as (tool: string, input: ChatSendInput) => Promise<ChatSendResult>)("chat_send", input);

/** "sent": the hub has it. "pending": cut off or unanswered, resent by the layer. "failed": not sent, its item says
 *  why. "offline": not sent and no item; the words stay in the box. */
export type SendOutcome = "sent" | "pending" | "failed" | "offline";

/** The data layer's chat actions (E1, A7): the layer owns pending messages and their clientRequestIds. */
export interface ChatActions {
  send(key: string, input: { readonly text: string; readonly attachments?: readonly AttachmentId[] }): Promise<SendOutcome>;
  retry(key: string, clientRequestId: string): void;
  discard(key: string, clientRequestId: string): void;
}
