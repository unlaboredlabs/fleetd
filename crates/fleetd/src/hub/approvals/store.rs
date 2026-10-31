//! The `requests` table: one row per secret or approval request (`Q<n>` is the row's `n`), the record behind the chat
//! item that shows it. Every write goes through [`Requests::update`], which keeps the kind rule.
use std::sync::Arc;

use fleetd_contracts::chat::ChatRequestId;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::{HumanRequest, RequestKind, RequestState};
use rusqlite::{OptionalExtension, params};

use crate::hub::ledger::project_key;
use crate::hub::store::{HubDb, StoreError};

/// What a new request holds; the store numbers it and opens it.
pub struct NewRequest {
    pub project_ref: ProjectRef,
    pub workstream_id: Option<fleetd_contracts::ledger::WorkstreamId>,
    pub kind: RequestKind,
    pub text: String,
    pub secret: Option<fleetd_contracts::ledger::SecretRequest>,
    pub gated: Option<fleetd_contracts::ledger::GatedRunSpec>,
    pub permission: Option<fleetd_contracts::ledger::ToolPermission>,
    pub preview_config: Option<fleetd_contracts::preview::PreviewConfigProposeCall>,
    pub purchase: Option<fleetd_contracts::purchase::Purchase>,
    pub at: Timestamp,
    pub at_ms: i64,
}

/// Why a write was refused.
#[derive(Debug, thiserror::Error)]
pub enum RequestStoreError {
    #[error("no request {0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    /// The request was no longer in the state the change expected: someone else changed it first.
    #[error("{id} is already {}", .now.as_str())]
    Moved { id: String, now: RequestState },
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[derive(Clone, Debug, Default)]
pub struct RequestFilter {
    pub project_ref: Option<ProjectRef>,
    pub states: Option<Vec<RequestState>>,
    pub kind: Option<RequestKind>,
    pub limit: i64,
}

pub struct Requests {
    db: Arc<HubDb>,
}

fn n_of(id: &str) -> Option<i64> {
    let digits = id.strip_prefix('Q')?;
    let n: i64 = digits.parse().ok()?;
    (n > 0 && !digits.starts_with('0')).then_some(n)
}

fn decode(data: &str) -> rusqlite::Result<HumanRequest> {
    serde_json::from_str(data).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

impl Requests {
    pub fn new(db: Arc<HubDb>) -> Arc<Self> {
        Arc::new(Requests { db })
    }

    pub fn create(&self, new: NewRequest) -> Result<HumanRequest, RequestStoreError> {
        let record = |n: i64| -> Result<HumanRequest, serde_json::Error> {
            serde_json::from_value(serde_json::json!({
                "requestId": format!("Q{n}"),
                "projectRef": new.project_ref,
                "workstreamId": new.workstream_id,
                "kind": new.kind,
                "text": new.text,
                "state": "open",
                "secret": new.secret,
                "gated": new.gated,
                "permission": new.permission,
                "previewConfig": new.preview_config,
                "purchase": new.purchase,
                "createdAt": new.at,
            }))
        };
        // Checked before a number is taken: an invalid request never leaves a row behind.
        record(1).map_err(|e| RequestStoreError::Invalid(e.to_string()))?;
        Ok(self.db.transaction(|c| {
            c.execute(
                "INSERT INTO requests (project_key, kind, state, created_ms, data) VALUES (?, ?, 'open', ?, '{}')",
                params![project_key(&new.project_ref), kind_text(new.kind), new.at_ms],
            )?;
            let n = c.last_insert_rowid();
            let request = record(n).expect("checked above");
            c.execute(
                "UPDATE requests SET data = ? WHERE n = ?",
                params![serde_json::to_string(&request).expect("a request serializes"), n],
            )?;
            Ok(request)
        })?)
    }

    pub fn get(&self, id: &str) -> Result<Option<HumanRequest>, StoreError> {
        let Some(n) = n_of(id) else {
            return Ok(None);
        };
        self.db.with(|c| {
            Ok(
                c.query_row("SELECT data FROM requests WHERE n = ?", [n], |r| {
                    decode(&r.get::<_, String>(0)?)
                })
                .optional()?,
            )
        })
    }

    /// Newest first.
    pub fn list(&self, filter: &RequestFilter) -> Result<Vec<HumanRequest>, StoreError> {
        let states = filter
            .states
            .as_ref()
            .map(|s| serde_json::to_string(&s.iter().map(|s| s.as_str()).collect::<Vec<_>>()))
            .transpose()?;
        let project = filter.project_ref.as_ref().map(project_key);
        let kind = filter.kind.map(kind_text);
        self.db.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT data FROM requests
                 WHERE (?1 IS NULL OR project_key = ?1)
                   AND (?2 IS NULL OR state IN (SELECT value FROM json_each(?2)))
                   AND (?3 IS NULL OR kind = ?3)
                 ORDER BY n DESC LIMIT ?4",
            )?;
            let rows = stmt
                .query_map(params![project, states, kind, filter.limit.max(1)], |r| {
                    decode(&r.get::<_, String>(0)?)
                })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Applies `change` to the stored request and saves it, if the result still holds the kind rule.
    pub fn update(
        &self,
        id: &ChatRequestId,
        change: impl FnOnce(&mut HumanRequest),
    ) -> Result<HumanRequest, RequestStoreError> {
        self.write(id, None, change)
    }

    /// As `update`, only while the request is still `from`: of two answers at once exactly one moves it, and the
    /// other gets `Moved`. Read and write share one immediate transaction, and the write is guarded by the state.
    pub fn update_from(
        &self,
        id: &ChatRequestId,
        from: RequestState,
        change: impl FnOnce(&mut HumanRequest),
    ) -> Result<HumanRequest, RequestStoreError> {
        self.write(id, Some(from), change)
    }

    fn write(
        &self,
        id: &ChatRequestId,
        from: Option<RequestState>,
        change: impl FnOnce(&mut HumanRequest),
    ) -> Result<HumanRequest, RequestStoreError> {
        let Some(n) = n_of(id.as_str()) else {
            return Err(RequestStoreError::NotFound(id.to_string()));
        };
        let mut failed: Option<RequestStoreError> = None;
        let written = self.db.transaction(|c| {
            let Some(data) = c
                .query_row("SELECT data FROM requests WHERE n = ?", [n], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
            else {
                failed = Some(RequestStoreError::NotFound(id.to_string()));
                return Ok(None);
            };
            let mut request: HumanRequest = serde_json::from_str(&data)?;
            if let Some(from) = from
                && request.state != from
            {
                failed = Some(RequestStoreError::Moved {
                    id: id.to_string(),
                    now: request.state,
                });
                return Ok(None);
            }
            let was = request.state;
            change(&mut request);
            // Round-trip through the checked decoder, so a write can never store a request no reader accepts.
            let text = serde_json::to_string(&request).expect("a request serializes");
            let request: HumanRequest = match serde_json::from_str(&text) {
                Ok(r) => r,
                Err(e) => {
                    failed = Some(RequestStoreError::Invalid(e.to_string()));
                    return Ok(None);
                }
            };
            let changed = c.execute(
                "UPDATE requests SET state = ?, data = ? WHERE n = ? AND state = ?",
                params![request.state.as_str(), text, n, was.as_str()],
            )?;
            Ok((changed == 1).then_some(request))
        })?;
        match (written, failed) {
            (Some(r), _) => Ok(r),
            (None, Some(e)) => Err(e),
            (None, None) => Err(RequestStoreError::Moved {
                id: id.to_string(),
                now: self
                    .get(id.as_str())?
                    .map_or(RequestState::Open, |r| r.state),
            }),
        }
    }
}

fn kind_text(kind: RequestKind) -> &'static str {
    match kind {
        RequestKind::Secret => "secret",
        RequestKind::Approval => "approval",
    }
}
