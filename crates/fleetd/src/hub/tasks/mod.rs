//! fleetd-owned tasks: every subagent a lead runs. Spawn resolves the profile, takes a slot or queues with the
//! reason, and launches a thread (writers in a new worktree on `<branchPrefix><taskId>-<slug>`,
//! `fleetd/` by default).
//! The thread's status transitions, read off the event log, end the task: the result goes into the record and,
//! inline, into one lead wake; the slot is released and the queue is tried again.
pub mod base;
pub mod breaker;
pub mod cap;
#[cfg(test)]
mod cap_tests;
pub mod duplicates;
#[cfg(test)]
mod duplicates_tests;
#[cfg(test)]
mod fresh_tests;
#[cfg(test)]
mod guard_tests;
pub mod hooks;
pub mod policy;
pub mod ports;
pub mod pr;
#[cfg(test)]
mod race_tests;
pub mod records;
pub mod recovery;
#[cfg(test)]
mod recovery_tests;
pub mod render;
pub mod resolve;
pub mod sweep;
#[cfg(test)]
mod sweep_tests;
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
    FetchFailedData, PrUrl, RecoveryMode, Task, TaskId, TaskKind, TaskRecovery, TaskResult,
    TaskResultStatus, TaskState,
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
use ports::{BranchPrError, LaunchRequest, PortError, TaskError, TaskPorts, WakeKind, Worktree};
use render::{branch_for, render_task_prompt, tail_of};
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

const THREAD_EVENTS: [HubEventType; 10] = [
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
    // PR lookups the machine's absence held up run again.
    HubEventType::MachineOnline,
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

/// What a task whose context is full is sent first: claude's own compaction of its conversation.
const COMPACT: &str = "/compact";
/// How much of the earlier thread's last words a fresh thread's handoff carries.
const HANDOFF_TAIL: usize = 1500;
/// The most each node read for a handoff (the thread's changes, each git command) may take.
const HANDOFF_STEP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

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

/// A project's repo and base being read in the background: dropping it, when the read ends however it ends, takes the
/// project out of `Tasks::binding`.
struct Reading {
    projects: Arc<Mutex<HashSet<ProjectRef>>>,
    project: ProjectRef,
}

impl Drop for Reading {
    fn drop(&mut self) {
        self.projects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.project);
    }
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
    /// Running tasks whose lead was told their machine is away, with the machine and the start of that offline spell:
    /// once per spell. Not kept across a hub restart, after which a spell may be told once more.
    unreachable: Mutex<HashMap<TaskId, (MachineId, String)>>,
    /// Tasks fleetd resumed whose new run hasn't started yet: what the dead run was doing, and what the node had last
    /// rebuilt their worktree from before the resume. Their lead's line goes once the run starts, when the node has
    /// said whether it rebuilt the worktree for it. Not kept across a hub restart.
    resumed: Mutex<HashMap<TaskId, (String, Option<ports::Rebuilt>)>>,
    /// Fresh restarts' handoffs by task, for the attempt they were gathered for: `None` while the gathering runs. Not
    /// kept across a hub restart, after which they are gathered again.
    handoffs: Mutex<HashMap<TaskId, (i64, Option<String>)>>,
    /// Per machine: whether its agents keep dying, so their resumes wait (`breaker`).
    breakers: Mutex<breaker::Breakers>,
    /// Sessions the sweep found that no task or lead owns, with when it first did and whether it reported them.
    unowned: Mutex<HashMap<ThreadRef, (i64, bool)>>,
    /// Tasks whose PR lookup runs now, so a retry doesn't start a second one.
    looking_up: Mutex<HashSet<TaskId>>,
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
            looking_up: Mutex::new(HashSet::new()),
            asking: Mutex::new(HashSet::new()),
            continuing: Mutex::new(HashMap::new()),
            binding: Arc::new(Mutex::new(HashSet::new())),
            unreachable: Mutex::new(HashMap::new()),
            resumed: Mutex::new(HashMap::new()),
            handoffs: Mutex::new(HashMap::new()),
            breakers: Mutex::default(),
            unowned: Mutex::default(),
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
        // Recoveries a restart cut short still go at their time, unless their machine's breaker holds them.
        self.restore_breakers();
        for stored in self.db(TaskRecords::queued).unwrap_or_default() {
            self.resume_at(stored.task.recovery.as_ref());
        }
        let retry = {
            let tasks = self.clone();
            async move {
                loop {
                    tasks.resume_pr_lookups(None);
                    tokio::time::sleep(PR_LOOKUP_RETRY).await;
                }
            }
        };
        tokio::select! {
            () = shutdown.wait() => {}
            () = self.clone().follow(self.cursor) => {}
            () = retry => {}
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
        self.handoffs.lock().unwrap().remove(&task.task_id);
        self.continuing.lock().unwrap().remove(&task.task_id);
        self.resumed.lock().unwrap().remove(&task.task_id);
        self.d.slots.release(task.task_id.as_str())?;
        self.breakers.lock().unwrap().release(&task.task_id);
        Ok(())
    }

    /// `escalated`: its run died and was not resumed.
    fn wake_result(&self, task: &Task, result: &TaskResult, escalated: bool) {
        let text = render::task_result_lines(
            task.task_id.as_str(),
            task.title.as_str(),
            result,
            escalated,
        );
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

    /// The task's new thread, its branch, and where the branch started. `handoff`: a fresh restart, which takes over
    /// the task's thread and its worktree, and whose agent gets the handoff after its brief.
    async fn launch(&self, task: &Task, handoff: Option<&str>) -> Result<Launched, StartError> {
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
        // Every task gets a worktree of its own from the default branch, a writer's on its branch and a reader's
        // detached, so none works in the human's checkout. A reader still runs there, as before, on a node too old to
        // decode a detached workspace (it would drop its link), and in a directory with no branch or a repo with no
        // commit yet, which can't have one.
        let base_branch = if write || self.d.ports.detached_worktrees(&r.machine_id) {
            self.d
                .ports
                .default_branch(&r.machine_id, &project.workspace_root)
                .await?
        } else {
            None
        };
        if write && base_branch.is_none() {
            return Err(StartError::Other(format!(
                "no branch with a commit at {}",
                project.workspace_root
            )));
        }
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
        let mut prompt = render_task_prompt(
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
        if let Some(handoff) = handoff {
            prompt = format!("{prompt}\n\n{handoff}");
        }
        let from = handoff
            .and(task.thread_ref.as_ref())
            .map(|t| t.thread_id.clone());
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
            worktree: base_branch.map(|base_ref| Worktree {
                base_ref,
                branch: branch.clone(),
                pr: task.pr.as_deref().map(str::to_owned),
                from,
            }),
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
            self.wake_result(&next, &result, false);
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
        // A recovery due now goes on as its mode says: in its thread, `/compact` first, or in a fresh thread.
        let recovering = task.thread_ref.is_some()
            && task.recovery.as_ref().is_some_and(|r| r.next_at.is_some());
        let mode = task
            .recovery
            .as_ref()
            .filter(|_| recovering)
            .map(|r| r.mode);
        let fresh = mode == Some(RecoveryMode::Fresh);
        let compact = mode == Some(RecoveryMode::Compact);
        let continuing =
            task.thread_ref.is_some() && !fresh && (stored.pending_message.is_some() || recovering);
        // The disk and load guard holds new agents only; machine.guard runs the queue again. One with a thread
        // continues in the worktree it has, a fresh restart too.
        if !continuing
            && !fresh
            && let Some(paused) = self.d.ports.paused(&r.machine_id)
        {
            return self.queue(stored, "guard", &paused);
        }
        // A fresh restart's handoff reads the node (git, the thread's changes), off the lock: it waits queued until that
        // is in, and the gathering runs the queue again.
        let handoff = if fresh {
            match self.handoff_ready(task) {
                Some(handoff) => Some(handoff),
                None => return Ok(task.clone()),
            }
        } else {
            None
        };
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
        if (continuing || fresh) && self.asking.lock().unwrap().contains(&task.task_id) {
            return Ok(task.clone());
        }
        if (continuing || fresh)
            && let Some(thread) = &task.thread_ref
            && self
                .d
                .store
                .thread_get(thread)?
                .is_some_and(|t| t.thread.status == fleetd_contracts::model::ThreadStatus::Running)
        {
            return Ok(task.clone());
        }
        // What the dead run did last and what its worktree was last rebuilt from, for the lead's line: read before
        // the resume adds to them.
        let (doing, rebuilt_before) = match &task.thread_ref {
            Some(thread) if recovering => (
                self.last_doing(thread).await,
                self.d.ports.recreated_from(thread),
            ),
            _ => (String::new(), None),
        };
        // What the recovery says goes first, then anything sent into the gap.
        let with_pending = |text: Option<String>| {
            [text.as_deref(), stored.pending_message.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("\n\n")
        };
        let started = if let Some(handoff) = handoff {
            self.launch(task, Some(&with_pending(Some(handoff)))).await
        } else if continuing {
            let thread = task.thread_ref.as_ref().expect("continuing has a thread");
            // A full context compacts first; the note and anything sent meanwhile follow once that run completed.
            let message = if compact {
                COMPACT.to_owned()
            } else {
                with_pending(
                    task.recovery
                        .as_ref()
                        .filter(|_| recovering)
                        .map(|recovery| self.recover_note(thread, recovery, &doing)),
                )
            };
            let message = message.as_str();
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
            self.launch(task, None).await
        };
        let (thread_ref, branch, base) = match started {
            Ok(started) => started,
            Err(StartError::Offline) => {
                self.d.slots.release(task.task_id.as_str())?;
                self.retry_when_live(&r.machine_id);
                return self.queue(stored, "offline", &offline);
            }
            // Its thread can't go on (claude's conversation is gone, or its config dir changed): a new one takes over.
            Err(StartError::Other(message))
                if continuing && message.contains(fleetd_contracts::sessions::RESUME_REFUSED) =>
            {
                return self.refused(stored, &message, from_queue).await;
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
        if fresh && let Some(earlier) = task.thread_ref.clone() {
            next.previous_threads.push(earlier);
            self.handoffs.lock().unwrap().remove(&task.task_id);
        }
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
        // A fresh restart that took over the worktree keeps the base it has: the node reports none for a takeover. One
        // the node gave a new worktree (the earlier session's record was gone) records where that one started.
        if !continuing && (!fresh || base.is_some()) {
            next.base = base.clone();
        }
        next.state = TaskState::Running;
        if let Some(recovery) = next.recovery.as_mut().filter(|_| recovering) {
            recovery.next_at = None;
            recovery.resumed_at = Some(Timestamp(at.clone()));
        }
        next.started_at = Some(task.started_at.clone().unwrap_or(Timestamp(at)));
        // From here the board holds the slot while the thread runs and frees it whenever it stops.
        self.d.slots.bind(task.task_id.as_str(), &thread_ref)?;
        self.put(&StoredTask {
            task: next.clone(),
            // Held back until the compaction completed.
            pending_message: stored.pending_message.clone().filter(|_| compact),
        })?;
        let now = self.now_iso();
        let summary = if let Some(recovery) = next.recovery.as_ref().filter(|_| recovering) {
            let how = match recovery.mode {
                RecoveryMode::Resume => "resumed automatically",
                RecoveryMode::Compact => "compacting its full context to resume",
                RecoveryMode::Fresh => "restarted in a fresh thread",
            };
            format!(
                "{} {how} (attempt {}, {}): {}",
                task.task_id.as_str(),
                task.attempt.get(),
                recovery::used(recovery),
                task.title.as_str()
            )
        } else if continuing {
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
        // A compaction's lead line goes with the note that follows it.
        if recovering && !compact {
            self.resumed
                .lock()
                .unwrap()
                .insert(task.task_id.clone(), (doing, rebuilt_before));
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

    /// The thread's last action, else its headline: what a dead run was doing.
    async fn last_doing(&self, thread: &ThreadRef) -> String {
        let last = self.last_action(thread).await;
        self.doing(thread, last)
    }

    async fn last_action(&self, thread: &ThreadRef) -> Option<String> {
        self.bounded(async {
            self.d
                .ports
                .action_texts(thread, 1)
                .await
                .into_iter()
                .next()
        })
        .await
        .map(|(summary, _)| summary)
    }

    /// `last`, the thread's last action, else its headline.
    fn doing(&self, thread: &ThreadRef, last: Option<String>) -> String {
        last.or_else(|| {
            self.d
                .store
                .thread_get(thread)
                .ok()
                .flatten()
                .map(|t| t.thread.headline.as_str().trim().to_owned())
                .filter(|h| !h.is_empty())
        })
        .map_or_else(
            || "nothing it said".to_owned(),
            |d| render::one_line(&d, 200),
        )
    }

    /// FIFO over every project's queue; each task is tried once. Call with the lock held.
    async fn retry_queue(self: &Arc<Self>) {
        let queued = match self.db(TaskRecords::queued) {
            Ok(queued) => queued,
            Err(error) => return tracing::warn!(%error, "tasks: queue not read"),
        };
        let now = now_ms(self.d.clock.as_ref());
        self.close_quiet_breakers(now);
        for mut stored in queued {
            if let Err(error) = self.settle(&mut stored) {
                tracing::warn!(task_id = stored.task.task_id.as_str(), %error, "tasks: recovery not settled");
            }
            // A recovering task waits out its delay; its timer runs the queue then. One its machine's breaker holds
            // waits for that to close.
            if recovery::waiting(stored.task.recovery.as_ref(), now) || self.held(&stored.task) {
                continue;
            }
            // Its work may have ended while it waited: then it isn't resumed, and ends with its run's plain result.
            let recovering = stored
                .task
                .recovery
                .as_ref()
                .is_some_and(|r| r.next_at.is_some());
            if recovering && self.stopped(&stored.task).unwrap_or(false) {
                tracing::info!(
                    task_id = stored.task.task_id.as_str(),
                    "recovering task not resumed: its work is over"
                );
                let cause = stored.task.recovery.as_ref().map(|r| r.last_cause);
                // No resume goes out, so a later continue by the lead is neither labelled one nor counted as one.
                if let Some(recovery) = &mut stored.task.recovery {
                    recovery.next_at = None;
                    recovery.resumed_at = None;
                }
                if let Err(error) = self
                    .end(&stored, TaskResultStatus::Failed, None, cause, None)
                    .await
                {
                    tracing::warn!(task_id = stored.task.task_id.as_str(), %error, "tasks: recovering task not ended");
                }
                continue;
            }
            self.try_start(stored, true).await;
        }
    }

    /// A task its node's going away cut off resumes 30-40 s after the node is back, however early the node reported
    /// the death: it moves its time to then, and the timer with it.
    fn settle(self: &Arc<Self>, stored: &mut StoredTask) -> Result<(), StoreError> {
        let task = &stored.task;
        let Some(recovery) = task.recovery.as_ref() else {
            return Ok(());
        };
        let Some(back) = self.d.ports.live_since(&task.project_ref.machine_id) else {
            // Offline: its start queues it until the node is back, and this runs again then.
            return Ok(());
        };
        let Some(at) = recovery::settled(recovery, back, task.task_id.as_str()) else {
            return Ok(());
        };
        let mut next = task.clone();
        if let Some(r) = &mut next.recovery {
            r.next_at = Some(at);
        }
        self.resume_at(next.recovery.as_ref());
        stored.task = next;
        self.put(stored)
    }

    /// The project's `origin` remote, shortened ("github.com/acme/shop"), as git reads it in its checkout on the
    /// node: `Some(None)` when it has none (or the project is gone), `None` when the node couldn't say.
    async fn origin(&self, r: &ProjectRef) -> Option<Option<String>> {
        let Ok(found) = self.d.store.project_get(r) else {
            return None;
        };
        let Some(project) = found else {
            return Some(None);
        };
        let argv = ["git", "remote", "get-url", "origin"]
            .map(String::from)
            .to_vec();
        let out = self
            .d
            .ports
            .run_command(&r.machine_id, &project.workspace_root, argv, 15)
            .await?;
        let url = out.output_tail.trim();
        Some(
            (out.exit_code == Some(0) && !url.is_empty())
                .then(|| fleetd_contracts::projects::short_remote(url)),
        )
    }

    /// `why` stands in for the thread's own error: the watchdog's stall, which the thread row does not hold yet.
    /// `escalated`: why a dead run was not resumed, which its lead decides on.
    async fn finish(
        self: &Arc<Self>,
        stored: &StoredTask,
        status: TaskResultStatus,
        why: Option<String>,
        end_cause: Option<RunEnd>,
        escalated: Option<&str>,
    ) -> Result<(), StoreError> {
        self.end(stored, status, why, end_cause, escalated).await?;
        self.retry_queue().await;
        Ok(())
    }

    /// `finish` without running the queue after, for the queue's own run.
    async fn end(
        self: &Arc<Self>,
        stored: &StoredTask,
        status: TaskResultStatus,
        why: Option<String>,
        end_cause: Option<RunEnd>,
        escalated: Option<&str>,
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
        let branch = changes
            .as_ref()
            .and_then(|c| c.branch.clone())
            .or_else(|| task.branch.as_ref().map(|b| b.as_str().to_owned()));
        // A reader or a review has the PR it was given, never one its report links (D130). A writer's is looked up
        // after the task ends, off the lock.
        let pr_url = task.pr.clone().filter(|_| task.kind != TaskKind::Write);
        let at = self.now_iso();
        let escalation = escalated.map(|why| {
            format!(
                "Not resumed automatically: {why}. Decide: continue it with instructions (message_agent), split the work, or cancel it."
            )
        });
        let tail = [
            text.trim(),
            error.as_str(),
            escalation.as_deref().unwrap_or(""),
        ]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n\n");
        let result = TaskResult {
            status,
            tail: Text::unchecked(tail_of(&tail, render::TAIL_MAX)),
            branch: branch.clone().map(NonEmpty::unchecked),
            pr_url,
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
        // The PR lookup is marked pending in the same write, so no crash between them loses it.
        let stored_next = StoredTask {
            task: next.clone(),
            pending_message: None,
        };
        let look_up = task.kind == TaskKind::Write;
        self.db(|c| TaskRecords::put_ended(c, &stored_next, look_up))?;

        self.release_all(task)?;
        self.wake_result(&next, &result, escalated.is_some());
        // Last, so whoever waits on it sees the slot and the wake already settled.
        let (r#type, verb) = if status == TaskResultStatus::Done {
            (HubEventType::TaskCompleted, "completed")
        } else {
            (HubEventType::TaskFailed, "failed")
        };
        let mut extra = Map::new();
        if let Some(why) = escalated {
            extra.insert("escalated".into(), json!(why));
        }
        self.emit(
            &next,
            r#type,
            format!("{} {verb}: {}", task.task_id.as_str(), task.title.as_str()),
            extra,
        )?;
        // A reader's worktree holds no work, so it goes now; a writer's waits for its PR to merge.
        if !write {
            self.remove_worktree(&next);
        }
        if look_up {
            self.resolve_pr(next.task_id.clone());
        }
        Ok(())
    }

    /// A run of a live task ended without completing: resumed, escalated or failed plainly (`recovery::decide`).
    /// Only a run that started ends here; a task that never started, or was cancelled, has its result already.
    async fn died(
        self: &Arc<Self>,
        stored: &StoredTask,
        thread: &ThreadRef,
        event: &HubEvent,
    ) -> Result<(), StoreError> {
        let task = &stored.task;
        // Only the run the thread is on dies mid-run (`earlier_run` drops the others): one that names no run can't
        // be told from a run that never started, so it ends the task plainly.
        let ran = event
            .data
            .as_ref()
            .and_then(|d| d["runId"].as_str())
            .is_some_and(|run| self.d.ports.started_run(thread).is_none_or(|s| s == run));
        let last = self.last_action(thread).await;
        let death = recovery::death(
            event.r#type,
            event.data.as_ref(),
            thread.machine_id.as_str(),
            last.as_deref(),
        );
        let opened = ran.then(|| self.count_death(task, death.kind)).flatten();
        let action = recovery::decide(
            &death,
            task.recovery.as_ref(),
            !ran || self.stopped(task)?,
            now_ms(self.d.clock.as_ref()),
            rand::random(),
            recovery::max(),
        );
        // The watchdog's stall, which the thread row does not hold yet.
        let stalled = event
            .data
            .as_ref()
            .filter(|_| death.kind == recovery::Kind::Stalled)
            .and_then(|d| d["error"]["message"].as_str())
            .map(|m| format!("[stalled] {m}"));
        match action {
            recovery::Action::Finish => {
                self.finish(
                    stored,
                    TaskResultStatus::Failed,
                    stalled,
                    death.reported,
                    None,
                )
                .await
            }
            recovery::Action::Escalate(why) => {
                tracing::info!(
                    task_id = task.task_id.as_str(),
                    why,
                    "dead task not resumed"
                );
                self.finish(
                    stored,
                    TaskResultStatus::Failed,
                    stalled,
                    death.reported,
                    Some(&why),
                )
                .await
            }
            recovery::Action::Resume(recovery) => {
                self.recover(stored, recovery)?;
                self.hold_if_paused(&task.task_id, &thread.machine_id)
            }
        }?;
        if let Some(opened) = opened {
            self.recovery_paused(&thread.machine_id, &opened)?;
        }
        Ok(())
    }

    /// Queues a dead task to go on at `recovery.next_at`, as `recovery.mode` says; what it is told is rendered when it
    /// goes (`recovery_text`), and a message sent into the gap goes with it, so the agent is continued once. The lead
    /// isn't woken: the queued reason is in its digest, and the resume in its next one.
    fn recover(
        self: &Arc<Self>,
        stored: &StoredTask,
        recovery: TaskRecovery,
    ) -> Result<Task, StoreError> {
        let task = &stored.task;
        let reason = recovery::queued_reason(&recovery);
        tracing::info!(
            task_id = task.task_id.as_str(),
            reason,
            "dead task recovers"
        );
        // A question it asked before it died no longer holds it back: it goes on, and the answer reaches it then.
        self.asking.lock().unwrap().remove(&task.task_id);
        let mut next = task.clone();
        next.attempt = Int::unchecked(next.attempt.get() + 1);
        self.resume_at(Some(&recovery));
        next.recovery = Some(recovery);
        self.d.slots.release(task.task_id.as_str())?;
        self.queue(
            &StoredTask {
                task: next,
                pending_message: stored.pending_message.clone(),
            },
            "recover",
            &reason,
        )
    }

    /// The node would not resume the task's thread (`message`, its words): a fresh thread takes over, once.
    async fn refused(
        self: &Arc<Self>,
        stored: &StoredTask,
        message: &str,
        from_queue: bool,
    ) -> Result<Task, StoreError> {
        let task = &stored.task;
        let death = recovery::refused(message);
        let action = recovery::decide(
            &death,
            task.recovery.as_ref(),
            self.stopped(task)?,
            now_ms(self.d.clock.as_ref()),
            rand::random(),
            recovery::max(),
        );
        match action {
            recovery::Action::Resume(recovery) => self.recover(stored, recovery),
            recovery::Action::Escalate(why) => self.fail_to_start(
                stored,
                &format!(
                    "{message}. Not restarted automatically: {why}. Decide: continue it with instructions \
                     (message_agent), split the work, or cancel it."
                ),
                from_queue,
            ),
            recovery::Action::Finish => self.fail_to_start(stored, message, from_queue),
        }
    }

    /// The handoff gathered for the task's fresh restart at this attempt; else starts gathering it, off the lock, which
    /// runs the queue again once it is in.
    fn handoff_ready(self: &Arc<Self>, task: &Task) -> Option<String> {
        let attempt = task.attempt.get();
        {
            let mut handoffs = self.handoffs.lock().unwrap();
            match handoffs.get(&task.task_id) {
                Some((at, ready)) if *at == attempt => return ready.clone(),
                _ => handoffs.insert(task.task_id.clone(), (attempt, None)),
            };
        }
        let (tasks, task) = (self.clone(), task.clone());
        tokio::spawn(async move {
            let (Some(thread), Some(recovery)) = (&task.thread_ref, &task.recovery) else {
                return;
            };
            let handoff = tasks.handoff(&task, thread, recovery).await;
            let mut handoffs = tasks.handoffs.lock().unwrap();
            // Unless the task ended, or moved on to another attempt, meanwhile.
            if handoffs
                .get(&task.task_id)
                .is_some_and(|(at, _)| *at == attempt)
            {
                handoffs.insert(task.task_id.clone(), (attempt, Some(handoff)));
                drop(handoffs);
                tasks.retry_later();
            }
        });
        None
    }

    /// `step`, or `None` once it took HANDOFF_STEP_TIMEOUT of the hub's clock: a node that doesn't answer delays a fresh
    /// restart by that much, and holds up nothing else.
    async fn bounded<T>(&self, step: impl std::future::Future<Output = Option<T>>) -> Option<T> {
        let timeout = self.d.clock.sleep(HANDOFF_STEP_TIMEOUT);
        tokio::select! {
            out = step => out,
            () = timeout => None,
        }
    }

    /// `task.handoff` from the earlier thread: its last words, and from git (any project) the branch's commits, what is
    /// uncommitted and its PR. What the node can't tell reads as such, and the agent checks git itself.
    async fn handoff(&self, task: &Task, thread: &ThreadRef, recovery: &TaskRecovery) -> String {
        let tail = self
            .d
            .store
            .thread_get(thread)
            .ok()
            .flatten()
            .map(|t| t.thread.latest_message_tail.as_str().trim().to_owned())
            .filter(|t| !t.is_empty())
            .map_or_else(|| "(none)".to_owned(), |t| tail_of(&t, HANDOFF_TAIL));
        let changes = if task.kind == TaskKind::Write {
            self.bounded(self.d.ports.changes(thread)).await
        } else {
            None
        };
        let path = changes
            .as_ref()
            .and_then(|c| c.worktree_path.clone())
            .or_else(|| task.worktree_path.as_ref().map(|p| p.as_str().to_owned()));
        let branch = changes
            .as_ref()
            .and_then(|c| c.branch.clone())
            .or_else(|| task.branch.as_ref().map(|b| b.as_str().to_owned()));
        let git = |argv: &[&str]| {
            let argv = argv.iter().map(|a| (*a).to_owned()).collect();
            let path = path.clone();
            async move {
                let path = path?;
                let out = self
                    .bounded(
                        self.d
                            .ports
                            .run_command(&thread.machine_id, &path, argv, 30),
                    )
                    .await
                    .filter(|o| o.exit_code == Some(0))?;
                let out = out.output_tail.trim().to_owned();
                Some(if out.is_empty() {
                    "none".to_owned()
                } else {
                    out
                })
            }
        };
        let unknown = || "(fleetd could not read them)".to_owned();
        let (commits, uncommitted, workspace) = match (&path, &branch) {
            (Some(path), Some(branch)) => {
                // The branch's own commits: not on any remote's copy of another branch, so pushed ones count too.
                let exclude = format!("--exclude=*/{branch}");
                let commits = git(&[
                    "git",
                    "log",
                    "--oneline",
                    "-n",
                    "20",
                    "HEAD",
                    "--not",
                    &exclude,
                    "--remotes",
                ])
                .await
                .unwrap_or_else(unknown);
                let uncommitted = git(&["git", "status", "--short"])
                    .await
                    .unwrap_or_else(unknown);
                (
                    commits,
                    uncommitted,
                    format!("You work in its worktree {path}, on its branch {branch}."),
                )
            }
            _ => (
                "none".to_owned(),
                "none".to_owned(),
                "It changed no files.".to_owned(),
            ),
        };
        // The branch's PR as a finished task's result links it (D67), never the last URL in the thread's words.
        let pr = match task.kind {
            TaskKind::Write => self.bounded(self.look_up_pr(task)).await.and_then(|l| l.pr),
            _ => None,
        }
        .unwrap_or_else(|| "none".to_owned());
        let why = match recovery.last_cause {
            RunEnd::ContextFull => "its context filled up again after `/compact`".to_owned(),
            _ => recovery.last_cause_text.as_str().to_owned(),
        };
        let set = self
            .d
            .db
            .prompts()
            .for_thread(&thread.machine_id, thread.thread_id.as_str());
        set.render(
            "task.handoff",
            &[
                ("why", &why),
                ("workspace", &workspace),
                ("tail", &tail),
                ("commits", &commits),
                ("uncommitted", &uncommitted),
                ("pr", &pr),
            ],
        )
    }

    /// The `task.recover` note a resume starts with: why the run ended and what it was doing.
    fn recover_note(
        &self,
        thread: &ThreadRef,
        recovery: &fleetd_contracts::tasks::TaskRecovery,
        doing: &str,
    ) -> String {
        let set = self
            .d
            .db
            .prompts()
            .for_thread(&thread.machine_id, thread.thread_id.as_str());
        set.render(
            "task.recover",
            &[
                ("cause", &recovery.last_cause_text.as_str()),
                ("doing", &doing),
                ("used", &recovery::used(recovery)),
            ],
        )
    }

    /// Runs the queue once a recovery's delay is over.
    fn resume_at(self: &Arc<Self>, recovery: Option<&fleetd_contracts::tasks::TaskRecovery>) {
        let Some(at) = recovery
            .and_then(|r| r.next_at.as_ref())
            .and_then(|at| parse_ms(at.as_str()))
        else {
            return;
        };
        let wait = (at - now_ms(self.d.clock.as_ref())).max(0) as u64;
        let (tasks, sleep) = (
            Arc::downgrade(self),
            self.d.clock.sleep(std::time::Duration::from_millis(wait)),
        );
        tokio::spawn(async move {
            sleep.await;
            if let Some(tasks) = tasks.upgrade() {
                tasks.retry_later();
            }
        });
    }

    /// Sends a message held for the task into the run a person started in its thread; its lead is told when it can't.
    async fn deliver(&self, task: &Task, thread: &ThreadRef, text: &str) {
        let id = request_id(task, &["msg", &random_uuid()]);
        let steer = crate::hub::steer::take_held(&self.d.db, task.task_id.as_str(), thread, &id);
        let sent = match &steer {
            Some(steer) => {
                self.d
                    .ports
                    .send_steer(thread, text, &id, steer.clone())
                    .await
            }
            None => self.d.ports.send(thread, text, &id).await,
        };
        let Err(error) = sent else {
            return;
        };
        if let Some(steer) = &steer {
            crate::hub::steer::rehold(&self.d.db, &steer.id);
        }
        let why = match error {
            PortError::Offline => format!("{} is offline", thread.machine_id.as_str()),
            PortError::Failed(message) => message,
        };
        tracing::warn!(
            task_id = task.task_id.as_str(),
            why,
            "held message not delivered"
        );
        let line = render::task_message_not_sent_lines(task, &why, text);
        self.d
            .ports
            .wake(&task.project_ref, WakeKind::TaskResult, line);
    }

    /// Whether the task's work is over, so a dead run of it isn't resumed: it was cancelled, its workstream is closed,
    /// its PR merged, or its plan item done or dropped.
    fn stopped(&self, task: &Task) -> Result<bool, StoreError> {
        if task.state == TaskState::Cancelled
            || self
                .workstream(&task.workstream_id)
                .is_none_or(|w| w.state != fleetd_contracts::ledger::WorkstreamState::Open)
        {
            return Ok(true);
        }
        let merged = self.db(|c| {
            c.prepare_cached(
                "SELECT EXISTS (SELECT 1 FROM events WHERE type = 'pr.merged' AND json_extract(data, '$.data.taskId') = ?)",
            )?
            .query_row([task.task_id.as_str()], |r| r.get::<_, bool>(0))
        })?;
        let item_over = match &task.item_id {
            Some(item) => self
                .db(|c| {
                    crate::hub::plan::store::item_get(c, crate::hub::plan::number(item.as_str()))
                })?
                .is_some_and(|i| i.state != fleetd_contracts::plan::PlanItemState::Open),
            None => false,
        };
        Ok(merged || item_over)
    }

    /// Runs again the pending PR lookups (of the machine's tasks, or all): at start, for those a hub restart cut
    /// off; when a machine links, for those its absence held up; and every PR_LOOKUP_RETRY for an unread host.
    fn resume_pr_lookups(self: &Arc<Self>, machine_id: Option<&MachineId>) {
        match self.db(TaskRecords::pr_lookups) {
            Ok(tasks) => tasks
                .into_iter()
                .filter(|t| machine_id.is_none_or(|m| t.project_ref.machine_id == *m))
                .for_each(|t| self.resolve_pr(t.task_id)),
            Err(error) => tracing::warn!(%error, "tasks: pending PR lookups not read"),
        }
    }

    /// D67: a finished writer's PR is the host's PR for its branch; unread, a URL in its report (a reader's too) on
    /// the project's own remote. Resolved off the lock (the report's actions, a node git call, a host read, each
    /// bounded by PR_LOOKUP_TIMEOUT), then set with a short re-lock on the result the task ended with. The lead gets
    /// a quiet line and the train is told. The task stays marked pending until a definite answer (a node that can't
    /// say, or an unread host with nothing to fall back on, is tried again), or PR_LOOKUP_GIVE_UP after it ended;
    /// nothing found leaves it empty.
    fn resolve_pr(self: &Arc<Self>, task_id: TaskId) {
        if !self.looking_up.lock().unwrap().insert(task_id.clone()) {
            return;
        }
        let tasks = self.clone();
        tokio::spawn(async move {
            let found = tasks.resolve_pr_once(&task_id).await;
            tasks.looking_up.lock().unwrap().remove(&task_id);
            if found {
                tasks.d.ports.pr_found(&task_id);
            }
        });
    }

    async fn resolve_pr_once(&self, task_id: &TaskId) -> bool {
        let Ok(Some(StoredTask { task, .. })) = self.db(|c| TaskRecords::get(c, task_id)) else {
            return false;
        };
        let at = task.result.as_ref().map(|r| r.at.clone());
        let answer = self.look_up_pr(&task).await.or_else(|| {
            let ended = task.ended_at.as_ref().and_then(|e| parse_ms(e.as_str()))?;
            let late =
                now_ms(self.d.clock.as_ref()) - ended >= PR_LOOKUP_GIVE_UP.as_millis() as i64;
            late.then_some(Lookup::default())
        });
        let Some(answer) = answer else {
            return false;
        };
        let _guard = self.lock.lock().await;
        self.settle_pr(task_id, at.as_ref(), answer)
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "tasks: PR not set");
                false
            })
    }

    /// A writer's PR, or `None` when the node or the host couldn't say yet.
    async fn look_up_pr(&self, task: &Task) -> Option<Lookup> {
        let mut texts: Vec<String> = Vec::new();
        if let Some(thread) = &task.thread_ref {
            let actions =
                tokio::time::timeout(PR_LOOKUP_TIMEOUT, self.d.ports.action_texts(thread, 30))
                    .await;
            for (summary, output_tail) in actions.unwrap_or_default().into_iter().rev() {
                texts.push(summary);
                texts.extend(output_tail);
            }
        }
        if let Some(result) = &task.result {
            texts.push(result.tail.as_str().to_owned());
        }
        let texts = || texts.iter().map(String::as_str);
        let remote = tokio::time::timeout(PR_LOOKUP_TIMEOUT, self.origin(&task.project_ref))
            .await
            .ok()
            .flatten()?;
        let Some(remote) = remote else {
            return Some(Lookup::default());
        };
        let unread = || PortError::Failed("the host was not read".into());
        let Some(branch) = &task.branch else {
            let pr = pr::task_pr_url(Err(unread()), Some(&remote), texts());
            return Some(Lookup { pr, skipped: None });
        };
        let host = tokio::time::timeout(
            PR_LOOKUP_TIMEOUT,
            self.d.ports.branch_pr(&remote, branch.as_str()),
        )
        .await
        .unwrap_or_else(|_| Err(BranchPrError::Unread("the host did not answer".into())));
        let (host, retry, skipped) = match host {
            Ok(found) => (Ok(found), false, None),
            Err(BranchPrError::Unread(_)) => (Err(unread()), true, None),
            Err(BranchPrError::Refused(why)) => (Err(unread()), false, Some(why)),
            Err(BranchPrError::NoReader) => (Err(unread()), false, None),
        };
        let pr = pr::task_pr_url(host, Some(&remote), texts());
        // An unread host with nothing on the remote in the report: try again.
        if pr.is_none() && retry {
            return None;
        }
        let skipped = skipped.filter(|_| pr.is_none());
        Some(Lookup { pr, skipped })
    }

    /// Clears the pending mark and sets the PR on the result the task ended with (`at`), if it still is the task's;
    /// whether it was set. Call with the lock held.
    fn settle_pr(
        &self,
        task_id: &TaskId,
        at: Option<&Timestamp>,
        lookup: Lookup,
    ) -> Result<bool, StoreError> {
        let Some(mut stored) = self.db(|c| TaskRecords::get(c, task_id))? else {
            return Ok(false);
        };
        // Continued and ended again since: that end's own lookup settles it.
        let Some(result) = stored.task.result.as_mut().filter(|r| Some(&r.at) == at) else {
            return Ok(false);
        };
        if !self.db(|c| TaskRecords::pr_lookup_pending(c, task_id))? {
            return Ok(false);
        }
        self.db(|c| TaskRecords::set_pr_lookup(c, task_id, false))?;
        let Some(pr_url) = lookup.pr else {
            if let Some(why) = lookup.skipped {
                let text = render::task_pr_skipped_lines(task_id.as_str(), &why);
                let project_ref = &stored.task.project_ref;
                self.d.ports.wake(project_ref, WakeKind::Quiet, text);
            }
            return Ok(false);
        };
        result.pr_url = Some(PrUrl::unchecked(pr_url.clone()));
        self.put(&stored)?;
        let task = &stored.task;
        let text = render::task_pr_lines(task.task_id.as_str(), &pr_url);
        self.d.ports.wake(&task.project_ref, WakeKind::Quiet, text);
        Ok(true)
    }

    async fn on_thread_event(self: &Arc<Self>, event: &HubEvent) -> Result<(), StoreError> {
        match event.r#type {
            HubEventType::UsageResumed | HubEventType::MachineGuard => {
                self.retry_queue().await;
                return Ok(());
            }
            HubEventType::PrMerged => return self.merged(event),
            HubEventType::MachineOnline => {
                self.resume_pr_lookups(event.machine_id.as_ref());
                return Ok(());
            }
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
        // A thread the task was restarted fresh from: whatever it reports, the task has moved on.
        if task.thread_ref.as_ref() != Some(&thread_ref) {
            tracing::info!(
                task_id = task.task_id.as_str(),
                seq = event.seq.get(),
                "task event for an earlier thread ignored"
            );
            return Ok(());
        }
        // An earlier run's end is not this run's: the task goes on.
        let live = matches!(task.state, TaskState::Running | TaskState::Idle)
            && !self.earlier_run(task, &thread_ref, event)?;
        match event.r#type {
            HubEventType::ThreadStarted if live && task.state == TaskState::Running => {
                // The run fleetd resumed it in: its lead reads of it in its next wake. A node that had to rebuild the
                // worktree for it has said so by now.
                let Some((doing, before)) = self.resumed.lock().unwrap().remove(&task.task_id)
                else {
                    return Ok(());
                };
                let Some(recovery) = &task.recovery else {
                    return Ok(());
                };
                let rebuilt = self
                    .d
                    .ports
                    .recreated_from(&thread_ref)
                    .filter(|now| Some(now) != before.as_ref())
                    .map(|(from, _)| from);
                let line = render::task_recovered_lines(task, recovery, &doing, rebuilt);
                self.d
                    .ports
                    .wake(&task.project_ref, WakeKind::Recovery, line);
            }
            HubEventType::ThreadStarted => {
                // Continued outside `task message`: the usage layer's continue, or a human writing to the thread. One
                // waiting to resume after a death is continued by it, and its note isn't sent too.
                let recovering = task.state == TaskState::Queued
                    && task.recovery.as_ref().is_some_and(|r| r.next_at.is_some());
                if !recovering
                    && !matches!(
                        task.state,
                        TaskState::Done | TaskState::Failed | TaskState::Idle
                    )
                {
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
                if recovering {
                    tracing::info!(
                        task_id = task.task_id.as_str(),
                        "recovering task continued in its thread; its note is not sent"
                    );
                    next.queued_reason = None;
                }
                let held = stored.pending_message.clone().filter(|_| recovering);
                // A person continued it, not fleetd (the usage layer's continue of a parked task aside): the digest no
                // longer says it was resumed automatically.
                if (recovering || task.parked.is_none())
                    && let Some(recovery) = &mut next.recovery
                {
                    recovery.next_at = None;
                    recovery.resumed_at = None;
                }
                self.put(&StoredTask {
                    task: next.clone(),
                    pending_message: None,
                })?;
                // What was sent to it while it waited goes to the run that continued it, never dropped.
                if let Some(text) = held {
                    self.deliver(&next, &thread_ref, &text).await;
                }
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
            // Its `/compact` completed: the note to continue goes now, as the recovery it is.
            HubEventType::ThreadCompleted
                if live
                    && task.recovery.as_ref().is_some_and(|r| {
                        r.mode == RecoveryMode::Compact && r.next_at.is_none()
                    }) =>
            {
                let mut next = task.clone();
                next.attempt = Int::unchecked(next.attempt.get() + 1);
                if let Some(recovery) = &mut next.recovery {
                    recovery.mode = RecoveryMode::Resume;
                    recovery.last_cause_text =
                        Text::unchecked("its context was full; fleetd compacted it".to_owned());
                    recovery.next_at = Some(Timestamp(self.now_iso()));
                }
                tracing::info!(task_id = task.task_id.as_str(), "compacted task resumes");
                self.try_start(
                    StoredTask {
                        task: next,
                        pending_message: stored.pending_message.clone(),
                    },
                    true,
                )
                .await;
            }
            HubEventType::ThreadCompleted if live => {
                // An agent there got its work done: the machine is fine again.
                self.close_breaker(machine_id, Some(task))?;
                let end = end_cause(event).or(Some(RunEnd::Completed));
                self.finish(&stored, TaskResultStatus::Done, None, end, None)
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
                self.died(&stored, &thread_ref, event).await?
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
            self.d.slots.agents(r).max_agents,
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
            previous_threads: Vec::new(),
            branch: None,
            base: None,
            worktree_path: None,
            parked: None,
            attempt: Int::unchecked(1),
            recovery: None,
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
        let bind = self.d.ports.work_bind(r);
        // However the read ends (done, panicked or cancelled), the project is free to be read again.
        let reading = Reading {
            projects: self.binding.clone(),
            project: r.clone(),
        };
        let mut bound = tokio::spawn(async move {
            let bound = bind.await;
            if let Err(error) = &bound {
                tracing::warn!(%error, project = %reading.project.project_id, "tasks: repo and base not read");
            }
            drop(reading);
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
                // A recovering task resumes now (once a node just back has settled), with the note and this: the lead's
                // call stands.
                let mut next = task.clone();
                let recovering =
                    recovery::waiting(next.recovery.as_ref(), now_ms(self.d.clock.as_ref()));
                if let Some(recovery) = next.recovery.as_mut().filter(|_| recovering) {
                    recovery.next_at = Some(Timestamp(self.now_iso()));
                }
                // Over the machine's breaker too.
                let held = self.held(&task);
                self.breakers.lock().unwrap().release(task_id);
                self.put(&StoredTask {
                    task: next.clone(),
                    pending_message: Some(pending),
                })
                .map_err(store_error)?;
                if recovering || held {
                    // An answer to its question goes with the resume.
                    self.asking.lock().unwrap().remove(task_id);
                    self.retry_later();
                    return Ok(next);
                }
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
                // The lead continued it: a death like the last one is resumed again, within the same cap, and this run
                // is the lead's, not an automatic resume.
                if let Some(recovery) = &mut next.recovery {
                    recovery.signature = None;
                    recovery.resumed_at = None;
                }
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
        if task.kind != TaskKind::Write {
            self.remove_worktree(&next);
        }
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
            && task.kind == TaskKind::Write
            && matches!(task.state, TaskState::Done | TaskState::Failed)
        {
            self.remove_worktree(&task);
        }
        Ok(())
    }

    /// Has the node stop a task's agent and delete its worktree, and the build output in it, off the lock. A node that
    /// can't (offline, a git error, or a writer's work that exists only there) leaves it, logged.
    fn remove_worktree(self: &Arc<Self>, task: &Task) {
        let Some(thread) = task.thread_ref.clone() else {
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
/// A writer's settled PR lookup: its PR, or why the host refused it.
#[derive(Default)]
struct Lookup {
    pr: Option<String>,
    skipped: Option<String>,
}

/// Each step of a finished task's PR lookup: reading its report, its `origin`, the host.
const PR_LOOKUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// How often pending PR lookups run again, and when one with no answer yet is given up on.
const PR_LOOKUP_RETRY: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const PR_LOOKUP_GIVE_UP: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

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
        let offline = self.offline_since();
        let offline = |machine: &str| offline.get(machine).cloned();
        match self.db(|c| TaskRecords::for_digest(c, project_ref, since, limit)) {
            Ok(tasks) => render::task_digest_lines(&tasks, since, &self.now_iso(), &offline),
            Err(error) => {
                tracing::warn!(%error, "tasks: digest lines not read");
                Vec::new()
            }
        }
    }

    /// Every offline machine, with when its offline spell started.
    fn offline_machines(&self) -> Vec<(MachineId, String)> {
        match self.d.store.machines_list() {
            Ok(machines) => machines
                .into_iter()
                .filter(|m| m.status == fleetd_contracts::model::MachineStatus::Offline)
                .map(|m| (m.machine_id, m.last_seen_at.0))
                .collect(),
            Err(error) => {
                tracing::warn!(%error, "tasks: machines not read");
                Vec::new()
            }
        }
    }

    /// Offline machines by id, with the `HH:MM` their spell started at.
    fn offline_since(&self) -> HashMap<String, String> {
        self.offline_machines()
            .into_iter()
            .map(|(m, since)| {
                let at = since.get(11..16).unwrap_or(&since).to_owned();
                (m.as_str().to_owned(), at)
            })
            .collect()
    }

    /// The sweep's check: a running task whose machine has been offline for `recovery::UNREACHABLE_MS` gets one quiet
    /// line to its lead per offline spell. It keeps its slot and resumes when the machine is back; tasks never move.
    pub fn unreachable(&self) -> Result<(), StoreError> {
        let now = now_ms(self.d.clock.as_ref());
        let offline = self.offline_machines();
        let mut told = self.unreachable.lock().unwrap();
        // A spell that ended is forgotten, so the next one is told again.
        told.retain(|_, (machine, since)| offline.iter().any(|(m, s)| m == machine && s == since));
        for (machine, since) in &offline {
            let Some(away) = parse_ms(since).map(|at| now - at) else {
                continue;
            };
            if away < recovery::UNREACHABLE_MS {
                continue;
            }
            for task in self.db(|c| TaskRecords::running_on(c, machine.as_str()))? {
                if told.contains_key(&task.task_id) {
                    continue;
                }
                told.insert(task.task_id.clone(), (machine.clone(), since.clone()));
                let line = render::task_unreachable_lines(&task, away / 60_000);
                self.d
                    .ports
                    .wake(&task.project_ref, WakeKind::Recovery, line);
            }
        }
        Ok(())
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
            source: match agents.source {
                crate::hub::slots::MaxSource::Project => "max agents set".to_owned(),
                crate::hub::slots::MaxSource::Machine => "machine cap set".to_owned(),
                crate::hub::slots::MaxSource::Auto(why) => format!("auto: {why}"),
            },
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
        /// A read that panics.
        bind_panics: std::sync::atomic::AtomicBool,
        /// `git remote get-url origin` in the project's checkout; unread when `None`.
        origin: Mutex<Option<String>>,
        /// The host's PR for a branch: `None` hangs, as a host that never answers.
        host_pr: Mutex<Option<Result<Option<String>, BranchPrError>>>,
        looked_up: Mutex<Vec<(String, String)>>,
        /// Told on each host lookup and each `pr_found`.
        looking: tokio::sync::Notify,
        origin_asked: tokio::sync::Notify,
        /// What each thread did, newest first, as `action_texts` reads it.
        actions: Mutex<Vec<(String, Option<String>)>>,
        found: tokio::sync::Notify,
        pr_found: Mutex<Vec<TaskId>>,
        wakes: Mutex<Vec<(WakeKind, String)>>,
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
            launched.push(request.worktree.and_then(|w| w.branch));
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
        fn detached_worktrees(&self, _: &MachineId) -> bool {
            true
        }
        fn action_texts<'a>(
            &'a self,
            _: &'a ThreadRef,
            _: usize,
        ) -> BoxFut<'a, Vec<(String, Option<String>)>> {
            let actions = self.actions.lock().unwrap().clone();
            Box::pin(async move { actions })
        }
        fn default_branch<'a>(
            &'a self,
            _: &'a MachineId,
            _: &'a str,
        ) -> BoxFut<'a, Result<Option<String>, PortError>> {
            Box::pin(async { Ok(Some("main".to_owned())) })
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
        fn pr_found(&self, task_id: &TaskId) {
            self.pr_found.lock().unwrap().push(task_id.clone());
            self.found.notify_one();
        }
        fn branch_pr<'a>(
            &'a self,
            remote: &'a str,
            branch: &'a str,
        ) -> BoxFut<'a, Result<Option<String>, BranchPrError>> {
            self.looked_up
                .lock()
                .unwrap()
                .push((remote.to_owned(), branch.to_owned()));
            self.looking.notify_one();
            let answer = self.host_pr.lock().unwrap().clone();
            Box::pin(async move {
                match answer {
                    Some(answer) => answer,
                    None => std::future::pending().await,
                }
            })
        }
        fn run_command<'a>(
            &'a self,
            _: &'a MachineId,
            _: &'a str,
            _: Vec<String>,
            _: u32,
        ) -> BoxFut<'a, Option<CmdOutput>> {
            // An offline node runs nothing.
            let origin = self
                .origin
                .lock()
                .unwrap()
                .clone()
                .filter(|_| !self.offline());
            self.origin_asked.notify_one();
            Box::pin(async move {
                origin.map(|url| CmdOutput {
                    exit_code: Some(0),
                    output_tail: format!("{url}\n"),
                })
            })
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
        fn wake(&self, _: &ProjectRef, kind: WakeKind, text: String) {
            self.wakes.lock().unwrap().push((kind, text));
        }
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
            let panics = self.bind_panics.load(SeqCst);
            let (scope, gate) = (self.scope.clone(), self.bind_gate.clone());
            Box::pin(async move {
                if panics {
                    panic!("the read panicked");
                }
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
        let slots = Slots::new(db.clone(), clock.clone(), &store, &events).unwrap();
        // A 32-CPU, 128 GB machine, so its cap (28) doesn't hold these tests' agents back.
        let mut load = crate::hub::link::guard::tests::load(500, 1.0);
        load.mem_total_bytes = Some(fleetd_contracts::prim::Count::unchecked(128 << 30));
        slots
            .observe_machine(&MachineId::unchecked("lab-a"), "lab-a", &load)
            .unwrap();
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

    /// A read that panics still frees its project: the next spawn there reads again rather than skipping the check
    /// as "being read" until the hub restarts.
    #[tokio::test]
    async fn a_read_that_panics_frees_its_project() {
        use std::sync::atomic::Ordering::SeqCst;
        let (tasks, node) = tasks();
        node.bind_panics.store(true, SeqCst);
        let caller = TaskCaller {
            project_ref: ProjectRef {
                machine_id: MachineId::unchecked("lab-a"),
                project_id: ProjectId::unchecked("p1"),
            },
            by: "lead".into(),
        };
        let first = tasks
            .spawn_noted(&caller, writer("add the docs page"))
            .await
            .unwrap();
        assert_eq!(first.note.as_deref(), Some(duplicates::UNBOUND));
        assert!(tasks.binding.lock().unwrap().is_empty());

        node.bind_panics.store(false, SeqCst);
        let second = tasks
            .spawn_noted(&caller, writer("fix the api"))
            .await
            .unwrap();
        assert_eq!(second.note, None, "read again, and checked");
        assert_eq!(node.binds.load(SeqCst), 2);
    }

    /// Ends the task as its thread's completion does.
    async fn complete(tasks: &Arc<Tasks>, task: &Task) {
        let stored = tasks
            .db(|c| TaskRecords::get(c, &task.task_id))
            .unwrap()
            .unwrap();
        let _guard = tasks.lock.lock().await;
        tasks
            .finish(
                &stored,
                TaskResultStatus::Done,
                None,
                Some(RunEnd::Completed),
                None,
            )
            .await
            .unwrap();
    }

    fn result_pr(tasks: &Tasks, task: &Task) -> Option<String> {
        let task = tasks.get(&task.task_id).unwrap().unwrap();
        task.result?.pr_url.map(|p| p.as_str().to_owned())
    }

    fn pending(tasks: &Tasks, task: &Task) -> bool {
        tasks
            .db(|c| TaskRecords::pr_lookup_pending(c, &task.task_id))
            .unwrap()
    }

    async fn told(notify: &tokio::sync::Notify, what: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(5), notify.notified())
            .await
            .unwrap_or_else(|_| panic!("{what}"));
    }

    /// D67: a writer's PR is the host's PR for its branch, even when its report never names it. It is set once the
    /// task has ended, the lead gets it as a quiet line, and the train is told.
    #[tokio::test]
    async fn a_finished_writer_gets_its_branchs_pr_from_the_host() {
        let (tasks, node) = tasks();
        *node.origin.lock().unwrap() = Some("git@github.com:acme/shop.git".into());
        let pr = "https://github.com/acme/shop/pull/5";
        *node.host_pr.lock().unwrap() = Some(Ok(Some(pr.into())));
        let writer = tasks
            .spawn(&lead(), writer("add the docs page"))
            .await
            .unwrap();
        complete(&tasks, &writer).await;
        assert_eq!(
            tasks.get(&writer.task_id).unwrap().unwrap().state,
            TaskState::Done
        );

        told(&node.found, "the train is told of the PR").await;
        assert_eq!(result_pr(&tasks, &writer).as_deref(), Some(pr));
        assert!(!pending(&tasks, &writer), "the lookup settled");
        assert_eq!(
            *node.looked_up.lock().unwrap(),
            [(
                "github.com/acme/shop".to_owned(),
                "fleetd/T1-add-the-docs-page".to_owned()
            )]
        );
        assert_eq!(
            *node.pr_found.lock().unwrap(),
            std::slice::from_ref(&writer.task_id)
        );
        let wakes = node.wakes.lock().unwrap().clone();
        assert_eq!(
            wakes.last(),
            Some(&(
                WakeKind::Quiet,
                "- T1's PR: https://github.com/acme/shop/pull/5".to_owned()
            )),
            "{wakes:?}"
        );
    }

    /// The lookup runs off the tasks lock: a host that never answers holds up neither the task's end nor a spawn.
    /// It stays pending, and a hub restart runs it again.
    #[tokio::test]
    async fn a_hanging_pr_lookup_blocks_no_spawn_and_a_restart_runs_it_again() {
        let (tasks, node) = tasks();
        *node.origin.lock().unwrap() = Some("https://github.com/acme/shop.git".into());
        let first = tasks
            .spawn(&lead(), writer("add the docs page"))
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), complete(&tasks, &first))
            .await
            .expect("the task ends without waiting on its PR");
        told(&node.looking, "the lookup starts").await;

        let second = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tasks.spawn(&lead(), writer("fix the api")),
        )
        .await
        .expect("the spawn waits on no PR lookup")
        .unwrap();
        assert_eq!(second.state, TaskState::Running);
        assert_eq!(result_pr(&tasks, &first), None);
        assert!(pending(&tasks, &first));

        // The hub restarts (the hanging job is the one it lost), and now the host answers.
        tasks.looking_up.lock().unwrap().clear();
        let pr = "https://github.com/acme/shop/pull/6";
        *node.host_pr.lock().unwrap() = Some(Ok(Some(pr.into())));
        tasks.resume_pr_lookups(None);
        told(&node.found, "the retried lookup finds the PR").await;
        assert_eq!(result_pr(&tasks, &first).as_deref(), Some(pr));
        assert!(!pending(&tasks, &first));
    }

    /// Lets the PR lookup jobs spawned so far run to their end.
    async fn lookups_done(tasks: &Tasks) {
        for _ in 0..10_000 {
            if tasks.looking_up.lock().unwrap().is_empty() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("a PR lookup never ended");
    }

    /// At a hub restart the node has not linked yet: its `origin` can't be read, so the lookup stays pending, and
    /// runs again when the machine comes online. An unread host keeps it pending too.
    #[tokio::test]
    async fn a_lookup_the_node_or_host_could_not_answer_stays_pending_until_the_machine_links() {
        let (tasks, node) = tasks();
        *node.origin.lock().unwrap() = Some("https://github.com/acme/shop.git".into());
        *node.host_pr.lock().unwrap() = Some(Err(BranchPrError::Unread("network".into())));
        let writer = tasks
            .spawn(&lead(), writer("add the docs page"))
            .await
            .unwrap();
        complete(&tasks, &writer).await;
        told(&node.looking, "the host is asked").await;
        lookups_done(&tasks).await;
        assert!(pending(&tasks, &writer), "an unread host is no answer");

        // The hub restarts before the node links.
        node.offline
            .store(true, std::sync::atomic::Ordering::SeqCst);
        tasks.resume_pr_lookups(None);
        told(&node.origin_asked, "the origin is asked").await;
        lookups_done(&tasks).await;
        assert!(pending(&tasks, &writer), "an offline node is no answer");
        assert_eq!(result_pr(&tasks, &writer), None);

        // The node links, and the host answers now.
        node.offline
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let pr = "https://github.com/acme/shop/pull/8";
        *node.host_pr.lock().unwrap() = Some(Ok(Some(pr.into())));
        let online: HubEvent = serde_json::from_value(json!({
            "seq": 1, "at": AT, "type": "machine.online", "machineId": "lab-a", "summary": "lab-a online",
        }))
        .unwrap();
        tasks.on_thread_event(&online).await.unwrap();
        told(&node.found, "the lookup runs when the machine links").await;
        assert_eq!(result_pr(&tasks, &writer).as_deref(), Some(pr));
        assert!(!pending(&tasks, &writer));
    }

    /// A reader's result carries the PR it was given or none, never one its report links, even on the project's
    /// own repo (D130), and nothing is looked up for it.
    #[tokio::test]
    async fn a_readers_result_takes_no_pr_from_its_report() {
        let (tasks, node) = tasks();
        *node.origin.lock().unwrap() = Some("https://github.com/acme/shop.git".into());
        *node.host_pr.lock().unwrap() =
            Some(Ok(Some("https://github.com/acme/shop/pull/99".into())));
        *node.actions.lock().unwrap() = vec![(
            "gh pr view 8".into(),
            Some("https://github.com/acme/shop/pull/8 is the one that broke it".into()),
        )];
        let reader: TaskSpawnCall = serde_json::from_value(json!({
            "workstreamId": "W1", "title": "read the logs", "kind": "read", "prompt": "find why it broke",
        }))
        .unwrap();
        let reader = tasks.spawn(&lead(), reader).await.unwrap();
        complete(&tasks, &reader).await;
        lookups_done(&tasks).await;
        assert_eq!(result_pr(&tasks, &reader), None);
        assert!(!pending(&tasks, &reader), "no lookup for a reader");
        assert!(node.looked_up.lock().unwrap().is_empty());
        assert!(node.pr_found.lock().unwrap().is_empty());
    }

    /// The host refusing the lookup (gh not logged in, a 404) ends it at once with one quiet line saying why: it is
    /// not asked again every PR_LOOKUP_RETRY for a day.
    #[tokio::test]
    async fn a_refused_pr_lookup_ends_at_once_and_says_why() {
        let (tasks, node) = tasks();
        *node.origin.lock().unwrap() = Some("https://github.com/acme/shop.git".into());
        *node.host_pr.lock().unwrap() =
            Some(Err(BranchPrError::Refused("gh not logged in".into())));
        let writer = tasks
            .spawn(&lead(), writer("add the docs page"))
            .await
            .unwrap();
        complete(&tasks, &writer).await;
        told(&node.looking, "the host is asked").await;
        lookups_done(&tasks).await;
        assert!(!pending(&tasks, &writer), "a refusal settles the lookup");
        assert_eq!(result_pr(&tasks, &writer), None);
        assert!(node.pr_found.lock().unwrap().is_empty());
        let wakes = node.wakes.lock().unwrap().clone();
        let skipped: Vec<_> = wakes
            .iter()
            .filter(|(k, _)| *k == WakeKind::Quiet)
            .collect();
        assert_eq!(
            skipped,
            [&(
                WakeKind::Quiet,
                "- T1: PR lookup skipped: gh not logged in".to_owned()
            )]
        );

        tasks.resume_pr_lookups(None);
        lookups_done(&tasks).await;
        assert_eq!(node.looked_up.lock().unwrap().len(), 1, "not asked again");
    }

    /// A review's result names the PR it reviewed, in the record and in the lead's result line, at once: always its
    /// own `pr`, whatever PR URLs its output shows (T250 reviewed #442 and recorded a fixture it read in the diff).
    #[tokio::test]
    async fn a_finished_review_names_its_own_pr_whatever_its_output_shows() {
        let (tasks, node) = tasks();
        *node.origin.lock().unwrap() = Some("https://github.com/acme/shop.git".into());
        *node.host_pr.lock().unwrap() =
            Some(Ok(Some("https://github.com/acme/shop/pull/99".into())));
        *node.actions.lock().unwrap() = vec![
            (
                "Read the diff".into(),
                Some("+ const URL = \"https://github.com/o/testbed/pull/12\";".into()),
            ),
            (
                "gh pr view".into(),
                Some(
                    "see https://github.com/acme/shop/pull/8 and \
                      https://gitlab.example.com/group/shop/-/merge_requests/9"
                        .into(),
                ),
            ),
        ];
        let pr = "https://github.com/acme/shop/pull/7";
        let review: TaskSpawnCall = serde_json::from_value(json!({
            "workstreamId": "W1", "title": "review #7", "kind": "review", "prompt": "review it", "pr": pr,
        }))
        .unwrap();
        let review = tasks.spawn(&lead(), review).await.unwrap();
        complete(&tasks, &review).await;
        lookups_done(&tasks).await;
        assert_eq!(result_pr(&tasks, &review).as_deref(), Some(pr));
        let wakes = node.wakes.lock().unwrap();
        assert!(
            wakes
                .iter()
                .any(|(k, w)| *k == WakeKind::TaskResult && w.contains(&format!("PR {pr}"))),
            "{wakes:?}"
        );
        assert!(!pending(&tasks, &review), "no lookup for a review");
        assert!(node.looked_up.lock().unwrap().is_empty());
        assert!(node.pr_found.lock().unwrap().is_empty());
    }
}
