//! A project's PRs and one PR in detail, for the PR list and PR view: `pr_list`, `pr_get`, `pr_files` and `pr_diff`.
//!
//! The hub joins what it records (the merge queue, its agents' reviews, the agent that wrote each PR) with what GitHub
//! says (titles, descriptions, checks, files, people's reviews), read through `gh` and cached briefly. When GitHub
//! can't be reached the answer still carries the hub's own records and says why in `githubError`. Every read is
//! refetched on the durable events that move a PR: `change.*`, `pr.merged`, `review.verdict`, `train.*` and `task.*`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::effort::TaskProfile;
use crate::ids::{ThreadRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::live::{AgentRole, LaneId};
use crate::prim::{Count, NonEmpty, Positive, Text};
use crate::tasks::TaskId;
use crate::train::{ChangeId, ChangeState, GitHubPrUrl, GitHubRepo};

/// The most rows `pr_list` answers.
pub const PR_LIST_MAX: usize = 60;
/// Files per `pr_files` page.
pub const PR_FILES_PAGE: usize = 100;
/// Diff lines per `pr_diff` page, at most.
pub const PR_DIFF_PAGE_MAX: usize = 400;
/// The longest diff line sent; longer lines are cut and marked `cut`.
pub const PR_DIFF_LINE_MAX: usize = 400;

/// The PR on GitHub.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

/// The checks on the PR's head, rolled up: any failed is `failing`, else any running is `pending`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ChecksState {
    /// No checks ran on it.
    None,
    Pending,
    Passing,
    Failing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChecksSummary {
    pub state: ChecksState,
    pub passed: Count,
    pub failed: Count,
    pub pending: Count,
}

/// Its reviews, rolled up.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ReviewState {
    /// Nothing asks for a review.
    None,
    /// Reviews are asked for or running.
    Pending,
    Approved,
    ChangesRequested,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSummary {
    pub state: ReviewState,
    /// Clean agent reviews of the current change.
    pub done: Count,
    /// Agent reviews it needs before it can merge: 1 for a PR fleetd lands, else 0.
    pub needed: Count,
}

/// Who wrote the PR: fleetd's agent when one did, and the GitHub account it was opened from.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrAuthor {
    /// The writing agent's lane in the agents view.
    pub lane_id: Option<LaneId>,
    pub task_id: Option<TaskId>,
    pub role: Option<AgentRole>,
    /// The agent's task title.
    pub title: Option<Text<0, 80>>,
    pub profile: Option<TaskProfile>,
    /// Its session, for `agent_work`.
    pub thread_ref: Option<ThreadRef>,
    /// GitHub login; absent when GitHub wasn't reached.
    pub login: Option<Text<1, 100>>,
}

/// Where the PR stands in fleetd's merge queue. Absent from a PR fleetd doesn't land.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrQueue {
    pub change_id: ChangeId,
    pub state: ChangeState,
    /// 0-based place in the queue; absent when not waiting in it.
    pub position: Option<Count>,
    /// PRs waiting in the same queue.
    pub length: Count,
    /// Why it is held or was sent back: a conflict, failing check names, or the refusal's fix.
    pub reason: Option<Text<0, 2000>>,
}

/// One PR as the list shows it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrRow {
    pub repo: GitHubRepo,
    pub number: Positive,
    pub url: GitHubPrUrl,
    /// GitHub's title; the writing agent's task title when GitHub wasn't reached.
    pub title: Text<0, 300>,
    pub state: PrState,
    /// Absent when GitHub wasn't reached.
    pub checks: Option<ChecksSummary>,
    pub review: ReviewSummary,
    pub queue: Option<PrQueue>,
    pub author: PrAuthor,
    /// Its head branch.
    pub branch: Option<NonEmpty>,
    /// The work it belongs to, when fleetd's agents wrote it.
    pub workstream_id: Option<WorkstreamId>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub merged_at: Option<Timestamp>,
}

/// One check run or commit status on the head. fleetd's own merge statuses are left out: `queue` says the same.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: Text<1, 200>,
    pub state: ChecksState,
    /// GitHub's conclusion as given, lowercased ("success", "failure", "skipped", "timed_out"…).
    pub conclusion: Option<Text<1, 40>>,
    pub url: Option<Text<1, 2000>>,
    pub started_at: Option<Timestamp>,
    pub completed_at: Option<Timestamp>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum ReviewVerdictKind {
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
}

/// One review: an agent's verdict with its findings, or a person's review on GitHub.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewEntry {
    pub verdict: ReviewVerdictKind,
    /// The reviewing agent (reviewer or QA); absent for a person's review.
    pub agent: Option<PrAuthor>,
    /// GitHub login of a person's review.
    pub login: Option<Text<1, 100>>,
    /// Findings that must be fixed before merging; agent reviews only.
    pub blocking: Option<Count>,
    pub non_blocking: Option<Count>,
    /// The agent's findings, or the person's review text. Secrets are replaced by `[secret]`.
    pub text: Text<0, 2000>,
    /// It reviewed the PR's current change (an agent review stays current across a rebase that changes nothing).
    pub current: bool,
    pub at: Timestamp,
}

/// One move of the PR through the merge queue.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrQueueStep {
    pub at: Timestamp,
    pub from: ChangeState,
    pub to: ChangeState,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrLinks {
    pub pr: GitHubPrUrl,
    pub files: Text<1, 2000>,
    pub checks: Text<1, 2000>,
    /// The squash commit on the base, once merged.
    pub merge_commit: Option<Text<1, 2000>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum PrFileStatus {
    Added,
    Modified,
    Removed,
    Renamed,
    Copied,
    Changed,
    Unchanged,
}

/// One changed file.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    /// Repo-relative; the new path of a rename.
    pub path: Text<1, 1000>,
    /// A rename's old path.
    pub previous_path: Option<Text<1, 1000>>,
    pub status: PrFileStatus,
    pub additions: Count,
    pub deletions: Count,
    /// Lines `pr_diff` pages through; absent when GitHub shows no diff for it (binary, or too large).
    pub diff_lines: Option<Count>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum DiffLineKind {
    /// A hunk header ("@@ -12,7 +12,9 @@ fn main"); `text` is its trailing context.
    Hunk,
    Context,
    Add,
    Del,
}

/// One line of a file's diff. Secrets are replaced by `[secret]`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    /// Without the leading "+", "-" or " ".
    pub text: Text<0, PR_DIFF_LINE_MAX>,
    /// Line number in the old file (context and deleted lines; a hunk's start).
    pub old: Option<Count>,
    /// Line number in the new file (context and added lines; a hunk's start).
    pub new: Option<Count>,
    /// The line was longer than `PR_DIFF_LINE_MAX` and is cut.
    pub cut: Option<bool>,
}
