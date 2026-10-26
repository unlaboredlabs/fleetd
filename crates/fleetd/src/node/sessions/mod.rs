//! The node session service: runs the hub's sessions on this machine through a [`Runner`] (one `claude` process per
//! live session) and answers the hub's `session_call` frames, one `session_reply` each, plus the machine and thread
//! streams.
//!
//! Everything durable is in [`NodeStore`], written before it is sent, so a node restart or crash loses no session:
//! on start, runs that were active are closed as interrupted (its lead decides whether to continue one) and the next
//! `send` resumes the claude session in the same cwd and config dir. Idle processes are reaped and respawned on
//! demand. Permission prompts are answered from policy or held as a pending approval for the hub.
mod env;
pub mod files;
mod health;
mod proc;
mod share;
mod spans;
pub mod state;
mod steers;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::ids::{ProjectId, ThreadId, Timestamp};
use fleetd_contracts::prim::{NonEmpty, Text};
use fleetd_contracts::project_settings::{ProjectWorktree, ProjectWorktrees};
use fleetd_contracts::sessions::{
    CloneProgressFrame, FailureClass, ItemKind, ItemStatus, MachineEvent, MachineEventFrame,
    MessageRole, PendingPermission, PermissionDecision, ProjectInfo, RunEnd, RunFailure, RunInfo,
    RunStatus, RunUsage, RunnerInfo, SendAccepted, SendMode, SendNow, SessionCall,
    SessionCallFrame, SessionChanges, SessionError, SessionErrorCode, SessionLaunch, SessionOutput,
    SessionReplyFrame, SessionResult, SessionRole, SessionStatus, SessionSummary, SessionWorkspace,
    ThreadEvent, ThreadEventFrame, ThreadItem, ThreadMessage, ThreadSnapshot, WorktreeBase,
};
use fleetd_contracts::steer::SteerTag;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

use super::runner::claude::{self, failure, setup};
use super::runner::claude::{
    ALWAYS_DISALLOWED, AUTO_MEMORY_OFF_ENV, DEFAULT_ENV, HELPER_MODEL_ENV, PROMPT_CACHE_TTL_VARS,
    SESSION_ENV, default_cache_ttl, subagents_off_settings_env,
};
use super::runner::{
    ExitInfo, RunOutcome, Runner, RunnerError, RunnerEvent, SessionCommand, SessionSpec,
};
use super::store::{NodeStore, SessionLocal, SessionRow, StoreError};
use super::util::{now_iso, tail_utf16};
use super::wire::{NodeToHub, head_text, to_json};
use super::worktree;
use health::Health;
use state::EndCause;

/// fleetd's own MCP servers (none yet: leads and agents call the `fleetd` CLI). The user's own servers load too.
const SNAPSHOT_WINDOW: usize = 200;
const DELTA_EVERY: Duration = Duration::from_millis(100);
/// A project's file list is reused this long.
const FILES_FOR: Duration = Duration::from_secs(30);
/// Live usage goes to followers at most this often per session.
const USAGE_EVERY: Duration = Duration::from_secs(1);
/// An interrupt claude has not honoured by then escalates to SIGTERM, then SIGKILL.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);
/// `stop`: stdin closed, SIGTERM after this.
const STOP_GRACE: Duration = Duration::from_secs(5);
/// An idle process gets stdin closed, and SIGTERM after this if it is still there.
const REAP_GRACE: Duration = Duration::from_secs(10);
const EXIT_WAIT: Duration = Duration::from_secs(20);
/// `stop`: how long a SIGKILLed claude gets to be reaped before the stop is reported as failed.
const KILL_WAIT: Duration = Duration::from_secs(5);
/// `project_remove`: how long the project's stopped processes get to exit (SIGTERM comes at [`STOP_GRACE`]). The
/// hub's own wait for the reply is longer.
const REMOVE_WAIT: Duration = Duration::from_secs(12);
/// Node shutdown: how long interrupted runs get to end before every process is closed.
const SHUTDOWN_DRAIN: Duration = Duration::from_secs(10);
/// After the machine wakes, how long a running claude gets to say anything before its stream counts as lost.
const WAKE_GRACE: Duration = Duration::from_secs(60);

/// HOME, PATH, USER, LANG and the git identity of the node's environment, `var`: never its SSH agent or anything else.
pub(crate) fn session_env(var: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    super::util::passed_env(
        &[
            "HOME",
            "PATH",
            "USER",
            "LANG",
            "GIT_AUTHOR_NAME",
            "GIT_AUTHOR_EMAIL",
            "GIT_COMMITTER_NAME",
            "GIT_COMMITTER_EMAIL",
        ],
        var,
    )
}

/// Where sessions live and what their processes get.
#[derive(Clone, Debug)]
pub struct SessionConfig {
    /// The node home: `worktrees/`, `sessions/<id>/` (the MCP config) and `transcripts/` live here.
    pub home: PathBuf,
    /// A dedicated `CLAUDE_CONFIG_DIR` for every session (`node join --claude-config-dir`). None: the user's own
    /// claude setup (`~/.claude`), so their login, proxy settings and MCP servers work as in their own shell.
    pub config_dir: Option<PathBuf>,
    /// Optional `KEY=VALUE` lines added to every session's environment, re-read per spawn: for a login or gateway
    /// variable the node's service doesn't otherwise see (e.g. one exported only in an interactive shell).
    pub claude_env: PathBuf,
    /// HOME, PATH, USER, LANG and the git identity; nothing else of the node's environment reaches claude.
    pub base_env: Vec<(String, String)>,
    pub idle_reap: Duration,
    /// The node's own retries of a run that failed Overloaded or Network, after claude's internal retries.
    pub retry_schedule_ms: Vec<u64>,
}

impl SessionConfig {
    /// The user's own claude setup and the optional `<fleetd dir>/claude.env`, from `$HOME`, so a lab node with its own
    /// HOME needs no flag. A dedicated config dir comes from the node config (`claudeConfigDir`), else from a
    /// `CLAUDE_CONFIG_DIR` the node itself was started with.
    /// `FLEETD_NODE_IDLE_REAP_SEC` and `FLEETD_NODE_RETRY_SCHEDULE_MS` (e.g. `500,1000,2000`) exist for tests and
    /// the lab only.
    pub fn for_node(home: &Path) -> Self {
        let fleetd = crate::home::fleetd_dir();
        let base_env = session_env(|key| std::env::var(key).ok());
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
            // Drawn once per node, so machines hit by one outage don't all come back at the same second.
            .unwrap_or_else(|| {
                (1..=failure::MAX_RUN_RETRIES)
                    .filter_map(failure::retry_delay_ms)
                    .collect()
            });
        // fleetd's old default, which a node unit written by an older `machine add` still sets in the environment:
        // sessions are back on the user's own setup.
        let from_env = std::env::var("CLAUDE_CONFIG_DIR")
            .ok()
            .filter(|d| expand_home(d) != fleetd.join("claude"));
        let config_dir = super::config::read_config(home)
            .ok()
            .flatten()
            .and_then(|c| c.claude_config_dir)
            .or(from_env)
            .filter(|d| !d.trim().is_empty())
            .map(|d| expand_home(&d));
        Self {
            home: home.to_path_buf(),
            config_dir,
            claude_env: fleetd.join("claude.env"),
            base_env,
            idle_reap,
            retry_schedule_ms,
        }
    }
}

impl SessionConfig {
    /// What every claude the node starts gets, sessions and probes alike: the base environment, then `claude.env`
    /// (re-read on each call), then [`DEFAULT_ENV`] for what neither set, then fleetd's own values, which win. No `CLAUDE_CONFIG_DIR` unless the machine has a
    /// dedicated one: claude then reads the user's own `~/.claude` and `~/.claude.json`.
    pub fn runner_env(&self) -> Vec<(String, String)> {
        let mut env = self.base_env.clone();
        if let Ok(text) = std::fs::read_to_string(&self.claude_env) {
            let extra = parse_env_file(&text);
            if extra.iter().any(|(k, _)| k == "ANTHROPIC_BASE_URL") {
                env.push((
                    setup::FLEETD_ENV_SOURCE.to_owned(),
                    setup::tilde(&self.claude_env),
                ));
            }
            env.extend(extra);
        }
        for (key, value) in DEFAULT_ENV {
            if !env.iter().any(|(k, _)| k == key) {
                env.push(((*key).to_owned(), (*value).to_owned()));
            }
        }
        if let Some(dir) = &self.config_dir {
            env.push((
                "CLAUDE_CONFIG_DIR".to_owned(),
                dir.to_string_lossy().into_owned(),
            ));
        }
        env.extend(
            SESSION_ENV
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
        );
        env
    }

    /// Each of [`PROMPT_CACHE_TTL_VARS`] for a session of `role`: what `env` ([`Self::runner_env`]) sets, else the
    /// role's default. The settings overlay carries it too, since an `env` in the user's own settings outranks the
    /// process environment.
    pub fn prompt_cache_env(
        &self,
        role: SessionRole,
        env: &[(String, String)],
    ) -> Vec<(String, String)> {
        PROMPT_CACHE_TTL_VARS
            .iter()
            .map(|var| {
                let ttl = env.iter().rev().find(|(k, _)| k == var).map_or_else(
                    || default_cache_ttl(role).as_str().to_owned(),
                    |(_, v)| v.clone(),
                );
                ((*var).to_owned(), ttl)
            })
            .collect()
    }
}

/// One compile cache for every session on the machine, when sccache is installed and the environment names no
/// wrapper: dependencies compile once, not once per worktree. Target dirs stay in each worktree and go with it,
/// since cargo checks a workspace's own crates by path and mtime: a target shared between worktrees can hand one
/// worktree another's build.
pub fn compile_cache_env(env: &[(String, String)]) -> Vec<(String, String)> {
    let var = |name: &str| env.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    if var("RUSTC_WRAPPER").is_some() {
        return Vec::new();
    }
    let Some(sccache) = std::env::split_paths(var("PATH").unwrap_or_default())
        .map(|dir| dir.join("sccache"))
        .find(|bin| bin.is_file())
    else {
        return Vec::new();
    };
    vec![
        (
            "RUSTC_WRAPPER".to_owned(),
            sccache.to_string_lossy().into_owned(),
        ),
        // A cache server that fails compiles locally instead of failing the build.
        ("SCCACHE_IGNORE_SERVER_IO_ERROR".to_owned(), "1".to_owned()),
    ]
}

/// `~/x` as `$HOME/x`; other paths as given.
fn expand_home(dir: &str) -> PathBuf {
    match dir.strip_prefix("~/") {
        Some(rest) => super::util::home_dir().join(rest),
        None if dir == "~" => super::util::home_dir(),
        None => PathBuf::from(dir),
    }
}

/// `KEY=VALUE` lines; blank lines, `#` comments and an `export ` prefix are allowed, and one pair of matching quotes
/// around a value is removed.
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

/// The session's `--mcp-config`: fleetd's own agent MCP server (`fleetd agent-mcp`, this binary) for a lead or a
/// worker, scoped to the role; nothing for a plain thread. The server reaches the hub through this node's socket, as the
/// CLI does, and names the session so the hub can tell a lead from a task. `alwaysLoad` keeps its tools in the prompt
/// from the first turn, out of tool search (`ENABLE_TOOL_SEARCH`): every agent calls them, and finding one through a
/// search costs a model round trip each session. claude 2.1.302 honors it for `--mcp-config` servers.
#[cfg(test)]
fn mcp_config(role: SessionRole, sock: &Path, session_id: &str) -> String {
    let servers = match fleetd_server(role, sock, session_id) {
        None => serde_json::json!({}),
        Some(fleetd) => serde_json::json!({ crate::cli::agent_mcp::SERVER_NAME: fleetd }),
    };
    format!("{}\n", serde_json::json!({ "mcpServers": servers }))
}

/// fleetd's own server's entry in a session's `mcpServers` (see [`mcp_config`]); none for a plain thread.
fn fleetd_server(role: SessionRole, sock: &Path, session_id: &str) -> Option<serde_json::Value> {
    let role = role.cli_arg()?;
    let exe = match super::self_exe::pinned() {
        Some(pinned) => pinned.to_string_lossy().into_owned(),
        None => agent_exe(std::env::current_exe(), std::process::id()),
    };
    Some(serde_json::json!({
        "type": "stdio",
        "command": exe,
        "args": ["agent-mcp", "--role", role],
        "alwaysLoad": true,
        "env": {
            "FLEETD_NODE_SOCK": sock.to_string_lossy(),
            "FLEETD_THREAD_ID": session_id,
        },
    }))
}

/// The command for `fleetd agent-mcp` when the node couldn't pin its binary (self_exe.rs), which it otherwise uses on
/// every platform: the node's own running binary, which speaks the node's socket. Once `fleetd
/// update` replaces that binary on disk while the node keeps running, Linux names it `<path> (deleted)`, a file that
/// doesn't exist: claude can't start the server (`ENOENT`) and every session from then on goes without fleetd's tools.
/// `/proc/<pid>/exe` still opens the running binary for as long as the node lives, and its sessions don't outlive it.
fn agent_exe(exe: std::io::Result<PathBuf>, pid: u32) -> String {
    match exe {
        Ok(path) if !path.exists() && cfg!(target_os = "linux") => format!("/proc/{pid}/exe"),
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(_) => "fleetd".into(),
    }
}

/// fleetd's settings overlay (`--settings`). claude ranks it above the user's own settings, so a user's `env` or
/// allow rule can't undo what sessions depend on: the pinned claude (no autoupdate), helper calls on the one model,
/// the subagent cap, the tools fleetd never gives an agent, auto memory off ([`AUTO_MEMORY_OFF_ENV`]), and `extra_env`
/// (the session's prompt cache TTL and role defaults such as a task agent's command timeout). `skills` turns off
/// claude's own skills of the names fleetd's plugin gives the session (`node::skills`).
pub fn settings_overlay(
    extra_env: &[(String, String)],
    skills: serde_json::Map<String, serde_json::Value>,
) -> String {
    let mut env = subagents_off_settings_env();
    env.extend(
        extra_env
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().into())),
    );
    env.insert("DISABLE_AUTOUPDATER".into(), "1".into());
    let (key, model) = HELPER_MODEL_ENV;
    env.insert(key.into(), model.into());
    let (key, value) = AUTO_MEMORY_OFF_ENV;
    env.insert(key.into(), value.into());
    let mut overlay = serde_json::json!({
        "env": env,
        "permissions": { "deny": ALWAYS_DISALLOWED },
        "autoMemoryEnabled": false,
    });
    if !skills.is_empty() {
        overlay["skillOverrides"] = skills.into();
    }
    format!("{overlay}\n")
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
        RunnerError::Missing { .. } => Some(
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
    /// rather than fails the run. Always `Requested` or `NodeStopping`.
    ending: Option<EndCause>,
    /// A shutdown was sent: a new command waits for the exit and respawns.
    closing: bool,
    /// claude's user-message uuid → fleetd run id, for node retries sent under a fresh uuid.
    aliases: HashMap<String, String>,
    exited: watch::Receiver<bool>,
    /// The run the node interrupted because claude said nothing after the machine woke: it ends as a network
    /// failure, so the node's retry resumes it.
    slept: Option<String>,
    /// The digest of the order's variables the process was started with: when it changes, the next turn starts a
    /// new process with them.
    order_digest: Option<String>,
    /// The secrets the process was started with, for masking what it reports and the fleetd calls it makes.
    spawned: Arc<super::mask::Secrets>,
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
    /// Runs the node cut after the machine woke, until they end: one that fails after its retries ended by the sleep.
    slept: HashSet<String>,
    /// Sessions with an active run, for the sleep inhibitor.
    active: HashSet<String>,
    outbox: spans::Outbox,
    /// Runs whose send had to start claude's process, until they start: their wait is `run.startup`.
    spawned: HashSet<String>,
    /// claude's own agent tools a session's init still offered: every later session denies them too.
    agent_tools: Vec<String>,
    /// Runs the node is retrying: when the retry was scheduled (ms), its attempt and delay.
    node_retry: HashMap<String, (u64, u32, u64)>,
    /// Tagged sends (steers) by steer id, until their receipt is final.
    steers: HashMap<String, steers::SteerTrack>,
    send_now_waiters: HashMap<String, oneshot::Sender<SendNow>>,
    withdraw_waiters: HashMap<String, oneshot::Sender<bool>>,
    /// Sessions whose worktree setup still runs: a send waits for it to end, `Some(true)` once the brief went to
    /// claude, `Some(false)` when the start failed.
    setting_up: HashMap<String, watch::Receiver<Option<bool>>>,
    /// Cancels a session's running setup (`true`): an interrupt or stop ends it, killing its command.
    /// The run each setup is for, too: only that run's interrupt ends it.
    setup_cancel: HashMap<String, (String, watch::Sender<bool>)>,
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
    /// Per session: a send holds it while it records its run and hands it to the process, and `stop{removeWorktree}`
    /// while it stops the process and removes the worktree. So a message either lands first, and the removal leaves
    /// the session at work, or waits for the removal and then brings the worktree back; it never resumes in a
    /// directory being deleted.
    workspaces: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    health: Mutex<Health>,
    /// One probe at a time; a caller that waited answers from the probe it waited for.
    probing: tokio::sync::Mutex<()>,
    /// Wakes the prober when health changed without a probe, so an unusable runner is re-checked on its short
    /// schedule.
    health_changed: Arc<tokio::sync::Notify>,
    /// The latest claude.ai usage window per limit type, for the heartbeat.
    limits: Mutex<std::collections::BTreeMap<String, (crate::node::runner::RateLimit, Timestamp)>>,
    /// Project files for @-mentions, per project, for `FILES_FOR`.
    files: Mutex<HashMap<String, Listed>>,
    /// How many sessions have an active run.
    running: watch::Sender<usize>,
    /// Wakes the span flusher.
    span_wake: Arc<tokio::sync::Notify>,
    /// The node's browser broker, once it runs: a lead's and a task's claude get agent-browser pointed at their
    /// session, and their browser commands are logged.
    browser: std::sync::OnceLock<Arc<dyn crate::node::browser::SessionHooks>>,
    /// The node's previews: a removed project's end, and its preview worktrees go.
    previews: std::sync::OnceLock<Arc<crate::node::preview::Previews>>,
}

/// A project's file list and when it was read.
type Listed = (Instant, Arc<Vec<String>>);

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
        if let Some(pending) = self.row.summary.pending_permission.take() {
            self.cancel_prompt(&pending.request_id);
        }
    }

    fn cancel_prompt(&mut self, request_id: &str) {
        let id = permission_item_id(request_id);
        if let Ok(Some(mut item)) = self.store.item(&self.id(), &id)
            && item.status == ItemStatus::Running
        {
            item.status = ItemStatus::Cancelled;
            item.completed_at = Some(self.at.clone());
            item.updated_at = self.at.clone();
            self.put_item(item);
        }
    }

    /// claude withdrew prompt `request_id` (`control_cancel_request`, e.g. its tool call was aborted): nobody can
    /// answer it any more, so the pending permission clears and the run is no longer waiting.
    fn withdraw_prompt(&mut self, request_id: &str) {
        self.cancel_prompt(request_id);
        if self
            .row
            .summary
            .pending_permission
            .as_ref()
            .is_some_and(|p| p.request_id == request_id)
        {
            self.row.summary.pending_permission = None;
            for run in self
                .runs
                .iter_mut()
                .filter(|r| r.status == RunStatus::Waiting)
            {
                run.status = RunStatus::Running;
            }
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
            st.outbox.enabled = false;
        }
    }
}

impl SessionService {
    /// Hands the node's browser broker to its sessions; the sessions started from then on get agent-browser.
    pub fn set_browser(&self, hooks: Arc<dyn crate::node::browser::SessionHooks>) {
        let _ = self.inner.browser.set(hooks);
    }

    pub fn set_previews(&self, previews: Arc<crate::node::preview::Previews>) {
        let _ = self.inner.previews.set(previews);
    }

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
                workspaces: Mutex::default(),
                health: Mutex::new(Health::default()),
                probing: tokio::sync::Mutex::new(()),
                health_changed: Arc::new(tokio::sync::Notify::new()),
                limits: Mutex::default(),
                files: Mutex::default(),
                running: watch::Sender::new(0),
                span_wake: Arc::new(tokio::sync::Notify::new()),
                browser: std::sync::OnceLock::new(),
                previews: std::sync::OnceLock::new(),
            }),
        };
        let rows = service.inner.store.sessions()?;
        // Scratch dirs whose worktree is still there are kept; no other outlives a node restart.
        let keep: Vec<String> = rows
            .iter()
            .filter(|r| r.local.base_ref.is_some() && r.summary.worktree_path.is_some())
            .map(|r| r.summary.session_id.to_string())
            .collect();
        for mut row in rows {
            // A session stored on another model or effort resumes on its profile's: only the two run.
            let runner = &service.inner.runner;
            let runs_on = runner.profile(runner.profile_of(&row.summary.model, row.summary.effort));
            if (row.summary.model.as_str(), row.summary.effort) != (runs_on.model, runs_on.effort) {
                row.summary.model = runs_on.model.into();
                row.summary.effort = runs_on.effort;
                service.inner.store.commit(&row, &[], false)?;
            }
            if let (Some(pid), Some(started)) = (row.local.pid, &row.local.pid_start) {
                proc::kill_recorded(pid, started, &row.summary.session_id, INTERRUPT_GRACE).await;
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
        let node_home = service.inner.config.home.clone();
        let swept = blocking(move || share::sweep_scratch(&node_home, &keep)).await;
        if swept > 0 {
            tracing::info!(swept, "removed scratch dirs a previous node left");
        }
        let home = crate::node::util::home_dir();
        let removed = blocking(move || super::repos::remove_partials(&home)).await;
        if removed > 0 {
            tracing::info!(removed, "removed clones a previous node left half done");
        }
        service.spawn_reaper();
        service.spawn_prober();
        service.spawn_span_flusher(service.inner.span_wake.clone());
        Ok(service)
    }

    /// Which session a process calling the node's socket runs in (blocking: it reads the process table).
    pub fn peer_session(&self, pid: i32) -> super::runner::process::PeerSession {
        let roots = self
            .st()
            .live
            .iter()
            .map(|(id, live)| (live.pid as i32, id.clone()))
            .collect();
        super::runner::process::peer_session(&super::runner::process::table(), pid, &roots)
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
            SessionCall::ProjectRemove {
                project_id,
                remove_worktrees,
            } => self.project_remove(&project_id, remove_worktrees).await,
            SessionCall::ProjectEnv {
                project_id,
                set,
                remove,
            } => {
                self.project_root(&project_id)?;
                let home = self.inner.config.home.clone();
                let secrets = blocking(move || {
                    let box_key = super::identity::load_or_create_box_key(&home).ok();
                    super::project_env::apply(
                        &home,
                        project_id.as_str(),
                        &set,
                        &remove,
                        box_key.as_ref(),
                    )
                })
                .await
                .map_err(invalid)?;
                Ok(SessionOutput::ProjectEnv { secrets })
            }
            SessionCall::OrderEnvDrop {
                project_id,
                order_id,
                name,
                fingerprint,
            } => {
                let home = self.inner.config.home.clone();
                blocking(move || match name {
                    Some(name) => super::order_env::forget_one(
                        &home,
                        project_id.as_str(),
                        order_id.as_str(),
                        name.as_str(),
                        fingerprint.as_ref().map(|f| f.as_str()),
                    ),
                    None => super::order_env::forget(&home, project_id.as_str(), order_id.as_str()),
                })
                .await
                .map_err(invalid)?;
                Ok(SessionOutput::Done)
            }
            SessionCall::ProjectWorktrees { project_id } => {
                let root = self.project_root(&project_id)?;
                let dir = self.worktrees_dir(&project_id);
                let held = self.worktrees_of(&project_id)?;
                let worktrees = blocking(move || {
                    let base_branch = worktree::has_commit(&root)
                        .then(|| worktree::default_branch(&root))
                        .flatten();
                    let worktrees = held
                        .into_iter()
                        .filter(|(_, path, _)| path.is_dir())
                        .map(|(session_id, path, branch)| ProjectWorktree {
                            session_id,
                            // A worktree git can't read is counted as holding work, so the confirm names it.
                            uncommitted: worktree::uncommitted(&path).unwrap_or(true),
                            path: path.to_string_lossy().into_owned(),
                            branch,
                        })
                        .collect();
                    ProjectWorktrees {
                        dir: dir.to_string_lossy().into_owned(),
                        base_branch,
                        worktrees,
                    }
                })
                .await;
                Ok(SessionOutput::ProjectWorktrees(worktrees))
            }
            SessionCall::McpSecrets {
                scope,
                server,
                set,
                keep,
            } => {
                if let fleetd_contracts::mcp_servers::McpSecretScope::Project { project_id } =
                    &scope
                {
                    self.project_root(project_id)?;
                }
                let home = self.inner.config.home.clone();
                let secrets = blocking(move || {
                    let box_key = super::identity::load_or_create_box_key(&home).ok();
                    super::mcp_servers::apply(&home, &scope, &server, &set, &keep, box_key.as_ref())
                })
                .await
                .map_err(invalid)?;
                Ok(SessionOutput::McpSecrets { secrets })
            }
            SessionCall::McpTest { project_id, server } => {
                let config = &self.inner.config;
                let mut env = config.runner_env();
                let cwd = match &project_id {
                    Some(project_id) => {
                        let root = self.project_root(project_id)?;
                        let mut project_env =
                            super::project_env::vars(&config.home, project_id.as_str());
                        project_env.retain(|(p, _)| {
                            !env.iter().any(|(k, _)| k == p)
                                && p != super::browser::onepassword::TOKEN_ENV
                        });
                        env.extend(project_env);
                        root
                    }
                    None => super::util::home_dir(),
                };
                let result = match super::mcp_servers::resolve(&config.home, &server) {
                    Ok(resolved) => super::mcp_probe::probe(&resolved, &cwd, &env).await,
                    Err(missing) => fleetd_contracts::mcp_servers::McpTestResult {
                        error: Some(format!(
                            "this machine doesn't hold its {}: save the server again",
                            missing.join(", ")
                        )),
                        ..Default::default()
                    },
                };
                Ok(SessionOutput::McpTested(result))
            }
            SessionCall::Launch(launch) => self.launch(launch).await,
            SessionCall::Send {
                session_id,
                run_id,
                text,
                mode,
                steer,
                mcp,
                skills,
            } => {
                if let Some(config) = mcp {
                    self.refresh_mcp(&session_id, config).await;
                }
                if let Some(skills) = skills {
                    self.refresh_skills(&session_id, &skills).await;
                }
                let waiter = (mode == SendMode::Now).then(|| {
                    let (tx, rx) = oneshot::channel();
                    self.st().send_now_waiters.insert(run_id.to_string(), tx);
                    rx
                });
                let queued = self
                    .begin_run(&session_id, &run_id, &text, mode, steer)
                    .await;
                let send_now = match (waiter, &queued) {
                    (Some(rx), Ok(true)) => tokio::time::timeout(steers::SEND_NOW_WAIT, rx)
                        .await
                        .ok()
                        .and_then(Result::ok),
                    _ => None,
                };
                self.st().send_now_waiters.remove(run_id.as_str());
                Ok(SessionOutput::Sent(SendAccepted {
                    run_id,
                    queued: queued?,
                    send_now,
                }))
            }
            SessionCall::Withdraw { session_id, run_id } => {
                self.withdraw(&session_id, &run_id).await
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
                by,
            } => self.answer(&session_id, &request_id, decision, by).await,
            SessionCall::Subscribe { after, spans_after } => {
                let reply = self.subscribe(after);
                if let Some(cursor) = spans_after {
                    // A cursor past every row this outbox ever had is from a reset database: send all of it.
                    let cursor = if cursor > self.store().spans_head()? {
                        0
                    } else {
                        cursor
                    };
                    let mut st = self.st();
                    st.outbox.enabled = true;
                    st.outbox.sent = cursor;
                    st.outbox.acked = cursor;
                    st.outbox.urgent = true;
                    drop(st);
                    self.inner.span_wake.notify_one();
                }
                reply
            }
            SessionCall::Window {
                session_id,
                item_id,
                before,
                after,
            } => {
                let (entries, focus) = self.store().window(
                    &session_id,
                    &item_id,
                    before.get() as usize,
                    after.get() as usize,
                )?;
                Ok(SessionOutput::Window { entries, focus })
            }
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
            SessionCall::SkillsList { project_id } => {
                let root = self.project_root(&project_id)?;
                let skills = blocking(move || super::skills::repo_skills(&root)).await;
                Ok(SessionOutput::Skills { skills })
            }
            SessionCall::RepoScan => {
                let home = crate::node::util::home_dir();
                let (clone_root, repos) = blocking(move || super::repos::scan(&home)).await;
                Ok(SessionOutput::Repos { clone_root, repos })
            }
            SessionCall::RepoInspect { path } => {
                let path = PathBuf::from(path.as_str());
                Ok(SessionOutput::RepoFacts(
                    blocking(move || super::repos::inspect(&path)).await,
                ))
            }
            SessionCall::RepoClone { add_id, url, dest } => {
                self.repo_clone(add_id, &url, &dest).await
            }
            SessionCall::GhRepoList => {
                Ok(SessionOutput::GhRepos(super::repos::gh_repo_list().await))
            }
            SessionCall::LandedLog {
                project_id,
                branch,
                since_ms,
                stop_at,
            } => {
                let root = self.project_root(&project_id)?;
                let stop_at = stop_at.map(|s| s.to_string());
                let log = blocking(move || {
                    super::landed::landed_log(&root, &branch, since_ms.get(), stop_at.as_deref())
                })
                .await?;
                Ok(SessionOutput::LandedLog(log))
            }
            SessionCall::DefaultBranch { project_id } => {
                let root = self.project_root(&project_id)?;
                // A new repo with no commit yet has nothing to start a worktree from: none, as for no checkout.
                let branch = blocking(move || {
                    worktree::has_commit(&root)
                        .then(|| worktree::default_branch(&root))
                        .flatten()
                })
                .await;
                Ok(SessionOutput::DefaultBranch { branch })
            }
            SessionCall::Changes { session_id } => {
                let row = self.session(&session_id)?;
                let (cwd, root) = (row.local.cwd.clone(), row.local.workspace_root.clone());
                let recorded = row.local.base_ref.clone();
                let paths = if cwd.is_dir() {
                    blocking(move || {
                        let base = recorded.map(|b| worktree::changes_base(&root, &b));
                        worktree::changes(&cwd, base.as_deref())
                    })
                    .await?
                } else {
                    Vec::new()
                };
                Ok(SessionOutput::Changes(SessionChanges {
                    branch: row.summary.branch,
                    worktree_path: row.summary.worktree_path,
                    paths,
                }))
            }
            SessionCall::RunnerInfo => Ok(SessionOutput::RunnerInfo(self.runner_info().await)),
            SessionCall::ListFiles {
                project_id,
                query,
                limit,
            } => {
                let all = self.project_files(&project_id).await?;
                let limit = limit.get() as usize;
                let (paths, truncated) = blocking(move || files::rank(&all, &query, limit)).await;
                Ok(SessionOutput::Files { paths, truncated })
            }
            SessionCall::PutFile {
                project_id,
                rel_path,
                data_b64,
            } => {
                use base64::Engine;
                let root = self.project_root(&project_id)?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_b64.as_bytes())
                    .map_err(|e| invalid(format!("the file is not base64: {e}")))?;
                blocking(move || files::put_file(&root, &rel_path, &bytes))
                    .await
                    .map_err(invalid)?;
                Ok(SessionOutput::Done)
            }
        }
    }

    /// The project's files, listed at most every `FILES_FOR`.
    async fn project_files(&self, project_id: &str) -> Result<Arc<Vec<String>>, SessionError> {
        if let Some((at, files)) = self.inner.files.lock().unwrap().get(project_id)
            && at.elapsed() < FILES_FOR
        {
            return Ok(files.clone());
        }
        let root = self.project_root(project_id)?;
        let listed = Arc::new(
            blocking(move || files::git_files(&root))
                .await
                .map_err(|e| error(SessionErrorCode::Git, e))?,
        );
        self.inner
            .files
            .lock()
            .unwrap()
            .insert(project_id.to_owned(), (Instant::now(), listed.clone()));
        Ok(listed)
    }

    fn remember_limit(&self, limit: crate::node::runner::RateLimit) {
        let key = limit.limit_type.clone().unwrap_or_else(|| "unknown".into());
        self.inner
            .limits
            .lock()
            .unwrap()
            .insert(key, (limit, now()));
    }

    /// The node home, where the worktrees live: the heartbeat reports its volume's free space.
    pub fn home(&self) -> PathBuf {
        self.inner.config.home.clone()
    }

    /// The claude.ai usage windows sessions last reported, for the heartbeat.
    pub fn login_limits(&self) -> Vec<fleetd_contracts::node_link::LoginLimit> {
        use fleetd_contracts::node_link::LoginLimit;
        use fleetd_contracts::prim::{NonNegative, Text};
        self.inner
            .limits
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(kind, (l, observed_at))| {
                Some(LoginLimit {
                    limit_type: Text::new(super::util::head_utf16(kind, 40)).ok()?,
                    utilization: l.utilization.and_then(|u| NonNegative::new(u).ok()),
                    resets_at: l
                        .resets_at
                        .and_then(|s| chrono::DateTime::from_timestamp(s, 0))
                        .map(|d| {
                            d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                                .into()
                        }),
                    status: Text::new(super::util::head_utf16(&l.status, 40)).ok()?,
                    observed_at: Some(observed_at.clone()),
                })
            })
            .take(4)
            .collect()
    }

    fn session(&self, id: &str) -> Result<SessionRow, SessionError> {
        self.store()
            .session(id)?
            .ok_or_else(|| not_found(format!("no session {id} on this machine")))
    }

    /// A project's checkout on this machine, for its previews.
    pub fn project_workspace(&self, project_id: &str) -> Option<PathBuf> {
        self.project_root(project_id).ok()
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
        let mut st = self.st();
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
        if row.summary.active_run_id.is_some() {
            st.active.insert(id.to_owned());
        } else {
            st.active.remove(id);
        }
        let running = st.active.len();
        self.inner
            .running
            .send_if_modified(|n| std::mem::replace(n, running) != running);
        Ok(out)
    }

    /// How many sessions have an active run, updated as runs start and end.
    pub fn running(&self) -> watch::Receiver<usize> {
        self.inner.running.subscribe()
    }

    /// The machine just woke. A run whose claude has said nothing since, and waits on no tool and no person, lost
    /// its stream with the network: after [`WAKE_GRACE`] it is interrupted and retried like a network failure, with
    /// `--resume` if the process has to go.
    pub fn woke(&self) {
        let service = self.clone();
        let since = Instant::now();
        tokio::spawn(async move {
            tokio::time::sleep(WAKE_GRACE).await;
            service.recover_after_sleep(since).await;
        });
    }

    async fn recover_after_sleep(&self, since: Instant) {
        let quiet: Vec<(String, u64)> = self
            .st()
            .live
            .iter()
            .filter(|(_, l)| !l.closing && l.last_active < since)
            .map(|(id, l)| (id.clone(), l.generation))
            .collect();
        for (id, generation) in quiet {
            let Ok(row) = self.session(&id) else { continue };
            let Some(run) = row
                .summary
                .active_run_id
                .filter(|_| row.summary.pending_permission.is_none())
            else {
                continue;
            };
            let busy = self
                .store()
                .newest_items(&id, 20)
                .is_ok_and(|(items, _)| items.iter().any(|i| i.status == ItemStatus::Running));
            if busy {
                continue;
            }
            let commands = self
                .st()
                .live
                .get_mut(&id)
                .filter(|l| l.generation == generation)
                .map(|l| {
                    l.slept = Some(run.to_string());
                    l.commands.clone()
                });
            let Some(commands) = commands else { continue };
            tracing::info!(session_id = %id, "claude said nothing since the machine woke; interrupting it to resume the run");
            let _ = commands.send(SessionCommand::Interrupt).await;
            let service = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(INTERRUPT_GRACE).await;
                let commands = service
                    .st()
                    .live
                    .get_mut(&id)
                    .filter(|l| l.generation == generation && l.slept.is_some())
                    .map(|l| {
                        l.closing = true;
                        l.commands.clone()
                    });
                if let Some(commands) = commands {
                    let _ = commands
                        .send(SessionCommand::Shutdown {
                            grace: Duration::ZERO,
                        })
                        .await;
                }
            });
        }
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
        let id = launch.session_id.to_string();
        // Idempotent: a retried launch gets the session the first one made.
        if let Some(row) = self.store().session(&id)? {
            return Ok(SessionOutput::Launched {
                summary: row.summary,
                base: None,
            });
        }
        if !path_safe(&id) {
            return Err(invalid(format!(
                "session id {id} has characters a path can't hold"
            )));
        }
        let root = self.project_root(&launch.project_id)?;
        // A session taking over an earlier one of the same branch (a task restarted fresh) works in that one's
        // worktree as it was left, uncommitted changes included; a worktree that is gone comes back first.
        let taken = match &launch.workspace {
            SessionWorkspace::Worktree {
                branch,
                from_session: Some(from),
                ..
            } => self.store().session(from.as_str())?.filter(|r| {
                r.local.base_ref.is_some() && r.local.branch.as_deref() == Some(branch.as_str())
            }),
            _ => None,
        };
        let lost = match &taken {
            Some(from) => self.lost_worktree(from).await?,
            None => None,
        };
        // `base_ref` names the PRs' target; the branch starts from a fresh fetch of the remote's copy of it. The fetch
        // runs outside the launch lock, so a slow remote holds up only the starts that need it, and starts that
        // arrive together share it.
        let base = match &launch.workspace {
            SessionWorkspace::Root => None,
            SessionWorkspace::Worktree { .. } if taken.is_some() => None,
            SessionWorkspace::Worktree { base_ref, .. }
            | SessionWorkspace::Detached { base_ref, .. } => {
                let (r, name) = (root.clone(), base_ref.to_string());
                let base = blocking(move || worktree::fresh_base(&r, &name)).await?;
                if let Some(note) = &base.note {
                    tracing::warn!(session_id = id.as_str(), "worktree {note}");
                }
                Some(base)
            }
        };
        // A review reads its PR's head when the remote publishes it, else the base; its prompt has it check.
        let head = match &launch.workspace {
            SessionWorkspace::Detached { pr: Some(pr), .. } => {
                let (r, url) = (root.clone(), pr.to_string());
                blocking(move || worktree::pr_head(&r, &url))
                    .await
                    .inspect_err(|e| {
                        tracing::warn!(
                            session_id = id.as_str(),
                            "worktree at the base, not {pr}'s head: {e}"
                        );
                    })
                    .ok()
            }
            _ => None,
        };
        let _launching = self.inner.launching.lock().await;
        // A retry that arrived while this one fetched.
        if let Some(row) = self.store().session(&id)? {
            return Ok(SessionOutput::Launched {
                summary: row.summary,
                base: None,
            });
        }
        let reported = base.as_ref().map(|b| WorktreeBase {
            base_ref: b.base_ref.clone(),
            sha: b.sha.clone(),
            fetched_at: b.fetched_at.clone().map(Timestamp),
            error: b.error.clone(),
            fork_behind: b.fork_behind,
        });
        let path = self
            .inner
            .config
            .home
            .join("worktrees")
            .join(launch.project_id.as_str())
            .join(&id);
        let mut recreated_from = None;
        let mut prompt = launch.prompt.to_string();
        let (cwd, add_dirs, base_ref, branch) = match (&launch.workspace, base, taken) {
            (_, _, Some(from)) => {
                let local = from.local;
                if let (Some(lost), Some(branch)) = (lost, &local.branch) {
                    let (r, p, b, f) = (
                        local.workspace_root.clone(),
                        local.cwd.clone(),
                        branch.clone(),
                        lost.clone(),
                    );
                    blocking(move || worktree::restore(&r, &p, &b, &f)).await?;
                    tracing::info!(
                        session_id = id.as_str(),
                        ?lost,
                        "recreated a lost worktree to take over"
                    );
                    recreated_from = Some(lost.kind());
                    // Rebuilt, it has none of what setup made there before.
                    super::worktree_setup::record(&local.cwd, None);
                    prompt = format!("{}\n\n{prompt}", lost.note(branch));
                }
                (local.cwd, local.add_dirs, local.base_ref, local.branch)
            }
            (SessionWorkspace::Detached { .. }, Some(base), None) => {
                let sha = head.unwrap_or(base.sha);
                let (r, p, s) = (root.clone(), path.clone(), sha.clone());
                blocking(move || worktree::ensure_detached(&r, &p, &s)).await?;
                (path, vec![root.clone()], Some(sha), None)
            }
            (SessionWorkspace::Worktree { branch, .. }, Some(base), None) => {
                let (r, p, b, sha) = (
                    root.clone(),
                    path.clone(),
                    branch.to_string(),
                    base.sha.clone(),
                );
                blocking(move || worktree::ensure(&r, &p, &b, &sha)).await?;
                (
                    path,
                    vec![root.clone()],
                    Some(base.base_ref),
                    Some(branch.to_string()),
                )
            }
            _ => (root.clone(), Vec::new(), None, None),
        };
        let at = now();
        let title = launch.title.clone().unwrap_or_else(|| {
            let first = launch.prompt.lines().next().unwrap_or_default();
            first.chars().take(80).collect()
        });
        // Only the two profiles run, whatever an older hub asks for.
        let profile = launch.profile.unwrap_or_else(|| {
            self.inner.runner.profile_of(
                launch.model.as_deref().unwrap_or_default(),
                launch.effort.unwrap_or(Effort::High),
            )
        });
        let runs_on = self.inner.runner.profile(profile);
        // Setup applies to a session in a worktree of its own.
        let setup = launch
            .setup
            .map(|s| *s)
            .filter(|s| !s.is_empty() && base_ref.is_some());
        let row = SessionRow {
            summary: SessionSummary {
                session_id: launch.session_id.clone(),
                project_id: launch.project_id.clone(),
                title,
                status: SessionStatus::Idle,
                model: runs_on.model.into(),
                effort: runs_on.effort,
                runtime_mode: launch.runtime_mode,
                latest_run: None,
                active_run_id: None,
                pending_permission: None,
                latest_assistant_tail: None,
                branch: branch.clone(),
                worktree_path: base_ref
                    .is_some()
                    .then(|| cwd.to_string_lossy().into_owned()),
                recreated_at: recreated_from.is_some().then(|| at.clone()),
                recreated_from,
                created_at: at.clone(),
                updated_at: at,
            },
            local: SessionLocal {
                cwd,
                add_dirs,
                config_dir: setup::config_dir(&self.inner.config.runner_env()),
                workspace_root: root,
                base_ref,
                branch,
                started: false,
                pid: None,
                pid_start: None,
                allowed_tools: launch.allowed_tools.clone(),
                disallowed_tools: launch.disallowed_tools.clone(),
                role: launch.role,
                order_id: launch.order_id.as_ref().map(|o| o.to_string()),
                setup_pending: setup.is_some(),
                setup: setup.clone(),
            },
        };
        self.store().commit(&row, &[], false)?;
        if let (Some(role), Some(config)) = (launch.mcp_role, launch.mcp.clone()) {
            self.keep_mcp(&id, super::mcp_servers::Kept { role, config })
                .await;
        }
        let dir = self.inner.config.home.join("sessions").join(&id);
        super::skills::keep(&dir, &launch.skills).map_err(|e| {
            error(
                SessionErrorCode::Internal,
                format!("cannot keep the session's skills: {e}"),
            )
        })?;
        let prompt = match launch.role {
            SessionRole::Worker => {
                let home = self.inner.config.home.clone();
                let n = blocking(move || super::load::build_jobs_here(&home)).await;
                let set = share::jobs_env(&self.inner.config.runner_env(), n);
                format!("{}\n\n{}", prompt.trim_end(), share::brief_note(&set, n))
            }
            _ => prompt,
        };
        let prompt = self.with_env_note(&row, prompt);
        // A new worktree is set up first, while the run shows as starting; the brief goes to claude once it is done.
        match setup {
            Some(setup) => {
                self.begin_after_setup(&id, &launch.run_id, prompt, setup)
                    .await?
            }
            None => {
                self.begin_run(&id, &launch.run_id, &prompt, SendMode::Plain, None)
                    .await?;
            }
        }
        Ok(SessionOutput::Launched {
            summary: self.session(&id)?.summary,
            base: reported,
        })
    }

    /// Records a run and its user message, then hands the message to the session's process (spawning or resuming
    /// it). Returns whether the run waits behind an active one. Idempotent on `run_id`.
    async fn begin_run(
        &self,
        id: &str,
        run_id: &NonEmpty,
        text: &str,
        mode: SendMode,
        steer: Option<SteerTag>,
    ) -> Result<bool, SessionError> {
        let workspace = self.workspace_lock(id);
        let _workspace = workspace.lock().await;
        // A new turn of a session whose order's variables changed starts a new claude, which has them.
        self.renew_env(id).await;
        let queued = match self.record_run(id, run_id, text, steer)? {
            Ok(queued) => queued,
            Err(was_queued) => return Ok(was_queued),
        };
        // The worktree is still being set up: the message goes once that has ended and the brief has gone.
        let setting_up = self.st().setting_up.get(id).cloned();
        if let Some(mut done) = setting_up {
            let (service, id, run_id, text) =
                (self.clone(), id.to_owned(), run_id.clone(), text.to_owned());
            tokio::spawn(async move {
                let started = done.wait_for(Option::is_some).await.ok().and_then(|d| *d);
                if started == Some(true) {
                    let _ = service.send_run(&id, &run_id, &text, mode).await;
                } else {
                    let why = "the session did not start: its worktree setup failed or was stopped";
                    service.fail_run(&id, &run_id, FailureClass::Other, why);
                    service.steer_failed(&run_id, why);
                }
            });
            return Ok(queued);
        }
        // Setup is due (the node stopped before it ended, or the worktree is gone and comes back): it runs again
        // first, in the background, and the message goes once it has ended.
        if !queued && let Some(setup) = self.setup_due(id) {
            self.set_up_then_send(id, run_id, text.to_owned(), mode, setup);
            return Ok(queued);
        }
        self.send_run(id, run_id, text, mode).await?;
        Ok(queued)
    }

    /// Records a run and its user message; `Err(queued)` when the run was recorded before (a retry).
    fn record_run(
        &self,
        id: &str,
        run_id: &NonEmpty,
        text: &str,
        steer: Option<SteerTag>,
    ) -> Result<Result<bool, bool>, SessionError> {
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
                queued_at: Some(c.at.clone()),
                started_at: None,
                ended_at: None,
                superseded_by: None,
                failure: None,
                usage: None,
                end: None,
                ended_by: None,
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
            Err(was_queued) => return Ok(Err(was_queued)),
        };
        {
            let mut st = self.st();
            if !queued && !st.live.contains_key(id) {
                st.spawned.insert(run_id.to_string());
            }
        }
        if let Some(tag) = steer {
            for rider in tag.riders {
                self.track_steer(id, run_id, rider, queued);
            }
            self.track_steer(id, run_id, tag.id, queued);
        }
        Ok(Ok(queued))
    }

    /// Hands a recorded run's message to the session's process, spawning or resuming it; a failure fails the run.
    async fn send_run(
        &self,
        id: &str,
        run_id: &NonEmpty,
        text: &str,
        mode: SendMode,
    ) -> Result<(), SessionError> {
        let command = SessionCommand::Send {
            run_id: run_id.to_string(),
            text: text.to_owned(),
            mode,
        };
        if let Err(e) = self.dispatch(id, command, None).await {
            self.fail_run(id, run_id, FailureClass::Other, e.message.as_str());
            self.steer_failed(run_id, e.message.as_str());
            return Err(e);
        }
        Ok(())
    }

    fn fail_run(&self, id: &str, run_id: &str, class: FailureClass, message: &str) {
        self.st().slept.remove(run_id);
        let failed = self.update(id, |c| {
            let at = c.at.clone();
            if let Some(run) = c.run_mut(run_id).filter(|r| r.status.is_active()) {
                run.status = RunStatus::Failed;
                run.ended_at = Some(at);
                let failure = RunFailure {
                    class,
                    message: Text::new(message).unwrap_or_else(|_| Text::unchecked("failed")),
                    api_status: None,
                    reset_at: None,
                    retries: 0,
                    model: None,
                };
                run.end = Some(state::failure_end(&failure));
                run.failure = Some(failure);
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
        // The session's first message going (again): a start without a conversation begins with the brief itself.
        let opening = match &command {
            SessionCommand::Send { text, .. } => self
                .store()
                .runs(id)?
                .first()
                .map(|first| self.store().message(id, first.id.as_str()))
                .transpose()?
                .flatten()
                .is_some_and(|m| {
                    // A worker's first message is the hub's brief and then the node's build-jobs note
                    // (`share::brief_note`), which the hub never sends back.
                    m.text == *text
                        || m.text
                            .strip_prefix(text.trim_end())
                            .is_some_and(|rest| rest.starts_with("\n\n"))
                }),
            _ => false,
        };
        let (commands, note) = self.ensure_live(id, opening).await?;
        // The agent hears that its worktree was rebuilt before anything else, so it checks what is left.
        let command = match (command, note) {
            (SessionCommand::Send { run_id, text, mode }, Some(note)) => SessionCommand::Send {
                run_id,
                text: format!("{note}\n\n{text}"),
                mode,
            },
            (command, _) => command,
        };
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

    /// The live process's command channel, spawning (first start) or resuming the session when there is none, and
    /// the note for the agent when its worktree had to be rebuilt. `opening`: what goes first is the session's first
    /// message.
    async fn ensure_live(
        &self,
        id: &str,
        opening: bool,
    ) -> Result<(mpsc::Sender<SessionCommand>, Option<String>), SessionError> {
        // Finding what is left of a lost worktree's branch can wait on remotes, so it runs before the spawn lock: other
        // sessions' starts never wait on it.
        let found = if self.st().live.contains_key(id) {
            None
        } else {
            self.lost_worktree(&self.session(id)?).await?
        };
        let _spawning = self.inner.spawning.lock().await;
        let closing = match self.st().live.get(id) {
            Some(live) if !live.closing => return Ok((live.commands.clone(), None)),
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
        let resume = state::start_mode(&row.local, &setup::config_dir(&config.runner_env()), id)
            .map_err(|m| error(SessionErrorCode::RunnerUnavailable, m))?;
        let (recreated, note) = self.restore_worktree(id, &mut row, found).await?;
        if !row.local.cwd.is_dir() {
            return Err(invalid(format!(
                "the session's workspace {} is missing",
                row.local.cwd.display()
            )));
        }
        // A task's agent can't go on without its conversation, even one whose first run died before claude answered:
        // a later message alone (a recovery note) would leave it with no idea of its task. Refused, so the hub restarts
        // it with its brief and a handoff. Only its first message itself may start over.
        let must_resume = resume && !opening && row.local.role == SessionRole::Worker;
        let (spec, secrets, order_digest) = self.spec(&row, resume, must_resume).map_err(|e| {
            error(
                SessionErrorCode::Internal,
                format!("cannot prepare the session's files: {e}"),
            )
        })?;
        let secrets = Arc::new(secrets);
        let handle = self.inner.runner.spawn(spec).map_err(runner_error)?;
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
                    slept: None,
                    order_digest,
                    spawned: secrets.clone(),
                },
            );
            generation
        };
        tokio::spawn(self.clone().pump(
            id.to_owned(),
            generation,
            handle.events,
            exited_tx,
            secrets,
        ));
        Ok((handle.commands, note))
    }

    /// Keeps a session's MCP servers in its directory for its next start.
    async fn keep_mcp(&self, id: &str, kept: super::mcp_servers::Kept) {
        let dir = self.inner.config.home.join("sessions").join(id);
        if let Err(e) = blocking(move || super::mcp_servers::keep(&dir, &kept)).await {
            tracing::warn!(session = id, "the session's MCP servers were not kept: {e}");
        }
    }

    /// The hub's MCP servers for a session changed: kept for its next start (a running claude keeps the servers it
    /// started with). A session from before MCP servers takes its role from what it is; a plain thread gets none.
    async fn refresh_mcp(&self, id: &str, config: fleetd_contracts::mcp_servers::McpSessionConfig) {
        use fleetd_contracts::mcp_servers::McpAgentRole;
        let Ok(Some(row)) = self.store().session(id) else {
            return;
        };
        let dir = self.inner.config.home.join("sessions").join(id);
        let role = match super::mcp_servers::kept(&dir) {
            Some(kept) => kept.role,
            None => match row.local.role {
                SessionRole::Plain => return,
                SessionRole::Lead => McpAgentRole::Lead,
                SessionRole::Worker if row.local.branch.is_some() => McpAgentRole::Writer,
                SessionRole::Worker => McpAgentRole::Reviewer,
            },
        };
        self.keep_mcp(id, super::mcp_servers::Kept { role, config })
            .await;
    }

    /// The hub's skills for a session changed: kept for its next start, and its skills folder written again now, so a
    /// running session reads a new one there (`FLEETD_SKILLS_DIR`) before its next start lists it.
    async fn refresh_skills(&self, id: &str, bundles: &[fleetd_contracts::skills::SkillBundle]) {
        let Ok(Some(row)) = self.store().session(id) else {
            return;
        };
        let dir = self.inner.config.home.join("sessions").join(id);
        let (cwd, bundles) = (row.local.cwd.clone(), bundles.to_vec());
        let done = blocking(move || {
            super::skills::keep(&dir, &bundles)?;
            super::skills::prepare(&dir, &cwd).map(|_| ())
        })
        .await;
        if let Err(e) = done {
            tracing::warn!(session = id, "the session's skills were not refreshed: {e}");
        }
    }

    /// Brings a session's worktree back at its path when it is gone: a writer's from what is left of its branch
    /// (`found`, or looked up now), a reader's detached one at its commit. Returns whether it did, and the note for the
    /// agent when a writer's was rebuilt. The caller commits the row.
    async fn restore_worktree(
        &self,
        id: &str,
        row: &mut SessionRow,
        found: Option<worktree::Source>,
    ) -> Result<(bool, Option<String>), SessionError> {
        // A worktree that is gone (removed by `stop{removeWorktree}`, or deleted) comes back at the same path, so the
        // session still resumes, from what is left of its branch.
        let mut recreated = false;
        let mut note = None;
        let from = match found {
            Some(from) if !row.local.cwd.exists() => Some(from),
            // Only when the worktree went missing meanwhile.
            _ => self.lost_worktree(row).await?,
        };
        if let (Some(from), Some(branch)) = (from, &row.local.branch) {
            let (r, p, b, f) = (
                row.local.workspace_root.clone(),
                row.local.cwd.clone(),
                branch.clone(),
                from.clone(),
            );
            blocking(move || worktree::restore(&r, &p, &b, &f)).await?;
            tracing::info!(session_id = id, ?from, "recreated a lost worktree");
            note = Some(from.note(branch));
            row.summary.recreated_from = Some(from.kind());
            row.summary.recreated_at = Some(now());
            row.summary.worktree_path = Some(row.local.cwd.to_string_lossy().into_owned());
            row.summary.branch = row.local.branch.clone();
            recreated = true;
        }
        // A reader's detached worktree, removed at its task's end, comes back at the same commit.
        if let (Some(at), None) = (&row.local.base_ref, &row.local.branch)
            && !row.local.cwd.exists()
        {
            let (r, p, a) = (
                row.local.workspace_root.clone(),
                row.local.cwd.clone(),
                at.clone(),
            );
            blocking(move || worktree::ensure_detached(&r, &p, &a)).await?;
            row.summary.worktree_path = Some(row.local.cwd.to_string_lossy().into_owned());
            recreated = true;
        }
        // A rebuilt worktree has none of what setup made: setup runs again before its agent goes on.
        if recreated {
            super::worktree_setup::record(&row.local.cwd, None);
            if row.local.setup.is_some() {
                row.local.setup_pending = true;
            }
        }
        Ok((recreated, note))
    }

    /// Where a writer's worktree that is gone comes back from; `None` while it is there, or for a session in the root.
    async fn lost_worktree(
        &self,
        row: &SessionRow,
    ) -> Result<Option<worktree::Source>, SessionError> {
        let (Some(base_ref), Some(branch)) = (&row.local.base_ref, &row.local.branch) else {
            return Ok(None);
        };
        if row.local.cwd.exists() {
            return Ok(None);
        }
        let (r, b, base) = (
            row.local.workspace_root.clone(),
            branch.clone(),
            base_ref.clone(),
        );
        Ok(Some(
            blocking(move || worktree::source(&r, &b, &base)).await?,
        ))
    }

    /// The process spec, after writing the session's MCP config and settings overlay. The transcript is fleetd's own
    /// copy (claude keeps its session in the config dir); its writer keeps it under its cap.
    fn spec(
        &self,
        row: &SessionRow,
        resume: bool,
        must_resume: bool,
    ) -> std::io::Result<(SessionSpec, super::mask::Secrets, Option<String>)> {
        let config = &self.inner.config;
        let id = row.summary.session_id.as_str();
        let dir = config.home.join("sessions").join(id);
        super::config::mkdir_private(&dir)?;
        let mcp = dir.join("mcp.json");
        let sock = super::lead::lead_socket_path(&config.home);
        // The configured servers of the session's role, their secrets resolved here, then fleetd's own. The file
        // holds secrets, so it is written as the node's secret files are (0600).
        let kept = super::mcp_servers::kept(&dir);
        let session_mcp = super::mcp_servers::session_config(
            &config.home,
            kept.as_ref(),
            fleetd_server(row.local.role, &sock, id),
            id,
        );
        super::secrets::write_atomic(&mcp, session_mcp.json.as_bytes())?;
        let transcripts = config.home.join("transcripts");
        super::config::mkdir_private(&transcripts)?;
        let transcript = transcripts.join(format!("{id}.jsonl"));

        let mut env = config.runner_env();
        // The project's own variables, re-read per spawn. What the node already gives claude (its login, gateway,
        // claude.env) keeps the node's value, and fleetd's values below still win.
        let (mut project_env, mut secrets) =
            super::project_env::for_spawn(&config.home, row.summary.project_id.as_str());
        secrets.extend(session_mcp.secrets.iter().cloned());
        // A task's order's own variables on top, each in place of the project's of the same name.
        let (order_env, order_digest) = self.order_vars(row);
        project_env.retain(|(p, _)| !order_env.iter().any(|(o, _)| o == p));
        secrets.extend(order_env.iter().cloned());
        project_env.extend(order_env);
        let secrets = super::mask::Secrets(secrets);
        project_env.retain(|(p, _)| !env.iter().any(|(k, _)| k == p));
        // The 1Password token is the node's alone, for fill_credential: no agent gets it. It stays in `secrets`, masked.
        project_env.retain(|(p, _)| p != super::browser::onepassword::TOKEN_ENV);
        env.extend(project_env);
        let mut role_env = config.prompt_cache_env(row.local.role, &env);
        role_env.extend(claude::role_env(row.local.role, &env));
        env.retain(|(k, _)| !role_env.iter().any(|(c, _)| c == k));
        env.extend(role_env.iter().cloned());
        let skills = super::skills::prepare(&dir, &row.local.cwd)?;
        env.push((
            super::skills::DIR_ENV.to_owned(),
            super::skills::skills_dir(&dir)
                .to_string_lossy()
                .into_owned(),
        ));
        let settings = dir.join("settings.json");
        std::fs::write(&settings, settings_overlay(&role_env, skills.overrides()))?;
        env.extend([
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
        let (key, value) = AUTO_MEMORY_OFF_ENV;
        env.retain(|(k, _)| k != key);
        env.push((key.to_owned(), value.to_owned()));
        env.extend(compile_cache_env(&env));
        // A writer's commits name its task, so its work merged by hand is found from git alone.
        if let Some(task) = row
            .local
            .branch
            .as_deref()
            .and_then(super::landed::branch_task)
            && row.local.cwd.is_dir()
            && let Err(e) = super::landed::trailer_hooks(&row.local.cwd, &task)
        {
            tracing::warn!(session = id, "commits won't name their task: {e}");
        }
        env.extend(share::jobs_env(
            &env,
            super::load::build_jobs_here(&config.home),
        ));
        let scratch = share::scratch_dir(&config.home, id);
        super::config::mkdir_private(&scratch)?;
        let scratch = share::scratch_env(&scratch);
        env.retain(|(k, _)| !scratch.iter().any(|(s, _)| s == k));
        env.extend(scratch);
        let mut plugin_dirs: Vec<PathBuf> = skills.plugin_dir.into_iter().collect();
        if let Some(browser) = self.inner.browser.get()
            && row.local.role.cli_arg().is_some()
        {
            let path = env
                .iter()
                .find(|(k, _)| k == "PATH")
                .map(|(_, v)| v.clone());
            let browser_env = browser.env(id, path.as_deref());
            env.retain(|(k, _)| !browser_env.iter().any(|(b, _)| b == k));
            env.extend(browser_env);
            plugin_dirs.extend(browser.plugin_dir());
        }
        let spec = SessionSpec {
            session_id: id.to_owned(),
            resume,
            must_resume,
            cwd: row.local.cwd.clone(),
            add_dirs: row.local.add_dirs.clone(),
            model: row.summary.model.clone(),
            effort: row.summary.effort,
            runtime_mode: row.summary.runtime_mode,
            allowed_tools: row.local.allowed_tools.clone(),
            disallowed_tools: ALWAYS_DISALLOWED
                .iter()
                .map(|t| (*t).to_owned())
                .chain(self.st().agent_tools.iter().cloned())
                .chain(claude::role_disallowed(row.local.role).map(str::to_owned))
                .chain(row.local.disallowed_tools.iter().cloned())
                .collect(),
            mcp_config: Some(mcp),
            strict_mcp: session_mcp.strict,
            settings: Some(settings),
            plugin_dirs,
            env,
            transcript: Some(transcript),
        };
        Ok((spec, secrets, order_digest))
    }

    /// Applies one process's events in order until it exits. Text deltas go only to followers, at most one frame
    /// per [`DELTA_EVERY`], and a pending one is dropped once its complete message is stored.
    async fn pump(
        self,
        id: String,
        generation: u64,
        mut events: mpsc::Receiver<RunnerEvent>,
        exited: watch::Sender<bool>,
        spawned: Arc<super::mask::Secrets>,
    ) {
        let mut delta: Option<(String, String)> = None;
        let mut flushed: Option<Instant> = None;
        let mut usage: Option<(String, RunUsage)> = None;
        let mut usage_sent: Option<Instant> = None;
        let mut run_id: Option<String> = None;
        // What its browser sessions filled from 1Password, masked like its secrets from the fill on.
        let mut filled = super::mask::Secrets::default();
        // The secrets the process was started with, which it holds until it exits, and the project's as they are now,
        // read again at each run's start.
        let mut masker = self.masker(&id, &spawned, &filled);
        loop {
            let delta_due = delta
                .as_ref()
                .map(|_| flushed.map_or_else(Instant::now, |at| at + DELTA_EVERY));
            let usage_due = usage
                .as_ref()
                .map(|_| usage_sent.map_or_else(Instant::now, |at| at + USAGE_EVERY));
            let next = match delta_due.into_iter().chain(usage_due).min() {
                Some(due) => {
                    tokio::select! {
                        event = events.recv() => event,
                        () = tokio::time::sleep_until(due) => {
                            let now = Instant::now();
                            if delta_due.is_some_and(|d| d <= now) {
                                self.flush_delta(&id, &mut delta, &run_id, &masker, true);
                                flushed = Some(now);
                            }
                            if usage_due.is_some_and(|d| d <= now) {
                                self.flush_usage(&id, &mut usage);
                                usage_sent = Some(now);
                            }
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
                self.steers_exited(&id, &exit);
                self.exited(&id, generation, exit);
                break;
            };
            if let Some(live) = self.st().live.get_mut(&id) {
                live.last_active = Instant::now();
            }
            if let Some(browser) = self.inner.browser.get()
                && let Some(more) = browser.filled_since(&id, filled.0.len())
            {
                filled = more;
                masker = self.masker(&id, &spawned, &filled);
            } else if matches!(event, RunnerEvent::RunStarted { .. }) {
                masker = self.masker(&id, &spawned, &filled);
            }
            // Nothing the agent's session reports leaves this machine with a secret of its project in it.
            let Some(event) = masker.event(event) else {
                tracing::warn!(
                    session_id = id.as_str(),
                    "an event dropped: masking a secret broke its shape"
                );
                continue;
            };
            match event {
                RunnerEvent::Delta { message_id, append } => {
                    if !self.st().followed.contains(&id) {
                        continue;
                    }
                    match &mut delta {
                        Some((m, text)) if *m == message_id => text.push_str(&append),
                        _ => {
                            self.flush_delta(&id, &mut delta, &run_id, &masker, false);
                            delta = Some((message_id, append));
                        }
                    }
                    if flushed.is_none_or(|at| at + DELTA_EVERY <= Instant::now()) {
                        self.flush_delta(&id, &mut delta, &run_id, &masker, true);
                        flushed = Some(Instant::now());
                    }
                }
                RunnerEvent::Exited(exit) => {
                    // Its agent-browser and its tools went with the process: so does its browser.
                    if let Some(browser) = self.inner.browser.get() {
                        browser.ended(&id);
                    }
                    self.steers_exited(&id, &exit);
                    self.exited(&id, generation, exit);
                    break;
                }
                RunnerEvent::RunStarted { run_id: started } => {
                    let started = self.resolve(&id, &started);
                    run_id = Some(started.clone());
                    let before = self.update(&id, |c| {
                        let at = c.at.clone();
                        let prev_end = c
                            .runs
                            .iter()
                            .filter(|r| r.id.as_str() != started)
                            .filter_map(|r| r.ended_at.clone())
                            .max_by(|a, b| a.as_str().cmp(b.as_str()));
                        let mut pre = None;
                        if let Some(run) = c.run_mut(&started)
                            && matches!(run.status, RunStatus::Queued | RunStatus::Starting)
                        {
                            pre = Some((run.status, run.queued_at.clone(), prev_end));
                            run.status = RunStatus::Running;
                            run.started_at.get_or_insert(at);
                        }
                        pre
                    });
                    match before {
                        Ok(pre) => self.run_began(&id, &started, pre),
                        Err(e) => tracing::warn!(error = %e.message, "session event not applied"),
                    }
                    self.steer_delivered(&started, false);
                    // A send claude took in after its turn was cut for the node's shutdown (the withdraw lost the
                    // race) must not run on through the drain.
                    let cut = {
                        let mut st = self.st();
                        let stopping = st.stopping;
                        st.live
                            .get_mut(&id)
                            .filter(|_| stopping)
                            .map(|l| l.commands.clone())
                    };
                    if let Some(commands) = cut {
                        let _ = commands.send(SessionCommand::Interrupt).await;
                    }
                }
                RunnerEvent::Spans(mut spans) => {
                    for span in &mut spans {
                        if let Some(r) = &span.run_id {
                            let resolved = self.resolve(&id, r.as_str());
                            span.run_id = Text::new(resolved).ok();
                        }
                    }
                    self.put_spans(&spans, true);
                }
                RunnerEvent::Joined { run_id: joined } => {
                    let joined = self.resolve(&id, &joined);
                    self.log(self.update(&id, |c| {
                        let at = c.at.clone();
                        if let Some(run) = c.run_mut(&joined)
                            && matches!(run.status, RunStatus::Queued | RunStatus::Starting)
                        {
                            run.status = RunStatus::Running;
                            run.started_at.get_or_insert(at);
                        }
                    }));
                    self.steer_delivered(&joined, true);
                }
                RunnerEvent::Queued { .. } => {}
                RunnerEvent::Seen { run_ids } => {
                    let run_ids: Vec<String> =
                        run_ids.iter().map(|r| self.resolve(&id, r)).collect();
                    self.steer_seen(&run_ids);
                }
                RunnerEvent::SendNow {
                    run_id: steer,
                    outcome,
                    stopped_tool,
                } => self.steer_send_now(&self.resolve(&id, &steer), outcome, stopped_tool),
                RunnerEvent::Withdrawn {
                    run_id: steer,
                    cancelled,
                    by_stop,
                } => self.steer_withdrawn(&self.resolve(&id, &steer), cancelled, by_stop),
                RunnerEvent::AssistantText { message_id, text } => {
                    if delta.as_ref().is_some_and(|(m, _)| *m == message_id) {
                        delta = None;
                    }
                    self.steer_text(&id, &message_id, &text);
                    self.assistant_text(&id, message_id, text, &run_id);
                }
                // The runner's only Permission item is a withdrawn prompt; the node keeps its own item per prompt.
                RunnerEvent::Item(ThreadItem {
                    kind: ItemKind::Permission { request_id, .. },
                    ..
                }) => self.log(self.update(&id, |c| c.withdraw_prompt(&request_id))),
                RunnerEvent::Item(item) => {
                    if let Some(browser) = self.inner.browser.get() {
                        browser.item(&id, &item);
                    }
                    self.log(self.update(&id, |c| c.put_item(item)))
                }
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
                    usage: usage_of_run,
                } => {
                    let ended = self.resolve(&id, &ended);
                    // The run's own usage follows on its `run` event.
                    if usage.as_ref().is_some_and(|(r, _)| *r == ended) {
                        usage = None;
                    }
                    self.run_ended(&id, &ended, outcome.clone(), usage_of_run);
                    let retrying = self.store().runs(&id).is_ok_and(|runs| {
                        runs.iter()
                            .any(|r| r.id.as_str() == ended && r.status.is_active())
                    });
                    if !retrying {
                        self.steer_ended(&ended, &outcome);
                    }
                }
                RunnerEvent::Usage {
                    run_id: run,
                    usage: so_far,
                } => {
                    if !self.st().followed.contains(&id) {
                        continue;
                    }
                    usage = Some((self.resolve(&id, &run), so_far));
                    if usage_sent.is_none_or(|at| at + USAGE_EVERY <= Instant::now()) {
                        self.flush_usage(&id, &mut usage);
                        usage_sent = Some(Instant::now());
                    }
                }
                RunnerEvent::RateLimit(limit) => self.remember_limit(limit),
                RunnerEvent::Init { agent_tools, .. } => {
                    if agent_tools.as_ref().is_none_or(|t| !t.is_empty()) {
                        self.agent_tools_offered(&id, run_id.as_deref(), agent_tools)
                            .await;
                    }
                }
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

    fn flush_usage(&self, id: &str, usage: &mut Option<(String, RunUsage)>) {
        if let Some((run_id, usage)) = usage.take()
            && let Ok(run_id) = NonEmpty::new(run_id)
        {
            self.st().thread(id, ThreadEvent::Usage { run_id, usage });
        }
    }

    /// For masking what the session reports: the secrets its process was `spawned` with (a rotated or removed one is
    /// still in its environment), its project's, order's and MCP servers' secrets now, and each value its browser
    /// sessions `filled` in every form a page may show it.
    fn masker(
        &self,
        id: &str,
        spawned: &super::mask::Secrets,
        filled: &super::mask::Secrets,
    ) -> super::mask::Masker {
        let now = match self.store().session(id) {
            Ok(Some(row)) => self.secrets_now(&row),
            _ => super::mask::Secrets::default(),
        };
        let all: Vec<(String, String)> = spawned.0.iter().chain(&now.0).cloned().collect();
        let all = super::mask::Secrets(all);
        super::mask::Masker::new(&all.0).and(super::mask::Masker::thorough(&filled.0))
    }

    /// Sends the live text so far, masked. `hold` keeps back an end that could be the start of a secret, until the
    /// next piece (or the complete message) shows what it is.
    fn flush_delta(
        &self,
        id: &str,
        delta: &mut Option<(String, String)>,
        run_id: &Option<String>,
        masker: &super::mask::Masker,
        hold: bool,
    ) {
        if let Some((message_id, mut append)) = delta.take() {
            let held = if hold { masker.held(&append) } else { 0 };
            if held > 0 {
                let kept = append.split_off(append.len() - held);
                *delta = Some((message_id.clone(), kept));
                if append.is_empty() {
                    return;
                }
            }
            let append = masker.text(&append).into_owned();
            self.send_delta(id, message_id, append, run_id);
        }
    }

    fn send_delta(&self, id: &str, message_id: String, append: String, run_id: &Option<String>) {
        if let Ok(message_id) = NonEmpty::new(message_id) {
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

    /// A session's init still offers claude's own agent tools, which would start agents outside fleetd's slots: a
    /// claude newer than fleetd's deny list, or one that ignores it (`None`: the init lists no tools, so none could be
    /// checked). The process stops before its run can call one, and every later session on this node denies them.
    async fn agent_tools_offered(
        &self,
        id: &str,
        run_id: Option<&str>,
        tools: Option<Vec<String>>,
    ) {
        let why = match &tools {
            Some(tools) => format!(
                "claude offered its own agent tools ({}), which would start agents outside fleetd's slots. fleetd \
                 stopped the session; the next start denies them. If it happens again, install the claude fleetd was \
                 tested with: claude install {}",
                tools.join(", "),
                crate::node::runner::claude::version::TESTED
            ),
            None => format!(
                "claude's init listed no tools, so fleetd could not check that its own agent tools are off, and \
                 stopped the session. Install the claude fleetd was tested with: claude install {}",
                crate::node::runner::claude::version::TESTED
            ),
        };
        tracing::error!(session_id = id, "{why}");
        let commands = {
            let mut st = self.st();
            for tool in tools.into_iter().flatten() {
                if !st.agent_tools.contains(&tool) {
                    st.agent_tools.push(tool);
                }
            }
            st.live.get_mut(id).map(|live| {
                live.ending = Some(EndCause::Requested(why.clone()));
                live.closing = true;
                live.commands.clone()
            })
        };
        self.log(self.update(id, |c| {
            let at = c.at.clone();
            c.put_item(ThreadItem {
                id: NonEmpty::unchecked(format!("agent-tools-{}", run_id.unwrap_or(id))),
                run_id: run_id.and_then(|r| NonEmpty::new(r).ok()),
                status: ItemStatus::Failed,
                title: "claude offered its own agent tools".into(),
                started_at: at.clone(),
                completed_at: Some(at.clone()),
                updated_at: at,
                kind: ItemKind::Error {
                    failure: RunFailure {
                        class: FailureClass::Other,
                        message: Text::new(why)
                            .unwrap_or_else(|_| Text::unchecked("agent tools offered")),
                        api_status: None,
                        reset_at: None,
                        retries: 0,
                        model: None,
                    },
                },
            });
        }));
        if let Some(commands) = commands {
            let _ = commands
                .send(SessionCommand::Shutdown {
                    grace: Duration::ZERO,
                })
                .await;
        }
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
                    by: Some(fleetd_contracts::time::DecidedBy::Policy),
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
        let slept = {
            let mut st = self.st();
            let marked = st.live.get_mut(id).is_some_and(|l| {
                let marked = l.slept.as_deref() == Some(run_id);
                if marked {
                    l.slept = None;
                    l.ending = None;
                }
                marked
            });
            if marked {
                st.slept.insert(run_id.to_owned());
            }
            marked
        };
        let outcome = match outcome {
            RunOutcome::Interrupted | RunOutcome::Failed(_) if slept => {
                RunOutcome::Failed(RunFailure {
                    class: FailureClass::Network,
                    message: Text::unchecked(
                        "the machine slept, and claude's stream did not come back after it woke",
                    ),
                    api_status: None,
                    reset_at: None,
                    retries: 0,
                    model: None,
                })
            }
            outcome => outcome,
        };
        let mut retries = 0;
        if let RunOutcome::Failed(failure) = &outcome {
            // claude never said `started` and no API call answered: it never took the message in, so a retry sends
            // the message itself.
            let unread = failure.api_status.is_none()
                && self.store().runs(id).is_ok_and(|runs| {
                    runs.iter()
                        .any(|r| r.id.as_str() == run_id && r.status == RunStatus::Starting)
                });
            if unread
                && claude::session_in_use(failure.message.as_str())
                && self.resend_refused(id, run_id)
            {
                return;
            }
            if failure::retryable(failure.class) {
                let schedule = &self.inner.config.retry_schedule_ms;
                let attempt = {
                    let mut st = self.st();
                    let done = st.retries.entry(run_id.to_owned()).or_default();
                    *done += 1;
                    *done
                };
                if let Some(&delay) = schedule.get(attempt as usize - 1) {
                    self.schedule_retry(id, run_id, attempt, delay, failure, unread);
                    return;
                }
                retries = attempt - 1;
            }
        }
        self.st().retries.remove(run_id);
        let slept = self.st().slept.remove(run_id)
            && (slept || matches!(&outcome, RunOutcome::Failed(f) if failure::retryable(f.class)));
        // Why someone ended it (an interrupt, a stop, a removed project): claude's own end of the run says only that
        // it was cut.
        let asked = {
            let mut st = self.st();
            let asked = st.live.get_mut(id).and_then(|live| live.ending.take());
            // The node's shutdown asks every run of the process, not only the first to end.
            asked.or_else(|| st.stopping.then_some(EndCause::NodeStopping))
        };
        let end = state::run_end(&outcome, asked.as_ref(), slept);
        let ended_by = asked.as_ref().and_then(EndCause::ended_by);
        match &outcome {
            RunOutcome::Failed(failure) if failure.class == FailureClass::Auth => {
                self.health_changed(|h| h.auth_failed(&failure.message, Instant::now()));
            }
            RunOutcome::Completed { .. } => self.health_changed(Health::run_completed),
            _ => {}
        }
        self.log(self.update(id, |c| {
            let at = c.at.clone();
            if let Some(run) = state::ending(&c.runs, run_id).map(|i| &mut c.runs[i]) {
                (run.status, run.failure) = match outcome {
                    RunOutcome::Completed { .. } => (RunStatus::Completed, None),
                    RunOutcome::Interrupted => (
                        RunStatus::Interrupted,
                        asked.map(|cause| state::ended_by(cause.message())),
                    ),
                    RunOutcome::Superseded { by } => {
                        run.superseded_by = NonEmpty::new(by).ok();
                        (RunStatus::Interrupted, None)
                    }
                    RunOutcome::Failed(failure) => {
                        (RunStatus::Failed, Some(RunFailure { retries, ..failure }))
                    }
                };
                run.ended_at = Some(at);
                run.usage = usage;
                run.end = Some(end);
                run.ended_by = ended_by.filter(|_| end == RunEnd::Requested);
            }
            if !c.runs.iter().any(|r| r.status.is_active()) {
                c.cancel_pending();
            }
        }));
    }

    /// claude refused a first start because it already has the session (the node died between spawning claude and
    /// recording it, and [`claude::session_file`] could not tell). The message goes again, once, to a respawn, which
    /// resumes because the session has started.
    fn resend_refused(&self, id: &str, run_id: &str) -> bool {
        {
            let mut st = self.st();
            if st.retries.contains_key(run_id) {
                return false;
            }
            // Keeps the run active through the refused process's exit.
            st.retries.insert(run_id.to_owned(), 0);
            if let Some(live) = st.live.get_mut(id) {
                live.closing = true;
            }
        }
        self.resend(id, run_id, 0, true);
        true
    }

    /// The run stays active while the node waits, with a `NodeRetry` item saying why it is slow.
    fn schedule_retry(
        &self,
        id: &str,
        run_id: &str,
        attempt: u32,
        delay: u64,
        failure: &RunFailure,
        unread: bool,
    ) {
        let max = self.inner.config.retry_schedule_ms.len() as u32;
        let now_ms = crate::node::runner::claude::mapper::Now::system().ms;
        self.st()
            .node_retry
            .insert(run_id.to_owned(), (now_ms, attempt, delay));
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
        self.resend(id, run_id, delay, unread);
    }

    /// After `delay`, unless the run ended meanwhile, the session gets the run's message again (`unread`: claude never
    /// took it in) or [`failure::RETRY_MESSAGE`], under a fresh uuid that maps back to the run.
    fn resend(&self, id: &str, run_id: &str, delay: u64, unread: bool) {
        let service = self.clone();
        let (id, run_id) = (id.to_owned(), run_id.to_owned());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let active = service.store().runs(&id).is_ok_and(|runs| {
                runs.iter()
                    .any(|r| r.id.as_str() == run_id && r.status.is_active())
            });
            if !active {
                if unread {
                    service.steer_failed(&run_id, "the run ended before claude took it in");
                }
                return;
            }
            let text = if unread {
                match service.store().message(&id, &run_id) {
                    Ok(Some(message)) => Ok(message.text),
                    Ok(None) => Err(not_found(format!("run {run_id} has no message"))),
                    Err(e) => Err(e.into()),
                }
            } else {
                Ok(failure::RETRY_MESSAGE.to_owned())
            };
            let uuid = new_uuid();
            let sent = match text {
                Ok(text) => {
                    let command = SessionCommand::Send {
                        run_id: uuid.clone(),
                        text,
                        mode: SendMode::Plain,
                    };
                    service
                        .dispatch(&id, command, Some((uuid, run_id.clone())))
                        .await
                }
                Err(e) => Err(e),
            };
            if let Err(e) = sent {
                service.st().retries.remove(&run_id);
                service.fail_run(&id, &run_id, FailureClass::Other, e.message.as_str());
                if unread {
                    service.steer_failed(&run_id, e.message.as_str());
                }
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
                .or_else(|| st.stopping.then_some(EndCause::NodeStopping));
            (live.pid, ending)
        };
        let cause = ending.unwrap_or(EndCause::Exited(exit));
        // A run the node is retrying outlives an exit nobody asked for: the retry resumes the session. An interrupt,
        // a stop or the node's shutdown ends it, and so its retry.
        let requested = cause.asked();
        let retrying: HashSet<String> = self.st().retries.keys().cloned().collect();
        let mut closed = Vec::new();
        self.log(self.update(id, |c| {
            let retried = |r: &RunInfo| r.status.is_active() && retrying.contains(r.id.as_str());
            if requested || !c.runs.iter().any(retried) {
                closed = state::close_out(&mut c.runs, &cause, &c.at)
                    .into_iter()
                    .map(|i| c.runs[i].id.to_string())
                    .collect();
            }
            c.cancel_pending();
            // A replacement process may already be recorded.
            if c.row.local.pid == Some(pid) {
                c.row.local.pid = None;
                c.row.local.pid_start = None;
            }
        }));
        let mut st = self.st();
        for run in closed {
            st.retries.remove(&run);
            st.slept.remove(&run);
        }
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
        // A run still in its worktree's setup: the setup ends, its command killed, and no claude starts for it.
        let setting_up = self.cancel_setup(id, Some(active.id.as_str()));
        let target = self.st().live.get_mut(id).map(|live| {
            live.ending = Some(EndCause::Requested(reason.clone()));
            (live.commands.clone(), live.generation)
        });
        let Some((commands, generation)) = target else {
            // No process to stop: the run only needs closing.
            self.update(id, |c| {
                state::close_out(&mut c.runs, &EndCause::Requested(reason), &c.at);
                c.cancel_pending();
            })?;
            if let Some(mut done) = setting_up {
                let _ = tokio::time::timeout(EXIT_WAIT, done.wait_for(Option::is_some)).await;
            }
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

    fn workspace_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.inner.workspaces.lock().unwrap();
        locks.entry(id.to_owned()).or_default().clone()
    }

    async fn stop(&self, id: &str, remove_worktree: bool) -> Reply {
        // A run still in its worktree's setup ends with it: its command is killed and no claude starts.
        if let Some(mut done) = self.cancel_setup(id, None) {
            self.update(id, |c| {
                state::close_out(&mut c.runs, &EndCause::Requested("stopped".into()), &c.at);
                c.cancel_pending();
            })?;
            let _ = tokio::time::timeout(EXIT_WAIT, done.wait_for(Option::is_some)).await;
        }
        let workspace = self.workspace_lock(id);
        let _workspace = if remove_worktree {
            let held = workspace.lock().await;
            // A message reached the session first: it is at work again, so its process and worktree stay.
            if self.store().runs(id)?.iter().any(|r| r.status.is_active()) {
                tracing::info!(
                    session_id = id,
                    "worktree kept: the session is at work again"
                );
                return Ok(SessionOutput::Done);
            }
            Some(held)
        } else {
            None
        };
        let row = self.session(id)?;
        let target = self.st().live.get_mut(id).map(|live| {
            live.ending = Some(EndCause::Requested("stopped".into()));
            live.closing = true;
            (live.commands.clone(), live.exited.clone(), live.pid)
        });
        if let Some((commands, mut exited, pid)) = target {
            let _ = commands
                .send(SessionCommand::Shutdown { grace: STOP_GRACE })
                .await;
            if tokio::time::timeout(EXIT_WAIT, exited.wait_for(|e| *e))
                .await
                .is_err()
            {
                // The kill ladder ends in SIGKILL well within EXIT_WAIT; this is the backstop, on the process group
                // the node spawned claude in.
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(pid as i32),
                    nix::sys::signal::Signal::SIGKILL,
                );
                if tokio::time::timeout(KILL_WAIT, exited.wait_for(|e| *e))
                    .await
                    .is_err()
                {
                    return Err(error(
                        SessionErrorCode::Internal,
                        format!(
                            "the session's claude (pid {pid}) did not exit, even after SIGKILL"
                        ),
                    ));
                }
            }
        }
        // A session's scratch goes with its worktree, or with its process when it has none.
        if remove_worktree || row.local.base_ref.is_none() {
            let home = self.inner.config.home.clone();
            let id = id.to_owned();
            blocking(move || share::remove_scratch(&home, &id)).await;
        }
        if remove_worktree && let Some(base_ref) = row.local.base_ref {
            let (root, path, branch) = (row.local.workspace_root, row.local.cwd, row.local.branch);
            let deleted = blocking(move || match branch {
                Some(branch) => worktree::remove(&root, &path, &branch, &base_ref),
                None => worktree::remove_detached(&root, &path).map(|()| false),
            })
            .await
            .inspect_err(|e| tracing::warn!(session_id = id, "worktree not removed: {e:?}"))?;
            self.update(id, |c| {
                c.row.summary.worktree_path = None;
                if deleted {
                    c.row.summary.branch = None;
                }
            })?;
        }
        Ok(SessionOutput::Done)
    }

    /// Sessions in the project with a claude process, idle ones included: each has the project as its cwd.
    fn live_in(&self, st: &State, project_id: &ProjectId) -> Vec<String> {
        let mut live: Vec<String> = st
            .live
            .keys()
            .filter(|id| {
                self.store()
                    .session(id)
                    .is_ok_and(|r| r.is_some_and(|r| &r.summary.project_id == project_id))
            })
            .cloned()
            .collect();
        live.sort_unstable();
        live
    }

    /// Stops the project's claude processes (their active runs close as interrupted), waits up to [`REMOVE_WAIT`]
    /// for them to exit, then forgets the project.
    async fn repo_clone(&self, add_id: NonEmpty, url: &str, dest: &str) -> Reply {
        let dest = PathBuf::from(dest);
        if !dest.is_absolute() {
            return Err(invalid(format!(
                "{} is not an absolute path",
                dest.display()
            )));
        }
        let service = self.clone();
        let id = add_id.to_string();
        super::repos::clone(url, &dest, &id, move |p| {
            let percent = p
                .percent
                .map(|n| fleetd_contracts::prim::Int::unchecked(i64::from(n)));
            service
                .st()
                .send(NodeToHub::CloneProgress(CloneProgressFrame {
                    add_id: add_id.clone(),
                    phase: p.phase,
                    percent,
                    detail: p.detail,
                }));
        })
        .await
        .map_err(|message| SessionError {
            code: SessionErrorCode::Git,
            message: Text::unchecked(tail_utf16(&message, 2000)),
            fix: None,
        })?;
        Ok(SessionOutput::RepoFacts(
            blocking(move || super::repos::inspect(&dest)).await,
        ))
    }

    /// `<node home>/worktrees/<project>`, where every worktree of the project's sessions is made.
    fn worktrees_dir(&self, project_id: &ProjectId) -> PathBuf {
        self.inner
            .config
            .home
            .join("worktrees")
            .join(project_id.as_str())
    }

    /// Each session of the project that has a worktree of its own: its id, path and branch.
    fn worktrees_of(
        &self,
        project_id: &ProjectId,
    ) -> Result<Vec<(ThreadId, PathBuf, Option<String>)>, SessionError> {
        let dir = self.worktrees_dir(project_id);
        Ok(self
            .store()
            .sessions()?
            .into_iter()
            .filter(|r| {
                &r.summary.project_id == project_id
                    && r.local.base_ref.is_some()
                    && r.local.cwd.starts_with(&dir)
            })
            .map(|r| (r.summary.session_id, r.local.cwd, r.local.branch))
            .collect())
    }

    async fn project_remove(&self, project_id: &ProjectId, remove_worktrees: bool) -> Reply {
        let stopping: Vec<_> = {
            let mut st = self.st();
            let ids = self.live_in(&st, project_id);
            let mut stopping = Vec::new();
            for id in &ids {
                let Some(live) = st.live.get_mut(id) else {
                    continue;
                };
                live.ending
                    .get_or_insert_with(|| EndCause::Requested("its project was removed".into()));
                live.closing = true;
                let (commands, mut exited) = (live.commands.clone(), live.exited.clone());
                stopping.push(async move {
                    let _ = commands
                        .send(SessionCommand::Shutdown { grace: STOP_GRACE })
                        .await;
                    let _ = exited.wait_for(|e| *e).await;
                });
            }
            stopping
        };
        let _ = tokio::time::timeout(REMOVE_WAIT, futures_util::future::join_all(stopping)).await;
        let live = self.live_in(&self.st(), project_id);
        if !live.is_empty() {
            return Err(invalid(format!(
                "project {project_id}: claude in session(s) {} was stopped but has not exited after {}s; run \
                 project_remove again",
                live.join(", "),
                REMOVE_WAIT.as_secs()
            )));
        }
        // Its previews end and their worktrees go whatever `remove_worktrees` says: they hold no work.
        if let (Some(previews), Ok(root)) =
            (self.inner.previews.get(), self.project_root(project_id))
        {
            previews.forget_project(project_id.as_str(), &root).await;
        }
        // Only once every process of the project has exited: none still works in a worktree that goes.
        if remove_worktrees {
            let root = self.project_root(project_id)?;
            let dir = self.worktrees_dir(project_id);
            let held = self.worktrees_of(project_id)?;
            let home = self.inner.config.home.clone();
            let removed = blocking(move || {
                for (session_id, _, _) in &held {
                    share::remove_scratch(&home, session_id.as_str());
                }
                worktree::remove_all(&root, &dir)
            })
            .await?;
            tracing::info!(
                project_id = project_id.as_str(),
                removed,
                "project worktrees removed"
            );
        }
        let frame = self
            .store()
            .remove_project(project_id)?
            .ok_or_else(|| not_found(format!("no project {project_id} on this machine")))?;
        let home = self.inner.config.home.clone();
        let id = project_id.to_string();
        blocking(move || {
            super::project_env::forget(&home, &id);
            super::mcp_servers::forget(&home, &id);
        })
        .await;
        self.st().machine(frame);
        Ok(SessionOutput::Done)
    }

    async fn answer(
        &self,
        id: &str,
        request_id: &str,
        decision: PermissionDecision,
        by: Option<fleetd_contracts::time::DecidedBy>,
    ) -> Reply {
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
                by,
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

    fn health(&self) -> MutexGuard<'_, Health> {
        self.inner.health.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// `runner_info`: the last probe, unless the next one is due ([`Health::next_probe_in`]).
    async fn runner_info(&self) -> RunnerInfo {
        let _probing = self.inner.probing.lock().await;
        let cached = {
            let health = self.health();
            if health.next_probe_in(Instant::now()) == Some(Duration::ZERO) {
                None
            } else {
                health.info()
            }
        };
        if let Some(info) = cached {
            return info;
        }
        let started = Instant::now();
        let env = self.inner.config.runner_env();
        let info = self.inner.runner.probe(&env).await;
        let shown = info.clone();
        self.health_changed(|h| h.probed(info, started));
        self.health().info().unwrap_or(shown)
    }

    /// Probes whenever [`Health::next_probe_in`] says so: at start, then every 15 s while the runner is unusable. A
    /// change of health (an Auth failure) wakes it to recompute.
    fn spawn_prober(&self) {
        let weak = Arc::downgrade(&self.inner);
        let changed = self.inner.health_changed.clone();
        tokio::spawn(async move {
            loop {
                let wait = {
                    let Some(inner) = weak.upgrade() else { return };
                    let health = inner.health.lock().unwrap_or_else(|p| p.into_inner());
                    health.next_probe_in(Instant::now())
                };
                match wait {
                    Some(wait) if wait.is_zero() => {}
                    Some(wait) => {
                        tokio::select! {
                            () = tokio::time::sleep(wait) => {}
                            () = changed.notified() => {}
                        }
                        continue;
                    }
                    None => {
                        changed.notified().await;
                        continue;
                    }
                }
                let Some(inner) = weak.upgrade() else { return };
                SessionService { inner }.runner_info().await;
            }
        });
    }

    /// Applies `f` and pushes `runner_info` when what it reports changed.
    fn health_changed(&self, f: impl FnOnce(&mut Health)) {
        let changed = {
            let mut health = self.health();
            let before = health.info();
            f(&mut health);
            let after = health.info();
            (after != before).then_some(after).flatten()
        };
        if let Some(info) = changed {
            self.inner.health_changed.notify_one();
            self.push_runner_info(info);
        }
    }

    fn push_runner_info(&self, info: RunnerInfo) {
        tracing::info!(
            version = info.version.as_deref().unwrap_or("(missing)"),
            version_ok = info.version_ok,
            login = ?info.login,
            conformance_ok = ?info.conformance_ok,
            problem = info.problem.as_deref().unwrap_or(""),
            "runner_info changed"
        );
        let st = self.st();
        match self.store().runner_info(&info) {
            Ok(frame) => st.machine(frame),
            Err(e) => tracing::warn!(error = %e, "cannot log the runner's state"),
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

    /// Node SIGTERM: withdraw every send claude still holds, interrupt every active run, give them
    /// [`SHUTDOWN_DRAIN`] to end, then close every process. Without the withdraw a queued send starts the moment the
    /// interrupt ends the turn before it, and is only cut at the end of the drain.
    pub async fn shutdown(&self) {
        let targets: Vec<_> = {
            let mut st = self.st();
            st.stopping = true;
            st.live
                .iter_mut()
                .map(|(id, live)| {
                    live.ending.get_or_insert(EndCause::NodeStopping);
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
            let queued = self.store().runs(id).unwrap_or_default();
            for run in queued.iter().filter(|r| r.status == RunStatus::Queued) {
                let _ = commands
                    .send(SessionCommand::Withdraw {
                        run_id: run.id.to_string(),
                    })
                    .await;
            }
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
