//! Decisions, asks, batches and the reply grammar.
//!
//! Three services over one set of tables, each an `Arc` field on `Hub`:
//! - [`Decisions`]: the keyed decision log, resolved workstream → project → global, with FTS5 search.
//! - [`Asks`]: the ask path (class filter, auto-resolve, dedupe, candidates), batches and their 30 s quiet window.
//! - [`Inbox`]: `inbox_reply`, the terse reply grammar applied in one transaction, then [`AnswerSink`] per project.
//!
//! Every write runs in one `BEGIN IMMEDIATE` transaction that a [`LedgerError`] rolls back; events are appended after
//! the commit.
mod asks;
mod decisions;
pub mod digest_text;
pub mod grammar;
mod inbox;
pub mod repo;
mod tools;

#[cfg(test)]
mod tests;

pub use asks::{AskInput, AskOutcome, Asks, DECIDE_YOURSELF, QUIET_WINDOW_MS, validate_ask};
pub use decisions::Decisions;
pub use inbox::{
    Answer, AnswerOutcome, AnswerSink, Inbox, MisfiledSink, ReplyInput, followed_up, pref_key,
};
pub use repo::{
    AskFilter, DecisionFilter, RecordInput, StoredBatch, ask_n, batch_n, decision_n, fts_query,
};
pub use tools::{WorkstreamLookup, lead_call, register};

use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::ledger::{DecisionSource, WorkstreamId};
use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::clock::Clock;
use crate::hub::store::{HubDb, StoreError};

/// Who is writing: filled by the hub from the caller (human device, agent key or lead-side call).
#[derive(Clone, Debug, PartialEq)]
pub struct Actor {
    pub source: DecisionSource,
    /// "human:<device>", the agent key name, or "lead:<machineId>/<projectId>".
    pub by: String,
}

/// Where a lookup starts: the workstream (when known), then its project, then global.
#[derive(Clone, Debug, PartialEq)]
pub struct Chain {
    pub project_ref: ProjectRef,
    pub workstream_id: Option<WorkstreamId>,
}

/// The ledger's refusal codes, mapping one to one onto the MCP error codes. `Internal` is a store failure, answered
/// with the hub's generic "failed to answer" error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerCode {
    NotFound,
    Invalid,
    Forbidden,
    Internal,
}

impl LedgerCode {
    pub fn as_str(self) -> &'static str {
        match self {
            LedgerCode::NotFound => "not_found",
            LedgerCode::Invalid => "invalid",
            LedgerCode::Forbidden => "forbidden",
            LedgerCode::Internal => "failed",
        }
    }
}

/// Refusals the ledger returns to its callers, in the wire's `{ code, message, fix }` shape.
#[derive(Clone, Debug, PartialEq)]
pub struct LedgerError {
    pub code: LedgerCode,
    pub message: String,
    pub fix: Option<String>,
}

impl LedgerError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: LedgerCode::Invalid,
            message: message.into(),
            fix: None,
        }
    }
    pub fn invalid_fix(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self {
            code: LedgerCode::Invalid,
            message: message.into(),
            fix: Some(fix.into()),
        }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            code: LedgerCode::NotFound,
            message: message.into(),
            fix: None,
        }
    }
    pub fn forbidden(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self {
            code: LedgerCode::Forbidden,
            message: message.into(),
            fix: Some(fix.into()),
        }
    }
    fn internal(detail: impl std::fmt::Display) -> Self {
        tracing::error!(%detail, "ledger store failure");
        Self {
            code: LedgerCode::Internal,
            message: "The hub failed to answer that request.".into(),
            fix: Some("Retry; if it keeps failing, check the hub log.".into()),
        }
    }
}

impl std::fmt::Display for LedgerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LedgerError {}

/// Inside a write: a refusal (rolls back, returned as is) or a store failure (rolls back, logged).
#[derive(Debug)]
pub enum Fail {
    Ledger(LedgerError),
    Internal(String),
}

impl From<LedgerError> for Fail {
    fn from(error: LedgerError) -> Self {
        Fail::Ledger(error)
    }
}

impl From<rusqlite::Error> for Fail {
    fn from(error: rusqlite::Error) -> Self {
        Fail::Internal(error.to_string())
    }
}

impl From<Fail> for LedgerError {
    fn from(fail: Fail) -> Self {
        match fail {
            Fail::Ledger(error) => error,
            Fail::Internal(detail) => LedgerError::internal(detail),
        }
    }
}

impl From<StoreError> for LedgerError {
    fn from(error: StoreError) -> Self {
        LedgerError::internal(error)
    }
}

/// What every ledger service holds.
#[derive(Clone)]
pub(crate) struct Ctx {
    pub db: Arc<HubDb>,
    pub events: Arc<crate::hub::store::EventLog>,
    pub clock: Arc<dyn Clock>,
}

impl Ctx {
    pub fn now_ms(&self) -> i64 {
        crate::hub::store::now_ms(self.clock.as_ref())
    }

    /// Runs `f` in one write transaction. A `Fail` rolls everything back and becomes the error.
    pub fn write<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, Fail>,
    ) -> Result<T, LedgerError> {
        let mut out: Option<Result<T, Fail>> = None;
        self.db.with(|conn| {
            let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            let result = f(&tx);
            if result.is_ok() {
                tx.commit()?;
            }
            // Dropping an uncommitted transaction rolls it back.
            out = Some(result);
            Ok(())
        })?;
        out.expect("ran").map_err(LedgerError::from)
    }

    /// Runs `f` on the connection for a read.
    pub fn read<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, Fail>,
    ) -> Result<T, LedgerError> {
        let mut out: Option<Result<T, Fail>> = None;
        self.db.with(|conn| {
            out = Some(f(conn));
            Ok(())
        })?;
        out.expect("ran").map_err(LedgerError::from)
    }

    /// Appends after a commit. A failed append is logged: the write it announces already happened.
    pub fn emit(&self, event: crate::hub::store::NewEvent) {
        if let Err(error) = self.events.append(event) {
            tracing::error!(%error, "ledger event append failed");
        }
    }
}

/// Stable text form of a project ref; machine ids cannot contain "/".
pub fn project_key(project_ref: &ProjectRef) -> String {
    format!("{}/{}", project_ref.machine_id, project_ref.project_id)
}

/// `new Date(ms).toISOString()`.
pub fn iso_at(ms: i64) -> String {
    crate::hub::store::iso_ms(ms)
}

pub fn source_text(source: &DecisionSource) -> &'static str {
    match source {
        DecisionSource::Human => "human",
        DecisionSource::Lead => "lead",
        DecisionSource::Agent => "agent",
    }
}

/// A hub-built text value for a bounded contract string; the bound was checked where the text came in.
pub(crate) fn text<T: for<'a> TryFrom<&'a str, Error = String>>(value: &str) -> T {
    T::try_from(value)
        .unwrap_or_else(|error| panic!("ledger text out of bounds ({error}): {value:?}"))
}

/// `projectFields`: an event's machine and project, for asks and decisions that have one.
pub(crate) fn project_fields(
    project_ref: Option<&ProjectRef>,
) -> (Option<MachineId>, Option<ProjectId>) {
    match project_ref {
        Some(r) => (Some(r.machine_id.clone()), Some(r.project_id.clone())),
        None => (None, None),
    }
}

/// JavaScript's `text.slice(0, units)`, without splitting a surrogate pair.
pub(crate) fn js_prefix(text: &str, units: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= units
        })
        .collect()
}
