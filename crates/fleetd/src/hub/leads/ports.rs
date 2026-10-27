//! What this area calls in the executor, the write queue, the node link, the ledger and the requests, one method per
//! call.
//! `wiring::HubPorts` implements it over those areas; `Unwired` answers until `Ctx::set_ports` runs, so the area's
//! logic builds and tests without them.
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::ledger::{Decision, HumanRequest, WorkstreamId};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::sessions::SessionRole;

use super::error::LeadError;
use super::hooks::BoxFuture;
use crate::hub::executor::LaunchInput;

pub trait LeadPorts: Send + Sync {
    /// `Executors.launch(machineId, input)` as a session of `role` (a lead, or a Navi's assistant). Map
    /// `MachineNotConnected` with `LeadError::machine_offline`, anything else with `LeadError::failed`.
    fn launch(
        &self,
        machine_id: &MachineId,
        input: LaunchInput,
        role: SessionRole,
    ) -> BoxFuture<Result<ThreadId, LeadError>>;
    /// `WriteQueue.send(thread, message, clientRequestId)`: through the queue's offline writer, so a wake to an
    /// offline machine waits for it. `Ok(queued)`.
    fn send(
        &self,
        thread: ThreadRef,
        message: String,
        client_request_id: String,
    ) -> BoxFuture<Result<bool, LeadError>>;
    /// Open secret and approval requests, in one project or all, newest first.
    fn open_requests(
        &self,
        project_ref: Option<&ProjectRef>,
        limit: usize,
    ) -> Result<Vec<HumanRequest>, LeadError>;
    /// `Decisions.list({chain: {projectRef}, limit})`: global, project and every workstream-scoped decision in it.
    fn decisions_in_project(
        &self,
        project_ref: &ProjectRef,
        limit: usize,
    ) -> Result<Vec<Decision>, LeadError>;
    /// `Decisions.list({scope: {kind: "workstream", workstreamId}, limit})`.
    fn decisions_of_workstream(
        &self,
        workstream_id: &WorkstreamId,
        limit: usize,
    ) -> Result<Vec<Decision>, LeadError>;
}

/// The stand-in until the integration slice wires the real areas.
pub struct Unwired;

fn unwired(what: &str) -> LeadError {
    LeadError::bare(
        ErrorCode::Failed,
        format!("{what} is not wired in this hub yet."),
    )
}

impl LeadPorts for Unwired {
    fn launch(
        &self,
        _: &MachineId,
        _: LaunchInput,
        _: SessionRole,
    ) -> BoxFuture<Result<ThreadId, LeadError>> {
        Box::pin(async { Err(unwired("Launching a lead thread")) })
    }
    fn send(&self, _: ThreadRef, _: String, _: String) -> BoxFuture<Result<bool, LeadError>> {
        Box::pin(async { Err(unwired("Sending to a lead thread")) })
    }
    fn open_requests(
        &self,
        _: Option<&ProjectRef>,
        _: usize,
    ) -> Result<Vec<HumanRequest>, LeadError> {
        Ok(Vec::new())
    }
    fn decisions_in_project(&self, _: &ProjectRef, _: usize) -> Result<Vec<Decision>, LeadError> {
        Ok(Vec::new())
    }
    fn decisions_of_workstream(
        &self,
        _: &WorkstreamId,
        _: usize,
    ) -> Result<Vec<Decision>, LeadError> {
        Ok(Vec::new())
    }
}
