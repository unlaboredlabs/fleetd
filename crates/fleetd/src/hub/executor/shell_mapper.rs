//! Pure mapping from T3 shell stream items to the hub's thread/project caches and derived events. The executor feeds
//! every item through `apply_shell_item`; nothing here does I/O.
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::limit::{limit_data, limit_of_summary, normalize_iso};
use t3_wire::types::{
    ProjectRemovedItem, ProjectUpdatedItem, ShellSnapshotItem, ShellStreamItem, ThreadRemovedItem,
    ThreadShell, ThreadUpdatedItem,
};

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
    /// T3's latest run id when this row was written.
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
    /// T3's latest run; a new one in the same phase is still a transition. Unknown (None) after a hub restart;
    /// `Some(None)` is T3 saying the thread has no run.
    pub run_id: Option<Option<String>>,
    pub active_run_id: Option<String>,
    /// The active run is still being prepared or started, so a message sent now is queued behind it.
    pub active_run_starting: bool,
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

/// One machine's view of T3's shell. Holds shell rows only, never transcripts.
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
    /// Set when the item moved the shell cursor.
    pub cursor: Option<u64>,
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

/// T3 reports "waiting" for more than approvals, so only a pending runtime request counts as waiting on a human.
pub fn thread_status(shell: &ThreadShell) -> String {
    match shell.status.as_str() {
        "preparing" | "queued" | "starting" | "running" | "waiting" => {
            if shell.pending_runtime_request.is_some() {
                "waiting"
            } else {
                "running"
            }
            .to_owned()
        }
        "rolled_back" => "cancelled".to_owned(),
        other => other.to_owned(),
    }
}

fn first_line(text: &str) -> String {
    js_take(text.trim().split('\n').next().unwrap_or(""), 280).to_owned()
}

/// Applies the latest visible assistant text (T3's shell rows carry none, so it comes from a thread read).
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
    shell: &ThreadShell,
    prev: Option<&Summary>,
    now: &str,
) -> Summary {
    let effort = shell
        .model_selection
        .options
        .as_ref()
        .and_then(|o| o.iter().find(|o| o.id == "effort"))
        .and_then(|o| o.value.as_str().map(str::to_owned));
    let reset_at = if shell.last_error_class.as_deref() == Some("usage_limit") {
        shell.usage_limit_reset_at.clone().filter(|r| !r.is_empty())
    } else {
        None
    };
    let base = Summary {
        machine_id: machine_id.to_owned(),
        thread_id: shell.id.clone(),
        project_id: shell.project_id.clone(),
        title: shell.title.clone(),
        status: thread_status(shell),
        headline: prev.map(|p| p.headline.clone()).unwrap_or_default(),
        latest_message_tail: prev
            .map(|p| p.latest_message_tail.clone())
            .unwrap_or_default(),
        last_error: shell
            .last_error
            .as_ref()
            .filter(|e| !e.is_empty())
            .map(|e| LastError {
                class: shell
                    .last_error_class
                    .clone()
                    .unwrap_or_else(|| "unknown".into()),
                message: js_take(e, 2000).to_owned(),
            }),
        usage_limit_reset_at: reset_at,
        last_progress_at: normalize_iso(&shell.updated_at),
        model: Some(shell.model_selection.model.clone()),
        effort,
        stale: false,
        as_of: now.to_owned(),
    };
    match &shell.latest_visible_message {
        Some(latest) if latest.role == "assistant" => {
            with_assistant_text(&base, Some(&latest.text))
        }
        _ => base,
    }
}

/// M4: a failure T3 calls usage_limit, or whose text is a 429, a usage limit or an exhausted proxy, is a usage limit.
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
        shell: &ThreadShell,
        sequence: Option<u64>,
        quiet_if_new: bool,
        restart: bool,
    ) {
        let known = self.state.threads.get(&shell.id).cloned();
        let stored = if known.is_none() {
            self.ctx.stored.get(&shell.id)
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
            shell,
            prev.as_ref().map(|p| &p.0),
            self.ctx.now,
        );
        let starting = shell
            .activity_run_status
            .as_deref()
            .unwrap_or(&shell.status);
        let next = TrackedThread {
            summary: summary.clone(),
            run_id: Some(shell.latest_run_id.clone()),
            active_run_id: shell.active_run_id.clone(),
            active_run_starting: matches!(starting, "preparing" | "queued" | "starting"),
        };
        self.state.threads.insert(shell.id.clone(), next.clone());
        if let Some(k) = &known
            && k.summary.project_id != summary.project_id
        {
            self.touch(&k.summary.project_id.clone());
        }
        self.touch(&summary.project_id);
        let run_status = phase(&summary);
        let next_run = shell.latest_run_id.as_deref();
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
                last_run_id: shell.latest_run_id.clone(),
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

/// Mutates `state` with one shell stream item and reports what changed.
pub fn apply_shell_item(
    state: &mut ShellState,
    item: &ShellStreamItem,
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
    match item {
        ShellStreamItem::Synchronized | ShellStreamItem::Other => {}
        ShellStreamItem::Snapshot(ShellSnapshotItem {
            snapshot,
            resolved_repository_identity_roots,
        }) => {
            for p in &snapshot.projects {
                a.state.projects.insert(
                    p.id.clone(),
                    ProjectMeta {
                        title: p.title.clone(),
                        workspace_root: p.workspace_root.clone(),
                        updated_at: p.updated_at.clone(),
                    },
                );
                a.touch(&p.id);
            }
            // A snapshot that names resolved repository roots is only a project metadata refresh: it lists some
            // projects and no threads, and its sequence can be ahead of a replay that follows it.
            if resolved_repository_identity_roots.is_none() {
                let baseline = ctx.baseline && !a.state.complete;
                let restart = !ctx.baseline && !a.state.complete;
                let present: HashSet<&str> =
                    snapshot.threads.iter().map(|t| t.id.as_str()).collect();
                let gone: Vec<String> = a
                    .state
                    .threads
                    .keys()
                    .filter(|id| !present.contains(id.as_str()))
                    .cloned()
                    .collect();
                for id in gone {
                    a.drop_thread(&id);
                }
                a.state
                    .projects
                    .retain(|id, _| snapshot.projects.iter().any(|p| &p.id == id));
                for shell in &snapshot.threads {
                    a.upsert_thread(shell, None, baseline, restart);
                }
                a.state.complete = true;
                a.advance(snapshot.snapshot_sequence);
            }
        }
        ShellStreamItem::ProjectUpdated(ProjectUpdatedItem { sequence, project }) => {
            a.state.projects.insert(
                project.id.clone(),
                ProjectMeta {
                    title: project.title.clone(),
                    workspace_root: project.workspace_root.clone(),
                    updated_at: project.updated_at.clone(),
                },
            );
            a.touch(&project.id);
            a.advance(*sequence);
        }
        ShellStreamItem::ProjectRemoved(ProjectRemovedItem {
            sequence,
            project_id,
        }) => {
            a.state.projects.remove(project_id);
            a.advance(*sequence);
        }
        ShellStreamItem::ThreadUpdated(ThreadUpdatedItem {
            sequence,
            location,
            thread,
        }) => {
            if location == "archive" || thread.deleted_at.is_some() {
                a.drop_thread(&thread.id);
            } else {
                a.upsert_thread(thread, Some(*sequence), false, false);
            }
            a.advance(*sequence);
        }
        ShellStreamItem::ThreadRemoved(ThreadRemovedItem {
            sequence,
            thread_id,
            ..
        }) => {
            a.drop_thread(thread_id);
            a.advance(*sequence);
        }
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
    }
}

/// Cached projects T3 no longer has, given the state after `item` was applied: the one a `project.removed` names, or
/// after a full snapshot every cached one it left out. The cache is read from the store, not memory, so a project
/// deleted while the hub was down is found by the first snapshot after its restart.
pub fn removed_projects(
    state: &ShellState,
    item: &ShellStreamItem,
    cached: &[String],
) -> Vec<String> {
    match item {
        ShellStreamItem::ProjectRemoved(ProjectRemovedItem { project_id, .. }) => cached
            .iter()
            .filter(|id| *id == project_id)
            .cloned()
            .collect(),
        ShellStreamItem::Snapshot(ShellSnapshotItem {
            resolved_repository_identity_roots: None,
            ..
        }) => cached
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
