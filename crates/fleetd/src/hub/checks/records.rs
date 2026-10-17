//! The `claims` table. A row is numbered when the claim starts; `outcome` and `data` (the Claim) are set when its checks
//! end, so a claim superseded or cut off by a restart stays NULL and is never listed.
//! TS spec: apps/hub/src/checks/ClaimRecords.ts.
use crate::hub::store::{HubDb, StoreError};
use fleetd_contracts::{Claim, ClaimId, ClaimOutcome, ProjectRef, WorkstreamId};
use rusqlite::{OptionalExtension, named_params};
use std::sync::Arc;

#[derive(Debug, Clone, Default)]
pub struct ClaimFilter {
    pub workstream_id: Option<WorkstreamId>,
    pub project_ref: Option<ProjectRef>,
    pub outcome: Option<ClaimOutcome>,
    pub limit: usize,
}

fn outcome_name(o: ClaimOutcome) -> &'static str {
    match o {
        ClaimOutcome::Pass => "pass",
        ClaimOutcome::Fail => "fail",
    }
}

fn number_of(claim_id: &ClaimId) -> i64 {
    claim_id.as_str().get(1..).and_then(|n| n.parse().ok()).unwrap_or(0)
}

pub struct ClaimRecords {
    db: Arc<HubDb>,
}

impl ClaimRecords {
    pub fn new(db: Arc<HubDb>) -> Self {
        Self { db }
    }

    /// Numbers a claim (`C<n>`) as it starts.
    pub fn start(&self, workstream_id: &WorkstreamId, project: &ProjectRef) -> Result<ClaimId, StoreError> {
        self.db.with(|conn| {
            let n: i64 = conn
                .prepare_cached("INSERT INTO claims (workstream_id, machine_id, project_id) VALUES (?, ?, ?) RETURNING n")?
                .query_row([workstream_id.as_str(), project.machine_id.as_str(), project.project_id.as_str()], |r| r.get(0))?;
            Ok(ClaimId(format!("C{n}")))
        })
    }

    /// Stores the finished claim under the id `start` gave it.
    pub fn finish(&self, claim: &Claim) -> Result<(), StoreError> {
        let data = serde_json::to_string(claim)?;
        self.db.with(|conn| {
            conn.prepare_cached("UPDATE claims SET outcome = ?, data = ? WHERE n = ?")?
                .execute(rusqlite::params![outcome_name(claim.outcome), data, number_of(&claim.claim_id)])?;
            Ok(())
        })
    }

    pub fn get(&self, claim_id: &ClaimId) -> Result<Option<Claim>, StoreError> {
        self.db.with(|conn| {
            let data: Option<String> = conn
                .prepare_cached("SELECT data FROM claims WHERE n = ? AND data IS NOT NULL")?
                .query_row([number_of(claim_id)], |r| r.get(0))
                .optional()?;
            Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
        })
    }

    /// Finished claims, newest first.
    pub fn list(&self, filter: &ClaimFilter) -> Result<Vec<Claim>, StoreError> {
        self.db.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT data FROM claims
                 WHERE data IS NOT NULL AND ($workstream IS NULL OR workstream_id = $workstream)
                   AND ($machine IS NULL OR machine_id = $machine) AND ($project IS NULL OR project_id = $project)
                   AND ($outcome IS NULL OR outcome = $outcome)
                 ORDER BY n DESC LIMIT $limit",
            )?;
            let rows = stmt.query_map(
                named_params! {
                    "$workstream": filter.workstream_id.as_ref().map(|w| w.as_str()),
                    "$machine": filter.project_ref.as_ref().map(|r| r.machine_id.as_str()),
                    "$project": filter.project_ref.as_ref().map(|r| r.project_id.as_str()),
                    "$outcome": filter.outcome.map(outcome_name),
                    "$limit": filter.limit as i64,
                },
                |r| r.get::<_, String>(0),
            )?;
            let mut out = Vec::new();
            for data in rows {
                out.push(serde_json::from_str(&data?)?);
            }
            Ok(out)
        })
    }
}
