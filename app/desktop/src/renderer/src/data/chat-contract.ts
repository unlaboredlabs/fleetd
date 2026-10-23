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
  ChatStopInput,
  ChatStopOutput,
  KnownChatAuthor,
  ProjectChatState,
} from "../../../shared/contracts";

export const CHAT_EVENTS = { message: "chat.message", waiting: "chat.waiting" } as const;

// chat_stop stops the lead's turn and every agent of the project (project_stop's stop). `stopped` is false when
// nothing was running; `message` is the chat line saying what stopped ("Stopped the lead and 2 agents."), which also
// arrives as a chat.message event.
