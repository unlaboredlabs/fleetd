//! Leads, lead settings and workstreams as stored (tables `leads`, `lead_settings`, `workstreams`).
use std::sync::Arc;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::{
    IntakeChannel, PlaybookRef, Workstream, WorkstreamId, WorkstreamParent,
    WorkstreamSource, WorkstreamState,
};
use rusqlite::{OptionalExtension, named_params, params};
use serde::{Deserialize, Serialize};

use crate::hub::store::{HubDb, StoreError};

/// A lead as stored; its `state` (and M4 `parked`) is derived from the lead thread when read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredLead {
    pub project_ref: ProjectRef,
    pub thread_id: fleetd_contracts::ids::ThreadId,
    pub started_at: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_wake_at: Option<Timestamp>,
    pub session_generation: i64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LeadSettings {
    pub model: Option<String>,
    pub effort: Option<Effort>,
}

#[derive(Debug, Clone)]
pub struct StoredWorkstream {
    pub workstream: Workstream,
    /// The decisions already used to amend its brief (decision ids; ask ids on rows from before the questions tool
    /// went); each authorizes one change.
    pub amends: Vec<String>,
}

pub const CLOSED_STATES: [WorkstreamState; 3] = [
    WorkstreamState::Done,
    WorkstreamState::Stopped,
    WorkstreamState::Failed,
];

pub fn is_closed(state: WorkstreamState) -> bool {
    CLOSED_STATES.contains(&state)
}

pub struct NewWorkstream {
    pub project_ref: ProjectRef,
    pub title: String,
    pub text: String,
    pub channel: IntakeChannel,
    pub by: String,
    pub at: Timestamp,
    pub client_request_id: Option<String>,
    pub playbook: Option<PlaybookRef>,
    pub parent: Option<WorkstreamParent>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkstreamFilter {
    pub project_ref: Option<ProjectRef>,
    pub state: Option<WorkstreamState>,
    /// Keeps states other than done, stopped and failed.
    pub open: bool,
    pub limit: usize,
}

pub struct LeadRecords {
    db: Arc<HubDb>,
}

fn state_str(state: WorkstreamState) -> String {
    crate::hub::leads::digest::state_text(state).to_string()
}

fn lead_of(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(String, String, String, String, Option<String>, i64)> {
    Ok((
        row.get("machine_id")?,
        row.get("project_id")?,
        row.get("thread_id")?,
        row.get("started_at")?,
        row.get("last_wake_at")?,
        row.get("session_generation")?,
    ))
}

fn decode_lead(
    cols: (String, String, String, String, Option<String>, i64),
) -> Result<StoredLead, StoreError> {
    let (machine_id, project_id, thread_id, started_at, last_wake_at, session_generation) = cols;
    Ok(serde_json::from_value(serde_json::json!({
        "projectRef": { "machineId": machine_id, "projectId": project_id },
        "threadId": thread_id,
        "startedAt": started_at,
        "lastWakeAt": last_wake_at,
        "sessionGeneration": session_generation,
    }))?)
}

fn workstream_number(id: &WorkstreamId) -> i64 {
    id.as_str()[1..].parse().unwrap_or(0)
}

impl LeadRecords {
    pub fn new(db: Arc<HubDb>) -> Arc<Self> {
        Arc::new(Self { db })
    }

    pub fn lead_get(&self, r: &ProjectRef) -> Result<Option<StoredLead>, StoreError> {
        let cols = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT * FROM leads WHERE machine_id = ? AND project_id = ?",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                lead_of,
            )
            .optional()?)
        })?;
        cols.map(decode_lead).transpose()
    }

    pub fn lead_put(&self, lead: &StoredLead) -> Result<(), StoreError> {
        self.db.with(|c| {
            c.execute(
                "INSERT INTO leads (machine_id, project_id, thread_id, started_at, last_wake_at, session_generation)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (machine_id, project_id) DO UPDATE SET thread_id = excluded.thread_id, started_at = excluded.started_at,
                   last_wake_at = excluded.last_wake_at, session_generation = excluded.session_generation",
                params![
                    lead.project_ref.machine_id.as_str(),
                    lead.project_ref.project_id.as_str(),
                    lead.thread_id.as_str(),
                    lead.started_at.as_str(),
                    lead.last_wake_at.as_ref().map(|t| t.as_str()),
                    lead.session_generation
                ],
            )?;
            Ok(())
        })
    }

    pub fn leads_list(&self) -> Result<Vec<StoredLead>, StoreError> {
        let rows = self.db.with(|c| {
            let mut stmt = c.prepare("SELECT * FROM leads ORDER BY machine_id, project_id")?;
            let rows = stmt
                .query_map([], lead_of)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        rows.into_iter().map(decode_lead).collect()
    }

    pub fn settings_get(&self, r: &ProjectRef) -> Result<LeadSettings, StoreError> {
        let row: Option<(Option<String>, Option<String>)> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT model, effort FROM lead_settings WHERE machine_id = ? AND project_id = ?",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
        })?;
        let Some((model, effort)) = row else {
            return Ok(LeadSettings::default());
        };
        let effort = effort
            .map(|e| serde_json::from_value(serde_json::Value::String(e)))
            .transpose()?;
        Ok(LeadSettings { model, effort })
    }

    /// Absent fields fall back to the hub default.
    pub fn settings_set(&self, r: &ProjectRef, settings: &LeadSettings) -> Result<(), StoreError> {
        let effort = settings
            .effort
            .as_ref()
            .map(crate::hub::leads::digest::serde_plain);
        self.db.with(|c| {
            c.execute(
                "INSERT INTO lead_settings (machine_id, project_id, model, effort) VALUES (?, ?, ?, ?)
                 ON CONFLICT (machine_id, project_id) DO UPDATE SET model = excluded.model, effort = excluded.effort",
                params![r.machine_id.as_str(), r.project_id.as_str(), settings.model, effort],
            )?;
            Ok(())
        })
    }

    /// Creates a draft. A repeated `client_request_id` in the same project returns the first one with `created: false`.
    pub fn workstream_create(
        &self,
        input: NewWorkstream,
    ) -> Result<(Workstream, bool), StoreError> {
        self.db.transaction(|c| {
            let r = &input.project_ref;
            if let Some(id) = &input.client_request_id {
                let existing: Option<String> = c
                    .query_row(
                        "SELECT data FROM workstreams WHERE machine_id = ? AND project_id = ? AND client_request_id = ?",
                        params![r.machine_id.as_str(), r.project_id.as_str(), id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(data) = existing {
                    return Ok((serde_json::from_str(&data)?, false));
                }
            }
            let n: i64 = c.query_row(
                "INSERT INTO workstreams (machine_id, project_id, client_request_id, state, data) VALUES (?, ?, ?, 'draft', '') RETURNING n",
                params![r.machine_id.as_str(), r.project_id.as_str(), input.client_request_id],
                |row| row.get(0),
            )?;
            let workstream: Workstream = serde_json::from_value(serde_json::json!({
                "workstreamId": format!("W{n}"),
                "projectRef": r,
                "title": input.title,
                "source": WorkstreamSource {
                    text: serde_json::from_value(serde_json::Value::String(input.text.clone()))?,
                    channel: input.channel,
                    by: input.by.clone(),
                    at: input.at.clone(),
                },
                "state": "draft",
                "playbook": input.playbook,
                "parent": input.parent,
                "createdAt": input.at,
                "updatedAt": input.at,
            }))?;
            c.execute(
                "UPDATE workstreams SET state = ?, amends = ?, data = ? WHERE n = ?",
                params![state_str(workstream.state), "[]", serde_json::to_string(&workstream)?, n],
            )?;
            Ok((workstream, true))
        })
    }

    pub fn workstream_get(
        &self,
        id: &WorkstreamId,
    ) -> Result<Option<StoredWorkstream>, StoreError> {
        let row: Option<(String, String)> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT data, amends FROM workstreams WHERE n = ?",
                params![workstream_number(id)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
        })?;
        row.map(|(data, amends)| {
            Ok(StoredWorkstream {
                workstream: serde_json::from_str(&data)?,
                amends: serde_json::from_str(&amends)?,
            })
        })
        .transpose()
    }

    pub fn workstream_put(&self, stored: &StoredWorkstream) -> Result<(), StoreError> {
        let w = &stored.workstream;
        let data = serde_json::to_string(w)?;
        let amends = serde_json::to_string(&stored.amends)?;
        self.db.with(|c| {
            c.execute(
                "UPDATE workstreams SET state = ?, amends = ?, data = ? WHERE n = ?",
                params![
                    state_str(w.state),
                    amends,
                    data,
                    workstream_number(&w.workstream_id)
                ],
            )?;
            Ok(())
        })
    }

    /// Like `workstream_put`, but only while the stored workstream still has `expect`'s state and brief hash: a claim
    /// concluding and a brief being amended can't overwrite each other. False when it changed meanwhile.
    pub fn workstream_put_if(
        &self,
        stored: &StoredWorkstream,
        expect: &Workstream,
    ) -> Result<bool, StoreError> {
        let w = &stored.workstream;
        let data = serde_json::to_string(w)?;
        let amends = serde_json::to_string(&stored.amends)?;
        self.db.with(|c| {
            let changed = c.execute(
                "UPDATE workstreams SET state = ?, amends = ?, data = ?
                 WHERE n = ? AND state = ? AND json_extract(data, '$.briefHash') IS ?",
                params![
                    state_str(w.state),
                    amends,
                    data,
                    workstream_number(&w.workstream_id),
                    state_str(expect.state),
                    expect.brief_hash.as_ref().map(|h| h.as_str()),
                ],
            )?;
            Ok(changed == 1)
        })
    }

    /// Newest first.
    pub fn workstreams_list(
        &self,
        filter: &WorkstreamFilter,
    ) -> Result<Vec<Workstream>, StoreError> {
        let closed = serde_json::to_string(&CLOSED_STATES.map(state_str))?;
        let rows: Vec<String> = self.db.with(|c| {
            let mut stmt = c.prepare(
                "SELECT data FROM workstreams
                 WHERE ($machine IS NULL OR machine_id = $machine) AND ($project IS NULL OR project_id = $project)
                   AND ($state IS NULL OR state = $state)
                   AND ($open = 0 OR state NOT IN (SELECT value FROM json_each($closed)))
                 ORDER BY n DESC LIMIT $limit",
            )?;
            let rows = stmt
                .query_map(
                    named_params! {
                        "$machine": filter.project_ref.as_ref().map(|r| r.machine_id.as_str()),
                        "$project": filter.project_ref.as_ref().map(|r| r.project_id.as_str()),
                        "$state": filter.state.map(state_str),
                        "$open": i64::from(filter.open),
                        "$closed": closed,
                        "$limit": filter.limit as i64,
                    },
                    |row| row.get(0),
                )?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(rows)
        })?;
        rows.iter()
            .map(|data| Ok(serde_json::from_str(data)?))
            .collect()
    }
}

/// The ledger's `WorkstreamLookup` (which project a workstream belongs to, a project's open ones), used by `wiring`.
impl LeadRecords {
    pub fn project_of(&self, workstream_id: &WorkstreamId) -> Option<ProjectRef> {
        self.workstream_get(workstream_id)
            .ok()
            .flatten()
            .map(|s| s.workstream.project_ref)
    }

    pub fn open_in(&self, project_ref: &ProjectRef, limit: usize) -> Vec<WorkstreamId> {
        self.workstreams_list(&WorkstreamFilter {
            project_ref: Some(project_ref.clone()),
            open: true,
            limit,
            ..Default::default()
        })
        .map(|ws| ws.into_iter().map(|w| w.workstream_id).collect())
        .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::ledger::BriefHash;

    /// A concluding claim and an amend each write only over the workstream they read: the second writer loses.
    #[test]
    fn a_conditional_put_loses_once_the_state_or_brief_changed() {
        let records = LeadRecords::new(HubDb::open_memory().unwrap());
        let (w, _) = records
            .workstream_create(NewWorkstream {
                project_ref: serde_json::from_value(
                    serde_json::json!({ "machineId": "lab-a", "projectId": "p1" }),
                )
                .unwrap(),
                title: "schedules".into(),
                text: "should we build schedules?".into(),
                channel: IntakeChannel::Mcp,
                by: "human".into(),
                at: Timestamp::from("2026-10-19T19:01:42.801Z".to_owned()),
                client_request_id: None,
                playbook: None,
                parent: None,
            })
            .unwrap();
        let put = |next: &Workstream, expect: &Workstream| {
            records
                .workstream_put_if(
                    &StoredWorkstream {
                        workstream: next.clone(),
                        amends: vec![],
                    },
                    expect,
                )
                .unwrap()
        };
        let research = Workstream {
            state: WorkstreamState::Verifying,
            brief_hash: Some(BriefHash::unchecked("a".repeat(64))),
            ..w.clone()
        };
        assert!(put(&research, &w));
        let build = Workstream {
            state: WorkstreamState::Running,
            brief_hash: Some(BriefHash::unchecked("b".repeat(64))),
            ..research.clone()
        };
        assert!(put(&build, &research));
        let done = Workstream {
            state: WorkstreamState::Done,
            ..research.clone()
        };
        assert!(!put(&done, &research), "the stale claim's write loses");
        let stored = records.workstream_get(&w.workstream_id).unwrap().unwrap();
        assert_eq!(stored.workstream, build);
    }
}
