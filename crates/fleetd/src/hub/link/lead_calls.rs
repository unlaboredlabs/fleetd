//! Lead-side calls (node `lead_call` frames): which project a call comes from, decided from the node's machine and the
//! caller's cwd, and the registry areas register their handlers into, keyed by the call's `op`.
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock, RwLock};

use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::model::ProjectSummary;

use super::cwd;
pub use crate::hub::tasks::policy::CallerAgent;

/// Who a lead-side call came from, as decided by the hub from the node link, the caller's cwd and the session it names.
#[derive(Debug, Clone)]
pub struct LeadCaller {
    pub project_ref: ProjectRef,
    /// `lead:<machineId>/<projectId>`, recorded as `by` on whatever the call writes.
    pub by: String,
    pub cwd: String,
    /// The session the call names (`FLEETD_THREAD_ID`), on the calling machine.
    pub thread: Option<ThreadRef>,
    pub agent: CallerAgent,
}

/// Tells which of fleetd's agents a session is; the tasks area provides it.
pub trait AgentDirectory: Send + Sync + 'static {
    fn agent_of(&self, thread: &ThreadRef) -> CallerAgent;
}

/// The hub said no; `fix` tells the lead what to do instead. Sent to the CLI as the result frame's error.
pub type LeadCallRefused = McpToolError;

pub type LeadCallFuture =
    Pin<Box<dyn Future<Output = Result<LeadCallResult, LeadCallRefused>> + Send>>;

/// One area's handler for the lead calls it registered.
pub trait LeadCallHandler: Send + Sync + 'static {
    fn handle(&self, caller: LeadCaller, call: LeadCall) -> LeadCallFuture;
}

impl<F> LeadCallHandler for F
where
    F: Fn(LeadCaller, LeadCall) -> LeadCallFuture + Send + Sync + 'static,
{
    fn handle(&self, caller: LeadCaller, call: LeadCall) -> LeadCallFuture {
        self(caller, call)
    }
}

/// Handlers by the call's `op` (`ask`, `decide`, `task_spawn`, ...). An op nobody registered is refused.
#[derive(Default)]
pub struct LeadCalls {
    handlers: RwLock<HashMap<String, Arc<dyn LeadCallHandler>>>,
    directory: OnceLock<Arc<dyn AgentDirectory>>,
}

impl LeadCalls {
    pub fn set_directory(&self, directory: Arc<dyn AgentDirectory>) {
        let _ = self.directory.set(directory);
    }

    /// The agent behind `thread`; without a thread, a person.
    pub fn agent_of(&self, thread: Option<&ThreadRef>) -> CallerAgent {
        match (thread, self.directory.get()) {
            (None, _) => CallerAgent::Person,
            (Some(thread), Some(directory)) => directory.agent_of(thread),
            (Some(_), None) => CallerAgent::Lead,
        }
    }

    pub fn register(&self, op: &str, handler: Arc<dyn LeadCallHandler>) {
        self.handlers
            .write()
            .unwrap()
            .insert(op.to_owned(), handler);
    }

    pub fn handler(&self, op: &str) -> Option<Arc<dyn LeadCallHandler>> {
        self.handlers.read().unwrap().get(op).cloned()
    }
}

/// The call's `op` tag, as on the wire.
pub fn op_of(call: &LeadCall) -> String {
    serde_json::to_value(call)
        .ok()
        .and_then(|v| v.get("op")?.as_str().map(str::to_owned))
        .unwrap_or_default()
}

pub fn lead_by(r: &ProjectRef) -> String {
    format!("lead:{}/{}", r.machine_id, r.project_id)
}

/// The project whose workspace root is `cwd` or one of its ancestors, so worktrees under the root count. With nested
/// roots the deepest wins; with equal roots, the first in `projects` (newest activity first from the store).
pub fn project_for_cwd<'a>(
    projects: &'a [ProjectSummary],
    cwd: &str,
) -> Option<&'a ProjectSummary> {
    cwd::project_index_for_cwd(projects.iter().map(|p| p.workspace_root.as_str()), cwd)
        .map(|i| &projects[i])
}

/// Refusal for a cwd outside every project on the machine.
pub fn outside_every_project(
    machine_id: &MachineId,
    cwd: &str,
    projects: &[ProjectSummary],
) -> LeadCallRefused {
    let roots: Vec<&str> = projects.iter().map(|p| p.workspace_root.as_str()).collect();
    let (message, fix) = cwd::outside_every_project(machine_id.as_str(), cwd, &roots);
    McpToolError::new(ErrorCode::Forbidden, message).with_fix(fix)
}
