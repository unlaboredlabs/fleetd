//! What the review verdicts area needs from other hub areas, as one trait. The hub's implementation (`HubPorts`)
//! forwards to their services; tests use fakes.
use fleetd_contracts::ledger::{MetricValues, Workstream, WorkstreamId};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::tasks::{Task, TaskId};
use fleetd_contracts::verification::CommitSha;
use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A refusal at the wire: `{code, message, fix?}`, with the texts older hubs sent.
pub type Refusal = McpToolError;

pub fn invalid(message: impl Into<String>, fix: Option<&str>) -> Refusal {
    with_fix(McpToolError::new(ErrorCode::Invalid, message), fix)
}

pub fn not_found(message: impl Into<String>, fix: Option<&str>) -> Refusal {
    with_fix(McpToolError::new(ErrorCode::NotFound, message), fix)
}

fn with_fix(error: Refusal, fix: Option<&str>) -> Refusal {
    match fix {
        Some(fix) => error.with_fix(fix),
        None => error,
    }
}

/// A store failure: logged, answered with the generic "The hub failed to answer that request."
pub fn internal(error: crate::hub::store::StoreError) -> Refusal {
    error.into()
}

pub trait Ports: Send + Sync + 'static {
    // leads: LeadRecords.workstreams
    fn workstream(&self, id: &WorkstreamId) -> Option<Workstream>;
    /// Research.recordVerdict: stores the computed research verdict and returns its text.
    fn research_verdict<'a>(
        &'a self,
        workstream: &'a WorkstreamId,
        values: MetricValues,
    ) -> BoxFuture<'a, Result<String, Refusal>>;
    // tasks
    fn task(&self, id: &TaskId) -> Option<Task>;
    /// The head a review task reviewed when it didn't say: its train round's head, else its PR's head now. None for a
    /// task with no PR or a head the hub can't read.
    fn reviewed_head<'a>(&'a self, _task: &'a Task) -> BoxFuture<'a, Option<CommitSha>> {
        Box::pin(async { None })
    }
}
