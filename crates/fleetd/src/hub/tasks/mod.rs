//! fleetd-owned tasks: every subagent a lead runs. Spawn resolves model and effort, takes leases (writers) and a
//! slot or queues with the reason, and launches a T3 thread (writers in a new worktree on `fleetd/<taskId>-<slug>`).
//! The thread's status transitions, read off the event log, end the task: the result goes into the record and,
//! inline, into one lead wake; the slot and leases are released and the queue is tried again.
//! TS spec: apps/hub/src/tasks/Tasks.ts.
pub mod branch_diff;
pub mod glob;
pub mod hooks;
pub mod records;
pub mod render;
pub mod resolve;
pub mod tools;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use fleetd_contracts::prim::{Int, Text};
use fleetd_contracts::{
    HubEvent, HubEventType, MachineId, NonEmpty, PolicyFile, PrUrl, ProjectRef, Task, TaskId, TaskKind, TaskResult, TaskResultStatus,
    TaskSpawnCall, TaskState, ThreadRef, Timestamp, WorkstreamId,
};
use serde_json::{Map, Value, json};

use crate::clock::Clock;
use crate::hub::executor::{ExecutorError, Executors, LaunchOptions};
use crate::hub::leads::LeadError;
use crate::hub::leases::{Leases, Policies, parse_iso_ms};
use crate::hub::link::NodeCommands;
use crate::hub::link::commands::CommandInput;
use crate::hub::slots::{SlotRequest, Slots, priority_of};
use crate::hub::store::{EventLog, HubDb, HubStore, NewEvent, StoreError, WaitInput, iso_ms, now_ms};
use hooks::{ResultReceipts, SpawnCheck, TaskLeads, TaskWake, UsageGate};
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
    pub executors: Arc<Executors>,
    pub commands: Arc<NodeCommands>,
    pub slots: Arc<Slots>,
    pub leases: Arc<Leases>,
    pub policies: Arc<Policies>,
    pub leads: Arc<dyn TaskLeads>,
    pub usage: Arc<dyn UsageGate>,
    pub spawn_check: Arc<dyn SpawnCheck>,
    pub receipts: Arc<dyn ResultReceipts>,
}

const THREAD_EVENTS: [HubEventType; 7] = [
    HubEventType::ThreadStarted,
    HubEventType::ThreadWaiting,
    HubEventType::ThreadCompleted,
    HubEventType::ThreadFailed,
    HubEventType::ThreadInterrupted,
    HubEventType::ThreadUsageLimited,
    // M4 usage: a lifted pause lets queued tasks start.
    HubEventType::UsageResumed,
];

const OUT_OF_AREA_MAX: usize = 20;
const CLOSED_STATES: [&str; 3] = ["done", "stopped", "failed"];

fn same_project(a: &ProjectRef, b: &ProjectRef) -> bool {
    a.machine_id == b.machine_id && a.project_id == b.project_id
}

fn lead_error(code: &str, message: impl Into<String>, fix: Option<&str>) -> LeadError {
    LeadError::new(code, message, fix.map(str::to_owned))
}

/// Store failures are defects in TS (Effect.sync throwing); here they refuse the call plainly and are logged.
fn store_error(error: StoreError) -> LeadError {
    tracing::error!(%error, "tasks: store failed");
    lead_error("t3_error", "The hub failed to answer that request.", Some("Retry; if it keeps failing, check the hub's log."))
}

/// TS leads/LeadError.ts `fromExecutor`.
fn from_executor(error: &ExecutorError) -> LeadError {
    match error {
        ExecutorError::MachineNotConnected { machine_id } => lead_error(
            "machine_offline",
            format!("Machine {} has no live T3 connection.", machine_id.as_str()),
            Some("Wait for the machine to come back online (fleetd_status shows it), then retry."),
        ),
        other => lead_error("t3_error", other.to_string(), Some("Retry; if it keeps failing, check the machine's T3 with fleetd_status.")),
    }
}

/// Why a launch or continuation did not go out: the machine went offline (the task queues), or anything else
/// (the task fails to start with this message).
enum StartError {
    Offline,
    Other(String),
}

impl From<ExecutorError> for StartError {
    fn from(error: ExecutorError) -> Self {
        match error {
            ExecutorError::MachineNotConnected { .. } => Self::Offline,
            other => Self::Other(other.to_string()),
        }
    }
}

impl From<LeadError> for StartError {
    fn from(error: LeadError) -> Self {
        Self::Other(error.message)
    }
}

impl From<StoreError> for StartError {
    fn from(error: StoreError) -> Self {
        Self::Other(error.to_string())
    }
}

/// A T3 command id for one of the task's writes. T3 keeps a receipt per id forever, so the id carries the task's
/// creation time: a hub on a fresh database numbers tasks from T1 again and must not get an earlier hub's thread.
fn request_id(task: &Task, parts: &[&str]) -> String {
    let created = parse_iso_ms(task.created_at.as_str()).map_or_else(|| "NaN".to_owned(), |ms| ms.to_string());
    let mut all = vec!["fleetd-task".to_owned(), task.task_id.as_str().to_owned(), created];
    all.extend(parts.iter().map(|p| (*p).to_owned()));
    all.join(":")
}

fn random_uuid() -> String {
    let b: [u8; 16] = rand::random();
    let h = |r: std::ops::Range<usize>| b[r].iter().map(|x| format!("{x:02x}")).collect::<String>();
    format!("{}-{}-4{}-{:x}{}-{}", h(0..4), h(4..6), &h(6..8)[1..], 8 | (b[8] & 3), &h(8..10)[1..], h(10..16))
}

fn js_prefix(s: &str, max: usize) -> String {
    crate::hub::api::clip(s, max)
}

fn state_name<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

fn area_globs(policy: &PolicyFile, areas: &[String]) -> Vec<(String, Vec<String>)> {
    areas
        .iter()
        .map(|a| {
            let globs = policy.areas.get(a).map(|g| g.iter().map(|x| x.as_str().to_owned()).collect()).unwrap_or_default();
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
}

impl Tasks {
    /// Registers the slot release listener (which also runs once now, picking up tasks queued before a restart)
    /// and follows thread events from the log's head for as long as the hub runs.
    pub fn start(deps: TaskDeps) -> Result<Arc<Self>, StoreError> {
        let tasks = Arc::new(Self { d: deps, lock: tokio::sync::Mutex::new(()), awaiting: Mutex::new(HashSet::new()) });
        let weak = Arc::downgrade(&tasks);
        tasks.d.slots.on_release(Arc::new(move || {
            if let Some(tasks) = weak.upgrade() {
                tasks.retry_later();
            }
        }))?;
        // The cursor is read here, not in the task, so nothing appended before the task first runs is missed.
        let from = tasks.d.events.head();
        let follower = tasks.clone();
        tokio::spawn(async move { follower.follow(from).await });
        Ok(tasks)
    }

    fn now_iso(&self) -> String {
        iso_ms(now_ms(self.d.clock.as_ref()))
    }

    fn db<R>(&self, f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<R>) -> Result<R, StoreError> {
        self.d.db.with(|c| Ok(f(c)?))
    }

    fn put(&self, stored: &StoredTask) -> Result<(), StoreError> {
        self.db(|c| TaskRecords::put(c, stored))
    }

    fn emit(&self, task: &Task, r#type: HubEventType, summary: String, extra: Map<String, Value>) -> Result<(), StoreError> {
        let mut data = Map::new();
        data.insert("taskId".into(), json!(task.task_id));
        data.insert("workstreamId".into(), json!(task.workstream_id));
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
        })?;
        Ok(())
    }

    fn release_all(&self, task: &Task) -> Result<(), StoreError> {
        self.d.slots.release(task.task_id.as_str())?;
        self.d.leases.release(&task.task_id)?;
        Ok(())
    }

    fn wake_result(&self, task: &Task, result: &TaskResult) {
        self.d.leads.wake(
            &task.project_ref,
            TaskWake::Result { task_id: task.task_id.clone(), title: task.title.as_str().to_owned(), result: result.clone() },
        );
    }

    fn queue(&self, stored: &StoredTask, reason: &str) -> Result<Task, StoreError> {
        let task = &stored.task;
        if task.state == TaskState::Queued && task.queued_reason.as_ref().map(|r| r.as_str()) == Some(reason) {
            return Ok(task.clone());
        }
        let mut next = task.clone();
        next.state = TaskState::Queued;
        next.queued_reason = Some(queued_reason(reason));
        self.put(&StoredTask { task: next.clone(), pending_message: stored.pending_message.clone() })?;
        let mut extra = Map::new();
        extra.insert("queuedReason".into(), json!(reason));
        self.emit(&next, HubEventType::TaskQueued, format!("{} queued: {reason}", task.task_id.as_str()), extra)?;
        Ok(next)
    }

    async fn launch(&self, task: &Task) -> Result<(ThreadRef, Option<String>), StartError> {
        let r = &task.project_ref;
        let Some(project) = self.d.store.project_get(r)? else {
            return Err(StartError::Other(format!("No project {} on machine {}.", r.project_id.as_str(), r.machine_id.as_str())));
        };
        let policy = self.d.policies.get(r).await?;
        let brief = self.d.leads.workstream(&task.workstream_id).and_then(|w| w.brief);
        let write = task.kind == TaskKind::Write;
        let base_branch = if write { Some(self.d.executors.default_branch(&r.machine_id, &project.workspace_root).await?) } else { None };
        let branch = write.then(|| branch_for(task.task_id.as_str(), task.title.as_str()));
        let globs = area_globs(&policy, &area_names(task));
        let prompt = render_task_prompt(&render::PromptInput {
            task,
            project_title: &project.title,
            brief: brief.as_ref(),
            area_globs: &globs,
            branch: branch.as_deref(),
            base_branch: base_branch.as_deref(),
        });
        let input = serde_json::from_value(json!({
            "machineId": r.machine_id,
            "projectId": r.project_id,
            "prompt": prompt,
            "model": task.model,
            "effort": task.effort,
            "runtimeMode": "full-access",
            "title": js_prefix(&format!("{}: {}", task.task_id.as_str(), task.title.as_str()), 80),
            // T3 keeps a receipt per command id, so a retried launch returns the same thread.
            "clientRequestId": request_id(task, &[&task.attempt.get().to_string()]),
        }))
        .map_err(|e| StartError::Other(e.to_string()))?;
        let workspace = match (&base_branch, &branch) {
            (Some(base), Some(branch)) => Some(json!({ "type": "worktree", "baseRef": base, "branch": branch })),
            _ => None,
        };
        let thread_id = self.d.executors.launch(&r.machine_id, &input, LaunchOptions { workspace }).await?;
        Ok((ThreadRef { machine_id: r.machine_id.clone(), thread_id }, branch))
    }

    fn fail_to_start(&self, stored: &StoredTask, message: &str, from_queue: bool) -> Result<Task, StoreError> {
        let task = &stored.task;
        let at = self.now_iso();
        let result = TaskResult {
            status: TaskResultStatus::Failed,
            tail: Text::unchecked(tail_of(&format!("fleetd could not start the task: {message}"), render::TAIL_MAX)),
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
        self.put(&StoredTask { task: next.clone(), pending_message: None })?;
        self.release_all(task)?;
        // A direct call gets this in its reply; a task started from the queue has nobody waiting on it.
        if from_queue {
            self.wake_result(&next, &result);
        }
        self.emit(&next, HubEventType::TaskFailed, format!("{} failed to start: {message}", task.task_id.as_str()), Map::new())?;
        Ok(next)
    }

    fn retry_when_live(self: &Arc<Self>, machine_id: &MachineId) {
        if !self.awaiting.lock().unwrap().insert(machine_id.clone()) {
            return;
        }
        let (tasks, machine_id) = (self.clone(), machine_id.clone());
        tokio::spawn(async move {
            tasks.d.executors.await_live(&machine_id).await;
            tasks.awaiting.lock().unwrap().remove(&machine_id);
            let _guard = tasks.lock.lock().await;
            tasks.retry_queue().await;
        });
    }

    fn retry_later(self: &Arc<Self>) {
        let tasks = self.clone();
        tokio::spawn(async move {
            let _guard = tasks.lock.lock().await;
            tasks.retry_queue().await;
        });
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

    async fn try_start_inner(self: &Arc<Self>, stored: &StoredTask, from_queue: bool) -> Result<Task, StoreError> {
        let task = &stored.task;
        let r = &task.project_ref;
        if task.kind == TaskKind::Write
            && let crate::hub::slots::Grant::Queued(reason) = self.d.leases.acquire(r, &task.task_id, &task.areas)?
        {
            return self.queue(stored, &reason);
        }
        // Checked before the slot: taking and releasing one would run the queue again at once.
        let offline = format!("machine {} is offline", r.machine_id.as_str());
        if !self.d.executors.is_connected(&r.machine_id) {
            self.retry_when_live(&r.machine_id);
            return self.queue(stored, &offline);
        }
        // M4 usage: a paused login takes no new turns; usage.resumed runs the queue again.
        if let Some(paused) = self.d.usage.gate(&r.machine_id) {
            return self.queue(stored, &paused);
        }
        let slot = self.d.slots.acquire(SlotRequest { holder: task.task_id.as_str(), project_ref: r, priority: priority_of(task.kind) })?;
        if let crate::hub::slots::Grant::Queued(reason) = slot {
            return self.queue(stored, &reason);
        }

        let continuing = task.thread_ref.is_some() && stored.pending_message.is_some();
        let started = if continuing {
            let thread = task.thread_ref.as_ref().expect("continuing has a thread");
            let message = stored.pending_message.as_deref().expect("continuing has a message");
            let id = request_id(task, &[&task.attempt.get().to_string()]);
            self.d.executors.send(thread, message, &id).await.map(|_| (thread.clone(), None)).map_err(StartError::from)
        } else {
            self.launch(task).await
        };
        let (thread_ref, branch) = match started {
            Ok(started) => started,
            Err(StartError::Offline) => {
                self.d.slots.release(task.task_id.as_str())?;
                self.retry_when_live(&r.machine_id);
                return self.queue(stored, &offline);
            }
            Err(StartError::Other(message)) => return self.fail_to_start(stored, &message, from_queue),
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
        self.put(&StoredTask { task: next.clone(), pending_message: None })?;
        let summary = if continuing {
            format!("{} continued (attempt {}): {}", task.task_id.as_str(), task.attempt.get(), task.title.as_str())
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
        let base = self.d.executors.default_branch(&r.machine_id, &project.workspace_root).await.ok()?;
        let argv = branch_diff::branch_diff_argv(&base, branch)?;
        let input = CommandInput { cwd: project.workspace_root.clone(), argv, timeout_sec: Some(branch_diff::TIMEOUT_SEC as u32) };
        let out = self.d.commands.run(&r.machine_id, input).await.ok()?;
        branch_diff::parse_branch_diff(out.exit_code.map_or(-1, |c| c.get()), out.output_tail.as_str())
    }

    async fn finish(self: &Arc<Self>, stored: &StoredTask, status: TaskResultStatus) -> Result<(), StoreError> {
        let task = &stored.task;
        let thread_ref = task.thread_ref.clone().expect("a live task has a thread");
        let thread = self.d.store.thread_get(&thread_ref)?;
        let text = thread.as_ref().map_or("", |t| t.thread.latest_message_tail.as_str()).to_owned();
        let error = match (&thread, status) {
            (Some(t), TaskResultStatus::Failed) => t.thread.last_error.as_ref().map(|e| format!("[{}] {}", e.class, e.message)).unwrap_or_default(),
            _ => String::new(),
        };
        let write = task.kind == TaskKind::Write;
        let changes = if write { self.d.executors.changes(&thread_ref).await.ok() } else { None };
        let actions = self.d.executors.actions(&thread_ref, 30, false).await.unwrap_or_default();
        let pr_url = changes.as_ref().and_then(|c| c.pull_request_urls.last().cloned()).or_else(|| {
            let mut texts: Vec<&str> = Vec::new();
            for a in actions.iter().rev() {
                texts.push(a.summary.as_str());
                if let Some(out) = &a.output_tail {
                    texts.push(out.as_str());
                }
            }
            texts.push(&text);
            find_pr_url(texts)
        });
        let branch = changes.as_ref().and_then(|c| c.branch.clone()).or_else(|| task.branch.as_ref().map(|b| b.as_str().to_owned()));
        let at = self.now_iso();
        let tail = [text.trim(), error.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n\n");
        // M6 receipts: what the thread actually ran, counted from its items.
        let result = self
            .d
            .receipts
            .attach(
                &thread_ref,
                TaskResult {
                    status,
                    tail: Text::unchecked(tail_of(&tail, render::TAIL_MAX)),
                    branch: branch.clone().map(NonEmpty::unchecked),
                    pr_url: pr_url.map(PrUrl::unchecked),
                    receipts: None,
                    claims_unverified: None,
                    at: Timestamp(at.clone()),
                },
            )
            .await;
        let mut next = task.clone();
        next.state = if status == TaskResultStatus::Done { TaskState::Done } else { TaskState::Failed };
        next.result = Some(result.clone());
        next.ended_at = Some(Timestamp(at));
        if let Some(branch) = &branch {
            next.branch = Some(NonEmpty::unchecked(branch.clone()));
        }
        if let Some(path) = changes.as_ref().and_then(|c| c.worktree_path.clone()) {
            next.worktree_path = Some(fleetd_contracts::AbsolutePath::unchecked(path));
        }
        self.put(&StoredTask { task: next.clone(), pending_message: None })?;

        // The PR's diff when the node can read it; T3's checkpoint paths (which include whatever a rebase brought
        // in) only when it can't.
        let pr_paths = match (&branch, write) {
            (Some(branch), true) => self.branch_paths(&task.project_ref, branch).await,
            _ => None,
        };
        if pr_paths.is_none() && write {
            tracing::warn!(task_id = task.task_id.as_str(), "task: branch diff not read; areas checked on T3 checkpoint paths");
        }
        if let Some(paths) = pr_paths.or_else(|| changes.as_ref().map(|c| c.paths.clone()))
            && let Ok(policy) = self.d.policies.get(&task.project_ref).await
        {
            let globs: Vec<String> = area_globs(&policy, &area_names(task)).into_iter().flat_map(|(_, g)| g).collect();
            let outside = glob::outside_globs(&paths, &globs);
            if !outside.is_empty() {
                let n = outside.len();
                let first: Vec<&str> = outside.iter().take(5).map(|s| s.as_str()).collect();
                let mut extra = Map::new();
                extra.insert("paths".into(), json!(outside.iter().take(OUT_OF_AREA_MAX).collect::<Vec<_>>()));
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
        let (r#type, verb) = if status == TaskResultStatus::Done { (HubEventType::TaskCompleted, "completed") } else { (HubEventType::TaskFailed, "failed") };
        self.emit(&next, r#type, format!("{} {verb}: {}", task.task_id.as_str(), task.title.as_str()), Map::new())?;
        self.retry_queue().await;
        Ok(())
    }

    async fn on_thread_event(self: &Arc<Self>, event: &HubEvent) -> Result<(), StoreError> {
        if event.r#type == HubEventType::UsageResumed {
            self.retry_queue().await;
            return Ok(());
        }
        let (Some(machine_id), Some(thread_id)) = (&event.machine_id, &event.thread_id) else { return Ok(()) };
        let thread_ref = ThreadRef { machine_id: machine_id.clone(), thread_id: thread_id.clone() };
        let Some(stored) = self.db(|c| TaskRecords::by_thread(c, &thread_ref))? else { return Ok(()) };
        let task = &stored.task;
        let live = matches!(task.state, TaskState::Running | TaskState::Idle);
        match event.r#type {
            HubEventType::ThreadStarted => {
                // Continued outside `task message`: the watchdog's nudge, or a human writing to the thread.
                if !matches!(task.state, TaskState::Done | TaskState::Failed | TaskState::Idle) {
                    return Ok(());
                }
                if task.kind == TaskKind::Write {
                    self.d.leases.acquire(&task.project_ref, &task.task_id, &task.areas)?;
                }
                let request = SlotRequest { holder: task.task_id.as_str(), project_ref: &task.project_ref, priority: priority_of(task.kind) };
                self.d.slots.acquire(request)?;
                self.d.slots.bind(task.task_id.as_str(), &thread_ref)?;
                let mut next = task.clone();
                next.ended_at = None;
                next.parked = None;
                next.state = TaskState::Running;
                self.put(&StoredTask { task: next, pending_message: None })?;
            }
            HubEventType::ThreadWaiting => {
                // The board frees the slot itself and takes it again if the run resumes; the leases stay.
                if task.state != TaskState::Running {
                    return Ok(());
                }
                let mut next = task.clone();
                next.state = TaskState::Idle;
                self.put(&StoredTask { task: next, pending_message: None })?;
                // Nobody else answers a task's question, so its lead is woken with it.
                let asked = self.d.executors.pending_question(&thread_ref).await.ok().flatten();
                let latest = self.d.store.thread_get(&thread_ref)?.map(|t| t.thread.latest_message_tail.as_str().trim().to_owned());
                let question = asked.or_else(|| latest.filter(|l| !l.is_empty()).map(|l| tail_of(&l, 1500))).unwrap_or_else(|| {
                    format!(
                        "(T3 did not say what it waits for; read it with thread_tail on {}/{})",
                        thread_ref.machine_id.as_str(),
                        thread_ref.thread_id.as_str()
                    )
                });
                self.d
                    .leads
                    .wake(&task.project_ref, TaskWake::Waiting { task_id: task.task_id.clone(), title: task.title.as_str().to_owned(), question });
            }
            HubEventType::ThreadCompleted => {
                if live {
                    self.finish(&stored, TaskResultStatus::Done).await?;
                }
            }
            HubEventType::ThreadUsageLimited => {
                // M4 usage: parked, not failed. The board freed the slot, the leases stay, and the usage layer sends
                // "continue" at the reset, which comes back here as thread.started.
                if let Some(parked) = self.d.usage.parked_of(event).filter(|_| live) {
                    let mut next = task.clone();
                    next.state = TaskState::Idle;
                    next.parked = Some(parked);
                    self.put(&StoredTask { task: next, pending_message: stored.pending_message.clone() })?;
                }
            }
            HubEventType::ThreadFailed | HubEventType::ThreadInterrupted => {
                // A cancel interrupts the thread itself and has already ended the task.
                if live {
                    self.finish(&stored, TaskResultStatus::Failed).await?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn follow(self: Arc<Self>, from: u64) {
        let mut cursor = from;
        loop {
            let input = WaitInput { cursor: Some(cursor), types: Some(THREAD_EVENTS.to_vec()), machine_id: None, timeout_sec: 300 };
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
                if let Err(error) = self.on_thread_event(event).await {
                    tracing::warn!(seq = ?event.seq, %error, "task event not handled");
                }
            }
        }
    }

    fn owned(&self, caller: &TaskCaller, task_id: &TaskId) -> Result<StoredTask, LeadError> {
        match self.db(|c| TaskRecords::get(c, task_id)).map_err(store_error)? {
            Some(stored) if same_project(&stored.task.project_ref, &caller.project_ref) => Ok(stored),
            _ => Err(lead_error("not_found", format!("No task {} in this project.", task_id.as_str()), Some("Run `fleetd task list`."))),
        }
    }

    /// The task as stored: running, queued with its reason, or failed if T3 refused the launch.
    pub async fn spawn(self: &Arc<Self>, caller: &TaskCaller, input: SpawnInput) -> Result<Task, LeadError> {
        let r = &caller.project_ref;
        // M6 value bar: serves, done workstreams and review rounds. Outside the lock, since it may ask GitHub for a
        // PR head, and before the closed-state check, so a done workstream gets its own refusal.
        if let Some(ws) = self.d.leads.workstream(&input.workstream_id).filter(|w| same_project(&w.project_ref, r)) {
            self.d.spawn_check.check_spawn(caller, &input, &ws).await?;
        }
        let _guard = self.lock.lock().await;
        let ws = match self.d.leads.workstream(&input.workstream_id) {
            Some(ws) if same_project(&ws.project_ref, r) => ws,
            _ => {
                return Err(lead_error(
                    "not_found",
                    format!("No workstream {} in this project.", input.workstream_id.as_str()),
                    Some("Use a workstream id from your digest."),
                ));
            }
        };
        let ws_state = state_name(&ws.state);
        if CLOSED_STATES.contains(&ws_state.as_str()) {
            return Err(lead_error(
                "invalid",
                format!("Workstream {} is {ws_state}; tasks run only for open workstreams.", input.workstream_id.as_str()),
                None,
            ));
        }
        let policy = self.d.policies.get(r).await?;
        let unknown: Vec<&str> = input.areas.iter().map(|a| a.as_str()).filter(|a| !policy.areas.contains_key(*a)).collect();
        if !unknown.is_empty() {
            let known: Vec<&str> = policy.areas.keys().map(String::as_str).collect();
            return Err(lead_error(
                "invalid",
                format!("Unknown area{} {}.", if unknown.len() == 1 { "" } else { "s" }, unknown.join(", ")),
                Some(&format!("Use areas from .fleetd/policy.yaml: {}.", known.join(", "))),
            ));
        }
        let flag = ModelEffort { model: input.model.as_ref().map(|m| m.as_str().to_owned()), effort: input.effort };
        let defaults = policy.defaults.as_ref().map(|d| ModelEffort { model: d.model.as_ref().map(|m| m.as_str().to_owned()), effort: d.effort });
        let settings = self.d.leads.project_settings(r);
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
            tier: input.tier.clone(),
            estimate_minutes: input.estimate_minutes.clone(),
            serves: input.serves.clone(),
            qa: input.qa,
            pr: input.pr.clone(),
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
        let task = self.db(|c| TaskRecords::create(c, task)).map_err(store_error)?;
        Ok(self.try_start(StoredTask { task, pending_message: None }, false).await)
    }

    /// Steers a running task; continues an ended one in the same thread, which re-takes its slot and leases.
    pub async fn message(self: &Arc<Self>, caller: &TaskCaller, task_id: &TaskId, text: &str) -> Result<Task, LeadError> {
        let _guard = self.lock.lock().await;
        let stored = self.owned(caller, task_id)?;
        let task = stored.task.clone();
        let id = task_id.as_str();
        match task.state {
            TaskState::Cancelled => Err(lead_error("invalid", format!("{id} was cancelled."), Some("Spawn a new task for the remaining work."))),
            TaskState::Queued => {
                if task.thread_ref.is_none() {
                    return Err(lead_error(
                        "invalid",
                        format!("{id} has not started yet ({}).", task.queued_reason.as_ref().map_or("queued", |r| r.as_str())),
                        Some(&format!("Wait for it to start, or `fleetd task cancel {id}` and spawn it again with the new prompt.")),
                    ));
                }
                let pending = match &stored.pending_message {
                    None => text.to_owned(),
                    Some(earlier) => format!("{earlier}\n\n{text}"),
                };
                self.put(&StoredTask { task: task.clone(), pending_message: Some(pending) }).map_err(store_error)?;
                Ok(task)
            }
            TaskState::Running => {
                let thread = task.thread_ref.as_ref().expect("a running task has a thread");
                let uuid = random_uuid();
                self.d.executors.send(thread, text, &request_id(&task, &["msg", &uuid])).await.map_err(|e| from_executor(&e))?;
                Ok(task)
            }
            _ => {
                let mut next = task;
                next.attempt = Int::unchecked(next.attempt.get() + 1);
                Ok(self.try_start(StoredTask { task: next, pending_message: Some(text.to_owned()) }, false).await)
            }
        }
    }

    /// Interrupts a running task and releases its slot and leases.
    pub async fn cancel(self: &Arc<Self>, caller: &TaskCaller, task_id: &TaskId, reason: Option<&str>) -> Result<Task, LeadError> {
        let _guard = self.lock.lock().await;
        let task = self.owned(caller, task_id)?.task;
        let id = task_id.as_str();
        match task.state {
            TaskState::Cancelled => return Ok(task),
            TaskState::Done | TaskState::Failed => {
                return Err(lead_error("invalid", format!("{id} already ended ({}); there is nothing to cancel.", state_name(&task.state)), None));
            }
            _ => {}
        }
        if task.state == TaskState::Running
            && let Some(thread) = &task.thread_ref
            && let Err(error) = self.d.executors.interrupt(thread, &request_id(&task, &["cancel", &task.attempt.get().to_string()])).await
        {
            tracing::warn!(task_id = id, %error, "task cancel: interrupt failed");
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
            self.put(&StoredTask { task: next.clone(), pending_message: None })?;
            self.release_all(&task)?;
            self.emit(&next, HubEventType::TaskCancelled, format!("{id} cancelled: {}", task.title.as_str()), Map::new())
        })();
        done.map_err(store_error)?;
        self.retry_queue().await;
        Ok(next)
    }

    pub fn get(&self, task_id: &TaskId) -> Result<Option<Task>, StoreError> {
        Ok(self.db(|c| TaskRecords::get(c, task_id))?.map(|s| s.task))
    }

    /// Newest first.
    pub fn list(&self, filter: &TaskFilter) -> Result<Vec<Task>, StoreError> {
        self.db(|c| TaskRecords::list(c, filter))
    }
}
