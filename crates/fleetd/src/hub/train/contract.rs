//! TEMPORARY: the M7 contract types this area uses, mirroring packages/contracts/src/{train,ledger,ids}.ts, until
//! `fleetd-contracts` lands. On rebase this file becomes `pub use fleetd_contracts::...` re-exports.
use serde::{Deserialize, Serialize};

macro_rules! id {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);
        impl $name {
            pub fn unchecked(value: impl Into<String>) -> Self {
                Self(value.into())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl std::ops::Deref for $name {
            type Target = str;
            fn deref(&self) -> &str {
                &self.0
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}
id!(MachineId);
id!(ProjectId);
id!(ChangeId);
id!(TaskId);
id!(WorkstreamId);

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub machine_id: MachineId,
    pub project_id: ProjectId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Tier {
    S,
    M,
    L,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::S => "S",
            Tier::M => "M",
            Tier::L => "L",
        }
    }
}

impl std::fmt::Display for Tier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

impl ChangeState {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeState::Queued => "queued",
            ChangeState::Reviewing => "reviewing",
            ChangeState::Ready => "ready",
            ChangeState::Rebasing => "rebasing",
            ChangeState::Ci => "ci",
            ChangeState::Merging => "merging",
            ChangeState::Merged => "merged",
            ChangeState::NeedsRebase => "needs_rebase",
            ChangeState::CiFailed => "ci_failed",
            ChangeState::Refused => "refused",
            ChangeState::Abandoned => "abandoned",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(s.into())).ok()
    }
}

impl std::fmt::Display for ChangeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeReview {
    pub task_id: TaskId,
    pub pr_head_sha: String,
    pub patch_id: String,
    pub blocking: i64,
    pub non_blocking: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub change_id: ChangeId,
    pub project_ref: ProjectRef,
    pub repo: String,
    pub pr_number: i64,
    pub pr_url: String,
    pub branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<TaskId>,
    pub workstream_id: WorkstreamId,
    pub serves: String,
    pub tier: Tier,
    pub head_sha: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_id: Option<String>,
    pub state: ChangeState,
    pub reviews: Vec<ChangeReview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_sha: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainState {
    pub repo: String,
    pub frozen: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<ChangeId>,
    pub queue: Vec<ChangeId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRule {
    pub reviewers: i64,
    pub verifier: bool,
    pub plan_first: bool,
}

/// `fleetd change enqueue` without its `op`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEnqueueInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<TaskId>,
    pub pr_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workstream_id: Option<WorkstreamId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serves: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<Tier>,
}

fn is_owner(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 39 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

fn is_name(s: &str) -> bool {
    (1..=100).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-')) && s != "." && s != ".."
}

/// The repo and number of a `https://github.com/<owner>/<name>/pull/<n>` URL.
pub fn parse_pr_url(url: &str) -> Option<(String, i64)> {
    let rest = url.strip_prefix("https://github.com/")?;
    let mut parts = rest.split('/');
    let (owner, name, pull, n) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || pull != "pull" || !is_owner(owner) || !is_name(name) {
        return None;
    }
    if n.is_empty() || n.starts_with('0') || !n.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((format!("{owner}/{name}"), n.parse().ok()?))
}

fn is_http_url(s: &str) -> bool {
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty() && !r.starts_with('/'))
}

fn is_count(s: &str) -> bool {
    s == "0" || (!s.is_empty() && !s.starts_with('0') && s.bytes().all(|c| c.is_ascii_digit()))
}

/// `done:<n>`, `issue:<#n|url>`, `defect:<one line>` or `ask:A<n>`.
pub fn is_serves(serves: &str) -> bool {
    let Some((kind, r)) = serves.split_once(':') else { return false };
    match kind {
        "done" => is_count(r),
        "issue" => r.strip_prefix('#').is_some_and(|n| is_count(n) && n != "0") || is_http_url(r),
        "defect" => r.chars().count() <= 200 && !r.trim().is_empty() && !r.contains(['\r', '\n']),
        "ask" => r.strip_prefix('A').is_some_and(|n| is_count(n) && n != "0"),
        _ => false,
    }
}
