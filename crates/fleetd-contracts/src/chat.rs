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
use crate::ledger::{EnvName, GatedRunSpec, ToolPermission};
use crate::mcp::{AttachmentId, AttachmentMime, RequestId};
use crate::prim::{Count, Line, List, Text};
use crate::secrets::{SecretFingerprint, SecretSink};

crate::brand!(
    /// "m" plus a positive integer, unique per hub.
    ChatMessageId, name = "ChatMessageId", pattern = r"^m[1-9][0-9]*$"
);

crate::brand!(
    /// "Q" plus a positive integer, unique per hub: an inline request in a chat (a secret to enter, a command to
    /// approve), named by the call that answers it.
    ChatRequestId, name = "ChatRequestId", pattern = r"^Q[1-9][0-9]*$"
);

/// A message's place in its project's chat: 1, 2, 3… with no gaps, never reused. Paging and dedupe go by it.
pub type ChatSeq = Count;

/// The longest message text, in characters.
pub const CHAT_TEXT_MAX: usize = 100_000;
/// The most messages one `chat_history` page holds.
pub const CHAT_PAGE_MAX: usize = 100;

/// A file on a message: what the app shows without fetching it. Its bytes come from `attachment_get`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    pub attachment_id: AttachmentId,
    pub name: Line<1, 120>,
    pub mime: AttachmentMime,
    pub bytes: Count,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ChatAuthor {
    Human,
    Lead,
    /// An agent or integration writing with its own key (`fleetd chat` with an agent key): input for the lead, never
    /// the human. It approves nothing, answers nothing that is the human's, and leaves needs-you as it was.
    Agent,
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
    /// A question the lead asked with the retired questions tool, and its answer.
    Question,
}

/// Where a human message was written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ChatClient {
    /// The desktop app.
    App,
    /// `fleetd chat`.
    Cli,
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequestItem {
    pub request_id: ChatRequestId,
    /// The secret's key, e.g. `stripe.test_key`.
    pub name: Line<1, 120>,
    /// One line: why the lead needs it.
    pub text: Line<1, 300>,
    pub sink: SecretSink,
    /// An `env:` sink: the variable it writes, when not the one `name` gives (`secrets::secret_env_name`).
    pub env_name: Option<EnvName>,
    pub state: SecretRequestState,
    /// Once stored.
    pub fingerprint: Option<SecretFingerprint>,
    /// Why it is open again, or why it could not be stored.
    pub note: Option<Line<1, 300>>,
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
/// human: the exact command, then Approve or Deny. Answered with `approval_answer`, naming `requestId`. Exactly one of
/// `gated` and `permission`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandApprovalItem {
    pub request_id: ChatRequestId,
    /// Where it runs, or the machine of the session that asks.
    pub machine_id: MachineId,
    /// A gated command: exactly what runs once approved.
    pub gated: Option<GatedRunSpec>,
    /// A session's permission prompt: the tool and what it would do.
    pub permission: Option<ToolPermission>,
    /// A retro playbook change that relaxes a gate: what changes, in plain words, and the exact diff.
    pub playbook: Option<Box<crate::ledger::PlaybookGateChange>>,
    pub state: CommandApprovalState,
    pub exit_code: Option<i64>,
    /// The end of the output, once it ran.
    pub output_tail: Option<Text<0, 2000>>,
    /// Why it is open again ("not run: the node was offline when approved"), or why it failed without running.
    pub note: Option<Line<1, 300>>,
    pub answered_at: Option<Timestamp>,
    /// The key name of the person who answered.
    pub by: Option<Line<1, 120>>,
}

/// The two things a chat can't carry as plain text, shown inline in place of the message text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatItem {
    SecretRequest(SecretRequestItem),
    CommandApproval(CommandApprovalItem),
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub message_id: ChatMessageId,
    pub project_ref: ProjectRef,
    pub seq: ChatSeq,
    pub author: ChatAuthor,
    /// Markdown. Empty while a streamed message has no text yet, and for an inline `item`.
    pub text: Text<0, CHAT_TEXT_MAX>,
    #[serde(default)]
    pub attachments: List<AttachmentRef, 0, 8>,
    pub created_at: Timestamp,
    /// Set when the text was last appended to, or an item's state changed.
    pub updated_at: Option<Timestamp>,
    pub state: ChatMessageState,
    /// A human message: the `clientRequestId` its `chat_send` carried, for the app's optimistic copy.
    pub client_request_id: Option<RequestId>,
    /// A human message: how it reached the lead.
    pub delivery: Option<ChatDelivery>,
    /// The name of the key that wrote it: a person's device for a human message, the agent for an agent's.
    pub by: Option<Line<1, 120>>,
    /// A human message: where it was written.
    pub client: Option<ChatClient>,
    pub item: Option<ChatItem>,
    /// From before the chat: where this history message came from.
    pub history: Option<ChatHistorySource>,
}

/// One chat's state, for the sidebar and the status row.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageEventData {
    pub project_ref: ProjectRef,
    pub message_id: ChatMessageId,
    pub seq: ChatSeq,
    pub author: ChatAuthor,
    pub state: ChatMessageState,
    pub message: Option<ChatMessage>,
}

/// Streamed text of the subscribed chat's lead message `messageId`. `offset` is the message's text length before
/// `append`, in UTF-16 units: append when it equals the length the app holds, skip the frame when
/// `offset + append.length` is within it (already applied, e.g. after a `chat_history` read), and read the message
/// again otherwise (a gap). The `chat.message` event with `state: final` carries the full text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatDelta {
    pub project_ref: ProjectRef,
    pub message_id: ChatMessageId,
    pub seq: ChatSeq,
    pub offset: Count,
    pub append: Text<0, 4000>,
}

/// The human's answer to a `command_approval`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    Deny,
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
            "item": { "kind": "command_approval", "requestId": "Q3", "machineId": "devbox", "state": "open",
                "gated": { "argv": ["./deploy.sh", "prod"], "class": "irreversible", "reason": "prod deploy",
                    "timeoutSec": 600 } },
        });
        let decoded: ChatMessage = serde_json::from_value(message.clone()).unwrap();
        assert!(matches!(decoded.item, Some(ChatItem::CommandApproval(_))));
        assert_eq!(serde_json::to_value(&decoded).unwrap(), message);
        assert!(ChatMessageId::new("m0").is_err() && ChatRequestId::new("Q1").is_ok());
        // A newer hub's author or state decodes in the app (x-open), not here: this build refuses it.
        let mut newer = message;
        newer["author"] = json!("bot");
        assert!(serde_json::from_value::<ChatMessage>(newer).is_err());
    }
}
