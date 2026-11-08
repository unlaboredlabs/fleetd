//! Each Navi is its owner's (D215): the person whose key made it, else the hub's first owner. Only they see it in a
//! list or reach it through a tool: its chat, approvals, integrations, hub links, sites, settings, archive and delete.
//! Anyone else is refused, an admin too, except to delete the Navi of a person since removed from the hub.
//!
//! The gate is one place: [`guard`] runs before every tool's handler and refuses a call that names another person's
//! Navi, by its project, one of its threads, one of its requests or one of its automations. Lists leave those Navis
//! out with [`others`].
//!
//! A key with no person (an agent key, minted only from the hub's home on its machine, whose user is the hub's owner)
//! counts as the hub's owner. A Navi with no owner (a hub without people) is anyone's, as before people.
use std::collections::HashSet;

use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEvent;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::model::ProjectSummary;
use fleetd_contracts::people::PersonId;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::hub::api::{Caller, Hub, ToolError, allows, error};
use crate::hub::store::{HubDb, StoreError};

/// How deep [`guard`] looks into a call's input for the projects it names.
const DEPTH: usize = 4;

/// The person `caller` acts as for Navis: their own, or the hub's first owner for a key with no person. None on a hub
/// without people.
pub fn who(c: &Connection, caller: &Caller) -> Result<Option<PersonId>, StoreError> {
    Ok(match &caller.person {
        Some(person) => Some(person.person_id.clone()),
        None => crate::hub::people::owner_on(c)?.map(|p| p.person_id),
    })
}

/// The Navis `caller` may not see or use: every one with an owner other than them.
pub fn others(db: &HubDb, caller: &Caller) -> Result<HashSet<ProjectRef>, StoreError> {
    db.with(|c| {
        let me = who(c, caller)?;
        Ok(super::store::others(c, me.as_ref())?.into_iter().collect())
    })
}

/// The Navis that aren't `person`'s, for one who acts for a person outside a key: a Navi for its owner (None: a Navi
/// with no owner, which sees no Navi with one), a hub link for the person who made it (None: the hub's owner).
pub fn others_of(
    db: &HubDb,
    person: Option<&PersonId>,
    or_owner: bool,
) -> Result<HashSet<ProjectRef>, StoreError> {
    db.with(|c| {
        let me = match person {
            Some(p) => Some(p.clone()),
            None if or_owner => crate::hub::people::owner_on(c)?.map(|p| p.person_id),
            None => None,
        };
        Ok(super::store::others(c, me.as_ref())?.into_iter().collect())
    })
}

/// Whether `caller` may see and use `r`: any project but another person's Navi.
pub fn may_use(db: &HubDb, caller: &Caller, r: &ProjectRef) -> Result<bool, StoreError> {
    Ok(!others(db, caller)?.contains(r))
}

/// Whether `project` is one of `navis`.
pub fn among(navis: &HashSet<ProjectRef>, project: &ProjectSummary) -> bool {
    !navis.is_empty()
        && navis.contains(&ProjectRef {
            machine_id: project.machine_id.clone(),
            project_id: project.project_id.clone(),
        })
}

/// Whether `event` is about one of `navis`: what a list of events leaves out for a caller they aren't theirs. An event
/// that names a thread but no project (a steer's, a wake's, a queued message's) is its thread's project's; one whose
/// thread can't be read is left out too.
pub fn about(db: &HubDb, navis: &HashSet<ProjectRef>, event: &HubEvent) -> bool {
    if navis.is_empty() {
        return false;
    }
    match (&event.machine_id, &event.project_id, &event.thread_id) {
        (Some(m), Some(p), _) => navis.contains(&ProjectRef {
            machine_id: m.clone(),
            project_id: p.clone(),
        }),
        (Some(m), None, Some(t)) => thread_among(db, navis, m, t),
        _ => false,
    }
}

/// Whether thread `t` on `m` is one of `navis`'s. One whose project can't be read counts as one.
pub fn thread_among(db: &HubDb, navis: &HashSet<ProjectRef>, m: &MachineId, t: &ThreadId) -> bool {
    !navis.is_empty()
        && db
            .with(|c| thread_project(c, m.as_str(), t.as_str()))
            .map_or(true, |r| r.is_some_and(|r| navis.contains(&r)))
}

/// The refusal for a call that names another person's Navi.
pub fn refused(r: &ProjectRef) -> ToolError {
    error(
        ErrorCode::Forbidden,
        format!(
            "{} on {} is another person's Only me project: only its owner uses and manages it.",
            r.project_id, r.machine_id
        ),
        "Your own projects are in your list; make one with project_add.",
    )
}

/// `Ok` unless `input` names another person's Navi. `project_remove` of the Navi of a person since removed from the
/// hub goes through for a key with admin on its machine: their Navi has no one else to delete it.
pub fn guard(hub: &Hub, caller: &Caller, tool: &str, input: &Value) -> Result<(), ToolError> {
    let others = others(&hub.db, caller)?;
    if others.is_empty() {
        return Ok(());
    }
    let mut named = Vec::new();
    hub.db.with(|c| refs(c, input, DEPTH, &mut named))?;
    let Some(r) = named.into_iter().find(|r| others.contains(r)) else {
        return Ok(());
    };
    if tool == "project_remove"
        && allows(caller, Role::Admin, Some(&r.machine_id))
        && owner_removed(&hub.db, &r)?
    {
        return Ok(());
    }
    // An admin may turn another person's Only me off, and that alone (D310).
    let only_me_alone = input.as_object().is_some_and(|o| {
        o.contains_key("onlyMe")
            && o.keys()
                .all(|k| matches!(k.as_str(), "machineId" | "projectId" | "onlyMe"))
    });
    if tool == "project_settings_set"
        && only_me_alone
        && allows(caller, Role::Admin, Some(&r.machine_id))
    {
        return Ok(());
    }
    Err(refused(&r))
}

/// Whether the Navi's owner was removed from the hub.
fn owner_removed(db: &HubDb, r: &ProjectRef) -> Result<bool, StoreError> {
    db.with(|c| {
        Ok(c.prepare_cached(
            "SELECT 1 FROM project_settings s JOIN people p ON p.person_id = s.owner_person
             WHERE s.machine_id = ? AND s.project_id = ? AND s.only_me = 1 AND p.removed_ms IS NOT NULL",
        )?
        .query_row(
            params![r.machine_id.as_str(), r.project_id.as_str()],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
    })
}

/// The projects a call's input names, at any of its objects down to `depth`: a `machineId` with a `projectId`, or
/// with a `threadId` (the thread's project), a `requestId` (the project that asked), an `automationId` (the
/// project it runs in), a `sessionId` (the screen's project), a `workstreamId` (the order's project), a `taskId`
/// (the task's project) and a `steerId` (its order's project).
fn refs(
    c: &Connection,
    input: &Value,
    depth: usize,
    out: &mut Vec<ProjectRef>,
) -> Result<(), StoreError> {
    match input {
        Value::Object(fields) => {
            let text = |k: &str| fields.get(k).and_then(Value::as_str);
            if let Some(m) = text("machineId") {
                if let Some(p) = text("projectId") {
                    out.push(ProjectRef {
                        machine_id: MachineId::unchecked(m),
                        project_id: ProjectId::unchecked(p),
                    });
                } else if let Some(t) = text("threadId")
                    && let Some(p) = thread_project(c, m, t)?
                {
                    out.push(p);
                }
            }
            if let Some(id) = text("requestId")
                && let Some(p) = request_project(c, id)?
            {
                out.push(p);
            }
            if let Some(id) = text("automationId")
                && let Some(p) = automation_project(c, id)?
            {
                out.push(p);
            }
            if let Some(id) = text("sessionId")
                && let Some(p) = screen_project(c, id)?
            {
                out.push(p);
            }
            if let Some(id) = text("workstreamId")
                && let Some(p) = numbered_project(c, "workstreams", 'W', id)?
            {
                out.push(p);
            }
            if let Some(id) = text("taskId")
                && let Some(p) = numbered_project(c, "tasks", 'T', id)?
            {
                out.push(p);
            }
            if let Some(id) = text("steerId")
                && let Some(p) = steer_project(c, id)?
            {
                out.push(p);
            }
            if depth > 0 {
                for v in fields.values() {
                    refs(c, v, depth - 1, out)?;
                }
            }
        }
        Value::Array(items) if depth > 0 => {
            for v in items {
                refs(c, v, depth - 1, out)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn thread_project(c: &Connection, m: &str, t: &str) -> Result<Option<ProjectRef>, StoreError> {
    let p: Option<String> = c
        .prepare_cached("SELECT project_id FROM threads WHERE machine_id = ? AND thread_id = ?")?
        .query_row(params![m, t], |row| row.get(0))
        .optional()?;
    Ok(p.map(|p| ProjectRef {
        machine_id: MachineId::unchecked(m),
        project_id: ProjectId::unchecked(p),
    }))
}

/// The project of row n of `table` (`workstreams` or `tasks`), by an id `<prefix><n>`: an order's or a task's.
fn numbered_project(
    c: &Connection,
    table: &str,
    prefix: char,
    id: &str,
) -> Result<Option<ProjectRef>, StoreError> {
    let Some(n) = id.strip_prefix(prefix).and_then(|n| n.parse::<i64>().ok()) else {
        return Ok(None);
    };
    let row: Option<(String, String)> = c
        .prepare_cached(&format!(
            "SELECT machine_id, project_id FROM {table} WHERE n = ?"
        ))?
        .query_row([n], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    Ok(row.map(|(m, p)| ProjectRef {
        machine_id: MachineId::unchecked(m),
        project_id: ProjectId::unchecked(p),
    }))
}

/// A steer's project: its order's.
fn steer_project(c: &Connection, id: &str) -> Result<Option<ProjectRef>, StoreError> {
    let Some(n) = id.strip_prefix('S').and_then(|n| n.parse::<i64>().ok()) else {
        return Ok(None);
    };
    let order: Option<String> = c
        .prepare_cached("SELECT workstream_id FROM steers WHERE n = ?")?
        .query_row([n], |row| row.get(0))
        .optional()?;
    match order {
        Some(w) => numbered_project(c, "workstreams", 'W', &w),
        None => Ok(None),
    }
}

/// An automation's project.
fn automation_project(c: &Connection, id: &str) -> Result<Option<ProjectRef>, StoreError> {
    let row: Option<(String, String)> = c
        .prepare_cached("SELECT machine_id, project_id FROM automations WHERE automation_id = ?")?
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    Ok(row.map(|(m, p)| ProjectRef {
        machine_id: MachineId::unchecked(m),
        project_id: ProjectId::unchecked(p),
    }))
}

/// A screen's project: a Navi's screen is its owner's to watch, take over and replay.
pub fn screen_project(c: &Connection, id: &str) -> Result<Option<ProjectRef>, StoreError> {
    let row: Option<(String, String)> = c
        .prepare_cached("SELECT machine_id, project_id FROM browser_sessions WHERE session_id = ?")?
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    Ok(row.map(|(m, p)| ProjectRef {
        machine_id: MachineId::unchecked(m),
        project_id: ProjectId::unchecked(p),
    }))
}

/// A chat request's project: `Q<n>` is row n of `requests`.
fn request_project(c: &Connection, id: &str) -> Result<Option<ProjectRef>, StoreError> {
    let Some(n) = id.strip_prefix('Q').and_then(|n| n.parse::<i64>().ok()) else {
        return Ok(None);
    };
    let row: Option<(Option<String>, Option<String>)> = c
        .prepare_cached(
            "SELECT json_extract(data, '$.projectRef.machineId'), json_extract(data, '$.projectRef.projectId')
             FROM requests WHERE n = ?",
        )?
        .query_row([n], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    Ok(match row {
        Some((Some(m), Some(p))) => Some(ProjectRef {
            machine_id: MachineId::unchecked(m),
            project_id: ProjectId::unchecked(p),
        }),
        _ => None,
    })
}
