//! The hub schema: one SQL file per migration in migrations/, run in the order of their prefixes (build.rs lists
//! them). A hub records each one it ran by name, with the SHA-256 of its file, in `migrations_applied`, and runs every
//! one not there, so a file that lands before one a hub already ran still runs. Never edit, rename or remove one that
//! shipped, add a new one. CONTRIBUTING.md says how.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

use super::db::StoreError;

/// One file of migrations/: its name without `.sql`, and its SQL.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Migration {
    pub(crate) name: &'static str,
    pub(crate) sql: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

impl Migration {
    fn sha256(&self) -> String {
        Sha256::digest(self.sql.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

/// An applied migration that no longer matches what ships. It never runs again: the hub says so at its start.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Drift {
    /// Its file changed after it ran.
    Changed(&'static str),
    /// No file of this build has its name: a newer fleetd ran it, or it was removed.
    Unknown(String),
}

/// Runs each of `migrations` that `conn` hasn't, in their order, each in its own write transaction with its record,
/// and returns what ran before but doesn't match now. A database from before names counted its migrations in
/// `user_version`: the first that many are recorded as run, once. `user_version` still counts the ones run, for an
/// older fleetd opening it.
pub(crate) fn migrate(
    conn: &mut Connection,
    migrations: &[Migration],
) -> Result<Vec<Drift>, StoreError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let tracked: Option<String> = tx
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations_applied'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if tracked.is_none() {
        tx.execute_batch(
            "CREATE TABLE migrations_applied (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL) WITHOUT ROWID",
        )?;
        let counted = usize::try_from(user_version(&tx)?).unwrap_or(0);
        for m in migrations.iter().take(counted) {
            record(&tx, m)?;
        }
    }
    tx.commit()?;
    loop {
        // Read inside the lock each time: another process may have migrated while we waited.
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let applied = applied(&tx)?;
        let Some(next) = migrations.iter().find(|m| !applied.contains_key(m.name)) else {
            return Ok(drift(&applied, migrations));
        };
        if next.sql.contains("DROP TABLE profile_settings") {
            log_dropped_overrides(&tx)?;
        }
        tx.execute_batch(next.sql)?;
        record(&tx, next)?;
        tx.pragma_update(None, "user_version", applied.len() + 1)?;
        tx.commit()?;
    }
}

fn record(conn: &Connection, m: &Migration) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO migrations_applied (name, sha256) VALUES (?1, ?2)",
        (m.name, m.sha256()),
    )?;
    Ok(())
}

/// Name to SHA-256 of each migration run.
fn applied(conn: &Connection) -> rusqlite::Result<HashMap<String, String>> {
    conn.prepare("SELECT name, sha256 FROM migrations_applied")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect()
}

fn drift(applied: &HashMap<String, String>, migrations: &[Migration]) -> Vec<Drift> {
    let mut found: Vec<Drift> = migrations
        .iter()
        .filter(|m| applied.get(m.name).is_some_and(|sha| *sha != m.sha256()))
        .map(|m| Drift::Changed(m.name))
        .collect();
    let mut unknown: Vec<&String> = applied
        .keys()
        .filter(|name| !migrations.iter().any(|m| m.name == name.as_str()))
        .collect();
    unknown.sort();
    found.extend(unknown.into_iter().map(|name| Drift::Unknown(name.clone())));
    found
}

pub(crate) fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

/// Profiles became rows (W146), which a project only allows: one line for each project's model or effort override
/// the migration drops, so a person can make a profile of it.
fn log_dropped_overrides(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT machine_id, project_id, profile, model, effort FROM profile_settings WHERE project_id != ''
         ORDER BY machine_id, project_id, profile",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
        ))
    })?;
    for row in rows {
        let (machine, project, profile, model, effort) = row?;
        tracing::warn!(
            project = format!("{machine}/{project}"),
            profile,
            model = model.as_deref().unwrap_or("-"),
            effort = effort.as_deref().unwrap_or("-"),
            "profiles: a project's override of a profile is dropped; make a profile of it and allow it in the project"
        );
    }
    Ok(())
}
