//! Node sessions: how the hub drives the agent sessions that `fleetd node` runs itself, over the existing node link.
//!
//! The hub sends [`SessionCallFrame`]s; the node answers each with exactly one [`SessionReplyFrame`] carrying the same
//! `id`. Two streams flow back without being asked for, once the hub has subscribed:
//! - [`MachineEventFrame`]: projects and session summaries for the whole machine, numbered by `seq` so the hub can
//!   resume after its stored cursor and miss nothing while it was away.
//! - [`ThreadEventFrame`]: messages, items, runs and live text deltas, only for sessions the hub follows. Deltas are
//!   never stored or replayed.
//!
//! A session's id is the thread id the rest of fleetd already uses. The runner maps it onto its own conversation (the
//! claude runner passes it as `--session-id` and resumes with `--resume <id>`), so a session survives a node restart.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_with::skip_serializing_none;

use crate::effort::{Effort, TaskProfile};
use crate::ids::{ProjectId, ThreadId, Timestamp};
use crate::model::RuntimeMode;
use crate::prim::{Count, Int, NonEmpty, Text};
use crate::steer::{SteerReceipt, SteerTag};

/// Which agent runtime runs a session. Each has its own adapter on the node; nothing else tells them apart.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunnerKind {
    #[default]
    Claude,
}

/// Where a session works.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionWorkspace {
    /// The project's workspace root (leads).
    Root,
    /// A new git worktree on a new branch, one per writer, created by the node with `git worktree add`.
    #[serde(rename_all = "camelCase")]
    Worktree {
        base_ref: NonEmpty,
        branch: NonEmpty,
        /// A session of the same branch this one takes over: it works in that session's worktree (rebuilt when it is
        /// gone), uncommitted changes included, instead of a new one. Older nodes ignore it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_session: Option<ThreadId>,
    },
    /// A detached git worktree of its own, for a read or review task, so it never works in the human's checkout:
    /// at a fresh fetch of the remote's `baseRef`, or at the head of `pr` (a review's) when the remote publishes PR
    /// refs. `stop{removeWorktree}` removes it; a resume makes it again at the same commit.
    #[serde(rename_all = "camelCase")]
    Detached {
        base_ref: NonEmpty,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pr: Option<NonEmpty>,
    },
}

/// Hub -> node: start a session and its first run. Idempotent on `session_id`: a retry returns the existing session.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionLaunch {
    /// Minted by the hub (a UUID), used as the thread id and the runner's conversation id.
    pub session_id: ThreadId,
    pub project_id: ProjectId,
    pub title: Option<String>,
    #[serde(default)]
    pub runner: RunnerKind,
    /// The node's runner picks the model and effort it runs on. Absent from a hub before profiles, which sends
    /// `model` and `effort` instead.
    pub profile: Option<TaskProfile>,
    /// A hub before profiles only: the runner reads its profile off these.
    pub model: Option<NonEmpty>,
    pub effort: Option<Effort>,
    pub runtime_mode: RuntimeMode,
    pub workspace: SessionWorkspace,
    /// The first user message.
    pub prompt: NonEmpty,
    /// Minted by the hub (a UUID); the first run's id.
    pub run_id: NonEmpty,
    /// `--allowedTools` rules from the project's policy (`tools.allow`), in claude's own syntax: these never prompt.
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    /// `--disallowedTools` rules from the project's policy (`tools.deny`), on top of the tools fleetd always denies.
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    /// Which fleetd management tools the session's MCP server offers.
    #[serde(default)]
    pub role: SessionRole,
}

/// A session's place among fleetd's agents, which decides the MCP tools it gets. The hub enforces the same split on
/// every call (`hub/tasks/policy.rs`); the tool list only keeps a worker from seeing tools it can't use.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionRole {
    /// A thread a person started (`thread_start`): no fleetd tools.
    #[default]
    Plain,
    /// A project's lead: spawns, steers and stops agents, asks, decides, plans.
    Lead,
    /// A task's agent: reports and asks its lead.
    Worker,
}

impl SessionRole {
    /// `fleetd agent-mcp --role <this>`; none for a plain thread.
    pub fn cli_arg(self) -> Option<&'static str> {
        match self {
            SessionRole::Plain => None,
            SessionRole::Lead => Some("lead"),
            SessionRole::Worker => Some("worker"),
        }
    }
}

/// A person's or policy's answer to a tool permission prompt.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "behavior", rename_all = "snake_case")]
pub enum PermissionDecision {
    #[serde(rename_all = "camelCase")]
    Allow {
        updated_input: Option<Value>,
    },
    Deny {
        message: Text<1, 2000>,
    },
}

/// Hub -> node operations: add and remove projects; launch, send to, interrupt, stop and answer sessions; subscribe to
/// and follow their streams; read items, files, default branches and changes; and the runner's state (see
/// docs/build/native-runner-spec.md §5).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum SessionCall {
    /// Register or rename a project rooted at a directory on this machine.
    #[serde(rename_all = "camelCase")]
    ProjectUpsert {
        project_id: ProjectId,
        title: NonEmpty,
        workspace_root: NonEmpty,
    },
    #[serde(rename_all = "camelCase")]
    ProjectRemove {
        project_id: ProjectId,
    },
    Launch(SessionLaunch),
    /// A new run with this user message. `plain`: taken in at the running turn's next tool boundary, or now if it is
    /// idle. Steers use `boundary` or `now` (see [`SendMode`]); an older node ignores `mode` and sends plainly.
    #[serde(rename_all = "camelCase")]
    Send {
        session_id: ThreadId,
        run_id: NonEmpty,
        text: NonEmpty,
        #[serde(default, skip_serializing_if = "SendMode::is_plain")]
        mode: SendMode,
        /// Set when the send is a steer: the node reports its receipts as `MachineEvent::Steer`.
        steer: Option<SteerTag>,
    },
    /// Withdraw a send claude still holds queued (`cancel_async_message`). A no-op once it has started.
    #[serde(rename_all = "camelCase")]
    Withdraw {
        session_id: ThreadId,
        run_id: NonEmpty,
    },
    /// Interrupt the active run (or `run_id` when it is still the active one).
    #[serde(rename_all = "camelCase")]
    Interrupt {
        session_id: ThreadId,
        run_id: Option<NonEmpty>,
        reason: Option<String>,
    },
    /// End the session's process; the session stays resumable. `removeWorktree` also deletes its worktree (a
    /// writer's only once nothing would be lost; a detached one always), and does nothing while a run is active: a
    /// message that came first keeps the session at work.
    #[serde(rename_all = "camelCase")]
    Stop {
        session_id: ThreadId,
        #[serde(default)]
        remove_worktree: bool,
    },
    #[serde(rename_all = "camelCase")]
    Answer {
        session_id: ThreadId,
        request_id: NonEmpty,
        decision: PermissionDecision,
        /// Who decided, for the time inspector; an older hub sends none.
        by: Option<crate::time::DecidedBy>,
    },
    /// Start (or restart) the machine stream after `after`; none means from a fresh snapshot. `spansAfter` asks for
    /// the node's time spans after that outbox row; a node sends spans only when it is present.
    #[serde(rename_all = "camelCase")]
    Subscribe {
        after: Option<u64>,
        #[serde(default)]
        spans_after: Option<u64>,
    },
    /// Start the thread stream for one session: a bounded snapshot, then live events.
    #[serde(rename_all = "camelCase")]
    Follow {
        session_id: ThreadId,
    },
    #[serde(rename_all = "camelCase")]
    Release {
        session_id: ThreadId,
    },
    /// The items and messages around one item, oldest first, from the node's own log (for "click to transcript").
    #[serde(rename_all = "camelCase")]
    Window {
        session_id: ThreadId,
        item_id: NonEmpty,
        before: Int<0, 25>,
        after: Int<0, 25>,
    },
    /// The full output of one item whose snapshot copy was cut (`outputOmitted`).
    #[serde(rename_all = "camelCase")]
    ReadItem {
        session_id: ThreadId,
        item_id: NonEmpty,
    },
    /// A file under the project's workspace root; `None` in the reply when it does not exist.
    #[serde(rename_all = "camelCase")]
    ReadFile {
        project_id: ProjectId,
        path: NonEmpty,
    },
    #[serde(rename_all = "camelCase")]
    DefaultBranch {
        project_id: ProjectId,
    },
    /// What a session changed: its branch, worktree and the paths it touched against its base.
    #[serde(rename_all = "camelCase")]
    Changes {
        session_id: ThreadId,
    },
    /// The runner's version, login and conformance, for the doctor and the usage area.
    RunnerInfo,
    /// Files of the project (`git ls-files -co --exclude-standard`, cached 30 s), best fuzzy match of `query` first.
    #[serde(rename_all = "camelCase")]
    ListFiles {
        project_id: ProjectId,
        #[serde(default)]
        query: Text<0, 200>,
        limit: Int<1, 50>,
    },
    /// Git checkouts under the home directory's usual source dirs, at most two levels down, and where a clone goes.
    RepoScan,
    /// What is at `path`: whether it exists and is a checkout, its remote, default branch and workflow files.
    #[serde(rename_all = "camelCase")]
    RepoInspect {
        path: NonEmpty,
    },
    /// Clone `url` into `dest` (which must not exist), through gh when it is logged in here, else git. The node
    /// sends `clone_progress` frames for `addId` meanwhile and answers when the clone ends.
    #[serde(rename_all = "camelCase")]
    RepoClone {
        add_id: NonEmpty,
        url: NonEmpty,
        dest: NonEmpty,
    },
    /// `gh repo list` for the logged-in user and their orgs, run on this machine.
    GhRepoList,
    /// The project's default branch `branch` as git alone records it, for a repo whose host fleetd can't read: fetched
    /// from its remote first, then its first-parent line newest first, back to `stopAt` when that is still on it, else
    /// to commits made since `sinceMs` (epoch ms). Only nodes listing [`crate::node_link::CAP_LANDED_LOG`] get it.
    #[serde(rename_all = "camelCase")]
    LandedLog {
        project_id: ProjectId,
        branch: NonEmpty,
        since_ms: Count,
        stop_at: Option<NonEmpty>,
    },
    /// Write a file under the project's workspace root, creating its directories. `rel_path` must stay inside
    /// `.fleetd/attachments/`, which the node keeps out of git through `.git/info/exclude`.
    #[serde(rename_all = "camelCase")]
    PutFile {
        project_id: ProjectId,
        rel_path: NonEmpty,
        data_b64: NonEmpty,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionCallFrame {
    pub id: NonEmpty,
    pub call: SessionCall,
}

/// How a `SessionError`'s message starts when the node won't resume the session: claude's conversation is gone, or
/// was kept under another claude config dir. Its thread can't go on; a new one has to take over. A prefix, not a code,
/// so hubs that don't know it still read the error.
pub const RESUME_REFUSED: &str = "the session can't resume: ";

/// Why a call failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionErrorCode {
    NotFound,
    Invalid,
    /// The runner is not usable on this machine (missing binary, unsupported version, not logged in).
    RunnerUnavailable,
    /// git refused (worktree exists, bad ref).
    Git,
    Internal,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionError {
    pub code: SessionErrorCode,
    pub message: Text<1, 2000>,
    pub fix: Option<String>,
}

/// How a send reaches a session whose turn is running.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SendMode {
    /// Today's send (wakes, nudges): no priority, claude may join it to the running turn.
    #[default]
    Plain,
    /// `priority: "now"`: the running turn ends at its next tool boundary (the tool's result kept) and this message
    /// gets its own turn.
    Boundary,
    /// Stop the running step and deliver at once (`interrupt` with `send_now`, or its fallbacks).
    Now,
}

impl SendMode {
    pub fn is_plain(&self) -> bool {
        *self == Self::Plain
    }
}

/// claude's answer to a `send_now` interrupt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SendNow {
    /// The running step was stopped and the message starts now.
    Stopped,
    /// The CLI is delivering it without a stop (it backgrounded what the turn waited on).
    Delivering,
    /// Nothing was queued to send now (it had already started, or the session was idle).
    NothingWaiting,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SendAccepted {
    pub run_id: NonEmpty,
    /// True when it waits behind an active run.
    pub queued: bool,
    /// Mode `now` while a run was active: what claude did.
    pub send_now: Option<SendNow>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionChanges {
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    /// Repo-relative, sorted, unique: committed since the base plus uncommitted.
    pub paths: Vec<String>,
}

/// One session's bounded window: what `thread_tail` and `actions_list` read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub summary: SessionSummary,
    pub messages: Vec<ThreadMessage>,
    pub items: Vec<ThreadItem>,
    pub runs: Vec<RunInfo>,
    /// Older entries exist beyond this window.
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LoginStatus {
    LoggedIn,
    LoggedOut,
    Unknown,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunnerInfo {
    pub runner: RunnerKind,
    /// As the runner's CLI prints it; absent when the binary is missing.
    pub version: Option<String>,
    /// The range this fleetd supports, e.g. ">=2.1.300, <2.2.0".
    pub supported: String,
    /// Inside `supported`. Outside it sessions still run; the doctor warns.
    pub version_ok: bool,
    pub login: LoginStatus,
    /// The runner's own word for the login, e.g. claude's "subscription", "api_key", "token" or "none".
    pub login_kind: Option<String>,
    /// The last zero-cost conformance probe passed against the installed binary.
    pub conformance_ok: Option<bool>,
    pub problem: Option<String>,
    /// A person's name for the login: "Max", "API key", "gateway token", ….
    pub login_label: Option<String>,
    /// The proxy or gateway sessions go through, when it is not the provider's own endpoint.
    pub proxy: Option<String>,
    /// Where `proxy` is set, e.g. "~/.claude/settings.json".
    pub proxy_source: Option<String>,
    /// The runner's config dir sessions use, when it has one: the user's own unless the machine was given another.
    pub config_dir: Option<String>,
}

/// Why a worktree's base may be behind its remote's default branch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BaseErrorKind {
    /// The remote can't be reached, or didn't answer in time.
    Offline,
    /// The remote refused git's credentials; the agent's pushes will fail the same way.
    Auth,
    /// The remote says there is no such repository: a wrong URL or name, or credentials that can't see it.
    NoAccess,
    /// git can't run ssh on the machine: it isn't installed. The doctor shows it; no attention item.
    NoSsh,
    /// The remote answered but names no default branch: its HEAD points at a branch it doesn't have.
    NoDefaultBranch,
    /// The project has no remote: the base is a local branch.
    NoRemote,
    /// Any other fetch failure.
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BaseError {
    pub kind: BaseErrorKind,
    /// git's first line, e.g. "fatal: Authentication failed for 'https://github.com/a/b.git/'"; "offline".
    pub message: String,
}

/// Where a writer's worktree branch started: the remote's default branch, freshly fetched unless `error` says why not.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBase {
    /// "origin/main"; a local branch when there is no remote, or no copy of the remote's.
    #[serde(rename = "ref")]
    pub base_ref: String,
    pub sha: String,
    /// When `ref` was last fetched: by this start, else by the one whose copy it fell back to. Absent for a local
    /// branch, or when git can't tell.
    pub fetched_at: Option<Timestamp>,
    pub error: Option<BaseError>,
    /// A fork (an `upstream` remote beside it) only: the commits upstream's default branch has that `ref` lacks, as
    /// last fetched.
    pub fork_behind: Option<u32>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionOutput {
    Done,
    Launched {
        summary: SessionSummary,
        /// Where a new worktree's branch started; absent for a session in the project root, from an older node, or
        /// on a retried launch.
        base: Option<WorktreeBase>,
    },
    Sent(SendAccepted),
    Snapshot(ThreadSnapshot),
    Item {
        item: ThreadItem,
    },
    File {
        contents: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    DefaultBranch {
        branch: Option<String>,
    },
    Changes(SessionChanges),
    RunnerInfo(RunnerInfo),
    /// Answer to `window`: items and messages in log order; `focus` is the index of the asked item, absent when the
    /// node no longer has it.
    Window {
        entries: Vec<WindowEntry>,
        focus: Option<u64>,
    },
    /// Answer to `withdraw`: whether claude dropped it.
    Withdrawn {
        cancelled: bool,
    },
    /// Answer to `list_files`: repo-relative paths.
    Files {
        paths: Vec<String>,
        truncated: bool,
    },
    /// Answer to `repo_scan`.
    #[serde(rename_all = "camelCase")]
    Repos {
        clone_root: String,
        repos: Vec<ScannedRepo>,
    },
    /// Answer to `repo_inspect`, and to `repo_clone` for the new checkout.
    RepoFacts(RepoFacts),
    /// Answer to `gh_repo_list`.
    GhRepos(GhRepos),
    /// Answer to `landed_log`.
    LandedLog(LandedLog),
}

/// The default branch's first-parent line, newest first, at most [`LandedLog::MAX`] commits.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LandedLog {
    /// What was read: "origin/main", or the local branch when there is no remote copy of it.
    pub read: String,
    /// Why the fetch before the read failed: the log is as of the last good fetch.
    pub fetch_failed: Option<String>,
    pub commits: Vec<GitCommit>,
}

impl LandedLog {
    pub const MAX: usize = 5000;
}

/// One commit on the default branch's own line.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub sha: String,
    /// Two or more for a merge commit.
    pub parents: Vec<String>,
    /// Committer time, epoch ms: when it reached the branch.
    pub at_ms: i64,
    pub author_name: String,
    pub subject: String,
    /// The values of its own `Fleetd-Change` trailers, in order: the train's squash names each Change it landed.
    #[serde(default)]
    pub changes: Vec<String>,
    /// The values of its own `Fleetd-Task` trailers: an agent's commit, or a squash that kept their messages.
    #[serde(default)]
    pub tasks: Vec<String>,
    /// A merge commit's: the `Fleetd-Task` trailers of the commits it brought in.
    #[serde(default)]
    pub merged_tasks: Vec<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScannedRepo {
    pub path: String,
    /// The origin URL as configured (else the first remote's).
    pub remote: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepoFacts {
    pub exists: bool,
    pub is_git: bool,
    pub remote: Option<String>,
    /// `origin/HEAD`, else the current branch.
    pub default_branch: Option<String>,
    /// File names under `.github/workflows`.
    #[serde(default)]
    pub workflow_files: Vec<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GhRepos {
    pub owners: Vec<String>,
    pub repos: Vec<GhRepo>,
    /// Set when gh is missing or logged out here.
    pub problem: Option<String>,
}

/// One `gh repo list --json` row.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GhRepo {
    pub name_with_owner: String,
    pub url: String,
    #[serde(default)]
    pub is_private: bool,
    pub description: Option<String>,
    pub pushed_at: Option<String>,
}

/// Node -> hub while a `repo_clone` runs: git's progress for one clone, at most one frame per 250 ms.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgressFrame {
    pub add_id: NonEmpty,
    pub phase: crate::projects::ClonePhase,
    pub percent: Option<Int<0, 100>>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WindowEntry {
    Item(ThreadItem),
    Message(ThreadMessage),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum SessionResult {
    Ok(SessionOutput),
    Err(SessionError),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionReplyFrame {
    pub id: NonEmpty,
    pub result: SessionResult,
}

/// fleetd's failure taxonomy for a run. The hub maps these onto its existing limit, park and doctor paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    /// A plan limit with a reset time: park and continue at the reset.
    UsageLimit,
    /// A short request-rate limit (429 without a plan reset): park briefly.
    RateLimit,
    /// No account or provider behind a gateway can serve the model.
    PoolExhausted,
    /// Not logged in, or the login expired: needs the runner's login on the machine. Never retried.
    Auth,
    /// 529 or 5xx after the runner's own retries.
    Overloaded,
    /// No HTTP response after the runner's own retries.
    Network,
    /// The request itself is wrong (bad model, prompt too long). Never retried.
    InvalidRequest,
    /// The agent's process exited or was killed outside an interrupt.
    ProcessExited,
    Other,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunFailure {
    pub class: FailureClass,
    /// The runner's own text (its result or error), then the tail of its stderr. Never rewritten.
    pub message: Text<1, 4000>,
    pub api_status: Option<u16>,
    /// UsageLimit and RateLimit: when to continue.
    pub reset_at: Option<Timestamp>,
    /// How many times the node retried the run before giving up (Overloaded, Network).
    #[serde(default)]
    pub retries: u32,
    /// PoolExhausted: the model the gateway has no account for, as the runner read it off the error.
    pub model: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Starting,
    Running,
    /// Blocked on a permission answer.
    Waiting,
    Completed,
    Failed,
    Interrupted,
}

impl RunStatus {
    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Starting | Self::Running | Self::Waiting
        )
    }
}

/// Why a run ended, so a node going away reads apart from a person stopping it. Set once the run is no longer active.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum RunEnd {
    /// The agent finished the turn.
    Completed,
    /// Someone interrupted or stopped it: `RunInfo.endedBy` says who.
    Requested,
    /// A steer cut it short at a tool boundary to take its own turn (`RunInfo.supersededBy`). Not a failure.
    Superseded,
    /// The node was stopping (SIGTERM) and cut it.
    NodeStopping,
    /// The node found it active on start: it died with the node process (crash, SIGKILL, power loss).
    NodeRestarted,
    /// The machine slept and the agent's stream did not come back.
    MachineSlept,
    /// The agent's process exited or was killed with nobody asking; `failure` has the exit code or signal.
    Exited,
    /// A usage, rate or pool limit; `failure.resetAt` says when to continue.
    Limited,
    /// The conversation no longer fits in the model's context.
    ContextFull,
    /// Any other failure; `failure.class` says which.
    Failed,
    /// Set by the hub, never by a node: the watchdog saw no output for too long and ended the run.
    Stalled,
    /// A cause this build doesn't know (a newer node or hub). Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
/// A run's tokens, the same for every provider: each runner maps its own usage onto these. `input_tokens` counts
/// only the input no cache served or stored, so the four token counts add up to everything the model was sent and
/// wrote. A provider that reports cached tokens inside its prompt tokens has them taken out of `input_tokens`; one
/// that bills no cache writes reports 0 for them. The wire names stay those the first runner used.
pub struct RunUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Input served from the provider's prompt cache.
    #[serde(rename = "cacheReadInputTokens")]
    pub cache_read_tokens: u64,
    /// Input written to the provider's prompt cache, at whatever lifetime.
    #[serde(rename = "cacheCreationInputTokens")]
    pub cache_write_tokens: u64,
    /// The runner's own estimate, when its CLI reports one; not a bill.
    pub cost_usd: Option<f64>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub id: NonEmpty,
    pub status: RunStatus,
    /// 1-based position in the session.
    pub ordinal: u64,
    /// When the send reached the node; absent on runs an older node recorded.
    pub queued_at: Option<Timestamp>,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
    pub failure: Option<RunFailure>,
    pub usage: Option<RunUsage>,
    /// A steer (`boundary` or `now`) cut this run short at a tool boundary: its status is `interrupted`, but it is
    /// not a failure. The steer's run id.
    pub superseded_by: Option<NonEmpty>,
    /// Why it ended; absent while it is active and on runs an older node recorded.
    pub end: Option<RunEnd>,
    /// `end: requested`: the reason the interrupt or stop was sent with (`watchdog`, `stopped`, …).
    pub ended_by: Option<Text<1, 200>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// No active run.
    Idle,
    Running,
    /// A permission prompt waits for an answer.
    Waiting,
    /// The last run failed.
    Failed,
    /// The last run was interrupted.
    Interrupted,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermission {
    pub request_id: NonEmpty,
    pub tool_name: NonEmpty,
    /// One line for a person: the command, the path, or the tool's own description.
    pub summary: Text<0, 2000>,
}

/// One session's row on the machine stream: what the hub's shell mapper turns into a ThreadSummary.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: ThreadId,
    pub project_id: ProjectId,
    pub title: String,
    pub status: SessionStatus,
    pub model: String,
    pub effort: Effort,
    pub runtime_mode: RuntimeMode,
    pub latest_run: Option<RunInfo>,
    /// Set while a run is queued, starting, running or waiting.
    pub active_run_id: Option<NonEmpty>,
    pub pending_permission: Option<PendingPermission>,
    /// The last assistant text, cut to its last 2000 characters.
    pub latest_assistant_tail: Option<String>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    /// What the node rebuilt the worktree from the last time it was gone. Absent while it never was.
    pub recreated_from: Option<WorktreeSource>,
    /// When it did, so each rebuild is told apart from the last, even from the same source. Absent from older nodes.
    pub recreated_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Where a lost worktree came back from, best first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum WorktreeSource {
    /// The local branch: its commits are back, uncommitted changes are gone.
    Local,
    /// `<remote>/<branch>`, freshly fetched: what was pushed is back, unpushed commits and uncommitted changes are gone.
    Remote,
    /// Nothing of the branch was left, here or on a remote: a new branch from the base, as for a new task.
    Base,
    /// A source this build doesn't know (a newer node). Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub project_id: ProjectId,
    pub title: String,
    pub workspace_root: String,
    pub updated_at: Timestamp,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum MachineEvent {
    /// Everything current: replaces the hub's view of this machine. Sent when `after` is absent or older than the
    /// node keeps.
    Snapshot {
        projects: Vec<ProjectInfo>,
        sessions: Vec<SessionSummary>,
    },
    ProjectUpserted(ProjectInfo),
    #[serde(rename_all = "camelCase")]
    ProjectRemoved {
        project_id: ProjectId,
    },
    SessionUpdated(SessionSummary),
    /// The runner's state changed: a probe (at start, every 6 h), a login that expired, or one that came back.
    RunnerInfo(RunnerInfo),
    /// A steer's receipt moved (delivered, acknowledged, unacknowledged, withdrawn, failed).
    Steer(SteerReceipt),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MachineEventFrame {
    pub seq: u64,
    pub at: Timestamp,
    pub event: MachineEvent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub id: NonEmpty,
    pub run_id: Option<NonEmpty>,
    pub role: MessageRole,
    pub text: String,
    pub created_at: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// What a run did, one tool call or event per item. Outputs over 8 KB are cut to their tail with `outputOmitted`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ItemKind {
    /// Bash.
    #[serde(rename_all = "camelCase")]
    Command {
        command: String,
        /// The timeout the call states, in ms.
        timeout_ms: Option<u64>,
        output: Option<String>,
        #[serde(default)]
        output_omitted: bool,
        exit_code: Option<i64>,
    },
    /// Edit, Write, NotebookEdit.
    #[serde(rename_all = "camelCase")]
    FileChange {
        tool_name: String,
        path: String,
    },
    /// Any other tool, MCP tools included. `tool_name` is the runner's own name for it; `class` says what it does.
    #[serde(rename_all = "camelCase")]
    Tool {
        tool_name: String,
        input: Value,
        output: Option<String>,
        #[serde(default)]
        output_omitted: bool,
        /// Absent for a tool fleetd has no word for, and from older nodes.
        class: Option<ToolClass>,
    },
    /// A permission prompt (`can_use_tool`) and how it was answered.
    #[serde(rename_all = "camelCase")]
    Permission {
        request_id: String,
        tool_name: String,
        summary: String,
        decision: Option<PermissionDecision>,
    },
    /// Context compaction (`compact_boundary`).
    #[serde(rename_all = "camelCase")]
    Compaction {
        trigger: String,
        pre_tokens: Option<u64>,
        post_tokens: Option<u64>,
    },
    /// The runner retrying an API call itself (claude's `api_retry`).
    #[serde(rename_all = "camelCase")]
    ApiRetry {
        attempt: u32,
        max_retries: u32,
        error_status: Option<u16>,
        error: String,
        /// The wait the runner announced before retrying.
        retry_delay_ms: Option<u64>,
    },
    /// The node continuing a run itself after the runner's own retries gave up (Overloaded, Network): `attempt` of
    /// `of`, sent after `delay_ms`, because of `reason`.
    #[serde(rename_all = "camelCase")]
    NodeRetry {
        attempt: u32,
        of: u32,
        delay_ms: u64,
        reason: RunFailure,
    },
    Error {
        failure: RunFailure,
    },
}

/// What a tool call does, in fleetd's words: the runner maps its own tools onto these, so nothing past it reads a tool
/// name.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolClass {
    /// Reads a file.
    Read { path: Option<String> },
    /// Searches files by name or content.
    Search { pattern: Option<String> },
    /// Fetches a page or searches the web.
    Web {
        url: Option<String>,
        query: Option<String>,
    },
    /// Keeps the agent's own todo list.
    Plan,
    /// Calls a tool of an MCP server; fleetd's own is `fleetd`.
    Mcp { server: String, tool: String },
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadItem {
    /// The tool_use id, or a node-minted id for non-tool items.
    pub id: NonEmpty,
    pub run_id: Option<NonEmpty>,
    pub status: ItemStatus,
    pub title: String,
    pub started_at: Timestamp,
    pub completed_at: Option<Timestamp>,
    pub updated_at: Timestamp,
    pub kind: ItemKind,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum ThreadEvent {
    /// First frame after `follow`, and again whenever the node can't replay what the hub missed.
    Snapshot(ThreadSnapshot),
    Message(ThreadMessage),
    Item(ThreadItem),
    Run(RunInfo),
    /// Live assistant text, coalesced to at most one frame per 100 ms per session. Not stored, not replayed: the
    /// complete `message` follows.
    #[serde(rename_all = "camelCase")]
    Delta {
        message_id: NonEmpty,
        run_id: Option<NonEmpty>,
        append: String,
    },
    /// The active run's usage so far, cumulative, at most once a second per followed session. Not stored, not
    /// replayed: the run's final usage arrives on its `run` event.
    #[serde(rename_all = "camelCase")]
    Usage {
        run_id: NonEmpty,
        usage: RunUsage,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventFrame {
    pub session_id: ThreadId,
    pub at: Timestamp,
    pub event: ThreadEvent,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_is_either_an_output_or_an_error() {
        let ok = r#"{"id":"c1","result":{"ok":{"kind":"sent","runId":"r2","queued":false}}}"#;
        assert!(serde_json::from_str::<SessionReplyFrame>(ok).is_ok());
        let err = r#"{"id":"c1","result":{"err":{"code":"runner_unavailable","message":"claude is not logged in"}}}"#;
        assert!(serde_json::from_str::<SessionReplyFrame>(err).is_ok());
    }
}
