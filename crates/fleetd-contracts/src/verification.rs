//! M6 objects: claims and their check results, review verdicts, calibrated ETAs and incidents.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::brand;
use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::{CheckSpec, MetricValues, WorkstreamId};
use crate::prim::{Count, List, NonNegative, PositiveNumber, Text};
use crate::tasks::TaskId;

brand!(ClaimId, name = "ClaimId", pattern = r"^C[1-9][0-9]*$");
brand!(IncidentId, name = "IncidentId", pattern = r"^I[1-9][0-9]*$");
brand!(
    /// A full lowercase commit SHA (SHA-1 or SHA-256), so the same head always compares equal.
    CommitSha,
    name = "CommitSha",
    pattern = r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
    description = "Full lowercase hex commit SHA, 40 or 64 characters"
);

/// `error` (the check could not run) counts as not passing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckOutcome {
    Pass,
    Fail,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckResultRanBy {
    Hub,
    Node,
    Judge,
    Human,
}

#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// 0-based index into the brief's doneWhen.
    pub check_index: Count,
    pub spec: CheckSpec,
    pub result: CheckOutcome,
    /// Output tail, HTTP status and body excerpt, verdict summary, or the fix when `error`.
    pub evidence: Text<0, 2000>,
    /// Only for `cmd` checks, which the node runs.
    pub exit_code: Option<i64>,
    pub ran_by: CheckResultRanBy,
    pub at: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaimOutcome {
    Pass,
    Fail,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub claim_id: ClaimId,
    pub workstream_id: WorkstreamId,
    /// "lead:<machineId>/<projectId>", an agent keyId or "human".
    pub by: String,
    pub at: Timestamp,
    /// In check index order.
    pub results: List<CheckResult, 0, 20>,
    /// `pass` only when every check passed.
    pub outcome: ClaimOutcome,
}

/// `fleetd review verdict`, the last step of every review task.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewVerdict {
    pub task_id: TaskId,
    pub pr_head_sha: CommitSha,
    pub blocking: Count,
    pub non_blocking: Count,
    pub summary: Text<1, 1000>,
    /// M9: a research workstream's judge reports its metric for the baseline and the candidate; the hub computes the verdict.
    pub metric_values: Option<MetricValues>,
}

/// The brief's raw estimate corrected by the tier's measured actual/raw ratio.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Eta {
    pub raw_minutes: NonNegative,
    pub calibrated_minutes: NonNegative,
    /// Median actual/raw over the tier's last 20 done workstreams; the 5.0 prior below 5 samples.
    pub ratio: PositiveNumber,
    pub samples: Count,
    /// From 10 samples on.
    pub p80_minutes: Option<NonNegative>,
}

/// `policy_bypass`: a PR on a watched repo was merged by something other than the train. M12: `re_ask`, a human was
/// asked about a key that already had an active Decision; `override`, a human replaced a lead's Decision with another
/// value; `playbook_reverted`, a retro wording change missed its metric and was rolled back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IncidentClass {
    FalseClaim,
    /// Retired: fleetd no longer scores time estimates. Kept so older incidents still read.
    EstimateMiss,
    PolishLoop,
    MisfiledAsk,
    OutOfArea,
    Stall,
    PolicyBypass,
    ReAsk,
    Override,
    PlaybookReverted,
}

/// Recorded by the hub, never by an agent.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Incident {
    pub incident_id: IncidentId,
    pub class: IncidentClass,
    pub project_ref: ProjectRef,
    pub workstream_id: Option<WorkstreamId>,
    pub task_id: Option<TaskId>,
    /// Plain-language lines: claim ids with their failing checks, ratios, SHAs.
    pub evidence: List<Text<1, 2000>, 0, 20>,
    pub at: Timestamp,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn review_verdict_needs_a_full_lowercase_head_sha_and_sane_counts() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let verdict = json!({ "taskId": "T4", "prHeadSha": sha, "blocking": 0, "nonBlocking": 2, "summary": "two nits" });
        let accepts = |patch: serde_json::Value| {
            let mut value = verdict.clone();
            for (key, field) in patch.as_object().unwrap() {
                value[key] = field.clone();
            }
            serde_json::from_value::<ReviewVerdict>(value).is_ok()
        };
        assert!(accepts(json!({})));
        assert!(accepts(json!({ "prHeadSha": "a".repeat(64) })));
        for bad in [sha[..7].to_owned(), sha.to_uppercase(), format!("{sha}0")] {
            assert!(!accepts(json!({ "prHeadSha": bad })), "{bad}");
        }
        assert!(!accepts(json!({ "blocking": -1 })));
        assert!(!accepts(json!({ "summary": "" })));
        assert!(!accepts(json!({ "summary": "x".repeat(1001) })));
    }
}
