//! Per-machine T3 clients. Each attached machine gets one supervised connection that follows T3's shell stream into
//! the store (thread/project caches) and the event log (derived events, on transitions only). Thread transcripts are
//! read on demand (tail, actions, headlines) and dropped after 60 s unused.
//!
//! One `Executors` serves thread watching, workspace files and changes, the provider list, the usage source and T3
//! settings.
pub mod limit;
pub mod providers;
pub mod shell_mapper;
pub mod t3;
pub mod thread_view;
pub mod tools;

pub use tools::register;

#[cfg(test)]
mod shell_mapper_tests;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::model::RuntimeMode;
use futures_util::StreamExt;
use serde_json::json;
use t3_wire::T3Client;
use t3_wire::types::{
    Command, CreatedBy, CreationSource, DeliveryIntent, DispatchMode, GetTurnItemInput,
    InitialMessage, InteractionMode, LaunchThreadInput, ListRefsInput, MessageDispatch,
    ModelOptionInput, ModelSelectionInput, ReadFileInput, RefKind, RootWorkspace, RunInterrupt,
    ServerConfig, ServerSettings, ShellStreamItem, SubscribeShellInput, SubscribeThreadInput,
    ThreadStreamItem, UpdateSettingsInput, WorkspaceStrategy,
};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::clock::Clock;
use crate::hub::store::{EventLog, HubStore, iso_ms, now_ms};
pub use providers::ProviderInstance;
use shell_mapper::{ApplyContext, ShellState, StoredThread, Summary, TrackedThread, js_take};
use thread_view::{Action, TailRow, ThreadView};

/// Reconnect delay: doubles from 1 s to a 30 s cap, +-25 % jitter so machines don't reconnect in step.
pub fn backoff_ms(attempt: u32, random: f64) -> u64 {
    let base = 1000.0 * 2f64.powi(attempt.min(5) as i32) * (0.75 + random * 0.5);
    (base.round() as u64).min(30_000)
}

pub const WATCH_IDLE_MS: u64 = 60_000;
const READ_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum T3Operation {
    Launch,
    Send,
    Interrupt,
    Read,
    Configure,
}

impl T3Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Send => "send",
            Self::Interrupt => "interrupt",
            Self::Read => "read",
            Self::Configure => "configure",
        }
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum ExecutorError {
    #[error("machine {machine_id} has no live T3 connection")]
    MachineNotConnected { machine_id: MachineId },
    #[error("thread {thread_id} is not known on machine {machine_id}")]
    ThreadNotFound {
        machine_id: MachineId,
        thread_id: ThreadId,
    },
    /// `cause` is for logs only and never carries the bearer or a ws ticket.
    #[error("T3 on {machine_id} refused or failed the {} request", operation.as_str())]
    T3RequestFailed {
        machine_id: MachineId,
        operation: T3Operation,
        cause: String,
    },
}

fn failed(machine_id: &MachineId, operation: T3Operation, cause: impl ToString) -> ExecutorError {
    ExecutorError::T3RequestFailed {
        machine_id: machine_id.clone(),
        operation,
        cause: cause.to_string(),
    }
}

/// The T3 session the node minted for the hub.
#[derive(Clone, PartialEq, Eq)]
pub struct T3Session {
    pub t3_url: String,
    pub bearer: String,
}

#[derive(Debug, Clone)]
pub struct LaunchInput {
    pub project_id: ProjectId,
    pub prompt: String,
    pub model: String,
    pub effort: Effort,
    pub runtime_mode: RuntimeMode,
    pub title: Option<String>,
    /// T3 keeps a receipt per command id, so a retried launch returns the same thread.
    pub client_request_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct LaunchOptions {
    /// Default: the project root. Tasks launch writers in a new worktree on their own branch.
    pub workspace: Option<WorkspaceStrategy>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendOutcome {
    pub run_id: Option<String>,
    pub queued: bool,
}

/// What `thread_send` returns: delivered now, or queued while the machine is offline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteOutcome {
    pub run_id: Option<String>,
    pub queued: bool,
    pub queued_until: Option<String>,
}

/// The queue area's hook: `thread_send` goes through it when set, so a message to an offline machine waits.
pub trait OfflineWriter: Send + Sync + 'static {
    fn send<'a>(
        &'a self,
        thread_ref: &'a ThreadRef,
        message: &'a str,
        client_request_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<WriteOutcome, ExecutorError>> + Send + 'a>>;
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
    /// Epoch ms of the stream's last frame, or of its opening.
    pub last_frame_ms: u64,
    pub tool: Option<OpenTool>,
}

/// What a finished task thread changed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ThreadChanges {
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    /// Repo-relative paths any of the thread's checkpoints touched, sorted and unique.
    pub paths: Vec<String>,
    /// Pull requests T3 linked to the thread.
    pub pull_request_urls: Vec<String>,
}

/// A thread's tail, newest first (thread_tail's items, thread and truncated).
#[derive(Debug, Clone)]
pub struct Tail {
    pub items: Vec<TailRow>,
    pub thread: Summary,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Ready {
    Pending,
    Open,
    Failed(String),
}

struct WatchState {
    view: ThreadView,
    last_used_ms: u64,
    /// Any frame but "synchronized" counts as progress; starts at the stream's opening.
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
    t3_url: String,
    bearer: String,
    supervisor: Option<JoinHandle<()>>,
    /// Set while a socket is open and the shell stream has delivered its first item.
    live: Option<T3Client>,
    shell: ShellState,
    watches: HashMap<String, Arc<Watch>>,
}

pub struct Executors {
    store: Arc<HubStore>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
    machines: Mutex<HashMap<MachineId, Slot>>,
    /// Per machine: true while live. `await_live` waits on it.
    live: Mutex<HashMap<MachineId, watch::Sender<bool>>>,
    offline_writer: Mutex<Option<Arc<dyn OfflineWriter>>>,
    /// Where later areas plug into the M1 tools.
    pub hooks: tools::ToolHooks,
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

/// A random v4-shaped UUID.
pub(crate) fn new_uuid() -> String {
    let b: [u8; 16] = rand::random();
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

/// Drops the slot's live client and its thread watches when a connection ends, however it ends.
struct LiveGuard {
    executors: Arc<Executors>,
    machine_id: MachineId,
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        let mut machines = self.executors.machines.lock().unwrap();
        if let Some(slot) = machines.get_mut(&self.machine_id) {
            slot.live = None;
            for (_, w) in slot.watches.drain() {
                if let Some(task) = w.task.lock().unwrap().take() {
                    task.abort();
                }
                w.settle(Ready::Failed("the T3 connection closed".into()));
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
            offline_writer: Mutex::default(),
            hooks: tools::ToolHooks::default(),
        })
    }

    /// The queue area sets this; `thread_send` then writes through it.
    pub fn set_offline_writer(&self, writer: Arc<dyn OfflineWriter>) {
        *self.offline_writer.lock().unwrap() = Some(writer);
    }

    pub fn offline_writer(&self) -> Option<Arc<dyn OfflineWriter>> {
        self.offline_writer.lock().unwrap().clone()
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

    fn client(&self, machine_id: &MachineId) -> Result<T3Client, ExecutorError> {
        self.machines
            .lock()
            .unwrap()
            .get(machine_id)
            .and_then(|s| s.live.clone())
            .ok_or_else(|| ExecutorError::MachineNotConnected {
                machine_id: machine_id.clone(),
            })
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

    /// (Re)connects. Idempotent for the same URL and bearer; a new bearer reconnects with it.
    pub async fn attach(self: &Arc<Self>, machine_id: &MachineId, session: T3Session) {
        let old = {
            let mut machines = self.machines.lock().unwrap();
            let slot = machines.entry(machine_id.clone()).or_default();
            if slot.supervisor.is_some()
                && slot.t3_url == session.t3_url
                && slot.bearer == session.bearer
            {
                return;
            }
            slot.t3_url = session.t3_url;
            slot.bearer = session.bearer;
            slot.supervisor.take()
        };
        if let Some(old) = old {
            old.abort();
            let _ = old.await;
        }
        let this = self.clone();
        let id = machine_id.clone();
        let task = tokio::spawn(async move { this.supervise(id).await });
        if let Some(slot) = self.machines.lock().unwrap().get_mut(machine_id) {
            slot.supervisor = Some(task);
        }
    }

    /// Drops the connection. The machine's shell state is kept, so a later attach resumes from its cursor.
    pub async fn detach(&self, machine_id: &MachineId) {
        let task = self
            .machines
            .lock()
            .unwrap()
            .get_mut(machine_id)
            .and_then(|s| s.supervisor.take());
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }

    pub fn is_connected(&self, machine_id: &MachineId) -> bool {
        self.machines
            .lock()
            .unwrap()
            .get(machine_id)
            .is_some_and(|s| s.live.is_some())
    }

    /// Returns once the machine has a live T3 connection, at once if it has one now.
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

    async fn supervise(self: Arc<Self>, machine_id: MachineId) {
        let attempt = Arc::new(AtomicU32::new(0));
        loop {
            let reason = match self
                .clone()
                .run_connection(&machine_id, attempt.clone())
                .await
            {
                Ok(()) => "stream ended".to_owned(),
                Err(e) => e,
            };
            let delay = backoff_ms(
                attempt.fetch_add(1, Ordering::SeqCst),
                rand::random::<f64>(),
            );
            // t3-wire's error texts never carry the bearer or the ws ticket.
            tracing::warn!(machine_id = %machine_id, reason = %reason, retry_in_ms = delay, "T3 connection lost; reconnecting");
            self.clock.sleep(Duration::from_millis(delay)).await;
        }
    }

    /// One socket's lifetime: connect, follow the shell stream until it fails or ends.
    async fn run_connection(
        self: Arc<Self>,
        machine_id: &MachineId,
        attempt: Arc<AtomicU32>,
    ) -> Result<(), String> {
        let (url, bearer, complete) = {
            let machines = self.machines.lock().unwrap();
            let slot = machines.get(machine_id).ok_or("detached")?;
            (
                slot.t3_url.clone(),
                slot.bearer.clone(),
                slot.shell.complete,
            )
        };
        let client = T3Client::connect(&url, &bearer)
            .await
            .map_err(|e| e.to_string())?;
        let cursor = self
            .store
            .cursor_get(machine_id)
            .map_err(|e| e.to_string())?;
        // A replay only carries changed rows, and project counts need every row, so the first stream in this
        // process starts from a snapshot; it is diffed against the stored summaries, so nothing is missed.
        let after_sequence = if complete {
            cursor.map(|c| c.max(0) as u64)
        } else {
            None
        };
        let baseline = cursor.is_none();
        let mut stream = client.subscribe_shell(&SubscribeShellInput {
            after_sequence,
            ..Default::default()
        });
        let _guard = LiveGuard {
            executors: self.clone(),
            machine_id: machine_id.clone(),
        };
        while let Some(item) = stream.next().await {
            let item = item.map_err(|e| e.to_string())?;
            let went_live = {
                let mut machines = self.machines.lock().unwrap();
                let slot = machines.get_mut(machine_id).ok_or("detached")?;
                let fresh = slot.live.is_none();
                if fresh {
                    slot.live = Some(client.clone());
                }
                fresh
            };
            if went_live {
                attempt.store(0, Ordering::SeqCst);
                self.set_live(machine_id, true);
            }
            self.handle_shell_item(machine_id, &item, baseline).await;
        }
        Ok(())
    }

    async fn handle_shell_item(
        self: &Arc<Self>,
        machine_id: &MachineId,
        item: &ShellStreamItem,
        baseline: bool,
    ) {
        let ids: Vec<String> = match item {
            ShellStreamItem::Snapshot(s) => {
                s.snapshot.threads.iter().map(|t| t.id.clone()).collect()
            }
            ShellStreamItem::ThreadUpdated(u) => vec![u.thread.id.clone()],
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
            shell_mapper::apply_shell_item(&mut slot.shell, item, &ctx)
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
        // Shell rows carry no assistant text, so a run that ended or paused gets its headline from a thread read.
        for t in &applied.transitions {
            if t.kind == shell_mapper::EventType::Started {
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
            // Keeps the row's lastSequence and run fields, if this item set them.
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
        if matches!(
            item,
            ShellStreamItem::ProjectRemoved(_) | ShellStreamItem::Snapshot(_)
        ) {
            self.prune_projects(machine_id, item, &now);
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

    /// Projects T3 deleted: dropped from the cache, each with a project.removed event.
    fn prune_projects(&self, machine_id: &MachineId, item: &ShellStreamItem, now: &str) {
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
            shell_mapper::removed_projects(&slot.shell, item, &ids)
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
            let summary = format!("Project \"{title}\" on {machine_id} was deleted in T3");
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

    /// The thread's live view, opening a bounded `subscribeThread` if none is open.
    async fn view(self: &Arc<Self>, r: &ThreadRef) -> Result<Arc<Watch>, ExecutorError> {
        let machine_id = &r.machine_id;
        let now = self.now_ms();
        let watch = {
            let mut machines = self.machines.lock().unwrap();
            let slot = machines
                .get_mut(machine_id)
                .filter(|s| s.live.is_some())
                .ok_or_else(|| ExecutorError::MachineNotConnected {
                    machine_id: machine_id.clone(),
                })?;
            let client = slot.live.clone().expect("live");
            let watch = match slot.watches.get(r.thread_id.as_str()) {
                Some(w) => w.clone(),
                None => {
                    let w = Arc::new(Watch {
                        state: Mutex::new(WatchState {
                            view: ThreadView::default(),
                            last_used_ms: now,
                            last_frame_ms: now,
                            pinned: false,
                        }),
                        ready: watch::channel(Ready::Pending).0,
                        task: Mutex::new(None),
                    });
                    slot.watches.insert(r.thread_id.to_string(), w.clone());
                    let task =
                        tokio::spawn(self.clone().follow_thread(client, r.clone(), w.clone()));
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
                Err(_) => Err("timeout".to_owned()),
                Ok(Err(_)) => Err("closed".to_owned()),
                Ok(Ok(state)) => match &*state {
                    Ready::Failed(e) => Err(e.clone()),
                    _ => Ok(()),
                },
            };
        outcome
            .map(|()| watch.clone())
            .map_err(|e| failed(machine_id, T3Operation::Read, e))
    }

    /// Follows one thread's stream until it fails, or until it is unpinned and nobody read it for WATCH_IDLE_MS.
    async fn follow_thread(self: Arc<Self>, client: T3Client, r: ThreadRef, w: Arc<Watch>) {
        let input = SubscribeThreadInput {
            thread_id: r.thread_id.to_string(),
            accept_bounded_snapshot: Some(true),
            ..Default::default()
        };
        let mut stream = client.subscribe_thread(&input);
        let idle = {
            let this = self.clone();
            let w = w.clone();
            async move {
                loop {
                    let (idle, pinned) = {
                        let s = w.state.lock().unwrap();
                        (this.now_ms().saturating_sub(s.last_used_ms), s.pinned)
                    };
                    if idle >= WATCH_IDLE_MS && !pinned {
                        return;
                    }
                    let wait = if pinned {
                        WATCH_IDLE_MS
                    } else {
                        WATCH_IDLE_MS - idle
                    };
                    this.clock.sleep(Duration::from_millis(wait)).await;
                }
            }
        };
        tokio::pin!(idle);
        let end = loop {
            tokio::select! {
                item = stream.next() => match item {
                    Some(Ok(item)) => {
                        let now = self.now_ms();
                        let ready = {
                            let mut s = w.state.lock().unwrap();
                            if !matches!(item, ThreadStreamItem::Synchronized) {
                                s.last_frame_ms = now;
                            }
                            thread_view::apply_thread_item(&mut s.view, &item);
                            s.view.ready
                        };
                        if ready {
                            w.settle(Ready::Open);
                        }
                    }
                    Some(Err(e)) => break e.to_string(),
                    None => break "stream ended".to_owned(),
                },
                () = &mut idle => break "idle".to_owned(),
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

    /// Fills in command output the bounded snapshot withheld, for the items about to be returned.
    async fn fill_outputs(
        &self,
        r: &ThreadRef,
        w: &Watch,
        ids: &[String],
    ) -> Result<(), ExecutorError> {
        let client = self.client(&r.machine_id)?;
        let omitted = thread_view::omitted_outputs(&w.state.lock().unwrap().view, ids);
        let fetches = omitted.into_iter().map(|item_id| {
            let client = client.clone();
            let input = GetTurnItemInput {
                thread_id: r.thread_id.to_string(),
                item_id,
            };
            async move { client.get_turn_item(&input).await }
        });
        let results: Vec<_> = futures_util::stream::iter(fetches)
            .buffer_unordered(4)
            .collect()
            .await;
        for result in results {
            let item = result
                .map_err(|e| failed(&r.machine_id, T3Operation::Read, e))?
                .item;
            if let Some(item) = item {
                w.state
                    .lock()
                    .unwrap()
                    .view
                    .items
                    .insert(item.id.clone(), item);
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

    /// Claude models go straight to the fleetd instance; anything else looks at the provider list, falling back to
    /// fleetd.
    async fn route_of(&self, machine_id: &MachineId, model: &str) -> providers::Route {
        if model.starts_with("claude") {
            return providers::route_model(&[], model);
        }
        match self.provider_instances(machine_id).await {
            Ok(list) => providers::route_model(&list, model),
            Err(_) => providers::route_model(&[], model),
        }
    }

    pub async fn launch(
        &self,
        machine_id: &MachineId,
        input: &LaunchInput,
        options: LaunchOptions,
    ) -> Result<ThreadId, ExecutorError> {
        let client = self.client(machine_id)?;
        let route = self.route_of(machine_id, &input.model).await;
        let title = match input.title.as_deref().map(str::trim) {
            Some(t) if !t.is_empty() => t.to_owned(),
            _ => js_take(input.prompt.trim().split('\n').next().unwrap_or(""), 80).to_owned(),
        };
        let effort = serde_json::to_value(input.effort)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        let (option_id, option_value) = providers::effort_option(&route.driver, &effort);
        let runtime_mode =
            serde_json::from_value(serde_json::to_value(input.runtime_mode).unwrap_or_default())
                .map_err(|e| failed(machine_id, T3Operation::Launch, e))?;
        let launch = LaunchThreadInput {
            command_id: input.client_request_id.clone(),
            project_id: input.project_id.to_string(),
            title,
            generate_title: Some(false),
            // The "fleetd" instance (its launch args deny T3's own spawn tools) unless only Codex has the model;
            // explicit effort.
            model_selection: ModelSelectionInput {
                instance_id: route.instance_id,
                model: input.model.clone(),
                options: vec![ModelOptionInput {
                    id: option_id.to_owned(),
                    value: option_value,
                }],
            },
            runtime_mode,
            interaction_mode: InteractionMode::Default,
            workspace_strategy: options
                .workspace
                .unwrap_or(WorkspaceStrategy::Root(RootWorkspace::default())),
            initial_message: Some(InitialMessage {
                text: input.prompt.clone(),
                attachments: vec![],
            }),
        };
        let result = client
            .launch_thread(&launch)
            .await
            .map_err(|e| failed(machine_id, T3Operation::Launch, e))?;
        Ok(ThreadId::unchecked(result.thread_id))
    }

    pub async fn send(
        &self,
        r: &ThreadRef,
        message: &str,
        client_request_id: &str,
    ) -> Result<SendOutcome, ExecutorError> {
        let client = self.client(&r.machine_id)?;
        let tracked = self.tracked(r);
        let command = Command::MessageDispatch(MessageDispatch {
            created_by: CreatedBy::User,
            creation_source: CreationSource::Web,
            command_id: client_request_id.to_owned(),
            thread_id: r.thread_id.to_string(),
            message_id: new_uuid(),
            text: message.to_owned(),
            attachments: vec![],
            // T3 picks: start a run if idle, steer a running one, queue behind one still starting.
            delivery_intent: Some(DeliveryIntent::Auto),
            dispatch_mode: DispatchMode::StartImmediately,
        });
        client
            .dispatch_command(&command)
            .await
            .map_err(|e| failed(&r.machine_id, T3Operation::Send, e))?;
        Ok(
            match tracked.and_then(|t| t.active_run_id.clone().map(|a| (a, t.active_run_starting)))
            {
                None => SendOutcome {
                    run_id: None,
                    queued: false,
                },
                Some((_, true)) => SendOutcome {
                    run_id: None,
                    queued: true,
                },
                Some((active, false)) => SendOutcome {
                    run_id: Some(active),
                    queued: false,
                },
            },
        )
    }

    pub async fn interrupt(
        self: &Arc<Self>,
        r: &ThreadRef,
        client_request_id: &str,
    ) -> Result<(), ExecutorError> {
        let client = self.client(&r.machine_id)?;
        let run_id = match self.tracked(r).and_then(|t| t.active_run_id) {
            Some(run) => Some(run),
            None => {
                let w = self.view(r).await?;
                thread_view::active_run_id(&w.state.lock().unwrap().view)
            }
        };
        let Some(run_id) = run_id else { return Ok(()) };
        let command = Command::RunInterrupt(RunInterrupt {
            command_id: client_request_id.to_owned(),
            thread_id: r.thread_id.to_string(),
            run_id,
            reason: Some("interrupted through fleetd".into()),
        });
        client
            .dispatch_command(&command)
            .await
            .map_err(|e| failed(&r.machine_id, T3Operation::Interrupt, e))?;
        Ok(())
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

    /// Threads whose shell row says running, on machines with a live T3 connection.
    pub fn running(&self) -> Vec<RunningThread> {
        let machines = self.machines.lock().unwrap();
        machines
            .iter()
            .filter(|(_, s)| s.live.is_some())
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

    /// T3's latest run on the thread as last seen; None for an unknown thread.
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

    /// Opens the thread's stream if needed and keeps it open until `release`.
    pub async fn follow(self: &Arc<Self>, r: &ThreadRef) -> Result<(), ExecutorError> {
        let w = self.view(r).await?;
        w.state.lock().unwrap().pinned = true;
        Ok(())
    }

    /// The stream then closes 60 s from now unless something reads it.
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

    /// None when no stream is open (never followed, or its connection dropped).
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

    // ProviderList, UsageSource, T3Settings (usage, reviews and the doctor)

    /// T3's `server.getConfig`.
    pub async fn server_config(
        &self,
        machine_id: &MachineId,
    ) -> Result<ServerConfig, ExecutorError> {
        let client = self.client(machine_id)?;
        match tokio::time::timeout(READ_TIMEOUT, client.get_config()).await {
            Ok(Ok(config)) => Ok(config),
            Ok(Err(e)) => Err(failed(machine_id, T3Operation::Read, e)),
            Err(_) => Err(failed(machine_id, T3Operation::Read, "timeout")),
        }
    }

    pub async fn provider_instances(
        &self,
        machine_id: &MachineId,
    ) -> Result<Vec<ProviderInstance>, ExecutorError> {
        Ok(self
            .server_config(machine_id)
            .await?
            .providers
            .iter()
            .map(providers::to_instance)
            .collect())
    }

    /// The T3 URL the machine is attached with, if any (usage's `local` check).
    pub fn t3_url(&self, machine_id: &MachineId) -> Option<String> {
        self.machines
            .lock()
            .unwrap()
            .get(machine_id)
            .map(|s| s.t3_url.clone())
    }

    pub async fn settings_read(
        &self,
        machine_id: &MachineId,
    ) -> Result<ServerSettings, ExecutorError> {
        let client = self.client(machine_id)?;
        match tokio::time::timeout(READ_TIMEOUT, client.get_settings()).await {
            Ok(Ok(s)) => Ok(s),
            Ok(Err(e)) => Err(failed(machine_id, T3Operation::Read, e)),
            Err(_) => Err(failed(machine_id, T3Operation::Read, "timeout")),
        }
    }

    pub async fn settings_update(
        &self,
        machine_id: &MachineId,
        update: &UpdateSettingsInput,
    ) -> Result<ServerSettings, ExecutorError> {
        let client = self.client(machine_id)?;
        match tokio::time::timeout(READ_TIMEOUT, client.update_settings(update)).await {
            Ok(Ok(s)) => Ok(s),
            Ok(Err(e)) => Err(failed(machine_id, T3Operation::Configure, e)),
            Err(_) => Err(failed(machine_id, T3Operation::Configure, "timeout")),
        }
    }

    // WorkspaceFiles, ThreadWorkspace (leads, tasks)

    /// None when the file does not exist. `cwd` must be a T3 workspace root.
    pub async fn read_file(
        &self,
        machine_id: &MachineId,
        cwd: &str,
        relative_path: &str,
    ) -> Result<Option<String>, ExecutorError> {
        let client = self.client(machine_id)?;
        let input = ReadFileInput {
            cwd: cwd.to_owned(),
            relative_path: relative_path.to_owned(),
        };
        match client.read_file(&input).await {
            Ok(r) => Ok(Some(r.contents)),
            // T3 resolves the target's real path first, so a missing file fails there.
            Err(t3_wire::Error::Rpc { error, .. })
                if error.tag == "ProjectReadFileError"
                    && error.operation.as_deref() == Some("realpath-target") =>
            {
                Ok(None)
            }
            Err(e) => Err(failed(machine_id, T3Operation::Read, e)),
        }
    }

    /// The repo's default local branch at `cwd`, else its current branch.
    pub async fn default_branch(
        &self,
        machine_id: &MachineId,
        cwd: &str,
    ) -> Result<String, ExecutorError> {
        let client = self.client(machine_id)?;
        let input = ListRefsInput {
            cwd: cwd.to_owned(),
            ref_kind: Some(RefKind::Local),
            limit: Some(200),
        };
        let refs = client
            .list_refs(&input)
            .await
            .map_err(|e| failed(machine_id, T3Operation::Read, e))?
            .refs;
        let local: Vec<_> = refs.iter().filter(|r| r.is_remote != Some(true)).collect();
        local
            .iter()
            .find(|r| r.is_default)
            .or_else(|| local.iter().find(|r| r.current))
            .map(|r| r.name.clone())
            .ok_or_else(|| {
                failed(
                    machine_id,
                    T3Operation::Read,
                    format!("no local branch at {cwd}"),
                )
            })
    }

    pub async fn changes(&self, r: &ThreadRef) -> Result<ThreadChanges, ExecutorError> {
        let client = self.client(&r.machine_id)?;
        let p = client
            .get_thread_projection(r.thread_id.as_str())
            .await
            .map_err(|e| failed(&r.machine_id, T3Operation::Read, e))?;
        let paths = thread_view::checkpoint_paths(
            p.checkpoints
                .iter()
                .flat_map(|c| c.files.iter().map(|f| f.path.as_str())),
        );
        let mut urls: Vec<String> = p
            .thread
            .pull_requests
            .iter()
            .flatten()
            .filter(|l| l.source != "stack-dismissed")
            .map(|l| l.url.clone())
            .collect();
        if let Some(linked) = &p.thread.linked_pull_request {
            urls.push(linked.url.clone());
        }
        let mut unique: Vec<String> = vec![];
        for u in urls {
            if !unique.contains(&u) {
                unique.push(u);
            }
        }
        Ok(ThreadChanges {
            branch: p.thread.branch,
            worktree_path: p.thread.worktree_path,
            paths,
            pull_request_urls: unique,
        })
    }

    /// What the thread is waiting on a human for, if anything: a question or an approval prompt.
    pub async fn pending_question(&self, r: &ThreadRef) -> Result<Option<String>, ExecutorError> {
        let client = self.client(&r.machine_id)?;
        let p = client
            .get_thread_projection(r.thread_id.as_str())
            .await
            .map_err(|e| failed(&r.machine_id, T3Operation::Read, e))?;
        Ok(thread_view::pending_question_text(
            &p.runtime_requests,
            &p.turn_items,
        ))
    }
}
