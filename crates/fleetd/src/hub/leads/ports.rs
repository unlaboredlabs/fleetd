//! What this area calls in the executor, the write queue, the node link and the ledger, one method per call.
//! `wiring::HubPorts` implements it over those areas; `Unwired` answers until `Ctx::set_ports` runs, so the area's
//! logic builds and tests without them.
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::ledger::{Ask, AskId, Decision, DecisionKey, WorkstreamId};
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

/// The router's fallback ask: `kind: decide, class: product, proceededOnRec: false`, no project.
#[derive(Debug, Clone)]
pub struct RouteAsk {
    pub key: DecisionKey,
    pub text: String,
    pub options: Vec<String>,
    pub recommendation: String,
    pub blocks: String,
}

pub trait LeadPorts: Send + Sync {
    /// `Executors.launch(machineId, input)`. Map `MachineNotConnected` with `LeadError::machine_offline`, anything
    /// else with `LeadError::t3_error`.
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
    /// `NodeCommands.run(machineId, {cwd, argv, timeoutSec})`; `Err` is the command error's message.
    fn run_command(
        &self,
        machine_id: &MachineId,
        cwd: String,
        argv: Vec<String>,
        timeout_sec: u32,
    ) -> BoxFuture<Result<CmdOutcome, String>>;

    /// `Asks.list({state: "open", projectRef?, workstreamId?, limit})`.
    fn open_asks(
        &self,
        project_ref: Option<&ProjectRef>,
        workstream_id: Option<&WorkstreamId>,
        limit: usize,
    ) -> Result<Vec<Ask>, LeadError>;
    /// `Asks.get(askId)`.
    fn ask(&self, ask_id: &AskId) -> Result<Option<Ask>, LeadError>;
    /// `Asks.create({kind: "decide", key, class: "product", text, options, recommendation, blocks, proceededOnRec: false}, by)`.
    fn create_route_ask(&self, input: RouteAsk, by: &str) -> Result<AskId, LeadError>;
    /// `Asks.withdraw(askId, {reason})`, errors ignored by the caller.
    fn withdraw_ask(&self, ask_id: &AskId, reason: &str) -> Result<(), LeadError>;
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
        ErrorCode::T3Error,
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
    fn open_asks(
        &self,
        _: Option<&ProjectRef>,
        _: Option<&WorkstreamId>,
        _: usize,
    ) -> Result<Vec<Ask>, LeadError> {
        Ok(Vec::new())
    }
    fn ask(&self, _: &AskId) -> Result<Option<Ask>, LeadError> {
        Ok(None)
    }
    fn create_route_ask(&self, _: RouteAsk, _: &str) -> Result<AskId, LeadError> {
        Err(unwired("Filing an ask"))
    }
    fn withdraw_ask(&self, _: &AskId, _: &str) -> Result<(), LeadError> {
        Ok(())
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

/// One answered or withdrawn ask, as the ledger's AnswerSink delivers it (`wiring` converts `ledger::Answer`).
#[derive(Debug, Clone)]
pub struct Answer {
    /// The ask after the answer was applied.
    pub ask: Ask,
    pub withdrawn: bool,
    /// The answer value; None for a withdrawal.
    pub value: Option<String>,
    pub decision: Option<Decision>,
}

/// Answers whose lead wake waits for the hub to act on them first: an approve ask's "go" (the node runs the command)
/// and a checklist's "done" with a verify check (the check runs). Their outcome reaches the lead later.
pub fn followed_up(answer: &Answer) -> bool {
    use fleetd_contracts::ledger::AskKind;
    !answer.withdrawn
        && ((answer.ask.kind == AskKind::Approve && answer.value.as_deref() == Some("go"))
            || (answer.ask.kind == AskKind::Do
                && answer.ask.verify.is_some()
                && answer.value.as_deref() == Some("done")))
}
