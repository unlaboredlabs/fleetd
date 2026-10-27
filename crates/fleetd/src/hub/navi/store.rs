//! The `assistants` table: one row per Navi, the project it is, the key that made it and when it was archived.
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::model::ProjectCreator;
use rusqlite::{Connection, OptionalExtension, params};

use crate::hub::store::iso_ms;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Navi {
    pub created_by: ProjectCreator,
    pub created_ms: i64,
    pub archived_at: Option<Timestamp>,
}

pub fn of(db: &Connection, r: &ProjectRef) -> rusqlite::Result<Option<Navi>> {
    db.prepare_cached(
        "SELECT created_by_key, created_by_name, created_ms, archived_ms FROM assistants
         WHERE machine_id = ? AND project_id = ?",
    )?
    .query_row(
        params![r.machine_id.as_str(), r.project_id.as_str()],
        |row| {
            Ok(Navi {
                created_by: ProjectCreator {
                    key_id: row.get(0)?,
                    name: row.get(1)?,
                },
                created_ms: row.get(2)?,
                archived_at: row.get::<_, Option<i64>>(3)?.map(|ms| iso_ms(ms).into()),
            })
        },
    )
    .optional()
}

pub fn put(
    db: &Connection,
    r: &ProjectRef,
    by: &ProjectCreator,
    at_ms: i64,
) -> rusqlite::Result<()> {
    db.prepare_cached(
        "INSERT INTO assistants (machine_id, project_id, created_ms, created_by_key, created_by_name)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (machine_id, project_id) DO NOTHING",
    )?
    .execute(params![r.machine_id.as_str(), r.project_id.as_str(), at_ms, by.key_id, by.name])?;
    Ok(())
}

pub fn remove(db: &Connection, r: &ProjectRef) -> rusqlite::Result<()> {
    db.prepare_cached("DELETE FROM assistants WHERE machine_id = ? AND project_id = ?")?
        .execute(params![r.machine_id.as_str(), r.project_id.as_str()])?;
    Ok(())
}

/// `None` brings it back.
pub fn set_archived(db: &Connection, r: &ProjectRef, at_ms: Option<i64>) -> rusqlite::Result<()> {
    db.prepare_cached(
        "UPDATE assistants SET archived_ms = ? WHERE machine_id = ? AND project_id = ?",
    )?
    .execute(params![at_ms, r.machine_id.as_str(), r.project_id.as_str()])?;
    Ok(())
}

/// Every Navi, oldest first.
pub fn all(db: &Connection) -> rusqlite::Result<Vec<ProjectRef>> {
    let mut stmt = db.prepare_cached(
        "SELECT machine_id, project_id FROM assistants ORDER BY created_ms, rowid",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ProjectRef {
            machine_id: fleetd_contracts::ids::MachineId::unchecked(row.get::<_, String>(0)?),
            project_id: fleetd_contracts::ids::ProjectId::unchecked(row.get::<_, String>(1)?),
        })
    })?;
    rows.collect()
}

/// Whether the Navi may fetch and open `site` without asking.
pub fn site_allowed(db: &Connection, r: &ProjectRef, site: &str) -> rusqlite::Result<bool> {
    db.prepare_cached(
        "SELECT 1 FROM navi_sites WHERE machine_id = ? AND project_id = ? AND site = ?",
    )?
    .query_row(
        params![r.machine_id.as_str(), r.project_id.as_str(), site],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
}

pub fn allow_site(
    db: &Connection,
    r: &ProjectRef,
    site: &str,
    by: &str,
    at_ms: i64,
) -> rusqlite::Result<()> {
    db.prepare_cached(
        "INSERT INTO navi_sites (machine_id, project_id, site, allowed_ms, allowed_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id, site) DO NOTHING",
    )?
    .execute(params![r.machine_id.as_str(), r.project_id.as_str(), site, at_ms, by])?;
    Ok(())
}

pub fn revoke_site(db: &Connection, r: &ProjectRef, site: &str) -> rusqlite::Result<()> {
    db.prepare_cached(
        "DELETE FROM navi_sites WHERE machine_id = ? AND project_id = ? AND site = ?",
    )?
    .execute(params![r.machine_id.as_str(), r.project_id.as_str(), site])?;
    Ok(())
}

/// The Navi's allowed sites, by site.
pub fn sites(
    db: &Connection,
    r: &ProjectRef,
) -> rusqlite::Result<Vec<fleetd_contracts::mcp::NaviSite>> {
    let mut stmt = db.prepare_cached(
        "SELECT site, allowed_ms, allowed_by FROM navi_sites WHERE machine_id = ? AND project_id = ? ORDER BY site",
    )?;
    let rows = stmt.query_map(
        params![r.machine_id.as_str(), r.project_id.as_str()],
        |row| {
            Ok(fleetd_contracts::mcp::NaviSite {
                site: row.get(0)?,
                allowed_at: iso_ms(row.get(1)?).into(),
                allowed_by: row.get(2)?,
            })
        },
    )?;
    rows.collect()
}
