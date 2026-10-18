//! The app's live view of the fleet: per-agent lanes, order cards joined by the hub, train chips and machine load.
//!
//! `LiveFrame` is ephemeral: built from thread frames the hub already receives, never stored, never replayed. Order
//! cards and train chips come from `orders_board` / `order_get` and are refetched on the durable events.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::effort::Effort;
use crate::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use crate::ledger::{Headline, PlaybookName, WorkstreamId, WorkstreamState};
use crate::model::MachineStatus;
use crate::node_link::NodeLoad;
use crate::prim::{Count, List, NonEmpty, Positive, Text};
use crate::tasks::{Receipts, SlotState, TaskId};
use crate::train::{ChangeId, ChangeState, GitHubPrUrl, GitHubRepo};

/// A task id ("T31"), or "lead:<machineId>/<projectId>" for a project's lead.
pub type LaneId = Text<1, 80>;

/// The lane id of a project's lead.
pub fn lead_lane_id(project: &ProjectRef) -> LaneId {
    let id = format!("lead:{}/{}", project.machine_id, project.project_id);
    let mut cut = id.as_str();
    while crate::prim::js_len(cut) > 80 {
        cut = &cut[..cut.char_indices().next_back().map_or(0, |(i, _)| i)];
    }
    LaneId::unchecked(cut)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Lead,
    Implementer,
    Reader,
    Reviewer,
    Verifier,
    Qa,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LaneStatus {
    Queued,
    Starting,
    Working,
    /// A permission prompt waits on a person.
    Waiting,
    /// Usage limit: resumes at the reset.
    Parked,
    Stalled,
    Idle,
    Done,
    Failed,
    Cancelled,
}

/// What a lane is doing now, literally.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Activity {
    /// The command's first line, `cd x &&` stripped.
    Command {
        text: Text<0, 160>,
    },
    /// Repo-relative.
    Edit {
        path: Text<0, 200>,
    },
    /// A file read, or a search when `pattern` is set.
    Read {
        path: Option<Text<0, 200>>,
        pattern: Option<Text<0, 120>>,
    },
    Tool {
        name: Text<1, 60>,
        detail: Option<Text<0, 120>>,
    },
    /// Assistant text streamed in the last 3 s.
    Writing,
    /// A run is active with nothing open and no text for 3 s: waiting on the model.
    Thinking,
    Compacting,
    Retrying {
        attempt: u32,
        of: u32,
        reason: Text<0, 80>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ActivityNow {
    pub activity: Activity,
    pub since: Timestamp,
}

/// Summed over the lane's runs. `live`: the running run's usage is streaming in (else it updates at each run's end).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub live: bool,
}

/// Seconds per sparkline bucket.
pub const SPARK_BUCKET_SECS: u32 = 2;
/// Buckets in a sparkline: the last minute.
pub const SPARK_BUCKETS: usize = 30;

/// Work per 2 s bucket, oldest first, ending with the bucket that ends at `end_at`. A sample is
/// `min(255, 16 × items started + streamed chars / 32 + output tokens not streamed as text / 8)`; a bucket with
/// no frames is 0.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Spark {
    pub end_at: Timestamp,
    pub samples: List<u8, 0, SPARK_BUCKETS>,
}

/// One lane's live values. In a frame that is not `full`, only lanes that changed are sent.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LiveLane {
    pub lane_id: LaneId,
    pub status: LaneStatus,
    /// Absent: nothing to say (no run active, or no recent model output; the UI says no more than the status).
    pub activity: Option<ActivityNow>,
    pub tokens: Option<Tokens>,
    /// Absent: unchanged since the last frame (always present in a `full` frame for lanes that have one).
    pub spark: Option<Spark>,
}

/// Streamed assistant text of the focused order's lanes and lead: append to `message_id`'s text. The complete
/// message replaces it when the thread tail is refetched.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LiveText {
    pub lane_id: LaneId,
    pub message_id: NonEmpty,
    pub append: Text<0, 2000>,
}

/// A machine's load and running agents, from its heartbeat (every 15 s) and the hub's executors.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineLive {
    pub machine_id: MachineId,
    pub name: Text<0, 200>,
    pub status: MachineStatus,
    /// Absent: the node does not report load (older node, or the read failed). Show no load then.
    pub load: Option<NodeLoad>,
    /// Agent turns running there now.
    pub running: Count,
    pub as_of: Timestamp,
    /// Its latest sleep; show it while recent ([`crate::model::SleptSpan::recent_text`]).
    pub slept: Option<crate::model::SleptSpan>,
}

/// Bounds of one live frame.
pub const LIVE_MAX_LANES: usize = 64;
pub const LIVE_MAX_TEXTS: usize = 4;
pub const LIVE_MAX_MACHINES: usize = 20;
/// The hub keeps an encoded frame under this; lanes that don't fit go in the next tick.
pub const LIVE_MAX_FRAME_BYTES: usize = 16 * 1024;

/// Hub -> app on the live subscription. Board lanes at most 1/s, focus lanes and text at most 4/s; machines at most
/// every 5 s and slots at most 1/s, each only when changed. A slow link skips frames (latest wins), never queues them.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LiveFrame {
    /// The hub's clock; the app derives its skew from it.
    pub at: Timestamp,
    /// The first frame after a (re)subscribe: every lane in scope. Lanes not in a full frame are gone.
    pub full: bool,
    pub lanes: List<LiveLane, 0, LIVE_MAX_LANES>,
    /// Focus only.
    #[serde(default)]
    pub text: List<LiveText, 0, LIVE_MAX_TEXTS>,
    /// Present when any machine changed (always in a full frame).
    pub machines: Option<List<MachineLive, 0, LIVE_MAX_MACHINES>>,
    /// Present when the slot board changed (always in a full frame, once the hub runs slots).
    pub slots: Option<SlotState>,
}

/// An order's phase: the first match in this order wins, and the board sorts by it.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum OrderPhase {
    /// An open ask for it, or a lane waiting on a permission.
    WaitingOnYou,
    Failed,
    Stopped,
    /// An implementer or reader lane starting or working.
    Working,
    /// A Change reviewing, or a reviewer, verifier or qa lane working.
    Reviewing,
    /// A Change ready, rebasing, in CI or merging.
    Merging,
    /// The workstream checks its done-when.
    Verifying,
    /// Only queued lanes.
    Queued,
    /// Draft, or running with no tasks while the lead works.
    Planning,
    /// Anything else open: waiting for the lead.
    Idle,
    Done,
}

/// One PR of an order.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrRef {
    pub change_id: ChangeId,
    pub repo: GitHubRepo,
    pub number: Positive,
    pub url: GitHubPrUrl,
    pub state: ChangeState,
    /// 0-based place in its train's queue; absent when not queued.
    pub position: Option<Count>,
    /// Clean reviews of the current patch.
    pub reviews_done: Count,
    /// What the tier asks for.
    pub reviews_needed: Count,
}

/// One agent of an order: a task, or the project's lead.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentLane {
    pub lane_id: LaneId,
    pub role: AgentRole,
    pub task_id: Option<TaskId>,
    pub thread_ref: Option<ThreadRef>,
    pub title: Text<0, 80>,
    pub model: Option<Text<1, 80>>,
    pub effort: Option<Effort>,
    pub status: LaneStatus,
    /// Queued, parked or failed: why, e.g. "slots: 40/40 in use", "usage limit: resumes 14:05".
    pub status_reason: Option<Text<0, 160>>,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
    pub branch: Option<NonEmpty>,
    pub pr: Option<PrRef>,
    /// Counted from the thread's items when it ended.
    pub receipts: Option<Receipts>,
    /// Live values at snapshot time.
    pub live: Option<LiveLane>,
}

/// One order (workstream) as the board shows it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrderCard {
    pub workstream_id: WorkstreamId,
    pub project_ref: ProjectRef,
    pub title: Text<0, 200>,
    pub state: WorkstreamState,
    pub template: Option<PlaybookName>,
    pub phase: OrderPhase,
    /// "3 working", "#212 in CI", "1 question".
    pub phase_detail: Option<Text<0, 120>>,
    /// The lead's headline.
    pub next: Option<Headline>,
    /// Open asks for it.
    pub needs_you: Count,
    /// Agents done, failed or cancelled, of `total`.
    pub settled: Count,
    pub total: Count,
    /// Active first, then newest; finished lanes are left out on the board.
    pub lanes: List<AgentLane, 0, 12>,
    pub prs: List<PrRef, 0, 6>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// One PR on a train strip.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrChip {
    pub change_id: ChangeId,
    pub number: Positive,
    pub url: GitHubPrUrl,
    pub workstream_id: WorkstreamId,
    pub state: ChangeState,
    /// 0-based; absent for the head (being rebased, checked or merged) and for PRs merged today.
    pub position: Option<Count>,
}

/// One repo's merge train, resolved for the strip: head first, then the queue in order, then today's merges.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrainLive {
    pub repo: GitHubRepo,
    pub frozen: bool,
    pub frozen_reason: Option<Text<0, 200>>,
    pub chips: List<PrChip, 0, 12>,
    /// Merged since 00:00 UTC.
    pub merged_today: Count,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lead_lane_ids_stay_within_bounds() {
        let project = ProjectRef {
            machine_id: MachineId::new("devbox").unwrap(),
            project_id: crate::ids::ProjectId::new("p".repeat(200)).unwrap(),
        };
        let id = lead_lane_id(&project);
        assert!(id.starts_with("lead:devbox/"));
        assert_eq!(crate::prim::js_len(&id), 80);
        assert!(LaneId::new(id.as_str()).is_ok());
    }
}
