// The chat shapes the layer reads, from H1's generated contracts (crates/fleetd-contracts/src/chat.rs).
import type { ChatMessage } from "../../../shared/contracts";

export type {
  AttachmentRef,
  ChatDelta,
  ChatHistoryInput,
  ChatHistoryOutput,
  ChatMessage,
  ChatMessageEventData,
  ChatSendInput,
  ChatSendOutput,
  KnownChatAuthor,
  ProjectChatState,
} from "../../../shared/contracts";

export const CHAT_EVENTS = { message: "chat.message", waiting: "chat.waiting" } as const;

/**
 * chat_stop, the hub's stop for a lead mid-turn (agents keep running), agreed with its hub slice ahead of the
 * generated contracts. `stopped` is false when the lead wasn't mid-turn; `message` is the chat line it wrote, which
 * also arrives as a chat.message event. The layer calls it by name until it lands (chat-layer.ts).
 */
export interface ChatStopInput {
  readonly projectRef: { readonly machineId: string; readonly projectId: string };
  readonly clientRequestId: string;
}
export interface ChatStopOutput {
  readonly stopped: boolean;
  readonly message: ChatMessage;
}
