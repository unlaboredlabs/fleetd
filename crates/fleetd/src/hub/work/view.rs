//! The in-flight view, as a pure function of what the hub holds: write tasks, Changes and claims become one list of
//! `WorkItem`s. A writer appears once: its Change takes over when its PR is enqueued.
use std::collections::{HashMap, HashSet};

use fleetd_contracts::prim::{Line, List};
use fleetd_contracts::tasks::{PrUrl, Task, TaskId, TaskKind, TaskState};
use fleetd_contracts::train::{Change, ChangeState};
use fleetd_contracts::work::{Claim, ClaimState, WorkItem, WorkItemKind, WorkKey, WorkPath};

use crate::hub::train::contract::state_str as change_state_str;

/// Task states that are work in flight.
pub const LIVE_TASK_STATES: [TaskState; 3] =
    [TaskState::Queued, TaskState::Running, TaskState::Idle];
/// Change states that are no longer in flight: merged work is a landing, abandoned work is gone. A refused Change
/// stays, as its PR is still open.
pub const ENDED_CHANGE_STATES: [ChangeState; 2] = [ChangeState::Merged, ChangeState::Abandoned];

/// What the view is built from, already narrowed to one scope.
#[derive(Default)]
pub struct Sources {
    /// The scope's projects' tasks; only live write tasks become items.
    pub tasks: Vec<Task>,
    /// The scope's projects' Changes on the scope's repo.
    pub changes: Vec<Change>,
    /// The tasks the Changes were opened by, when they are not in `tasks`.
    pub change_tasks: Vec<Task>,
    pub claims: Vec<Claim>,
    /// What each writer has changed so far, by task.
    pub observed: HashMap<TaskId, Vec<String>>,
}

fn paths_of<'a>(paths: impl IntoIterator<Item = &'a str>) -> List<WorkPath, 0, { usize::MAX }> {
    let mut seen = HashSet::new();
    List::unchecked(
        paths
            .into_iter()
            .filter(|p| seen.insert(*p))
            .filter_map(|p| WorkPath::new(p).ok())
            .collect(),
    )
}

fn push_key(keys: &mut Vec<WorkKey>, key: WorkKey) {
    if !keys.contains(&key) {
        keys.push(key);
    }
}

fn branch_key(branch: &str) -> Option<WorkKey> {
    Line::new(branch).ok().map(WorkKey::Branch)
}

fn task_state_str(state: TaskState) -> &'static str {
    match state {
        TaskState::Queued => "queued",
        TaskState::Running => "running",
        TaskState::Idle => "idle",
        TaskState::Done => "done",
        TaskState::Failed => "failed",
        TaskState::Cancelled => "cancelled",
    }
}

fn claim_state_str(state: ClaimState) -> &'static str {
    crate::hub::work::store::state_str(state)
}

fn task_keys(task: &Task) -> Vec<WorkKey> {
    let mut keys = Vec::new();
    if let Some(key) = task.branch.as_deref().and_then(branch_key) {
        push_key(&mut keys, key);
    }
    // A writer spawned for a PR (to finish or fix it) holds that PR as much as one that opened it.
    if let Some(url) = &task.pr {
        push_key(&mut keys, WorkKey::Pr(url.clone()));
    }
    if let Some(url) = task.result.as_ref().and_then(|r| r.pr_url.clone()) {
        push_key(&mut keys, WorkKey::Pr(url));
    }
    keys
}

fn task_item(task: &Task, observed: &HashMap<TaskId, Vec<String>>) -> WorkItem {
    let declared = task.paths.iter().flatten().map(|p| p.as_str());
    let observed = observed.get(&task.task_id).into_iter().flatten();
    WorkItem {
        id: Line::unchecked(task.task_id.as_str()),
        kind: WorkItemKind::Task,
        project_ref: Some(task.project_ref.clone()),
        owner: None,
        title: Line::unchecked(task.title.as_str()),
        state: Line::unchecked(task_state_str(task.state)),
        keys: List::unchecked(task_keys(task)),
        paths: paths_of(declared.chain(observed.map(String::as_str))),
        task_id: Some(task.task_id.clone()),
        change_id: None,
        claim_id: None,
        since: task.created_at.clone(),
        expires_at: None,
    }
}

fn change_item(
    change: &Change,
    task: Option<&Task>,
    observed: &HashMap<TaskId, Vec<String>>,
) -> WorkItem {
    let mut keys = vec![WorkKey::Pr(PrUrl::unchecked(change.pr_url.as_str()))];
    if let Some(key) = branch_key(&change.branch) {
        push_key(&mut keys, key);
    }
    let title = match task {
        Some(task) => task.title.as_str().to_owned(),
        None => format!("#{} {}", change.pr_number.get(), change.branch.as_str()),
    };
    let paths = change
        .task_id
        .as_ref()
        .and_then(|t| observed.get(t))
        .map(Vec::as_slice)
        .unwrap_or_default();
    WorkItem {
        id: Line::unchecked(change.change_id.as_str()),
        kind: WorkItemKind::Change,
        project_ref: Some(change.project_ref.clone()),
        owner: None,
        title: Line::new(title).unwrap_or_else(|_| Line::unchecked(change.change_id.as_str())),
        state: Line::unchecked(change_state_str(change.state)),
        keys: List::unchecked(keys),
        paths: paths_of(paths.iter().map(String::as_str)),
        task_id: change.task_id.clone(),
        change_id: Some(change.change_id.clone()),
        claim_id: None,
        since: change.created_at.clone(),
        expires_at: None,
    }
}

fn claim_item(claim: &Claim) -> WorkItem {
    let mut keys = claim.keys.to_vec();
    if let Some(branch) = &claim.branch {
        push_key(&mut keys, WorkKey::Branch(branch.clone()));
    }
    let observed = claim.observed.iter().flat_map(|o| o.paths.iter());
    WorkItem {
        id: Line::unchecked(claim.claim_id.as_str()),
        kind: WorkItemKind::Claim,
        project_ref: claim.project_ref.clone(),
        owner: Some(claim.owner.clone()),
        title: Line::unchecked(claim.title.as_str()),
        state: Line::unchecked(claim_state_str(claim.state)),
        keys: List::unchecked(keys),
        paths: paths_of(claim.paths.iter().chain(observed).map(|p| p.as_str())),
        task_id: None,
        change_id: None,
        claim_id: Some(claim.claim_id.clone()),
        since: claim.renewed_at.clone(),
        expires_at: Some(claim.expires_at.clone()),
    }
}

/// Every live item, newest first; expired claims (still shown, as weak) come last.
pub fn items(sources: &Sources) -> Vec<WorkItem> {
    let live_changes: Vec<&Change> = sources
        .changes
        .iter()
        .filter(|c| !ENDED_CHANGE_STATES.contains(&c.state))
        .collect();
    let taken_over: HashSet<&TaskId> = live_changes
        .iter()
        .filter_map(|c| c.task_id.as_ref())
        .collect();
    let task_of: HashMap<&TaskId, &Task> = sources
        .tasks
        .iter()
        .chain(&sources.change_tasks)
        .map(|t| (&t.task_id, t))
        .collect();
    let mut out: Vec<WorkItem> = sources
        .tasks
        .iter()
        .filter(|t| t.kind == TaskKind::Write && LIVE_TASK_STATES.contains(&t.state))
        .filter(|t| !taken_over.contains(&t.task_id))
        .map(|t| task_item(t, &sources.observed))
        .collect();
    out.extend(live_changes.iter().map(|c| {
        let task = c.task_id.as_ref().and_then(|t| task_of.get(t).copied());
        change_item(c, task, &sources.observed)
    }));
    out.extend(
        sources
            .claims
            .iter()
            .filter(|c| matches!(c.state, ClaimState::Active | ClaimState::Expired))
            .map(claim_item),
    );
    // Timestamps are all the hub's own ISO form, so they sort as text.
    out.sort_by(|a, b| {
        let expired = |i: &WorkItem| i.kind == WorkItemKind::Claim && i.state == "expired";
        expired(a)
            .cmp(&expired(b))
            .then_with(|| b.since.cmp(&a.since))
    });
    out
}
