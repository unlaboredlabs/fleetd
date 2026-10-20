//! An order's write work that has not landed: its write tasks still going or failed, and its PRs neither in nor on
//! their way in. An order never closes over it unless the lead says so on purpose. A claim refuses or holds while
//! some is open (`checks::claims`), and the done sweep keeps it (`idle::on_done`). On a live hub, an order's fix task,
//! spawned from its PR's review while the order verified, was cancelled as a leftover the moment the order's checks
//! passed, and the fix never shipped. Which `serves` a fix was spawned with, or whether the review blocked, does not
//! matter: write work is what ships.
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::tasks::{Task, TaskId, TaskKind, TaskState};
use fleetd_contracts::train::{Change, ChangeId, ChangeState};

use crate::hub::api::Hub;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Item {
    Task(TaskId),
    Pr(ChangeId),
}

/// One piece of unlanded write work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenWork {
    pub item: Item,
    /// What it is in plain words, with no ids: what the lead says in chat and the record shows.
    pub line: String,
}

impl OpenWork {
    /// Its id, for tool calls only.
    pub fn id(&self) -> &str {
        match &self.item {
            Item::Task(id) => id.as_str(),
            Item::Pr(id) => id.as_str(),
        }
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max - 1).collect::<String>())
    }
}

/// The order's unlanded write work, from its tasks and the project's PRs.
pub fn select(workstream_id: &WorkstreamId, tasks: &[Task], changes: &[Change]) -> Vec<OpenWork> {
    let title_of = |task_id: &TaskId| {
        tasks
            .iter()
            .find(|t| &t.task_id == task_id)
            .map(|t| clip(t.title.as_str(), 80))
    };
    let mut out: Vec<OpenWork> = tasks
        .iter()
        .filter(|t| &t.workstream_id == workstream_id && t.kind == TaskKind::Write)
        .filter_map(|t| {
            let state = match t.state {
                TaskState::Queued => "queued",
                TaskState::Running => "running",
                TaskState::Idle => "waiting for a message",
                TaskState::Failed => "failed",
                TaskState::Done | TaskState::Cancelled => return None,
            };
            Some(OpenWork {
                item: Item::Task(t.task_id.clone()),
                line: format!("\"{}\" ({state})", clip(t.title.as_str(), 80)),
            })
        })
        .collect();
    out.extend(
        changes
            .iter()
            .filter(|c| &c.workstream_id == workstream_id)
            .filter_map(|c| {
                let state = match c.state {
                    ChangeState::Queued | ChangeState::Reviewing => "in review",
                    ChangeState::Ready => "waiting for the train",
                    ChangeState::NeedsRebase => "needs a rebase",
                    ChangeState::CiFailed => "CI failed",
                    // On its way in, or ended.
                    ChangeState::Rebasing
                    | ChangeState::Ci
                    | ChangeState::Merging
                    | ChangeState::Merged
                    | ChangeState::Refused
                    | ChangeState::Abandoned => return None,
                };
                let what = match c.task_id.as_ref().and_then(title_of) {
                    Some(title) => format!("the pull request for \"{title}\""),
                    None => format!("a pull request in {}", c.repo),
                };
                Some(OpenWork {
                    item: Item::Pr(c.change_id.clone()),
                    line: format!("{what} ({state})"),
                })
            }),
    );
    out
}

/// `select` over the hub's own records.
pub fn open(hub: &Hub, project: &ProjectRef, workstream_id: &WorkstreamId) -> Vec<OpenWork> {
    select(
        workstream_id,
        &super::order_tasks(hub, workstream_id),
        &super::project_changes(hub, project),
    )
}

/// The plain lines, joined for one sentence.
pub fn listed(work: &[OpenWork]) -> String {
    work.iter()
        .map(|w| w.line.as_str())
        .collect::<Vec<_>>()
        .join("; ")
}

/// The ids, for tool calls.
pub fn ids(work: &[OpenWork]) -> String {
    work.iter().map(OpenWork::id).collect::<Vec<_>>().join(", ")
}

/// How the `reason` of a `workstream.done` starts when the lead closed the order over its open work on purpose.
pub const CLOSED_ON_PURPOSE: &str = "closed on purpose: ";

/// What the done sweep does with what an order left: its live tasks are cancelled and its PRs not on their way in
/// are closed, except its unlanded write work, which keeps going. Closed on purpose (`closeOver`), all of it goes.
#[derive(Debug, PartialEq, Eq)]
pub struct Sweep {
    pub cancel: Vec<TaskId>,
    /// PRs the sweep leaves open.
    pub keep_prs: Vec<ChangeId>,
    /// The write work kept going, which the lead is told about.
    pub kept: Vec<OpenWork>,
}

pub fn sweep(tasks: &[Task], open: Vec<OpenWork>, on_purpose: bool) -> Sweep {
    let kept = if on_purpose { Vec::new() } else { open };
    let cancel = tasks
        .iter()
        .filter(|t| {
            matches!(
                t.state,
                TaskState::Queued | TaskState::Running | TaskState::Idle
            )
        })
        .filter(|t| !kept.iter().any(|w| w.item == Item::Task(t.task_id.clone())))
        .map(|t| t.task_id.clone())
        .collect();
    let keep_prs = kept
        .iter()
        .filter_map(|w| match &w.item {
            Item::Pr(id) => Some(id.clone()),
            Item::Task(_) => None,
        })
        .collect();
    Sweep {
        cancel,
        keep_prs,
        kept,
    }
}
