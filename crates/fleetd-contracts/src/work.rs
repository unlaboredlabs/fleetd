//! The work ledger: what is in flight on a repo's base branch, across leads, their agents and the human's own
//! sessions. Tasks and Changes are already in the hub; a claim is the intent fleetd can't otherwise see (a human
//! session, or a lead holding something in reserve). `WorkItem` is one row of the in-flight view over all of them.
//!
//! Work is scoped by repo key and base branch, not by project: two projects on one repo see each other's work, and
//! two bases of one repo don't.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::brand;
use crate::ids::{ProjectRef, Timestamp};
use crate::plan::PlanItemId;
use crate::prim::{Line, List, js_len};
use crate::projects::short_remote;
use crate::tasks::PrUrl;
use crate::train::ChangeId;
use crate::verification::CommitSha;

brand!(
    /// "C" plus a positive integer, unique per hub, e.g. "C7".
    ClaimId, name = "ClaimId", pattern = r"^C[1-9][0-9]*$"
);

fn is_repo_key(s: &str) -> bool {
    !s.is_empty() && js_len(s) <= 300 && !s.contains(['\r', '\n']) && s == s.to_lowercase()
}

brand!(
    /// A repository on any git host, as its origin remote shortened and lowercased: "github.com/acme/shop",
    /// "gitlab.example.com/group/shop", "/srv/git/shop". `RepoKey::of` makes one from any remote form.
    RepoKey,
    name = "RepoKey",
    check = is_repo_key,
    expected = "a repo key such as github.com/acme/shop (lowercase, one line)"
);

impl RepoKey {
    /// `git@github.com:Acme/Shop.git`, `https://github.com/acme/shop` → `github.com/acme/shop`; `None` when empty.
    pub fn of(remote: &str) -> Option<Self> {
        Self::new(short_remote(remote).to_lowercase()).ok()
    }
}

/// A branch name, as git has it.
pub type BranchName = Line<1, 250>;

/// The repo and base branch work lands on: what the in-flight view is read for.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkScope {
    pub repo_key: RepoKey,
    pub base: BranchName,
}

/// An id someone chose on purpose; the same key on two pieces of work means the same work.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkKey {
    /// "#123", "ABC-123", or an issue URL.
    Issue(Line<1, 300>),
    Item(PlanItemId),
    Pr(PrUrl),
    Branch(BranchName),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaimOwnerKind {
    /// A person's own session (Claude Code over MCP, or the CLI).
    HumanSession,
    /// Anything else holding an agent key.
    AgentKey,
    /// A project's lead, holding work in reserve.
    Lead,
}

#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOwner {
    pub kind: ClaimOwnerKind,
    /// The key it called with; a lead's is its project, as `<machineId>/<projectId>`.
    pub key_id: Line<1, 200>,
    /// Who it is to a person: "laptop", a git user.email.
    pub label: Option<Line<1, 120>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaimState {
    Active,
    /// Its work reached the base.
    Landed,
    /// Its owner dropped it.
    Released,
    /// Not renewed for `CLAIM_TTL_MS`.
    Expired,
}

/// A claim lasts this long after it was made or last renewed.
pub const CLAIM_TTL_MS: i64 = 12 * 3_600_000;
/// An expired claim stays in the in-flight view, as weak, this long after it expired.
pub const EXPIRED_SHOWN_MS: i64 = 24 * 3_600_000;
pub const CLAIM_PATHS_MAX: usize = 50;
pub const OBSERVED_PATHS_MAX: usize = 200;
pub const CLAIM_KEYS_MAX: usize = 20;

/// A repo-relative path or glob: "app/theme.ts", "app/settings/**".
pub type WorkPath = Line<1, 500>;

/// What the claim's branch actually changed, refreshed from the remote branch or the CLI.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaimObserved {
    pub paths: List<WorkPath, 0, OBSERVED_PATHS_MAX>,
    pub head_sha: Option<CommitSha>,
    pub at: Timestamp,
}

#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaimEnd {
    pub at: Timestamp,
    pub reason: Line<1, 200>,
    /// The commit on the base it landed as.
    pub landing: Option<CommitSha>,
}

/// Intent fleetd can't otherwise see: a free-text title plus optional exact keys and paths.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub claim_id: ClaimId,
    pub repo_key: RepoKey,
    pub base: BranchName,
    /// When the repo is a project's.
    pub project_ref: Option<ProjectRef>,
    pub owner: ClaimOwner,
    /// "dark mode toggle in settings".
    pub title: Line<1, 120>,
    pub keys: List<WorkKey, 0, CLAIM_KEYS_MAX>,
    /// The branch the work is on; its key too.
    pub branch: Option<BranchName>,
    /// Declared.
    pub paths: List<WorkPath, 0, CLAIM_PATHS_MAX>,
    pub observed: Option<ClaimObserved>,
    /// `git config user.email` of whoever does the work, for matching their direct pushes.
    pub author_email: Option<Line<1, 200>>,
    pub state: ClaimState,
    /// Set once it is no longer active.
    pub end: Option<ClaimEnd>,
    pub created_at: Timestamp,
    pub renewed_at: Timestamp,
    pub expires_at: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemKind {
    /// A write task that is queued, running or idle and has no Change yet.
    Task,
    /// A Change on the merge train that is not merged or abandoned.
    Change,
    /// An open PR that isn't fleetd's.
    Pr,
    Claim,
    /// An open plan item with no live task.
    Planned,
}

/// One piece of work in flight, from whichever source holds it.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    /// "T12", "X4", "C7", "acme/shop#57", "P5".
    pub id: Line<1, 300>,
    pub kind: WorkItemKind,
    /// The project whose lead runs it; absent for a claim not tied to one, and for outside PRs.
    pub project_ref: Option<ProjectRef>,
    /// A claim's owner.
    pub owner: Option<ClaimOwner>,
    pub title: Line<1, 300>,
    /// Its source's own state: a task's ("running"), a Change's ("ci"), a claim's ("active", "expired").
    pub state: Line<1, 40>,
    pub keys: List<WorkKey, 0, { usize::MAX }>,
    /// Declared and observed, deduplicated.
    pub paths: List<WorkPath, 0, { usize::MAX }>,
    pub task_id: Option<crate::tasks::TaskId>,
    pub change_id: Option<ChangeId>,
    pub claim_id: Option<ClaimId>,
    /// When it was made, or a claim last renewed.
    pub since: Timestamp,
}

/// `HubEvent.data` on `work.claimed` and `work.ended`.
#[serde_with::skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkEventData {
    pub claim_id: ClaimId,
    pub repo_key: RepoKey,
    pub base: BranchName,
    pub project_ref: Option<ProjectRef>,
    pub owner_kind: ClaimOwnerKind,
    pub state: ClaimState,
    /// work.ended: why.
    pub reason: Option<String>,
    pub landing: Option<CommitSha>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claim_id_is_c_plus_a_positive_integer() {
        for id in ["C1", "C42"] {
            assert!(ClaimId::new(id).is_ok(), "{id}");
        }
        for id in ["C0", "C01", "c1", "T1", "C"] {
            assert!(ClaimId::new(id).is_err(), "{id}");
        }
    }

    #[test]
    fn a_repo_key_is_the_remote_shortened_on_any_host() {
        for (remote, key) in [
            ("git@github.com:Acme/Shop.git", "github.com/acme/shop"),
            ("https://github.com/acme/shop", "github.com/acme/shop"),
            (
                "ssh://git@gitlab.example.com/group/shop.git",
                "gitlab.example.com/group/shop",
            ),
            (
                "https://user@bitbucket.org/team/shop.git",
                "bitbucket.org/team/shop",
            ),
            ("/srv/git/shop.git", "/srv/git/shop"),
        ] {
            assert_eq!(RepoKey::of(remote).unwrap().as_str(), key, "{remote}");
        }
        assert!(RepoKey::of("  ").is_none());
        assert!(
            RepoKey::new("github.com/Acme/shop").is_err(),
            "lowercase only"
        );
    }

    #[test]
    fn a_work_key_is_one_tagged_id() {
        let keys: Vec<WorkKey> = serde_json::from_value(json!([
            { "issue": "#123" }, { "issue": "ABC-123" }, { "item": "P5" },
            { "pr": "https://gitlab.example.com/group/shop/-/merge_requests/9" }, { "branch": "wynn/dark-mode" },
        ]))
        .unwrap();
        assert_eq!(keys[2], WorkKey::Item(PlanItemId::unchecked("P5")));
        assert_eq!(
            serde_json::to_value(&keys[4]).unwrap(),
            json!({ "branch": "wynn/dark-mode" })
        );
        assert!(serde_json::from_value::<WorkKey>(json!({ "item": "T5" })).is_err());
        assert!(serde_json::from_value::<WorkKey>(json!({ "issue": "a\nb" })).is_err());
    }
}
