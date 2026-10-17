//! M12: the retro job's playbook changes, the fixed metrics they are judged by, and its runs.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::Timestamp;
use crate::ledger::{AskId, PlaybookName, PlaybookRef};
use crate::prim::{Count, Finite, Int, List, MAX_SAFE_INT, Text};
use crate::verification::IncidentId;
use crate::{brand, literal};

/// The fixed metric list, defined in code: incident counts per class, and agent-minutes per done workstream. A
/// proposal names one; the retro cannot add or change them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RetroMetricClass {
    FalseClaim,
    EstimateMiss,
    PolishLoop,
    MisfiledAsk,
    OutOfArea,
    Stall,
    PolicyBypass,
    ReAsk,
    Override,
    AgentMinutesPerDone,
}

literal!(
    /// The only metric direction.
    Decrease = "decrease"
);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RetroMetric {
    pub class: RetroMetricClass,
    pub op: Decrease,
    /// Measured over this many days after the change, against the same span before it.
    pub window_days: Int<1, 28>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlaybookChangeKind {
    Wording,
    Gate,
}

/// One change the retro's `claude -p` run proposes; the hub validates it and classifies its kind itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookChange {
    pub playbook: PlaybookName,
    /// Unified diff of the playbook file, frontmatter or body.
    pub diff: Text<1, 8000>,
    pub kind: PlaybookChangeKind,
    pub fixes_incidents: List<IncidentId, 0, 20>,
    pub metric: RetroMetric,
    pub expected: Text<1, 300>,
}

/// A metric's values over one window; agent-minutes is null when no workstream finished in it. Its keys are
/// snake_case on the wire.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RetroSnapshot {
    #[schemars(with = "crate::prim::NullOr<Finite>")]
    pub target: Option<Finite>,
    pub false_claim: Count,
    pub estimate_miss: Count,
    pub polish_loop: Count,
    #[schemars(with = "crate::prim::NullOr<Finite>")]
    pub agent_minutes_per_done: Option<Finite>,
}

brand!(
    RetroProposalId,
    name = "RetroProposalId",
    pattern = r"^R[1-9][0-9]*$"
);

/// suggested: advise-only, nothing applies. pending: a gate change waiting for the weekly Ask; asked: in it.
/// measuring: a wording change applied, its window running; then kept or reverted. applied: a gate change a person
/// approved. rejected: a person said no. stale: the playbook changed under it, so its diff no longer applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RetroProposalState {
    Suggested,
    Pending,
    Asked,
    Measuring,
    Kept,
    Reverted,
    Applied,
    Rejected,
    Stale,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RetroProposal {
    pub proposal_id: RetroProposalId,
    /// The retro run that proposed it.
    pub run: Int<1, MAX_SAFE_INT>,
    pub at: Timestamp,
    pub playbook: PlaybookName,
    /// Decided by the hub from the fields the diff touches.
    pub kind: PlaybookChangeKind,
    /// What the model said it was.
    pub claimed_kind: PlaybookChangeKind,
    pub diff: Text<1, 8000>,
    /// Frontmatter fields the diff changes, plus "body".
    pub fields: List<String, 0, 20>,
    pub fixes_incidents: List<IncidentId, 1, 20>,
    pub metric: RetroMetric,
    pub expected: Text<1, 300>,
    pub state: RetroProposalState,
    /// The gate Ask, key `playbook.<name>.<hash>`.
    pub ask_id: Option<AskId>,
    /// The version it applied and the one it replaced.
    pub r#ref: Option<PlaybookRef>,
    pub previous_ref: Option<PlaybookRef>,
    pub applied_at: Option<Timestamp>,
    /// When a wording change's window ends and its metric is computed.
    pub due_at: Option<Timestamp>,
    /// The window before it applied; `measured` is the window after.
    pub baseline: Option<RetroSnapshot>,
    pub measured: Option<RetroSnapshot>,
    pub note: Option<Text<1, 500>>,
}

literal!(OrchestratorKind = "orchestrator");

/// A `claude -p` one-shot the hub ran for itself, counted as orchestrator usage.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorRun {
    pub kind: OrchestratorKind,
    pub model: String,
    pub duration_ms: Count,
    pub ok: bool,
    pub input_tokens: Option<Count>,
    pub output_tokens: Option<Count>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RetroTrigger {
    Weekly,
    Threshold,
    Manual,
}

/// A change the hub refused, with why.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RetroRunDropped {
    pub index: Count,
    pub playbook: Option<String>,
    pub reason: Text<1, 500>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RetroRun {
    pub run: Int<1, MAX_SAFE_INT>,
    pub at: Timestamp,
    pub trigger: RetroTrigger,
    /// Nothing it proposed applies: `--advise`, or `policy.retro.apply` is not true.
    pub advise: bool,
    pub window_days: Int<1, 28>,
    /// Incidents in the window it was given.
    pub incidents: Count,
    pub proposals: List<RetroProposalId, 0, 10>,
    pub dropped: List<RetroRunDropped, 0, 20>,
    /// Absent when there was nothing to look at and no turn ran.
    pub usage: Option<OrchestratorRun>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_keeps_its_nulls() {
        let json = r#"{"target":null,"false_claim":2,"estimate_miss":0,"polish_loop":1,"agent_minutes_per_done":null}"#;
        let snapshot: RetroSnapshot = serde_json::from_str(json).unwrap();
        assert_eq!(serde_json::to_string(&snapshot).unwrap(), json);
    }
}
