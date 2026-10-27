//! Work rows: `work_claims` (the Claim as JSON in `data`, plus the columns queries filter on), `work_projects`
//! (the repo and base each project's work lands on), `landings` (each commit on a watched base, as JSON) and
//! `landing_watch` (how far each watched base has been read). A project's own repo (`repos`) carries the same repo and
//! base: binding writes both, and `work_projects` stays so a rolled-back hub still reads it.
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::prim::Line;
use fleetd_contracts::repos::RepoId;
use fleetd_contracts::tasks::Task;
use fleetd_contracts::work::{Claim, ClaimId, ClaimState, LandingRoute, RepoKey, WorkScope};
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::landings::Landing;
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

fn decode<T: serde::de::DeserializeOwned>(data: &str) -> rusqlite::Result<T> {
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

/// Forgets the repo and base the project's work landed on.
pub fn unbind(db: &Connection, project: &ProjectRef) -> rusqlite::Result<()> {
    db.prepare_cached("DELETE FROM work_projects WHERE machine_id = ? AND project_id = ?")?
        .execute(params![
            project.machine_id.as_str(),
            project.project_id.as_str()
        ])?;
    Ok(())
}

/// The repo and base the project's work lands on: its own repo's.
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

/// The repo and base the repo's work lands on; `None` for an unknown repo or one with no remote.
pub fn scope_of_repo(db: &Connection, repo_id: &RepoId) -> rusqlite::Result<Option<WorkScope>> {
    Ok(
        crate::hub::repos::store::get(db, repo_id)?.and_then(|(_, repo)| {
            Some(WorkScope {
                repo_key: repo.repo_key?,
                base: repo.base?,
            })
        }),
    )
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

/// How far a watched base has been read: its newest commit seen, and when the watch started (nothing older is
/// reported).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Watch {
    pub last_sha: String,
    pub since_ms: i64,
}

pub fn watch(db: &Connection, scope: &WorkScope) -> rusqlite::Result<Option<Watch>> {
    db.prepare_cached(
        "SELECT last_sha, since_ms FROM landing_watch WHERE repo_key = ? AND base = ?",
    )?
    .query_row(params![scope.repo_key.as_str(), scope.base.as_str()], |r| {
        Ok(Watch {
            last_sha: r.get(0)?,
            since_ms: r.get(1)?,
        })
    })
    .optional()
}

/// Starts the watch at `last_sha`, or moves it there.
pub fn watch_at(
    db: &Connection,
    scope: &WorkScope,
    last_sha: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    db.prepare_cached(
        "INSERT INTO landing_watch (repo_key, base, last_sha, since_ms) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (repo_key, base) DO UPDATE SET last_sha = ?3",
    )?
    .execute(params![
        scope.repo_key.as_str(),
        scope.base.as_str(),
        last_sha,
        now_ms
    ])?;
    Ok(())
}

pub fn route_str(route: LandingRoute) -> &'static str {
    match route {
        LandingRoute::Train => "train",
        LandingRoute::PrOutside => "pr_outside",
        LandingRoute::DirectPush => "direct_push",
    }
}

/// Stores the landing with what a rebase keeps of its commit; false when the commit was already recorded on that base.
pub fn insert_landing(
    db: &Connection,
    landing: &Landing,
    rewrite_key: &str,
) -> rusqlite::Result<bool> {
    let at_ms = parse_ms(landing.at.as_str()).unwrap_or(0);
    let added = db
        .prepare_cached(
            "INSERT OR IGNORE INTO landings (repo_key, base, sha, at_ms, route, pr_number, rewrite_key, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )?
        .execute(params![
            landing.repo_key.as_str(),
            landing.base.as_str(),
            landing.sha.as_str(),
            at_ms,
            route_str(landing.route),
            landing.pr_number.map(|n| n.get()),
            rewrite_key,
            serde_json::to_string(landing).expect("a Landing encodes"),
        ])?;
    Ok(added == 1)
}

/// Whether a commit with this rewrite key, or from this PR, already landed on the scope's base.
pub fn rewrite_of(
    db: &Connection,
    scope: &WorkScope,
    rewrite_key: &str,
    pr_number: Option<i64>,
) -> rusqlite::Result<bool> {
    db.prepare_cached(
        "SELECT 1 FROM landings WHERE repo_key = ?1 AND base = ?2 AND (rewrite_key = ?3 OR pr_number = ?4) LIMIT 1",
    )?
    .query_row(
        params![scope.repo_key.as_str(), scope.base.as_str(), rewrite_key, pr_number],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
}

pub fn has_landing(db: &Connection, scope: &WorkScope, sha: &str) -> rusqlite::Result<bool> {
    db.prepare_cached("SELECT 1 FROM landings WHERE repo_key = ? AND base = ? AND sha = ?")?
        .query_row(
            params![scope.repo_key.as_str(), scope.base.as_str(), sha],
            |_| Ok(()),
        )
        .optional()
        .map(|found| found.is_some())
}

/// The scope's landings committed at or after `since_ms`, newest first; with `outside`, only those that didn't come
/// through the train.
pub fn landings_since(
    db: &Connection,
    scope: &WorkScope,
    since_ms: i64,
    limit: usize,
    outside: bool,
) -> rusqlite::Result<Vec<Landing>> {
    db.prepare_cached(
        "SELECT data FROM landings WHERE repo_key = ? AND base = ? AND at_ms >= ? AND (? = 0 OR route != 'train')
         ORDER BY at_ms DESC, rowid DESC LIMIT ?",
    )?
    .query_map(
        params![
            scope.repo_key.as_str(),
            scope.base.as_str(),
            since_ms,
            outside,
            limit as i64
        ],
        |r| decode(&r.get::<_, String>(0)?),
    )?
    .collect()
}

/// The newest write task of one of `projects` on `branch`, in any state.
pub fn task_on_branch(
    db: &Connection,
    projects: &[ProjectRef],
    branch: &str,
) -> rusqlite::Result<Option<Task>> {
    let mut stmt = db.prepare_cached(
        "SELECT data FROM tasks WHERE machine_id = ? AND project_id = ? AND json_extract(data, '$.kind') = 'write'
           AND json_extract(data, '$.branch') = ?
         ORDER BY n DESC LIMIT 1",
    )?;
    for project in projects {
        let task = stmt
            .query_row(
                params![
                    project.machine_id.as_str(),
                    project.project_id.as_str(),
                    branch
                ],
                |r| decode::<Task>(&r.get::<_, String>(0)?),
            )
            .optional()?;
        if task.is_some() {
            return Ok(task);
        }
    }
    Ok(None)
}

/// The bases the repo's projects land on, most recently bound first.
pub fn bases_of(db: &Connection, repo_key: &RepoKey) -> rusqlite::Result<Vec<String>> {
    db.prepare_cached(
        "SELECT base FROM work_projects WHERE repo_key = ? GROUP BY base ORDER BY max(updated_ms) DESC",
    )?
    .query_map([repo_key.as_str()], |r| r.get(0))?
    .collect()
}
