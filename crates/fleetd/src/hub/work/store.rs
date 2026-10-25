//! Work rows: `work_claims` (the Claim as JSON in `data`, plus the columns queries filter on) and `work_projects`
//! (the repo and base each project's work lands on).
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::prim::Line;
use fleetd_contracts::work::{Claim, ClaimId, ClaimState, RepoKey, WorkScope};
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::hub::store::parse_ms;

fn number_of(claim_id: &ClaimId) -> i64 {
    claim_id.as_str()[1..].parse().unwrap_or(0)
}

pub fn state_str(state: ClaimState) -> &'static str {
    match state {
        ClaimState::Active => "active",
        ClaimState::Landed => "landed",
        ClaimState::Released => "released",
        ClaimState::Expired => "expired",
    }
}

fn decode(data: &str) -> rusqlite::Result<Claim> {
    serde_json::from_str(data).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn claim_of(row: &Row<'_>) -> rusqlite::Result<Claim> {
    decode(&row.get::<_, String>(0)?)
}

fn write(db: &Connection, claim: &Claim) -> rusqlite::Result<()> {
    let ended_ms = claim.end.as_ref().and_then(|e| parse_ms(e.at.as_str()));
    db.prepare_cached(
        "UPDATE work_claims SET state = ?, expires_ms = ?, ended_ms = ?, data = ? WHERE n = ?",
    )?
    .execute(params![
        state_str(claim.state),
        parse_ms(claim.expires_at.as_str()).unwrap_or(0),
        ended_ms,
        serde_json::to_string(claim).expect("a Claim encodes"),
        number_of(&claim.claim_id),
    ])?;
    Ok(())
}

/// Numbers the claim (`C<n>`) and stores it. `claim.claim_id` is ignored.
pub fn insert(db: &Connection, mut claim: Claim) -> rusqlite::Result<Claim> {
    let n: i64 = db
        .prepare_cached(
            "INSERT INTO work_claims (repo_key, base, state, owner_key, expires_ms, data)
             VALUES (?, ?, ?, ?, 0, '') RETURNING n",
        )?
        .query_row(
            params![
                claim.repo_key.as_str(),
                claim.base.as_str(),
                state_str(claim.state),
                claim.owner.key_id.as_str()
            ],
            |r| r.get(0),
        )?;
    claim.claim_id = ClaimId::unchecked(format!("C{n}"));
    write(db, &claim)?;
    Ok(claim)
}

pub fn put(db: &Connection, claim: &Claim) -> rusqlite::Result<()> {
    write(db, claim)
}

pub fn get(db: &Connection, claim_id: &ClaimId) -> rusqlite::Result<Option<Claim>> {
    db.prepare_cached("SELECT data FROM work_claims WHERE n = ?")?
        .query_row([number_of(claim_id)], claim_of)
        .optional()
}

/// The scope's active claims, and those that expired after `expired_since_ms`. Newest first.
pub fn in_scope(
    db: &Connection,
    scope: &WorkScope,
    expired_since_ms: i64,
) -> rusqlite::Result<Vec<Claim>> {
    db.prepare_cached(
        "SELECT data FROM work_claims WHERE repo_key = ?1 AND base = ?2
           AND (state = 'active' OR (state = 'expired' AND ended_ms > ?3))
         ORDER BY n DESC",
    )?
    .query_map(
        params![
            scope.repo_key.as_str(),
            scope.base.as_str(),
            expired_since_ms
        ],
        claim_of,
    )?
    .collect()
}

/// Active claims whose time ran out by `now_ms`, oldest first.
pub fn due(db: &Connection, now_ms: i64) -> rusqlite::Result<Vec<Claim>> {
    db.prepare_cached(
        "SELECT data FROM work_claims WHERE state = 'active' AND expires_ms <= ? ORDER BY n",
    )?
    .query_map([now_ms], claim_of)?
    .collect()
}

/// The owner's active claims, oldest first.
pub fn active_of_owner(db: &Connection, key_id: &str) -> rusqlite::Result<Vec<Claim>> {
    db.prepare_cached(
        "SELECT data FROM work_claims WHERE state = 'active' AND owner_key = ? ORDER BY n",
    )?
    .query_map([key_id], claim_of)?
    .collect()
}

/// Records the repo and base the project's work lands on, replacing what it had.
pub fn bind(
    db: &Connection,
    project: &ProjectRef,
    scope: &WorkScope,
    now_ms: i64,
) -> rusqlite::Result<()> {
    db.prepare_cached(
        "INSERT INTO work_projects (machine_id, project_id, repo_key, base, updated_ms) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET repo_key = ?3, base = ?4, updated_ms = ?5",
    )?
    .execute(params![
        project.machine_id.as_str(),
        project.project_id.as_str(),
        scope.repo_key.as_str(),
        scope.base.as_str(),
        now_ms
    ])?;
    Ok(())
}

pub fn scope_of(db: &Connection, project: &ProjectRef) -> rusqlite::Result<Option<WorkScope>> {
    db.prepare_cached(
        "SELECT repo_key, base FROM work_projects WHERE machine_id = ? AND project_id = ?",
    )?
    .query_row(
        params![project.machine_id.as_str(), project.project_id.as_str()],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
    .map(|row| {
        row.map(|(repo_key, base)| WorkScope {
            repo_key: RepoKey::unchecked(repo_key),
            base: Line::unchecked(base),
        })
    })
}

/// Every project whose work lands on the scope, in a stable order.
pub fn projects_in(db: &Connection, scope: &WorkScope) -> rusqlite::Result<Vec<ProjectRef>> {
    db.prepare_cached(
        "SELECT machine_id, project_id FROM work_projects WHERE repo_key = ? AND base = ?
         ORDER BY machine_id, project_id",
    )?
    .query_map(params![scope.repo_key.as_str(), scope.base.as_str()], |r| {
        Ok(ProjectRef {
            machine_id: MachineId::unchecked(r.get::<_, String>(0)?),
            project_id: ProjectId::unchecked(r.get::<_, String>(1)?),
        })
    })?
    .collect()
}
