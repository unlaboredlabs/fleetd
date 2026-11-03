//! Deleting a Navi erases it (D287 navi.delete-erases): `project_remove` of a Navi forgets it on its node, which also
//! deletes its sessions, Claude Code's transcripts of them and the attachments in its folder (the folder too when the
//! person ticks it, `node/sessions`), then [`erase`] deletes everything of it the hub keeps: its chat and the events
//! that carried it, its approvals and purchases (`requests`), asks and decisions, its orders and what they hold, its
//! memory and skills, its attachments and its screen recordings. Its settings go with the project as any project's do
//! (`HubStore::project_remove`).
use std::collections::BTreeSet;

use fleetd_contracts::browser::BrowserSessionId;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::skills::SkillScope;
use rusqlite::{Connection, params};

use crate::hub::api::Hub;
use crate::hub::ledger::project_key;
use crate::hub::store::StoreError;

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
    "telegram_bridges",
    "telegram_cards",
    "browser_sessions",
    "screen_waits",
    "session_prompts",
    "tasks",
    "slot_claims",
    "workstreams",
];

/// Tables with rows of the Navi's sessions, by `machine_id` and `thread_id`.
const BY_THREAD: &[&str] = &[
    "threads",
    "wakes",
    "queued_writes",
    "steers",
    "thread_accounts",
    "task_threads",
];

/// Tables with the Navi's rows by `project_key` (`<machine>/<project>`).
const BY_KEY: &[&str] = &["requests", "legacy_asks", "decisions"];

/// Erases what the hub keeps of the Navi `r`, its rows and its files. Run once its node has forgotten it.
pub fn erase(hub: &Hub, r: &ProjectRef) -> Result<(), StoreError> {
    let (recordings, blobs) = hub.db.transaction(|c| rows(c, r))?;
    for id in &recordings {
        gone(&crate::hub::browser::dir(
            hub,
            &BrowserSessionId::unchecked(id),
        ));
    }
    let attachments = crate::hub::intake::attachments::dir(hub);
    for sha in &blobs {
        // A file another chat or order holds too stays.
        let held = hub.db.with(|c| {
            Ok(
                c.prepare_cached("SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1")?
                    .exists([sha])?,
            )
        })?;
        if !held {
            gone(&attachments.join(sha));
        }
    }
    if let Some(dir) = hub.db.memory().project_dir(r) {
        gone(&dir);
    }
    if let Some(dir) = hub.db.skills().scope_dir(SkillScope::Project, Some(r)) {
        gone(&dir);
    }
    Ok(())
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
    for table in ["navi_ask_orders", "order_env", "time_orders"] {
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
    c.execute(
        "DELETE FROM events WHERE (machine_id = ?1 AND json_extract(data, '$.projectId') = ?2)
           OR (json_extract(data, '$.data.projectRef.machineId') = ?1
               AND json_extract(data, '$.data.projectRef.projectId') = ?2)",
        params![m, p],
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
