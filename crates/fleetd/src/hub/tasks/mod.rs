//! fleetd-owned tasks: every subagent a lead runs. Spawn resolves model and effort, takes leases (writers) and a
//! slot or queues with the reason, and launches a thread (writers in a new worktree on `<branchPrefix><taskId>-<slug>`,
//! `fleetd/` by default).
//! The thread's status transitions, read off the event log, end the task: the result goes into the record and,
//! inline, into one lead wake; the slot and leases are released and the queue is tried again.
pub mod branch_diff;
pub mod cap;
#[cfg(test)]
mod cap_tests;
pub mod glob;
#[cfg(test)]
mod guard_tests;
pub mod hooks;
pub mod policy;
pub mod ports;
pub mod records;
pub mod render;
pub mod resolve;
pub mod tools;
pub mod wire;

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};

use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::lead_calls::TaskSpawnCall;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::prim::{Int, Text};
use fleetd_contracts::tasks::{
    AreaName, PolicyFile, PrUrl, Task, TaskId, TaskKind, TaskResult, TaskResultStatus, TaskState,
};
use serde_json::{Map, Value, json};

use crate::clock::Clock;
use crate::hub::api::Shutdown;
use crate::hub::leases::{Leases, Policies, parse_iso_ms};
use crate::hub::slots::{SlotRequest, Slots, priority_of};
use crate::hub::store::{
    EventLog, HubDb, HubStore, NewEvent, StoreError, WaitInput, iso_ms, now_ms,
};
use fleetd_contracts::mcp::ErrorCode;
use hooks::{ResultReceipts, SpawnCheck, UsageGate};
use ports::{LaunchRequest, PortError, TaskError, TaskPorts, WakeKind, Worktree};
use render::{branch_for, find_pr_url, render_task_prompt, tail_of};
use resolve::{ModelEffort, resolve_model_effort};

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
    pub leases: Arc<Leases>,
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

const OUT_OF_AREA_MAX: usize = 20;
const CLOSED_STATES: [&str; 3] = ["done", "stopped", "failed"];

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
    let created = parse_iso_ms(task.created_at.as_str())
        .map_or_else(|| "NaN".to_owned(), |ms| ms.to_string());
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

fn area_globs(policy: &PolicyFile, areas: &[String]) -> Vec<(String, Vec<String>)> {
    areas
        .iter()
        .map(|a| {
            let globs = policy
                .areas
                .get(a)
                .map(|g| g.iter().map(|x| x.as_str().to_owned()).collect())
                .unwrap_or_default();
            (a.clone(), globs)
        })
        .collect()
}

fn area_names(task: &Task) -> Vec<String> {
    task.areas.iter().map(|a| a.as_str().to_owned()).collect()
}

fn queued_reason(reason: &str) -> Text<1, 200> {
    Text::unchecked(js_prefix(reason, 200))
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
    /// Set once in `hub/serve` (`wire::wire`) to usage, the value bar and receipts; unset passes through.
    pub hooks: TaskHooks,
    cursor: i64,
    /// The last thread event applied, by the follower or by a retry catching up (read and written under `lock`).
    applied: std::sync::atomic::AtomicI64,
}

#[derive(Default)]
pub struct TaskHooks {
    pub usage: OnceLock<Arc<dyn UsageGate>>,
    pub spawn_check: OnceLock<Arc<dyn SpawnCheck>>,
    pub receipts: OnceLock<Arc<dyn ResultReceipts>>,
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

    fn now_iso(&self) -> String {
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
        self.d.slots.release(task.task_id.as_str())?;
        self.d.leases.release(&task.task_id)?;
        Ok(())
    }

    fn wake_result(&self, task: &Task, result: &TaskResult) {
        let receipts = self.hooks.receipts.get().and_then(|r| r.line(result));
        let text = render::task_result_lines(
            task.task_id.as_str(),
            task.title.as_str(),
            result,
            receipts.as_deref(),
        );
        self.d
            .ports
            .wake(&task.project_ref, WakeKind::TaskResult, text);
    }

    fn workstream(&self, id: &WorkstreamId) -> Option<fleetd_contracts::ledger::Workstream> {
        self.d.ports.workstream(id)
    }

    /// A research order whose budget is spent gets no more agent turns.
    fn budget_check(&self, ws: &fleetd_contracts::ledger::Workstream) -> Result<(), TaskError> {
        let now = crate::hub::store::now_ms(self.d.clock.as_ref());
        let refused = self
            .d
            .db
            .with(|c| Ok(crate::hub::playbooks::budget::refusal(c, ws, now)?))
            .map_err(store_error)?;
        match refused {
            Some(why) => Err(lead_error(
                ErrorCode::Invalid,
                why,
                Some(crate::hub::playbooks::budget::FIX),
            )),
            None => Ok(()),
        }
    }

    /// `kind` says what it waits for (`lease`, `offline`, `usage`, `slot`) for the time inspector's queue spans.
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

    async fn launch(&self, task: &Task) -> Result<(ThreadRef, Option<String>), StartError> {
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
        let globs = area_globs(&policy, &area_names(task));
        let set = self.d.db.prompts().current(Some(r));
        let prompt = render_task_prompt(
            &set,
            &render::PromptInput {
                task,
                project_title: &project.title,
                brief: brief.as_ref(),
                done_when: brief.as_ref().map(|b| self.d.ports.done_when_text(b)),
                area_globs: &globs,
                branch: branch.as_deref(),
                base_branch: base_branch.as_deref(),
            },
        );
        let request = LaunchRequest {
            project_id: r.project_id.clone(),
            prompt: prompt.clone(),
            model: task.model.as_str().to_owned(),
            effort: task.effort,
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
        let thread_id = self.d.ports.launch(&r.machine_id, request).await?;
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
            receipts: None,
            claims_unverified: None,
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

    /// Leases, then a slot, then the launch or the pending message. Queues with the first reason it cannot go.
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

    /// The project's areas whose globs cover the whole repo (`all`); just `all` when the policy can't be read.
    async fn whole_areas(&self, r: &ProjectRef) -> Vec<AreaName> {
        match self.d.policies.get(r).await {
            Ok(policy) => policy
                .areas
                .iter()
                .filter(|(_, globs)| {
                    globs.iter().any(|g| {
                        matches!(glob::GlobMatcher::new(g.as_str()), glob::GlobMatcher::All)
                    })
                })
                .map(|(name, _)| AreaName::unchecked(name.as_str()))
                .collect(),
            Err(_) => vec![AreaName::unchecked("all")],
        }
    }

    async fn try_start_inner(
        self: &Arc<Self>,
        stored: &StoredTask,
        from_queue: bool,
    ) -> Result<Task, StoreError> {
        let task = &stored.task;
        let r = &task.project_ref;
        if task.kind == TaskKind::Write
            && let crate::hub::slots::Grant::Queued(reason) =
                self.d
                    .leases
                    .acquire(r, &task.task_id, &task.areas, &self.whole_areas(r).await)?
        {
            return self.queue(stored, "lease", &reason);
        }
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
            sent.map(|_| (thread.clone(), None))
                .map_err(StartError::from)
        } else {
            self.launch(task).await
        };
        let (thread_ref, branch) = match started {
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
        next.state = TaskState::Running;
        next.started_at = Some(task.started_at.clone().unwrap_or(Timestamp(at)));
        // From here the board holds the slot while the thread runs and frees it whenever it stops.
        self.d.slots.bind(task.task_id.as_str(), &thread_ref)?;
        self.put(&StoredTask {
            task: next.clone(),
            pending_message: None,
        })?;
        let summary = if continuing {
            format!(
                "{} continued (attempt {}): {}",
                task.task_id.as_str(),
                task.attempt.get(),
                task.title.as_str()
            )
        } else {
            format!(
                "{} started ({}/{}): {}",
                task.task_id.as_str(),
                task.model.as_str(),
                render::effort_str(task.effort),
                task.title.as_str()
            )
        };
        self.emit(&next, HubEventType::TaskStarted, summary, Map::new())?;
        Ok(next)
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

    /// The files `branch` changes against the project's base branch, read by the node; `None` if it can't say.
    async fn branch_paths(&self, r: &ProjectRef, branch: &str) -> Option<Vec<String>> {
        let project = self.d.store.project_get(r).ok()??;
        let base = self
            .d
            .ports
            .default_branch(&r.machine_id, &project.workspace_root)
            .await
            .ok()?;
        let argv = branch_diff::branch_diff_argv(&base, branch)?;
        let out = self
            .d
            .ports
            .run_command(
                &r.machine_id,
                &project.workspace_root,
                argv,
                branch_diff::TIMEOUT_SEC as u32,
            )
            .await?;
        branch_diff::parse_branch_diff(out.exit_code.unwrap_or(-1), &out.output_tail)
    }

    async fn finish(
        self: &Arc<Self>,
        stored: &StoredTask,
        status: TaskResultStatus,
    ) -> Result<(), StoreError> {
        let task = &stored.task;
        let thread_ref = task.thread_ref.clone().expect("a live task has a thread");
        let thread = self.d.store.thread_get(&thread_ref)?;
        let text = thread
            .as_ref()
            .map_or("", |t| t.thread.latest_message_tail.as_str())
            .to_owned();
        let error = match (&thread, status) {
            (Some(t), TaskResultStatus::Failed) => t
                .thread
                .last_error
                .as_ref()
                .map(|e| format!("[{}] {}", e.class, e.message))
                .unwrap_or_default(),
            _ => String::new(),
        };
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
        // M6 receipts: what the thread actually ran, counted from its items.
        let result = TaskResult {
            status,
            tail: Text::unchecked(tail_of(&tail, render::TAIL_MAX)),
            branch: branch.clone().map(NonEmpty::unchecked),
            pr_url: pr_url.map(PrUrl::unchecked),
            receipts: None,
            claims_unverified: None,
            at: Timestamp(at.clone()),
        };
        let result = match self.hooks.receipts.get() {
            Some(receipts) => receipts.attach(&thread_ref, result).await,
            None => result,
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

        // The PR's diff when the node can read it; the thread's changed paths (which include whatever a rebase
        // brought in) only when it can't.
        let pr_paths = match (&branch, write) {
            (Some(branch), true) => self.branch_paths(&task.project_ref, branch).await,
            _ => None,
        };
        if pr_paths.is_none() && write {
            tracing::warn!(
                task_id = task.task_id.as_str(),
                "task: branch diff not read; areas checked on the thread's changed paths"
            );
        }
        if let Some(paths) = pr_paths.or_else(|| changes.as_ref().map(|c| c.paths.clone()))
            && let Ok(policy) = self.d.policies.get(&task.project_ref).await
        {
            let globs: Vec<String> = area_globs(&policy, &area_names(task))
                .into_iter()
                .flat_map(|(_, g)| g)
                .collect();
            let outside = glob::outside_globs(&paths, &globs);
            if !outside.is_empty() {
                let n = outside.len();
                let first: Vec<&str> = outside.iter().take(5).map(|s| s.as_str()).collect();
                let mut extra = Map::new();
                extra.insert(
                    "paths".into(),
                    json!(outside.iter().take(OUT_OF_AREA_MAX).collect::<Vec<_>>()),
                );
                self.emit(
                    &next,
                    HubEventType::TaskOutOfArea,
                    format!(
                        "{} changed {n} file{} outside {}: {}",
                        task.task_id.as_str(),
                        if n == 1 { "" } else { "s" },
                        area_names(task).join(", "),
                        first.join(", ")
                    ),
                    extra,
                )?;
            }
        }
        self.release_all(task)?;
        self.wake_result(&next, &result);
        // Last, so whoever waits on it sees the slot, the leases and the wake already settled.
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
        let live = matches!(task.state, TaskState::Running | TaskState::Idle);
        match event.r#type {
            HubEventType::ThreadStarted => {
                // Continued outside `task message`: the watchdog's nudge, or a human writing to the thread.
                if !matches!(
                    task.state,
                    TaskState::Done | TaskState::Failed | TaskState::Idle
                ) {
                    return Ok(());
                }
                if task.kind == TaskKind::Write {
                    let whole = self.whole_areas(&task.project_ref).await;
                    self.d
                        .leases
                        .acquire(&task.project_ref, &task.task_id, &task.areas, &whole)?;
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
                // The board frees the slot itself and takes it again if the run resumes; the leases stay.
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
                self.finish(&stored, TaskResultStatus::Done).await?
            }
            HubEventType::ThreadUsageLimited => {
                // M4 usage: parked, not failed. The board freed the slot, the leases stay, and the usage layer sends
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
                self.finish(&stored, TaskResultStatus::Failed).await?
            }
            _ => {}
        }
        Ok(())
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
                Some("Call `list_agents`."),
            )),
        }
    }

    /// The task as stored: running, queued with its reason, or failed if the node refused the launch.
    pub async fn spawn(
        self: &Arc<Self>,
        caller: &TaskCaller,
        input: SpawnInput,
    ) -> Result<Task, TaskError> {
        let r = &caller.project_ref;
        // M6 value bar: serves, done workstreams and review rounds. Outside the lock, since it may ask GitHub for a
        // PR head, and before the closed-state check, so a done workstream gets its own refusal.
        if let Some(check) = self.hooks.spawn_check.get()
            && let Some(ws) = self
                .workstream(&input.workstream_id)
                .filter(|w| same_project(&w.project_ref, r))
        {
            check.check_spawn(caller, &input, &ws).await?;
        }
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
        let ws_state = state_name(&ws.state);
        if CLOSED_STATES.contains(&ws_state.as_str()) {
            return Err(lead_error(
                ErrorCode::Invalid,
                format!(
                    "Workstream {} is {ws_state}; tasks run only for open workstreams.",
                    input.workstream_id.as_str()
                ),
                None,
            ));
        }
        self.budget_check(&ws)?;
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
        let policy = self.d.policies.get(r).await?;
        let unknown: Vec<&str> = input
            .areas
            .iter()
            .map(|a| a.as_str())
            .filter(|a| !policy.areas.contains_key(*a))
            .collect();
        if !unknown.is_empty() {
            let known: Vec<&str> = policy.areas.keys().map(String::as_str).collect();
            return Err(lead_error(
                ErrorCode::Invalid,
                format!(
                    "Unknown area{} {}.",
                    if unknown.len() == 1 { "" } else { "s" },
                    unknown.join(", ")
                ),
                Some(&format!(
                    "Use the project's areas (.fleetd/policy.yaml, else inferred from the repo): {}.",
                    known.join(", ")
                )),
            ));
        }
        let flag = ModelEffort {
            model: input.model.as_ref().map(|m| m.as_str().to_owned()),
            effort: input.effort,
        };
        let defaults = policy.defaults.as_ref().map(|d| ModelEffort {
            model: d.model.as_ref().map(|m| m.as_str().to_owned()),
            effort: d.effort,
        });
        let settings = self.d.ports.lead_settings(r);
        let (model, effort) = resolve_model_effort(&flag, defaults.as_ref(), settings.as_ref());
        let task = Task {
            task_id: TaskId::unchecked("T0"),
            project_ref: r.clone(),
            workstream_id: input.workstream_id.clone(),
            title: input.title.clone(),
            kind: input.kind,
            prompt: input.prompt.clone(),
            areas: input.areas.clone(),
            model: NonEmpty::unchecked(model),
            effort,
            tier: input.tier,
            estimate_minutes: input.estimate_minutes,
            serves: input.serves.clone(),
            qa: input.qa,
            pr: input.pr.clone(),
            item_id: input.item.clone(),
            state: TaskState::Queued,
            queued_reason: None,
            thread_ref: None,
            branch: None,
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
        Ok(self
            .try_start(
                StoredTask {
                    task,
                    pending_message: None,
                },
                false,
            )
            .await)
    }

    /// Steers a running task; continues an ended one in the same thread, which re-takes its slot and leases.
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
        if let Some(ws) = self.workstream(&task.workstream_id) {
            self.budget_check(&ws)?;
        }
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

    /// Interrupts a running task and releases its slot and leases.
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
        // The slot and leases go only once the agent's claude has exited: a cancel the node could not carry out
        // leaves the task as it was, still holding them, and says so. Under the lock, so the thread's own end
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
                format!(
                    "{id} could not be stopped ({why}); it keeps running and keeps its slot and leases."
                ),
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
            receipts: None,
            claims_unverified: None,
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

const LIVE_TASKS: [TaskState; 3] = [TaskState::Queued, TaskState::Running, TaskState::Idle];
const SCAN_LIMIT: usize = 10_000;

/// What leads read from tasks: digest lines, live tasks and cancels for removed projects (leads' TasksHook, set in
/// `wire`).
impl Tasks {
    /// A line per task; the agents line is `agents`, at the top of the state block.
    pub fn digest_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
        limit: usize,
    ) -> Vec<String> {
        let since = since.map(Timestamp::as_str);
        match self.db(|c| TaskRecords::for_digest(c, project_ref, since, limit)) {
            Ok(tasks) => render::task_digest_lines(&tasks, since),
            Err(error) => {
                tracing::warn!(%error, "tasks: digest lines not read");
                Vec::new()
            }
        }
    }

    /// A task waiting for a slot, as its spawn answers: "queued: 12/12 running, starts when a slot frees, position 3".
    pub fn queued_next(&self, task: &Task) -> Option<String> {
        if task.state != TaskState::Queued {
            return None;
        }
        let position = self.d.slots.position(task.task_id.as_str())?;
        let reason = task.queued_reason.as_ref()?.as_str();
        let why = reason
            .strip_prefix("agents: ")
            .or_else(|| reason.strip_prefix("slots: "))
            .unwrap_or(reason);
        Some(format!(
            "queued: {why}, starts when a slot frees, position {position}. fleetd starts it by itself; don't spawn it again."
        ))
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
