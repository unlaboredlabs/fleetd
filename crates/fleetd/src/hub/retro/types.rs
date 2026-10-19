//! The retro's wire types, with the JSON older hubs used. Swapped for `fleetd_contracts`' once it has them.
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

pub const PLAYBOOK_NAMES: [&str; 4] = ["bugfix", "feature", "research", "finish-all"];

/// The fixed metric list, defined in code: incident counts per class, and agent-minutes per done workstream.
pub const METRIC_CLASSES: [&str; 7] = [
    "false_claim",
    "polish_loop",
    "out_of_area",
    "stall",
    "policy_bypass",
    "override",
    "agent_minutes_per_done",
];

/// `playbook.`: the global decisions that settle gate changes.
pub const PLAYBOOK_KEY_PREFIX: &str = "playbook.";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetroMetric {
    pub class: String,
    pub op: String,
    pub window_days: u32,
}

/// One change the retro's `claude -p` run proposes; the hub validates it and classifies its kind itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookChange {
    pub playbook: String,
    pub diff: String,
    pub kind: String,
    pub fixes_incidents: Vec<String>,
    pub metric: RetroMetric,
    pub expected: String,
}

static INCIDENT_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^I[1-9][0-9]*$").unwrap());

impl PlaybookChange {
    /// The `PlaybookChange` schema's checks, with a short reason on failure.
    pub fn decode(raw: &Value) -> Result<Self, String> {
        let c: PlaybookChange = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
        let len = |s: &str| s.chars().count();
        if len(&c.diff) == 0 || len(&c.diff) > 8000 {
            return Err("diff must be 1 to 8000 characters".into());
        }
        if c.kind != "wording" && c.kind != "gate" {
            return Err(format!(
                "kind must be \"wording\" or \"gate\", not {:?}",
                c.kind
            ));
        }
        if c.fixes_incidents.len() > 20 {
            return Err("fixesIncidents has more than 20 entries".into());
        }
        if let Some(bad) = c
            .fixes_incidents
            .iter()
            .find(|id| !INCIDENT_ID.is_match(id))
        {
            return Err(format!("{bad:?} is not an incident id"));
        }
        if c.metric.op != "decrease" {
            return Err("metric.op must be \"decrease\"".into());
        }
        if !(1..=28).contains(&c.metric.window_days) {
            return Err("metric.windowDays must be between 1 and 28".into());
        }
        if len(&c.expected) == 0 || len(&c.expected) > 300 {
            return Err("expected must be 1 to 300 characters".into());
        }
        Ok(c)
    }
}

/// A metric's values over one window; agent-minutes is null when no workstream finished in it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RetroSnapshot {
    #[serde(serialize_with = "js_number")]
    pub target: Option<f64>,
    pub false_claim: u64,
    pub polish_loop: u64,
    #[serde(serialize_with = "js_number")]
    pub agent_minutes_per_done: Option<f64>,
}

/// A number as JSON.stringify writes it: whole values without a fraction (`3`, not `3.0`).
fn js_number<S: serde::Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        None => s.serialize_none(),
        Some(n) if n.fract() == 0.0 && n.abs() < 9e15 => s.serialize_i64(*n as i64),
        Some(n) => s.serialize_f64(*n),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetroProposal {
    pub proposal_id: String,
    pub run: u64,
    pub at: String,
    pub playbook: String,
    /// Decided by the hub from the fields the diff touches.
    pub kind: String,
    /// What the model said it was.
    pub claimed_kind: String,
    pub diff: String,
    pub fields: Vec<String>,
    pub fixes_incidents: Vec<String>,
    pub metric: RetroMetric,
    pub expected: String,
    /// suggested, pending, measuring, kept, reverted, applied, rejected or stale.
    pub state: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<RetroSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measured: Option<RetroSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A `claude -p` one-shot the hub ran for itself, counted as orchestrator usage (intake's `RouterRun`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorRun {
    pub kind: String,
    pub model: String,
    pub duration_ms: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedChange {
    pub index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playbook: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetroRun {
    pub run: u64,
    pub at: String,
    /// weekly, threshold or manual.
    pub trigger: String,
    pub advise: bool,
    pub window_days: u32,
    pub incidents: usize,
    pub proposals: Vec<String>,
    pub dropped: Vec<DroppedChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<OrchestratorRun>,
    /// The retro prompt it was given (`retro@…`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_ref: Option<String>,
}
