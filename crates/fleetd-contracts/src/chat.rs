//! A project's lead chat: one ongoing conversation per lead, the main surface. The human writes at any time; the hub
//! delivers each message into the lead's session and streams the lead's replies back. Past orders, notes and steers
//! read back as history in the same conversation.
//!
//! On the /app socket a chat shows up three ways:
//! - `chat.message` and `chat.waiting` hub events (durable, replayed after a reconnect like every event);
//! - `chat_delta` frames for the one chat the app subscribed to with a `chat` message (ephemeral, never replayed);
//! - `chat_history` pages, read with the call frame.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{MachineId, ProjectRef, Timestamp};
use crate::ledger::{EnvName, GatedClass};
use crate::mcp::{Attachments, RequestId};
use crate::prim::{Count, Line, List, Text};

crate::brand!(
    /// "m" plus a positive integer, unique per hub.
    ChatMessageId, name = "ChatMessageId", pattern = r"^m[1-9][0-9]*$"
);

crate::brand!(
    /// "R" plus a positive integer, unique per hub: an inline request in a chat (a secret to enter, a command to
    /// approve), named by the call that answers it.
    ChatRequestId, name = "ChatRequestId", pattern = r"^R[1-9][0-9]*$"
);

/// A message's place in its project's chat: 1, 2, 3… with no gaps, never reused. Paging and dedupe go by it.
pub type ChatSeq = Count;

/// The longest message text, in characters.
pub const CHAT_TEXT_MAX: usize = 100_000;
/// The most messages one `chat_history` page holds.
pub const CHAT_PAGE_MAX: usize = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ChatAuthor {
    Human,
    Lead,
    /// fleetd itself: one-line events (a PR merged, an agent started, a past order's state).
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ChatMessageState {
    /// The lead is still writing it: `chat_delta` frames append to its text until it is `final`.
    Streaming,
    Final,
}

/// Where a history message came from, for messages from before the chat existed (a read model; nothing is moved or
/// destroyed). Absent on messages written in the chat.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ChatHistorySource {
    /// An order's text as it was submitted.
    Order,
    /// A person's note on an order.
    Note,
    /// A person's steer to the lead or one of its agents.
    Steer,
    /// What the lead said in its own session.
    LeadMessage,
    /// An order's outcome (done, stopped, failed) as a one-line event.
    OrderOutcome,
}

/// How a human message reached the lead.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ChatDelivery {
    /// The lead was idle: the message started its next turn.
    Turn,
    /// The lead was mid-turn: it takes the message at its next step, as a steer.
    Steer,
    /// The lead is starting, or its machine is away: the message waits and goes in as soon as it can.
    Queued,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum SecretRequestState {
    Open,
    Stored,
    Withdrawn,
}

/// The lead needs a secret. The app shows a masked field; the value never enters the transcript: it is sealed to the
/// sink's machine and answered with `secret_submit`, naming `requestId`. Only its fingerprint comes back.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequestItem {
    pub request_id: ChatRequestId,
    /// The secret's key, e.g. `stripe.test_key`.
    pub name: Line<1, 120>,
    /// One line: why the lead needs it.
    pub text: Line<1, 300>,
    /// Where it lands: `env:<machine>:<absolute path>` or `file:<machine>:<absolute path>`.
    pub sink: Text<1, 600>,
    pub state: SecretRequestState,
    /// Once stored.
    pub fingerprint: Option<Text<1, 100>>,
    pub answered_at: Option<Timestamp>,
    /// The key name of the person who answered.
    pub by: Option<Line<1, 120>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum CommandApprovalState {
    Open,
    Approved,
    Denied,
    /// Approved and run: see `exitCode` and `outputTail`.
    Ran,
    /// Approved, and the node could not run it.
    Failed,
}

/// A risky command (prod write, spend, delete, credential use) or a session's permission prompt waits for the
/// human: the exact command, then Approve or Deny. Answered with `approval_answer`, naming `requestId`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandApprovalItem {
    pub request_id: ChatRequestId,
    /// The exact argv that runs once approved. Absent for a session's permission prompt, which has `tool`.
    pub argv: Option<List<Text<0, 4000>, 1, 64>>,
    /// A permission prompt: the tool the agent wants to use, with `inputSummary`.
    pub tool: Option<Line<1, 120>>,
    pub input_summary: Option<Text<0, 2000>>,
    pub machine_id: MachineId,
    pub cwd: Option<Text<1, 1000>>,
    pub class: GatedClass,
    /// One line: why.
    pub reason: Line<1, 300>,
    /// Names only; the values come from the node's own sinks.
    pub secret_env: Option<List<EnvName, 0, 16>>,
    pub timeout_sec: Option<Count>,
    pub state: CommandApprovalState,
    pub exit_code: Option<i64>,
    /// The end of the output, once it ran.
    pub output_tail: Option<Text<0, 2000>>,
    pub answered_at: Option<Timestamp>,
    /// The key name of the person who answered.
    pub by: Option<Line<1, 120>>,
}

/// The two things a chat can't carry as plain text, shown inline in place of the message text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatItem {
    SecretRequest(SecretRequestItem),
    CommandApproval(CommandApprovalItem),
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub message_id: ChatMessageId,
    pub project_ref: ProjectRef,
    pub seq: ChatSeq,
    pub author: ChatAuthor,
    /// Markdown. Empty while a streamed message has no text yet, and for an inline `item`.
    pub text: Text<0, CHAT_TEXT_MAX>,
    #[serde(default)]
    pub attachments: Attachments,
    pub created_at: Timestamp,
    /// Set when the text was last appended to, or an item's state changed.
    pub updated_at: Option<Timestamp>,
    pub state: ChatMessageState,
    /// A human message: the `clientRequestId` its `chat_send` carried, for the app's optimistic copy.
    pub client_request_id: Option<RequestId>,
    /// A human message: how it reached the lead.
    pub delivery: Option<ChatDelivery>,
    /// A human message: the key name of the person who wrote it.
    pub by: Option<Line<1, 120>>,
    pub item: Option<ChatItem>,
    /// From before the chat: where this history message came from.
    pub history: Option<ChatHistorySource>,
}

/// One chat's state, for the sidebar and the status row.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChatState {
    pub project_ref: ProjectRef,
    /// The lead's last message waits for a human reply, or an inline item is open.
    pub needs_you: bool,
    /// The lead is mid-turn.
    pub lead_working: bool,
    /// The newest message's `seq`; 0 for an empty chat.
    pub last_seq: ChatSeq,
    pub last_message_at: Option<Timestamp>,
}

/// `chat.message` data: on each new message, and again when a streamed message is final or an inline item changes
/// state. `message` is the whole message when it fits the event's 2 KB; otherwise read it with `chat_history`
/// (`after: seq - 1`, `limit: 1`).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageEventData {
    pub project_ref: ProjectRef,
    pub message_id: ChatMessageId,
    pub seq: ChatSeq,
    pub author: ChatAuthor,
    pub state: ChatMessageState,
    pub message: Option<ChatMessage>,
}

/// Streamed text of the subscribed chat's lead message `messageId`: append `append` to its text. `index` counts the
/// frames of one message from 0, so a gap or a repeat shows; on either, read the message with `chat_history`. The
/// `chat.message` event with `state: final` carries the full text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatDelta {
    pub project_ref: ProjectRef,
    pub message_id: ChatMessageId,
    pub seq: ChatSeq,
    pub index: Count,
    pub append: Text<0, 4000>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_message_with_an_inline_item_round_trips_and_ids_are_checked() {
        let message = json!({
            "messageId": "m7", "projectRef": { "machineId": "devbox", "projectId": "app" }, "seq": 7,
            "author": "lead", "text": "", "attachments": [], "createdAt": "2026-10-19T10:00:00.000Z",
            "state": "final",
            "item": { "kind": "command_approval", "requestId": "R3", "argv": ["./deploy.sh", "prod"],
                "machineId": "devbox", "class": "irreversible", "reason": "prod deploy", "state": "open" },
        });
        let decoded: ChatMessage = serde_json::from_value(message.clone()).unwrap();
        assert!(matches!(decoded.item, Some(ChatItem::CommandApproval(_))));
        assert_eq!(serde_json::to_value(&decoded).unwrap(), message);
        assert!(ChatMessageId::new("m0").is_err() && ChatRequestId::new("R1").is_ok());
        // A newer hub's author or state decodes in the app (x-open), not here: this build refuses it.
        let mut newer = message;
        newer["author"] = json!("bot");
        assert!(serde_json::from_value::<ChatMessage>(newer).is_err());
    }
}
