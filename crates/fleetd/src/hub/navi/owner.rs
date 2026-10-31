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
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
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

/// Whether `event` is about one of `navis`: what a list of events leaves out for a caller they aren't theirs.
pub fn about(navis: &HashSet<ProjectRef>, event: &HubEvent) -> bool {
    !navis.is_empty()
        && match (&event.machine_id, &event.project_id) {
            (Some(m), Some(p)) => navis.contains(&ProjectRef {
                machine_id: m.clone(),
                project_id: p.clone(),
            }),
            _ => false,
        }
}

/// The refusal for a call that names another person's Navi.
pub fn refused(r: &ProjectRef) -> ToolError {
    error(
        ErrorCode::Forbidden,
        format!(
            "{} on {} is another person's Navi: only its owner uses and manages it.",
            r.project_id, r.machine_id
        ),
        "navi_list shows your own Navis; make one of your own with navi_create.",
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
    Err(refused(&r))
}

/// Whether the Navi's owner was removed from the hub.
fn owner_removed(db: &HubDb, r: &ProjectRef) -> Result<bool, StoreError> {
    db.with(|c| {
        Ok(c.prepare_cached(
            "SELECT 1 FROM assistants a JOIN people p ON p.person_id = a.owner_person
             WHERE a.machine_id = ? AND a.project_id = ? AND p.removed_ms IS NOT NULL",
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
/// project it runs in) and a `sessionId` (the screen's project).
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
