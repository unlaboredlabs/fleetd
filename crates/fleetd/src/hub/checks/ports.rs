//! What the receipts and review verdicts areas need from other hub areas, as one trait. The hub's implementation
//! (`HubPorts`) forwards to their services; tests use fakes.
use fleetd_contracts::ids::ThreadRef;
use fleetd_contracts::ledger::{MetricValues, Workstream, WorkstreamId};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::model::ActionItem;
use fleetd_contracts::tasks::{Task, TaskId};
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
    // executor
    fn thread_actions<'a>(
        &'a self,
        thread: &'a ThreadRef,
        max: usize,
    ) -> BoxFuture<'a, Result<Vec<ActionItem>, String>>;
}
