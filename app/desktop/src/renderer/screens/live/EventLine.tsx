// fleetd's own one-line messages in the lead's chat (a PR merged, CI failed, an agent started, a past order's state):
// a system ChatMessage, worded by the hub and shown as sent, quietly, with `code` in backticks shown as code.
import type { ChatMessage } from "../../../shared/contracts";
import { InlineCode, Text } from "../../ui";
import s from "./live.module.css";

/** True for a message this component draws: fleetd's own (author "system") with text. */
export const isEventLine = (m: ChatMessage): boolean => m.author === "system" && m.text.trim() !== "";

export function EventLine({ message }: { message: ChatMessage }) {
  if (!isEventLine(message)) return null;
  return (
    <div className={s.event} data-chat-event={message.messageId}>
      <Text size="xs" tone="quiet">
        {message.text.split("`").map((part, i) => (i % 2 === 1 ? <InlineCode key={i}>{part}</InlineCode> : part))}
      </Text>
    </div>
  );
}
