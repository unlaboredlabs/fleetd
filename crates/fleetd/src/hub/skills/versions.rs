//! A hub-kept skill's history and its use (W238). Every write of its `SKILL.md` keeps a version in `skill_versions`:
//! who wrote it (a Navi or lead, or a person), when, the one line on why, and the whole text, the newest
//! [`SKILL_VERSIONS_KEPT`] of them. A revert is a new version with an older one's text. `skill_uses` holds a skill as
//! one project's sessions get it: turned off there, and when one of them last ran it (`used`, from the hub's view of
//! the session's Skill calls). Both go with the skill's delete and the project's.
use std::collections::{HashMap, HashSet};

use fleetd_contracts::ids::{ProjectId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::prim::{Int, Line};
use fleetd_contracts::skills::{
    SKILL_VERSIONS_KEPT, SkillAuthor, SkillName, SkillScope, SkillVersion, WHY_CAP,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::hub::store::{HubDb, StoreError, iso_ms};

/// Who writes a version, and why.
#[derive(Clone, Debug, PartialEq)]
pub struct Who {
    pub author: SkillAuthor,
    /// The Navi's (or lead's project's) title, or the person's name.
    pub by: String,
    pub why: Option<String>,
    pub at_ms: i64,
}

impl Who {
    pub fn person(by: &str, why: Option<&str>, at_ms: i64) -> Self {
        Self {
            author: SkillAuthor::Person,
            by: by.to_owned(),
            why: why.map(str::to_owned),
            at_ms,
        }
    }

    pub fn agent(by: &str, why: &str, at_ms: i64) -> Self {
        Self {
            author: SkillAuthor::Agent,
            by: by.to_owned(),
            why: Some(why.to_owned()),
            at_ms,
        }
    }
}

/// A scope's key in both tables: a project's machine and id, or two empty strings for the global scope.
fn key(scope: SkillScope, r: Option<&ProjectRef>) -> (&str, &str) {
    match (scope, r) {
        (SkillScope::Project, Some(r)) => (r.machine_id.as_str(), r.project_id.as_str()),
        _ => ("", ""),
    }
}

fn author_of(s: &str) -> SkillAuthor {
    if s == "agent" {
        SkillAuthor::Agent
    } else {
        SkillAuthor::Person
    }
}

fn author_name(a: SkillAuthor) -> &'static str {
    match a {
        SkillAuthor::Agent => "agent",
        SkillAuthor::Person => "person",
    }
}

fn clip(s: &str, cap: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    one.chars().take(cap).collect()
}

const COLUMNS: &str = "version, author, by_name, why, at_ms";

fn row_version(row: &rusqlite::Row<'_>) -> rusqlite::Result<SkillVersion> {
    let by: String = row.get(2)?;
    let why: Option<String> = row.get(3)?;
    Ok(SkillVersion {
        version: Int::unchecked(row.get(0)?),
        author: author_of(&row.get::<_, String>(1)?),
        by: Line::unchecked(if by.is_empty() { "someone".into() } else { by }),
        at: Timestamp(iso_ms(row.get(4)?)),
        why: why.filter(|w| !w.is_empty()).map(Line::unchecked),
    })
}

/// Keeps `text` as the skill's next version; returns its number. Only the newest [`SKILL_VERSIONS_KEPT`] stay.
pub(super) fn keep(
    c: &Connection,
    scope: SkillScope,
    r: Option<&ProjectRef>,
    name: &SkillName,
    text: &str,
    who: &Who,
) -> Result<i64, StoreError> {
    let (m, p) = key(scope, r);
    let last: Option<i64> = c.query_row(
        "SELECT MAX(version) FROM skill_versions WHERE machine_id = ? AND project_id = ? AND name = ?",
        params![m, p, name.as_str()],
        |row| row.get(0),
    )?;
    let version = last.unwrap_or(0) + 1;
    c.execute(
        "INSERT INTO skill_versions (machine_id, project_id, name, version, author, by_name, why, text, at_ms) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            m,
            p,
            name.as_str(),
            version,
            author_name(who.author),
            clip(&who.by, 200),
            who.why
                .as_deref()
                .map(|w| clip(w, WHY_CAP))
                .filter(|w| !w.is_empty()),
            text,
            who.at_ms
        ],
    )?;
    c.execute(
        "DELETE FROM skill_versions WHERE machine_id = ? AND project_id = ? AND name = ? AND version <= ?",
        params![m, p, name.as_str(), version - SKILL_VERSIONS_KEPT as i64],
    )?;
    Ok(version)
}

/// Drops a deleted skill's versions, and in a project its off switch and last use there.
pub(super) fn forget(
    c: &Connection,
    scope: SkillScope,
    r: Option<&ProjectRef>,
    name: &SkillName,
) -> Result<(), StoreError> {
    let (m, p) = key(scope, r);
    for table in ["skill_versions", "skill_uses"] {
        c.execute(
            &format!("DELETE FROM {table} WHERE machine_id = ? AND project_id = ? AND name = ?"),
            params![m, p, name.as_str()],
        )?;
    }
    Ok(())
}

/// The skill's versions, newest first, without their texts.
pub fn list(
    db: &HubDb,
    scope: SkillScope,
    r: Option<&ProjectRef>,
    name: &SkillName,
) -> Result<Vec<SkillVersion>, StoreError> {
    let (m, p) = key(scope, r);
    db.with(|c| {
        let mut st = c.prepare_cached(&format!(
            "SELECT {COLUMNS} FROM skill_versions WHERE machine_id = ? AND project_id = ? AND name = ? \
             ORDER BY version DESC"
        ))?;
        let rows = st.query_map(params![m, p, name.as_str()], row_version)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// The skill's newest version, without its text.
pub fn newest(
    db: &HubDb,
    scope: SkillScope,
    r: Option<&ProjectRef>,
    name: &SkillName,
) -> Result<Option<SkillVersion>, StoreError> {
    let (m, p) = key(scope, r);
    db.with(|c| {
        Ok(c.query_row(
            &format!(
                "SELECT {COLUMNS} FROM skill_versions WHERE machine_id = ? AND project_id = ? AND name = ? \
                 ORDER BY version DESC LIMIT 1"
            ),
            params![m, p, name.as_str()],
            row_version,
        )
        .optional()?)
    })
}

/// One version with its text.
pub fn get(
    db: &HubDb,
    scope: SkillScope,
    r: Option<&ProjectRef>,
    name: &SkillName,
    version: i64,
) -> Result<Option<(SkillVersion, String)>, StoreError> {
    let (m, p) = key(scope, r);
    db.with(|c| {
        Ok(c.query_row(
            &format!(
                "SELECT {COLUMNS}, text FROM skill_versions WHERE machine_id = ? AND project_id = ? AND name = ? \
                 AND version = ?"
            ),
            params![m, p, name.as_str(), version],
            |row| Ok((row_version(row)?, row.get::<_, String>(5)?)),
        )
        .optional()?)
    })
}

/// How a project's sessions get a skill: off there, and its last use there.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Use {
    pub off: bool,
    pub last_used_ms: Option<i64>,
}

/// Every skill of the project's that is off or was used, by name.
pub fn uses(db: &HubDb, r: &ProjectRef) -> Result<HashMap<String, Use>, StoreError> {
    db.with(|c| {
        let mut st = c.prepare_cached(
            "SELECT name, off, last_used_ms FROM skill_uses WHERE machine_id = ? AND project_id = ?",
        )?;
        let rows = st.query_map(params![r.machine_id.as_str(), r.project_id.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Use {
                    off: row.get::<_, i64>(1)? != 0,
                    last_used_ms: row.get(2)?,
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    })
}

/// The skills turned off in any of `projects`.
pub fn off_in(db: &HubDb, projects: &[&ProjectRef]) -> Result<HashSet<String>, StoreError> {
    let mut out = HashSet::new();
    for r in projects {
        out.extend(
            uses(db, r)?
                .into_iter()
                .filter(|(_, u)| u.off)
                .map(|(n, _)| n),
        );
    }
    Ok(out)
}

/// Turns a skill off in the project, or back on.
pub fn set_off(db: &HubDb, r: &ProjectRef, name: &SkillName, off: bool) -> Result<(), StoreError> {
    db.with(|c| {
        c.execute(
            "INSERT INTO skill_uses (machine_id, project_id, name, off) VALUES (?, ?, ?, ?) \
             ON CONFLICT (machine_id, project_id, name) DO UPDATE SET off = excluded.off",
            params![
                r.machine_id.as_str(),
                r.project_id.as_str(),
                name.as_str(),
                off
            ],
        )?;
        Ok(())
    })
}

/// One of the project's sessions ran the skill just now.
pub fn used(db: &HubDb, r: &ProjectRef, name: &SkillName, at_ms: i64) -> Result<(), StoreError> {
    db.with(|c| {
        c.execute(
            "INSERT INTO skill_uses (machine_id, project_id, name, last_used_ms) VALUES (?, ?, ?, ?) \
             ON CONFLICT (machine_id, project_id, name) DO UPDATE SET last_used_ms = excluded.last_used_ms",
            params![r.machine_id.as_str(), r.project_id.as_str(), name.as_str(), at_ms],
        )?;
        Ok(())
    })
}

/// The project a session is in, as the hub's threads know it.
fn project_of(db: &HubDb, thread: &ThreadRef) -> Result<Option<ProjectRef>, StoreError> {
    db.with(|c| {
        Ok(c.query_row(
            "SELECT project_id FROM threads WHERE machine_id = ? AND thread_id = ?",
            params![thread.machine_id.as_str(), thread.thread_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
    })
    .map(|id| {
        id.map(|id| ProjectRef {
            machine_id: thread.machine_id.clone(),
            project_id: ProjectId::unchecked(id),
        })
    })
}

/// A session ran `ran` (`fleetd:<name>`) with the Skill tool: its project's last use of it is now. Its own skills
/// (`.claude/skills`) and the person's carry no prefix and aren't the hub's, so they are left alone.
pub fn ran(db: &HubDb, thread: &ThreadRef, ran: &str, at_ms: i64) -> Result<(), StoreError> {
    let Some(name) = ran
        .strip_prefix("fleetd:")
        .and_then(|n| SkillName::new(n).ok())
    else {
        return Ok(());
    };
    let Some(r) = project_of(db, thread)? else {
        return Ok(());
    };
    used(db, &r, &name, at_ms)
}

/// From `hub/serve`: every Skill call a session the hub follows finishes counts as its project's last use.
pub fn watch_uses(hub: &std::sync::Arc<crate::hub::api::Hub>) {
    let weak = std::sync::Arc::downgrade(hub);
    hub.executors
        .set_skill_sink(std::sync::Arc::new(move |thread, skill| {
            let Some(hub) = weak.upgrade() else { return };
            let at = crate::hub::store::now_ms(hub.clock.as_ref());
            if let Err(error) = ran(&hub.db, thread, skill, at) {
                tracing::warn!(%error, "skills: a use not kept");
            }
        }));
}
