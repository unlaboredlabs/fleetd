//! What the hub keeps of a project beyond its node's report, in its own `project_settings` columns (D310): Only me
//! (`only_me`, every former Navi's), the key that made it, its owner, when it was archived and the card it pays with.
//! A Navi is an Only me project.
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::model::ProjectCreator;
use fleetd_contracts::people::PersonId;
use rusqlite::{Connection, OptionalExtension, params};

use crate::hub::store::iso_ms;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Navi {
    pub created_by: ProjectCreator,
    pub created_ms: i64,
    pub archived_at: Option<Timestamp>,
    /// The person it belongs to (D215); none on a hub without people.
    pub owner: Option<PersonId>,
}

/// What the hub keeps of any project: its owner, maker and archive, whether Only me or not. None for a project with no
/// row of its own.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Kept {
    pub only_me: bool,
    pub created_by: Option<ProjectCreator>,
    pub owner: Option<PersonId>,
    pub archived_at: Option<Timestamp>,
}

pub fn kept(db: &Connection, r: &ProjectRef) -> rusqlite::Result<Option<Kept>> {
    db.prepare_cached(
        "SELECT only_me, created_by_key, created_by_name, owner_person, archived_ms FROM project_settings
         WHERE machine_id = ? AND project_id = ?",
    )?
    .query_row(
        params![r.machine_id.as_str(), r.project_id.as_str()],
        |row| {
            let key: Option<String> = row.get(1)?;
            let name: Option<String> = row.get(2)?;
            Ok(Kept {
                only_me: row.get(0)?,
                created_by: key.map(|key_id| ProjectCreator {
                    key_id,
                    name: name.unwrap_or_default(),
                }),
                owner: row.get::<_, Option<String>>(3)?.map(PersonId::unchecked),
                archived_at: row.get::<_, Option<i64>>(4)?.map(|ms| iso_ms(ms).into()),
            })
        },
    )
    .optional()
}

/// Turns Only me on or off. On, the project becomes `owner`'s when it has no owner yet; off, it is everyone's on the
/// hub, and keeps its owner for when it is turned on again.
pub fn set_only_me(
    db: &Connection,
    r: &ProjectRef,
    on: bool,
    owner: Option<&PersonId>,
) -> rusqlite::Result<()> {
    db.prepare_cached(
        "INSERT INTO project_settings (machine_id, project_id, only_me, owner_person) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET only_me = excluded.only_me,
           owner_person = COALESCE(project_settings.owner_person, excluded.owner_person)",
    )?
    .execute(params![
        r.machine_id.as_str(),
        r.project_id.as_str(),
        on,
        owner.filter(|_| on).map(PersonId::as_str)
    ])?;
    Ok(())
}

/// Makes `person` the project's owner when it has none, Only me as it was: the one person a Telegram bridge answers as.
pub fn claim(db: &Connection, r: &ProjectRef, person: &PersonId) -> rusqlite::Result<()> {
    db.prepare_cached(
        "INSERT INTO project_settings (machine_id, project_id, owner_person) VALUES (?1, ?2, ?3)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET
           owner_person = COALESCE(project_settings.owner_person, excluded.owner_person)",
    )?
    .execute(params![
        r.machine_id.as_str(),
        r.project_id.as_str(),
        person.as_str()
    ])?;
    Ok(())
}

pub fn of(db: &Connection, r: &ProjectRef) -> rusqlite::Result<Option<Navi>> {
    db.prepare_cached(
        "SELECT created_by_key, created_by_name, created_ms, archived_ms, owner_person FROM project_settings
         WHERE machine_id = ? AND project_id = ? AND only_me = 1",
    )?
    .query_row(
        params![r.machine_id.as_str(), r.project_id.as_str()],
        |row| {
            Ok(Navi {
                created_by: ProjectCreator {
                    key_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                },
                created_ms: row.get::<_, Option<i64>>(2)?.unwrap_or_default(),
                archived_at: row.get::<_, Option<i64>>(3)?.map(|ms| iso_ms(ms).into()),
                owner: row.get::<_, Option<String>>(4)?.map(PersonId::unchecked),
            })
        },
    )
    .optional()
}

pub fn put(
    db: &Connection,
    r: &ProjectRef,
    by: &ProjectCreator,
    owner: Option<&PersonId>,
    at_ms: i64,
) -> rusqlite::Result<()> {
    db.prepare_cached(
        "INSERT INTO project_settings (machine_id, project_id, only_me, created_ms, created_by_key, created_by_name,
           owner_person) VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET only_me = 1, created_ms = excluded.created_ms,
           created_by_key = excluded.created_by_key, created_by_name = excluded.created_by_name,
           owner_person = excluded.owner_person WHERE only_me = 0",
    )?
    .execute(params![
        r.machine_id.as_str(),
        r.project_id.as_str(),
        at_ms,
        by.key_id,
        by.name,
        owner.map(PersonId::as_str)
    ])?;
    Ok(())
}

/// Unmarks a Navi whose folder couldn't be made: its project has nothing else yet.
pub fn remove(db: &Connection, r: &ProjectRef) -> rusqlite::Result<()> {
    db.prepare_cached("DELETE FROM project_settings WHERE machine_id = ? AND project_id = ?")?
        .execute(params![r.machine_id.as_str(), r.project_id.as_str()])?;
    Ok(())
}

/// Archives any project; `None` brings it back.
pub fn set_archived(db: &Connection, r: &ProjectRef, at_ms: Option<i64>) -> rusqlite::Result<()> {
    db.prepare_cached(
        "INSERT INTO project_settings (machine_id, project_id, archived_ms) VALUES (?2, ?3, ?1)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET archived_ms = excluded.archived_ms",
    )?
    .execute(params![at_ms, r.machine_id.as_str(), r.project_id.as_str()])?;
    Ok(())
}

/// Whether `r` is archived.
pub fn archived(db: &Connection, r: &ProjectRef) -> rusqlite::Result<bool> {
    Ok(db
        .prepare_cached(
            "SELECT 1 FROM project_settings WHERE machine_id = ? AND project_id = ? AND archived_ms IS NOT NULL",
        )?
        .query_row(params![r.machine_id.as_str(), r.project_id.as_str()], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Every Navi, oldest first.
pub fn all(db: &Connection) -> rusqlite::Result<Vec<ProjectRef>> {
    let mut stmt = db.prepare_cached(
        "SELECT machine_id, project_id FROM project_settings WHERE only_me = 1 ORDER BY created_ms, rowid",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ProjectRef {
            machine_id: fleetd_contracts::ids::MachineId::unchecked(row.get::<_, String>(0)?),
            project_id: fleetd_contracts::ids::ProjectId::unchecked(row.get::<_, String>(1)?),
        })
    })?;
    rows.collect()
}

/// The Navis with an owner other than `person` (every owned one for `None`): those a caller may not see or use.
pub fn others(db: &Connection, person: Option<&PersonId>) -> rusqlite::Result<Vec<ProjectRef>> {
    let mut stmt = db.prepare_cached(
        "SELECT machine_id, project_id FROM project_settings
         WHERE only_me = 1 AND owner_person IS NOT NULL AND (?1 IS NULL OR owner_person != ?1)",
    )?;
    let rows = stmt.query_map([person.map(PersonId::as_str)], |row| {
        Ok(ProjectRef {
            machine_id: fleetd_contracts::ids::MachineId::unchecked(row.get::<_, String>(0)?),
            project_id: fleetd_contracts::ids::ProjectId::unchecked(row.get::<_, String>(1)?),
        })
    })?;
    rows.collect()
}

/// Archives `person`'s Only-me projects not archived yet, as they are removed from the hub: an archived project's lead
/// takes no turn, its automations' included. The ones it archived.
pub fn archive_of(
    db: &Connection,
    person: &PersonId,
    at_ms: i64,
) -> rusqlite::Result<Vec<ProjectRef>> {
    let mut stmt = db.prepare_cached(
        "UPDATE project_settings SET archived_ms = ?2
         WHERE only_me = 1 AND owner_person = ?1 AND archived_ms IS NULL RETURNING machine_id, project_id",
    )?;
    let rows = stmt.query_map(params![person.as_str(), at_ms], |row| {
        Ok(ProjectRef {
            machine_id: fleetd_contracts::ids::MachineId::unchecked(row.get::<_, String>(0)?),
            project_id: fleetd_contracts::ids::ProjectId::unchecked(row.get::<_, String>(1)?),
        })
    })?;
    rows.collect()
}

/// The Only-me projects of people removed from the hub, each with its owner, oldest first.
pub fn left(db: &Connection) -> rusqlite::Result<Vec<(ProjectRef, PersonId)>> {
    let mut stmt = db.prepare_cached(
        "SELECT s.machine_id, s.project_id, s.owner_person FROM project_settings s
         JOIN people p ON p.person_id = s.owner_person
         WHERE s.only_me = 1 AND p.removed_ms IS NOT NULL ORDER BY s.created_ms, s.rowid",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            ProjectRef {
                machine_id: fleetd_contracts::ids::MachineId::unchecked(row.get::<_, String>(0)?),
                project_id: fleetd_contracts::ids::ProjectId::unchecked(row.get::<_, String>(1)?),
            },
            PersonId::unchecked(row.get::<_, String>(2)?),
        ))
    })?;
    rows.collect()
}

/// Gives every Navi with no owner to `person`: a hub's first owner takes the Navis from before people.
pub fn adopt(db: &Connection, person: &PersonId) -> rusqlite::Result<()> {
    db.prepare_cached(
        "UPDATE project_settings SET owner_person = ? WHERE only_me = 1 AND owner_person IS NULL",
    )?
    .execute([person.as_str()])?;
    Ok(())
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

/// The card the Navi pays with, as its `op://vault/item` reference.
pub fn card(db: &Connection, r: &ProjectRef) -> rusqlite::Result<Option<String>> {
    Ok(db
        .prepare_cached(
            "SELECT card_ref FROM project_settings WHERE machine_id = ? AND project_id = ?",
        )?
        .query_row(
            params![r.machine_id.as_str(), r.project_id.as_str()],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// `None`: the Navi has no card.
pub fn set_card(db: &Connection, r: &ProjectRef, card: Option<&str>) -> rusqlite::Result<()> {
    db.prepare_cached(
        "UPDATE project_settings SET card_ref = ? WHERE machine_id = ? AND project_id = ?",
    )?
    .execute(params![card, r.machine_id.as_str(), r.project_id.as_str()])?;
    Ok(())
}
