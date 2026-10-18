//! Node sessions: how the hub drives Claude sessions that `fleetd node` runs itself, over the existing node link.
//!
//! The hub sends [`SessionCallFrame`]s; the node answers each with exactly one [`SessionReplyFrame`] carrying the same
//! `id`. Two streams flow back without being asked for, once the hub has subscribed:
//! - [`MachineEventFrame`]: projects and session summaries for the whole machine, numbered by `seq` so the hub can
//!   resume after its stored cursor (the shell stream T3 used to provide).
//! - [`ThreadEventFrame`]: messages, items, runs and live text deltas, only for sessions the hub follows (the thread
//!   stream T3 used to provide). Deltas are never stored or replayed.
//!
//! A session's id is the thread id the rest of fleetd already uses, and also the `claude --session-id`, so a session
//! survives a node restart through `claude --resume <id>` in the same cwd and config dir.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_with::skip_serializing_none;

use crate::effort::Effort;
use crate::ids::{ProjectId, ThreadId, Timestamp};
use crate::model::RuntimeMode;
use crate::prim::{NonEmpty, Text};

/// Which agent runtime runs a session. Codex comes later as its own adapter.
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
    /// The project's workspace root (leads, read-only tasks).
    Root,
    /// A new git worktree on a new branch, one per writer, created by the node with `git worktree add`.
    #[serde(rename_all = "camelCase")]
    Worktree {
        base_ref: NonEmpty,
        branch: NonEmpty,
    },
}

/// Hub -> node: start a session and its first run. Idempotent on `session_id`: a retry returns the existing session.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionLaunch {
    /// Minted by the hub (a UUID), used as the thread id and the claude session id.
    pub session_id: ThreadId,
    pub project_id: ProjectId,
    pub title: Option<String>,
    #[serde(default)]
    pub runner: RunnerKind,
    pub model: NonEmpty,
    pub effort: Effort,
    pub runtime_mode: RuntimeMode,
    pub workspace: SessionWorkspace,
    /// The first user message.
    pub prompt: NonEmpty,
    /// Minted by the hub (a UUID); the first run's id and the claude user-message uuid.
    pub run_id: NonEmpty,
    /// `--allowedTools` rules from the project's policy (`tools.allow`), in claude's own syntax: these never prompt.
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    /// `--disallowedTools` rules from the project's policy (`tools.deny`), on top of the tools fleetd always denies.
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
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

/// Hub -> node operations. Each maps one T3 RPC fleetd used before (see docs/build/native-runner-spec.md §5).
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
    /// A new run with this user message; queued behind an active run.
    #[serde(rename_all = "camelCase")]
    Send {
        session_id: ThreadId,
        run_id: NonEmpty,
        text: NonEmpty,
    },
    /// Interrupt the active run (or `run_id` when it is still the active one).
    #[serde(rename_all = "camelCase")]
    Interrupt {
        session_id: ThreadId,
        run_id: Option<NonEmpty>,
        reason: Option<String>,
    },
    /// End the session's process; the session stays resumable. `removeWorktree` also deletes its worktree.
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
    },
    /// Start (or restart) the machine stream after `after`; none means from a fresh snapshot.
    Subscribe {
        after: Option<u64>,
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionCallFrame {
    pub id: NonEmpty,
    pub call: SessionCall,
}

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

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SendAccepted {
    pub run_id: NonEmpty,
    /// True when it waits behind an active run.
    pub queued: bool,
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
    /// As `claude --version` prints it; absent when the binary is missing.
    pub version: Option<String>,
    /// The range this fleetd supports, e.g. ">=2.1.300, <2.2.0".
    pub supported: String,
    pub version_ok: bool,
    pub login: LoginStatus,
    /// "subscription", "api_key", "token" (an ANTHROPIC_AUTH_TOKEN gateway) or "none".
    pub login_kind: Option<String>,
    /// The last zero-cost conformance probe passed against the installed binary.
    pub conformance_ok: Option<bool>,
    pub problem: Option<String>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionOutput {
    Done,
    Launched {
        summary: SessionSummary,
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
    /// Not logged in, or the login expired: needs `claude /login` on the machine. Never retried.
    Auth,
    /// 529 or 5xx after claude's own retries.
    Overloaded,
    /// No HTTP response after claude's own retries.
    Network,
    /// The request itself is wrong (bad model, prompt too long). Never retried.
    InvalidRequest,
    /// claude exited or was killed outside an interrupt.
    ProcessExited,
    Other,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunFailure {
    pub class: FailureClass,
    /// claude's own text (its result or assistant error), then the tail of its stderr. Never rewritten.
    pub message: Text<1, 4000>,
    pub api_status: Option<u16>,
    /// UsageLimit and RateLimit: when to continue.
    pub reset_at: Option<Timestamp>,
    /// How many times the node retried the run before giving up (Overloaded, Network).
    #[serde(default)]
    pub retries: u32,
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

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    /// claude's own estimate from the result message; not a bill.
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
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
    pub failure: Option<RunFailure>,
    pub usage: Option<RunUsage>,
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
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
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
    /// Any other tool, MCP tools included.
    #[serde(rename_all = "camelCase")]
    Tool {
        tool_name: String,
        input: Value,
        output: Option<String>,
        #[serde(default)]
        output_omitted: bool,
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
    /// claude retrying an API call itself (`api_retry`).
    #[serde(rename_all = "camelCase")]
    ApiRetry {
        attempt: u32,
        max_retries: u32,
        error_status: Option<u16>,
        error: String,
    },
    /// The node continuing a run itself after claude's own retries gave up (Overloaded, Network): `attempt` of
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
    fn calls_and_events_round_trip() {
        let call =
            r#"{"id":"c1","call":{"op":"send","sessionId":"7f0c","runId":"r2","text":"continue"}}"#;
        let decoded: SessionCallFrame = serde_json::from_str(call).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), call);

        let answer = r#"{"id":"c2","call":{"op":"answer","sessionId":"7f0c","requestId":"q1","decision":{"behavior":"deny","message":"no"}}}"#;
        let decoded: SessionCallFrame = serde_json::from_str(answer).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), answer);

        let delta = r#"{"sessionId":"7f0c","at":"2026-10-18T10:00:00.000Z","event":{"type":"delta","messageId":"m1","append":"O"}}"#;
        let decoded: ThreadEventFrame = serde_json::from_str(delta).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), delta);
    }

    #[test]
    fn a_reply_is_either_an_output_or_an_error() {
        let ok = r#"{"id":"c1","result":{"ok":{"kind":"sent","runId":"r2","queued":false}}}"#;
        assert!(serde_json::from_str::<SessionReplyFrame>(ok).is_ok());
        let err = r#"{"id":"c1","result":{"err":{"code":"runner_unavailable","message":"claude is not logged in"}}}"#;
        assert!(serde_json::from_str::<SessionReplyFrame>(err).is_ok());
    }
}
