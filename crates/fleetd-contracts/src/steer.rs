//! Steering: a person (or a lead, for its own tasks) redirects a running agent mid-run. A steer is one short user
//! message sent straight to the agent's thread, never through the wake debounce. Its receipt follows claude's own
//! frames: queued at the hub, delivered when claude's context takes it in, acknowledged by the agent's next reply.
//! See docs/build/steering-spec.md.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{ThreadId, ThreadRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::prim::{NonEmpty, Text};
use crate::tasks::TaskId;

brand!(
    /// "S" plus a positive integer, unique per hub, e.g. "S12". The agent is asked to begin its reply with it.
    SteerId, name = "SteerId", pattern = r"^S[1-9][0-9]*$"
);

/// The longest steer, in UTF-16 units as the app counts them.
pub const STEER_TEXT_MAX: usize = 20_000;
pub type SteerText = Text<1, STEER_TEXT_MAX>;

impl SteerId {
    pub fn from_n(n: i64) -> Self {
        Self::unchecked(format!("S{n}"))
    }
    pub fn n(&self) -> Option<i64> {
        self.as_str().strip_prefix('S')?.parse().ok()
    }
}

/// How a steer reaches a running agent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteerMode {
    /// Enter, "add to the lead's queue": taken in at the agent's next tool boundary, as its own turn. Never cuts a
    /// running tool.
    #[default]
    Queue,
    /// ⌘Enter, "interrupt and redirect now": stops the current step and delivers at once.
    Now,
}

/// Who a steer is for: an order's lead, or one task (writer, reviewer, …).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
pub enum SteerTarget {
    #[serde(rename_all = "camelCase")]
    Lead { workstream_id: WorkstreamId },
    #[serde(rename_all = "camelCase")]
    Task { task_id: TaskId },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteerStage {
    /// The hub stored it, or put it in the offline queue.
    Queued,
    /// claude's context took it in (`command_lifecycle started`).
    Delivered,
    /// The agent replied after taking it in, or a lead call named it (`--steer S12`).
    Acknowledged,
    /// Its run ended with no reply after it was delivered.
    Unacknowledged,
    /// Dropped while still queued.
    Withdrawn,
    Failed,
    /// The machine stayed offline past the queue's TTL.
    Expired,
}

impl SteerStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Delivered => "delivered",
            Self::Acknowledged => "acknowledged",
            Self::Unacknowledged => "unacknowledged",
            Self::Withdrawn => "withdrawn",
            Self::Failed => "failed",
            Self::Expired => "expired",
        }
    }

    /// No later receipt changes it.
    pub fn is_final(self) -> bool {
        matches!(
            self,
            Self::Acknowledged
                | Self::Unacknowledged
                | Self::Withdrawn
                | Self::Failed
                | Self::Expired
        )
    }
}

/// How a delivered steer was taken in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveredHow {
    /// It started a turn while the agent was idle.
    Turn,
    /// After the running tool returned.
    Boundary,
    /// ⌘Enter stopped the running step (`stoppedTool` names it).
    Stopped,
    /// An older claude merged it into the running turn; the ack rule catches a miss.
    Joined,
}

/// Who sent a steer.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SteerBy {
    #[serde(rename_all = "camelCase")]
    Human {
        key_name: String,
    },
    Lead,
    /// Another agent of the same project (`agent_message`): a peer's note, never its lead's word. `messageId` is the
    /// agent message it delivers to this recipient.
    #[serde(rename_all = "camelCase")]
    Agent {
        task_id: TaskId,
        message_id: Option<AgentMessageId>,
    },
}

/// One steer and its receipt.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Steer {
    pub id: SteerId,
    pub target: SteerTarget,
    /// The order it belongs to (a task's own order for a task steer).
    pub workstream_id: WorkstreamId,
    pub thread: ThreadRef,
    /// The node run id it was sent as; also the user message id in the thread.
    pub run_id: NonEmpty,
    pub by: SteerBy,
    pub mode: SteerMode,
    pub text: SteerText,
    pub stage: SteerStage,
    pub queued_at: Timestamp,
    pub delivered_at: Option<Timestamp>,
    pub how: Option<DeliveredHow>,
    /// `how = stopped`: one line on the step it stopped.
    pub stopped_tool: Option<Text<0, 200>>,
    /// The first model request that carried it.
    pub seen_at: Option<Timestamp>,
    pub acked_at: Option<Timestamp>,
    /// Acknowledged: the agent's reply, first 200 characters.
    pub ack_excerpt: Option<Text<0, 200>>,
    /// Plain words on the stage: "waiting for lab-b (until 14:30)", "held: usage resets 14:00", the failure, or
    /// "sent (node older than 0.9)" when the node cannot report receipts.
    pub detail: Option<Text<0, 400>>,
    /// Held for the task's next run (it isn't running), until that run carries it.
    pub held: Option<bool>,
}

/// What the hub tells the node about a send that is a steer, so it can report its receipts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteerTag {
    pub id: SteerId,
    /// Older steers the same message carries (held for a task's next run): each gets its own receipts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub riders: Vec<SteerId>,
}

/// Node -> hub: a steer's receipt moved, decided from claude's own frames.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SteerReceipt {
    pub session_id: ThreadId,
    pub run_id: NonEmpty,
    pub steer_id: SteerId,
    pub stage: SteerStage,
    pub at: Timestamp,
    pub how: Option<DeliveredHow>,
    pub stopped_tool: Option<Text<0, 200>>,
    /// The first model request that carried it (`delivered`).
    pub seen_at: Option<Timestamp>,
    /// The assistant message the excerpt is from.
    pub message_id: Option<NonEmpty>,
    pub excerpt: Option<Text<0, 200>>,
    /// `failed`: why.
    pub reason: Option<Text<0, 400>>,
}

/// Fields `HubEvent.data` carries on `steer.*` events.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SteerEventData {
    pub steer_id: SteerId,
    pub workstream_id: WorkstreamId,
    pub task_id: Option<TaskId>,
    pub stage: SteerStage,
    pub how: Option<DeliveredHow>,
    pub excerpt: Option<Text<0, 200>>,
    /// steer.queued: the first 120 characters, the mode and who sent it.
    pub text: Option<String>,
    pub mode: Option<SteerMode>,
    pub by: Option<SteerBy>,
    /// steer.failed: why.
    pub reason: Option<String>,
    /// Held for the task's next run, not yet sent.
    pub held: Option<bool>,
}

brand!(
    /// "M" plus a positive integer, unique per hub: one agent's message to one or more others (`agent_message`).
    AgentMessageId, name = "AgentMessageId", pattern = r"^M[1-9][0-9]*$"
);

impl AgentMessageId {
    pub fn from_n(n: i64) -> Self {
        Self::unchecked(format!("M{n}"))
    }
    pub fn n(&self) -> Option<i64> {
        self.as_str().strip_prefix('M')?.parse().ok()
    }
}

/// Where an agent message stands for one recipient.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentMessageOutcome {
    /// Sent to a running agent, which takes it at its next tool boundary; `at` once its claude took it in.
    Delivered,
    /// The recipient hasn't started (it is queued): kept for its first run.
    Held,
    /// The recipient had ended its turn waiting for an answer (`ask_lead`), and this continued it.
    Woke,
    /// The recipient has finished and isn't waiting on the sender: kept for a run something else starts (a Monitor or
    /// wait_ci of its own, its lead), since an agent never restarts a finished agent.
    NotWoken,
    /// Not sent: no such agent in the project, it was cancelled, or its delivery failed.
    Refused,
}

impl AgentMessageOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Held => "held",
            Self::Woke => "woke",
            Self::NotWoken => "not_woken",
            Self::Refused => "refused",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "delivered" => Self::Delivered,
            "held" => Self::Held,
            "woke" => Self::Woke,
            "not_woken" => Self::NotWoken,
            "refused" => Self::Refused,
            _ => return None,
        })
    }
}

/// An agent of the project, as an agent message names it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageAgent {
    pub task_id: TaskId,
    /// Its title; absent for a recipient the project has no agent by that id.
    pub title: Option<String>,
}

/// One recipient of an agent message and where the message stands for it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageRecipient {
    pub task_id: TaskId,
    pub title: Option<String>,
    pub outcome: AgentMessageOutcome,
    /// When the outcome last changed: delivered once its claude took it in, held or woke when sent.
    pub at: Option<Timestamp>,
    /// Plain words on it: "T12 has finished and isn't waiting on T9", "it answers what T12 asked", why it was refused.
    pub detail: Option<String>,
}

/// One agent's message to others of its project, for the person to read and audit (`agent_messages`).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: AgentMessageId,
    pub from: AgentMessageAgent,
    /// The whole text.
    pub text: String,
    pub sent_at: Timestamp,
    /// In the order the sender named them.
    pub to: Vec<AgentMessageRecipient>,
}

/// A recipient as `agent.messaged` and `agent.message_updated` name it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageEventRecipient {
    pub task_id: TaskId,
    pub outcome: AgentMessageOutcome,
    pub detail: Option<String>,
}

/// Fields `HubEvent.data` carries on `agent.messaged` (sent) and `agent.message_updated` (a recipient's outcome
/// changed). The event's `projectId` is the project's.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageEventData {
    pub message_id: AgentMessageId,
    pub from: TaskId,
    pub to: Vec<AgentMessageEventRecipient>,
    /// The first 120 characters.
    pub text: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_target_is_an_order_or_a_task_never_both() {
        let lead: SteerTarget = serde_json::from_value(json!({ "workstreamId": "W41" })).unwrap();
        assert!(matches!(lead, SteerTarget::Lead { .. }));
        let task: SteerTarget = serde_json::from_value(json!({ "taskId": "T88" })).unwrap();
        assert!(matches!(task, SteerTarget::Task { .. }));
        assert!(
            serde_json::from_value::<SteerTarget>(
                json!({ "workstreamId": "W41", "taskId": "T88" })
            )
            .is_err()
        );
        assert!(serde_json::from_value::<SteerId>(json!("S0")).is_err());
        assert_eq!(SteerId::from_n(12).n(), Some(12));
    }
}
