//! The node session service: runs the hub's sessions on this machine through a [`Runner`] (one `claude` process per
//! live session) and answers the hub's `session_call` frames, one `session_reply` each, plus the machine and thread
//! streams.
//!
//! Everything durable is in [`NodeStore`], written before it is sent, so a node restart or crash loses no session:
//! on start, runs that were active are closed as interrupted (the hub's watchdog decides whether to continue them)
//! and the next `send` resumes the claude session in the same cwd and config dir. Idle processes are reaped and
//! respawned on demand. Permission prompts are answered from policy or held as a pending approval for the hub.
mod proc;
pub mod state;
pub mod t3;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use fleetd_contracts::ids::{ProjectId, ThreadId, Timestamp};
use fleetd_contracts::prim::{NonEmpty, Text};
use fleetd_contracts::sessions::{
    FailureClass, ItemKind, ItemStatus, MachineEvent, MachineEventFrame, MessageRole,
    PendingPermission, PermissionDecision, ProjectInfo, RunFailure, RunInfo, RunStatus,
    SendAccepted, SessionCall, SessionCallFrame, SessionChanges, SessionError, SessionErrorCode,
    SessionLaunch, SessionOutput, SessionReplyFrame, SessionResult, SessionStatus, SessionSummary,
    SessionWorkspace, ThreadEvent, ThreadEventFrame, ThreadItem, ThreadMessage, ThreadSnapshot,
};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

pub use t3::{CliSessions, SessionKeeper, T3Sessions};

use super::runner::claude::ALWAYS_DISALLOWED;
use super::runner::{
    ExitInfo, RunOutcome, Runner, RunnerError, RunnerEvent, SessionCommand, SessionSpec,
};
use super::store::{NodeStore, SessionLocal, SessionRow, StoreError};
use super::util::{now_iso, tail_utf16};
use super::wire::{NodeToHub, head_text, to_json};
use super::worktree;
use state::EndCause;

/// What the node sends after a retryable failure (Overloaded, Network) to continue the same run.
pub const CONTINUE_PROMPT: &str = "Continue where you left off.";
/// Only servers fleetd lists load (`--strict-mcp-config`); user and repo `.mcp.json` servers never leak in.
const MCP_CONFIG: &str = "{\"mcpServers\":{}}\n";
const SNAPSHOT_WINDOW: usize = 200;
const TRANSCRIPT_CAP: u64 = 20 * 1024 * 1024;
const DELTA_EVERY: Duration = Duration::from_millis(100);
/// An interrupt claude has not honoured by then escalates to SIGTERM, then SIGKILL.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);
/// `stop`: stdin closed, SIGTERM after this.
const STOP_GRACE: Duration = Duration::from_secs(5);
/// An idle process gets stdin closed, and SIGTERM after this if it is still there.
const REAP_GRACE: Duration = Duration::from_secs(10);
const EXIT_WAIT: Duration = Duration::from_secs(20);
/// Node shutdown: how long interrupted runs get to end before every process is closed.
const SHUTDOWN_DRAIN: Duration = Duration::from_secs(10);

/// Where sessions live and what their processes get.
#[derive(Clone, Debug)]
pub struct SessionConfig {
    /// The node home: `worktrees/`, `sessions/<id>/` (the MCP config) and `transcripts/` live here.
    pub home: PathBuf,
    /// `CLAUDE_CONFIG_DIR` for every session: the machine's fleetd login.
    pub config_dir: PathBuf,
    /// `KEY=VALUE` lines (the login or gateway variables) added to every session's environment, re-read per spawn.
    pub claude_env: PathBuf,
    /// HOME, PATH, USER, LANG and the git identity; nothing else of the node's environment reaches claude.
    pub base_env: Vec<(String, String)>,
    pub idle_reap: Duration,
    /// The node's own retries of a run that failed Overloaded or Network, after claude's internal retries.
    pub retry_schedule_ms: Vec<u64>,
}

impl SessionConfig {
    /// `~/.fleetd/{claude,claude.env}` from `$HOME`, so a lab node with its own HOME needs no flag.
    /// `FLEETD_NODE_IDLE_REAP_SEC` and `FLEETD_NODE_RETRY_SCHEDULE_MS` (e.g. `500,1000,2000`) exist for tests and
    /// the lab only.
    pub fn for_node(home: &Path) -> Self {
        let fleetd = super::util::home_dir().join(".fleetd");
        let mut base_env = super::util::scrubbed_env();
        for key in [
            "GIT_AUTHOR_NAME",
            "GIT_AUTHOR_EMAIL",
            "GIT_COMMITTER_NAME",
            "GIT_COMMITTER_EMAIL",
        ] {
            if let Ok(value) = std::env::var(key) {
                base_env.push((key.to_owned(), value));
            }
        }
        let idle_reap = std::env::var("FLEETD_NODE_IDLE_REAP_SEC")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .map_or(Duration::from_secs(600), Duration::from_secs);
        let retry_schedule_ms = std::env::var("FLEETD_NODE_RETRY_SCHEDULE_MS")
            .ok()
            .and_then(|s| {
                s.split(',')
                    .map(|n| n.trim().parse().ok())
                    .collect::<Option<Vec<u64>>>()
            })
            .unwrap_or_else(|| vec![60_000, 240_000, 900_000]);
        Self {
            home: home.to_path_buf(),
            config_dir: fleetd.join("claude"),
            claude_env: fleetd.join("claude.env"),
            base_env,
            idle_reap,
            retry_schedule_ms,
        }
    }
}

/// `KEY=VALUE` lines; blank lines, `#` comments and an `export ` prefix are allowed, and one pair of matching quotes
/// around a value is removed.
/// What claude's login depends on, read fresh each time (the user may have just edited claude.env): the base env,
/// claude.env, then fleetd's config dir. Every spawn starts from it, and the probe uses exactly it.
fn claude_env(config: &SessionConfig) -> Vec<(String, String)> {
    let mut env = config.base_env.clone();
    if let Ok(text) = std::fs::read_to_string(&config.claude_env) {
        env.extend(parse_env_file(&text));
    }
    env.push((
        "CLAUDE_CONFIG_DIR".to_owned(),
        config.config_dir.to_string_lossy().into_owned(),
    ));
    env
}

pub fn parse_env_file(text: &str) -> Vec<(String, String)> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let l = l.strip_prefix("export ").unwrap_or(l);
            let (key, value) = l.split_once('=')?;
            let value = value.trim();
            let unquoted = [('"', '"'), ('\'', '\'')]
                .iter()
                .find_map(|(a, b)| value.strip_prefix(*a)?.strip_suffix(*b))
                .unwrap_or(value);
            Some((key.trim().to_owned(), unquoted.to_owned()))
        })
        .filter(|(k, _)| !k.is_empty())
        .collect()
}

type Reply = Result<SessionOutput, SessionError>;

fn error(code: SessionErrorCode, message: impl AsRef<str>) -> SessionError {
    let message = message.as_ref();
    SessionError {
        code,
        message: head_text(if message.is_empty() {
            "failed"
        } else {
            message
        }),
        fix: None,
    }
}

fn not_found(message: impl AsRef<str>) -> SessionError {
    error(SessionErrorCode::NotFound, message)
}

fn invalid(message: impl AsRef<str>) -> SessionError {
    error(SessionErrorCode::Invalid, message)
}

impl From<StoreError> for SessionError {
    fn from(e: StoreError) -> Self {
        error(SessionErrorCode::Internal, format!("node store: {e}"))
    }
}

impl From<worktree::GitError> for SessionError {
    fn from(e: worktree::GitError) -> Self {
        error(SessionErrorCode::Git, e.0)
    }
}

fn runner_error(e: RunnerError) -> SessionError {
    let fix = match &e {
        RunnerError::Missing { .. } | RunnerError::UnsupportedVersion { .. } => Some(
            "Install a supported claude: curl -fsSL https://claude.ai/install.sh | bash".into(),
        ),
        _ => None,
    };
    SessionError {
        fix,
        ..error(SessionErrorCode::RunnerUnavailable, e.to_string())
    }
}

/// Ids become path components (worktrees, transcripts), so they are kept to a safe alphabet.
fn path_safe(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !id.starts_with('.')
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(f)
        .await
        .expect("blocking git task panicked")
}

fn now() -> Timestamp {
    Timestamp::from(now_iso())
}

/// A v4 UUID for a node retry's user message, which claude echoes as the run's lifecycle id.
fn new_uuid() -> String {
    let b: [u8; 16] = rand::random();
    let hex: String = b
        .iter()
        .enumerate()
        .map(|(i, x)| match i {
            6 => format!("{:02x}", (x & 0x0f) | 0x40),
            8 => format!("{:02x}", (x & 0x3f) | 0x80),
            _ => format!("{x:02x}"),
        })
        .collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn permission_item_id(request_id: &str) -> String {
    format!("permission-{request_id}")
}

/// One live claude process.
struct Live {
    generation: u64,
    pid: u32,
    commands: mpsc::Sender<SessionCommand>,
    last_active: Instant,
    /// Set when someone asked the process's run to end (interrupt, stop, node shutdown): an exit then interrupts
    /// rather than fails the run.
    ending: Option<String>,
    /// A shutdown was sent: a new command waits for the exit and respawns.
    closing: bool,
    /// claude's user-message uuid → fleetd run id, for node retries sent under a fresh uuid.
    aliases: HashMap<String, String>,
    exited: watch::Receiver<bool>,
}

#[derive(Default)]
struct State {
    outlet: Option<(u64, mpsc::UnboundedSender<String>)>,
    next_outlet: u64,
    next_generation: u64,
    subscribed: bool,
    followed: HashSet<String>,
    live: HashMap<String, Live>,
    stopping: bool,
    /// Node retries done per run.
    retries: HashMap<String, u32>,
}

impl State {
    fn send(&self, frame: NodeToHub) {
        if let Some((_, tx)) = &self.outlet {
            let _ = tx.send(to_json(&frame));
        }
    }

    fn machine(&self, frame: MachineEventFrame) {
        if self.subscribed {
            self.send(NodeToHub::MachineEvent(frame));
        }
    }

    fn thread(&self, session_id: &str, event: ThreadEvent) {
        if self.followed.contains(session_id) {
            self.send(NodeToHub::ThreadEvent(ThreadEventFrame {
                session_id: ThreadId::unchecked(session_id),
                at: now(),
                event,
            }));
        }
    }
}

struct Inner {
    store: NodeStore,
    runner: Arc<dyn Runner>,
    config: SessionConfig,
    /// Store writes and sends happen under this lock, so a subscribe or follow sees each change exactly once.
    state: Mutex<State>,
    /// One spawn at a time, so two sends never start two processes for a session.
    spawning: tokio::sync::Mutex<()>,
    launching: tokio::sync::Mutex<()>,
}

/// One session's pending change, applied by [`SessionService::update`].
struct Change<'a> {
    row: SessionRow,
    runs: Vec<RunInfo>,
    events: Vec<ThreadEvent>,
    store: &'a NodeStore,
    at: Timestamp,
    /// Announce the summary even when nothing in it changed: progress the watchdog should see.
    announce: bool,
}

impl Change<'_> {
    fn id(&self) -> String {
        self.row.summary.session_id.to_string()
    }

    fn run_mut(&mut self, id: &str) -> Option<&mut RunInfo> {
        self.runs.iter_mut().find(|r| r.id == id)
    }

    fn active_mut(&mut self) -> Option<&mut RunInfo> {
        self.runs.iter_mut().find(|r| r.status.is_active())
    }

    fn put_item(&mut self, item: ThreadItem) {
        if let Err(e) = self.store.put_item(&self.id(), &item) {
            tracing::warn!(error = %e, "cannot store a session item");
        }
        self.events.push(ThreadEvent::Item(state::bounded(&item)));
    }

    fn put_message(&mut self, message: ThreadMessage) {
        if let Err(e) = self.store.put_message(&self.id(), &message) {
            tracing::warn!(error = %e, "cannot store a session message");
        }
        self.events.push(ThreadEvent::Message(message));
    }

    /// Marks a prompt that can no longer be answered; the hub closes its ask.
    fn cancel_pending(&mut self) {
        let Some(pending) = self.row.summary.pending_permission.take() else {
            return;
        };
        let id = permission_item_id(&pending.request_id);
        if let Ok(Some(mut item)) = self.store.item(&self.id(), &id) {
            item.status = ItemStatus::Cancelled;
            item.completed_at = Some(self.at.clone());
            item.updated_at = self.at.clone();
            self.put_item(item);
        }
    }
}

#[derive(Clone)]
pub struct SessionService {
    inner: Arc<Inner>,
}

/// Detaches the service from a link when the link ends: the machine stream stops and follows are cleared (the hub
/// subscribes and re-follows on reconnect).
pub struct Attached {
    service: SessionService,
    outlet: u64,
}

impl Drop for Attached {
    fn drop(&mut self) {
        let mut st = self.service.st();
        if st.outlet.as_ref().is_some_and(|(id, _)| *id == self.outlet) {
            st.outlet = None;
            st.subscribed = false;
            st.followed.clear();
        }
    }
}

impl SessionService {
    /// Opens the service over `store`, settling what a previous node process left: recorded claude processes are
    /// killed (only when pid and start time still match) and their active runs closed as interrupted.
    pub async fn start(
        store: NodeStore,
        runner: Arc<dyn Runner>,
        config: SessionConfig,
    ) -> Result<Self, StoreError> {
        let service = Self {
            inner: Arc::new(Inner {
                store,
                runner,
                config,
                state: Mutex::new(State::default()),
                spawning: tokio::sync::Mutex::new(()),
                launching: tokio::sync::Mutex::new(()),
            }),
        };
        for row in service.inner.store.sessions()? {
            if let (Some(pid), Some(started)) = (row.local.pid, &row.local.pid_start) {
                proc::kill_recorded(pid, started, INTERRUPT_GRACE).await;
            }
            let leftover = row.local.pid.is_some()
                || row.summary.active_run_id.is_some()
                || row.summary.pending_permission.is_some();
            if leftover {
                let id = row.summary.session_id.to_string();
                let settled = service.update(&id, |c| {
                    state::close_out(&mut c.runs, &EndCause::NodeRestarted, &c.at);
                    c.cancel_pending();
                    c.row.local.pid = None;
                    c.row.local.pid_start = None;
                });
                if let Err(e) = settled {
                    tracing::warn!(session_id = %id, error = %e.message, "cannot settle a session on start");
                }
            }
        }
        service.spawn_reaper();
        Ok(service)
    }

    fn st(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn store(&self) -> &NodeStore {
        &self.inner.store
    }

    /// Frames from now on go to `tx` (the link's writer).
    pub fn attach(&self, tx: mpsc::UnboundedSender<String>) -> Attached {
        let mut st = self.st();
        st.next_outlet += 1;
        let outlet = st.next_outlet;
        st.outlet = Some((outlet, tx));
        st.subscribed = false;
        st.followed.clear();
        Attached {
            service: self.clone(),
            outlet,
        }
    }

    pub async fn handle(&self, frame: SessionCallFrame) -> SessionReplyFrame {
        let result = match self.call(frame.call).await {
            Ok(output) => SessionResult::Ok(output),
            Err(error) => SessionResult::Err(error),
        };
        SessionReplyFrame {
            id: frame.id,
            result,
        }
    }

    async fn call(&self, call: SessionCall) -> Reply {
        match call {
            SessionCall::ProjectUpsert {
                project_id,
                title,
                workspace_root,
            } => self.project_upsert(project_id, title.to_string(), workspace_root.to_string()),
            SessionCall::ProjectRemove { project_id } => {
                let st = self.st();
                let frame = self
                    .store()
                    .remove_project(&project_id)?
                    .ok_or_else(|| not_found(format!("no project {project_id} on this machine")))?;
                st.machine(frame);
                Ok(SessionOutput::Done)
            }
            SessionCall::Launch(launch) => self.launch(launch).await,
            SessionCall::Send {
                session_id,
                run_id,
                text,
            } => {
                let queued = self.begin_run(&session_id, &run_id, &text).await?;
                Ok(SessionOutput::Sent(SendAccepted { run_id, queued }))
            }
            SessionCall::Interrupt {
                session_id,
                run_id,
                reason,
            } => self.interrupt(&session_id, run_id.as_deref(), reason).await,
            SessionCall::Stop {
                session_id,
                remove_worktree,
            } => self.stop(&session_id, remove_worktree).await,
            SessionCall::Answer {
                session_id,
                request_id,
                decision,
            } => self.answer(&session_id, &request_id, decision).await,
            SessionCall::Subscribe { after } => self.subscribe(after),
            SessionCall::Follow { session_id } => {
                let mut st = self.st();
                let snapshot = self.snapshot(&session_id)?;
                st.followed.insert(session_id.to_string());
                st.thread(&session_id, ThreadEvent::Snapshot(snapshot));
                Ok(SessionOutput::Done)
            }
            SessionCall::Release { session_id } => {
                self.st().followed.remove(session_id.as_str());
                Ok(SessionOutput::Done)
            }
            SessionCall::ReadItem {
                session_id,
                item_id,
            } => {
                let item = self.store().item(&session_id, &item_id)?.ok_or_else(|| {
                    not_found(format!("no item {item_id} in session {session_id}"))
                })?;
                Ok(SessionOutput::Item { item })
            }
            SessionCall::ReadFile { project_id, path } => self.read_file(&project_id, &path),
            SessionCall::DefaultBranch { project_id } => {
                let root = self.project_root(&project_id)?;
                let branch = blocking(move || worktree::default_branch(&root)).await;
                Ok(SessionOutput::DefaultBranch { branch })
            }
            SessionCall::Changes { session_id } => {
                let row = self.session(&session_id)?;
                let (cwd, base_ref) = (row.local.cwd.clone(), row.local.base_ref.clone());
                let paths = if cwd.is_dir() {
                    blocking(move || worktree::changes(&cwd, base_ref.as_deref())).await?
                } else {
                    Vec::new()
                };
                Ok(SessionOutput::Changes(SessionChanges {
                    branch: row.summary.branch,
                    worktree_path: row.summary.worktree_path,
                    paths,
                }))
            }
            SessionCall::RunnerInfo => {
                let env = claude_env(&self.inner.config);
                Ok(SessionOutput::RunnerInfo(
                    self.inner.runner.probe(&env).await,
                ))
            }
        }
    }

    fn session(&self, id: &str) -> Result<SessionRow, SessionError> {
        self.store()
            .session(id)?
            .ok_or_else(|| not_found(format!("no session {id} on this machine")))
    }

    fn project_root(&self, project_id: &str) -> Result<PathBuf, SessionError> {
        let project = self
            .store()
            .project(project_id)?
            .ok_or_else(|| not_found(format!("no project {project_id} on this machine")))?;
        Ok(PathBuf::from(project.workspace_root))
    }

    /// Loads a session and its runs, applies `f`, settles the summary and commits, then sends what changed: the
    /// summary on the machine stream, items, messages and runs on the thread stream.
    fn update<R>(&self, id: &str, f: impl FnOnce(&mut Change) -> R) -> Result<R, SessionError> {
        let st = self.st();
        let row = self.session(id)?;
        let runs = self.store().runs(id)?;
        let before = (row.summary.clone(), runs.clone());
        let mut change = Change {
            row,
            runs,
            events: Vec::new(),
            store: self.store(),
            at: now(),
            announce: false,
        };
        let out = f(&mut change);
        let Change {
            mut row,
            runs,
            mut events,
            at,
            announce,
            ..
        } = change;
        state::settle(&mut row.summary, &runs, &at);
        let changed: Vec<&RunInfo> = runs.iter().filter(|r| !before.1.contains(r)).collect();
        let same_summary = {
            let mut s = row.summary.clone();
            s.updated_at = before.0.updated_at.clone();
            s == before.0
        };
        let quiet = !announce && changed.is_empty() && events.is_empty() && same_summary;
        if quiet {
            row.summary.updated_at = before.0.updated_at;
        }
        let frame = self.store().commit(&row, &changed, !quiet)?;
        events.extend(changed.into_iter().map(|r| ThreadEvent::Run(r.clone())));
        for event in events {
            st.thread(id, event);
        }
        if let Some(frame) = frame {
            st.machine(frame);
        }
        Ok(out)
    }

    fn project_upsert(&self, project_id: ProjectId, title: String, root: String) -> Reply {
        if !path_safe(&project_id) {
            return Err(invalid(format!(
                "project id {project_id} has characters a path can't hold"
            )));
        }
        let dir = Path::new(&root);
        if !dir.is_absolute() || !dir.is_dir() {
            return Err(invalid(format!(
                "{root} is not a directory on this machine"
            )));
        }
        let info = ProjectInfo {
            project_id,
            title,
            workspace_root: root,
            updated_at: now(),
        };
        let st = self.st();
        st.machine(self.store().upsert_project(&info)?);
        Ok(SessionOutput::Done)
    }

    async fn launch(&self, launch: SessionLaunch) -> Reply {
        let _launching = self.inner.launching.lock().await;
        let id = launch.session_id.to_string();
        // Idempotent: a retried launch gets the session the first one made.
        if let Some(row) = self.store().session(&id)? {
            return Ok(SessionOutput::Launched {
                summary: row.summary,
            });
        }
        if !path_safe(&id) {
            return Err(invalid(format!(
                "session id {id} has characters a path can't hold"
            )));
        }
        let root = self.project_root(&launch.project_id)?;
        let (cwd, add_dirs, base_ref, branch) = match &launch.workspace {
            SessionWorkspace::Root => (root.clone(), Vec::new(), None, None),
            SessionWorkspace::Worktree { base_ref, branch } => {
                let path = self
                    .inner
                    .config
                    .home
                    .join("worktrees")
                    .join(launch.project_id.as_str())
                    .join(&id);
                let (r, p, b, base) = (
                    root.clone(),
                    path.clone(),
                    branch.to_string(),
                    base_ref.to_string(),
                );
                blocking(move || worktree::ensure(&r, &p, &b, &base)).await?;
                (
                    path,
                    vec![root.clone()],
                    Some(base_ref.to_string()),
                    Some(branch.to_string()),
                )
            }
        };
        let at = now();
        let title = launch.title.clone().unwrap_or_else(|| {
            let first = launch.prompt.lines().next().unwrap_or_default();
            first.chars().take(80).collect()
        });
        let row = SessionRow {
            summary: SessionSummary {
                session_id: launch.session_id.clone(),
                project_id: launch.project_id.clone(),
                title,
                status: SessionStatus::Idle,
                model: launch.model.to_string(),
                effort: launch.effort,
                runtime_mode: launch.runtime_mode,
                latest_run: None,
                active_run_id: None,
                pending_permission: None,
                latest_assistant_tail: None,
                branch: branch.clone(),
                worktree_path: base_ref
                    .is_some()
                    .then(|| cwd.to_string_lossy().into_owned()),
                created_at: at.clone(),
                updated_at: at,
            },
            local: SessionLocal {
                cwd,
                add_dirs,
                config_dir: self.inner.config.config_dir.clone(),
                workspace_root: root,
                base_ref,
                branch,
                started: false,
                pid: None,
                pid_start: None,
                allowed_tools: launch.allowed_tools.clone(),
                disallowed_tools: launch.disallowed_tools.clone(),
            },
        };
        self.store().commit(&row, &[], false)?;
        self.begin_run(&id, &launch.run_id, &launch.prompt).await?;
        Ok(SessionOutput::Launched {
            summary: self.session(&id)?.summary,
        })
    }

    /// Records a run and its user message, then hands the message to the session's process (spawning or resuming
    /// it). Returns whether the run waits behind an active one. Idempotent on `run_id`.
    async fn begin_run(
        &self,
        id: &str,
        run_id: &NonEmpty,
        text: &str,
    ) -> Result<bool, SessionError> {
        let recorded = self.update(id, |c| {
            if let Some(run) = c.runs.iter().find(|r| r.id == *run_id) {
                return Err(run.status == RunStatus::Queued);
            }
            let queued = c.runs.iter().any(|r| r.status.is_active());
            let ordinal = c.runs.len() as u64 + 1;
            c.runs.push(RunInfo {
                id: run_id.clone(),
                status: if queued {
                    RunStatus::Queued
                } else {
                    RunStatus::Starting
                },
                ordinal,
                started_at: None,
                ended_at: None,
                failure: None,
                usage: None,
            });
            c.put_message(ThreadMessage {
                id: run_id.clone(),
                run_id: Some(run_id.clone()),
                role: MessageRole::User,
                text: text.to_owned(),
                created_at: c.at.clone(),
            });
            Ok(queued)
        })?;
        let queued = match recorded {
            Ok(queued) => queued,
            Err(was_queued) => return Ok(was_queued),
        };
        let command = SessionCommand::Send {
            run_id: run_id.to_string(),
            text: text.to_owned(),
        };
        if let Err(e) = self.dispatch(id, command, None).await {
            self.fail_run(id, run_id, FailureClass::Other, e.message.as_str());
            return Err(e);
        }
        Ok(queued)
    }

    fn fail_run(&self, id: &str, run_id: &str, class: FailureClass, message: &str) {
        let failed = self.update(id, |c| {
            let at = c.at.clone();
            if let Some(run) = c.run_mut(run_id).filter(|r| r.status.is_active()) {
                run.status = RunStatus::Failed;
                run.ended_at = Some(at);
                run.failure = Some(RunFailure {
                    class,
                    message: Text::new(message).unwrap_or_else(|_| Text::unchecked("failed")),
                    api_status: None,
                    reset_at: None,
                    retries: 0,
                });
            }
        });
        if let Err(e) = failed {
            tracing::warn!(session_id = id, error = %e.message, "cannot record a failed run");
        }
    }

    async fn dispatch(
        &self,
        id: &str,
        command: SessionCommand,
        alias: Option<(String, String)>,
    ) -> Result<(), SessionError> {
        let commands = self.ensure_live(id).await?;
        if let Some(live) = self.st().live.get_mut(id) {
            live.last_active = Instant::now();
            if let Some((uuid, run_id)) = alias {
                live.aliases.insert(uuid, run_id);
            }
        }
        commands.send(command).await.map_err(|_| {
            error(
                SessionErrorCode::Internal,
                "the session's claude process ended",
            )
        })
    }

    /// The live process's command channel, spawning (first start) or resuming the session when there is none.
    async fn ensure_live(&self, id: &str) -> Result<mpsc::Sender<SessionCommand>, SessionError> {
        let _spawning = self.inner.spawning.lock().await;
        let closing = match self.st().live.get(id) {
            Some(live) if !live.closing => return Ok(live.commands.clone()),
            Some(live) => Some(live.exited.clone()),
            None => None,
        };
        if let Some(mut exited) = closing {
            let _ = tokio::time::timeout(EXIT_WAIT, exited.wait_for(|e| *e)).await;
        }
        if self.st().stopping {
            return Err(error(
                SessionErrorCode::RunnerUnavailable,
                "the node is stopping",
            ));
        }
        let config = &self.inner.config;
        let mut row = self.session(id)?;
        let resume = state::start_mode(&row.local, &config.config_dir, id)
            .map_err(|m| error(SessionErrorCode::RunnerUnavailable, m))?;
        // A worktree removed by `stop{removeWorktree}` comes back at the same path, so the session still resumes.
        let mut recreated = false;
        if let (Some(base_ref), Some(branch)) = (&row.local.base_ref, &row.local.branch)
            && !row.local.cwd.exists()
        {
            let (r, p, b, base) = (
                row.local.workspace_root.clone(),
                row.local.cwd.clone(),
                branch.clone(),
                base_ref.clone(),
            );
            blocking(move || worktree::ensure(&r, &p, &b, &base)).await?;
            row.summary.worktree_path = Some(row.local.cwd.to_string_lossy().into_owned());
            row.summary.branch = row.local.branch.clone();
            recreated = true;
        }
        if !row.local.cwd.is_dir() {
            return Err(invalid(format!(
                "the session's workspace {} is missing",
                row.local.cwd.display()
            )));
        }
        let spec = self.spec(&row, resume).map_err(|e| {
            error(
                SessionErrorCode::Internal,
                format!("cannot prepare the session's files: {e}"),
            )
        })?;
        let handle = match self.inner.runner.spawn(spec.clone()) {
            // A node that died between spawning claude and recording it: claude already has the session.
            Err(RunnerError::Refused(why)) if !resume && why.contains("already in use") => {
                self.inner.runner.spawn(SessionSpec {
                    resume: true,
                    ..spec
                })
            }
            other => other,
        }
        .map_err(runner_error)?;
        row.local.started = true;
        row.local.pid = Some(handle.pid);
        row.local.pid_start = proc::start_time(handle.pid);
        let (exited_tx, exited_rx) = watch::channel(false);
        let generation = {
            let mut st = self.st();
            let frame = self.store().commit(&row, &[], recreated)?;
            if let Some(frame) = frame {
                st.machine(frame);
            }
            st.next_generation += 1;
            let generation = st.next_generation;
            st.live.insert(
                id.to_owned(),
                Live {
                    generation,
                    pid: handle.pid,
                    commands: handle.commands.clone(),
                    last_active: Instant::now(),
                    ending: None,
                    closing: false,
                    aliases: HashMap::new(),
                    exited: exited_rx,
                },
            );
            generation
        };
        tokio::spawn(
            self.clone()
                .pump(id.to_owned(), generation, handle.events, exited_tx),
        );
        Ok(handle.commands)
    }

    /// The process spec, after writing the session's MCP config and keeping its transcript under its cap.
    fn spec(&self, row: &SessionRow, resume: bool) -> std::io::Result<SessionSpec> {
        let config = &self.inner.config;
        let id = row.summary.session_id.as_str();
        let dir = config.home.join("sessions").join(id);
        super::config::mkdir_private(&dir)?;
        let mcp = dir.join("mcp.json");
        if !mcp.exists() {
            std::fs::write(&mcp, MCP_CONFIG)?;
        }
        let transcripts = config.home.join("transcripts");
        super::config::mkdir_private(&transcripts)?;
        let transcript = transcripts.join(format!("{id}.jsonl"));
        state::cap_transcript(&transcript, TRANSCRIPT_CAP)?;

        let mut env = claude_env(config);
        // After claude.env, so fleetd's own values win.
        let sock = super::lead::lead_socket_path(&config.home);
        env.extend([
            (
                "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS".to_owned(),
                "2".to_owned(),
            ),
            // claude never updates itself out of the pinned, tested range.
            ("DISABLE_AUTOUPDATER".to_owned(), "1".to_owned()),
            // Startup failures come back as result messages the failure classifier reads.
            (
                "CLAUDE_CODE_STARTUP_FAILURE_RESULTS".to_owned(),
                "1".to_owned(),
            ),
            (
                "FLEETD_NODE_SOCK".to_owned(),
                sock.to_string_lossy().into_owned(),
            ),
            ("FLEETD_THREAD_ID".to_owned(), id.to_owned()),
            (
                "FLEETD_PROJECT_ID".to_owned(),
                row.summary.project_id.to_string(),
            ),
        ]);
        Ok(SessionSpec {
            session_id: id.to_owned(),
            resume,
            cwd: row.local.cwd.clone(),
            add_dirs: row.local.add_dirs.clone(),
            model: row.summary.model.clone(),
            effort: row.summary.effort,
            runtime_mode: row.summary.runtime_mode,
            allowed_tools: row.local.allowed_tools.clone(),
            disallowed_tools: ALWAYS_DISALLOWED
                .iter()
                .map(|t| (*t).to_owned())
                .chain(row.local.disallowed_tools.iter().cloned())
                .collect(),
            mcp_config: Some(mcp),
            env,
            transcript: Some(transcript),
        })
    }

    /// Applies one process's events in order until it exits. Text deltas go only to followers, at most one frame
    /// per [`DELTA_EVERY`], and a pending one is dropped once its complete message is stored.
    async fn pump(
        self,
        id: String,
        generation: u64,
        mut events: mpsc::Receiver<RunnerEvent>,
        exited: watch::Sender<bool>,
    ) {
        let mut delta: Option<(String, String)> = None;
        let mut flushed: Option<Instant> = None;
        let mut run_id: Option<String> = None;
        loop {
            let next = match &delta {
                Some(_) => {
                    let due = flushed.map_or_else(Instant::now, |at| at + DELTA_EVERY);
                    tokio::select! {
                        event = events.recv() => event,
                        () = tokio::time::sleep_until(due) => {
                            self.flush_delta(&id, &mut delta, &run_id);
                            flushed = Some(Instant::now());
                            continue;
                        }
                    }
                }
                None => events.recv().await,
            };
            let Some(event) = next else {
                let exit = ExitInfo {
                    code: None,
                    signal: None,
                    stderr_tail: "the runner stopped reporting on claude".into(),
                };
                self.exited(&id, generation, exit);
                break;
            };
            if let Some(live) = self.st().live.get_mut(&id) {
                live.last_active = Instant::now();
            }
            match event {
                RunnerEvent::Delta { message_id, append } => {
                    if !self.st().followed.contains(&id) {
                        continue;
                    }
                    match &mut delta {
                        Some((m, text)) if *m == message_id => text.push_str(&append),
                        _ => {
                            self.flush_delta(&id, &mut delta, &run_id);
                            delta = Some((message_id, append));
                        }
                    }
                    if flushed.is_none_or(|at| at + DELTA_EVERY <= Instant::now()) {
                        self.flush_delta(&id, &mut delta, &run_id);
                        flushed = Some(Instant::now());
                    }
                }
                RunnerEvent::Exited(exit) => {
                    self.exited(&id, generation, exit);
                    break;
                }
                RunnerEvent::RunStarted { run_id: started } => {
                    let started = self.resolve(&id, &started);
                    run_id = Some(started.clone());
                    self.log(self.update(&id, |c| {
                        let at = c.at.clone();
                        if let Some(run) = c.run_mut(&started)
                            && matches!(run.status, RunStatus::Queued | RunStatus::Starting)
                        {
                            run.status = RunStatus::Running;
                            run.started_at.get_or_insert(at);
                        }
                    }));
                }
                RunnerEvent::AssistantText { message_id, text } => {
                    if delta.as_ref().is_some_and(|(m, _)| *m == message_id) {
                        delta = None;
                    }
                    self.assistant_text(&id, message_id, text, &run_id);
                }
                RunnerEvent::Item(item) => self.log(self.update(&id, |c| c.put_item(item))),
                // Progress for the watchdog: a long compaction is not a stall.
                RunnerEvent::Compacting(_) => self.log(self.update(&id, |c| c.announce = true)),
                RunnerEvent::PermissionRequest {
                    request_id,
                    tool_use_id: _,
                    tool_name,
                    input,
                    summary,
                } => {
                    self.permission(&id, request_id, tool_name, input, summary, &run_id)
                        .await
                }
                RunnerEvent::RunEnded {
                    run_id: ended,
                    outcome,
                    usage,
                } => {
                    let ended = self.resolve(&id, &ended);
                    self.run_ended(&id, &ended, outcome, usage);
                }
                RunnerEvent::Init { .. } | RunnerEvent::RateLimit(_) => {}
            }
        }
        let _ = exited.send(true);
    }

    fn log<T>(&self, result: Result<T, SessionError>) {
        if let Err(e) = result {
            tracing::warn!(error = %e.message, "session event not applied");
        }
    }

    fn resolve(&self, id: &str, uuid: &str) -> String {
        self.st()
            .live
            .get(id)
            .and_then(|l| l.aliases.get(uuid).cloned())
            .unwrap_or_else(|| uuid.to_owned())
    }

    fn flush_delta(&self, id: &str, delta: &mut Option<(String, String)>, run_id: &Option<String>) {
        if let Some((message_id, append)) = delta.take()
            && let Ok(message_id) = NonEmpty::new(message_id)
        {
            self.st().thread(
                id,
                ThreadEvent::Delta {
                    message_id,
                    run_id: run_id.clone().map(NonEmpty::unchecked),
                    append,
                },
            );
        }
    }

    fn assistant_text(&self, id: &str, message_id: String, text: String, run_id: &Option<String>) {
        self.log(self.update(id, |c| {
            let message = match c.store.message(id, &message_id) {
                Ok(Some(mut message)) => {
                    message.text.push_str("\n\n");
                    message.text.push_str(&text);
                    message
                }
                _ => ThreadMessage {
                    id: NonEmpty::new(message_id)
                        .unwrap_or_else(|_| NonEmpty::unchecked(new_uuid())),
                    run_id: run_id.clone().map(NonEmpty::unchecked),
                    role: MessageRole::Assistant,
                    text,
                    created_at: c.at.clone(),
                },
            };
            c.row.summary.latest_assistant_tail =
                Some(tail_utf16(&message.text, state::ASSISTANT_TAIL).to_owned());
            c.put_message(message);
        }));
    }

    async fn permission(
        &self,
        id: &str,
        request_id: String,
        tool_name: String,
        input: serde_json::Value,
        summary: String,
        run_id: &Option<String>,
    ) {
        let decision = self.update(id, |c| {
            let decision = state::auto_answer(c.row.summary.runtime_mode, &tool_name, &input);
            let at = c.at.clone();
            c.put_item(ThreadItem {
                id: NonEmpty::unchecked(permission_item_id(&request_id)),
                run_id: run_id.clone().map(NonEmpty::unchecked),
                status: if decision.is_some() {
                    ItemStatus::Completed
                } else {
                    ItemStatus::Running
                },
                title: format!("Permission: {tool_name}"),
                started_at: at.clone(),
                completed_at: decision.is_some().then(|| at.clone()),
                updated_at: at,
                kind: ItemKind::Permission {
                    request_id: request_id.clone(),
                    tool_name: tool_name.clone(),
                    summary: summary.clone(),
                    decision: decision.clone(),
                },
            });
            if decision.is_none() {
                c.row.summary.pending_permission = Some(PendingPermission {
                    request_id: NonEmpty::new(request_id.clone())
                        .unwrap_or_else(|_| NonEmpty::unchecked("?")),
                    tool_name: NonEmpty::new(tool_name.clone())
                        .unwrap_or_else(|_| NonEmpty::unchecked("?")),
                    summary: Text::new(tail_utf16(&summary, 2000))
                        .unwrap_or_else(|_| Text::unchecked("")),
                });
                if let Some(run) = c.active_mut() {
                    run.status = RunStatus::Waiting;
                }
            }
            decision
        });
        let Ok(Some(decision)) = decision else {
            return;
        };
        let commands = self.st().live.get(id).map(|l| l.commands.clone());
        if let Some(commands) = commands {
            let _ = commands
                .send(SessionCommand::Answer {
                    request_id,
                    decision,
                })
                .await;
        }
    }

    fn run_ended(
        &self,
        id: &str,
        run_id: &str,
        outcome: RunOutcome,
        usage: Option<fleetd_contracts::sessions::RunUsage>,
    ) {
        let mut retries = 0;
        if let RunOutcome::Failed(failure) = &outcome
            && matches!(
                failure.class,
                FailureClass::Overloaded | FailureClass::Network
            )
        {
            let schedule = &self.inner.config.retry_schedule_ms;
            let attempt = {
                let mut st = self.st();
                let done = st.retries.entry(run_id.to_owned()).or_default();
                *done += 1;
                *done
            };
            if let Some(&delay) = schedule.get(attempt as usize - 1) {
                self.schedule_retry(id, run_id, attempt, delay, failure);
                return;
            }
            retries = attempt - 1;
        }
        self.st().retries.remove(run_id);
        if let Some(live) = self.st().live.get_mut(id) {
            live.ending = None;
        }
        self.log(self.update(id, |c| {
            let at = c.at.clone();
            let found = c
                .runs
                .iter()
                .position(|r| r.id == run_id && r.status.is_active());
            let index = found.or_else(|| c.runs.iter().position(|r| r.status.is_active()));
            if let Some(run) = index.map(|i| &mut c.runs[i]) {
                (run.status, run.failure) = match outcome {
                    RunOutcome::Completed { .. } => (RunStatus::Completed, None),
                    RunOutcome::Interrupted => (RunStatus::Interrupted, None),
                    RunOutcome::Failed(failure) => {
                        (RunStatus::Failed, Some(RunFailure { retries, ..failure }))
                    }
                };
                run.ended_at = Some(at);
                run.usage = usage;
            }
            if !c.runs.iter().any(|r| r.status.is_active()) {
                c.cancel_pending();
            }
        }));
    }

    /// The run stays active while the node waits, with a `NodeRetry` item saying why it is slow; then
    /// [`CONTINUE_PROMPT`] goes to the same session under a fresh uuid that maps back to the run.
    fn schedule_retry(
        &self,
        id: &str,
        run_id: &str,
        attempt: u32,
        delay: u64,
        failure: &RunFailure,
    ) {
        let max = self.inner.config.retry_schedule_ms.len() as u32;
        self.log(self.update(id, |c| {
            let at = c.at.clone();
            c.put_item(ThreadItem {
                id: NonEmpty::unchecked(format!("node-retry-{run_id}-{attempt}")),
                run_id: Some(NonEmpty::unchecked(run_id)),
                status: ItemStatus::Completed,
                title: "Node retry".into(),
                started_at: at.clone(),
                completed_at: Some(at.clone()),
                updated_at: at,
                kind: ItemKind::NodeRetry {
                    attempt,
                    of: max,
                    delay_ms: delay,
                    reason: failure.clone(),
                },
            });
        }));
        let service = self.clone();
        let (id, run_id) = (id.to_owned(), run_id.to_owned());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let active = service.store().runs(&id).is_ok_and(|runs| {
                runs.iter()
                    .any(|r| r.id.as_str() == run_id && r.status.is_active())
            });
            if !active {
                return;
            }
            let uuid = new_uuid();
            let command = SessionCommand::Send {
                run_id: uuid.clone(),
                text: CONTINUE_PROMPT.to_owned(),
            };
            if let Err(e) = service
                .dispatch(&id, command, Some((uuid, run_id.clone())))
                .await
            {
                service.fail_run(&id, &run_id, FailureClass::Other, e.message.as_str());
            }
        });
    }

    /// The process is gone: active runs close (interrupted when someone asked, else failed with claude's exit).
    fn exited(&self, id: &str, generation: u64, exit: ExitInfo) {
        let (pid, ending) = {
            let mut st = self.st();
            let Some(live) = st.live.remove(id) else {
                return;
            };
            if live.generation != generation {
                st.live.insert(id.to_owned(), live);
                return;
            }
            let ending = live
                .ending
                .or_else(|| st.stopping.then(|| "the node stopped".to_owned()));
            (live.pid, ending)
        };
        let cause = match ending {
            Some(why) => EndCause::Requested(why),
            None => EndCause::Exited(exit),
        };
        self.log(self.update(id, |c| {
            state::close_out(&mut c.runs, &cause, &c.at);
            c.cancel_pending();
            // A replacement process may already be recorded.
            if c.row.local.pid == Some(pid) {
                c.row.local.pid = None;
                c.row.local.pid_start = None;
            }
        }));
    }

    async fn interrupt(&self, id: &str, run_id: Option<&str>, reason: Option<String>) -> Reply {
        self.session(id)?;
        let runs = self.store().runs(id)?;
        let Some(active) = runs.iter().find(|r| r.status.is_active()) else {
            return Ok(SessionOutput::Done);
        };
        if run_id.is_some_and(|r| r != active.id.as_str()) {
            return Ok(SessionOutput::Done);
        }
        let reason = reason
            .filter(|r| !r.trim().is_empty())
            .unwrap_or_else(|| "interrupted".into());
        let target = self.st().live.get_mut(id).map(|live| {
            live.ending = Some(reason.clone());
            (live.commands.clone(), live.generation)
        });
        let Some((commands, generation)) = target else {
            // No process to stop: the run only needs closing.
            self.update(id, |c| {
                state::close_out(&mut c.runs, &EndCause::Requested(reason), &c.at);
                c.cancel_pending();
            })?;
            return Ok(SessionOutput::Done);
        };
        let _ = commands.send(SessionCommand::Interrupt).await;
        let service = self.clone();
        let (id, run) = (id.to_owned(), active.id.to_string());
        tokio::spawn(async move {
            tokio::time::sleep(INTERRUPT_GRACE).await;
            let still = service.store().runs(&id).is_ok_and(|runs| {
                runs.iter()
                    .any(|r| r.id.as_str() == run && r.status.is_active())
            });
            let commands = still
                .then(|| {
                    let mut st = service.st();
                    st.live
                        .get_mut(&id)
                        .filter(|l| l.generation == generation)
                        .map(|l| {
                            l.closing = true;
                            l.commands.clone()
                        })
                })
                .flatten();
            if let Some(commands) = commands {
                tracing::warn!(session_id = %id, "claude did not honour the interrupt; stopping its process");
                let _ = commands
                    .send(SessionCommand::Shutdown {
                        grace: Duration::ZERO,
                    })
                    .await;
            }
        });
        Ok(SessionOutput::Done)
    }

    async fn stop(&self, id: &str, remove_worktree: bool) -> Reply {
        let row = self.session(id)?;
        let target = self.st().live.get_mut(id).map(|live| {
            live.ending = Some("stopped".into());
            live.closing = true;
            (live.commands.clone(), live.exited.clone())
        });
        if let Some((commands, mut exited)) = target {
            let _ = commands
                .send(SessionCommand::Shutdown { grace: STOP_GRACE })
                .await;
            let _ = tokio::time::timeout(EXIT_WAIT, exited.wait_for(|e| *e)).await;
        }
        if remove_worktree
            && let (Some(base_ref), Some(branch)) = (row.local.base_ref, row.local.branch)
        {
            let (root, path) = (row.local.workspace_root, row.local.cwd);
            let deleted =
                blocking(move || worktree::remove(&root, &path, &branch, &base_ref)).await?;
            self.update(id, |c| {
                c.row.summary.worktree_path = None;
                if deleted {
                    c.row.summary.branch = None;
                }
            })?;
        }
        Ok(SessionOutput::Done)
    }

    async fn answer(&self, id: &str, request_id: &str, decision: PermissionDecision) -> Reply {
        let row = self.session(id)?;
        if row
            .summary
            .pending_permission
            .as_ref()
            .is_none_or(|p| p.request_id != request_id)
        {
            return Err(not_found(format!(
                "no permission request {request_id} is waiting in session {id}"
            )));
        }
        let commands = self.st().live.get(id).map(|l| l.commands.clone());
        let commands = commands.ok_or_else(|| not_found("the run that asked has ended"))?;
        commands
            .send(SessionCommand::Answer {
                request_id: request_id.to_owned(),
                decision: decision.clone(),
            })
            .await
            .map_err(|_| not_found("the run that asked has ended"))?;
        self.update(id, |c| {
            let item_id = permission_item_id(request_id);
            if let Ok(Some(mut item)) = c.store.item(id, &item_id) {
                if let ItemKind::Permission { decision: d, .. } = &mut item.kind {
                    *d = Some(decision);
                }
                item.status = ItemStatus::Completed;
                item.completed_at = Some(c.at.clone());
                item.updated_at = c.at.clone();
                c.put_item(item);
            }
            c.row.summary.pending_permission = None;
            for run in c.runs.iter_mut().filter(|r| r.status == RunStatus::Waiting) {
                run.status = RunStatus::Running;
            }
        })?;
        Ok(SessionOutput::Done)
    }

    fn subscribe(&self, after: Option<u64>) -> Reply {
        let mut st = self.st();
        st.subscribed = true;
        let replay = match after {
            Some(after) => self.store().events_after(after)?,
            None => None,
        };
        match replay {
            Some(frames) => frames.into_iter().for_each(|f| st.machine(f)),
            None => {
                let frame = MachineEventFrame {
                    seq: self.store().latest_seq()?,
                    at: now(),
                    event: MachineEvent::Snapshot {
                        projects: self.store().projects()?,
                        sessions: self
                            .store()
                            .sessions()?
                            .into_iter()
                            .map(|r| r.summary)
                            .collect(),
                    },
                };
                st.machine(frame);
            }
        }
        Ok(SessionOutput::Done)
    }

    fn snapshot(&self, id: &str) -> Result<ThreadSnapshot, SessionError> {
        let row = self.session(id)?;
        let (messages, older_messages) = self.store().newest_messages(id, SNAPSHOT_WINDOW)?;
        let (items, older_items) = self.store().newest_items(id, SNAPSHOT_WINDOW)?;
        Ok(ThreadSnapshot {
            summary: row.summary,
            messages,
            items: items.iter().map(state::bounded).collect(),
            runs: self.store().runs(id)?,
            truncated: older_messages || older_items,
        })
    }

    fn read_file(&self, project_id: &str, path: &str) -> Reply {
        const MAX: u64 = 1024 * 1024;
        let root = self.project_root(project_id)?;
        let relative = Path::new(path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(invalid(format!("{path} is not a path inside the project")));
        }
        let real = match root.join(relative).canonicalize() {
            Ok(real) => real,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SessionOutput::File { contents: None });
            }
            Err(e) => return Err(error(SessionErrorCode::Internal, e.to_string())),
        };
        // A symlink may not lead out of the project.
        if !real.starts_with(root.canonicalize().unwrap_or(root)) {
            return Err(invalid(format!("{path} leads outside the project")));
        }
        if std::fs::metadata(&real).is_ok_and(|m| m.len() > MAX) {
            return Err(invalid(format!("{path} is larger than 1 MiB")));
        }
        match std::fs::read_to_string(&real) {
            Ok(contents) => Ok(SessionOutput::File {
                contents: Some(contents),
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok(SessionOutput::File { contents: None })
            }
            Err(e) => Err(invalid(format!("cannot read {path}: {e}"))),
        }
    }

    fn spawn_reaper(&self) {
        let weak = Arc::downgrade(&self.inner);
        let tick = (self.inner.config.idle_reap / 4)
            .clamp(Duration::from_secs(1), Duration::from_secs(60));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tick).await;
                let Some(inner) = weak.upgrade() else { return };
                SessionService { inner }.reap().await;
            }
        });
    }

    /// Idle processes cost RAM: close stdin on any without an active run for `idle_reap`. The next send resumes.
    async fn reap(&self) {
        let idle_reap = self.inner.config.idle_reap;
        let candidates: Vec<String> = self
            .st()
            .live
            .iter()
            .filter(|(_, l)| !l.closing && l.last_active.elapsed() >= idle_reap)
            .map(|(id, _)| id.clone())
            .collect();
        for id in candidates {
            let idle = self
                .store()
                .session(&id)
                .is_ok_and(|r| r.is_some_and(|r| r.summary.active_run_id.is_none()));
            if !idle {
                continue;
            }
            let commands = self.st().live.get_mut(&id).map(|l| {
                l.closing = true;
                l.commands.clone()
            });
            if let Some(commands) = commands {
                tracing::info!(session_id = %id, "reaping an idle claude process");
                let _ = commands
                    .send(SessionCommand::Shutdown { grace: REAP_GRACE })
                    .await;
            }
        }
    }

    /// Node SIGTERM: interrupt every active run, give them [`SHUTDOWN_DRAIN`] to end, then close every process.
    pub async fn shutdown(&self) {
        let targets: Vec<_> = {
            let mut st = self.st();
            st.stopping = true;
            st.live
                .iter_mut()
                .map(|(id, live)| {
                    live.ending.get_or_insert_with(|| "the node stopped".into());
                    live.closing = true;
                    (id.clone(), live.commands.clone(), live.exited.clone())
                })
                .collect()
        };
        let active = |id: &str| {
            self.store()
                .session(id)
                .is_ok_and(|r| r.is_some_and(|r| r.summary.active_run_id.is_some()))
        };
        for (id, commands, _) in &targets {
            if active(id) {
                let _ = commands.send(SessionCommand::Interrupt).await;
            }
        }
        let deadline = Instant::now() + SHUTDOWN_DRAIN;
        while Instant::now() < deadline && targets.iter().any(|(id, ..)| active(id)) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        for (_, commands, _) in &targets {
            let _ = commands
                .send(SessionCommand::Shutdown {
                    grace: Duration::from_secs(2),
                })
                .await;
        }
        for (_, _, mut exited) in targets {
            let _ = tokio::time::timeout(EXIT_WAIT, exited.wait_for(|e| *e)).await;
        }
    }
}
