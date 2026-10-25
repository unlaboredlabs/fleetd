//! fleetd-owned tasks: every subagent a lead runs. Spawn resolves the profile, takes a slot or queues with the
//! reason, and launches a thread (writers in a new worktree on `<branchPrefix><taskId>-<slug>`,
//! `fleetd/` by default).
//! The thread's status transitions, read off the event log, end the task: the result goes into the record and,
//! inline, into one lead wake; the slot is released and the queue is tried again.
pub mod base;
pub mod cap;
#[cfg(test)]
mod cap_tests;
pub mod duplicates;
#[cfg(test)]
mod duplicates_tests;
#[cfg(test)]
mod guard_tests;
pub mod hooks;
pub mod policy;
pub mod ports;
#[cfg(test)]
mod race_tests;
pub mod records;
pub mod render;
pub mod resolve;
pub mod tools;
pub mod wire;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use fleetd_contracts::events::{Attention, HubEvent, HubEventType};
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::lead_calls::TaskSpawnCall;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::prim::{Int, Text};
use fleetd_contracts::sessions::{RunEnd, WorktreeBase};
use fleetd_contracts::tasks::{
    FetchFailedData, PrUrl, Task, TaskId, TaskKind, TaskResult, TaskResultStatus, TaskState,
};
use serde_json::{Map, Value, json};

use crate::clock::Clock;
use crate::hub::api::Shutdown;
use crate::hub::policy::Policies;
use crate::hub::slots::{SlotRequest, Slots, priority_of};
use crate::hub::store::parse_ms;
use crate::hub::store::{
    EventLog, HubDb, HubStore, NewEvent, StoreError, WaitInput, iso_ms, now_ms,
};
use crate::hub::work::Observed;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::work::WorkScope;
use hooks::UsageGate;
use ports::{LaunchRequest, PortError, TaskError, TaskPorts, WakeKind, Worktree};
use render::{branch_for, find_pr_url, render_task_prompt, tail_of};
use resolve::resolve_profile;

pub use records::{StoredTask, TaskRecords};

/// Who asks: the project's lead, as the lead-call handler attributes it.
#[derive(Clone, Debug)]
pub struct TaskCaller {
    pub project_ref: ProjectRef,
    pub by: String,
}

/// `TaskSpawnCall` without `op` (the enum tag).
pub type SpawnInput = TaskSpawnCall;

#[derive(Clone, Debug, Default)]
pub struct TaskFilter {
    pub project_ref: Option<ProjectRef>,
    pub state: Option<TaskState>,
    pub workstream_id: Option<WorkstreamId>,
    pub limit: usize,
}

/// What the tasks area needs from the rest of the hub; built in `hub/serve`.
pub struct TaskDeps {
    pub db: Arc<HubDb>,
    pub store: Arc<HubStore>,
    pub events: Arc<EventLog>,
    pub clock: Arc<dyn Clock>,
    /// The executor, node link and leads (see `ports`).
    pub ports: Arc<dyn TaskPorts>,
    pub slots: Arc<Slots>,
    pub policies: Arc<Policies>,
}

const THREAD_EVENTS: [HubEventType; 9] = [
    HubEventType::ThreadStarted,
    HubEventType::ThreadWaiting,
    HubEventType::ThreadCompleted,
    HubEventType::ThreadFailed,
    HubEventType::ThreadInterrupted,
    HubEventType::ThreadUsageLimited,
    // M4 usage: a lifted pause lets queued tasks start.
    HubEventType::UsageResumed,
    // The disk and load guard: the same, for a machine with room again.
    HubEventType::MachineGuard,
    // A merged writer's worktree goes.
    HubEventType::PrMerged,
];

/// The run's end cause a `thread.*` event carries; absent from events of nodes that don't record it.
fn end_cause(event: &HubEvent) -> Option<RunEnd> {
    let end = event.data.as_ref()?.get("endCause")?;
    serde_json::from_value(end.clone()).ok()
}

fn same_project(a: &ProjectRef, b: &ProjectRef) -> bool {
    a.machine_id == b.machine_id && a.project_id == b.project_id
}

fn lead_error(code: ErrorCode, message: impl Into<String>, fix: Option<&str>) -> TaskError {
    TaskError {
        code,
        message: message.into(),
        fix: fix.map(str::to_owned),
    }
}

/// Store failures refuse the call plainly and are logged.
fn store_error(error: StoreError) -> TaskError {
    tracing::error!(%error, "tasks: store failed");
    lead_error(
        ErrorCode::Failed,
        "The hub failed to answer that request.",
        Some("Retry; if it keeps failing, check the hub's log."),
    )
}

/// A started task's thread, its branch, and where the branch started.
type Launched = (ThreadRef, Option<String>, Option<WorktreeBase>);

/// Why a launch or continuation did not go out: the machine went offline (the task queues), or anything else
/// (the task fails to start with this message).
enum StartError {
    Offline,
    Other(String),
}

impl From<PortError> for StartError {
    fn from(error: PortError) -> Self {
        match error {
            PortError::Offline => Self::Offline,
            PortError::Failed(message) => Self::Other(message),
        }
    }
}

impl From<TaskError> for StartError {
    fn from(error: TaskError) -> Self {
        // The policy read at launch: a node gone since the start's check queues the task, like the launch itself.
        if error.code == ErrorCode::MachineOffline {
            return Self::Offline;
        }
        Self::Other(error.message)
    }
}

impl From<StoreError> for StartError {
    fn from(error: StoreError) -> Self {
        Self::Other(error.to_string())
    }
}

/// A request id for one of the task's writes. The node's launch is idempotent on it, so the id carries the task's
/// creation time: a hub on a fresh database numbers tasks from T1 again and must not get an earlier hub's thread.
fn request_id(task: &Task, parts: &[&str]) -> String {
    let created =
        parse_ms(task.created_at.as_str()).map_or_else(|| "NaN".to_owned(), |ms| ms.to_string());
    let mut all = vec![
        "fleetd-task".to_owned(),
        task.task_id.as_str().to_owned(),
        created,
    ];
    all.extend(parts.iter().map(|p| (*p).to_owned()));
    all.join(":")
}

fn random_uuid() -> String {
    let b: [u8; 16] = rand::random();
    let h = |r: std::ops::Range<usize>| b[r].iter().map(|x| format!("{x:02x}")).collect::<String>();
    format!(
        "{}-{}-4{}-{:x}{}-{}",
        h(0..4),
        h(4..6),
        &h(6..8)[1..],
        8 | (b[8] & 3),
        &h(8..10)[1..],
        h(10..16)
    )
}

fn js_prefix(s: &str, max: usize) -> String {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return s[..i].to_owned();
        }
    }
    s.to_owned()
}

fn state_name<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// How long a run a task was continued in may take to show up before the ends of other runs count again.
const CONTINUED_RUN_WAIT_MS: i64 = 2 * 60 * 1000;

fn queued_reason(reason: &str) -> Text<1, 200> {
    Text::unchecked(js_prefix(reason, 200))
}

/// A spawn's task, with what its duplicate check says and the writers' changed paths it gathered.
pub struct Spawned {
    pub task: Task,
    pub note: Option<String>,
    pub observed: Observed,
}

/// Where a writer's spawn checks for duplicates.
enum SpawnScope {
    Bound(WorkScope),
    /// The project has no remote, or isn't known.
    NoRepo,
    /// Still being read from its root, in the background.
    Binding,
}

pub struct Tasks {
    d: TaskDeps,
    // Every state change goes through this, so a release, a completion and a lead call never interleave.
    lock: tokio::sync::Mutex<()>,
    /// Machines a queued task waits on; one waiter each.
    awaiting: Mutex<HashSet<MachineId>>,
    /// Tasks whose `ask_lead` question their lead hasn't answered yet (any message to the task answers it). Such a
    /// task is never paused, and a paused one that asks isn't continued until the answer is in its resume. Not kept
    /// across a hub restart: then the answer still reaches the task, only maybe after its resume.
    asking: Mutex<HashSet<TaskId>>,
    /// Tasks continued in their thread whose new run the hub hasn't seen yet, with that run's id and when it was sent.
    /// Until it shows up, for at most `CONTINUED_RUN_WAIT_MS`, an end event for another run is late word of an earlier
    /// one (T19: a node back from a stop reported the run it cut off after the task had been continued), so it doesn't
    /// end the task. Not kept across a hub restart, whose follower starts after every event appended before it.
    continuing: Mutex<HashMap<TaskId, (String, i64)>>,
    /// Projects whose repo and base a spawn is reading from their root, in the background once it stopped waiting.
    binding: Arc<Mutex<HashSet<ProjectRef>>>,
    /// Set once in `hub/serve` (`wire::wire`) to usage; unset passes through.
    pub hooks: TaskHooks,
    cursor: i64,
    /// The last thread event applied, by the follower or by a retry catching up (read and written under `lock`).
    applied: std::sync::atomic::AtomicI64,
}

#[derive(Default)]
pub struct TaskHooks {
    pub usage: OnceLock<Arc<dyn UsageGate>>,
}

impl Tasks {
    /// The cursor is read here, not in `run`, so nothing appended before `run` first waits is missed.
    pub fn new(deps: TaskDeps) -> Arc<Self> {
        let cursor = deps.events.head();
        Arc::new(Self {
            d: deps,
            lock: tokio::sync::Mutex::new(()),
            awaiting: Mutex::new(HashSet::new()),
            asking: Mutex::new(HashSet::new()),
            continuing: Mutex::new(HashMap::new()),
            binding: Arc::new(Mutex::new(HashSet::new())),
            hooks: TaskHooks::default(),
            cursor,
            applied: std::sync::atomic::AtomicI64::new(cursor),
        })
    }

    /// Registers the slot release listener (which also runs once now, picking up tasks queued before a restart)
    /// and follows thread events until the hub stops.
    pub async fn run(self: Arc<Self>, shutdown: Shutdown) {
        let weak = Arc::downgrade(&self);
        let registered = self.d.slots.on_release(Arc::new(move || {
            if let Some(tasks) = weak.upgrade() {
                tasks.retry_later();
            }
        }));
        if let Err(error) = registered {
            tracing::error!(%error, "tasks: slot listener not registered");
        }
        tokio::select! {
            () = shutdown.wait() => {}
            () = self.clone().follow(self.cursor) => {}
        }
    }

    pub(crate) fn now_iso(&self) -> String {
        iso_ms(now_ms(self.d.clock.as_ref()))
    }

    fn db<R>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<R>,
    ) -> Result<R, StoreError> {
        self.d.db.with(|c| Ok(f(c)?))
    }

    fn put(&self, stored: &StoredTask) -> Result<(), StoreError> {
        self.db(|c| TaskRecords::put(c, stored))
    }

    fn emit(
        &self,
        task: &Task,
        r#type: HubEventType,
        summary: String,
        extra: Map<String, Value>,
    ) -> Result<(), StoreError> {
        let mut data = Map::new();
        data.insert("taskId".into(), json!(task.task_id));
        data.insert("workstreamId".into(), json!(task.workstream_id));
        data.insert("createdAt".into(), json!(task.created_at));
        if let Some(branch) = &task.branch {
            data.insert("branch".into(), json!(branch));
        }
        data.extend(extra);
        self.d.events.append(NewEvent {
            at: Timestamp(self.now_iso()),
            r#type,
            machine_id: Some(task.project_ref.machine_id.clone()),
            project_id: Some(task.project_ref.project_id.clone()),
            thread_id: task.thread_ref.as_ref().map(|r| r.thread_id.clone()),
            summary,
            data: Some(Value::Object(data)),
            attention: None,
        })?;
        Ok(())
    }

    fn release_all(&self, task: &Task) -> Result<(), StoreError> {
        self.asking.lock().unwrap().remove(&task.task_id);
        self.continuing.lock().unwrap().remove(&task.task_id);
        self.d.slots.release(task.task_id.as_str())?;
        Ok(())
    }

    fn wake_result(&self, task: &Task, result: &TaskResult) {
        let text = render::task_result_lines(task.task_id.as_str(), task.title.as_str(), result);
        self.d
            .ports
            .wake(&task.project_ref, WakeKind::TaskResult, text);
    }

    fn workstream(&self, id: &WorkstreamId) -> Option<fleetd_contracts::ledger::Workstream> {
        self.d.ports.workstream(id)
    }

    /// `kind` says what it waits for (`offline`, `usage`, `slot`) for the time inspector's queue spans.
    fn queue(&self, stored: &StoredTask, kind: &str, reason: &str) -> Result<Task, StoreError> {
        let task = &stored.task;
        if task.state == TaskState::Queued
            && task.queued_reason.as_ref().map(|r| r.as_str()) == Some(reason)
        {
            return Ok(task.clone());
        }
        let mut next = task.clone();
        next.state = TaskState::Queued;
        next.queued_reason = Some(queued_reason(reason));
        self.put(&StoredTask {
            task: next.clone(),
            pending_message: stored.pending_message.clone(),
        })?;
        let mut extra = Map::new();
        extra.insert("queuedReason".into(), json!(reason));
        extra.insert("queuedKind".into(), json!(kind));
        self.emit(
            &next,
            HubEventType::TaskQueued,
            format!("{} queued: {reason}", task.task_id.as_str()),
            extra,
        )?;
        Ok(next)
    }

    /// The task's new thread, its branch, and where the branch started.
    async fn launch(&self, task: &Task) -> Result<Launched, StartError> {
        let r = &task.project_ref;
        let Some(project) = self.d.store.project_get(r)? else {
            return Err(StartError::Other(format!(
                "No project {} on machine {}.",
                r.project_id.as_str(),
                r.machine_id.as_str()
            )));
        };
        let policy = self.d.policies.get(r).await?;
        let brief = self.workstream(&task.workstream_id).and_then(|w| w.brief);
        let write = task.kind == TaskKind::Write;
        let base_branch = if write {
            Some(
                self.d
                    .ports
                    .default_branch(&r.machine_id, &project.workspace_root)
                    .await?,
            )
        } else {
            None
        };
        let branch = write.then(|| {
            branch_for(
                policy.branch_prefix.as_ref(),
                task.task_id.as_str(),
                task.title.as_str(),
            )
        });
        let elsewhere = if write {
            self.elsewhere_for(task).await
        } else {
            Vec::new()
        };
        let set = self.d.db.prompts().current(Some(r));
        let prompt = render_task_prompt(
            &set,
            &render::PromptInput {
                task,
                project_title: &project.title,
                brief: brief.as_ref(),
                done_when: brief.as_ref().map(|b| self.d.ports.done_when_text(b)),
                branch: branch.as_deref(),
                base_branch: base_branch.as_deref(),
                elsewhere: &elsewhere,
            },
        );
        let request = LaunchRequest {
            project_id: r.project_id.clone(),
            prompt: prompt.clone(),
            profile: task.profile,
            title: js_prefix(
                &format!("{}: {}", task.task_id.as_str(), task.title.as_str()),
                80,
            ),
            // The node's launch is idempotent on the request id, so a retried launch returns the same thread.
            client_request_id: request_id(task, &[&task.attempt.get().to_string()]),
            worktree: base_branch
                .zip(branch.clone())
                .map(|(base_ref, branch)| Worktree { base_ref, branch }),
        };
        let (thread_id, base) = self.d.ports.launch(&r.machine_id, request).await?;
        // Every later message to this thread renders from the texts it starts with. The thread runs either way.
        if let Err(error) = self.d.db.prompts().pin(
            &set,
            crate::hub::prompts::Audience::Task,
            r,
            &thread_id,
            &Timestamp(self.now_iso()),
            &prompt,
        ) {
            tracing::warn!(task = %task.task_id.as_str(), %error, "task prompts not pinned");
        }
        Ok((
            ThreadRef {
                machine_id: r.machine_id.clone(),
                thread_id,
            },
            branch,
            base,
        ))
    }

    fn fail_to_start(
        &self,
        stored: &StoredTask,
        message: &str,
        from_queue: bool,
    ) -> Result<Task, StoreError> {
        let task = &stored.task;
        let at = self.now_iso();
        let result = TaskResult {
            status: TaskResultStatus::Failed,
            tail: Text::unchecked(tail_of(
                &format!("fleetd could not start the task: {message}"),
                render::TAIL_MAX,
            )),
            branch: task.branch.clone(),
            pr_url: None,
            end_cause: Some(RunEnd::Failed),
            at: Timestamp(at.clone()),
        };
        let mut next = task.clone();
        next.queued_reason = None;
        next.state = TaskState::Failed;
        next.result = Some(result.clone());
        next.ended_at = Some(Timestamp(at));
        self.put(&StoredTask {
            task: next.clone(),
            pending_message: None,
        })?;
        self.release_all(task)?;
        // A direct call gets this in its reply; a task started from the queue has nobody waiting on it.
        if from_queue {
            self.wake_result(&next, &result);
        }
        self.emit(
            &next,
            HubEventType::TaskFailed,
            format!("{} failed to start: {message}", task.task_id.as_str()),
            Map::new(),
        )?;
        Ok(next)
    }

    fn retry_when_live(self: &Arc<Self>, machine_id: &MachineId) {
        if !self.awaiting.lock().unwrap().insert(machine_id.clone()) {
            return;
        }
        let (tasks, machine_id) = (self.clone(), machine_id.clone());
        tokio::spawn(async move {
            tasks.d.ports.await_live(&machine_id).await;
            tasks.awaiting.lock().unwrap().remove(&machine_id);
            let _guard = tasks.lock.lock().await;
            // A node back from a stop reports the runs it cut off: apply those first, while their tasks still wait,
            // so a task this continues isn't then ended by its previous run's end.
            tasks.catch_up().await;
            tasks.retry_queue().await;
        });
    }

    fn retry_later(self: &Arc<Self>) {
        let tasks = self.clone();
        tokio::spawn(async move {
            let _guard = tasks.lock.lock().await;
            // The slot board follows thread events on its own, so it can free a slot before this area's follower has
            // ended the task whose thread stopped. Apply those events first, so `task.completed` precedes the next
            // start, the order older hubs emitted them in.
            tasks.catch_up().await;
            tasks.retry_queue().await;
        });
    }

    /// Applies every thread event appended since the last one applied. Call with the lock held.
    async fn catch_up(self: &Arc<Self>) {
        use std::sync::atomic::Ordering;
        loop {
            let input = WaitInput {
                cursor: Some(self.applied.load(Ordering::SeqCst)),
                types: Some(THREAD_EVENTS.to_vec()),
                machine_id: None,
                timeout_sec: 0,
            };
            let Ok(page) = self.d.events.wait(input).await else {
                return;
            };
            for event in &page.events {
                self.apply(event).await;
            }
            self.applied.fetch_max(page.cursor, Ordering::SeqCst);
            if !page.more {
                return;
            }
        }
    }

    /// One thread event, once: the follower and `catch_up` both pass every event here. Call with the lock held.
    async fn apply(self: &Arc<Self>, event: &HubEvent) {
        use std::sync::atomic::Ordering;
        let seq = event.seq.get();
        if seq <= self.applied.load(Ordering::SeqCst) {
            return;
        }
        if let Err(error) = self.on_thread_event(event).await {
            tracing::warn!(seq, %error, "task event not handled");
        }
        self.applied.store(seq, Ordering::SeqCst);
    }

    /// A slot, then the launch or the pending message. Queues with the first reason it cannot go.
    /// Never fails: a store failure is logged and the task returned as it was. Call with the lock held.
    async fn try_start(self: &Arc<Self>, stored: StoredTask, from_queue: bool) -> Task {
        match self.try_start_inner(&stored, from_queue).await {
            Ok(task) => task,
            Err(error) => {
                tracing::warn!(task_id = stored.task.task_id.as_str(), %error, "task start failed");
                stored.task
            }
        }
    }

    async fn try_start_inner(
        self: &Arc<Self>,
        stored: &StoredTask,
        from_queue: bool,
    ) -> Result<Task, StoreError> {
        let task = &stored.task;
        let r = &task.project_ref;
        // Checked before the slot: taking and releasing one would run the queue again at once.
        let offline = format!("machine {} is offline", r.machine_id.as_str());
        if !self.d.ports.is_connected(&r.machine_id) {
            self.retry_when_live(&r.machine_id);
            return self.queue(stored, "offline", &offline);
        }
        // M4 usage: a paused login takes no new turns; usage.resumed runs the queue again.
        if let Some(paused) = self.hooks.usage.get().and_then(|u| u.gate(&r.machine_id)) {
            return self.queue(stored, "usage", &paused);
        }
        let continuing = task.thread_ref.is_some() && stored.pending_message.is_some();
        // The disk and load guard holds new agents only; machine.guard runs the queue again. One with a thread
        // continues in the worktree it has.
        if !continuing && let Some(paused) = self.d.ports.paused(&r.machine_id) {
            return self.queue(stored, "guard", &paused);
        }
        let slot = self.d.slots.acquire(SlotRequest {
            holder: task.task_id.as_str(),
            project_ref: r,
            priority: priority_of(task.kind),
        })?;
        if let crate::hub::slots::Grant::Queued(reason) = slot {
            return self.queue(stored, "slot", &reason);
        }

        // A paused agent's thread is still pushing its work: it continues once that turn ended, when its stop frees
        // the slot and runs the queue again. One that asked its lead meanwhile continues with the answer.
        if continuing && self.asking.lock().unwrap().contains(&task.task_id) {
            return Ok(task.clone());
        }
        if continuing
            && let Some(thread) = &task.thread_ref
            && self
                .d
                .store
                .thread_get(thread)?
                .is_some_and(|t| t.thread.status == fleetd_contracts::model::ThreadStatus::Running)
        {
            return Ok(task.clone());
        }
        let started = if continuing {
            let thread = task.thread_ref.as_ref().expect("continuing has a thread");
            let message = stored
                .pending_message
                .as_deref()
                .expect("continuing has a message");
            let id = request_id(task, &[&task.attempt.get().to_string()]);
            let steer =
                crate::hub::steer::take_held(&self.d.db, task.task_id.as_str(), thread, &id);
            let sent = match &steer {
                Some(steer) => {
                    self.d
                        .ports
                        .send_steer(thread, message, &id, steer.clone())
                        .await
                }
                None => self.d.ports.send(thread, message, &id).await,
            };
            if let (Err(_), Some(steer)) = (&sent, &steer) {
                crate::hub::steer::rehold(&self.d.db, &steer.id);
            }
            if sent.is_ok() {
                // The node runs a send under the run id its request id gives.
                let run = crate::hub::executor::Executors::send_run_id(thread, &id);
                let at = now_ms(self.d.clock.as_ref());
                self.continuing
                    .lock()
                    .unwrap()
                    .insert(task.task_id.clone(), (run, at));
            }
            sent.map(|_| (thread.clone(), None, None))
                .map_err(StartError::from)
        } else {
            self.launch(task).await
        };
        let (thread_ref, branch, base) = match started {
            Ok(started) => started,
            Err(StartError::Offline) => {
                self.d.slots.release(task.task_id.as_str())?;
                self.retry_when_live(&r.machine_id);
                return self.queue(stored, "offline", &offline);
            }
            Err(StartError::Other(message)) => {
                return self.fail_to_start(stored, &message, from_queue);
            }
        };
        let at = self.now_iso();
        let mut next = task.clone();
        next.queued_reason = None;
        next.ended_at = None;
        next.parked = None;
        next.thread_ref = Some(thread_ref.clone());
        if let Some(branch) = branch {
            next.branch = Some(NonEmpty::unchecked(branch));
        }
        // Raised once per project while git can't fetch its remote: not again while the last base failed the same way.
        let fetch_failed = match base.as_ref().and_then(base::alert) {
            Some(kind)
                if self
                    .db(|c| TaskRecords::latest_base(c, r))?
                    .as_ref()
                    .and_then(base::alert)
                    != Some(kind) =>
            {
                base.clone()
            }
            _ => None,
        };
        if !continuing {
            next.base = base.clone();
        }
        next.state = TaskState::Running;
        next.started_at = Some(task.started_at.clone().unwrap_or(Timestamp(at)));
        // From here the board holds the slot while the thread runs and frees it whenever it stops.
        self.d.slots.bind(task.task_id.as_str(), &thread_ref)?;
        self.put(&StoredTask {
            task: next.clone(),
            pending_message: None,
        })?;
        let now = self.now_iso();
        let summary = if continuing {
            format!(
                "{} continued (attempt {}): {}",
                task.task_id.as_str(),
                task.attempt.get(),
                task.title.as_str()
            )
        } else {
            let based = base
                .as_ref()
                .map_or_else(String::new, |b| format!("; {}", base::line(b, &now)));
            format!(
                "{} started ({}): {}{based}",
                task.task_id.as_str(),
                task.profile.as_str(),
                task.title.as_str()
            )
        };
        let mut extra = Map::new();
        if let Some(base) = &base {
            extra.insert("base".into(), json!(base));
        }
        self.emit(&next, HubEventType::TaskStarted, summary, extra)?;
        if let Some(failed) = fetch_failed {
            self.fetch_failed(&next, failed, &now)?;
        }
        Ok(next)
    }

    /// `project.fetch_failed`: the attention item for a start whose base git couldn't fetch, with the fix.
    fn fetch_failed(&self, task: &Task, base: WorktreeBase, now: &str) -> Result<(), StoreError> {
        let r = &task.project_ref;
        let project = self
            .d
            .store
            .project_get(r)?
            .map_or_else(|| r.project_id.to_string(), |p| p.title);
        let (message, fix) = base::fetch_failed_text(&project, &base, now);
        let data = FetchFailedData {
            project_ref: r.clone(),
            task_id: task.task_id.clone(),
            base,
            message: message.clone(),
            fix,
        };
        self.d.events.append(NewEvent {
            at: Timestamp(now.to_owned()),
            r#type: HubEventType::ProjectFetchFailed,
            machine_id: Some(r.machine_id.clone()),
            project_id: Some(r.project_id.clone()),
            thread_id: task.thread_ref.as_ref().map(|t| t.thread_id.clone()),
            summary: message,
            data: Some(json!(data)),
            attention: Some(Attention::Loud),
        })?;
        Ok(())
    }

    /// FIFO over every project's queue; each task is tried once. Call with the lock held.
    async fn retry_queue(self: &Arc<Self>) {
        let queued = match self.db(TaskRecords::queued) {
            Ok(queued) => queued,
            Err(error) => return tracing::warn!(%error, "tasks: queue not read"),
        };
        for stored in queued {
            self.try_start(stored, true).await;
        }
    }

    /// `why` stands in for the thread's own error: the watchdog's stall, which the thread row does not hold yet.
    async fn finish(
        self: &Arc<Self>,
        stored: &StoredTask,
        status: TaskResultStatus,
        why: Option<String>,
        end_cause: Option<RunEnd>,
    ) -> Result<(), StoreError> {
        let task = &stored.task;
        let thread_ref = task.thread_ref.clone().expect("a live task has a thread");
        let thread = self.d.store.thread_get(&thread_ref)?;
        let text = thread
            .as_ref()
            .map_or("", |t| t.thread.latest_message_tail.as_str())
            .to_owned();
        let error = why.unwrap_or_else(|| match (&thread, status) {
            (Some(t), TaskResultStatus::Failed) => t
                .thread
                .last_error
                .as_ref()
                .map(|e| format!("[{}] {}", e.class, e.message))
                .unwrap_or_default(),
            _ => String::new(),
        });
        let write = task.kind == TaskKind::Write;
        let changes = if write {
            self.d.ports.changes(&thread_ref).await
        } else {
            None
        };
        let actions = self.d.ports.action_texts(&thread_ref, 30).await;
        let pr_url = changes
            .as_ref()
            .and_then(|c| c.pull_request_urls.last().cloned())
            .or_else(|| {
                let mut texts: Vec<&str> = Vec::new();
                for (summary, output_tail) in actions.iter().rev() {
                    texts.push(summary);
                    if let Some(out) = output_tail {
                        texts.push(out);
                    }
                }
                texts.push(&text);
                find_pr_url(texts)
            });
        let branch = changes
            .as_ref()
            .and_then(|c| c.branch.clone())
            .or_else(|| task.branch.as_ref().map(|b| b.as_str().to_owned()));
        let at = self.now_iso();
        let tail = [text.trim(), error.as_str()]
            .iter()
            .filter(|s| !s.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join("\n\n");
        let result = TaskResult {
            status,
            tail: Text::unchecked(tail_of(&tail, render::TAIL_MAX)),
            branch: branch.clone().map(NonEmpty::unchecked),
            pr_url: pr_url.map(PrUrl::unchecked),
            end_cause,
            at: Timestamp(at.clone()),
        };
        let mut next = task.clone();
        next.state = if status == TaskResultStatus::Done {
            TaskState::Done
        } else {
            TaskState::Failed
        };
        next.result = Some(result.clone());
        next.ended_at = Some(Timestamp(at));
        if let Some(branch) = &branch {
            next.branch = Some(NonEmpty::unchecked(branch.clone()));
        }
        if let Some(path) = changes.as_ref().and_then(|c| c.worktree_path.clone()) {
            next.worktree_path = Some(fleetd_contracts::tasks::AbsolutePath::unchecked(path));
        }
        self.put(&StoredTask {
            task: next.clone(),
            pending_message: None,
        })?;

        self.release_all(task)?;
        self.wake_result(&next, &result);
        // Last, so whoever waits on it sees the slot and the wake already settled.
        let (r#type, verb) = if status == TaskResultStatus::Done {
            (HubEventType::TaskCompleted, "completed")
        } else {
            (HubEventType::TaskFailed, "failed")
        };
        self.emit(
            &next,
            r#type,
            format!("{} {verb}: {}", task.task_id.as_str(), task.title.as_str()),
            Map::new(),
        )?;
        self.retry_queue().await;
        Ok(())
    }

    async fn on_thread_event(self: &Arc<Self>, event: &HubEvent) -> Result<(), StoreError> {
        match event.r#type {
            HubEventType::UsageResumed | HubEventType::MachineGuard => {
                self.retry_queue().await;
                return Ok(());
            }
            HubEventType::PrMerged => return self.merged(event),
            _ => {}
        }
        let (Some(machine_id), Some(thread_id)) = (&event.machine_id, &event.thread_id) else {
            return Ok(());
        };
        let thread_ref = ThreadRef {
            machine_id: machine_id.clone(),
            thread_id: thread_id.clone(),
        };
        let Some(stored) = self.db(|c| TaskRecords::by_thread(c, &thread_ref))? else {
            return Ok(());
        };
        let task = &stored.task;
        // An earlier run's end is not this run's: the task goes on.
        let live = matches!(task.state, TaskState::Running | TaskState::Idle)
            && !self.earlier_run(task, &thread_ref, event)?;
        match event.r#type {
            HubEventType::ThreadStarted => {
                // Continued outside `task message`: the usage layer's continue, or a human writing to the thread.
                if !matches!(
                    task.state,
                    TaskState::Done | TaskState::Failed | TaskState::Idle
                ) {
                    return Ok(());
                }
                let request = SlotRequest {
                    holder: task.task_id.as_str(),
                    project_ref: &task.project_ref,
                    priority: priority_of(task.kind),
                };
                self.d.slots.acquire(request)?;
                self.d.slots.bind(task.task_id.as_str(), &thread_ref)?;
                let mut next = task.clone();
                next.ended_at = None;
                next.parked = None;
                next.state = TaskState::Running;
                self.put(&StoredTask {
                    task: next,
                    pending_message: None,
                })?;
            }
            HubEventType::ThreadWaiting => {
                // The board frees the slot itself and takes it again if the run resumes.
                if task.state != TaskState::Running {
                    return Ok(());
                }
                let mut next = task.clone();
                next.state = TaskState::Idle;
                self.put(&StoredTask {
                    task: next,
                    pending_message: None,
                })?;
                // Nobody else answers a task's question, so its lead is woken with it.
                let asked = self.d.ports.pending_question(&thread_ref).await;
                let latest = self
                    .d
                    .store
                    .thread_get(&thread_ref)?
                    .map(|t| t.thread.latest_message_tail.as_str().trim().to_owned());
                let question = asked
                    .or_else(|| latest.filter(|l| !l.is_empty()).map(|l| tail_of(&l, 1500)))
                    .unwrap_or_else(|| {
                        format!(
                            "(the node did not say what it waits for; read it with thread_tail on {}/{})",
                            thread_ref.machine_id.as_str(),
                            thread_ref.thread_id.as_str()
                        )
                    });
                let text = render::task_waiting_lines(
                    task.task_id.as_str(),
                    task.title.as_str(),
                    &question,
                );
                self.d
                    .ports
                    .wake(&task.project_ref, WakeKind::TaskWaiting, text);
            }
            HubEventType::ThreadCompleted if live => {
                let end = end_cause(event).or(Some(RunEnd::Completed));
                self.finish(&stored, TaskResultStatus::Done, None, end)
                    .await?
            }
            HubEventType::ThreadUsageLimited => {
                // M4 usage: parked, not failed. The board freed the slot, and the usage layer sends
                // "continue" at the reset, which comes back here as thread.started.
                if let Some(parked) = self
                    .hooks
                    .usage
                    .get()
                    .and_then(|u| u.parked_of(event))
                    .filter(|_| live)
                {
                    let mut next = task.clone();
                    next.state = TaskState::Idle;
                    next.parked = Some(parked);
                    self.put(&StoredTask {
                        task: next,
                        pending_message: stored.pending_message.clone(),
                    })?;
                }
            }
            // A cancel interrupts the thread itself and has already ended the task.
            HubEventType::ThreadFailed | HubEventType::ThreadInterrupted if live => {
                let stalled = event
                    .data
                    .as_ref()
                    .filter(|d| d["reason"] == "stalled")
                    .and_then(|d| d["error"]["message"].as_str())
                    .map(|m| format!("[stalled] {m}"));
                let end = if stalled.is_some() {
                    Some(RunEnd::Stalled)
                } else {
                    end_cause(event)
                };
                self.finish(&stored, TaskResultStatus::Failed, stalled, end)
                    .await?
            }
            _ => {}
        }
        Ok(())
    }

    /// Whether a thread event's run is older than the one the task is on, so its end is not the task's: the task was
    /// continued and that run hasn't shown up yet, or a newer run has started on the thread since (a send still queued
    /// behind the run doesn't count). Every event of a task's thread passes here, so a continued run is seen as soon as
    /// it starts. One that never shows up (the node took the send, then died) is given up on after a while, so the
    /// task's next end isn't ignored for good.
    fn earlier_run(
        &self,
        task: &Task,
        thread: &ThreadRef,
        event: &HubEvent,
    ) -> Result<bool, StoreError> {
        let Some(run) = event.data.as_ref().and_then(|d| d["runId"].as_str()) else {
            return Ok(false);
        };
        let now = now_ms(self.d.clock.as_ref());
        let awaited = {
            let mut continuing = self.continuing.lock().unwrap();
            match continuing.get(&task.task_id) {
                // Any run that starts now is the continued one or a later one.
                Some((sent, at))
                    if sent != run
                        && event.r#type != HubEventType::ThreadStarted
                        && now - at < CONTINUED_RUN_WAIT_MS =>
                {
                    true
                }
                Some(_) => {
                    continuing.remove(&task.task_id);
                    false
                }
                None => false,
            }
        };
        let ends = matches!(
            event.r#type,
            HubEventType::ThreadCompleted
                | HubEventType::ThreadFailed
                | HubEventType::ThreadInterrupted
                | HubEventType::ThreadUsageLimited
        );
        let earlier = awaited
            || (ends
                && self
                    .d
                    .ports
                    .started_run(thread)
                    .is_some_and(|started| started != run));
        if earlier {
            tracing::info!(
                task_id = task.task_id.as_str(),
                seq = event.seq.get(),
                run,
                "task event for an earlier run ignored"
            );
        }
        Ok(earlier)
    }

    async fn follow(self: Arc<Self>, from: i64) {
        let mut cursor = from;
        loop {
            let input = WaitInput {
                cursor: Some(cursor),
                types: Some(THREAD_EVENTS.to_vec()),
                machine_id: None,
                timeout_sec: 300,
            };
            let page = match self.d.events.wait(input).await {
                Ok(page) => page,
                Err(error) => {
                    tracing::warn!(%error, "tasks: event wait failed");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            };
            cursor = page.cursor;
            for event in &page.events {
                let _guard = self.lock.lock().await;
                self.apply(event).await;
            }
        }
    }

    fn owned(&self, caller: &TaskCaller, task_id: &TaskId) -> Result<StoredTask, TaskError> {
        match self
            .db(|c| TaskRecords::get(c, task_id))
            .map_err(store_error)?
        {
            Some(stored) if same_project(&stored.task.project_ref, &caller.project_ref) => {
                Ok(stored)
            }
            _ => Err(lead_error(
                ErrorCode::NotFound,
                format!("No task {} in this project.", task_id.as_str()),
                Some("Call `agents`."),
            )),
        }
    }

    /// The task as stored: running, queued with its reason, or failed if the node refused the launch.
    pub async fn spawn(
        self: &Arc<Self>,
        caller: &TaskCaller,
        input: SpawnInput,
    ) -> Result<Task, TaskError> {
        self.spawn_noted(caller, input).await.map(|s| s.task)
    }

    /// `spawn`, with what a writer's duplicate check has to say: the work elsewhere it may overlap, or that it was
    /// not checked; and the writers' changed paths it gathered, for `also_writing`. A writer that repeats work in
    /// flight is refused (`duplicates`).
    pub async fn spawn_noted(
        self: &Arc<Self>,
        caller: &TaskCaller,
        input: SpawnInput,
    ) -> Result<Spawned, TaskError> {
        let r = &caller.project_ref;
        // Binding may ask the node, and so does each writer's changed paths: both happen before the lock, the paths
        // within `OBSERVE_TIMEOUT`, so a slow node never holds up other task calls. Under the lock the check reads
        // the store only.
        let checked = if input.kind == TaskKind::Write {
            let scope = self.spawn_scope(r).await?;
            let observed = match &scope {
                SpawnScope::Bound(scope) => self
                    .d
                    .ports
                    .work_observe(scope, OBSERVE_TIMEOUT)
                    .await
                    .map_err(store_error)?,
                _ => Observed::default(),
            };
            Some((scope, observed))
        } else {
            None
        };
        let _guard = self.lock.lock().await;
        let ws = match self.workstream(&input.workstream_id) {
            Some(ws) if same_project(&ws.project_ref, r) => ws,
            _ => {
                return Err(lead_error(
                    ErrorCode::NotFound,
                    format!(
                        "No workstream {} in this project.",
                        input.workstream_id.as_str()
                    ),
                    Some("Use a workstream id from your digest."),
                ));
            }
        };
        if ws.state != fleetd_contracts::ledger::WorkstreamState::Open {
            let ws_state = state_name(&ws.state);
            return Err(lead_error(
                ErrorCode::Invalid,
                format!(
                    "Workstream {} is {ws_state}; tasks run only for open workstreams.",
                    input.workstream_id.as_str()
                ),
                None,
            ));
        }
        let counts = self
            .db(|c| TaskRecords::counts(c, r))
            .map_err(store_error)?;
        policy::check_fan_out(
            (counts.queued.get() + counts.running.get() + counts.idle.get()) as usize,
        )?;
        if let Some(item) = &input.item {
            let mut refused = None;
            self.d
                .db
                .with(|c| {
                    refused =
                        crate::hub::plan::Plans::check_spawn_item(c, r, item, &input.workstream_id)
                            .err();
                    Ok(())
                })
                .map_err(store_error)?;
            if let Some(e) = refused {
                return Err(lead_error(e.0.code, e.0.message, e.0.fix.as_deref()));
            }
        }
        let (note, overridden) = match &checked {
            Some((scope, observed)) => self.check_duplicates(r, scope, observed, &input)?,
            None => (None, Vec::new()),
        };
        // A broken policy file refuses the spawn now, not at its launch. An offline machine's file can't be read: the
        // task queues "offline", and its launch reads the file and still refuses a broken one.
        match self.d.policies.get(r).await {
            Err(e) if e.code != ErrorCode::MachineOffline => return Err(e),
            _ => {}
        }
        let profile = resolve_profile(input.profile, input.kind, self.d.ports.medium_allowed(r));
        let task = Task {
            task_id: TaskId::unchecked("T0"),
            project_ref: r.clone(),
            workstream_id: input.workstream_id.clone(),
            title: input.title.clone(),
            kind: input.kind,
            prompt: input.prompt.clone(),
            profile,
            qa: input.qa,
            pr: input.pr.clone(),
            item_id: input.item.clone(),
            paths: input.paths.clone(),
            state: TaskState::Queued,
            queued_reason: None,
            thread_ref: None,
            branch: None,
            base: None,
            worktree_path: None,
            parked: None,
            attempt: Int::unchecked(1),
            result: None,
            created_at: Timestamp(self.now_iso()),
            started_at: None,
            ended_at: None,
        };
        let task = self
            .db(|c| {
                let task = TaskRecords::create(c, task)?;
                if let Some(item) = &task.item_id {
                    crate::hub::plan::Plans::link_task(
                        c,
                        item,
                        &task.workstream_id,
                        &task.task_id,
                    )?;
                }
                Ok(task)
            })
            .map_err(store_error)?;
        if !overridden.is_empty() {
            tracing::info!(
                task = task.task_id.as_str(),
                project = %r.project_id,
                over = overridden.join(", "),
                why = input.not_duplicate_why.as_ref().map_or("", |w| w.as_str()),
                "tasks: spawned over a possible duplicate"
            );
        }
        let task = self
            .try_start(
                StoredTask {
                    task,
                    pending_message: None,
                },
                false,
            )
            .await;
        Ok(Spawned {
            task,
            note,
            observed: checked.map(|(_, observed)| observed).unwrap_or_default(),
        })
    }

    /// The project's repo and base for a writer's duplicate check. Unrecorded, they are read from its root, waiting at
    /// most `BIND_WAIT`: a slow remote finishes in the background, so a later spawn has them. One read runs per
    /// project at a time.
    async fn spawn_scope(&self, r: &ProjectRef) -> Result<SpawnScope, TaskError> {
        if let Some(scope) = self.d.ports.work_scope(r).await.map_err(store_error)? {
            return Ok(SpawnScope::Bound(scope));
        }
        if !self.binding.lock().unwrap().insert(r.clone()) {
            return Ok(SpawnScope::Binding);
        }
        let (bind, binding, project) = (self.d.ports.work_bind(r), self.binding.clone(), r.clone());
        let mut bound = tokio::spawn(async move {
            let bound = bind.await;
            binding.lock().unwrap().remove(&project);
            if let Err(error) = &bound {
                tracing::warn!(%error, project = %project.project_id, "tasks: repo and base not read");
            }
            bound
        });
        match tokio::time::timeout(BIND_WAIT, &mut bound).await {
            Ok(Ok(Ok(Some(scope)))) => Ok(SpawnScope::Bound(scope)),
            Ok(Ok(Ok(None)) | Err(_)) => Ok(SpawnScope::NoRepo),
            Ok(Ok(Err(error))) => Err(store_error(error)),
            Err(_) => Ok(SpawnScope::Binding),
        }
    }

    /// The work in flight a writer may overlap, read again from the store as it starts, for its prompt: no node is
    /// asked, as a launch holds the tasks lock. Nothing when it can't be read: the spawn was checked already.
    async fn elsewhere_for(&self, task: &Task) -> Vec<String> {
        let r = &task.project_ref;
        let Ok(Some(scope)) = self.d.ports.work_scope(r).await else {
            return Vec::new();
        };
        let intent = duplicates::intent(
            r,
            &scope,
            task.title.as_str(),
            task.prompt.as_str(),
            task.item_id.as_ref(),
            task.pr.as_ref(),
            task.paths.iter().flatten().map(|p| p.as_str().to_owned()),
        );
        match self.d.ports.work_match(&scope, &intent, &HashMap::new()) {
            Ok(matches) => duplicates::for_writer(&matches, &task.task_id),
            Err(error) => {
                tracing::warn!(%error, task = task.task_id.as_str(), "tasks: work elsewhere not read");
                Vec::new()
            }
        }
    }

    /// A writer against the work in flight on its project's repo and base, with the writers' paths gathered before
    /// the lock: refused when it repeats some, else what it may overlap (the result's `elsewhere:` line) and the ids
    /// `notDuplicateOf` let it through over. Reads the store only.
    fn check_duplicates(
        &self,
        r: &ProjectRef,
        scope: &SpawnScope,
        observed: &Observed,
        input: &SpawnInput,
    ) -> Result<(Option<String>, Vec<String>), TaskError> {
        let scope = match scope {
            SpawnScope::Bound(scope) => scope,
            SpawnScope::NoRepo => return Ok((Some(duplicates::UNBOUND.to_owned()), Vec::new())),
            SpawnScope::Binding => return Ok((Some(duplicates::BINDING.to_owned()), Vec::new())),
        };
        let intent = duplicates::spawn_intent(input, r, scope);
        let matches = self
            .d
            .ports
            .work_match(scope, &intent, &observed.paths)
            .map_err(store_error)?;
        let passed = duplicates::judge(&matches, input, &observed.unknown)?;
        let note = (!passed.elsewhere.is_empty())
            .then(|| format!("elsewhere: {}", passed.elsewhere.join("; ")));
        Ok((note, passed.overridden))
    }

    /// Steers a running task; continues an ended one in the same thread, which re-takes its slot.
    pub async fn message(
        self: &Arc<Self>,
        caller: &TaskCaller,
        task_id: &TaskId,
        text: &str,
    ) -> Result<Task, TaskError> {
        let _guard = self.lock.lock().await;
        let stored = self.owned(caller, task_id)?;
        let task = stored.task.clone();
        let id = task_id.as_str();
        match task.state {
            TaskState::Cancelled => Err(lead_error(
                ErrorCode::Invalid,
                format!("{id} was cancelled."),
                Some("Spawn a new task for the remaining work."),
            )),
            TaskState::Queued => {
                if task.thread_ref.is_none() {
                    return Err(lead_error(
                        ErrorCode::Invalid,
                        format!(
                            "{id} has not started yet ({}).",
                            task.queued_reason.as_ref().map_or("queued", |r| r.as_str())
                        ),
                        Some(
                            "Wait for it to start, or stop it with `stop_agent` and spawn it again with the new prompt.",
                        ),
                    ));
                }
                let pending = match &stored.pending_message {
                    None => text.to_owned(),
                    Some(earlier) => format!("{earlier}\n\n{text}"),
                };
                self.put(&StoredTask {
                    task: task.clone(),
                    pending_message: Some(pending),
                })
                .map_err(store_error)?;
                if self.asking.lock().unwrap().remove(task_id) {
                    // A paused agent held back for this answer can continue now, if a slot is free.
                    self.retry_later();
                }
                Ok(task)
            }
            TaskState::Running => {
                self.asking.lock().unwrap().remove(task_id);
                let thread = task
                    .thread_ref
                    .as_ref()
                    .expect("a running task has a thread");
                let uuid = random_uuid();
                self.d
                    .ports
                    .send(thread, text, &request_id(&task, &["msg", &uuid]))
                    .await
                    .map_err(|e| e.to_task_error(&thread.machine_id))?;
                Ok(task)
            }
            _ => {
                self.asking.lock().unwrap().remove(task_id);
                let mut next = task;
                next.attempt = Int::unchecked(next.attempt.get() + 1);
                Ok(self
                    .try_start(
                        StoredTask {
                            task: next,
                            pending_message: Some(text.to_owned()),
                        },
                        false,
                    )
                    .await)
            }
        }
    }

    /// Removes `text` from a task's pending message (a withdrawn steer that was waiting for its next run); false once
    /// that run went out.
    pub async fn take_back(&self, task_id: &TaskId, text: &str) -> Result<bool, TaskError> {
        let _guard = self.lock.lock().await;
        let Some(mut stored) = self
            .db(|c| TaskRecords::get(c, task_id))
            .map_err(store_error)?
        else {
            return Ok(false);
        };
        let Some(pending) = stored.pending_message.take() else {
            return Ok(false);
        };
        let parts: Vec<&str> = pending.split("\n\n").collect();
        let ours: Vec<&str> = text.split("\n\n").collect();
        let Some(at) = parts.windows(ours.len()).position(|w| w == ours.as_slice()) else {
            return Ok(false);
        };
        let rest: Vec<&str> = parts[..at]
            .iter()
            .chain(&parts[at + ours.len()..])
            .copied()
            .collect();
        stored.pending_message = (!rest.is_empty()).then(|| rest.join("\n\n"));
        self.put(&stored).map_err(store_error)?;
        Ok(true)
    }

    /// Interrupts a running task and releases its slot.
    pub async fn cancel(
        self: &Arc<Self>,
        caller: &TaskCaller,
        task_id: &TaskId,
        reason: Option<&str>,
    ) -> Result<Task, TaskError> {
        let _guard = self.lock.lock().await;
        let task = self.owned(caller, task_id)?.task;
        let id = task_id.as_str();
        match task.state {
            TaskState::Cancelled => return Ok(task),
            TaskState::Done | TaskState::Failed => {
                return Err(lead_error(
                    ErrorCode::Invalid,
                    format!(
                        "{id} already ended ({}); there is nothing to cancel.",
                        state_name(&task.state)
                    ),
                    None,
                ));
            }
            _ => {}
        }
        // The slot goes only once the agent's claude has exited: a cancel the node could not carry out
        // leaves the task as it was, still holding it, and says so. Under the lock, so the thread's own end
        // (interrupted) finds the task cancelled rather than failing it.
        if matches!(task.state, TaskState::Running | TaskState::Idle)
            && let Some(thread) = &task.thread_ref
            && let Err(error) = self.d.ports.stop(thread).await
        {
            tracing::warn!(task_id = id, error = ?error, "task cancel: stop failed");
            let why = match &error {
                PortError::Offline => {
                    format!("machine {} has no live node link", thread.machine_id)
                }
                PortError::Failed(message) => message.clone(),
            };
            return Err(lead_error(
                ErrorCode::Failed,
                format!("{id} could not be stopped ({why}); it keeps running and keeps its slot."),
                Some("Call stop_agent again shortly."),
            ));
        }
        let at = self.now_iso();
        let reason = reason.map_or_else(|| format!("Cancelled by {}.", caller.by), str::to_owned);
        let result = TaskResult {
            status: TaskResultStatus::Cancelled,
            tail: Text::unchecked(tail_of(&reason, render::TAIL_MAX)),
            branch: task.branch.clone(),
            pr_url: None,
            end_cause: Some(RunEnd::Requested),
            at: Timestamp(at.clone()),
        };
        let mut next = task.clone();
        next.queued_reason = None;
        next.state = TaskState::Cancelled;
        next.result = Some(result);
        next.ended_at = Some(Timestamp(at));
        let done = (|| {
            self.put(&StoredTask {
                task: next.clone(),
                pending_message: None,
            })?;
            self.release_all(&task)?;
            self.emit(
                &next,
                HubEventType::TaskCancelled,
                format!("{id} cancelled: {}", task.title.as_str()),
                Map::new(),
            )
        })();
        done.map_err(store_error)?;
        self.retry_queue().await;
        Ok(next)
    }

    /// A writer's PR merged: its worktree goes, unless its agent is still at work.
    fn merged(self: &Arc<Self>, event: &HubEvent) -> Result<(), StoreError> {
        let Some(task_id) = event
            .data
            .as_ref()
            .and_then(|d| d.get("taskId"))
            .and_then(Value::as_str)
            .and_then(|id| TaskId::new(id).ok())
        else {
            return Ok(());
        };
        if let Some(task) = self.get(&task_id)?
            && matches!(task.state, TaskState::Done | TaskState::Failed)
        {
            self.remove_worktree(&task);
        }
        Ok(())
    }

    /// Has the node delete a writer's worktree, and the build output in it, off the lock. A node that can't (offline,
    /// a git error, or work that exists only there) leaves it, logged.
    fn remove_worktree(self: &Arc<Self>, task: &Task) {
        let (TaskKind::Write, Some(thread)) = (task.kind, task.thread_ref.clone()) else {
            return;
        };
        let (tasks, task_id) = (self.clone(), task.task_id.clone());
        tokio::spawn(async move {
            if let Err(error) = tasks.d.ports.remove_worktree(&thread).await {
                tracing::warn!(task_id = task_id.as_str(), ?error, "worktree not removed");
            }
        });
    }

    pub fn get(&self, task_id: &TaskId) -> Result<Option<Task>, StoreError> {
        Ok(self.db(|c| TaskRecords::get(c, task_id))?.map(|s| s.task))
    }

    /// The task whose agent runs in `thread`, if one does.
    pub fn task_of_thread(&self, thread: &ThreadRef) -> Result<Option<Task>, StoreError> {
        Ok(self
            .db(|c| TaskRecords::by_thread(c, thread))?
            .map(|s| s.task))
    }

    /// A task's agent asks its lead (`ask_lead`): the lead is woken with the question, as with a task waiting for
    /// input, and answers with `message_agent`, which reaches the task as a steer.
    pub fn ask_lead(&self, task_id: &TaskId, question: &str) -> Result<Task, TaskError> {
        let Some(task) = self.get(task_id).map_err(store_error)? else {
            return Err(lead_error(
                ErrorCode::NotFound,
                format!("No task {}.", task_id.as_str()),
                None,
            ));
        };
        self.asking.lock().unwrap().insert(task_id.clone());
        let text = render::task_waiting_lines(task_id.as_str(), task.title.as_str(), question);
        self.d
            .ports
            .wake(&task.project_ref, WakeKind::TaskWaiting, text);
        Ok(task)
    }

    /// Newest first.
    pub fn list(&self, filter: &TaskFilter) -> Result<Vec<Task>, StoreError> {
        self.db(|c| TaskRecords::list(c, filter))
    }
}

const ALSO_WRITING_MAX: usize = 10;
/// How long a spawn waits to read an unrecorded project's repo and base before it goes on without the check.
const BIND_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
/// How long a spawn waits for a node to say what its writers changed; one that hasn't by then is "changes unknown".
const OBSERVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const ALSO_WRITING_PATHS: usize = 5;
const LIVE_TASKS: [TaskState; 3] = [TaskState::Queued, TaskState::Running, TaskState::Idle];
const SCAN_LIMIT: usize = 10_000;

/// What leads read from tasks: digest lines, live tasks and cancels for removed projects (leads' TasksHook, set in
/// `wire`).
impl Tasks {
    /// Where each of the machine's projects last started a worktree, for the doctor.
    pub fn latest_bases(&self, machine_id: &str) -> Vec<(ProjectRef, WorktreeBase)> {
        self.db(|c| TaskRecords::latest_bases(c, machine_id))
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "tasks: worktree bases not read");
                Vec::new()
            })
    }

    /// A line per task; the agents line is `agents`, at the top of the state block.
    pub fn digest_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
        limit: usize,
    ) -> Vec<String> {
        let since = since.map(Timestamp::as_str);
        match self.db(|c| TaskRecords::for_digest(c, project_ref, since, limit)) {
            Ok(tasks) => render::task_digest_lines(&tasks, since, &self.now_iso()),
            Err(error) => {
                tracing::warn!(%error, "tasks: digest lines not read");
                Vec::new()
            }
        }
    }

    /// A task waiting for a slot, as its spawn answers: "queued: Max agents: 12 of 12 running, starts when a slot
    /// frees, position 3".
    pub fn queued_next(&self, task: &Task) -> Option<String> {
        if task.state != TaskState::Queued {
            return None;
        }
        let position = self.d.slots.position(task.task_id.as_str())?;
        let why = task.queued_reason.as_ref()?.as_str();
        Some(format!(
            "queued: {why}, starts when a slot frees, position {position}. fleetd starts it by itself; don't spawn it again."
        ))
    }

    /// The project's other writers that have started, with the first files each changed so far, for a writer's
    /// spawn result: the lead plans slices that don't overlap, and this lets it check. Writers share the repo; a
    /// real overlap costs one of them a rebase, which the train sends back to it. A writer whose changes the spawn
    /// already gathered (`observed`) isn't asked again.
    pub async fn also_writing(&self, task: &Task, observed: &Observed) -> Option<String> {
        if task.kind != TaskKind::Write {
            return None;
        }
        let others: Vec<Task> = [TaskState::Running, TaskState::Idle]
            .into_iter()
            .flat_map(|state| {
                self.list(&TaskFilter {
                    project_ref: Some(task.project_ref.clone()),
                    state: Some(state),
                    workstream_id: None,
                    limit: ALSO_WRITING_MAX,
                })
                .unwrap_or_default()
            })
            .filter(|t| t.kind == TaskKind::Write && t.task_id != task.task_id)
            .take(ALSO_WRITING_MAX)
            .collect();
        if others.is_empty() {
            return None;
        }
        // `None`: its node didn't say, or not within `OBSERVE_TIMEOUT`.
        let changes = futures_util::future::join_all(others.iter().map(|t| async {
            if let Some(paths) = observed.paths.get(&t.task_id) {
                return Some(paths.clone());
            }
            if observed.unknown.contains(&t.task_id) {
                return None;
            }
            match &t.thread_ref {
                Some(thread) => tokio::time::timeout(OBSERVE_TIMEOUT, self.d.ports.changes(thread))
                    .await
                    .ok()
                    .flatten()
                    .map(|c| c.paths),
                None => Some(Vec::new()),
            }
        }))
        .await;
        let lines: Vec<String> = others
            .iter()
            .zip(changes)
            .map(|(t, paths)| {
                let paths = match paths {
                    None => "changes unknown".to_owned(),
                    Some(p) if p.is_empty() => "no changes yet".to_owned(),
                    Some(p) if p.len() > ALSO_WRITING_PATHS => format!(
                        "{}, +{} more",
                        p[..ALSO_WRITING_PATHS].join(", "),
                        p.len() - ALSO_WRITING_PATHS
                    ),
                    Some(p) => p.join(", "),
                };
                format!("{} {} ({paths})", t.task_id.as_str(), t.title.as_str())
            })
            .collect();
        Some(format!("also writing: {}", lines.join("; ")))
    }

    /// The project's agents against its max agents, from the slot board: the lead's own turns are not agents.
    pub fn agents(&self, project_ref: &ProjectRef) -> crate::hub::leads::events::AgentsLine {
        let agents = self.d.slots.agents(project_ref);
        crate::hub::leads::events::AgentsLine {
            running: agents.running,
            cap: agents.max_agents,
            queued: agents.queued,
        }
    }

    pub fn live(&self, project_ref: Option<&ProjectRef>) -> Vec<(TaskId, ProjectRef)> {
        let mut out = Vec::new();
        for state in LIVE_TASKS {
            let filter = TaskFilter {
                project_ref: project_ref.cloned(),
                state: Some(state),
                workstream_id: None,
                limit: SCAN_LIMIT,
            };
            for task in self.list(&filter).unwrap_or_default() {
                out.push((task.task_id, task.project_ref));
            }
        }
        out
    }

    /// `Tasks.cancel({projectRef, by: "hub"}, taskId, reason)` for a removed project, errors ignored.
    pub async fn cancel_for_removal(
        self: &Arc<Self>,
        project_ref: &ProjectRef,
        task_id: &TaskId,
        reason: &str,
    ) {
        let caller = TaskCaller {
            project_ref: project_ref.clone(),
            by: "hub".to_owned(),
        };
        let _ = self.cancel(&caller, task_id, Some(reason)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use fleetd_contracts::ids::{MachineId, ProjectId, ThreadId};
    use fleetd_contracts::lead_calls::TaskResultFrame;
    use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult, TaskSpawnCall};
    use fleetd_contracts::ledger::{Brief, Workstream};
    use fleetd_contracts::sessions::BaseErrorKind;
    use serde_json::json;

    use super::*;
    use crate::hub::policy::PolicySource;
    use crate::hub::store::test_clock::ManualClock;
    use crate::hub::tasks::ports::{BoxFut, CmdOutput, ThreadChanges};

    const AT: &str = "2026-10-19T10:00:00.000Z";

    /// A linked node that launches every thread and reports `docs/<thread>.md` as each one's change so far. `offline`
    /// unlinks it; `policy` is the project's policy file.
    #[derive(Default)]
    struct Node {
        launched: Mutex<Vec<Option<String>>>,
        offline: std::sync::atomic::AtomicBool,
        policy: Mutex<Option<String>>,
        /// Where each writer's worktree starts, as the node reports it.
        base: Mutex<Option<WorktreeBase>>,
        /// The project's recorded repo and base; `work_bind` records one, counting its reads in `binds`. With
        /// `bind_hangs`, a read waits for `bind_gate`, like a remote that doesn't answer.
        scope: Arc<Mutex<Option<WorkScope>>>,
        binds: Arc<std::sync::atomic::AtomicUsize>,
        bind_hangs: std::sync::atomic::AtomicBool,
        bind_gate: Arc<tokio::sync::Notify>,
    }

    impl Node {
        fn offline(&self) -> bool {
            self.offline.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl TaskPorts for Node {
        fn is_connected(&self, _: &MachineId) -> bool {
            !self.offline()
        }
        fn await_live<'a>(&'a self, _: &'a MachineId) -> BoxFut<'a, ()> {
            // The test runs the queue itself once it brings the node back.
            Box::pin(std::future::pending())
        }
        fn launch<'a>(
            &'a self,
            _: &'a MachineId,
            request: LaunchRequest,
        ) -> BoxFut<'a, Result<(ThreadId, Option<WorktreeBase>), PortError>> {
            let base = request
                .worktree
                .as_ref()
                .and_then(|_| self.base.lock().unwrap().clone());
            let mut launched = self.launched.lock().unwrap();
            launched.push(request.worktree.map(|w| w.branch));
            let id = ThreadId::unchecked(format!("t{}", launched.len()));
            Box::pin(async move { Ok((id, base)) })
        }
        fn send<'a>(
            &'a self,
            _: &'a ThreadRef,
            _: &'a str,
            _: &'a str,
        ) -> BoxFut<'a, Result<(), PortError>> {
            Box::pin(async { Ok(()) })
        }
        fn started_run(&self, _: &ThreadRef) -> Option<String> {
            None
        }
        fn stop<'a>(&'a self, _: &'a ThreadRef) -> BoxFut<'a, Result<(), PortError>> {
            Box::pin(async { Ok(()) })
        }
        fn remove_worktree<'a>(&'a self, _: &'a ThreadRef) -> BoxFut<'a, Result<(), PortError>> {
            Box::pin(async { Ok(()) })
        }
        fn paused(&self, _: &MachineId) -> Option<String> {
            None
        }
        fn action_texts<'a>(
            &'a self,
            _: &'a ThreadRef,
            _: usize,
        ) -> BoxFut<'a, Vec<(String, Option<String>)>> {
            Box::pin(async { Vec::new() })
        }
        fn default_branch<'a>(
            &'a self,
            _: &'a MachineId,
            _: &'a str,
        ) -> BoxFut<'a, Result<String, PortError>> {
            Box::pin(async { Ok("main".to_owned()) })
        }
        fn changes<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Option<ThreadChanges>> {
            let paths = vec![format!("docs/{}.md", thread.thread_id.as_str())];
            Box::pin(async move {
                Some(ThreadChanges {
                    paths,
                    ..Default::default()
                })
            })
        }
        fn pending_question<'a>(&'a self, _: &'a ThreadRef) -> BoxFut<'a, Option<String>> {
            Box::pin(async { None })
        }
        fn run_command<'a>(
            &'a self,
            _: &'a MachineId,
            _: &'a str,
            _: Vec<String>,
            _: u32,
        ) -> BoxFut<'a, Option<CmdOutput>> {
            Box::pin(async { None })
        }
        fn workstream(&self, id: &WorkstreamId) -> Option<Workstream> {
            serde_json::from_value(json!({
                "workstreamId": id, "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "title": "docs",
                "source": { "text": "write docs", "channel": "app", "by": "human", "at": AT },
                "state": "running", "createdAt": AT, "updatedAt": AT,
            }))
            .ok()
        }
        fn medium_allowed(&self, _: &ProjectRef) -> bool {
            true
        }
        fn wake(&self, _: &ProjectRef, _: WakeKind, _: String) {}
        fn done_when_text(&self, _: &Brief) -> String {
            String::new()
        }
        fn work_scope<'a>(
            &'a self,
            _: &'a ProjectRef,
        ) -> BoxFut<'a, Result<Option<WorkScope>, StoreError>> {
            Box::pin(async move { Ok(self.scope.lock().unwrap().clone()) })
        }
        fn work_bind(
            &self,
            _: &ProjectRef,
        ) -> BoxFut<'static, Result<Option<WorkScope>, StoreError>> {
            use std::sync::atomic::Ordering::SeqCst;
            self.binds.fetch_add(1, SeqCst);
            let hangs = self.bind_hangs.load(SeqCst);
            let (scope, gate) = (self.scope.clone(), self.bind_gate.clone());
            Box::pin(async move {
                if hangs {
                    gate.notified().await;
                }
                let bound: WorkScope = serde_json::from_value(
                    json!({ "repoKey": "git.example.com/acme/shop", "base": "main" }),
                )
                .unwrap();
                *scope.lock().unwrap() = Some(bound.clone());
                Ok(Some(bound))
            })
        }
    }

    /// The policy file as the node reads it from the project's checkout: none unless the test writes one.
    impl PolicySource for Node {
        fn read<'a>(
            &'a self,
            project_ref: &'a ProjectRef,
        ) -> BoxFut<'a, Result<Option<String>, TaskError>> {
            let read = if self.offline() {
                Err(PortError::Offline.to_task_error(&project_ref.machine_id))
            } else {
                Ok(self.policy.lock().unwrap().clone())
            };
            Box::pin(async move { read })
        }
    }

    fn tasks() -> (Arc<Tasks>, Arc<Node>) {
        let db = HubDb::open_memory().unwrap();
        let clock = ManualClock::at(1_792_000_000_000);
        let store = Arc::new(HubStore::new(db.clone()));
        let events = Arc::new(EventLog::new(db.clone(), clock.clone()).unwrap());
        store
            .projects_upsert_many(
                &MachineId::unchecked("lab-a"),
                &[serde_json::from_value(json!({
                    "machineId": "lab-a", "projectId": "p1", "title": "storefront", "workspaceRoot": "/work/p1",
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
        let node = Arc::new(Node::default());
        let ports: Arc<dyn TaskPorts> = node.clone();
        let slots = Slots::new(db.clone(), &store, &events).unwrap();
        let policies = Policies::new(node.clone(), clock.clone());
        let tasks = Tasks::new(TaskDeps {
            db,
            store,
            events,
            clock,
            ports,
            slots,
            policies,
        });
        (tasks, node)
    }

    fn writer(title: &str) -> TaskSpawnCall {
        serde_json::from_value(json!({
            "workstreamId": "W1", "title": title, "kind": "write", "prompt": "do it", "serves": "done:0",
        }))
        .unwrap()
    }

    /// No lease or area serializes writers: two in one repo run at once, each on its own branch, and the second
    /// spawn's result names the first and what it has changed, so the lead can see an overlap coming.
    #[tokio::test]
    async fn writers_in_one_repo_run_side_by_side() {
        let (tasks, node) = tasks();
        let caller = TaskCaller {
            project_ref: ProjectRef {
                machine_id: MachineId::unchecked("lab-a"),
                project_id: ProjectId::unchecked("p1"),
            },
            by: "lead".into(),
        };
        let first = tasks
            .spawn(&caller, writer("add the docs page"))
            .await
            .unwrap();
        assert_eq!(
            tasks.also_writing(&first, &Observed::default()).await,
            None,
            "nobody else writes yet"
        );
        let second = tasks.spawn(&caller, writer("fix the api")).await.unwrap();
        assert_eq!(
            (first.state, second.state),
            (TaskState::Running, TaskState::Running)
        );
        assert_eq!(
            *node.launched.lock().unwrap(),
            [
                Some("fleetd/T1-add-the-docs-page".to_owned()),
                Some("fleetd/T2-fix-the-api".to_owned())
            ]
        );
        assert_eq!(
            tasks
                .also_writing(&second, &Observed::default())
                .await
                .as_deref(),
            Some("also writing: T1 add the docs page (docs/t1.md)")
        );

        let reader: TaskSpawnCall = serde_json::from_value(json!({
            "workstreamId": "W1", "title": "read the logs", "kind": "read", "prompt": "do it",
        }))
        .unwrap();
        let reader = tasks.spawn(&caller, reader).await.unwrap();
        assert_eq!(
            tasks.also_writing(&reader, &Observed::default()).await,
            None,
            "only writers hear of writers"
        );
    }

    /// No policy file is needed, and an offline node doesn't fail the spawn: the task queues "offline". Back
    /// online, its launch reads the file and still refuses a broken one, so no deny rule is ever dropped.
    #[tokio::test]
    async fn a_spawn_while_the_node_is_offline_queues_and_its_launch_still_reads_the_policy() {
        let (tasks, node) = tasks();
        let caller = TaskCaller {
            project_ref: ProjectRef {
                machine_id: MachineId::unchecked("lab-a"),
                project_id: ProjectId::unchecked("p1"),
            },
            by: "lead".into(),
        };
        let first = tasks
            .spawn(&caller, writer("no policy file"))
            .await
            .unwrap();
        assert_eq!(first.state, TaskState::Running);

        node.offline
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let queued = tasks.spawn(&caller, writer("while offline")).await.unwrap();
        assert_eq!(queued.state, TaskState::Queued);
        assert_eq!(
            queued.queued_reason.as_ref().map(|r| r.as_str()),
            Some("machine lab-a is offline")
        );

        *node.policy.lock().unwrap() = Some("tools:\n  deny: Bash\n".into());
        tasks.d.policies.invalidate(&caller.project_ref);
        node.offline
            .store(false, std::sync::atomic::Ordering::SeqCst);
        {
            let _guard = tasks.lock.lock().await;
            tasks.retry_queue().await;
        }
        let failed = tasks.get(&queued.task_id).unwrap().unwrap();
        assert_eq!(failed.state, TaskState::Failed);
        assert_eq!(
            node.launched.lock().unwrap().len(),
            1,
            "only the first one launched"
        );

        let refused = tasks
            .spawn(&caller, writer("broken file"))
            .await
            .unwrap_err();
        assert_eq!(
            refused.code,
            ErrorCode::Invalid,
            "online, a broken file refuses the spawn"
        );
        // A node lost between the start's check and the launch's read queues the task too.
        let lost = PortError::Offline.to_task_error(&caller.project_ref.machine_id);
        assert!(matches!(StartError::from(lost), StartError::Offline));
    }

    fn lead() -> TaskCaller {
        TaskCaller {
            project_ref: ProjectRef {
                machine_id: MachineId::unchecked("lab-a"),
                project_id: ProjectId::unchecked("p1"),
            },
            by: "lead".into(),
        }
    }

    /// origin/main at abc1234, fetched at `at`; `error` says why it may be behind.
    fn base(at: &str, error: Option<(BaseErrorKind, &str)>) -> WorktreeBase {
        WorktreeBase {
            base_ref: "origin/main".into(),
            sha: "abc1234def5678abc1234def5678abc1234def56".into(),
            fetched_at: Some(Timestamp(at.into())),
            error: error.map(|(kind, message)| fleetd_contracts::sessions::BaseError {
                kind,
                message: message.into(),
            }),
            fork_behind: None,
        }
    }

    async fn spawn_frame(tasks: &Arc<Tasks>, title: &str) -> TaskResultFrame {
        let call = LeadCall::TaskSpawn(writer(title));
        match tools::lead_call(tasks, &lead(), call).await.unwrap() {
            LeadCallResult::TaskSpawn(frame) => frame,
            other => panic!("{other:?}"),
        }
    }

    async fn events_of(tasks: &Tasks, kind: HubEventType) -> Vec<HubEvent> {
        let page = tasks
            .d
            .events
            .wait(WaitInput {
                cursor: Some(0),
                types: Some(vec![kind]),
                machine_id: None,
                timeout_sec: 0,
            })
            .await
            .unwrap();
        page.events
    }

    /// The spawn result, the task, its digest line and `task.started` say where the worktree started. Offline, the
    /// start says "as of" the last fetch and raises nothing: it mends itself.
    #[tokio::test]
    async fn a_writers_base_is_in_its_spawn_result_and_task_line_and_offline_says_as_of() {
        let (tasks, node) = tasks();
        // The hub's clock reads 2026-10-14 17:46.
        let fresh = base("2026-10-14T17:46:00Z", None);
        *node.base.lock().unwrap() = Some(fresh.clone());
        let frame = spawn_frame(&tasks, "add the docs page").await;
        assert_eq!(frame.task.base.as_ref(), Some(&fresh));
        assert_eq!(
            frame.next.as_deref(),
            Some("Its worktree is based on origin/main @abc1234 as of 17:46 UTC.")
        );
        let started = events_of(&tasks, HubEventType::TaskStarted).await;
        assert_eq!(
            started[0].summary.as_str(),
            "T1 started (high): add the docs page; based on origin/main @abc1234 as of 17:46 UTC"
        );
        assert_eq!(
            tasks.digest_lines(&lead().project_ref, None, 10)[0],
            "- T1 running (write, high): add the docs page [fleetd/T1-add-the-docs-page, based on origin/main \
             @abc1234 as of 17:46 UTC]"
        );

        *node.base.lock().unwrap() = Some(base(
            "2026-10-13T18:02:00Z",
            Some((BaseErrorKind::Offline, "offline")),
        ));
        let frame = spawn_frame(&tasks, "fix the api").await;
        let next = frame.next.unwrap();
        assert!(
            next.starts_with(
                "Its worktree is based on origin/main @abc1234 as of 10-13 18:02 UTC (fetch failed: offline). "
            ),
            "{next}"
        );
        assert!(
            events_of(&tasks, HubEventType::ProjectFetchFailed)
                .await
                .is_empty()
        );
    }

    /// git refusing the credentials raises one attention item for the project, with the fix, however many writers
    /// start meanwhile; once a fetch works again, the next refusal raises another.
    #[tokio::test]
    async fn an_auth_failure_raises_exactly_one_attention_item() {
        let (tasks, node) = tasks();
        let refused = base(
            "2026-10-14T09:00:00Z",
            Some((
                BaseErrorKind::Auth,
                "fatal: Authentication failed for 'https://github.com/acme/shop.git/'",
            )),
        );
        *node.base.lock().unwrap() = Some(refused.clone());
        for title in ["one", "two", "three"] {
            spawn_frame(&tasks, title).await;
        }
        let raised = events_of(&tasks, HubEventType::ProjectFetchFailed).await;
        assert_eq!(raised.len(), 1);
        let item = &raised[0];
        assert_eq!(item.attention, Some(Attention::Loud));
        assert_eq!(item.project_id.as_ref().map(|p| p.as_str()), Some("p1"));
        let data: FetchFailedData = serde_json::from_value(item.data.clone().unwrap()).unwrap();
        assert_eq!(
            data.message,
            "git can't fetch origin for storefront: fatal: Authentication failed for \
             'https://github.com/acme/shop.git/'. Fix: `gh auth login` or your SSH key. Agents start from origin/main \
             @abc1234 as of 09:00 UTC; their pushes will fail the same way."
        );
        assert_eq!(data.fix.as_deref(), Some("gh auth login"));
        assert_eq!(data.task_id.as_str(), "T1");
        // The doctor reads the same base.
        let bases = tasks.latest_bases("lab-a");
        assert_eq!(bases.len(), 1);
        assert_eq!(bases[0].1, refused);

        *node.base.lock().unwrap() = Some(base("2026-10-14T17:00:00Z", None));
        spawn_frame(&tasks, "four").await;
        *node.base.lock().unwrap() = Some(refused);
        spawn_frame(&tasks, "five").await;
        assert_eq!(
            events_of(&tasks, HubEventType::ProjectFetchFailed)
                .await
                .len(),
            2
        );
    }

    /// With no remote, the spawn says it starts from the local branch and raises nothing; a remote that says there is
    /// no such repository raises the item, with what to check.
    #[tokio::test]
    async fn no_remote_reads_plainly_and_a_missing_repository_raises_the_item() {
        let (tasks, node) = tasks();
        let mut local = base(
            "2026-10-14T17:46:00Z",
            Some((BaseErrorKind::NoRemote, "no remote")),
        );
        (local.base_ref, local.fetched_at) = ("main".into(), None);
        *node.base.lock().unwrap() = Some(local);
        let frame = spawn_frame(&tasks, "one").await;
        assert_eq!(
            frame.next.as_deref(),
            Some("Its worktree is based on local main @abc1234 (no remote).")
        );
        assert!(
            events_of(&tasks, HubEventType::ProjectFetchFailed)
                .await
                .is_empty()
        );

        *node.base.lock().unwrap() = Some(base(
            "2026-10-14T09:00:00Z",
            Some((BaseErrorKind::NoAccess, "ERROR: Repository not found.")),
        ));
        spawn_frame(&tasks, "two").await;
        let raised = events_of(&tasks, HubEventType::ProjectFetchFailed).await;
        assert_eq!(raised.len(), 1);
        let data: FetchFailedData =
            serde_json::from_value(raised[0].data.clone().unwrap()).unwrap();
        assert_eq!(
            data.message,
            "git can't fetch origin for storefront: ERROR: Repository not found. Fix: check the remote's URL (`git \
             remote get-url origin`), the repo's name, and that your key or login can see it. Agents start from \
             origin/main @abc1234 as of 09:00 UTC."
        );
    }

    /// A remote that names no default branch says so in the spawn result and raises the attention item.
    #[tokio::test]
    async fn a_remote_with_no_default_branch_says_so() {
        let (tasks, node) = tasks();
        let mut headless = base(
            "2026-10-14T17:46:00Z",
            Some((
                BaseErrorKind::NoDefaultBranch,
                "origin names no default branch: its HEAD points at a branch it doesn't have",
            )),
        );
        headless.base_ref = "origin/feature".into();
        *node.base.lock().unwrap() = Some(headless);
        let frame = spawn_frame(&tasks, "one").await;
        assert_eq!(
            frame.next.as_deref(),
            Some(
                "Its worktree is based on origin/feature @abc1234 as of 17:46 UTC (origin names no default branch: \
                 its HEAD points at a branch it doesn't have)."
            )
        );
        let raised = events_of(&tasks, HubEventType::ProjectFetchFailed).await;
        assert_eq!(raised.len(), 1);
        assert!(
            raised[0].summary.as_str().starts_with(
                "origin names no default branch: its HEAD points at a branch it doesn't have, so \
                              storefront has no default branch to start from."
            ),
            "{}",
            raised[0].summary.as_str()
        );
    }

    /// The first spawn in a project with no repo recorded waits at most `BIND_WAIT` on a remote that hangs: it goes on
    /// unchecked, saying so, while the read finishes in the background. A spawn meanwhile starts no second read, and
    /// the next spawn after it is checked.
    #[tokio::test(start_paused = true)]
    async fn a_hanging_remote_never_holds_up_a_spawn() {
        use std::sync::atomic::Ordering::SeqCst;
        let (tasks, node) = tasks();
        node.bind_hangs.store(true, SeqCst);
        let caller = TaskCaller {
            project_ref: ProjectRef {
                machine_id: MachineId::unchecked("lab-a"),
                project_id: ProjectId::unchecked("p1"),
            },
            by: "lead".into(),
        };
        let started = tokio::time::Instant::now();
        let first = tasks
            .spawn_noted(&caller, writer("add the docs page"))
            .await
            .unwrap();
        assert!(started.elapsed() <= BIND_WAIT + std::time::Duration::from_millis(100));
        assert_eq!(first.note.as_deref(), Some(duplicates::BINDING));
        let second = tasks
            .spawn_noted(&caller, writer("fix the api"))
            .await
            .unwrap();
        assert_eq!(second.note.as_deref(), Some(duplicates::BINDING));
        assert_eq!(node.binds.load(SeqCst), 1, "one read at a time");

        node.bind_gate.notify_one();
        while !tasks.binding.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        let third = tasks
            .spawn_noted(&caller, writer("tidy the readme"))
            .await
            .unwrap();
        assert_eq!(
            third.note, None,
            "checked, against the scope read in the background"
        );
        assert_eq!(node.binds.load(SeqCst), 1);
    }

    /// `also writing` uses the changed paths the spawn's check gathered, and asks only nodes it didn't.
    #[tokio::test]
    async fn also_writing_reuses_what_the_check_gathered() {
        let (tasks, _node) = tasks();
        let caller = TaskCaller {
            project_ref: ProjectRef {
                machine_id: MachineId::unchecked("lab-a"),
                project_id: ProjectId::unchecked("p1"),
            },
            by: "lead".into(),
        };
        let first = tasks
            .spawn(&caller, writer("add the docs page"))
            .await
            .unwrap();
        let second = tasks.spawn(&caller, writer("fix the api")).await.unwrap();
        let third = tasks
            .spawn(&caller, writer("tidy the readme"))
            .await
            .unwrap();
        let mut observed = Observed::default();
        observed
            .paths
            .insert(first.task_id.clone(), vec!["app/api.ts".to_owned()]);
        observed.unknown.insert(second.task_id.clone());
        assert_eq!(
            tasks.also_writing(&third, &observed).await.as_deref(),
            Some(
                "also writing: T2 fix the api (changes unknown); T1 add the docs page (app/api.ts)"
            )
        );
    }
}
