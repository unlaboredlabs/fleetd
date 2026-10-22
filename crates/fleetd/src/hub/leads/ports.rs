//! What this area calls in the executor, the write queue, the node link, the ledger and the requests, one method per
//! call.
//! `wiring::HubPorts` implements it over those areas; `Unwired` answers until `Ctx::set_ports` runs, so the area's
//! logic builds and tests without them.
use fleetd_contracts::effort::Effort;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::ledger::{Decision, HumanRequest, WorkstreamId};
use fleetd_contracts::mcp::{ErrorCode, ThreadLaunchInput};

use super::error::LeadError;
use super::hooks::BoxFuture;

/// `cmd_result` from the node, as finish-all's inventory reads it.
#[derive(Debug, Clone)]
pub struct CmdOutcome {
    /// None when the process did not exit on its own.
    pub exit_code: Option<i64>,
    pub output_tail: String,
}

pub trait LeadPorts: Send + Sync {
    /// `Executors.launch(machineId, input)`. Map `MachineNotConnected` with `LeadError::machine_offline`, anything
    /// else with `LeadError::failed`.
    fn launch(
        &self,
        machine_id: &MachineId,
        input: ThreadLaunchInput,
    ) -> BoxFuture<Result<ThreadId, LeadError>>;
    /// `WriteQueue.send(thread, message, clientRequestId)`: through the queue's offline writer, so a wake to an
    /// offline machine waits for it. `Ok(queued)`.
    fn send(
        &self,
        thread: ThreadRef,
        message: String,
        client_request_id: String,
    ) -> BoxFuture<Result<bool, LeadError>>;
    /// `Executors.configure(thread, model, effort)`: the thread's next turns run on them.
    fn configure(
        &self,
        thread: ThreadRef,
        model: String,
        effort: Effort,
    ) -> BoxFuture<Result<(), LeadError>>;
    /// `NodeCommands.run(machineId, {cwd, argv, timeoutSec})`; `Err` is the command error's message.
    fn run_command(
        &self,
        machine_id: &MachineId,
        cwd: String,
        argv: Vec<String>,
        timeout_sec: u32,
    ) -> BoxFuture<Result<CmdOutcome, String>>;

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
    /// `Decisions.get(decisionId)`.
    fn decision(&self, decision_id: &str) -> Result<Option<Decision>, LeadError>;
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
        _: ThreadLaunchInput,
    ) -> BoxFuture<Result<ThreadId, LeadError>> {
        Box::pin(async { Err(unwired("Launching a lead thread")) })
    }
    fn send(&self, _: ThreadRef, _: String, _: String) -> BoxFuture<Result<bool, LeadError>> {
        Box::pin(async { Err(unwired("Sending to a lead thread")) })
    }
    fn configure(&self, _: ThreadRef, _: String, _: Effort) -> BoxFuture<Result<(), LeadError>> {
        Box::pin(async { Err(unwired("Configuring a lead thread")) })
    }
    fn run_command(
        &self,
        _: &MachineId,
        _: String,
        _: Vec<String>,
        _: u32,
    ) -> BoxFuture<Result<CmdOutcome, String>> {
        Box::pin(async {
            Err("running commands on a node is not wired in this hub yet".to_string())
        })
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
    fn decision(&self, _: &str) -> Result<Option<Decision>, LeadError> {
        Ok(None)
    }
}
