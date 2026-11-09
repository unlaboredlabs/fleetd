//! Deleting a Navi erases it (D287 navi.delete-erases): `project_remove` of a Navi forgets it on its node, which also
//! deletes its sessions, Claude Code's transcripts of them and the attachments in its folder (the folder too when the
//! person ticks it, `node/sessions`), then [`erase`] deletes everything of it the hub keeps: its chat and the events
//! that carried it, its approvals and purchases (`requests`), asks and decisions, its orders and what they hold, its
//! memory and skills, its attachments and its screen recordings, and the time inspector's record of its sessions (whose
//! labels name its commands, searches and pages). Its agents' slots and its own max agents go from the slot board,
//! and its project.removed stays in the log for the open apps. Its settings go with the project as any project's do
//! (`HubStore::project_remove`).
//!
//! The delete is marked as asked for first (`navi_erases`, [`asked`]): when its node removes the Navi but its answer
//! never reaches the hub (a timeout), [`run`] finishes the erase once the hub's cache no longer has the Navi, at the
//! node's `project_removed` or the first snapshot after, and at the hub's start.
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId};

use fleetd_contracts::browser::BrowserSessionId;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::skills::SkillScope;
use rusqlite::{Connection, params};

use crate::hub::api::Hub;
use crate::hub::ledger::project_key;
use crate::hub::store::{HubDb, StoreError, now_ms};

/// Tables with the Navi's rows by `machine_id` and `project_id`.
const BY_PROJECT: &[&str] = &[
    "chat_messages",
    "chat_projects",
    "checklists",
    "leads",
    "lead_mcp",
    "approval_checks",
    "memory_imports",
    "memory_refreshes",
    "memory_refresh_lines",
    "navi_auto_approved",
    "navi_approvals",
    "navi_sites",
    "skill_versions",
    "skill_uses",
    "browser_sessions",
    "screen_waits",
    "session_prompts",
    "tasks",
    "slot_claims",
    "workstreams",
    "hub_links",
];

/// Tables with rows of the Navi's sessions, by `machine_id` and `thread_id`.
const BY_THREAD: &[&str] = &[
    "threads",
    "wakes",
    "queued_writes",
    "steers",
    "thread_accounts",
    "task_threads",
    "time_lead_runs",
    "time_wakes",
];

/// Tables with the Navi's rows by `project_key` (`<machine>/<project>`).
const BY_KEY: &[&str] = &["requests", "legacy_asks", "decisions"];

/// Marks the Navi's delete as asked for, before its node is asked: [`run`] finishes it if the answer never comes.
pub fn asked(hub: &Hub, r: &ProjectRef) -> Result<(), StoreError> {
    hub.db.with(|c| {
        c.execute(
            "INSERT OR REPLACE INTO navi_erases (machine_id, project_id, asked_ms) VALUES (?, ?, ?)",
            params![r.machine_id.as_str(), r.project_id.as_str(), now_ms(hub.clock.as_ref())],
        )?;
        Ok(())
    })
}

/// Erases each Navi whose delete was asked for and that the hub's cache no longer has: its node removed it, whether
/// or not its answer came. One its node still has (it refused, or is yet to answer) waits. How many were erased.
pub fn finish_pending(hub: &Hub) -> Result<usize, StoreError> {
    let asked: Vec<(String, String)> = hub.db.with(|c| {
        Ok(c.prepare("SELECT machine_id, project_id FROM navi_erases")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?)
    })?;
    let mut n = 0;
    for (machine_id, project_id) in asked {
        let r = ProjectRef {
            machine_id: MachineId::unchecked(machine_id),
            project_id: ProjectId::unchecked(project_id),
        };
        if hub.store.project_get(&r)?.is_none() {
            erase(hub, &r)?;
            n += 1;
        }
    }
    Ok(n)
}

/// Projects the hub no longer has, whose rows an older hub left behind: `projects` names their id on no machine,
/// yet a table [`HubStore::machine_project_forget`] or [`erase`] clears still holds them, or a person's sidebar order
/// or pins do. A delete from before every project was erased (D310) left its chat, orders, leads and settings; one
/// since, its max agents and its place in each order. Each is erased and forgotten as a project of a removed machine
/// is (`projects::tools::forget_gone`), which clears every one of those rows, so a second run finds none. A project
/// any machine has under that id is never touched, nor a hub-wide row ([`hub_wide`]). Run at the hub's start; how
/// many were pruned.
///
/// [`HubStore::machine_project_forget`]: crate::hub::store::HubStore::machine_project_forget
pub fn prune_orphans(hub: &Hub) -> Result<usize, StoreError> {
    let orphans = hub.db.with(orphans)?;
    for (machine_id, project_id) in &orphans {
        let r = ProjectRef {
            machine_id: MachineId::unchecked(machine_id),
            project_id: ProjectId::unchecked(project_id),
        };
        erase(hub, &r)?;
        hub.store.machine_project_forget(&r)?;
    }
    Ok(orphans.len())
}

/// A hub-wide row's key, which no project has: a hub-wide MCP server's and skill's are an empty machine and project
/// (`mcp_servers::scope_key`, `skills::versions`). Erasing it as a project's would delete every hub-wide server and
/// skill, and, an empty project's folders being their roots, every project's memory and skills.
pub fn hub_wide(machine_id: &str, project_id: &str) -> bool {
    machine_id.is_empty() || project_id.is_empty()
}

/// Refuses a hub-wide key ([`hub_wide`]) where a project's is meant.
pub fn a_project(r: &ProjectRef) -> Result<(), StoreError> {
    if hub_wide(r.machine_id.as_str(), r.project_id.as_str()) {
        return Err(StoreError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "an empty machine or project id is the hub's own, not a project's: nothing was erased",
        )));
    }
    Ok(())
}

/// [`prune_orphans`]' projects, as (machine, project).
fn orphans(c: &Connection) -> Result<BTreeSet<(String, String)>, StoreError> {
    let live: BTreeSet<String> = c
        .prepare("SELECT project_id FROM projects")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = BTreeSet::new();
    let tables = crate::hub::store::MACHINE_TABLES
        .iter()
        .chain(&["workstreams", "tasks"])
        .filter(|t| **t != "projects");
    for table in tables {
        let has_project = c
            .prepare_cached("SELECT 1 FROM pragma_table_info(?) WHERE name = 'project_id'")?
            .exists([table])?;
        if !has_project {
            continue;
        }
        let rows = c
            .prepare(&format!(
                "SELECT DISTINCT machine_id, project_id FROM {table}"
            ))?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        out.extend(
            rows.into_iter()
                .filter(|(m, p)| !live.contains(p) && !hub_wide(m, p)),
        );
    }
    for table in ["sidebar_orders", "chat_pins"] {
        let lists = c
            .prepare(&format!("SELECT refs FROM {table}"))?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for refs in lists {
            let refs: Vec<ProjectRef> = serde_json::from_str(&refs).unwrap_or_default();
            out.extend(
                refs.into_iter()
                    .filter(|r| {
                        let (m, p) = (r.machine_id.as_str(), r.project_id.as_str());
                        !live.contains(p) && !hub_wide(m, p)
                    })
                    .map(|r| (r.machine_id.to_string(), r.project_id.to_string())),
            );
        }
    }
    Ok(out)
}

/// Prunes what older hubs left of deleted projects ([`prune_orphans`]), then finishes the erases asked for at the
/// hub's start, then at each `project.removed`, until the hub stops.
pub async fn run(hub: Arc<Hub>) {
    match prune_orphans(&hub) {
        Ok(0) => {}
        Ok(n) => tracing::info!(projects = n, "erased what was left of deleted projects"),
        Err(e) => tracing::warn!(error = %e, "what was left of deleted projects wasn't erased"),
    }
    let mut head = hub.events.subscribe();
    let mut cursor = hub.events.head();
    let types = [HubEventType::ProjectRemoved];
    let mut due = true;
    loop {
        head.borrow_and_update();
        if due && let Err(e) = finish_pending(&hub) {
            tracing::warn!(error = %e, "a deleted Navi's erase wasn't finished");
        }
        match hub.events.page(cursor, Some(&types), None) {
            Ok(page) => {
                due = !page.events.is_empty();
                cursor = page.cursor;
                if due || page.more {
                    continue;
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "navi erases: event log read failed");
                due = true;
                tokio::select! {
                    () = hub.shutdown.wait() => return,
                    () = hub.clock.sleep(Duration::from_secs(5)) => {}
                }
                continue;
            }
        }
        tokio::select! {
            () = hub.shutdown.wait() => return,
            changed = head.changed() => if changed.is_err() { return },
        }
    }
}

/// Erases what the hub keeps of the Navi `r`, its rows and its files, and its mark ([`asked`]). Run once its node has
/// forgotten it.
pub fn erase(hub: &Hub, r: &ProjectRef) -> Result<(), StoreError> {
    a_project(r)?;
    // Its tasks' rows go below, so their slots are given back here, while the board still knows whose they are.
    hub.slots.forget_project(r)?;
    erase_in(&hub.db, &hub.config.home, r)
}

/// [`erase`] in the hub database `db` whose home is `home`: `fleetd machine remove` erases a machine's projects
/// with it, from outside the hub's process too.
pub fn erase_in(db: &HubDb, home: &Path, r: &ProjectRef) -> Result<(), StoreError> {
    a_project(r)?;
    let (recordings, blobs) = db.transaction(|c| rows(c, r))?;
    for id in &recordings {
        gone(&crate::hub::browser::dir_in(
            home,
            &BrowserSessionId::unchecked(id),
        ));
    }
    let attachments = crate::hub::intake::attachments::dir_in(home);
    for sha in &blobs {
        // A file another chat or order holds too stays.
        let held = db.with(|c| {
            Ok(
                c.prepare_cached("SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1")?
                    .exists([sha])?,
            )
        })?;
        if !held {
            gone(&attachments.join(sha));
        }
    }
    if let Some(dir) = db.memory().project_dir(r) {
        gone(&dir);
    }
    if let Some(dir) = db.skills().scope_dir(SkillScope::Project, Some(r)) {
        gone(&dir);
    }
    db.with(|c| {
        c.execute(
            "DELETE FROM navi_erases WHERE machine_id = ? AND project_id = ?",
            params![r.machine_id.as_str(), r.project_id.as_str()],
        )?;
        Ok(())
    })
}

/// Deletes the Navi's rows; the ids of its screen recordings and the files of its attachments, for their files.
fn rows(c: &Connection, r: &ProjectRef) -> Result<(Vec<String>, BTreeSet<String>), StoreError> {
    let (m, p, key) = (r.machine_id.as_str(), r.project_id.as_str(), project_key(r));
    let strings = |sql: &str, args: &[&dyn rusqlite::ToSql]| -> Result<Vec<String>, StoreError> {
        Ok(c.prepare(sql)?
            .query_map(args, |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?)
    };
    let recordings = strings(
        "SELECT session_id FROM browser_sessions WHERE machine_id = ? AND project_id = ?",
        &[&m, &p],
    )?;
    // Its orders, as `W<n>`.
    let orders = strings(
        "SELECT 'W' || n FROM workstreams WHERE machine_id = ? AND project_id = ?",
        &[&m, &p],
    )?;
    let mut threads: BTreeSet<String> = BTreeSet::new();
    for sql in [
        "SELECT thread_id FROM threads WHERE machine_id = ? AND project_id = ?",
        "SELECT thread_id FROM leads WHERE machine_id = ? AND project_id = ?",
        "SELECT thread_id FROM session_prompts WHERE machine_id = ? AND project_id = ?",
        "SELECT thread_id FROM memory_refreshes WHERE machine_id = ? AND project_id = ? AND thread_id IS NOT NULL",
    ] {
        threads.extend(strings(sql, &[&m, &p])?);
    }
    let blobs: BTreeSet<String> = strings(
        "SELECT sha256 FROM attachments WHERE project = ?
         OR workstream_id IN (SELECT value FROM json_each(?))",
        &[&key, &serde_json::to_string(&orders)?],
    )?
    .into_iter()
    .collect();

    let orders_json = serde_json::to_string(&orders)?;
    c.execute(
        "DELETE FROM attachments WHERE project = ? OR workstream_id IN (SELECT value FROM json_each(?))",
        params![key, orders_json],
    )?;
    for table in ["navi_ask_orders", "order_env", "time_orders", "time_paths"] {
        c.execute(
            &format!("DELETE FROM {table} WHERE workstream_id IN (SELECT value FROM json_each(?))"),
            [&orders_json],
        )?;
    }
    c.execute(
        "DELETE FROM automation_runs WHERE automation_id IN
           (SELECT automation_id FROM automations WHERE machine_id = ? AND project_id = ?)",
        params![m, p],
    )?;
    c.execute(
        "DELETE FROM automations WHERE machine_id = ? AND project_id = ?",
        params![m, p],
    )?;
    // What its agents wrote to each other: each message's recipients, then the messages.
    c.execute(
        "DELETE FROM agent_message_to WHERE message_n IN
           (SELECT n FROM agent_messages WHERE machine_id = ? AND project_id = ?)",
        params![m, p],
    )?;
    c.execute(
        "DELETE FROM agent_messages WHERE machine_id = ? AND project_id = ?",
        params![m, p],
    )?;
    // The time inspector's spans of its sessions, whose labels hold its commands, searches, URLs and paths: the
    // spans, then each label no other span uses.
    let spans = "FROM time_spans WHERE machine_id = ?1
           AND (project_id = ?2 OR thread_id IN (SELECT value FROM json_each(?3)))";
    let threads_json = serde_json::to_string(&threads)?;
    let labels: Vec<i64> = c
        .prepare(&format!(
            "SELECT DISTINCT label_id {spans} AND label_id IS NOT NULL"
        ))?
        .query_map(params![m, p, threads_json], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    c.execute(&format!("DELETE {spans}"), params![m, p, threads_json])?;
    for label in labels {
        c.execute(
            "DELETE FROM time_labels WHERE id = ?1
               AND NOT EXISTS (SELECT 1 FROM time_spans WHERE label_id = ?1)",
            [label],
        )?;
    }
    for table in BY_THREAD {
        for t in &threads {
            c.execute(
                &format!("DELETE FROM {table} WHERE machine_id = ? AND thread_id = ?"),
                params![m, t],
            )?;
        }
    }
    for table in BY_PROJECT {
        c.execute(
            &format!("DELETE FROM {table} WHERE machine_id = ? AND project_id = ?"),
            params![m, p],
        )?;
    }
    for table in BY_KEY {
        c.execute(
            &format!("DELETE FROM {table} WHERE project_key = ?"),
            [&key],
        )?;
    }
    c.execute(
        "DELETE FROM navi_asks WHERE (from_machine_id = ?1 AND from_project_id = ?2)
           OR (to_machine_id = ?1 AND to_project_id = ?2)",
        params![m, p],
    )?;
    // The event log: its chat's messages ride in their events, under `data.projectRef`; the rest name it at the top.
    // Its project.removed stays: open apps read the log after it to drop the project (W465).
    c.execute(
        "DELETE FROM events WHERE type != 'project.removed'
           AND ((machine_id = ?1 AND json_extract(data, '$.projectId') = ?2)
             OR (json_extract(data, '$.data.projectRef.machineId') = ?1
                 AND json_extract(data, '$.data.projectRef.projectId') = ?2))",
        params![m, p],
    )?;
    // Without its name, as nothing else of it stays: the removal says only which id went from which machine.
    c.execute(
        "UPDATE events SET data = json_set(json_remove(data, '$.data'), '$.summary', ?3)
         WHERE type = 'project.removed' AND machine_id = ?1 AND json_extract(data, '$.projectId') = ?2",
        params![m, p, format!("A project on {m} was removed")],
    )?;
    Ok((recordings, blobs))
}

/// Removes a file or a folder; nothing there is no error, and what can't go is logged.
fn gone(path: &std::path::Path) {
    let removed = match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(_) => return,
    };
    if let Err(e) = removed {
        tracing::warn!(path = %path.display(), "a deleted Navi's file was not removed: {e}");
    }
}
