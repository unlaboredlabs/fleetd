//! Per-machine clients of the node's session service over the node link. Each attached machine gets one supervisor
//! that subscribes to the node's machine stream and folds it into the store (thread/project caches) and the event log
//! (derived events, on transitions only). Thread transcripts are followed on demand (tail, actions, headlines) and
//! released after 60 s unused.
//!
//! One `Executors` serves thread watching, workspace files and changes, the runner's info and permission answers.
//! Calls go out as `session_call` frames; the link server hands every `session_reply`, `machine_event` and
//! `thread_event` frame to `handle_frame`.
pub mod activity;
pub mod providers;
pub mod repos;
pub mod shell_mapper;
pub mod thread_view;
pub mod tools;

pub use tools::register;

/// What a session's MCP servers are, for telling a change.
fn mcp_digest(config: &fleetd_contracts::mcp_servers::McpSessionConfig) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(serde_json::to_vec(config).unwrap_or_default()).into()
}

/// What a session's hub skills are, for telling a change.
fn skills_digest(bundles: &[fleetd_contracts::skills::SkillBundle]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(serde_json::to_vec(bundles).unwrap_or_default()).into()
}

#[cfg(test)]
mod fake_node_tests;
#[cfg(test)]
mod shell_mapper_tests;
#[cfg(test)]
mod thread_view_tests;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::effort::TaskProfile;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::mcp::McpToolError;
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::node_link::{HubToNode, NodeToHub};
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::sessions::{
    ItemKind, ItemStatus, MachineEvent, MachineEventFrame, PendingPermission, PermissionDecision,
    RunnerInfo, SessionCall, SessionCallFrame, SessionError, SessionErrorCode, SessionLaunch,
    SessionOutput, SessionResult, SessionStatus, SessionSummary, SessionWorkspace, ThreadEvent,
    ThreadEventFrame, ThreadItem, WorktreeBase, WorktreeSource,
};
use fleetd_contracts::steer::{SteerReceipt, SteerTag};
use futures_util::StreamExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::clock::Clock;
use crate::hub::store::{EventLog, HubStore, iso_ms, now_ms};
use shell_mapper::{
    ApplyContext, ShellState, StoredThread, Summary, TrackedThread, js_len, js_take,
};
use thread_view::{Action, TailRow, ThreadView};

/// Resubscribe delay: doubles from 1 s to a 30 s cap, +-25 % jitter so machines don't retry in step.
pub fn backoff_ms(attempt: u32, random: f64) -> u64 {
    let base = 1000.0 * 2f64.powi(attempt.min(5) as i32) * (0.75 + random * 0.5);
    (base.round() as u64).min(30_000)
}

pub const WATCH_IDLE_MS: u64 = 60_000;
const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// A launch may create a worktree and spawn claude before the node answers.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
/// A connection test: the node gives a server 30 s to start and list its tools.
const MCP_TEST_TIMEOUT: Duration = Duration::from_secs(45);
/// The node first stops the project's claude processes and waits up to 12 s for them to exit.
const REMOVE_TIMEOUT: Duration = Duration::from_secs(30);
/// The node's stop waits up to 25 s for claude to exit (its kill ladder, then a SIGKILL).
const STOP_TIMEOUT: Duration = Duration::from_secs(40);
/// The node keeps the last 2000 characters of the assistant's text on the summary; a shorter tail is the whole text.
const SUMMARY_TAIL_MAX: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeOperation {
    Launch,
    Send,
    Interrupt,
    Stop,
    Answer,
    Read,
    Project,
}

impl NodeOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Send => "send",
            Self::Interrupt => "interrupt",
            Self::Stop => "stop",
            Self::Answer => "answer",
            Self::Read => "read",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExecutorError {
    #[error("machine {machine_id} has no live node link")]
    MachineNotConnected { machine_id: MachineId },
    #[error("thread {thread_id} is not known on machine {machine_id}")]
    ThreadNotFound {
        machine_id: MachineId,
        thread_id: ThreadId,
    },
    /// `message` is the node's own words (or why no answer came); safe to show.
    #[error("the node on {machine_id} refused or failed the {} request: {message}", operation.as_str())]
    NodeRequestFailed {
        machine_id: MachineId,
        operation: NodeOperation,
        message: String,
        fix: Option<String>,
    },
}

fn failed(
    machine_id: &MachineId,
    operation: NodeOperation,
    message: impl ToString,
) -> ExecutorError {
    ExecutorError::NodeRequestFailed {
        machine_id: machine_id.clone(),
        operation,
        message: message.to_string(),
        fix: None,
    }
}

/// A sender over one welcomed node link. `link_id` tells a newer link from the one it replaced.
#[derive(Clone)]
pub struct NodeSessions {
    pub link_id: u64,
    pub send: mpsc::UnboundedSender<HubToNode>,
}

#[derive(Debug, Clone)]
pub struct LaunchInput {
    pub project_id: ProjectId,
    pub prompt: String,
    pub profile: TaskProfile,
    pub runtime_mode: RuntimeMode,
    pub title: Option<String>,
    /// The session and run ids derive from it, and the node's launch is idempotent on the session id, so a retried
    /// launch returns the same thread.
    pub client_request_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct LaunchOptions {
    /// Default: the project root. Tasks launch writers in a new worktree on their own branch.
    pub workspace: Option<SessionWorkspace>,
    /// Leads and tasks get fleetd's agent MCP tools for their role; a thread a person starts gets none.
    pub role: fleetd_contracts::sessions::SessionRole,
    /// The role whose configured MCP servers it gets; none for a plain thread.
    pub mcp_role: Option<fleetd_contracts::mcp_servers::McpAgentRole>,
    /// A task's order, whose variables its session gets.
    pub order_id: Option<fleetd_contracts::ledger::WorkstreamId>,
    /// The project's setup commands, for a new worktree on a node that runs them.
    pub setup: Option<fleetd_contracts::project_settings::WorktreeSetup>,
    /// Runtime tools it never gets, on top of the project's denials and fleetd's own (claude's `--disallowedTools`
    /// syntax); the node applies them at every start of its process.
    pub deny_tools: Vec<String>,
    /// These MCP servers instead of `mcp_role`'s, kept for the thread's life: a send never brings it the project's.
    pub mcp: Option<fleetd_contracts::mcp_servers::McpSessionConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendOutcome {
    pub run_id: Option<String>,
    /// The message waits behind the thread's active run.
    pub queued: bool,
}

/// What a project's policy file says about its sessions' claude.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionRules {
    /// `tools.allow` and `tools.deny`, in claude's syntax.
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

pub type ToolRulesFuture<'a> =
    Pin<Box<dyn Future<Output = Result<SessionRules, McpToolError>> + Send + 'a>>;

/// A project's session rules (`tools.allow` and `tools.deny` in its policy file), read at every launch. The cached
/// policy reader implements it; a file that does not decode refuses the launch rather than drop its denies.
pub trait ToolPolicy: Send + Sync + 'static {
    fn tools<'a>(&'a self, project: &'a ProjectRef) -> ToolRulesFuture<'a>;
}

impl ToolPolicy for crate::hub::policy::Policies {
    fn tools<'a>(&'a self, project: &'a ProjectRef) -> ToolRulesFuture<'a> {
        Box::pin(async move {
            let policy = self.get(project).await?;
            let tools = policy.tools.unwrap_or_default();
            let rules = |l: &[fleetd_contracts::prim::Text<1, 200>]| {
                l.iter().map(|t| t.as_str().to_owned()).collect::<Vec<_>>()
            };
            Ok(SessionRules {
                allow: rules(&tools.allow),
                deny: rules(&tools.deny),
            })
        })
    }
}

/// What the watchdog needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningThread {
    pub thread_ref: ThreadRef,
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestRun {
    pub run_id: Option<String>,
    pub running: bool,
}

/// Set while a command or tool call of the run is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OpenTool {
    /// The longest timeout an open tool states itself.
    pub stated_timeout_ms: Option<u64>,
    /// Some open tool states none (the watchdog applies its default).
    pub unstated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    /// Epoch ms of the session's last machine or thread frame, or of the follow's opening.
    pub last_frame_ms: u64,
    pub tool: Option<OpenTool>,
}

/// What a finished task thread changed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ThreadChanges {
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    /// Repo-relative paths the session changed against its base (committed and not), sorted and unique.
    pub paths: Vec<String>,
    /// Always empty with the native runner; the tasks area finds a PR in the thread's command output instead.
    pub pull_request_urls: Vec<String>,
}

/// A followed thread's live lane values (see `activity`).
#[derive(Debug, Clone)]
pub struct LiveParts {
    pub activity: Option<fleetd_contracts::live::ActivityNow>,
    pub tokens: Option<fleetd_contracts::live::Tokens>,
    pub spark: fleetd_contracts::live::Spark,
    pub text: Option<activity::StreamText>,
    /// The complete text messages since the latest run started (see `ActivityTracker`): the chat lands these whole,
    /// whatever deltas it missed and whether or not the run is still going.
    pub done: Vec<activity::DoneText>,
    pub run_active: bool,
}

/// A thread's tail, newest first (thread_tail's items, thread and truncated).
#[derive(Debug, Clone)]
pub struct Tail {
    pub items: Vec<TailRow>,
    pub thread: Summary,
    pub truncated: bool,
}

/// One page of an agent's steps: `(id, row)` newest first.
pub struct Work {
    pub rows: Vec<(String, TailRow)>,
    /// Older steps remain in the view.
    pub more: bool,
    pub running: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Ready {
    Pending,
    Open,
    Failed(ExecutorError),
}

struct WatchState {
    view: ThreadView,
    /// What the thread is doing now, for the app's live lanes.
    activity: activity::ActivityTracker,
    last_used_ms: u64,
    /// Any machine or thread frame for the session counts as progress; starts at the follow's opening.
    last_frame_ms: u64,
    /// Followed by the watchdog: stays open however long nobody reads it.
    pinned: bool,
}

struct Watch {
    state: Mutex<WatchState>,
    ready: watch::Sender<Ready>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Watch {
    /// Settles a pending watch; a ready one stays ready.
    fn settle(&self, to: Ready) {
        self.ready.send_if_modified(|r| {
            let pending = *r == Ready::Pending;
            if pending {
                *r = to.clone();
            }
            pending
        });
    }
}

#[derive(Default)]
struct Slot {
    link: Option<NodeSessions>,
    supervisor: Option<JoinHandle<()>>,
    /// The supervisor's inbox: machine events, applied in order.
    events: Option<mpsc::UnboundedSender<MachineEventFrame>>,
    /// Set once the node accepted the subscription on the current link.
    live: bool,
    /// When `live` was last set, in ms.
    live_since_ms: i64,
    shell: ShellState,
    watches: HashMap<String, Arc<Watch>>,
    /// Calls in flight on the current link, by frame id.
    pending: HashMap<String, oneshot::Sender<SessionResult>>,
}

/// Called with a followed thread that just printed a GitHub PR URL.
pub type PrSink = Arc<dyn Fn(&ThreadRef) + Send + Sync>;

/// Takes a node's steer receipts, in stream order (replayed after a link drop, so a receipt may come twice).
pub trait SteerSink: Send + Sync {
    fn receipt(&self, machine_id: &MachineId, receipt: &SteerReceipt);
}

pub struct Executors {
    store: Arc<HubStore>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
    machines: Mutex<HashMap<MachineId, Slot>>,
    /// Per machine: true while live. `await_live` waits on it.
    live: Mutex<HashMap<MachineId, watch::Sender<bool>>>,
    /// Per machine: true once the link server announced the machine online by its runner's verdict, false while
    /// degraded or unlinked. Queued writes go out only while it is true.
    ready: Mutex<HashMap<MachineId, watch::Sender<bool>>>,
    /// Per machine: the runner as the node last reported it, by a `runner_info` answer or a pushed event.
    runners: Mutex<HashMap<MachineId, watch::Sender<Option<RunnerInfo>>>>,
    tool_policy: Mutex<Option<Arc<dyn ToolPolicy>>>,
    /// Where a launch's MCP servers come from (`hub::mcp_servers`); none until `hub/serve` sets it.
    mcp_servers: std::sync::OnceLock<Arc<crate::hub::store::HubDb>>,
    /// Per thread (`machine/thread`): its project, and a digest of the MCP servers it last got, so a send carries them
    /// only when they changed. Empty after a hub restart: each thread's next send carries them once.
    mcp_sent: Mutex<HashMap<String, (ProjectId, [u8; 32])>>,
    /// Threads (`machine/thread`) launched with their own fixed MCP servers (`LaunchOptions::mcp`): a send carries
    /// none. Empty after a hub restart.
    mcp_fixed: Mutex<std::collections::HashSet<String>>,
    /// Where the skills a launch carries come from (`hub::skills`); none until `hub/serve` sets it.
    skills: std::sync::OnceLock<Arc<crate::hub::store::HubDb>>,
    /// Where the hub reads which lead threads are archived (W79); none until `hub/serve` sets it.
    archive: std::sync::OnceLock<Arc<crate::hub::store::HubDb>>,
    /// Per thread (`machine/thread`): its project, and a digest of the hub skills it last got, so a send carries them
    /// only when they changed. Empty after a hub restart: each thread's next send carries them once.
    skills_sent: Mutex<HashMap<String, (ProjectId, [u8; 32])>>,
    /// Running clones by add id: where their `clone_progress` frames go.
    clones: repos::CloneWatchers,
    /// Where a node's steer receipts go (the steer area).
    steer_sink: Mutex<Option<Arc<dyn SteerSink>>>,
    /// Told of each finished command whose output names a GitHub PR (the train).
    pr_sink: std::sync::OnceLock<PrSink>,
    /// Where later areas plug into the M1 tools.
    pub hooks: tools::ToolHooks,
    time: std::sync::OnceLock<Arc<crate::hub::time::Time>>,
}

/// A finished command whose output holds a GitHub pull URL, such as `gh pr create`'s.
fn names_a_pr(item: &ThreadItem) -> bool {
    let ItemKind::Command {
        output: Some(output),
        ..
    } = &item.kind
    else {
        return false;
    };
    item.status == ItemStatus::Completed
        && output.contains("github.com/")
        && output.contains("/pull/")
}

fn thread_ref(machine_id: &MachineId, thread_id: &str) -> ThreadRef {
    ThreadRef {
        machine_id: machine_id.clone(),
        thread_id: ThreadId::unchecked(thread_id),
    }
}

fn to_stored(s: &crate::hub::store::StoredThread) -> Option<StoredThread> {
    Some(StoredThread {
        summary: serde_json::from_value(serde_json::to_value(&s.thread).ok()?).ok()?,
        last_sequence: s.last_sequence.map(|n| n.max(0) as u64),
        last_run_id: s.last_run_id.clone(),
        last_run_status: s.last_run_status.clone(),
    })
}

fn from_stored(s: &StoredThread) -> Option<crate::hub::store::StoredThread> {
    Some(crate::hub::store::StoredThread {
        thread: serde_json::from_value(serde_json::to_value(&s.summary).ok()?).ok()?,
        last_sequence: s.last_sequence.map(|n| n as i64),
        last_run_id: s.last_run_id.clone(),
        last_run_status: s.last_run_status.clone(),
    })
}

fn uuid_of(b: [u8; 16]) -> String {
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-4{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[13..16],
        &h[16..20],
        &h[20..32]
    )
}

/// A random v4-shaped UUID.
pub(crate) fn new_uuid() -> String {
    uuid_of(rand::random())
}

/// A v4-shaped UUID derived from `seed`: the same request always names the same session or run, so the node's
/// idempotent launch and send dedupe a retry.
pub(crate) fn uuid_from(seed: &str) -> String {
    let digest = Sha256::digest(seed.as_bytes());
    let mut b = [0u8; 16];
    b.copy_from_slice(&digest[..16]);
    uuid_of(b)
}

fn non_empty(
    machine_id: &MachineId,
    operation: NodeOperation,
    what: &str,
    value: &str,
) -> Result<NonEmpty, ExecutorError> {
    NonEmpty::new(value).map_err(|_| failed(machine_id, operation, format!("the {what} is empty")))
}

fn from_session_error(
    machine_id: &MachineId,
    operation: NodeOperation,
    session: Option<&ThreadId>,
    error: SessionError,
) -> ExecutorError {
    match (error.code, session) {
        (SessionErrorCode::NotFound, Some(thread_id))
            if operation != NodeOperation::Answer && operation != NodeOperation::Launch =>
        {
            ExecutorError::ThreadNotFound {
                machine_id: machine_id.clone(),
                thread_id: thread_id.clone(),
            }
        }
        _ => ExecutorError::NodeRequestFailed {
            machine_id: machine_id.clone(),
            operation,
            message: error.message.as_str().to_owned(),
            fix: error.fix,
        },
    }
}

/// Clears the slot's live flag and its thread follows when a supervisor ends, however it ends.
struct LiveGuard {
    executors: Arc<Executors>,
    machine_id: MachineId,
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        let mut machines = self.executors.machines.lock().unwrap();
        if let Some(slot) = machines.get_mut(&self.machine_id) {
            slot.live = false;
            for (_, w) in slot.watches.drain() {
                if let Some(task) = w.task.lock().unwrap().take() {
                    task.abort();
                }
                w.settle(Ready::Failed(ExecutorError::MachineNotConnected {
                    machine_id: self.machine_id.clone(),
                }));
            }
        }
        drop(machines);
        self.executors.set_live(&self.machine_id, false);
    }
}

impl Executors {
    pub fn new(store: Arc<HubStore>, events: Arc<EventLog>, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self {
            store,
            events,
            clock,
            machines: Mutex::default(),
            live: Mutex::default(),
            steer_sink: Mutex::default(),
            pr_sink: std::sync::OnceLock::new(),
            runners: Mutex::default(),
            ready: Mutex::default(),
            tool_policy: Mutex::default(),
            mcp_servers: std::sync::OnceLock::new(),
            mcp_sent: Mutex::default(),
            mcp_fixed: Mutex::default(),
            skills: std::sync::OnceLock::new(),
            archive: std::sync::OnceLock::new(),
            skills_sent: Mutex::default(),
            clones: Mutex::default(),
            hooks: tools::ToolHooks::default(),
            time: std::sync::OnceLock::new(),
        })
    }

    pub fn set_steer_sink(&self, sink: Arc<dyn SteerSink>) {
        *self.steer_sink.lock().unwrap() = Some(sink);
    }

    pub fn set_pr_sink(&self, sink: PrSink) {
        let _ = self.pr_sink.set(sink);
    }

    /// `hub/serve` sets this once the policy reader exists; until then launches carry no tool rules.
    pub fn set_tool_policy(&self, policy: Arc<dyn ToolPolicy>) {
        *self.tool_policy.lock().unwrap() = Some(policy);
    }

    /// `hub/serve` sets this once: every agent's launch from then on carries its project's MCP servers and the global
    /// ones, and every send a thread's changed ones.
    pub fn set_mcp_servers(&self, db: Arc<crate::hub::store::HubDb>) {
        let _ = self.mcp_servers.set(db);
    }

    fn mcp_config(
        &self,
        machine_id: &MachineId,
        project_id: &ProjectId,
    ) -> Option<fleetd_contracts::mcp_servers::McpSessionConfig> {
        let db = self.mcp_servers.get()?;
        let r = ProjectRef {
            machine_id: machine_id.clone(),
            project_id: project_id.clone(),
        };
        match db.mcp_servers().session_config(&r) {
            Ok(config) => Some(config),
            Err(e) => {
                tracing::warn!(%machine_id, %project_id, "MCP servers not read: {e}");
                None
            }
        }
    }

    /// The thread's MCP servers when they differ from what it last got, and what to record once the send went. A
    /// plain thread's node ignores them.
    #[allow(clippy::type_complexity)]
    fn changed_mcp(
        &self,
        r: &ThreadRef,
    ) -> (
        Option<fleetd_contracts::mcp_servers::McpSessionConfig>,
        Option<(ProjectId, [u8; 32])>,
    ) {
        if self.mcp_servers.get().is_none() {
            return (None, None);
        }
        let key = format!("{}/{}", r.machine_id, r.thread_id);
        if self.mcp_fixed.lock().unwrap().contains(&key) {
            return (None, None);
        }
        let last = self.mcp_sent.lock().unwrap().get(&key).cloned();
        let project = match &last {
            Some((project, _)) => Some(project.clone()),
            None => self
                .summary_of(r)
                .ok()
                .and_then(|s| ProjectId::new(s.project_id).ok()),
        };
        let Some(project) = project else {
            return (None, None);
        };
        let Some(config) = self.mcp_config(&r.machine_id, &project) else {
            return (None, None);
        };
        let digest = mcp_digest(&config);
        if last.is_some_and(|(_, d)| d == digest) {
            return (None, None);
        }
        (Some(config), Some((project, digest)))
    }

    /// `hub/serve` sets this once: every launch from then on carries the project's skills and the global ones, and
    /// every send a thread's changed ones.
    pub fn set_skills(&self, db: Arc<crate::hub::store::HubDb>) {
        let _ = self.skills.set(db);
    }

    /// `hub/serve` sets this once: from then on no send reaches the lead of an archived project.
    pub fn set_archive(&self, db: Arc<crate::hub::store::HubDb>) {
        let _ = self.archive.set(db);
    }

    /// The hub skills a launch in the node project carries.
    pub(crate) fn skill_bundles(
        &self,
        machine_id: &MachineId,
        project_id: &ProjectId,
    ) -> Vec<fleetd_contracts::skills::SkillBundle> {
        self.skills.get().map_or_else(Vec::new, |db| {
            let r = ProjectRef {
                machine_id: machine_id.clone(),
                project_id: project_id.clone(),
            };
            // A repo checkout carries the skills of the projects holding it first (W79).
            let holders = db
                .with(|c| Ok(crate::hub::repos::store::holders(c, &r)?))
                .unwrap_or_else(|error| {
                    tracing::warn!(%error, "skills: the checkout's projects not read");
                    Vec::new()
                });
            let projects: Vec<&ProjectRef> = holders
                .iter()
                .map(|(p, _)| p)
                .chain(std::iter::once(&r))
                .collect();
            db.skills().bundles_in(&projects)
        })
    }

    /// The thread's hub skills when they differ from what it last got, and what to record once the send went.
    #[allow(clippy::type_complexity)]
    fn changed_skills(
        &self,
        r: &ThreadRef,
    ) -> (
        Option<Vec<fleetd_contracts::skills::SkillBundle>>,
        Option<(ProjectId, [u8; 32])>,
    ) {
        if self.skills.get().is_none() {
            return (None, None);
        }
        let key = format!("{}/{}", r.machine_id, r.thread_id);
        let last = self.skills_sent.lock().unwrap().get(&key).cloned();
        let project = match &last {
            Some((project, _)) => Some(project.clone()),
            None => self
                .summary_of(r)
                .ok()
                .and_then(|s| ProjectId::new(s.project_id).ok()),
        };
        let Some(project) = project else {
            return (None, None);
        };
        let bundles = self.skill_bundles(&r.machine_id, &project);
        let digest = skills_digest(&bundles);
        if last.is_some_and(|(_, d)| d == digest) {
            return (None, None);
        }
        (Some(bundles), Some((project, digest)))
    }

    fn now_ms(&self) -> u64 {
        now_ms(self.clock.as_ref()).max(0) as u64
    }

    fn set_live(&self, machine_id: &MachineId, live: bool) {
        let mut flags = self.live.lock().unwrap();
        flags
            .entry(machine_id.clone())
            .or_insert_with(|| watch::channel(false).0)
            .send_replace(live);
    }

    fn tracked(&self, r: &ThreadRef) -> Option<TrackedThread> {
        self.machines
            .lock()
            .unwrap()
            .get(&r.machine_id)?
            .shell
            .threads
            .get(r.thread_id.as_str())
            .cloned()
    }

    /// Takes over the machine's link and (re)subscribes. Idempotent for the same link.
    pub async fn attach(self: &Arc<Self>, machine_id: &MachineId, sessions: NodeSessions) {
        let (tx, rx) = mpsc::unbounded_channel();
        let old = {
            let mut machines = self.machines.lock().unwrap();
            let slot = machines.entry(machine_id.clone()).or_default();
            if slot
                .link
                .as_ref()
                .is_some_and(|l| l.link_id == sessions.link_id)
            {
                return;
            }
            slot.link = Some(sessions);
            slot.events = Some(tx);
            // Replies to calls on the old link never come; their senders drop, so the waiters fail.
            slot.pending.clear();
            slot.supervisor.take()
        };
        if let Some(old) = old {
            old.abort();
            let _ = old.await;
        }
        let this = self.clone();
        let id = machine_id.clone();
        let task = tokio::spawn(async move { this.supervise(id, rx).await });
        if let Some(slot) = self.machines.lock().unwrap().get_mut(machine_id) {
            slot.supervisor = Some(task);
        }
    }

    /// Drops the link. The machine's shell state is kept, so a later attach resumes from its cursor.
    pub async fn detach(&self, machine_id: &MachineId) {
        self.set_runner_ready(machine_id, false);
        let task = self
            .machines
            .lock()
            .unwrap()
            .get_mut(machine_id)
            .and_then(|s| {
                s.link = None;
                s.events = None;
                s.pending.clear();
                s.supervisor.take()
            });
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }

    /// Drops the link only if it is still `link_id` (a newer link may have taken over).
    pub async fn detach_link(&self, machine_id: &MachineId, link_id: u64) {
        let current = self
            .machines
            .lock()
            .unwrap()
            .get(machine_id)
            .and_then(|s| s.link.as_ref().map(|l| l.link_id));
        if current == Some(link_id) {
            self.detach(machine_id).await;
        }
    }

    pub fn is_connected(&self, machine_id: &MachineId) -> bool {
        self.machines
            .lock()
            .unwrap()
            .get(machine_id)
            .is_some_and(|s| s.live && s.link.is_some())
    }

    /// When the machine's current link went live, in ms; None while it has no live link.
    pub fn live_since(&self, machine_id: &MachineId) -> Option<i64> {
        self.machines
            .lock()
            .unwrap()
            .get(machine_id)
            .filter(|s| s.live && s.link.is_some())
            .map(|s| s.live_since_ms)
    }

    /// Returns once the machine's node accepted the subscription, at once if it has.
    pub async fn await_live(&self, machine_id: &MachineId) {
        if self.is_connected(machine_id) {
            return;
        }
        let mut rx = self
            .live
            .lock()
            .unwrap()
            .entry(machine_id.clone())
            .or_insert_with(|| watch::channel(false).0)
            .subscribe();
        let _ = rx.wait_for(|live| *live).await;
    }

    /// Changes each time the machine's link goes live or drops.
    pub fn live_watch(&self, machine_id: &MachineId) -> watch::Receiver<bool> {
        self.live
            .lock()
            .unwrap()
            .entry(machine_id.clone())
            .or_insert_with(|| watch::channel(false).0)
            .subscribe()
    }

    fn ready_slot(&self, machine_id: &MachineId) -> watch::Sender<bool> {
        self.ready
            .lock()
            .unwrap()
            .entry(machine_id.clone())
            .or_insert_with(|| watch::channel(false).0)
            .clone()
    }

    /// The link server sets this after it announced the machine online, and clears it when the runner turns
    /// unusable or the link drops.
    pub fn set_runner_ready(&self, machine_id: &MachineId, ready: bool) {
        self.ready_slot(machine_id).send_if_modified(|r| {
            let changed = *r != ready;
            *r = ready;
            changed
        });
    }

    /// Live, and announced online: what the offline queue waits for before it delivers anything.
    pub fn is_ready(&self, machine_id: &MachineId) -> bool {
        self.is_connected(machine_id) && *self.ready_slot(machine_id).borrow()
    }

    /// Returns once `is_ready`, at once if it is now.
    pub async fn await_ready(&self, machine_id: &MachineId) {
        let mut ready = self.ready_slot(machine_id).subscribe();
        let mut live = self
            .live
            .lock()
            .unwrap()
            .entry(machine_id.clone())
            .or_insert_with(|| watch::channel(false).0)
            .subscribe();
        while !self.is_ready(machine_id) {
            tokio::select! {
                _ = ready.changed() => {}
                _ = live.changed() => {}
            }
        }
    }

    fn runner_slot(&self, machine_id: &MachineId) -> watch::Sender<Option<RunnerInfo>> {
        self.runners
            .lock()
            .unwrap()
            .entry(machine_id.clone())
            .or_insert_with(|| watch::channel(None).0)
            .clone()
    }

    /// The runner as last reported; it changes on every `runner_info` answer and every pushed runner event, which
    /// the link server follows for the machine's online/degraded status.
    pub fn runner_watch(&self, machine_id: &MachineId) -> watch::Receiver<Option<RunnerInfo>> {
        self.runner_slot(machine_id).subscribe()
    }

    /// The runner as last reported, without asking the node.
    pub fn cached_runner(&self, machine_id: &MachineId) -> Option<RunnerInfo> {
        self.runner_slot(machine_id).borrow().clone()
    }

    /// The runner's last reported problem as a refusal of `operation`, with the fix to run on the machine. None when
    /// it is usable or unknown.
    pub fn runner_refusal(
        &self,
        machine_id: &MachineId,
        operation: NodeOperation,
    ) -> Option<ExecutorError> {
        let info = self.cached_runner(machine_id)?;
        let problem = providers::runner_problem(&info)?;
        Some(ExecutorError::NodeRequestFailed {
            machine_id: machine_id.clone(),
            operation,
            message: problem,
            fix: Some(providers::runner_fix(&info, machine_id.as_str())),
        })
    }

    fn remember_runner(&self, machine_id: &MachineId, info: &RunnerInfo) {
        self.runner_slot(machine_id).send_if_modified(|current| {
            let changed = current.as_ref() != Some(info);
            if changed {
                *current = Some(info.clone());
            }
            changed
        });
    }

    /// The link server hands over every session frame the node sends.
    pub fn handle_frame(&self, machine_id: &MachineId, frame: NodeToHub) {
        match frame {
            NodeToHub::SessionReply(reply) => {
                let done = self
                    .machines
                    .lock()
                    .unwrap()
                    .get_mut(machine_id)
                    .and_then(|s| s.pending.remove(reply.id.as_str()));
                if let Some(done) = done {
                    let _ = done.send(reply.result);
                }
            }
            NodeToHub::MachineEvent(frame) => {
                if let MachineEvent::RunnerInfo(info) = &frame.event {
                    self.remember_runner(machine_id, info);
                }
                let machines = self.machines.lock().unwrap();
                let Some(slot) = machines.get(machine_id) else {
                    return;
                };
                if let MachineEvent::SessionUpdated(s) = &frame.event
                    && let Some(w) = slot.watches.get(s.session_id.as_str())
                {
                    w.state.lock().unwrap().last_frame_ms = self.now_ms();
                }
                if let Some(tx) = &slot.events {
                    let _ = tx.send(frame);
                }
            }
            NodeToHub::ThreadEvent(frame) => self.apply_thread_frame(machine_id, &frame),
            NodeToHub::CloneProgress(frame) => self.clone_progress(frame),
            _ => {}
        }
    }

    fn apply_thread_frame(&self, machine_id: &MachineId, frame: &ThreadEventFrame) {
        let w = self
            .machines
            .lock()
            .unwrap()
            .get(machine_id)
            .and_then(|s| s.watches.get(frame.session_id.as_str()).cloned());
        let Some(w) = w else { return };
        let root = matches!(frame.event, ThreadEvent::Snapshot(_))
            .then(|| self.session_root(machine_id, &frame.event))
            .flatten();
        let ready = {
            let mut s = w.state.lock().unwrap();
            let now = self.now_ms();
            s.last_frame_ms = now;
            if root.is_some() {
                s.activity.set_root(root);
            }
            s.activity.apply(&frame.event, now as i64);
            thread_view::apply_thread_event(&mut s.view, &frame.event);
            s.view.ready
        };
        if ready {
            w.settle(Ready::Open);
        }
        if let ThreadEvent::Item(item) = &frame.event
            && names_a_pr(item)
            && let Some(sink) = self.pr_sink.get()
        {
            sink(&thread_ref(machine_id, frame.session_id.as_str()));
        }
    }

    /// One `session_call` and its `session_reply`, at most `wait`.
    async fn call(
        &self,
        machine_id: &MachineId,
        operation: NodeOperation,
        call: SessionCall,
        wait: Duration,
    ) -> Result<SessionOutput, ExecutorError> {
        let session = match &call {
            SessionCall::Send { session_id, .. }
            | SessionCall::Interrupt { session_id, .. }
            | SessionCall::Answer { session_id, .. }
            | SessionCall::Follow { session_id }
            | SessionCall::ReadItem { session_id, .. }
            | SessionCall::Changes { session_id }
            | SessionCall::Stop { session_id, .. } => Some(session_id.clone()),
            _ => None,
        };
        let id = new_uuid();
        let (tx, rx) = oneshot::channel();
        let send = {
            let mut machines = self.machines.lock().unwrap();
            let slot = machines
                .get_mut(machine_id)
                .filter(|s| s.link.is_some())
                .ok_or_else(|| ExecutorError::MachineNotConnected {
                    machine_id: machine_id.clone(),
                })?;
            slot.pending.insert(id.clone(), tx);
            slot.link.as_ref().expect("link").send.clone()
        };
        let frame = HubToNode::SessionCall(SessionCallFrame {
            id: NonEmpty::unchecked(id.clone()),
            call,
        });
        let forget = || {
            if let Some(s) = self.machines.lock().unwrap().get_mut(machine_id) {
                s.pending.remove(&id);
            }
        };
        if send.send(frame).is_err() {
            forget();
            return Err(ExecutorError::MachineNotConnected {
                machine_id: machine_id.clone(),
            });
        }
        match tokio::time::timeout(wait, rx).await {
            Err(_) => {
                forget();
                Err(failed(
                    machine_id,
                    operation,
                    format!("no answer within {} s", wait.as_secs()),
                ))
            }
            Ok(Err(_)) => Err(failed(
                machine_id,
                operation,
                "the node link dropped before the node answered",
            )),
            Ok(Ok(SessionResult::Ok(output))) => Ok(output),
            Ok(Ok(SessionResult::Err(e))) => Err(from_session_error(
                machine_id,
                operation,
                session.as_ref(),
                e,
            )),
        }
    }

    /// One link's lifetime: subscribe after the stored cursor, then apply the machine stream until detached.
    async fn supervise(
        self: Arc<Self>,
        machine_id: MachineId,
        mut events: mpsc::UnboundedReceiver<MachineEventFrame>,
    ) {
        let _guard = LiveGuard {
            executors: self.clone(),
            machine_id: machine_id.clone(),
        };
        let cursor = match self.store.cursor_get(&machine_id) {
            Ok(c) => c,
            Err(e) => return tracing::error!(error = %e, "executor: cursor read failed"),
        };
        let complete = self
            .machines
            .lock()
            .unwrap()
            .get(&machine_id)
            .is_some_and(|s| s.shell.complete);
        // A replay only carries changed rows, and project counts need every row, so the first stream in this process
        // starts from a snapshot; it is diffed against the stored summaries, so nothing is missed. It also means a
        // cursor stored before the native runner, from another sequence, is never sent to a node.
        let after = if complete {
            cursor.map(|c| c.max(0) as u64)
        } else {
            None
        };
        let baseline = cursor.is_none();
        let mut attempt = 0;
        loop {
            match self
                .call(
                    &machine_id,
                    NodeOperation::Read,
                    SessionCall::Subscribe {
                        after,
                        spans_after: self.time.get().map(|t| t.node_cursor(machine_id.as_str())),
                    },
                    READ_TIMEOUT,
                )
                .await
            {
                Ok(_) => break,
                Err(ExecutorError::MachineNotConnected { .. }) => return,
                Err(e) => {
                    let delay = backoff_ms(attempt, rand::random::<f64>());
                    attempt += 1;
                    tracing::warn!(machine_id = %machine_id, error = %e, retry_in_ms = delay, "node refused the session subscription; retrying");
                    self.clock.sleep(Duration::from_millis(delay)).await;
                }
            }
        }
        if let Some(slot) = self.machines.lock().unwrap().get_mut(&machine_id) {
            slot.live = true;
            slot.live_since_ms = now_ms(self.clock.as_ref());
        }
        self.set_live(&machine_id, true);
        while let Some(frame) = events.recv().await {
            self.handle_machine_event(&machine_id, Some(frame.seq), &frame.event, baseline)
                .await;
        }
    }

    async fn handle_machine_event(
        self: &Arc<Self>,
        machine_id: &MachineId,
        seq: Option<u64>,
        event: &MachineEvent,
        baseline: bool,
    ) {
        self.follow_active(machine_id, event);
        self.flag_refused(machine_id, event);
        if let MachineEvent::Steer(receipt) = event {
            let sink = self.steer_sink.lock().unwrap().clone();
            if let Some(sink) = sink {
                sink.receipt(machine_id, receipt);
            }
        }
        let ids: Vec<String> = match event {
            MachineEvent::Snapshot { sessions, .. } => {
                sessions.iter().map(|s| s.session_id.to_string()).collect()
            }
            MachineEvent::SessionUpdated(s) => vec![s.session_id.to_string()],
            _ => vec![],
        };
        let unknown: Vec<String> = {
            let machines = self.machines.lock().unwrap();
            let Some(slot) = machines.get(machine_id) else {
                return;
            };
            ids.into_iter()
                .filter(|id| !slot.shell.threads.contains_key(id))
                .collect()
        };
        let mut stored = HashMap::new();
        for id in unknown {
            if let Ok(Some(s)) = self.store.thread_get(&thread_ref(machine_id, &id))
                && let Some(s) = to_stored(&s)
            {
                stored.insert(id, s);
            }
        }
        let now = iso_ms(now_ms(self.clock.as_ref()));
        let applied = {
            let mut machines = self.machines.lock().unwrap();
            let Some(slot) = machines.get_mut(machine_id) else {
                return;
            };
            let ctx = ApplyContext {
                machine_id: machine_id.as_str(),
                now: &now,
                stored: &stored,
                baseline,
            };
            shell_mapper::apply_machine_event(&mut slot.shell, seq, event, &ctx)
        };
        let mut upserts: Vec<StoredThread> = vec![];
        for t in applied.threads {
            match upserts
                .iter_mut()
                .find(|u| u.summary.thread_id == t.summary.thread_id)
            {
                Some(u) => *u = t,
                None => upserts.push(t),
            }
        }
        // The summary keeps only the end of a long reply, so a run that ended or paused on one gets its headline
        // from a thread read.
        for t in &applied.transitions {
            let cut = self
                .tracked(&thread_ref(machine_id, &t.thread_id))
                .is_some_and(|k| js_len(&k.summary.latest_message_tail) >= SUMMARY_TAIL_MAX);
            if t.kind == shell_mapper::EventType::Started || !cut {
                continue;
            }
            let Ok(watch) = self.view(&thread_ref(machine_id, &t.thread_id)).await else {
                continue;
            };
            let text = thread_view::latest_assistant_text(&watch.state.lock().unwrap().view);
            let mut machines = self.machines.lock().unwrap();
            let Some(tracked) = machines
                .get_mut(machine_id)
                .and_then(|s| s.shell.threads.get_mut(&t.thread_id))
            else {
                continue;
            };
            let summary = shell_mapper::with_assistant_text(&tracked.summary, text.as_deref());
            if summary == tracked.summary {
                continue;
            }
            tracked.summary = summary.clone();
            // Keeps the row's lastSequence and run fields, if this event set them.
            match upserts
                .iter_mut()
                .find(|u| u.summary.thread_id == t.thread_id)
            {
                Some(u) => u.summary = summary,
                None => upserts.push(StoredThread {
                    summary,
                    last_sequence: None,
                    last_run_id: None,
                    last_run_status: None,
                }),
            }
        }
        for u in &upserts {
            match from_stored(u) {
                Some(row) => {
                    if let Err(e) = self.store.thread_upsert(&row) {
                        tracing::error!(error = %e, "executor: thread write failed");
                    }
                }
                None => {
                    tracing::error!(thread_id = %u.summary.thread_id, "executor: thread summary does not decode")
                }
            }
        }
        if !applied.projects.is_empty() {
            let projects: Vec<_> = applied
                .projects
                .iter()
                .filter_map(|p| serde_json::from_value(serde_json::to_value(p).ok()?).ok())
                .collect();
            if let Err(e) = self.store.projects_upsert_many(machine_id, &projects) {
                tracing::error!(error = %e, "executor: project write failed");
            }
        }
        if let Some(present) = &applied.present {
            // Rows the node has no session for, such as threads from before the native runner, never resume.
            match self.store.threads_mark_stale(machine_id, present, &now) {
                Ok(0) => {}
                Ok(n) => {
                    tracing::info!(machine_id = %machine_id, threads = n, "executor: threads the node does not have marked stale")
                }
                Err(e) => tracing::error!(error = %e, "executor: stale marking failed"),
            }
        }
        if matches!(
            event,
            MachineEvent::ProjectRemoved { .. } | MachineEvent::Snapshot { .. }
        ) {
            self.prune_projects(machine_id, event, &now);
        }
        for t in &applied.transitions {
            let Some(tracked) = self.tracked(&thread_ref(machine_id, &t.thread_id)) else {
                continue;
            };
            self.append(
                serde_json::to_value(shell_mapper::transition_event(
                    t,
                    &tracked,
                    machine_id.as_str(),
                ))
                .ok(),
            );
        }
        if let Some(cursor) = applied.cursor
            && let Err(e) = self.store.cursor_set(machine_id, cursor as i64)
        {
            tracing::error!(error = %e, "executor: cursor write failed");
        }
    }

    /// Projects the node removed: dropped from the cache, each with a project.removed event.
    fn prune_projects(&self, machine_id: &MachineId, event: &MachineEvent, now: &str) {
        let cached = match self.store.projects_list(Some(machine_id), None) {
            Ok(c) => c,
            Err(e) => return tracing::error!(error = %e, "executor: project list failed"),
        };
        let ids: Vec<String> = cached.iter().map(|p| p.project_id.to_string()).collect();
        let removed = {
            let machines = self.machines.lock().unwrap();
            let Some(slot) = machines.get(machine_id) else {
                return;
            };
            shell_mapper::removed_projects(&slot.shell, event, &ids)
        };
        for project_id in removed {
            let title = cached
                .iter()
                .find(|p| p.project_id.as_str() == project_id)
                .map_or(project_id.as_str(), |p| p.title.as_str());
            let r = ProjectRef {
                machine_id: machine_id.clone(),
                project_id: ProjectId::unchecked(project_id.as_str()),
            };
            if let Err(e) = self.store.project_remove(&r) {
                tracing::error!(error = %e, "executor: project remove failed");
            }
            let summary = format!("Project \"{title}\" on {machine_id} was removed");
            self.append(Some(json!({
                "at": now,
                "type": "project.removed",
                "machineId": machine_id,
                "projectId": project_id,
                "summary": js_take(&summary, 200),
                "data": { "title": title },
            })));
        }
    }

    fn append(&self, event: Option<serde_json::Value>) {
        let Some(event) = event else { return };
        match serde_json::from_value(event) {
            Ok(event) => {
                if let Err(e) = self.events.append(event) {
                    tracing::error!(error = %e, "executor: event append failed");
                }
            }
            Err(e) => tracing::error!(error = %e, "executor: event does not decode"),
        }
    }

    /// The thread's live view, following the session if nobody does yet.
    async fn view(self: &Arc<Self>, r: &ThreadRef) -> Result<Arc<Watch>, ExecutorError> {
        let machine_id = &r.machine_id;
        let now = self.now_ms();
        let watch = {
            let mut machines = self.machines.lock().unwrap();
            let slot = machines
                .get_mut(machine_id)
                .filter(|s| s.live && s.link.is_some())
                .ok_or_else(|| ExecutorError::MachineNotConnected {
                    machine_id: machine_id.clone(),
                })?;
            let watch = match slot.watches.get(r.thread_id.as_str()) {
                Some(w) => w.clone(),
                None => {
                    let w = Arc::new(Watch {
                        state: Mutex::new(WatchState {
                            view: ThreadView::default(),
                            activity: activity::ActivityTracker::default(),
                            last_used_ms: now,
                            last_frame_ms: now,
                            pinned: false,
                        }),
                        ready: watch::channel(Ready::Pending).0,
                        task: Mutex::new(None),
                    });
                    slot.watches.insert(r.thread_id.to_string(), w.clone());
                    let task = tokio::spawn(self.clone().follow_thread(r.clone(), w.clone()));
                    *w.task.lock().unwrap() = Some(task);
                    w
                }
            };
            watch.state.lock().unwrap().last_used_ms = now;
            watch
        };
        let mut rx = watch.ready.subscribe();
        let outcome =
            match tokio::time::timeout(READ_TIMEOUT, rx.wait_for(|r| *r != Ready::Pending)).await {
                Err(_) => Err(failed(
                    machine_id,
                    NodeOperation::Read,
                    "no thread snapshot within 15 s",
                )),
                Ok(Err(_)) => Err(failed(machine_id, NodeOperation::Read, "the follow closed")),
                Ok(Ok(state)) => match &*state {
                    Ready::Failed(e) => Err(e.clone()),
                    _ => Ok(()),
                },
            };
        outcome.map(|()| watch.clone())
    }

    /// Follows one session until the follow fails, or until it is unpinned and nobody read it for WATCH_IDLE_MS.
    async fn follow_thread(self: Arc<Self>, r: ThreadRef, w: Arc<Watch>) {
        let follow = self
            .call(
                &r.machine_id,
                NodeOperation::Read,
                SessionCall::Follow {
                    session_id: r.thread_id.clone(),
                },
                READ_TIMEOUT,
            )
            .await;
        let end = match follow {
            Err(e) => e,
            Ok(output) => {
                if let SessionOutput::Snapshot(snapshot) = output {
                    let event = ThreadEvent::Snapshot(snapshot);
                    let root = self.session_root(&r.machine_id, &event);
                    let now = self.now_ms() as i64;
                    let mut s = w.state.lock().unwrap();
                    s.activity.set_root(root);
                    s.activity.apply(&event, now);
                    thread_view::apply_thread_event(&mut s.view, &event);
                    drop(s);
                    w.settle(Ready::Open);
                }
                loop {
                    let (idle, pinned) = {
                        let s = w.state.lock().unwrap();
                        (self.now_ms().saturating_sub(s.last_used_ms), s.pinned)
                    };
                    if idle >= WATCH_IDLE_MS && !pinned {
                        break;
                    }
                    let wait = if pinned {
                        WATCH_IDLE_MS
                    } else {
                        WATCH_IDLE_MS - idle
                    };
                    self.clock.sleep(Duration::from_millis(wait)).await;
                }
                let _ = self
                    .call(
                        &r.machine_id,
                        NodeOperation::Read,
                        SessionCall::Release {
                            session_id: r.thread_id.clone(),
                        },
                        READ_TIMEOUT,
                    )
                    .await;
                failed(&r.machine_id, NodeOperation::Read, "the follow went idle")
            }
        };
        {
            let mut machines = self.machines.lock().unwrap();
            if let Some(slot) = machines.get_mut(&r.machine_id)
                && slot
                    .watches
                    .get(r.thread_id.as_str())
                    .is_some_and(|x| Arc::ptr_eq(x, &w))
            {
                slot.watches.remove(r.thread_id.as_str());
            }
        }
        w.settle(Ready::Failed(end));
    }

    /// Fills in the outputs the bounded snapshot cut, for the items about to be returned.
    async fn fill_outputs(
        &self,
        r: &ThreadRef,
        w: &Watch,
        ids: &[String],
    ) -> Result<(), ExecutorError> {
        let omitted = thread_view::omitted_outputs(&w.state.lock().unwrap().view, ids);
        let fetches = omitted.into_iter().map(|item_id| {
            let call = SessionCall::ReadItem {
                session_id: r.thread_id.clone(),
                item_id: NonEmpty::unchecked(item_id),
            };
            self.call(&r.machine_id, NodeOperation::Read, call, READ_TIMEOUT)
        });
        let results: Vec<_> = futures_util::stream::iter(fetches)
            .buffer_unordered(4)
            .collect()
            .await;
        for result in results {
            if let SessionOutput::Item { item } = result? {
                w.state
                    .lock()
                    .unwrap()
                    .view
                    .items
                    .insert(item.id.to_string(), item);
            }
        }
        Ok(())
    }

    /// The thread's summary from the shell, else the store.
    fn summary_of(&self, r: &ThreadRef) -> Result<Summary, ExecutorError> {
        if let Some(t) = self.tracked(r) {
            return Ok(t.summary);
        }
        let stored = self
            .store
            .thread_get(r)
            .ok()
            .flatten()
            .and_then(|s| to_stored(&s));
        stored
            .map(|s| s.summary)
            .ok_or_else(|| ExecutorError::ThreadNotFound {
                machine_id: r.machine_id.clone(),
                thread_id: r.thread_id.clone(),
            })
    }

    pub async fn launch(
        &self,
        machine_id: &MachineId,
        input: &LaunchInput,
        options: LaunchOptions,
    ) -> Result<(ThreadId, Option<WorktreeBase>), ExecutorError> {
        let op = NodeOperation::Launch;
        // No new session goes to a runner the node says can't run it (spec §3.6): an expired login, or a runner that
        // is missing or broke fleetd's protocol probe. Unknown (the node can't say) leaves it to the node.
        if self.cached_runner(machine_id).is_none() {
            let _ = self.runner_info(machine_id).await;
        }
        if let Some(refused) = self.runner_refusal(machine_id, op) {
            return Err(refused);
        }
        // The machine's runner takes it, on the model and effort the profile's settings chose and the profile's own
        // for what they leave unset. Settings that can't be read leave it all to the profile's own.
        let runner = self
            .cached_runner(machine_id)
            .map(|info| info.runner)
            .unwrap_or_default();
        let title = match input.title.as_deref().map(str::trim) {
            Some(t) if !t.is_empty() => t.to_owned(),
            _ => js_take(input.prompt.trim().split('\n').next().unwrap_or(""), 80).to_owned(),
        };
        let policy = self.tool_policy.lock().unwrap().clone();
        let mut rules = match policy {
            None => SessionRules::default(),
            Some(policy) => {
                let project = ProjectRef {
                    machine_id: machine_id.clone(),
                    project_id: input.project_id.clone(),
                };
                policy
                    .tools(&project)
                    .await
                    .map_err(|e| ExecutorError::NodeRequestFailed {
                        machine_id: machine_id.clone(),
                        operation: op,
                        message: format!("the project's policy file was not read: {}", e.message),
                        fix: e.fix,
                    })?
            }
        };
        let project = ProjectRef {
            machine_id: machine_id.clone(),
            project_id: input.project_id.clone(),
        };
        let chosen = self
            .store
            .db()
            .profile_settings()
            .chosen(&project, input.profile)
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "the profile settings were not read; the profile's own runs");
                Default::default()
            });
        let fixed_mcp = options.mcp.is_some();
        // A Navi's lead gets no allow rules from the policy file in its own folder, which it could write: only its
        // denials hold.
        if options.role == fleetd_contracts::sessions::SessionRole::Assistant {
            rules.allow.clear();
        }
        // A Navi's lead never asks for its integrations' reads, and never gets a tool the blocked list refuses
        // (hub/integrations); the hub's verdict still answers every prompt that comes.
        if options.role == fleetd_contracts::sessions::SessionRole::Assistant
            && let Some(db) = self.mcp_servers.get()
        {
            let r = ProjectRef {
                machine_id: machine_id.clone(),
                project_id: input.project_id.clone(),
            };
            match db.mcp_servers().servers_for(&r) {
                Ok(servers) => {
                    let integrations = crate::hub::integrations::policy::launch_rules(&servers);
                    rules.allow.extend(integrations.allowed);
                    rules.deny.extend(integrations.disallowed);
                }
                Err(e) => tracing::warn!(%machine_id, "a Navi's integration rules not read: {e}"),
            }
        }
        let skills = self.skill_bundles(machine_id, &input.project_id);
        let seed = format!("{machine_id}\n{}", input.client_request_id);
        let session_id = ThreadId::unchecked(uuid_from(&format!("session\n{seed}")));
        let launch = SessionLaunch {
            session_id: session_id.clone(),
            project_id: input.project_id.clone(),
            title: Some(title),
            runner,
            profile: Some(input.profile),
            model: chosen.model.map(|m| NonEmpty::unchecked(m.into_inner())),
            effort: chosen.effort,
            helper_model: chosen
                .helper_model
                .map(|m| NonEmpty::unchecked(m.into_inner())),
            runtime_mode: input.runtime_mode,
            workspace: options.workspace.unwrap_or(SessionWorkspace::Root),
            prompt: non_empty(machine_id, op, "prompt", &input.prompt)?,
            run_id: NonEmpty::unchecked(uuid_from(&format!("run\n{seed}"))),
            allowed_tools: rules.allow,
            disallowed_tools: rules
                .deny
                .into_iter()
                .chain(options.deny_tools.iter().cloned())
                .collect(),
            role: options.role,
            mcp_role: options.mcp_role,
            mcp: options.mcp.or_else(|| {
                options
                    .mcp_role
                    .and_then(|_| self.mcp_config(machine_id, &input.project_id))
            }),
            skills,
            order_id: options.order_id,
            setup: options.setup.map(Box::new),
        };
        let mcp_launched = launch
            .mcp
            .as_ref()
            .map(|config| (input.project_id.clone(), mcp_digest(config)));
        let skills_launched = (input.project_id.clone(), skills_digest(&launch.skills));
        let base = match self
            .call(machine_id, op, SessionCall::Launch(launch), LAUNCH_TIMEOUT)
            .await?
        {
            SessionOutput::Launched { base, .. } => base,
            _ => None,
        };
        if let Some(sent) = mcp_launched {
            self.mcp_sent
                .lock()
                .unwrap()
                .insert(format!("{machine_id}/{session_id}"), sent);
        }
        if fixed_mcp {
            self.mcp_fixed
                .lock()
                .unwrap()
                .insert(format!("{machine_id}/{session_id}"));
        }
        self.skills_sent
            .lock()
            .unwrap()
            .insert(format!("{machine_id}/{session_id}"), skills_launched);
        Ok((session_id, base))
    }

    pub async fn send(
        &self,
        r: &ThreadRef,
        message: &str,
        client_request_id: &str,
    ) -> Result<SendOutcome, ExecutorError> {
        let opts = crate::hub::queue::ports::SendOpts::default();
        self.send_with(r, message, client_request_id, &opts).await
    }

    /// The node run id a send with this request id gets.
    pub fn send_run_id(r: &ThreadRef, client_request_id: &str) -> String {
        uuid_from(&format!(
            "send\n{}\n{}\n{client_request_id}",
            r.machine_id, r.thread_id
        ))
    }

    /// Withdraws a send the thread's claude still holds queued; false once it was taken in.
    pub async fn withdraw(&self, r: &ThreadRef, run_id: &str) -> Result<bool, ExecutorError> {
        let call = SessionCall::Withdraw {
            session_id: r.thread_id.clone(),
            run_id: NonEmpty::unchecked(run_id),
        };
        Ok(matches!(
            self.call(&r.machine_id, NodeOperation::Send, call, READ_TIMEOUT)
                .await?,
            SessionOutput::Withdrawn { cancelled: true }
        ))
    }

    pub async fn send_with(
        &self,
        r: &ThreadRef,
        message: &str,
        client_request_id: &str,
        opts: &crate::hub::queue::ports::SendOpts,
    ) -> Result<SendOutcome, ExecutorError> {
        let op = NodeOperation::Send;
        // Every turn of every lead goes through here: an archived project's lead takes none (W79), whichever path
        // (a chat message, a wake, a steer, the write queue) it came by.
        if let Some(db) = self.archive.get() {
            match crate::hub::repos::archived_lead(db, r) {
                Ok(None) => {}
                Ok(Some((holder, repo))) => {
                    let (message, fix) = crate::hub::repos::archived_note(&holder, &repo);
                    return Err(ExecutorError::NodeRequestFailed {
                        machine_id: r.machine_id.clone(),
                        operation: op,
                        message,
                        fix: Some(fix),
                    });
                }
                Err(e) => tracing::warn!(error = %e, "executor: the lead's archive not read"),
            }
        }
        let run_id = Self::send_run_id(r, client_request_id);
        let (mcp, mcp_sent) = self.changed_mcp(r);
        let (skills, skills_now) = self.changed_skills(r);
        let call = SessionCall::Send {
            session_id: r.thread_id.clone(),
            run_id: NonEmpty::unchecked(run_id.clone()),
            text: non_empty(&r.machine_id, op, "message", message)?,
            mode: opts.mode,
            steer: opts.steer.clone().map(|id| SteerTag {
                id,
                riders: opts.riders.clone(),
            }),
            mcp,
            skills,
        };
        let out = self.call(&r.machine_id, op, call, READ_TIMEOUT).await?;
        if let Some(sent) = mcp_sent {
            self.mcp_sent
                .lock()
                .unwrap()
                .insert(format!("{}/{}", r.machine_id, r.thread_id), sent);
        }
        if let Some(sent) = skills_now {
            self.skills_sent
                .lock()
                .unwrap()
                .insert(format!("{}/{}", r.machine_id, r.thread_id), sent);
        }
        Ok(match out {
            SessionOutput::Sent(sent) => SendOutcome {
                run_id: Some(sent.run_id.to_string()),
                queued: sent.queued,
            },
            _ => SendOutcome {
                run_id: Some(run_id),
                queued: false,
            },
        })
    }

    /// Answers the permission prompt the thread's run waits on.
    pub async fn answer(
        &self,
        r: &ThreadRef,
        request_id: &str,
        decision: PermissionDecision,
        by: Option<fleetd_contracts::time::DecidedBy>,
    ) -> Result<(), ExecutorError> {
        let op = NodeOperation::Answer;
        let call = SessionCall::Answer {
            session_id: r.thread_id.clone(),
            request_id: non_empty(&r.machine_id, op, "request id", request_id)?,
            decision,
            by,
        };
        self.call(&r.machine_id, op, call, READ_TIMEOUT).await?;
        Ok(())
    }

    /// The prompt the thread's run waits on now, from the machine stream.
    pub fn pending_permission(&self, r: &ThreadRef) -> Option<PendingPermission> {
        self.tracked(r)?.pending
    }

    pub async fn interrupt(
        self: &Arc<Self>,
        r: &ThreadRef,
        _client_request_id: &str,
    ) -> Result<(), ExecutorError> {
        let tracked = self.tracked(r);
        // Known idle: nothing to interrupt. Unknown: let the node decide.
        if tracked.as_ref().is_some_and(|t| t.active_run_id.is_none()) {
            return Ok(());
        }
        let call = SessionCall::Interrupt {
            session_id: r.thread_id.clone(),
            run_id: tracked
                .and_then(|t| t.active_run_id)
                .map(NonEmpty::unchecked),
            reason: Some("interrupted through fleetd".into()),
        };
        self.call(&r.machine_id, NodeOperation::Interrupt, call, READ_TIMEOUT)
            .await?;
        Ok(())
    }

    /// A person's Stop: interrupts whatever run the thread has now. [`Self::interrupt`] names the run it tracks, and
    /// the node ignores a name that is no longer its active run (a message sent just as a turn started).
    pub async fn interrupt_now(&self, r: &ThreadRef) -> Result<(), ExecutorError> {
        let call = SessionCall::Interrupt {
            session_id: r.thread_id.clone(),
            run_id: None,
            reason: Some("stopped by the person".into()),
        };
        self.call(&r.machine_id, NodeOperation::Interrupt, call, READ_TIMEOUT)
            .await?;
        Ok(())
    }

    /// Ends the thread's claude process; `Ok` only once the node saw it exit (it escalates to SIGKILL).
    /// `remove_worktree` then deletes its worktree, and its branch once merged.
    pub async fn stop(&self, r: &ThreadRef, remove_worktree: bool) -> Result<(), ExecutorError> {
        let call = SessionCall::Stop {
            session_id: r.thread_id.clone(),
            remove_worktree,
        };
        self.call(&r.machine_id, NodeOperation::Stop, call, STOP_TIMEOUT)
            .await?;
        Ok(())
    }

    /// The items and messages around `item_id`, oldest first, read from the node's own log, and the index of the
    /// item among them.
    pub async fn window(
        &self,
        r: &ThreadRef,
        item_id: &str,
        before: u64,
        after: u64,
    ) -> Result<(Vec<TailRow>, Option<u64>), ExecutorError> {
        let op = NodeOperation::Read;
        let call = SessionCall::Window {
            session_id: r.thread_id.clone(),
            item_id: non_empty(&r.machine_id, op, "item id", item_id)?,
            before: fleetd_contracts::prim::Int::try_from(before.min(25) as i64)
                .unwrap_or_default(),
            after: fleetd_contracts::prim::Int::try_from(after.min(25) as i64).unwrap_or_default(),
        };
        let SessionOutput::Window { entries, focus } =
            self.call(&r.machine_id, op, call, READ_TIMEOUT).await?
        else {
            return Ok((Vec::new(), None));
        };
        let rows = entries
            .into_iter()
            .filter_map(|e| match e {
                fleetd_contracts::sessions::WindowEntry::Item(item) => {
                    thread_view::to_action(&item).map(|action| TailRow::Action {
                        at: item.started_at.to_string(),
                        action,
                    })
                }
                fleetd_contracts::sessions::WindowEntry::Message(m) => Some(TailRow::Message {
                    at: m.created_at.to_string(),
                    role: serde_json::to_value(m.role)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_else(|| "assistant".into()),
                    text: crate::hub::api::clip(&m.text, 2000),
                }),
            })
            .collect();
        Ok((rows, focus))
    }

    /// Wires the time area: subscribes ask nodes for their span outbox from the hub's cursor.
    pub fn set_time(&self, time: Arc<crate::hub::time::Time>) {
        let _ = self.time.set(time);
    }

    /// Newest first. `kinds` are "message" and "action"; none means both.
    pub async fn tail(
        self: &Arc<Self>,
        r: &ThreadRef,
        n: usize,
        kinds: Option<&[&str]>,
    ) -> Result<Tail, ExecutorError> {
        let summary = self.summary_of(r)?;
        let w = self.view(r).await?;
        let (rows, truncated) = thread_view::tail_of(&w.state.lock().unwrap().view, n, kinds);
        let action_ids: Vec<String> = rows
            .iter()
            .filter(|(_, row)| matches!(row, TailRow::Action { .. }))
            .map(|(id, _)| id.clone())
            .collect();
        self.fill_outputs(r, &w, &action_ids).await?;
        let state = w.state.lock().unwrap();
        let items = rows
            .into_iter()
            .map(|(id, row)| match row {
                TailRow::Action { at, action } => {
                    let action = state
                        .view
                        .items
                        .get(&id)
                        .and_then(thread_view::to_action)
                        .unwrap_or(action);
                    TailRow::Action { at, action }
                }
                message => message,
            })
            .collect();
        let thread = shell_mapper::with_assistant_text(
            &summary,
            thread_view::latest_assistant_text(&state.view).as_deref(),
        );
        Ok(Tail {
            items,
            thread,
            truncated,
        })
    }

    /// A page of the session's steps for the agents view, newest first: those strictly older than `before`
    /// (`(at, id)`), at most `limit`, with whether older ones remain. Read from the followed view (the node's newest
    /// window plus live events), with cut outputs of the page's actions filled in.
    pub async fn work(
        self: &Arc<Self>,
        r: &ThreadRef,
        before: Option<(&str, &str)>,
        limit: usize,
    ) -> Result<Work, ExecutorError> {
        let summary = self.summary_of(r)?;
        let w = self.view(r).await?;
        let (rows, more) = {
            let state = w.state.lock().unwrap();
            thread_view::work_page(&state.view, before, limit)
        };
        let ids: Vec<String> = rows
            .iter()
            .filter(|(_, row)| matches!(row, TailRow::Action { .. }))
            .map(|(id, _)| id.clone())
            .collect();
        self.fill_outputs(r, &w, &ids).await?;
        let state = w.state.lock().unwrap();
        let rows = rows
            .into_iter()
            .map(|(id, row)| match row {
                TailRow::Action { at, action } => {
                    let action = state
                        .view
                        .items
                        .get(&id)
                        .and_then(thread_view::to_action)
                        .unwrap_or(action);
                    (id, TailRow::Action { at, action })
                }
                message => (id, message),
            })
            .collect();
        Ok(Work {
            rows,
            more,
            running: summary.status == "running",
        })
    }

    /// The session's messages as its view holds them, oldest first (the lead chat mirrors the lead's replies).
    pub async fn messages(
        self: &Arc<Self>,
        r: &ThreadRef,
    ) -> Result<Vec<fleetd_contracts::sessions::ThreadMessage>, ExecutorError> {
        self.summary_of(r)?;
        let w = self.view(r).await?;
        let state = w.state.lock().unwrap();
        let mut messages: Vec<_> = state.view.messages.values().cloned().collect();
        messages.sort_by(|a, b| {
            (a.created_at.as_str(), a.id.as_str()).cmp(&(b.created_at.as_str(), b.id.as_str()))
        });
        Ok(messages)
    }

    /// Newest first.
    pub async fn actions(
        self: &Arc<Self>,
        r: &ThreadRef,
        limit: usize,
        failed_only: bool,
    ) -> Result<Vec<Action>, ExecutorError> {
        self.summary_of(r)?;
        let w = self.view(r).await?;
        let picked = thread_view::actions_of(&w.state.lock().unwrap().view, limit, failed_only);
        let ids: Vec<String> = picked.iter().map(|(id, _)| id.clone()).collect();
        self.fill_outputs(r, &w, &ids).await?;
        let state = w.state.lock().unwrap();
        Ok(picked
            .into_iter()
            .map(|(id, a)| {
                state
                    .view
                    .items
                    .get(&id)
                    .and_then(thread_view::to_action)
                    .unwrap_or(a)
            })
            .collect())
    }

    // ThreadWatch (watchdog)

    /// Threads whose summary says running, on machines whose node is live.
    pub fn running(&self) -> Vec<RunningThread> {
        let machines = self.machines.lock().unwrap();
        machines
            .iter()
            .filter(|(_, s)| s.live && s.link.is_some())
            .flat_map(|(machine_id, s)| {
                s.shell.threads.iter().filter_map(move |(thread_id, t)| {
                    let run = t
                        .active_run_id
                        .clone()
                        .or_else(|| t.known_run().map(str::to_owned))?;
                    (t.summary.status == "running").then(|| RunningThread {
                        thread_ref: thread_ref(machine_id, thread_id),
                        run_id: run,
                    })
                })
            })
            .collect()
    }

    /// The thread as last seen: its status ("running", "waiting", "idle", "completed", "failed", "interrupted"),
    /// model and effort.
    pub fn thread_summary(&self, r: &ThreadRef) -> Option<Summary> {
        Some(self.tracked(r)?.summary)
    }

    /// The session's latest run as last seen; None for an unknown thread.
    pub fn latest_run(&self, r: &ThreadRef) -> Option<LatestRun> {
        let t = self.tracked(r)?;
        Some(LatestRun {
            run_id: t
                .active_run_id
                .clone()
                .or_else(|| t.known_run().map(str::to_owned)),
            running: t.summary.status == "running",
        })
    }

    /// What the node rebuilt the session's worktree from the last time it was gone, and when, as last seen.
    pub fn recreated_from(&self, r: &ThreadRef) -> Option<(WorktreeSource, Option<String>)> {
        self.tracked(r)?.recreated_from
    }

    /// The run the session is on as last seen: its active run once it has started, else its latest run. A send queued
    /// behind the active run is not it. None while the active run is still queued or starting, or for an unknown
    /// thread.
    pub fn started_run(&self, r: &ThreadRef) -> Option<String> {
        let t = self.tracked(r)?;
        match &t.active_run_id {
            Some(_) if t.active_run_starting => None,
            Some(active) => Some(active.clone()),
            None => t.known_run().map(str::to_owned),
        }
    }

    /// Follows the session if needed and keeps following until `release`.
    pub async fn follow(self: &Arc<Self>, r: &ThreadRef) -> Result<(), ExecutorError> {
        let w = self.view(r).await?;
        w.state.lock().unwrap().pinned = true;
        Ok(())
    }

    /// The follow then ends 60 s from now unless something reads it.
    pub fn release(&self, r: &ThreadRef) {
        let w = self
            .machines
            .lock()
            .unwrap()
            .get(&r.machine_id)
            .and_then(|s| s.watches.get(r.thread_id.as_str()).cloned());
        if let Some(w) = w {
            let mut s = w.state.lock().unwrap();
            s.pinned = false;
            s.last_used_ms = self.now_ms();
        }
    }

    /// None when the session is not followed (never followed, or its link dropped).
    pub fn progress(&self, r: &ThreadRef) -> Option<Progress> {
        let (w, active) = {
            let machines = self.machines.lock().unwrap();
            let slot = machines.get(&r.machine_id)?;
            let w = slot.watches.get(r.thread_id.as_str())?.clone();
            (
                w,
                slot.shell
                    .threads
                    .get(r.thread_id.as_str())
                    .and_then(|t| t.active_run_id.clone()),
            )
        };
        let s = w.state.lock().unwrap();
        if !s.view.ready {
            return None;
        }
        Some(Progress {
            last_frame_ms: s.last_frame_ms,
            tool: thread_view::open_tool(&s.view, active.as_deref()),
        })
    }

    /// Follows a session the moment a run of it is active, and lets the follow idle out once none is, so the live
    /// lanes see its tool calls, text and usage from the start. The watchdog follows running threads too, but only on
    /// its 30 s pass: a short task would end before it, and every lane would only say "waiting on the model".
    fn follow_active(self: &Arc<Self>, machine_id: &MachineId, event: &MachineEvent) {
        let sessions: Vec<&SessionSummary> = match event {
            MachineEvent::Snapshot { sessions, .. } => sessions.iter().collect(),
            MachineEvent::SessionUpdated(s) => vec![s],
            _ => return,
        };
        for s in sessions {
            let active = s.active_run_id.is_some()
                || matches!(s.status, SessionStatus::Running | SessionStatus::Waiting);
            let r = thread_ref(machine_id, s.session_id.as_str());
            let watched = self
                .machines
                .lock()
                .unwrap()
                .get(machine_id)
                .and_then(|slot| slot.watches.get(r.thread_id.as_str()).cloned());
            match (active, watched) {
                (true, Some(w)) => w.state.lock().unwrap().pinned = true,
                (true, None) => {
                    let this = Arc::clone(self);
                    tokio::spawn(async move {
                        if let Err(error) = this.follow(&r).await {
                            tracing::debug!(%error, "executor: active session not followed");
                        }
                    });
                }
                (false, Some(_)) => self.release(&r),
                (false, None) => {}
            }
        }
    }

    /// A session whose model claude refused runs on its profile's own: the settings that chose that model are marked
    /// refused, so new agents run as if they were unset and Settings says why.
    fn flag_refused(&self, machine_id: &MachineId, event: &MachineEvent) {
        let sessions: Vec<&SessionSummary> = match event {
            MachineEvent::Snapshot { sessions, .. } => sessions.iter().collect(),
            MachineEvent::SessionUpdated(s) => vec![s],
            _ => return,
        };
        for s in sessions {
            let Some(model) = &s.model_refused else {
                continue;
            };
            let why = format!(
                "claude on {machine_id} refused {model} at {}: agents run on {} instead until you set this again.",
                s.created_at, s.model
            );
            match self
                .store
                .db()
                .profile_settings()
                .refuse(model, s.created_at.as_str(), &why)
            {
                Ok(true) => {
                    tracing::warn!(%machine_id, %model, "claude refused a profile's model; flagged")
                }
                Ok(false) => {}
                Err(e) => tracing::warn!(error = %e, "a refused model was not flagged"),
            }
        }
    }

    /// The live parts of a followed thread's lane at the hub's `now`; None when nobody follows it (it is not running,
    /// or its machine is unlinked).
    pub fn live(&self, r: &ThreadRef) -> Option<LiveParts> {
        let w = self
            .machines
            .lock()
            .unwrap()
            .get(&r.machine_id)?
            .watches
            .get(r.thread_id.as_str())?
            .clone();
        let now = self.now_ms() as i64;
        let s = w.state.lock().unwrap();
        if !s.view.ready {
            return None;
        }
        Some(LiveParts {
            activity: s.activity.now(now),
            tokens: s.activity.tokens(),
            spark: s.activity.spark(now),
            text: s.activity.text().cloned(),
            done: s.activity.done().to_vec(),
            run_active: s.activity.run_active(),
        })
    }

    /// Where a session's paths are relative to: its worktree, else its project's workspace root.
    fn session_root(&self, machine_id: &MachineId, event: &ThreadEvent) -> Option<String> {
        let ThreadEvent::Snapshot(snap) = event else {
            return None;
        };
        snap.summary.worktree_path.clone().or_else(|| {
            let machines = self.machines.lock().unwrap();
            machines
                .get(machine_id)?
                .shell
                .projects
                .get(snap.summary.project_id.as_str())
                .map(|p| p.workspace_root.clone())
        })
    }

    // Runner and projects (usage, reviews, the doctor, project_add)

    /// The node's runner: version, login and conformance.
    pub async fn runner_info(&self, machine_id: &MachineId) -> Result<RunnerInfo, ExecutorError> {
        match self
            .call(
                machine_id,
                NodeOperation::Read,
                SessionCall::RunnerInfo,
                READ_TIMEOUT,
            )
            .await?
        {
            SessionOutput::RunnerInfo(info) => {
                self.remember_runner(machine_id, &info);
                Ok(info)
            }
            _ => Err(failed(
                machine_id,
                NodeOperation::Read,
                "the node sent no runner info",
            )),
        }
    }

    /// The project already registered at `workspace_root`, if any.
    pub fn project_at(&self, machine_id: &MachineId, workspace_root: &str) -> Option<ProjectId> {
        let machines = self.machines.lock().unwrap();
        let from_shell = machines.get(machine_id).and_then(|s| {
            s.shell
                .projects
                .iter()
                .find(|(_, p)| p.workspace_root == workspace_root)
                .map(|(id, _)| ProjectId::unchecked(id.as_str()))
        });
        drop(machines);
        from_shell.or_else(|| {
            self.store
                .projects_list(Some(machine_id), None)
                .ok()?
                .into_iter()
                .find(|p| p.workspace_root == workspace_root)
                .map(|p| p.project_id)
        })
    }

    /// Registers (or renames) a project on the node; the machine stream then carries it into the cache.
    pub async fn project_upsert(
        self: &Arc<Self>,
        machine_id: &MachineId,
        project_id: &ProjectId,
        title: &str,
        workspace_root: &str,
    ) -> Result<(), ExecutorError> {
        let op = NodeOperation::Project;
        let call = SessionCall::ProjectUpsert {
            project_id: project_id.clone(),
            title: non_empty(machine_id, op, "title", title)?,
            workspace_root: non_empty(machine_id, op, "path", workspace_root)?,
        };
        self.call(machine_id, op, call, READ_TIMEOUT).await?;
        Ok(())
    }

    /// Registers a project in `folder`, a path under the node's home that the node makes when missing: a Navi's.
    /// Returns the folder's absolute path. Only to a node listing `CAP_ASSISTANT`.
    pub async fn project_folder(
        self: &Arc<Self>,
        machine_id: &MachineId,
        project_id: &ProjectId,
        title: &str,
        folder: &str,
    ) -> Result<String, ExecutorError> {
        let op = NodeOperation::Project;
        let call = SessionCall::ProjectUpsert {
            project_id: project_id.clone(),
            title: non_empty(machine_id, op, "title", title)?,
            workspace_root: non_empty(machine_id, op, "folder", folder)?,
        };
        match self.call(machine_id, op, call, READ_TIMEOUT).await? {
            SessionOutput::Folder { path } => Ok(path),
            _ => Err(failed(
                machine_id,
                op,
                "the node did not say where the folder is",
            )),
        }
    }

    /// `remove_worktrees` only to a node listing `CAP_PROJECT_SETTINGS`.
    pub async fn project_remove(
        &self,
        machine_id: &MachineId,
        project_id: &ProjectId,
        remove_worktrees: bool,
    ) -> Result<(), ExecutorError> {
        let call = SessionCall::ProjectRemove {
            project_id: project_id.clone(),
            remove_worktrees,
        };
        self.call(machine_id, NodeOperation::Project, call, REMOVE_TIMEOUT)
            .await?;
        Ok(())
    }

    /// Sets and removes the project's environment variables on its node; the fingerprint of each secret it saved.
    /// Only to a node listing `CAP_PROJECT_SETTINGS`.
    pub async fn project_env(
        &self,
        machine_id: &MachineId,
        project_id: &ProjectId,
        set: Vec<fleetd_contracts::project_settings::EnvVarSet>,
        remove: Vec<fleetd_contracts::project_settings::EnvVarName>,
    ) -> Result<Vec<fleetd_contracts::project_settings::EnvSecretSaved>, ExecutorError> {
        let op = NodeOperation::Project;
        let call = SessionCall::ProjectEnv {
            project_id: project_id.clone(),
            set,
            remove,
        };
        match self.call(machine_id, op, call, READ_TIMEOUT).await? {
            SessionOutput::ProjectEnv { secrets } => Ok(secrets),
            _ => Err(failed(
                machine_id,
                op,
                "the node sent no answer to project_env",
            )),
        }
    }

    /// Copies project `from`'s environment variables into `to`'s on their node, secrets included. Only to a node
    /// listing `CAP_PROJECT_ENV_COPY`.
    pub async fn project_env_copy(
        &self,
        machine_id: &MachineId,
        from: &ProjectId,
        to: &ProjectId,
    ) -> Result<(), ExecutorError> {
        let call = SessionCall::ProjectEnvCopy {
            from: from.clone(),
            to: to.clone(),
        };
        self.call(machine_id, NodeOperation::Project, call, READ_TIMEOUT)
            .await?;
        Ok(())
    }

    /// Has the node forget the variables delivered for a closed order, or only `name` while it still holds the value
    /// `fingerprint` names. Only to a node listing `CAP_ORDER_ENV`.
    pub async fn order_env_drop(
        &self,
        machine_id: &MachineId,
        project_id: &ProjectId,
        order_id: &fleetd_contracts::ledger::WorkstreamId,
        name: Option<(
            fleetd_contracts::project_settings::EnvVarName,
            fleetd_contracts::secrets::SecretFingerprint,
        )>,
    ) -> Result<(), ExecutorError> {
        let (name, fingerprint) = name.unzip();
        let call = SessionCall::OrderEnvDrop {
            project_id: project_id.clone(),
            order_id: order_id.clone(),
            name,
            fingerprint,
        };
        self.call(machine_id, NodeOperation::Project, call, READ_TIMEOUT)
            .await?;
        Ok(())
    }

    /// Where the project's worktrees live on its node and which are there. Only to a node listing
    /// `CAP_PROJECT_SETTINGS`.
    pub async fn project_worktrees(
        &self,
        machine_id: &MachineId,
        project_id: &ProjectId,
    ) -> Result<fleetd_contracts::project_settings::ProjectWorktrees, ExecutorError> {
        let op = NodeOperation::Read;
        let call = SessionCall::ProjectWorktrees {
            project_id: project_id.clone(),
        };
        match self.call(machine_id, op, call, READ_TIMEOUT).await? {
            SessionOutput::ProjectWorktrees(w) => Ok(w),
            _ => Err(failed(machine_id, op, "the node sent no worktrees")),
        }
    }

    /// Replaces the secrets the node keeps for one MCP server; the fingerprint of each it saved. Only to a node listing
    /// `CAP_MCP_SERVERS`.
    pub async fn mcp_secrets(
        &self,
        machine_id: &MachineId,
        scope: fleetd_contracts::mcp_servers::McpSecretScope,
        server: fleetd_contracts::mcp_servers::McpServerName,
        set: Vec<fleetd_contracts::mcp_servers::McpSecretSet>,
        keep: Vec<fleetd_contracts::mcp_servers::McpSecretKey>,
    ) -> Result<Vec<fleetd_contracts::mcp_servers::McpSecretSaved>, ExecutorError> {
        let op = NodeOperation::Project;
        let call = SessionCall::McpSecrets {
            scope,
            server,
            set,
            keep,
        };
        match self.call(machine_id, op, call, READ_TIMEOUT).await? {
            SessionOutput::McpSecrets { secrets } => Ok(secrets),
            _ => Err(failed(
                machine_id,
                op,
                "the node sent no answer to mcp_secrets",
            )),
        }
    }

    /// Has the node start or reach an MCP server and list its tools. Only to a node listing `CAP_MCP_SERVERS`.
    pub async fn mcp_test(
        &self,
        machine_id: &MachineId,
        project_id: Option<ProjectId>,
        server: fleetd_contracts::mcp_servers::McpSessionServer,
    ) -> Result<fleetd_contracts::mcp_servers::McpTestResult, ExecutorError> {
        let op = NodeOperation::Read;
        let call = SessionCall::McpTest { project_id, server };
        match self.call(machine_id, op, call, MCP_TEST_TIMEOUT).await? {
            SessionOutput::McpTested(result) => Ok(result),
            _ => Err(failed(machine_id, op, "the node sent no test result")),
        }
    }

    // WorkspaceFiles, ThreadWorkspace (leads, tasks)

    fn project_for_root(
        &self,
        machine_id: &MachineId,
        cwd: &str,
    ) -> Result<ProjectId, ExecutorError> {
        self.project_at(machine_id, cwd).ok_or_else(|| {
            failed(
                machine_id,
                NodeOperation::Read,
                format!("no project on {machine_id} has its workspace root at {cwd}"),
            )
        })
    }

    /// A file of the project by its id, which the node knows as soon as `project_upsert` returns. None when the
    /// file does not exist.
    pub async fn read_project_file(
        &self,
        machine_id: &MachineId,
        project_id: &ProjectId,
        relative_path: &str,
    ) -> Result<Option<String>, ExecutorError> {
        let op = NodeOperation::Read;
        let call = SessionCall::ReadFile {
            project_id: project_id.clone(),
            path: non_empty(machine_id, op, "path", relative_path)?,
        };
        match self.call(machine_id, op, call, READ_TIMEOUT).await? {
            SessionOutput::File { contents } => Ok(contents),
            _ => Err(failed(machine_id, op, "the node sent no file")),
        }
    }

    /// The project's files best matching `query`, repo-relative.
    pub async fn list_files(
        &self,
        r: &ProjectRef,
        query: &str,
        limit: i64,
    ) -> Result<(Vec<String>, bool), ExecutorError> {
        let op = NodeOperation::Read;
        let call = SessionCall::ListFiles {
            project_id: r.project_id.clone(),
            query: fleetd_contracts::prim::Text::unchecked(js_take(query, 200)),
            limit: fleetd_contracts::prim::Int::unchecked(limit.clamp(1, 50)),
        };
        match self.call(&r.machine_id, op, call, READ_TIMEOUT).await? {
            SessionOutput::Files { paths, truncated } => Ok((paths, truncated)),
            _ => Err(failed(&r.machine_id, op, "the node sent no file list")),
        }
    }

    /// The skills in the project's checkout (`.agents/skills`, `.claude/skills`). Only for a node listing
    /// `CAP_SKILLS`.
    pub async fn list_repo_skills(
        &self,
        r: &ProjectRef,
    ) -> Result<Vec<fleetd_contracts::skills::RepoSkill>, ExecutorError> {
        let op = NodeOperation::Read;
        let call = SessionCall::SkillsList {
            project_id: r.project_id.clone(),
        };
        match self.call(&r.machine_id, op, call, READ_TIMEOUT).await? {
            SessionOutput::Skills { skills } => Ok(skills),
            _ => Err(failed(&r.machine_id, op, "the node sent no skills")),
        }
    }

    /// Writes a file under the project's `.fleetd/attachments/`.
    pub async fn put_file(
        &self,
        r: &ProjectRef,
        rel_path: &str,
        data_b64: String,
    ) -> Result<(), ExecutorError> {
        let op = NodeOperation::Project;
        let call = SessionCall::PutFile {
            project_id: r.project_id.clone(),
            rel_path: non_empty(&r.machine_id, op, "path", rel_path)?,
            data_b64: non_empty(&r.machine_id, op, "file", &data_b64)?,
        };
        // A minute, and a second more per half MiB: a 25 MiB file has two minutes on a slow link.
        let wait = Duration::from_secs(60 + data_b64.len() as u64 / (512 * 1024));
        self.call(&r.machine_id, op, call, wait).await.map(|_| ())
    }

    /// The repo's default branch at `cwd`, else its current branch; `None` when it has neither (not a checkout) or no
    /// commit yet (a new repo).
    pub async fn default_branch(
        &self,
        machine_id: &MachineId,
        cwd: &str,
    ) -> Result<Option<String>, ExecutorError> {
        let op = NodeOperation::Read;
        let call = SessionCall::DefaultBranch {
            project_id: self.project_for_root(machine_id, cwd)?,
        };
        match self.call(machine_id, op, call, READ_TIMEOUT).await? {
            SessionOutput::DefaultBranch { branch } => Ok(branch),
            _ => Err(failed(machine_id, op, "the node sent no default branch")),
        }
    }

    pub async fn changes(&self, r: &ThreadRef) -> Result<ThreadChanges, ExecutorError> {
        let op = NodeOperation::Read;
        let call = SessionCall::Changes {
            session_id: r.thread_id.clone(),
        };
        match self.call(&r.machine_id, op, call, READ_TIMEOUT).await? {
            SessionOutput::Changes(c) => Ok(ThreadChanges {
                branch: c.branch,
                worktree_path: c.worktree_path,
                paths: c.paths,
                pull_request_urls: vec![],
            }),
            _ => Err(failed(&r.machine_id, op, "the node sent no changes")),
        }
    }

    /// What the thread is waiting on a human for, if anything: its open permission prompt.
    pub async fn pending_question(&self, r: &ThreadRef) -> Result<Option<String>, ExecutorError> {
        Ok(self
            .tracked(r)
            .and_then(|t| t.pending)
            .map(|p| thread_view::pending_question_text(&p)))
    }
}
