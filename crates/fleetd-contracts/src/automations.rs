//! Automations: a project's stored prompt and its triggers (a 5-field cron in an IANA time zone, an incoming webhook,
//! Run now). Each run opens an order for the project's lead, which starts the work on its own.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::prim::{Count, Line, List, Text};
use crate::wakes::TimeZone;

/// The most automations one project keeps.
pub const AUTOMATIONS_PER_PROJECT: usize = 50;
/// A webhook body past this many bytes is refused (413).
pub const WEBHOOK_BODY_MAX: usize = 16 * 1024;
/// The runs one automation keeps; older ones go.
pub const RUNS_KEPT: usize = 100;

brand!(
    /// "au_" plus random URL-safe characters, unique per hub.
    AutomationId, name = "AutomationId", pattern = r"^au_[A-Za-z0-9_-]{6,40}$"
);
brand!(
    /// "ar_" plus random URL-safe characters, unique per hub.
    AutomationRunId, name = "AutomationRunId", pattern = r"^ar_[A-Za-z0-9_-]{6,40}$"
);

pub type AutomationName = Line<1, 80>;
/// What the lead is asked to do on each run.
pub type AutomationPrompt = Text<1, 2000>;

/// Standard 5-field cron (or @daily, @hourly…) read in `tz`; the hub parses it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AutomationSchedule {
    pub cron: Line<1, 100>,
    pub tz: TimeZone,
}

/// What started a run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum AutomationTrigger {
    Schedule,
    Webhook,
    /// Run now, from the app or the lead.
    Manual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum AutomationRunState {
    /// Its order is open.
    Running,
    /// Its order was closed as done.
    Done,
    /// Its order was stopped.
    Stopped,
    /// It came while another run was going, or while the automation was paused; `why` says which.
    Skipped,
    /// Its order could not be opened; `why` says why.
    Failed,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub run_id: AutomationRunId,
    pub automation_id: AutomationId,
    pub trigger: AutomationTrigger,
    pub at: Timestamp,
    pub state: AutomationRunState,
    /// The order it opened.
    pub workstream_id: Option<WorkstreamId>,
    /// A scheduled run: the time it was due.
    pub scheduled_at: Option<Timestamp>,
    /// A scheduled run the hub was down for, run once on its return: by how many minutes.
    pub late_min: Option<Count>,
    /// A webhook run: the size of the body it carried. The body itself is in automation_runs only.
    pub payload_bytes: Option<Count>,
    /// Why it was skipped or failed.
    pub why: Option<Line<0, 200>>,
    /// Who pressed Run now: a keyId, "human" or "lead:<machineId>/<projectId>".
    pub by: Option<String>,
    pub ended_at: Option<Timestamp>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub automation_id: AutomationId,
    pub project_ref: ProjectRef,
    pub name: AutomationName,
    pub prompt: AutomationPrompt,
    /// Absent: no schedule.
    pub schedule: Option<AutomationSchedule>,
    /// Whether it has a webhook URL. The URL holds a secret, shown once when it is made or rotated.
    pub webhook: bool,
    /// A paused automation's schedule and webhook start nothing; Run now still runs it.
    pub paused: bool,
    /// The schedule's next run; absent while paused or without a schedule.
    pub next_run_at: Option<Timestamp>,
    pub last_run: Option<AutomationRun>,
    /// Who made it: a keyId, "human" or "lead:<machineId>/<projectId>".
    pub created_by: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// The nightly memory refresh (hub/memory/refresh), listed with a project's automations as a built-in row: a hub job,
/// not an automation. Its hour is the hub's (`policy.memory_refresh_at` in `policy.tz`, set by an admin), its switch
/// the project's `memory_refresh` setting; it has no prompt to edit, no webhook and no delete.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRefreshJob {
    /// The project's `memory_refresh` setting.
    pub on: bool,
    /// Its hour, "HH:MM" in `tz`.
    pub at: Line<5, 5>,
    pub tz: TimeZone,
    /// Absent while off.
    pub next_run_at: Option<Timestamp>,
    /// The run going now, else the last one.
    pub last_run: Option<MemoryRefreshRun>,
}

/// One refresh: when it started (or was skipped), how it went, and what it changed in memory.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRefreshRun {
    pub at: Timestamp,
    pub trigger: AutomationTrigger,
    /// running, done (it completed), failed (it didn't start, failed or ran past its hour) or skipped.
    pub state: AutomationRunState,
    /// Entries added, put in place of another, and removed: the "+a ~b −c" of its chat line.
    pub added: Count,
    pub replaced: Count,
    pub removed: Count,
    /// Why it was skipped or failed.
    pub why: Option<Line<0, 200>>,
}

pub type Automations = List<Automation, 0, AUTOMATIONS_PER_PROJECT>;
pub type AutomationRuns = List<AutomationRun, 0, RUNS_KEPT>;
/// A webhook run's body as it came, at most [`WEBHOOK_BODY_MAX`] bytes.
pub type AutomationPayload = Text<0, WEBHOOK_BODY_MAX>;

// ---- the lead's calls -----------------------------------------------------------------------------

/// `automation_create`: a new automation in the lead's project. A webhook is added in the app, where a person sees
/// its secret URL.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AutomationCreateCall {
    pub name: AutomationName,
    pub prompt: AutomationPrompt,
    /// Absent: it runs only on Run now (and a webhook, once a person adds one).
    pub schedule: Option<AutomationSchedule>,
}

/// `automation_list`: the project's automations with their last run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AutomationListCall {}

/// `automation_update`: changes only the fields given.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationUpdateCall {
    pub automation_id: AutomationId,
    pub name: Option<AutomationName>,
    pub prompt: Option<AutomationPrompt>,
    pub schedule: Option<AutomationSchedule>,
    /// true: take its schedule off.
    pub remove_schedule: Option<bool>,
}

/// `automation_pause`: paused true stops its schedule and webhook; false resumes them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPauseCall {
    pub automation_id: AutomationId,
    pub paused: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDeleteCall {
    pub automation_id: AutomationId,
}

/// `automation_run`: Run now.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunCall {
    pub automation_id: AutomationId,
}

/// `automation_runs`: its runs, newest first; with runId, that run with its webhook body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunsCall {
    pub automation_id: AutomationId,
    pub run_id: Option<AutomationRunId>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AutomationResult {
    pub automation: Automation,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AutomationListResult {
    pub automations: Automations,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDeleteResult {
    pub automation_id: AutomationId,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AutomationRunResult {
    pub run: AutomationRun,
    pub next: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AutomationRunsResult {
    pub runs: AutomationRuns,
    /// With runId: that run's webhook body.
    pub payload: Option<AutomationPayload>,
    pub next: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_and_schedules_decode_with_their_checks() {
        assert!(AutomationId::new("au_Ab3_x-9q").is_ok());
        assert!(AutomationId::new("ar_Ab3_x-9q").is_err());
        let ok: Result<AutomationSchedule, _> =
            serde_json::from_value(json!({ "cron": "0 9 * * 1-5", "tz": "Europe/Berlin" }));
        assert!(ok.is_ok());
        let bad: Result<AutomationSchedule, _> =
            serde_json::from_value(json!({ "cron": "0 9 * * 1-5", "tz": "Mars/Olympus" }));
        assert!(bad.is_err());
    }
}
