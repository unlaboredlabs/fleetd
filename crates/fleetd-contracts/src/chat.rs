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
    /// Telegram, through the Navi's own bot (`telegram.rs`).
    Telegram,
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
    /// The lead was mid-turn and the human asked for now: its running step stopped for the message.
    Now,
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
    /// A Navi's secure input (`fill:` sink): the site, the field and why; what is typed fills that field, once.
    pub secure_input: Option<Box<crate::secure_input::SecureInput>>,
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

/// A risky command (prod write, spend, delete, credential use), a session's permission prompt, a purchase or a secure
/// input waits for the human: exactly what it would do, then Approve or Deny. Answered with `approval_answer`, naming
/// `requestId`. Exactly one of `gated`, `permission`, `purchase` and `secureInput`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandApprovalItem {
    pub request_id: ChatRequestId,
    /// Where it runs, or the machine of the session that asks.
    pub machine_id: MachineId,
    /// A gated command: exactly what runs once approved.
    pub gated: Option<GatedRunSpec>,
    /// A session's permission prompt: the tool and what it would do. Boxed: with its input it is large beside the
    /// item's other fields, and every chat item would carry its size.
    pub permission: Option<Box<ToolPermission>>,
    /// A Navi's purchase (purchase_request): the shop, the total, what it buys and the card. Approved, the Navi's node
    /// fills the card into that checkout once. Boxed, as `permission` is.
    pub purchase: Option<Box<crate::purchase::Purchase>>,
    /// A Navi's secure input from a 1Password field: approved, its node fills that field once.
    pub secure_input: Option<Box<crate::secure_input::SecureInput>>,
    pub state: CommandApprovalState,
    pub exit_code: Option<i64>,
    /// The end of the output, once it ran.
    pub output_tail: Option<Text<0, 2000>>,
    /// Why it is open again ("not run: the node was offline when approved"), or why it failed without running.
    pub note: Option<Line<1, 300>>,
    pub answered_at: Option<Timestamp>,
    /// The key name of the person who answered.
    pub by: Option<Line<1, 120>>,
    /// Once it ran or failed: when the result came back.
    pub finished_at: Option<Timestamp>,
}

/// The two things a chat can't carry as plain text, shown inline in place of the message text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatItem {
    SecretRequest(SecretRequestItem),
    CommandApproval(CommandApprovalItem),
}

/// The most bubbles one message splits into; the rest of its text stays in the last.
pub const CHAT_PARTS_MAX: usize = 24;

/// One bubble of a lead message: `text.slice(start, end)` (UTF-16 offsets, like `ChatDelta.offset`), shown as
/// markdown, or as `block` when it has one (the slice is then the block's fence, its readable fallback).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatPart {
    pub start: Count,
    pub end: Count,
    pub block: Option<crate::blocks::ChatBlock>,
}

/// The bubble a human message answers: a lead message and the bubble's place in it, as `parts` counts (0 for a
/// message of one bubble). The lead reads that bubble whole over the reply, and when it was written.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatReplyTo {
    pub message_id: ChatMessageId,
    pub part: Count,
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
    pub attachments: List<AttachmentRef, 0, { crate::mcp::ATTACHMENTS_MAX }>,
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
    /// A human message: the person who wrote it. Absent from a hub before people.
    pub person: Option<crate::people::PersonRef>,
    /// A human message: where it was written.
    pub client: Option<ChatClient>,
    /// A human message: the bubble it answers.
    pub reply_to: Option<ChatReplyTo>,
    /// A human message forwarded on Telegram: who it came from. The words are theirs, not the person's, and the lead
    /// reads them as untrusted content.
    pub forwarded_from: Option<Line<1, 120>>,
    pub item: Option<ChatItem>,
    /// From before the chat: where this history message came from.
    pub history: Option<ChatHistorySource>,
    /// A final lead message of more than one bubble, or with a block: its bubbles in order. Absent: `text` is one
    /// bubble (and while a message streams).
    pub parts: Option<List<ChatPart, 1, CHAT_PARTS_MAX>>,
    /// A system line "Remembered: …" or "Forgot: …": what the lead's `remember` or `forget` wrote, which `memory_undo` takes back.
    pub remembered: Option<crate::memory::RememberedItem>,
    /// A system line "Memory refreshed: +a ~b −c": what the nightly memory refresh changed, each change undone on its
    /// own or all together with `memory_undo`.
    pub memory_refreshed: Option<crate::memory::MemoryRefreshed>,
    /// A system line "Cleanup kept 6 worktrees with unsaved work": the worktrees one nightly cleanup kept for work only
    /// they hold.
    pub worktrees_kept: Option<WorktreesKept>,
    /// A human message: the skills it named with `$name`, which the lead's copy lists.
    pub skills: Option<List<crate::skills::SkillName, 1, 8, true>>,
    /// A system line "Saved a skill: …": a Navi saved or changed one of its skills (`skill_save`); the app links it
    /// to the skill.
    pub skill_saved: Option<crate::skills::SkillSaved>,
    /// The lead flagged it for the person's look (`nudge`).
    pub nudge: Option<ChatNudge>,
}

/// The most worktrees one "Cleanup kept" line lists; a night that keeps more posts another line.
pub const WORKTREES_KEPT_MAX: usize = 200;

/// The worktrees one nightly cleanup kept in a project because they hold work that exists nowhere else, as one line
/// that opens to each: what frees it is pushing or deleting that work.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorktreesKept {
    pub items: List<KeptWorktree, 1, WORKTREES_KEPT_MAX>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeptWorktree {
    /// Its task's title.
    pub title: crate::tasks::TaskTitle,
    /// What only it holds: "uncommitted changes", "2 unpushed commits".
    pub unsaved: Line<1, 120>,
    /// The machine it is on.
    pub machine_id: MachineId,
    /// Where it is on that machine.
    pub path: Line<1, 4096>,
}

/// The most nudges a project keeps open: a newer one past it clears the oldest.
pub const CHAT_NUDGES_MAX: usize = 3;
/// The most a chat state lists.
pub const CHAT_OPEN_NUDGES_MAX: usize = CHAT_NUDGES_MAX;
/// How long a nudge waits to be seen; past it, it fades on its own.
pub const CHAT_NUDGE_MS: i64 = 24 * 60 * 60_000;

/// A message worth the person's look: a showcase, something to try, a risk. It waits, below what the lead waits on
/// you for, until the person has seen the message or dismissed it, and for a day at most. In the app only: it sends
/// no notification.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatNudge {
    /// What to look at, in a few words: "the Machines page redesign".
    pub reason: Line<1, 200>,
    pub at: Timestamp,
    /// Why it no longer waits; absent while it does (or once a day has passed).
    pub cleared: Option<ChatNudgeCleared>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ChatNudgeCleared {
    /// The person has seen the message: scrolled into view, or opened with Show.
    Seen,
    Dismissed,
    /// A newer nudge of its kind took its place past [`CHAT_NUDGES_MAX`].
    Replaced,
    /// A day passed unseen.
    Expired,
}

/// A nudge still waiting, in a chat state: its message, and what to look at.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatOpenNudge {
    pub message_id: ChatMessageId,
    pub reason: Line<1, 200>,
    pub at: Timestamp,
}

/// `nudge`: the lead flags the message it just wrote for the person's look, with what to look at. Only for a
/// showcase, something to try or a risk, never routine news.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NudgeCall {
    /// What to look at, in a few words: "the Machines page redesign".
    pub reason: Line<1, 200>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NudgeResult {
    /// The message flagged; absent while it is still on its way into the chat, which flags it as it lands.
    pub message_id: Option<ChatMessageId>,
    pub next: Option<String>,
}

/// `chat_image`: a lead or task uploads an image it made (a screenshot of a UI change) for its project's chat. The
/// caller's node reads it from the session's own working directory: a png, jpeg, webp or gif by its bytes, at most
/// [`crate::mcp::ATTACHMENT_MAX_BYTES`]. A lead shows it with an `image` block; unshown, it goes after 24 h.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatImageCall {
    /// The image file: relative to your working directory, or absolute inside it.
    pub path: Line<1, 1000>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatImageResult {
    pub attachment_id: AttachmentId,
    pub mime: AttachmentMime,
    pub bytes: Count,
    pub next: Option<String>,
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
    /// The inline items still open, oldest first, however far back: the chat may not have their page loaded. Absent
    /// when none is (and from older hubs).
    pub open_items: Option<List<ChatOpenItem, 1, CHAT_OPEN_ITEMS_MAX>>,
    /// The nudges still waiting to be seen, oldest first: what the app shows as "N to look at". Absent when none is.
    pub nudges: Option<List<ChatOpenNudge, 1, CHAT_OPEN_NUDGES_MAX>>,
}

/// The most open items a chat state lists.
pub const CHAT_OPEN_ITEMS_MAX: usize = 20;

/// An inline item that waits on the human: which message, and what it asks for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatOpenItem {
    pub message_id: ChatMessageId,
    pub kind: ChatOpenItemKind,
}

/// `ChatItem`'s kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ChatOpenItemKind {
    SecretRequest,
    CommandApproval,
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
