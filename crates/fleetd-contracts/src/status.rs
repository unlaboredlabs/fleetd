//! Status: one row per project, derived by the hub from its event log and records: a state word, and the project's
//! work in groups (waiting on you, in review, working, landing, idle, done). Every row carries an as-of time; only the
//! hub decides a source is stale, and a stale row says why and since when.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::prim::{Count, Line, List, NonNegative, Positive, Text};
use crate::tasks::TaskId;
use crate::train::{ChangeId, ChangeState, GitHubRepo};

/// Why a part is not live: its source went quiet past its cadence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StaleMark {
    /// The source's last good signal (a heartbeat, a GitHub answer, a train pass).
    pub since: Timestamp,
    /// "no heartbeat from devbox for 4m", "GitHub not reached for 4m: …".
    pub reason: Line<1, 200>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum CiState {
    Green,
    Red,
    Pending,
    /// Not fetched since the hub started. Also what a state this build doesn't know decodes as.
    #[serde(other)]
    Unknown,
}

/// What a project is doing, in one word.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ProjectRowState {
    /// Agents are running, or its PRs are in review, CI or the train.
    Working,
    /// The lead is waiting for your reply.
    WaitingOnYou,
    /// Something outside the work stops it: its machine is offline, at its usage limit or short of disk or CPU for new
    /// agents, or main CI is red.
    Blocked,
    /// Nothing running and nothing waiting.
    Idle,
    /// A state this build doesn't know (a newer hub): show it as idle. Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// The project's latest merge, as the train recorded it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LastMerged {
    /// The work's own title (its writer task's), not the PR's branch.
    pub title: Line<1, 120>,
    pub pr_number: Option<Count>,
    pub pr_url: Option<Text<1, 300>>,
    /// When the train merged it.
    pub at: Timestamp,
}

/// Which group a piece of work is in. Each follows from state the hub observed (a task's run, its thread, its PR on
/// the train, an open request), never from an agent's word.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum StatusGroup {
    /// Only you can move it: the lead's question, an approval or secret request, an agent's permission prompt.
    WaitingOnYou,
    /// Its PR waits for or is with fleetd's reviewer.
    InReview,
    /// An agent is queued or running on it, or fleetd sent its PR back to its running writer.
    Working,
    /// The merge train holds its PR: review passed, rebasing, CI, merging.
    Landing,
    /// Nothing runs or waits on it: its agent ended or paused, or its PR came back with nobody on it.
    Idle,
    /// Merged in the last 7 days, or its agent finished in an order that closed in the last 7 days.
    Done,
    /// A group this build doesn't know (a newer hub): show it as idle. Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// A project's items per group. Complete: the rows' `items` may stop at a cap; these never do.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusCounts {
    pub waiting_on_you: Count,
    pub in_review: Count,
    pub working: Count,
    pub landing: Count,
    pub idle: Count,
    pub done: Count,
}

/// An item's PR.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusPr {
    pub repo: GitHubRepo,
    pub number: Positive,
    pub url: Text<1, 300>,
}

/// One piece of a project's work: an agent and its PR, a PR no listed agent wrote, or something waiting on you.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusItem {
    pub group: StatusGroup,
    pub title: Line<1, 120>,
    /// The agent that does it: the app opens it in the project's panel.
    pub task_id: Option<TaskId>,
    /// Its PR, when it has one: the app opens it in the project's panel when there is no agent.
    pub pr: Option<StatusPr>,
    /// What the group alone doesn't say: "CI failed", "usage limit: resumes 14:05", a request's text.
    pub why: Option<Line<1, 160>>,
    /// When it last moved: its PR's or its agent's latest change, a request's creation.
    pub at: Timestamp,
}

/// Items per group listed on a row; the counts cover the rest.
pub const STATUS_ITEMS_PER_GROUP: usize = 8;

/// One project on the Status screen: a state word, its work in groups, agents running and the last merge.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusRow {
    pub project_ref: ProjectRef,
    pub title: Line<1, 120>,
    pub state: ProjectRowState,
    /// Blocked only: why, in one line, for the expanded row.
    pub blocked_reason: Option<Line<1, 160>>,
    pub counts: StatusCounts,
    /// Group by group in `StatusGroup` order, newest first in each, at most `STATUS_ITEMS_PER_GROUP` per group.
    pub items: List<StatusItem, 0, 48>,
    /// Its task agents holding a slot now (the lead's own turn is not one).
    pub agents_running: Count,
    pub last_merged: Option<LastMerged>,
    /// Landed changes on its repos over the last 7 calendar days in the hub's zone, today included, by every route
    /// (metrics_get's count). Absent when the metrics know none of its repos, so nothing is read as zero.
    pub merged_7d: Option<Count>,
    /// Of `merged_7d`, the share the merge train landed, in percent. Absent when nothing landed.
    pub through_fleetd_pct_7d: Option<NonNegative>,
    pub as_of: Timestamp,
    /// Set when a source the row reads (its machine, its repos on GitHub, their merge train) went quiet.
    pub stale: Option<StaleMark>,
}

// Event data the status view adds to the log.

/// `change.state`: every train state change.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangeStateData {
    pub change_id: ChangeId,
    pub workstream_id: Option<WorkstreamId>,
    pub repo: GitHubRepo,
    pub pr_number: Count,
    pub from: ChangeState,
    pub to: ChangeState,
    /// Why it moved, when the train says: always set when a pass hands it back to `ready` (a bounce).
    pub reason: Option<Text<0, 2000>>,
}

/// `ci.main`: main-branch CI of a train repo changed state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CiMainData {
    pub repo: GitHubRepo,
    pub sha: String,
    pub state: CiState,
    pub failing: List<Text<1, 120>, 0, 10>,
}

/// `source.stale`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SourceStaleData {
    pub source: String,
    pub since_ms: Count,
    pub reason: String,
}

/// `source.fresh`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SourceFreshData {
    pub source: String,
    /// How long it was stale.
    pub stale_ms: Count,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_variants_degrade_instead_of_failing_the_row() {
        let from = |v: &str| serde_json::Value::String(v.into());
        let ci: CiState = serde_json::from_value(from("flaky")).unwrap();
        assert_eq!(ci, CiState::Unknown);
        let group: StatusGroup = serde_json::from_value(from("brand_new")).unwrap();
        assert_eq!(group, StatusGroup::Unknown);
        let state: ProjectRowState = serde_json::from_value(from("asleep")).unwrap();
        assert_eq!(state, ProjectRowState::Unknown);
    }
}
