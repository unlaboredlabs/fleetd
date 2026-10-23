//! Steering: a person (or a lead, for its own tasks) redirects a running agent mid-run. A steer is one short user
//! message sent straight to the agent's thread, never through the wake debounce. Its receipt follows claude's own
//! frames: queued at the hub, delivered when claude's context takes it in, acknowledged when the agent names its id.
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
    /// The agent's reply named its id, or a lead call did (`--steer S12`).
    Acknowledged,
    /// Its run ended with no reply naming it.
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
    pub text: Text<1, 4000>,
    pub stage: SteerStage,
    pub queued_at: Timestamp,
    pub delivered_at: Option<Timestamp>,
    pub how: Option<DeliveredHow>,
    /// `how = stopped`: one line on the step it stopped.
    pub stopped_tool: Option<Text<0, 200>>,
    /// The first model request that carried it.
    pub seen_at: Option<Timestamp>,
    pub acked_at: Option<Timestamp>,
    /// Acknowledged: the reply naming it; unacknowledged: the first reply. First 200 characters.
    pub ack_excerpt: Option<Text<0, 200>>,
    /// A plan change the steer made, e.g. "−1 item".
    pub plan_change: Option<Text<0, 200>>,
    /// Plain words on the stage: "waiting for lab-b (until 14:30)", "held: usage resets 14:00", the failure, or
    /// "sent (node older than 0.9)" when the node cannot report receipts.
    pub detail: Option<Text<0, 400>>,
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
}

/// The token an agent's text must contain to acknowledge `id`: the id as a whole word ("S12", not "S120").
pub fn names_steer(text: &str, id: &SteerId) -> bool {
    let id = id.as_str();
    text.match_indices(id).any(|(at, _)| {
        let word = |c: char| c.is_alphanumeric() || c == '_';
        let before = text[..at].chars().next_back().is_none_or(|c| !word(c));
        let after = text[at + id.len()..]
            .chars()
            .next()
            .is_none_or(|c| !word(c));
        before && after
    })
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

    #[test]
    fn the_ack_token_is_the_id_as_a_whole_word() {
        let id = SteerId::from_n(12);
        assert!(names_steer("S12: dropping the docs page", &id));
        assert!(names_steer("Got it (S12).", &id));
        assert!(!names_steer("S120: something else", &id));
        assert!(!names_steer("XS12 is a size", &id));
        assert!(!names_steer("no token here", &id));
    }
}
