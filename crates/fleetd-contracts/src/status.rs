//! Status: one row per project, derived by the hub from its event log and plan, and the series behind a row's bar.
//! Every row carries an as-of time; only the hub decides a source is stale, and a stale row says why and since when.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::plan::{MilestoneId, PlanItemId};
use crate::prim::{AnyInt, Count, Int, Line, List, NonNegative, Text};
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

/// A figure. `pct` counts verified must items by size only; polish shows beside it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// floor(100 · must points done / must points open or done); the polish figure when there are no must items.
    pub pct: Int<0, 100>,
    pub polish_pct: Option<Int<0, 100>>,
    /// Must items done and in the figure.
    pub done: Count,
    pub total: Count,
    /// Polish items done and in the figure ("polish 2/5").
    pub polish_done: Count,
    pub polish_total: Count,
    pub as_of: Timestamp,
    /// The latest scope change, e.g. "↓ from 80% · +3 items: time inspector added".
    pub marker: Option<Marker>,
}

/// A project's two-tone bar: solid is what fleetd verified, lighter is credit for work in flight. Every stage it
/// credits is one fleetd observed (an event, a PR or a CI state), never an agent's word, and nothing in it is a time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEstimate {
    /// verified + in flight, floored; 100 only when everything is verified.
    pub pct: Int<0, 100>,
    /// The solid part: points verified over points counted.
    pub verified_pct: Int<0, 100>,
    /// The lighter part: credit for open units' reached stages, plus in-stage credit for the time work on them ran.
    pub in_flight_pct: Int<0, 100>,
}

/// One point of a project's series: its bar over time, oldest first.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPoint {
    pub at: Timestamp,
    pub pct: Int<0, 100>,
    pub verified_pct: Int<0, 100>,
    /// Set when the figure fell at this point; it never falls without one.
    pub drop: Option<ProgressDrop>,
    /// Set while the figure holds because the work in flight paused, waiting for an answer or for a usage limit to
    /// reset ("paused: an agent hit a usage limit"). A marker, not a drop: what was earned stays.
    pub paused: Option<Line<1, 200>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum DropReason {
    /// Work was added (a scope-change marker).
    ScopeChange,
    /// A review blocked: the item fell back to "PR open".
    ReviewFailed,
    /// CI failed: the item fell back a stage.
    CiFailed,
    /// A done item reopened when a later check failed.
    Reopened,
    /// An agent ended with nothing else in flight for its item: the item's in-stage credit is taken back.
    WorkStopped,
    /// A reason this build doesn't know (a newer hub): show the drop's text. Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

/// Why the figure fell.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProgressDrop {
    pub reason: DropReason,
    pub from_pct: Int<0, 100>,
    /// "CI failed on #212", "+2 items: time inspector added".
    pub text: Line<1, 200>,
}

/// A change to a figure's denominator, shown next to it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub at: Timestamp,
    /// "+3 items: time inspector added".
    pub text: Line<1, 200>,
    pub pct_before: Option<Int<0, 100>>,
    pub pct_after: Option<Int<0, 100>>,
    pub delta_items: AnyInt,
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

/// One project on the Status screen: a state word, the two-tone bar, agents running and the last merge.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusRow {
    pub project_ref: ProjectRef,
    pub title: Line<1, 120>,
    pub state: ProjectRowState,
    /// Blocked only: why, in one line, for the expanded row.
    pub blocked_reason: Option<Line<1, 160>>,
    /// The project's bar, under the drop rule of its series (status_get). Absent when it has nothing to count.
    pub progress: Option<ProgressEstimate>,
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

/// `plan.changed`: a marker was written.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanChangedData {
    #[serde(flatten)]
    pub change: crate::plan::PlanChange,
}

/// `plan.verified`: the hub marked an item done.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanVerifiedData {
    pub item_id: PlanItemId,
    pub milestone_id: MilestoneId,
    pub workstream_id: Option<WorkstreamId>,
    pub evidence: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_variants_degrade_instead_of_failing_the_row() {
        let from = |v: &str| serde_json::Value::String(v.into());
        let ci: CiState = serde_json::from_value(from("flaky")).unwrap();
        assert_eq!(ci, CiState::Unknown);
        let reason: DropReason = serde_json::from_value(from("brand_new")).unwrap();
        assert_eq!(reason, DropReason::Unknown);
        let state: ProjectRowState = serde_json::from_value(from("asleep")).unwrap();
        assert_eq!(state, ProjectRowState::Unknown);
    }
}
