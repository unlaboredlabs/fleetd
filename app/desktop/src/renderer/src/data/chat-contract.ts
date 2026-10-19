// The chat shapes the layer reads, from H1's generated contracts (crates/fleetd-contracts/src/chat.rs).
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
