//! A project's plan: milestones `M<n>` holding items `P<n>`, each must or polish with a size. Only the hub marks an
//! item done, from verification (a train merge and passed done-when checks); leads add, edit and drop.

use crate::steer::SteerId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::prim::{AnyInt, Count, Int, Line, List, UniqueList};
use crate::status::{Progress, StatusEta};
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
/// A done-when index of the item's order (`Brief.done_when`, 0-based like `serves done:<n>`).
pub type CheckIndex = Int<0, 19>;

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

impl From<crate::ledger::Tier> for Size {
    fn from(tier: crate::ledger::Tier) -> Self {
        match tier {
            crate::ledger::Tier::S => Self::S,
            crate::ledger::Tier::M => Self::M,
            crate::ledger::Tier::L => Self::L,
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

/// The observable stages an item passes on its way to verified, in order. Each is credited only once fleetd saw it.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ItemStage {
    Planned,
    BriefFrozen,
    TaskStarted,
    FirstPush,
    PrOpen,
    ReviewPassed,
    CiGreen,
    Merged,
    Verified,
    /// A stage this build doesn't know (a newer hub). Never sent; not in `ALL`.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl ItemStage {
    pub const ALL: [ItemStage; 9] = [
        Self::Planned,
        Self::BriefFrozen,
        Self::TaskStarted,
        Self::FirstPush,
        Self::PrOpen,
        Self::ReviewPassed,
        Self::CiGreen,
        Self::Merged,
        Self::Verified,
    ];

    pub fn index(self) -> usize {
        self as usize
    }
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
    /// Done-when indices of the item's order that must pass in its latest claim.
    #[serde(default)]
    pub checks: UniqueList<CheckIndex, 0, 20>,
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
    /// The first item's time; scope changes within 10 minutes of it carry no marker.
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
    /// What verified it, e.g. "#212 merged by the train · check 2 passed C9".
    pub evidence: Option<Line<1, 200>>,
    /// Why it was dropped.
    pub drop_reason: Option<Line<1, 200>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanChangeKind {
    /// A lead's add, edit or drop that moved an open milestone's total after its planning window.
    Scope,
    /// A later claim failed a check a done item listed.
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
    /// Retired with the ETA: always absent.
    pub eta: Option<StatusEta>,
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
    /// Retired with the ETA: always absent.
    pub eta: Option<StatusEta>,
    pub milestones: List<MilestoneView, 0, 50>,
    pub items: List<PlanItem, 0, 500>,
    /// Newest first.
    pub markers: List<PlanChange, 0, 50>,
}

// Lead calls (`fleetd plan …`), scoped to the caller's project by cwd.

/// `fleetd plan milestone "<title>" [--position n]`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanMilestoneCall {
    pub title: PlanTitle,
    pub position: Option<Count>,
}

/// `fleetd plan add "<title>" --milestone M1 [--workstream W] [--must|--polish] [--size s|m|l] [--after P1,P2]
/// [--pr <url>] [--check <n>] [--why "<note>"]`. `--why` is required when it changes scope after the planning window.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanAddCall {
    pub title: PlanTitle,
    pub milestone_id: MilestoneId,
    pub workstream_id: Option<WorkstreamId>,
    #[serde(default)]
    pub weight: Weight,
    /// Absent: `m`, with a warning to size it.
    #[serde(default)]
    pub size: Option<Size>,
    #[serde(default)]
    pub after: UniqueList<PlanItemId, 0, 20>,
    pub pr: Option<GitHubPrUrl>,
    pub check: Option<CheckIndex>,
    pub why: Option<PlanWhy>,
    /// `--steer S12`: the change carries out a steer; it stands in for `--why` and acknowledges the steer.
    pub steer: Option<SteerId>,
}

/// `fleetd plan edit P1 [--title] [--size] [--must|--polish] [--milestone] [--workstream] [--after] [--pr +url|-url]
/// [--check +n|-n] [--position n] [--why]`. There is no state field: only the hub marks done.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanEditCall {
    pub item_id: PlanItemId,
    pub title: Option<PlanTitle>,
    pub size: Option<Size>,
    pub weight: Option<Weight>,
    pub milestone_id: Option<MilestoneId>,
    pub workstream_id: Option<WorkstreamId>,
    /// Replaces the list.
    pub after: Option<UniqueList<PlanItemId, 0, 20>>,
    #[serde(default)]
    pub pr_add: UniqueList<GitHubPrUrl, 0, 20>,
    #[serde(default)]
    pub pr_remove: UniqueList<GitHubPrUrl, 0, 20>,
    #[serde(default)]
    pub check_add: UniqueList<CheckIndex, 0, 20>,
    #[serde(default)]
    pub check_remove: UniqueList<CheckIndex, 0, 20>,
    pub position: Option<Count>,
    pub why: Option<PlanWhy>,
    /// `--steer S12`, as on `plan add`.
    pub steer: Option<SteerId>,
}

/// `fleetd plan drop P1 --why "<reason>" | --steer S12`: one of the two is required.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanDropCall {
    pub item_id: PlanItemId,
    pub why: Option<PlanWhy>,
    /// `--steer S12`, as on `plan add`.
    pub steer: Option<SteerId>,
}

/// `fleetd plan show [--workstream W]`.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanShowCall {
    pub workstream_id: Option<WorkstreamId>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PlanMilestoneResult {
    pub milestone: Milestone,
    pub next: Option<String>,
}

/// The answer to plan add, edit and drop. `change` is the marker it wrote, if it changed scope.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PlanItemResult {
    pub item: PlanItem,
    pub change: Option<PlanChange>,
    pub next: Option<String>,
    /// Granularity: the item has no size, or is bigger than m; split it.
    pub warning: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PlanShowResult {
    pub plan: PlanView,
    /// The plan as plain text, one item per line.
    pub text: String,
    pub next: Option<String>,
}
