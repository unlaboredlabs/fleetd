//! Pure mapping from the node's machine stream (`fleetd_contracts::sessions::MachineEvent`) to the hub's
//! thread/project caches and derived events. The executor feeds every event through `apply_machine_event`; nothing
//! here does I/O.
use std::collections::{HashMap, HashSet};

use fleetd_contracts::sessions::{
    FailureClass, MachineEvent, PendingPermission, ProjectInfo, RunStatus, SessionStatus,
    SessionSummary,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::limit::{limit_data, limit_of_summary, normalize_iso};

/// The first `max` UTF-16 code units of `s`, as JS `slice(0, max)` (never splitting a character).
pub fn js_take(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `text` if it fits in `max` UTF-16 units, else "…" and its last `max - 1`.
pub fn keep_tail(text: &str, max: usize) -> String {
    let len = js_len(text);
    if len <= max {
        return text.to_owned();
    }
    let mut skip = len - max + 1;
    let mut start = 0;
    for (i, c) in text.char_indices() {
        if skip == 0 {
            start = i;
            break;
        }
        skip = skip.saturating_sub(c.len_utf16());
        start = i + c.len_utf8();
    }
    format!("…{}", &text[start..])
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastError {
    pub class: String,
    pub message: String,
}

/// The hub's ThreadSummary, field for field (contracts `ThreadSummary` round-trips through serde).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub machine_id: String,
    pub thread_id: String,
    pub project_id: String,
    pub title: String,
    pub status: String,
    pub headline: String,
    pub latest_message_tail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<LastError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_limit_reset_at: Option<String>,
    pub last_progress_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub stale: bool,
    pub as_of: String,
}

/// A thread row as stored: its summary plus the shell bookkeeping columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredThread {
    pub summary: Summary,
    pub last_sequence: Option<u64>,
    /// The session's latest run id when this row was written.
    pub last_run_id: Option<String>,
    /// That run's phase: a ThreadStatus, or "usage_limited".
    pub last_run_status: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ThreadCounts {
    pub running: u64,
    pub waiting: u64,
    pub idle: u64,
    pub failed: u64,
}

/// The hub's ProjectSummary, field for field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub machine_id: String,
    pub project_id: String,
    pub title: String,
    pub workspace_root: String,
    pub threads: ThreadCounts,
    pub last_activity_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackedThread {
    pub summary: Summary,
    /// The session's latest run; a new one in the same phase is still a transition. Unknown (None) after a hub
    /// restart; `Some(None)` is the node saying the session has no run.
    pub run_id: Option<Option<String>>,
    pub active_run_id: Option<String>,
    /// The active run is still queued or starting, so a message sent now is queued behind it.
    pub active_run_starting: bool,
    /// The permission prompt the run waits on.
    pub pending: Option<PendingPermission>,
}

impl TrackedThread {
    pub fn known_run(&self) -> Option<&str> {
        self.run_id.as_ref().and_then(|r| r.as_deref())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectMeta {
    pub title: String,
    pub workspace_root: String,
    pub updated_at: String,
}

/// One machine's view of the node's sessions. Holds summary rows only, never transcripts.
#[derive(Debug, Clone, Default)]
pub struct ShellState {
    pub cursor: Option<u64>,
    /// True once an authoritative snapshot has been applied, so every active thread is in `threads`.
    pub complete: bool,
    pub projects: HashMap<String, ProjectMeta>,
    pub threads: HashMap<String, TrackedThread>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EventType {
    Started,
    Waiting,
    Completed,
    Failed,
    Interrupted,
    UsageLimited,
}

impl EventType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "thread.started",
            Self::Waiting => "thread.waiting",
            Self::Completed => "thread.completed",
            Self::Failed => "thread.failed",
            Self::Interrupted => "thread.interrupted",
            Self::UsageLimited => "thread.usage_limited",
        }
    }
    fn verb(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "was interrupted",
            Self::Waiting => "is waiting for approval or input",
            Self::UsageLimited => "hit the usage limit",
        }
    }
    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Interrupted | Self::UsageLimited
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transition {
    pub kind: EventType,
    pub thread_id: String,
    /// The run ended while the hub was down: found by diffing a snapshot against the stored row.
    pub late: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Applied {
    /// Changed thread summaries, to upsert.
    pub threads: Vec<StoredThread>,
    /// Projects whose metadata or thread counts changed, to upsert.
    pub projects: Vec<ProjectRow>,
    pub transitions: Vec<Transition>,
    /// Set when the event moved the machine stream's cursor.
    pub cursor: Option<u64>,
    /// After a full snapshot: every session the node has. Stored rows of this machine outside it are stale.
    pub present: Option<HashSet<String>>,
}

pub struct ApplyContext<'a> {
    pub machine_id: &'a str,
    pub now: &'a str,
    /// Stored summaries for threads not yet in memory (after a hub restart).
    pub stored: &'a HashMap<String, StoredThread>,
    /// No cursor was ever stored for this machine: its first snapshot is a baseline and emits nothing.
    pub baseline: bool,
}

/// A hub event before the log gives it a `seq` (the store's append input, field for field).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDraft {
    pub at: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// A session's row as the hub's ThreadStatus: an active run is running, or waiting while a permission prompt is open;
/// otherwise the latest run's outcome.
pub fn thread_status(s: &SessionSummary) -> &'static str {
    let active = s.active_run_id.is_some()
        || matches!(s.status, SessionStatus::Running | SessionStatus::Waiting);
    if active {
        return if s.pending_permission.is_some() {
            "waiting"
        } else {
            "running"
        };
    }
    match s.latest_run.as_ref().map(|r| r.status) {
        Some(RunStatus::Completed) => "completed",
        Some(RunStatus::Failed) => "failed",
        Some(RunStatus::Interrupted) => "interrupted",
        _ => match s.status {
            SessionStatus::Failed => "failed",
            SessionStatus::Interrupted => "interrupted",
            _ => "idle",
        },
    }
}

/// The failure class as the hub's events and usage area name it.
pub fn failure_class(class: FailureClass) -> String {
    serde_json::to_value(class)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "other".into())
}

fn first_line(text: &str) -> String {
    js_take(text.trim().split('\n').next().unwrap_or(""), 280).to_owned()
}

/// Applies the latest visible assistant text.
pub fn with_assistant_text(summary: &Summary, text: Option<&str>) -> Summary {
    match text {
        Some(text) if !text.trim().is_empty() => Summary {
            headline: first_line(text),
            latest_message_tail: keep_tail(text, 4096),
            ..summary.clone()
        },
        _ => summary.clone(),
    }
}

pub fn to_thread_summary(
    machine_id: &str,
    s: &SessionSummary,
    prev: Option<&Summary>,
    now: &str,
) -> Summary {
    let failure = s.latest_run.as_ref().and_then(|r| r.failure.as_ref());
    let reset_at = failure
        .filter(|f| matches!(f.class, FailureClass::UsageLimit | FailureClass::RateLimit))
        .and_then(|f| f.reset_at.as_ref())
        .map(|r| normalize_iso(r.as_str()));
    let effort = serde_json::to_value(s.effort)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned));
    let base = Summary {
        machine_id: machine_id.to_owned(),
        thread_id: s.session_id.to_string(),
        project_id: s.project_id.to_string(),
        title: s.title.clone(),
        status: thread_status(s).to_owned(),
        headline: prev.map(|p| p.headline.clone()).unwrap_or_default(),
        latest_message_tail: prev
            .map(|p| p.latest_message_tail.clone())
            .unwrap_or_default(),
        last_error: failure.map(|f| LastError {
            class: failure_class(f.class),
            message: js_take(f.message.as_str(), 2000).to_owned(),
        }),
        usage_limit_reset_at: reset_at,
        last_progress_at: normalize_iso(s.updated_at.as_str()),
        model: Some(s.model.clone()),
        effort,
        stale: false,
        as_of: now.to_owned(),
    };
    with_assistant_text(&base, s.latest_assistant_tail.as_deref())
}

/// M4: a failure the node classed as a usage, rate or pool limit (or whose text says so) is a usage limit.
pub fn phase(s: &Summary) -> String {
    if limit_of_summary(s).is_some() {
        "usage_limited".to_owned()
    } else {
        s.status.clone()
    }
}

fn event_for(phase: &str) -> Option<EventType> {
    Some(match phase {
        "running" => EventType::Started,
        "waiting" => EventType::Waiting,
        "completed" => EventType::Completed,
        "failed" => EventType::Failed,
        "interrupted" => EventType::Interrupted,
        "usage_limited" => EventType::UsageLimited,
        _ => return None,
    })
}

/// The event a change from `prev` to `next` produces, if any. Unchanged phase and run produce none.
/// Run ids: `None` is unknown, `Some(None)` is no run.
pub fn transition(
    prev: Option<(&Summary, Option<&str>)>,
    next: (&Summary, Option<&str>),
) -> Option<EventType> {
    let to = phase(next.0);
    let Some((prev_summary, prev_run)) = prev else {
        return event_for(&to);
    };
    let from = phase(prev_summary);
    let new_run = matches!((prev_run, next.1), (Some(a), Some(b)) if a != b);
    if from == to && !new_run {
        return None;
    }
    // An approval being answered resumes the same run; that is not a new start.
    if from == "waiting" && to == "running" && !new_run {
        return None;
    }
    event_for(&to)
}

fn same_summary(a: &Summary, b: &Summary) -> bool {
    Summary {
        as_of: String::new(),
        ..a.clone()
    } == Summary {
        as_of: String::new(),
        ..b.clone()
    }
}

pub fn project_summary(
    state: &ShellState,
    machine_id: &str,
    project_id: &str,
) -> Option<ProjectRow> {
    let meta = state.projects.get(project_id)?;
    let mut threads = ThreadCounts::default();
    let mut last_activity_at = meta.updated_at.clone();
    for t in state.threads.values() {
        if t.summary.project_id != project_id {
            continue;
        }
        match t.summary.status.as_str() {
            "running" => threads.running += 1,
            "waiting" => threads.waiting += 1,
            "failed" => threads.failed += 1,
            _ => threads.idle += 1,
        }
        if t.summary.last_progress_at > last_activity_at {
            last_activity_at = t.summary.last_progress_at.clone();
        }
    }
    Some(ProjectRow {
        machine_id: machine_id.to_owned(),
        project_id: project_id.to_owned(),
        title: meta.title.clone(),
        workspace_root: meta.workspace_root.clone(),
        threads,
        last_activity_at,
    })
}

struct Applier<'s, 'c> {
    state: &'s mut ShellState,
    ctx: &'c ApplyContext<'c>,
    threads: Vec<StoredThread>,
    transitions: Vec<Transition>,
    /// Insertion-ordered.
    touched: Vec<String>,
    cursor: Option<u64>,
}

impl Applier<'_, '_> {
    fn touch(&mut self, project_id: &str) {
        if !self.touched.iter().any(|p| p == project_id) {
            self.touched.push(project_id.to_owned());
        }
    }

    fn advance(&mut self, seq: u64) {
        if self.state.cursor.is_none_or(|c| seq > c) {
            self.state.cursor = Some(seq);
            self.cursor = Some(seq);
        }
    }

    /// `quiet_if_new`: a thread seen for the first time produces no event (a baseline snapshot).
    /// `restart`: the first snapshot in this hub process, diffed against what an earlier one stored.
    fn upsert_thread(
        &mut self,
        session: &SessionSummary,
        sequence: Option<u64>,
        quiet_if_new: bool,
        restart: bool,
    ) {
        let id = session.session_id.to_string();
        let known = self.state.threads.get(&id).cloned();
        let stored = if known.is_none() {
            self.ctx.stored.get(&id)
        } else {
            None
        };
        let prev: Option<(Summary, Option<Option<String>>)> = match (&known, stored) {
            (Some(k), _) => Some((k.summary.clone(), k.run_id.clone())),
            // A stored row without a run id has an unknown run.
            (None, Some(s)) => Some((s.summary.clone(), s.last_run_id.clone().map(Some))),
            (None, None) => None,
        };
        let summary = to_thread_summary(
            self.ctx.machine_id,
            session,
            prev.as_ref().map(|p| &p.0),
            self.ctx.now,
        );
        let latest_run = session.latest_run.as_ref().map(|r| r.id.to_string());
        let active_run_id = session.active_run_id.as_ref().map(|r| r.to_string());
        let starting = session.latest_run.as_ref().is_some_and(|r| {
            Some(r.id.as_str()) == active_run_id.as_deref()
                && matches!(r.status, RunStatus::Queued | RunStatus::Starting)
        });
        let next = TrackedThread {
            summary: summary.clone(),
            run_id: Some(latest_run.clone()),
            active_run_id,
            active_run_starting: starting,
            pending: session.pending_permission.clone(),
        };
        self.state.threads.insert(id.clone(), next.clone());
        if let Some(k) = &known
            && k.summary.project_id != summary.project_id
        {
            self.touch(&k.summary.project_id.clone());
        }
        self.touch(&summary.project_id);
        let run_status = phase(&summary);
        let next_run = latest_run.as_deref();
        let run_changed = stored.is_some_and(|s| {
            s.last_run_id.as_deref() != next_run
                || s.last_run_status.as_deref() != Some(run_status.as_str())
        });
        let prev_run_differs = match &prev {
            None => true,
            // An unknown run always differs, even from a known absent one.
            Some((_, run)) => run.as_ref().map(|r| r.as_deref()) != Some(next_run),
        };
        if prev.is_none()
            || run_changed
            || prev_run_differs
            || !same_summary(&prev.as_ref().unwrap().0, &summary)
        {
            self.threads.push(StoredThread {
                summary: summary.clone(),
                last_sequence: sequence,
                last_run_id: latest_run.clone(),
                last_run_status: Some(run_status),
            });
        }
        let kind = if quiet_if_new && prev.is_none() {
            None
        } else {
            transition(
                prev.as_ref()
                    .map(|(s, r)| (s, r.as_ref().and_then(|r| r.as_deref()))),
                (&summary, next_run),
            )
            .or_else(|| {
                // A second prompt in the same run, raised before the hub saw it run again, is a new wait.
                let asked = |t: Option<&TrackedThread>| {
                    t.and_then(|t| t.pending.as_ref())
                        .map(|p| p.request_id.to_string())
                };
                (summary.status == "waiting"
                    && known.is_some()
                    && asked(Some(&next)) != asked(known.as_ref()))
                .then_some(EventType::Waiting)
            })
        };
        if let Some(kind) = kind {
            // Anything a restart snapshot reveals happened while the hub was down.
            let late = restart && known.is_none() && kind.terminal();
            self.transitions.push(Transition {
                kind,
                thread_id: summary.thread_id.clone(),
                late,
            });
        }
    }

    fn drop_thread(&mut self, thread_id: &str) {
        if let Some(known) = self.state.threads.remove(thread_id) {
            self.touch(&known.summary.project_id);
        }
    }
}

fn project_meta(p: &ProjectInfo) -> ProjectMeta {
    ProjectMeta {
        title: p.title.clone(),
        workspace_root: p.workspace_root.clone(),
        updated_at: normalize_iso(p.updated_at.as_str()),
    }
}

/// Mutates `state` with one machine stream event and reports what changed. `seq` is the frame's; none for a change
/// the hub applies itself before the stream confirms it.
pub fn apply_machine_event(
    state: &mut ShellState,
    seq: Option<u64>,
    event: &MachineEvent,
    ctx: &ApplyContext,
) -> Applied {
    let mut a = Applier {
        state,
        ctx,
        threads: vec![],
        transitions: vec![],
        touched: vec![],
        cursor: None,
    };
    let mut present = None;
    match event {
        MachineEvent::Snapshot { projects, sessions } => {
            let baseline = ctx.baseline && !a.state.complete;
            let restart = !ctx.baseline && !a.state.complete;
            let ids: HashSet<String> = sessions.iter().map(|s| s.session_id.to_string()).collect();
            let gone: Vec<String> = a
                .state
                .threads
                .keys()
                .filter(|id| !ids.contains(id.as_str()))
                .cloned()
                .collect();
            for id in gone {
                a.drop_thread(&id);
            }
            a.state.projects.clear();
            for p in projects {
                a.state
                    .projects
                    .insert(p.project_id.to_string(), project_meta(p));
                a.touch(p.project_id.as_str());
            }
            for s in sessions {
                a.upsert_thread(s, None, baseline, restart);
            }
            a.state.complete = true;
            present = Some(ids);
        }
        MachineEvent::ProjectUpserted(p) => {
            a.state
                .projects
                .insert(p.project_id.to_string(), project_meta(p));
            a.touch(p.project_id.as_str());
        }
        MachineEvent::ProjectRemoved { project_id } => {
            a.state.projects.remove(project_id.as_str());
        }
        MachineEvent::SessionUpdated(s) => a.upsert_thread(s, seq, false, false),
        // The executor caches it for the link's online/degraded status; it changes no thread or project.
        MachineEvent::RunnerInfo(_) => {}
    }
    if let Some(seq) = seq {
        a.advance(seq);
    }
    let projects = a
        .touched
        .iter()
        .filter_map(|id| project_summary(a.state, ctx.machine_id, id))
        .collect();
    Applied {
        threads: a.threads,
        projects,
        transitions: a.transitions,
        cursor: a.cursor,
        present,
    }
}

/// Cached projects the node no longer has, given the state after `event` was applied: the one a `project_removed`
/// names, or after a snapshot every cached one it left out. The cache is read from the store, not memory, so a
/// project removed while the hub was down is found by the first snapshot after its restart.
pub fn removed_projects(
    state: &ShellState,
    event: &MachineEvent,
    cached: &[String],
) -> Vec<String> {
    match event {
        MachineEvent::ProjectRemoved { project_id } => cached
            .iter()
            .filter(|id| id.as_str() == project_id.as_str())
            .cloned()
            .collect(),
        MachineEvent::Snapshot { .. } => cached
            .iter()
            .filter(|id| !state.projects.contains_key(*id))
            .cloned()
            .collect(),
        _ => vec![],
    }
}

/// The hub event for a transition, in plain language. The event log trims summary and data to their limits.
pub fn transition_event(t: &Transition, thread: &TrackedThread, machine_id: &str) -> EventDraft {
    let s = &thread.summary;
    let limit = if t.kind == EventType::UsageLimited {
        limit_of_summary(s)
    } else {
        None
    };
    let detail = if let Some(limit) = &limit {
        if limit.class == super::limit::UsageClass::PoolExhausted {
            let model = limit
                .model
                .as_deref()
                .or(s.model.as_deref())
                .unwrap_or("the model");
            format!(": your proxy has no account available for {model}")
        } else {
            limit
                .resume_at
                .as_ref()
                .map(|r| format!(" (resets {r})"))
                .unwrap_or_default()
        }
    } else if let (EventType::Failed, Some(e)) = (t.kind, &s.last_error) {
        format!(": {}: {}", e.class, e.message)
    } else if t.kind != EventType::Started && !s.headline.is_empty() {
        format!(": {}", s.headline)
    } else {
        String::new()
    };
    let mut data = Map::new();
    data.insert("status".into(), json!(s.status));
    if let Some(run) = thread.known_run().filter(|r| !r.is_empty()) {
        data.insert("runId".into(), json!(run));
    }
    if t.late {
        data.insert("late".into(), json!(true));
    }
    if let Some(e) = &s.last_error
        && t.kind != EventType::Completed
    {
        data.insert(
            "error".into(),
            json!({ "class": e.class, "message": js_take(&e.message, 500) }),
        );
    }
    if let Some(r) = &s.usage_limit_reset_at {
        data.insert("usageLimitResetAt".into(), json!(r));
    }
    // What the approvals area files an approve ask from.
    if let (EventType::Waiting, Some(p)) = (t.kind, &thread.pending) {
        data.insert(
            "permission".into(),
            json!({ "requestId": p.request_id, "toolName": p.tool_name, "summary": p.summary }),
        );
    }
    if let Some(limit) = &limit {
        data.extend(limit_data(limit));
    }
    let summary = format!(
        "\"{}\" on {} {}{}",
        s.title,
        machine_id,
        t.kind.verb(),
        detail
    );
    EventDraft {
        at: s.last_progress_at.clone(),
        kind: t.kind.as_str().to_owned(),
        machine_id: Some(machine_id.to_owned()),
        project_id: Some(s.project_id.clone()),
        thread_id: Some(s.thread_id.clone()),
        summary: js_take(&summary, 200).to_owned(),
        data: Some(Value::Object(data)),
    }
}
