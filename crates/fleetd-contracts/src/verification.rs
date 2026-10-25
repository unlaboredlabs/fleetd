//! M6 objects: review verdicts.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::brand;
use crate::prim::{Count, Text};
use crate::tasks::TaskId;

brand!(
    /// A full lowercase commit SHA (SHA-1 or SHA-256), so the same head always compares equal.
    CommitSha,
    name = "CommitSha",
    pattern = r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
    description = "Full lowercase hex commit SHA, 40 or 64 characters"
);

/// A review task's verdict (`report`, `fleetd review verdict`), the last step of every review task.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewVerdict {
    /// The review task. From a task's session the hub fills it in: it is the session's own task.
    pub task_id: Option<TaskId>,
    /// The head reviewed. The hub fills it in when left out: the head a train review round was given, else the PR's
    /// head now; none for a judge, which reviews criteria rather than a PR.
    pub pr_head_sha: Option<CommitSha>,
    pub blocking: Count,
    pub non_blocking: Count,
    pub summary: Text<1, 4000>,
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
        assert!(!accepts(json!({ "summary": "x".repeat(4001) })));
    }
}
