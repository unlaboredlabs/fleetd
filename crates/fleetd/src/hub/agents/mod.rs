//! The agents view: every agent of the projects a key may read (`agents_list`), and one agent's recent steps
//! (`agent_work`). Reads the task, lead and train stores and the executor's followed sessions; owns no table.
//!
//! The live subscription's board lanes cover the same agents ([`live_tasks`] and [`lead_projects`]), so every row's
//! status and activity stay current between refetches without polling.
pub mod tools;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};

use fleetd_contracts::agents::AgentRow;
use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::live::{AgentLane, LaneStatus};
use fleetd_contracts::prim::Text;
use fleetd_contracts::tasks::{Task, TaskState};
use fleetd_contracts::train::Change;

use crate::hub::api::{Caller, Hub, allows};
use crate::hub::executor::shell_mapper::js_take;
use crate::hub::orders;
use crate::hub::tasks::TaskFilter;

/// Tasks read per state: far above what a fleet runs at once.
const TASK_SCAN: usize = 500;
/// Finished tasks read per end state for `endedSince`.
const ENDED_SCAN: usize = 100;

/// The projects the key may read, with their titles, optionally one of them.
pub fn readable_projects(
    hub: &Hub,
    caller: &Caller,
    only: Option<&ProjectRef>,
) -> HashMap<ProjectRef, String> {
    // Another person's Navi isn't the key's to read (D215).
    let navis = match crate::hub::navi::owner::others(&hub.db, caller) {
        Ok(navis) => navis,
        Err(error) => {
            tracing::warn!(%error, "agents: Navi owners not read");
            return HashMap::new();
        }
    };
    let among = crate::hub::navi::owner::among;
    hub.store
        .projects_list(only.map(|r| &r.machine_id), None)
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "agents: projects not read");
            Vec::new()
        })
        .into_iter()
        .filter(|p| allows(caller, Role::Read, Some(&p.machine_id)) && !among(&navis, p))
        .map(|p| {
            (
                ProjectRef {
                    machine_id: p.machine_id,
                    project_id: p.project_id,
                },
                p.title,
            )
        })
        .filter(|(r, _)| only.is_none_or(|o| o == r))
        .collect()
}

fn tasks_in(hub: &Hub, project: Option<&ProjectRef>, state: TaskState, limit: usize) -> Vec<Task> {
    hub.tasks
        .list(&TaskFilter {
            project_ref: project.cloned(),
            state: Some(state),
            workstream_id: None,
            limit,
        })
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "agents: tasks not read");
            Vec::new()
        })
}

/// Every queued, running or idle task the key may read.
pub fn live_tasks(hub: &Hub, caller: &Caller, project: Option<&ProjectRef>) -> Vec<Task> {
    [TaskState::Running, TaskState::Queued, TaskState::Idle]
        .into_iter()
        .flat_map(|state| tasks_in(hub, project, state, TASK_SCAN))
        .filter(|t| allows(caller, Role::Read, Some(&t.project_ref.machine_id)))
        .collect()
}

/// Tasks that ended at or after `since`, newest first per end state, that the key may read.
pub fn ended_tasks(
    hub: &Hub,
    caller: &Caller,
    project: Option<&ProjectRef>,
    since: &str,
    scan: usize,
) -> Vec<Task> {
    [TaskState::Done, TaskState::Failed, TaskState::Cancelled]
        .into_iter()
        .flat_map(|state| tasks_in(hub, project, state, scan))
        .filter(|t| t.ended_at.as_ref().is_some_and(|e| e.0.as_str() >= since))
        .filter(|t| allows(caller, Role::Read, Some(&t.project_ref.machine_id)))
        .collect()
}

/// The readable projects that have a lead.
pub fn lead_projects(hub: &Hub, readable: &HashMap<ProjectRef, String>) -> HashSet<ProjectRef> {
    hub.leads
        .records
        .leads_list()
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "agents: leads not read");
            Vec::new()
        })
        .into_iter()
        .map(|l| l.project_ref)
        .filter(|r| readable.contains_key(r))
        .collect()
}

/// Where a status sits in the list: agents doing something first, then those waiting their turn, then the rest.
fn rank(status: LaneStatus) -> u8 {
    match status {
        LaneStatus::Waiting => 0,
        LaneStatus::Working | LaneStatus::Starting => 1,
        LaneStatus::Stalled => 2,
        LaneStatus::Queued | LaneStatus::Parked => 3,
        LaneStatus::Idle => 4,
        LaneStatus::Failed => 5,
        LaneStatus::Done | LaneStatus::Cancelled => 6,
    }
}

/// Waiting on a person first, then working, then by most recent start; finished agents by most recent end.
pub fn sort_rows(rows: &mut [AgentRow]) {
    rows.sort_by(|a, b| {
        let (a, b) = (&a.lane, &b.lane);
        rank(a.status)
            .cmp(&rank(b.status))
            .then_with(|| b.ended_at.cmp(&a.ended_at))
            .then_with(|| b.started_at.cmp(&a.started_at))
            .then_with(|| a.lane_id.cmp(&b.lane_id))
    });
}

fn row(lane: AgentLane, project: &ProjectRef, title: &str, task: Option<&Task>) -> AgentRow {
    AgentRow {
        lane,
        project_ref: project.clone(),
        project_title: Text::unchecked(js_take(title, 200)),
        workstream_id: task.map(|t| t.workstream_id.clone()),
    }
}

/// Every agent in scope as a row, sorted, and whether the list was cut to `max`.
pub fn rows(
    hub: &Hub,
    caller: &Caller,
    project: Option<&ProjectRef>,
    ended_since: Option<&Timestamp>,
    max: usize,
) -> (Vec<AgentRow>, bool) {
    let projects = readable_projects(hub, caller, project);
    let mut tasks = live_tasks(hub, caller, project);
    if let Some(since) = ended_since {
        tasks.extend(ended_tasks(
            hub,
            caller,
            project,
            since.0.as_str(),
            ENDED_SCAN,
        ));
    }
    tasks.retain(|t| projects.contains_key(&t.project_ref));
    let mut changes: HashMap<ProjectRef, Vec<Change>> = HashMap::new();
    let mut out = Vec::new();
    for task in &tasks {
        let project_changes = changes
            .entry(task.project_ref.clone())
            .or_insert_with(|| orders::project_changes(hub, &task.project_ref));
        let prs: Vec<_> = project_changes
            .iter()
            .map(|c| (c, orders::pr_ref(c)))
            .collect();
        let lane = orders::task_lane(task, &prs, hub);
        let title = projects.get(&task.project_ref).map_or("", String::as_str);
        out.push(row(lane, &task.project_ref, title, Some(task)));
    }
    for r in lead_projects(hub, &projects) {
        let Some(lead) = hub.leads.leads.get(&r).ok().flatten() else {
            continue;
        };
        let title = projects.get(&r).map_or("", String::as_str);
        out.push(row(orders::lead_lane(&lead, title, hub), &r, title, None));
    }
    sort_rows(&mut out);
    let truncated = out.len() > max;
    out.truncate(max);
    (out, truncated)
}
