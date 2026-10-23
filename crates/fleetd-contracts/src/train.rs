//! M7 objects: Changes (PRs on the merge train) and each repo's train.

use std::sync::LazyLock;

use regex::Regex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::prim::{Count, NonEmpty, Positive, Text, UniqueList};
use crate::tasks::TaskId;
use crate::verification::CommitSha;
use crate::{brand, checked};

brand!(
    /// "X" plus a positive integer, unique per hub, e.g. "X3".
    ChangeId, name = "ChangeId", pattern = r"^X[1-9][0-9]*$"
);

// Patterns stay free of lookarounds so the app's regex engine can run the generated JSON Schema.
static REPO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})$").unwrap()
});
static PR_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^https://github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100})/pull/([1-9][0-9]*)$").unwrap()
});

/// GitHub refuses "." and ".." as repo names.
pub fn is_repo(repo: &str) -> bool {
    REPO.captures(repo)
        .is_some_and(|captures| !matches!(&captures[2], "." | ".."))
}

brand!(
    /// A GitHub repository as "owner/name".
    GitHubRepo,
    name = "GitHubRepo",
    check = is_repo,
    expected = "a GitHub repository as owner/name",
    pattern = r"^([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})$",
    description = "GitHub repository as owner/name"
);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedPrUrl {
    pub repo: String,
    pub pr_number: i64,
}

/// The repo and number of a `https://github.com/<owner>/<name>/pull/<n>` URL, or `None` for anything else.
pub fn parse_pr_url(url: &str) -> Option<ParsedPrUrl> {
    let captures = PR_URL.captures(url)?;
    let repo = &captures[1];
    // JS Number() of a long digit string loses precision rather than failing; any such PR number is absurd anyway.
    let pr_number = captures[2].parse::<i64>().ok()?;
    is_repo(repo).then(|| ParsedPrUrl {
        repo: repo.to_owned(),
        pr_number,
    })
}

brand!(
    GitHubPrUrl,
    name = "GitHubPrUrl",
    check = |url| parse_pr_url(url).is_some(),
    expected = "a PR URL https://github.com/<owner>/<name>/pull/<n>",
    pattern = r"^https://github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100})/pull/([1-9][0-9]*)$",
    description = "https://github.com/<owner>/<name>/pull/<n>"
);

brand!(
    /// `git patch-id --stable` of the PR diff against its merge base: full lowercase hex, 40 or 64 characters.
    PatchId,
    name = "PatchId",
    pattern = r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
    description = "Full lowercase hex patch id, 40 or 64 characters"
);

/// GitHub matches owner and name case-insensitively, so the URL may differ from `repo` only in case.
pub fn pr_url_rule(repo: &str, pr_number: i64, pr_url: &str) -> Result<(), String> {
    let Some(parsed) = parse_pr_url(pr_url) else {
        return Ok(());
    };
    if parsed.repo.to_lowercase() == repo.to_lowercase() && parsed.pr_number == pr_number {
        Ok(())
    } else {
        Err(format!(
            "prUrl must be https://github.com/{repo}/pull/{pr_number}"
        ))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChangeState {
    Queued,
    Reviewing,
    Ready,
    Rebasing,
    Ci,
    Merging,
    Merged,
    NeedsRebase,
    CiFailed,
    Refused,
    Abandoned,
}

/// One review verdict, valid for exactly this patch. A clean rebase that keeps the patch id keeps it valid.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangeReview {
    pub task_id: TaskId,
    pub pr_head_sha: CommitSha,
    pub patch_id: PatchId,
    pub blocking: Count,
    pub non_blocking: Count,
}

#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct Change {
    pub change_id: ChangeId,
    pub project_ref: ProjectRef,
    pub repo: GitHubRepo,
    pub pr_number: Positive,
    pub pr_url: GitHubPrUrl,
    /// The PR's head branch.
    pub branch: NonEmpty,
    /// The write task that opened it; absent when the lead enqueued a PR no task wrote.
    pub task_id: Option<TaskId>,
    pub workstream_id: WorkstreamId,
    pub head_sha: CommitSha,
    pub patch_id: Option<PatchId>,
    pub state: ChangeState,
    pub reviews: Vec<ChangeReview>,
    /// 0-based index into its train's queue; absent when not queued.
    pub position: Option<Count>,
    /// The refusal fix, conflicting paths, or failing check names.
    pub last_error: Option<Text<0, 2000>>,
    /// The squash commit on the base; set on merge.
    pub merged_sha: Option<CommitSha>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
checked!(Change, |change| pr_url_rule(
    &change.repo,
    change.pr_number.get(),
    &change.pr_url
));

/// One serial train per repo.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrainState {
    pub repo: GitHubRepo,
    /// The Change being rebased, checked or merged now.
    pub head: Option<ChangeId>,
    /// Waiting Changes in train order.
    pub queue: UniqueList<ChangeId, 0, { usize::MAX }>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    fn change() -> Value {
        json!({
            "changeId": "X1",
            "projectRef": { "machineId": "devbox", "projectId": "p1" },
            "repo": "acme/storefront",
            "prNumber": 7,
            "prUrl": "https://github.com/acme/storefront/pull/7",
            "branch": "fleetd/T1-add-file",
            "taskId": "T1",
            "workstreamId": "W1",
            "headSha": SHA,
            "state": "queued",
            "reviews": [{ "taskId": "T2", "prHeadSha": SHA, "patchId": "f".repeat(40), "blocking": 0, "nonBlocking": 1 }],
            "createdAt": "2026-10-17T10:00:00.000Z",
            "updatedAt": "2026-10-17T10:00:00.000Z",
        })
    }

    fn accepts_change(patch: Value) -> bool {
        let mut value = change();
        for (key, field) in patch.as_object().unwrap() {
            value[key] = field.clone();
        }
        serde_json::from_value::<Change>(value).is_ok()
    }

    #[test]
    fn change_id_is_x_plus_a_positive_integer() {
        for id in ["X1", "X42"] {
            assert!(ChangeId::new(id).is_ok(), "{id}");
        }
        for id in ["X0", "X01", "x1", "C1", "X", "X1a"] {
            assert!(ChangeId::new(id).is_err(), "{id}");
        }
    }

    #[test]
    fn repos_are_owner_slash_name() {
        for repo in [
            "acme/storefront-api",
            "Microsoft/TypeScript",
            "o/r.js",
            "o/.github",
            "o/a_b-c",
        ] {
            assert!(GitHubRepo::new(repo).is_ok(), "{repo}");
        }
        let long_owner = format!("{}/r", "o".repeat(40));
        for repo in [
            "fleetd",
            "o/",
            "/r",
            "o/r/x",
            "-o/r",
            "o/.",
            "o/..",
            "o/r s",
            &long_owner,
            "https://github.com/o/r",
        ] {
            assert!(GitHubRepo::new(repo).is_err(), "{repo}");
        }
    }

    #[test]
    fn pr_urls_are_only_github_pull_urls() {
        assert_eq!(
            parse_pr_url("https://github.com/acme/storefront-api/pull/12"),
            Some(ParsedPrUrl {
                repo: "acme/storefront-api".into(),
                pr_number: 12
            })
        );
        for url in [
            "http://github.com/o/r/pull/1",
            "https://github.com/o/r/pull/0",
            "https://github.com/o/r/pull/01",
            "https://github.com/o/r/issues/1",
            "https://github.com/o/r/pull/1/files",
            "https://github.com/o/r/pull/1#discussion",
            "https://github.com.evil.io/o/r/pull/1",
            "https://ghe.example.com/o/r/pull/1",
            "https://github.com/o/../pull/1",
            "o/r#1",
        ] {
            assert!(GitHubPrUrl::new(url).is_err(), "{url}");
        }
    }

    #[test]
    fn change_pr_url_names_the_same_repo_and_number() {
        assert!(accepts_change(json!({})));
        assert!(accepts_change(
            json!({ "prUrl": "https://github.com/Acme/Storefront/pull/7" })
        ));
        assert!(!accepts_change(json!({ "prNumber": 8 })));
        assert!(!accepts_change(json!({ "repo": "acme/storefront-api" })));
        assert!(!accepts_change(
            json!({ "prNumber": 0, "prUrl": "https://github.com/acme/storefront/pull/0" })
        ));
        let decoded: Change = serde_json::from_value(change()).unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), change());
    }

    #[test]
    fn shas_and_patch_ids_are_full_lowercase_hex() {
        assert!(accepts_change(
            json!({ "patchId": "a".repeat(64), "mergedSha": "b".repeat(40), "state": "merged" })
        ));
        for bad in [SHA[..12].to_owned(), SHA.to_uppercase(), format!("{SHA}0")] {
            assert!(!accepts_change(json!({ "headSha": bad })), "{bad}");
            assert!(PatchId::new(bad.as_str()).is_err(), "{bad}");
            assert!(CommitSha::new(bad.as_str()).is_err(), "{bad}");
            let mut reviews = change()["reviews"].clone();
            reviews[0]["patchId"] = json!(bad);
            assert!(!accepts_change(json!({ "reviews": reviews })), "{bad}");
        }
    }

    #[test]
    fn train_lists_each_change_once() {
        assert!(
            serde_json::from_value::<TrainState>(
                json!({ "repo": "o/r", "head": "X1", "queue": ["X2", "X3"] })
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<TrainState>(json!({ "repo": "o/r", "queue": ["X2", "X2"] }))
                .is_err()
        );
    }
}
