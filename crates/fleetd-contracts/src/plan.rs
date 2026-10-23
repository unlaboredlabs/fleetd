//! A project's plan: milestones `M<n>` holding items `P<n>`, each must or polish with a size. Only the hub marks an
//! item done, when its linked PR merged; leads set the list with `plan`.

use crate::steer::SteerId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::prim::{AnyInt, Count, Int, Line, List, UniqueList};
use crate::status::Progress;
use crate::tasks::TaskId;
use crate::train::GitHubPrUrl;

brand!(
    /// "M" plus a positive integer, unique per hub.
    MilestoneId, name = "MilestoneId", pattern = r"^M[1-9][0-9]*$"
);
brand!(
    /// "P" plus a positive integer, unique per hub.
    PlanItemId, name = "PlanItemId", pattern = r"^P[1-9][0-9]*$"
);

pub type PlanTitle = Line<1, 120>;
/// `--why`: the reason for a scope change or a drop.
pub type PlanWhy = Line<1, 200>;

#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Weight {
    /// Counts toward the headline number.
    #[default]
    Must,
    /// Shown beside the number, never in it.
    Polish,
}

#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Size {
    S,
    #[default]
    M,
    L,
}

impl Size {
    pub fn points(self) -> i64 {
        match self {
            Self::S => 1,
            Self::M => 3,
            Self::L => 8,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanItemState {
    Open,
    /// Set only by the hub, from verification.
    Done,
    Dropped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MilestoneState {
    Open,
    /// Derived: at least one item done and every item done or dropped.
    Done,
}

/// What ties work to an item. An item with no links never counts done.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanLinks {
    /// Tasks spawned with `--item`; their Changes count through `Change.task_id`.
    #[serde(default)]
    pub tasks: UniqueList<TaskId, 0, 50>,
    /// PRs listed on the item (`--pr`, or `change enqueue --item`).
    #[serde(default)]
    pub prs: UniqueList<GitHubPrUrl, 0, 20>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    pub milestone_id: MilestoneId,
    pub project_ref: ProjectRef,
    pub title: PlanTitle,
    pub position: Count,
    pub state: MilestoneState,
    pub created_at: Timestamp,
    /// The first item's time.
    pub first_item_at: Option<Timestamp>,
    pub done_at: Option<Timestamp>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub item_id: PlanItemId,
    pub project_ref: ProjectRef,
    pub milestone_id: MilestoneId,
    pub workstream_id: Option<WorkstreamId>,
    pub title: PlanTitle,
    pub weight: Weight,
    pub size: Size,
    pub position: Count,
    #[serde(default)]
    pub links: PlanLinks,
    /// Items that must be done before this one starts: serial gates.
    #[serde(default)]
    pub after: UniqueList<PlanItemId, 0, 20>,
    pub state: PlanItemState,
    /// The first linked `task.started`.
    pub started_at: Option<Timestamp>,
    pub done_at: Option<Timestamp>,
    /// What verified it, e.g. "#212 merged by the train".
    pub evidence: Option<Line<1, 200>>,
    /// Why it was dropped.
    pub drop_reason: Option<Line<1, 200>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanChangeKind {
    /// A lead's `plan` call that moved a milestone's total after it had items.
    Scope,
    /// Older markers only: a later claim failed a check a done item listed.
    Reopened,
    /// Items dropped by the hub when their order finished, stopped or failed.
    Closed,
    /// A milestone finished and left the project's figure.
    MilestoneDone,
    /// An item was added to a done milestone.
    MilestoneReopened,
}

/// One marker: a recorded change to a figure's denominator, never a silent jump.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanChange {
    pub kind: PlanChangeKind,
    pub milestone_id: MilestoneId,
    pub workstream_id: Option<WorkstreamId>,
    pub at: Timestamp,
    /// `lead:<projectRef>`, a key id, or `hub`.
    pub by: Line<1, 120>,
    pub delta_items: AnyInt,
    /// In points.
    pub delta_size: AnyInt,
    pub pct_before: Option<Int<0, 100>>,
    pub pct_after: Option<Int<0, 100>>,
    /// "+3 items: time inspector added".
    pub note: Line<1, 200>,
}

/// A milestone with its derived figure.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneView {
    #[serde(flatten)]
    pub milestone: Milestone,
    pub progress: Progress,
}

/// A plan as `plan show` and `plan_get` return it: derived state, figures and markers.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub project_ref: ProjectRef,
    /// Set when the view is one order's items.
    pub workstream_id: Option<WorkstreamId>,
    pub progress: Progress,
    pub milestones: List<MilestoneView, 0, 50>,
    pub items: List<PlanItem, 0, 500>,
    /// Newest first.
    pub markers: List<PlanChange, 0, 50>,
}

/// One line of `plan`: an existing item by `id`, or a new one.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanItemSpec {
    pub id: Option<PlanItemId>,
    pub title: PlanTitle,
    #[serde(default)]
    pub weight: Weight,
    #[serde(default)]
    pub size: Size,
    /// Items that must be done first.
    #[serde(default)]
    pub after: UniqueList<PlanItemId, 0, 20>,
    /// The milestone's title, created when new. Absent: the workstream's title.
    pub milestone: Option<PlanTitle>,
}

/// `plan`: sets a workstream's items, in order, and returns the plan. Its open items left out are dropped. Without
/// `items` it only returns the plan (one workstream's with `workstreamId`).
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanCall {
    pub workstream_id: Option<WorkstreamId>,
    pub items: Option<List<PlanItemSpec, 0, 100>>,
    /// A note for the change's marker.
    pub why: Option<PlanWhy>,
    /// The change carries out steer S12, which counts as acknowledged.
    pub steer: Option<SteerId>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PlanResult {
    pub plan: PlanView,
    /// The plan as plain text, one item per line.
    pub text: String,
    pub next: Option<String>,
}
