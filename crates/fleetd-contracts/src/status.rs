//! The status view: one doc per scope (fleet, project, order), derived by the hub from its event log and plan. Every
//! part carries an as-of time; only the hub decides a source is stale, and a stale part says why and since when.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{EventSeq, MachineId, ProjectRef, Timestamp};
use crate::ledger::{AskId, Tier, WorkstreamId};
use crate::model::MachineStatus;
use crate::plan::{ItemStage, MilestoneId, PlanItemId};
use crate::prim::{AnyInt, Count, Int, Line, List, NonNegative, Text};
use crate::prompts::PromptRef;
use crate::steer::{SteerId, SteerStage};
use crate::tasks::TaskId;
use crate::train::{ChangeId, ChangeState, GitHubRepo};

/// Done items an ETA needs before it is shown (as in `hub/estimates`).
pub const MIN_SAMPLES: i64 = 5;

/// What a status doc covers. `key()` is the form stored per human key ("fleet", "project:forge/p1", "order:W41").
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StatusScope {
    Fleet,
    Project {
        #[serde(rename = "projectRef")]
        project_ref: ProjectRef,
    },
    Order {
        #[serde(rename = "workstreamId")]
        workstream_id: WorkstreamId,
    },
}

impl StatusScope {
    pub fn key(&self) -> String {
        match self {
            Self::Fleet => "fleet".into(),
            Self::Project { project_ref } => {
                format!(
                    "project:{}/{}",
                    project_ref.machine_id, project_ref.project_id
                )
            }
            Self::Order { workstream_id } => format!("order:{workstream_id}"),
        }
    }
}

/// Why a part is not live: its source went quiet past its cadence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StaleMark {
    /// The source's last good signal (a heartbeat, a GitHub answer, a train pass).
    pub since: Timestamp,
    /// "no heartbeat from forge for 4m", "GitHub not reached for 4m: …".
    pub reason: Line<1, 200>,
}

/// A source that is stale now, `since` its last good signal. `source` is `machine:<m>`, `usage:<m>`, `ci:<repo>`,
/// `github:<repo>`, `train:<repo>` or
/// `webhook:<repo>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StaleSource {
    pub source: Line<1, 160>,
    pub since: Timestamp,
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
    pub stale: Option<StaleMark>,
    /// The estimate the headline shows: verified work plus credit for the observed stages of work in flight.
    pub estimate: Option<ProgressEstimate>,
}

/// The headline estimate and its two-tone bar: solid is what fleetd verified, lighter is in-flight credit. Every
/// stage it credits is one fleetd observed (an event, a PR or a CI state), never an agent's word.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEstimate {
    /// verified + in flight, floored; 100 only when everything is verified.
    pub pct: Int<0, 100>,
    /// The solid part: must points verified over must points (planning share included once fixed).
    pub verified_pct: Int<0, 100>,
    /// The lighter part: credit for open items' reached stages, smoothed within the current stage.
    pub in_flight_pct: Int<0, 100>,
    /// Present for an order while its lead plans, and after (with its fixed share).
    pub planning: Option<PlanningState>,
    /// Where the stage weights came from.
    pub weights: WeightsBasis,
    /// The doc's own scope only: the estimate over time, oldest first. A drop carries its reason.
    pub series: Option<List<ProgressPoint, 0, 96>>,
}

/// Planning counts: while the lead plans (no plan items yet) it has its own small bar, not 0%.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanningState {
    /// The lead is still planning: the order has no plan items yet.
    pub active: bool,
    /// The planning bar: elapsed over the usual planning time, at most 90 while active, 100 once the plan exists.
    pub pct: Int<0, 100>,
    /// Planning's share of the order's work, fixed when the plan appears.
    pub share_pct: Int<0, 100>,
    pub since: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WeightsBasis {
    /// Measured on this project's finished items.
    Project,
    /// Too few in the project: measured across the fleet.
    Fleet,
    /// Too few anywhere: the built-in weights.
    Default,
}

/// One point of the progress series.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPoint {
    pub at: Timestamp,
    pub pct: Int<0, 100>,
    pub verified_pct: Int<0, 100>,
    /// Set when the estimate fell at this point; it never falls without one.
    pub drop: Option<ProgressDrop>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DropReason {
    /// Work was added (a scope-change marker).
    ScopeChange,
    /// A review blocked: the item fell back to "PR open".
    ReviewFailed,
    /// CI failed: the item fell back a stage.
    CiFailed,
    /// A done item reopened when a later check failed.
    Reopened,
}

/// Why the estimate fell, shown as a marker on the sparkline.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProgressDrop {
    pub reason: DropReason,
    pub from_pct: Int<0, 100>,
    /// "CI failed on #212", "+2 items: time inspector added".
    pub text: Line<1, 200>,
}

/// How close past ETAs came: "ETAs have been within ±20% this week".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForecastAccuracy {
    /// Four in five of the window's items finished within ±this % of their predicted p50.
    pub within_pct: Count,
    /// Items behind it.
    pub samples: Count,
    pub window_days: Count,
    pub text: Line<1, 120>,
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
pub enum EtaBasis {
    /// The scope's own measured rate.
    Order,
    /// Too few samples in the order: the project's rate shared among its running orders.
    Project,
    Fleet,
    /// Too few samples anywhere: no ETA ("measuring: 2 of 5 verified").
    None,
}

/// `current − original`, split into what scope added and what speed lost.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EtaSlip {
    pub scope_minutes: AnyInt,
    pub speed_minutes: AnyInt,
}

/// ETA from measured throughput; the lead's own estimate only as a comparison.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusEta {
    /// max(throughput ETA, chain ETA).
    pub current: Option<Timestamp>,
    /// The first ETA with enough samples, stored once (orders and milestones only).
    pub original: Option<Timestamp>,
    pub slip: Option<EtaSlip>,
    /// The lead's calibrated estimate, present when it differs from `current` by more than max(1 h, 50%).
    pub lead: Option<Timestamp>,
    /// Points verified per busy hour.
    pub rate: Option<NonNegative>,
    /// Items verified in the 7-day window behind `rate`.
    pub samples: Count,
    pub basis: EtaBasis,
    /// The serial chain that sets `current` when it is later than throughput says, e.g. "P12 full lab run".
    pub chain: Option<Line<1, 160>>,
    /// The progress model's range: remaining stage time from history (median and 90th percentile), spread over the
    /// slots the scope can use. Shown as "p50–p90".
    pub p50: Option<Timestamp>,
    pub p90: Option<Timestamp>,
    pub accuracy: Option<ForecastAccuracy>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GateKind {
    /// An in-progress item with open items `after` it.
    Plan,
    /// An open time span on the scope's tasks or changes.
    Live,
    /// The order's phase, when no span says more.
    Phase,
}

/// What the scope is waiting on.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub kind: GateKind,
    /// "P12 full lab run", "CI on #212", "your answer on `api.path`".
    pub label: Line<1, 160>,
    /// It blocks every in-progress item of its order.
    pub serial: bool,
    pub since: Option<Timestamp>,
    pub item_id: Option<PlanItemId>,
    pub workstream_id: Option<WorkstreamId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HeadlineSource {
    /// Phrased by the `status.headline` prompt from the current facts.
    Generated,
    /// The deterministic template: the facts changed, claude was unavailable, or the daily limit was hit.
    Template,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Headline {
    /// Starts with "Not live: …" when a source the scope depends on is stale; the hub writes that clause.
    pub text: Line<1, 400>,
    pub source: HeadlineSource,
    /// Why the template shows: "facts changed, rewriting", "claude unavailable: …", "daily limit".
    pub reason: Option<Line<1, 200>>,
    /// The prompt version that wrote a generated line, `status.headline@<sha10>`.
    pub prompt_ref: Option<PromptRef>,
    pub at: Timestamp,
}

/// Counts since the reading key last looked at this scope. Zero counts are hidden by clients.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Since {
    /// Absent: never looked (or not a human key).
    pub seen_at: Option<Timestamp>,
    pub seen_seq: Option<EventSeq>,
    /// The mark is older than the event log keeps ("since more than 30 days").
    pub pruned: Option<bool>,
    pub merged: Count,
    pub verified: Count,
    pub started: Count,
    pub failed: Count,
    pub asked: Count,
    /// Net items added (negative: dropped) by scope changes.
    pub scope_items: AnyInt,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DoneRow {
    /// Absent for an order with no plan items, which counts as one item.
    pub item_id: Option<PlanItemId>,
    pub workstream_id: Option<WorkstreamId>,
    pub title: Line<1, 120>,
    pub done_at: Timestamp,
    /// "#208 merged by the train 13:12 · check 2 passed C7".
    pub evidence: Line<1, 200>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InProgressRow {
    pub item_id: Option<PlanItemId>,
    pub workstream_id: WorkstreamId,
    pub title: Line<1, 120>,
    /// Join to the live feed's lanes for what each agent is doing now.
    pub task_ids: List<TaskId, 0, 10>,
    pub change_ids: List<ChangeId, 0, 10>,
    pub gate: Option<Line<1, 160>>,
    /// started + the median duration of done items of its size.
    pub eta: Option<Timestamp>,
    /// Minutes past `eta`.
    pub overdue_minutes: Option<Count>,
    pub stale: Option<StaleMark>,
    /// The order's latest steers, newest first, on its first in-progress row only.
    pub steers: Option<List<StatusSteer, 0, 3>>,
    /// The furthest stage fleetd observed for the item.
    pub stage: Option<ItemStage>,
    /// Share of the item's size credited to the estimate.
    pub credit_pct: Option<Int<0, 100>>,
    /// Past 1.5× the usual time for its current stage: flagged in Risks, never credited past 90% of the stage.
    pub slower_than_usual: Option<bool>,
}

/// A steer as the status doc shows it: "↳ you steered S12 14:02 · acknowledged · −1 item".
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusSteer {
    pub id: SteerId,
    pub text: Line<1, 120>,
    pub stage: SteerStage,
    pub at: Timestamp,
    /// The plan change it made, e.g. "−1 item".
    pub plan_change: Option<Line<1, 200>>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NextRow {
    pub item_id: PlanItemId,
    pub workstream_id: Option<WorkstreamId>,
    pub title: Line<1, 120>,
    /// Open items it waits on.
    pub after: List<PlanItemId, 0, 5>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NeedsYou {
    pub count: Count,
    /// Render with the inbox's one-tap answers.
    pub ask_ids: List<AskId, 0, 10>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RiskRule {
    CiRedMain,
    MachineOffline,
    BlockedOnYou,
    Slipping,
    EstimateDrift,
    RiskiestItem,
    CiRedRepeat,
    MachineFlaky,
    UsageHigh,
    SlotsFull,
    GithubDrift,
    NoPlan,
    /// A steer was not acknowledged, or has gone 10 minutes delivered without it.
    SteerUnacknowledged,
    /// An item has spent over 1.5× the usual time in its current stage.
    SlowerThanUsual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Warning,
    Danger,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Risk {
    pub rule: RiskRule,
    pub level: RiskLevel,
    pub message: Line<1, 200>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CiState {
    Green,
    Red,
    Pending,
    /// Not fetched since the hub started.
    Unknown,
}

/// Main-branch CI of one repo.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthCi {
    pub repo: GitHubRepo,
    pub state: CiState,
    pub sha: Option<Line<1, 64>>,
    pub failing: List<Text<1, 120>, 0, 10>,
    /// When the state last changed.
    pub since: Option<Timestamp>,
    /// The last GitHub answer for the repo.
    pub as_of: Option<Timestamp>,
    pub stale: Option<StaleMark>,
}

/// A sleep a machine's node reported on waking, epoch milliseconds (the same fields as `machine.slept`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SleptAt {
    pub from_ms: Count,
    pub to_ms: Count,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthMachine {
    pub machine_id: MachineId,
    pub status: MachineStatus,
    pub last_seen_at: Option<Timestamp>,
    /// Its latest sleep, for 24 h after it woke.
    pub slept: Option<SleptAt>,
    /// Times it went offline or slept in the last 24 h.
    pub drops_today: Count,
    pub stale: Option<StaleMark>,
}

/// One claude usage window: the highest utilization of that type across machines.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthUsage {
    /// claude's name, e.g. "five_hour", "seven_day".
    pub limit_type: Text<1, 40>,
    pub machine_id: MachineId,
    /// 0 to 1.
    pub utilization: Option<NonNegative>,
    pub resets_at: Option<Timestamp>,
    pub status: Text<1, 40>,
    pub observed_at: Option<Timestamp>,
    pub stale: Option<StaleMark>,
}

/// "8 running · slots 8/40 · 1 queued". Hub-local, never stale.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthSlots {
    pub running: Count,
    pub used: Count,
    pub cap: Count,
    pub queued: Count,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ci: List<HealthCi, 0, 10>,
    pub machines: List<HealthMachine, 0, 20>,
    pub usage: List<HealthUsage, 0, 4>,
    pub slots: HealthSlots,
}

/// A child figure: the fleet's projects, a project's milestones, an order's milestones.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScopePart {
    pub title: Line<1, 120>,
    /// Open it as its own scope (projects and orders).
    pub scope: Option<StatusScope>,
    pub milestone_id: Option<MilestoneId>,
    pub progress: Progress,
    pub eta: Option<Timestamp>,
}

/// How many rows each capped list left out.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoreCounts {
    pub done: Count,
    pub in_progress: Count,
    pub next: Count,
    pub risks: Count,
    pub parts: Count,
    pub stale: Count,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusDoc {
    pub scope: StatusScope,
    /// "Fleet", the project's title or the order's.
    pub title: Line<1, 120>,
    /// Bumps whenever the doc's content changes; `status_wait` waits past it.
    pub version: Count,
    /// The event log's head the doc reflects; `status_seen` records it.
    pub seq: EventSeq,
    /// The hub clock when the doc was rendered.
    pub now: Timestamp,
    pub progress: Progress,
    /// Newest first.
    pub markers: List<Marker, 0, 3>,
    pub eta: StatusEta,
    pub gates: List<Gate, 0, 3>,
    pub headline: Headline,
    pub since: Since,
    pub parts: List<ScopePart, 0, 20>,
    pub done: List<DoneRow, 0, 10>,
    pub in_progress: List<InProgressRow, 0, 20>,
    pub next: List<NextRow, 0, 10>,
    pub needs_you: NeedsYou,
    pub risks: List<Risk, 0, 5>,
    pub health: Health,
    pub stale: List<StaleSource, 0, 10>,
    pub more: MoreCounts,
    /// The order's tier when the scope is an order with no plan items.
    pub virtual_tier: Option<Tier>,
}

/// What the headline prompt is given: code builds it, the model only phrases it. Canonical JSON, at most 2 KB.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HeadlineFacts {
    pub scope: String,
    pub pct: i64,
    pub was: Option<i64>,
    pub scope_change: Option<String>,
    /// At most 3 in-progress titles, plan order.
    pub doing: Vec<String>,
    /// At most 2 gate labels, serial first.
    pub waiting_on: Vec<String>,
    pub needs_you: i64,
    pub first_ask: Option<String>,
    pub eta: Option<String>,
    pub planned: Option<String>,
    pub slipped: bool,
    /// At most 2 risk messages.
    pub risks: Vec<String>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DriftKind {
    /// A PR merged or closed outside the train, or the base moved by a non-train push.
    OutsideFleetd,
    /// Webhooks are on and reconciliation saw a change no delivery announced.
    MissedWebhook,
}

/// `github.drift`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubDriftData {
    pub repo: GitHubRepo,
    pub kind: DriftKind,
    pub what: Text<1, 200>,
    pub lag_ms: Option<Count>,
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
    fn scope_wire_and_key() {
        let order: StatusScope =
            serde_json::from_value(serde_json::json!({ "kind": "order", "workstreamId": "W41" }))
                .unwrap();
        assert_eq!(order.key(), "order:W41");
        let project: StatusScope = serde_json::from_value(serde_json::json!({
            "kind": "project", "projectRef": { "machineId": "devbox", "projectId": "p1" }
        }))
        .unwrap();
        assert_eq!(project.key(), "project:devbox/p1");
        assert_eq!(
            serde_json::to_value(StatusScope::Fleet).unwrap(),
            serde_json::json!({ "kind": "fleet" })
        );
    }
}
