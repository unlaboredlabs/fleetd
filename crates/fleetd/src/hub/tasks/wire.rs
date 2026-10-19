//! Tasks, slots and leases over the rest of the hub: the executor and node commands (built before tasks) and leads
//! (built after, so reached through the `Hub` once it exists). Also the hooks other areas fill in on tasks, and the
//! hooks tasks fill in on leads.
use std::sync::{Arc, OnceLock, Weak};

use fleetd_contracts::events::HubEvent;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadId, ThreadRef, Timestamp};
use fleetd_contracts::lead_calls::{AskLeadResult, LeadCall, LeadCallResult};
use fleetd_contracts::ledger::{Brief, Workstream, WorkstreamId};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::sessions::SessionWorkspace;
use fleetd_contracts::tasks::{TaskId, TaskResult};
use fleetd_contracts::usage::UsageParked;

use super::hooks::{ResultReceipts, SpawnCheck, UsageGate};
use super::ports::{
    BoxFut, CmdOutput, LaunchRequest, PortError, TaskError, TaskPorts, ThreadChanges, WakeKind,
};
use super::resolve::ModelEffort;
use super::{SpawnInput, TaskCaller, Tasks};
use crate::hub::api::Hub;
use crate::hub::executor::{ExecutorError, Executors, LaunchInput, LaunchOptions};
use crate::hub::leads::hooks::{BoxFuture, PolicyHook, TasksHook};
use crate::hub::leads::wakes::{LineKind, Trigger};
use crate::hub::link::commands::CommandInput;
use crate::hub::link::lead_calls::{AgentDirectory, CallerAgent, LeadCallFuture};
use crate::hub::link::{LeadCallHandler, LeadCaller, NodeCommands};

fn port_error(error: ExecutorError) -> PortError {
    match error {
        ExecutorError::MachineNotConnected { .. } => PortError::Offline,
        other => PortError::Failed(other.to_string()),
    }
}

/// The real `TaskPorts`. The leads half answers "nothing" until `bind` runs in `hub/serve`.
pub struct HubTaskPorts {
    executors: Arc<Executors>,
    commands: Arc<NodeCommands>,
    hub: OnceLock<Weak<Hub>>,
}

impl HubTaskPorts {
    pub fn new(executors: Arc<Executors>, commands: Arc<NodeCommands>) -> Arc<Self> {
        Arc::new(Self {
            executors,
            commands,
            hub: OnceLock::new(),
        })
    }

    /// Called once by `hub::serve::build_on`, after the `Hub` is built.
    pub fn bind(&self, hub: &Arc<Hub>) {
        let _ = self.hub.set(Arc::downgrade(hub));
    }

    fn hub(&self) -> Option<Arc<Hub>> {
        self.hub.get()?.upgrade()
    }
}

impl TaskPorts for HubTaskPorts {
    fn is_connected(&self, machine_id: &MachineId) -> bool {
        self.executors.is_connected(machine_id)
    }

    fn await_live<'a>(&'a self, machine_id: &'a MachineId) -> BoxFut<'a, ()> {
        Box::pin(self.executors.await_live(machine_id))
    }

    fn launch<'a>(
        &'a self,
        machine_id: &'a MachineId,
        request: LaunchRequest,
    ) -> BoxFut<'a, Result<ThreadId, PortError>> {
        Box::pin(async move {
            let input = LaunchInput {
                project_id: request.project_id,
                prompt: request.prompt,
                model: request.model,
                effort: request.effort,
                runtime_mode: RuntimeMode::FullAccess,
                title: Some(request.title),
                client_request_id: request.client_request_id,
            };
            let workspace = match request.worktree {
                None => None,
                Some(w) => Some(SessionWorkspace::Worktree {
                    base_ref: NonEmpty::new(w.base_ref)
                        .map_err(|_| PortError::Failed("a worktree needs a base ref".into()))?,
                    branch: NonEmpty::new(w.branch)
                        .map_err(|_| PortError::Failed("a worktree needs a branch".into()))?,
                }),
            };
            let options = LaunchOptions {
                workspace,
                role: fleetd_contracts::sessions::SessionRole::Worker,
            };
            self.executors
                .launch(machine_id, &input, options)
                .await
                .map_err(port_error)
        })
    }

    fn send<'a>(
        &'a self,
        thread: &'a ThreadRef,
        message: &'a str,
        client_request_id: &'a str,
    ) -> BoxFut<'a, Result<(), PortError>> {
        Box::pin(async move {
            self.executors
                .send(thread, message, client_request_id)
                .await
                .map(|_| ())
                .map_err(port_error)
        })
    }

    fn send_steer<'a>(
        &'a self,
        thread: &'a ThreadRef,
        message: &'a str,
        client_request_id: &'a str,
        steer: fleetd_contracts::steer::SteerTag,
    ) -> BoxFut<'a, Result<(), PortError>> {
        Box::pin(async move {
            let opts = crate::hub::queue::ports::SendOpts {
                mode: fleetd_contracts::sessions::SendMode::Boundary,
                steer: Some(steer.id),
                riders: steer.riders,
            };
            self.executors
                .send_with(thread, message, client_request_id, &opts)
                .await
                .map(|_| ())
                .map_err(port_error)
        })
    }

    fn interrupt<'a>(
        &'a self,
        thread: &'a ThreadRef,
        client_request_id: &'a str,
    ) -> BoxFut<'a, Result<(), PortError>> {
        Box::pin(async move {
            self.executors
                .interrupt(thread, client_request_id)
                .await
                .map_err(port_error)
        })
    }

    fn action_texts<'a>(
        &'a self,
        thread: &'a ThreadRef,
        limit: usize,
    ) -> BoxFut<'a, Vec<(String, Option<String>)>> {
        Box::pin(async move {
            self.executors
                .actions(thread, limit, false)
                .await
                .map(|actions| {
                    actions
                        .into_iter()
                        .map(|a| (a.summary, a.output_tail))
                        .collect()
                })
                .unwrap_or_default()
        })
    }

    fn default_branch<'a>(
        &'a self,
        machine_id: &'a MachineId,
        cwd: &'a str,
    ) -> BoxFut<'a, Result<String, PortError>> {
        Box::pin(async move {
            self.executors
                .default_branch(machine_id, cwd)
                .await
                .map_err(port_error)
        })
    }

    fn changes<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Option<ThreadChanges>> {
        Box::pin(async move {
            let c = self.executors.changes(thread).await.ok()?;
            Some(ThreadChanges {
                branch: c.branch,
                worktree_path: c.worktree_path,
                paths: c.paths,
                pull_request_urls: c.pull_request_urls,
            })
        })
    }

    fn pending_question<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Option<String>> {
        Box::pin(async move { self.executors.pending_question(thread).await.ok().flatten() })
    }

    fn read_file<'a>(
        &'a self,
        machine_id: &'a MachineId,
        cwd: &'a str,
        path: &'a str,
    ) -> BoxFut<'a, Result<Option<String>, PortError>> {
        Box::pin(async move {
            self.executors
                .read_file(machine_id, cwd, path)
                .await
                .map_err(port_error)
        })
    }

    fn run_command<'a>(
        &'a self,
        machine_id: &'a MachineId,
        cwd: &'a str,
        argv: Vec<String>,
        timeout_sec: u32,
    ) -> BoxFut<'a, Option<CmdOutput>> {
        Box::pin(async move {
            let input = CommandInput {
                cwd: cwd.to_owned(),
                argv,
                timeout_sec: Some(timeout_sec),
            };
            let out = self.commands.run(machine_id, input).await.ok()?;
            Some(CmdOutput {
                exit_code: out.exit_code.map(|c| c.get()),
                output_tail: out.output_tail.to_string(),
            })
        })
    }

    fn workstream(&self, workstream_id: &WorkstreamId) -> Option<Workstream> {
        let hub = self.hub()?;
        let stored = hub.leads.records.workstream_get(workstream_id).ok()??;
        Some(stored.workstream)
    }

    fn lead_settings(&self, project_ref: &ProjectRef) -> Option<ModelEffort> {
        let settings = self.hub()?.leads.records.settings_get(project_ref).ok()?;
        Some(ModelEffort {
            model: settings.model,
            effort: settings.effort,
        })
    }

    fn wake(&self, project_ref: &ProjectRef, kind: WakeKind, text: String) {
        let Some(hub) = self.hub() else { return };
        let kind = match kind {
            WakeKind::TaskResult => LineKind::TaskResult,
            WakeKind::TaskWaiting => LineKind::TaskWaiting,
        };
        hub.leads
            .wakes
            .trigger(project_ref, Trigger::Line { kind, text });
    }

    fn lead_of(&self, machine_id: &MachineId, thread_id: &ThreadId) -> Option<ProjectRef> {
        let leads = self.hub()?.leads.records.leads_list().ok()?;
        leads
            .into_iter()
            .find(|l| &l.project_ref.machine_id == machine_id && &l.thread_id == thread_id)
            .map(|l| l.project_ref)
    }

    fn done_when_text(&self, brief: &Brief) -> String {
        crate::hub::leads::digest::done_when_text(&brief.done_when, None, 200)
    }
}

/// The lead's `fleetd task spawn|list|status|message|cancel`.
struct Calls(Arc<Tasks>);

impl LeadCallHandler for Calls {
    fn handle(&self, caller: LeadCaller, call: LeadCall) -> LeadCallFuture {
        let tasks = Arc::clone(&self.0);
        Box::pin(async move {
            if let LeadCall::AskLead(ask) = &call {
                let CallerAgent::Task(task_id) = &caller.agent else {
                    return Err(super::policy::check(&caller.agent, "ask_lead").unwrap_err());
                };
                let task = tasks.ask_lead(task_id, ask.question.as_str())?;
                return Ok(LeadCallResult::AskLead(AskLeadResult {
                    task_id: task.task_id,
                    next: Some(
                        "Asked. Carry on with what you can; your lead's answer arrives as a message. If you can't \
                         go on without it, end your turn with what you have: the answer continues this thread."
                            .into(),
                    ),
                }));
            }
            let caller = TaskCaller {
                project_ref: caller.project_ref,
                by: caller.by,
            };
            super::tools::lead_call(&tasks, &caller, call).await
        })
    }
}

pub const LEAD_CALL_OPS: [&str; 6] = [
    "task_spawn",
    "task_list",
    "task_status",
    "task_message",
    "task_cancel",
    "ask_lead",
];

/// Tells the hub's lead-call handling which sessions are tasks' agents and which are leads.
struct Directory {
    tasks: Arc<Tasks>,
    hub: Weak<Hub>,
}

impl AgentDirectory for Directory {
    fn agent_of(&self, thread: &ThreadRef) -> Result<(CallerAgent, ProjectRef), McpToolError> {
        let failed = |error: String| {
            tracing::error!(%error, "lead call: agent lookup failed");
            McpToolError::new(
                ErrorCode::Failed,
                "the hub failed while checking who made this call",
            )
            .with_fix("try again shortly")
        };
        if let Some(task) = self
            .tasks
            .task_of_thread(thread)
            .map_err(|e| failed(e.to_string()))?
        {
            return Ok((CallerAgent::Task(task.task_id), task.project_ref));
        }
        let hub = self
            .hub
            .upgrade()
            .ok_or_else(|| failed("the hub is shutting down".into()))?;
        let leads = hub
            .leads
            .records
            .leads_list()
            .map_err(|e| failed(e.to_string()))?;
        match leads
            .into_iter()
            .find(|l| l.project_ref.machine_id == thread.machine_id && l.thread_id == thread.thread_id)
        {
            Some(lead) => Ok((CallerAgent::Lead, lead.project_ref)),
            None => Err(McpToolError::new(
                ErrorCode::Forbidden,
                format!(
                    "session {} is neither a project's lead nor a task, so it can't make fleetd's lead calls",
                    thread.thread_id
                ),
            )
            .with_fix("a person runs these commands from their own shell; agents use their fleetd tools")),
        }
    }
}

pub fn register_lead_calls(hub: &Arc<Hub>) {
    hub.lead_calls.set_directory(Arc::new(Directory {
        tasks: Arc::clone(&hub.tasks),
        hub: Arc::downgrade(hub),
    }));
    let calls: Arc<dyn LeadCallHandler> = Arc::new(Calls(Arc::clone(&hub.tasks)));
    for op in LEAD_CALL_OPS {
        hub.lead_calls.register(op, Arc::clone(&calls));
    }
}

struct UsageFromArea(Arc<crate::hub::usage::Usage>);

impl UsageGate for UsageFromArea {
    fn gate(&self, machine_id: &MachineId) -> Option<String> {
        self.0.gate(machine_id.as_str())
    }
    fn parked_of(&self, event: &HubEvent) -> Option<UsageParked> {
        // Usage keeps its own copy of the event's wire shape.
        let event = serde_json::from_value(serde_json::to_value(event).ok()?).ok()?;
        let parked = crate::hub::usage::classify::parked_of(&event)?;
        serde_json::to_value(parked)
            .ok()
            .and_then(|v| serde_json::from_value(v).ok())
    }
}

struct ValueBarCheck(Arc<crate::hub::valuebar::ValueBar>);

impl SpawnCheck for ValueBarCheck {
    fn check_spawn<'a>(
        &'a self,
        caller: &'a TaskCaller,
        input: &'a SpawnInput,
        workstream: &'a Workstream,
    ) -> BoxFut<'a, Result<(), TaskError>> {
        Box::pin(async move {
            let caller = crate::hub::valuebar::Caller {
                project_ref: caller.project_ref.clone(),
                by: caller.by.clone(),
            };
            let request = crate::hub::valuebar::rules::SpawnRequest {
                workstream_id: input.workstream_id.clone(),
                kind: input.kind,
                serves: input.serves.as_ref().map(|s| s.to_string()),
                pr: input.pr.as_ref().map(|p| p.to_string()),
                qa: input.qa.unwrap_or(false),
            };
            self.0.check_spawn(&caller, &request, workstream).await
        })
    }
}

struct ReceiptsFromArea(Arc<crate::hub::receipts::Receipts>);

impl ResultReceipts for ReceiptsFromArea {
    fn attach<'a>(&'a self, thread: &'a ThreadRef, result: TaskResult) -> BoxFut<'a, TaskResult> {
        Box::pin(self.0.attach(thread, result))
    }
    fn line(&self, result: &TaskResult) -> Option<String> {
        crate::hub::receipts::count::receipts_line(result)
    }
}

/// Digest lines, and listing and cancelling the tasks of removed projects.
struct TasksForLeads(Arc<Tasks>);

impl TasksHook for TasksForLeads {
    fn digest_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
        limit: usize,
        prompts: &crate::hub::prompts::PromptSet,
    ) -> Vec<String> {
        self.0.digest_lines(project_ref, since, limit, prompts)
    }
    fn live(&self, project_ref: Option<&ProjectRef>) -> Vec<(TaskId, ProjectRef)> {
        self.0.live(project_ref)
    }
    fn cancel(&self, project_ref: &ProjectRef, task_id: &TaskId, reason: &str) -> BoxFuture<()> {
        let (tasks, r, t, reason) = (
            Arc::clone(&self.0),
            project_ref.clone(),
            task_id.clone(),
            reason.to_owned(),
        );
        Box::pin(async move { tasks.cancel_for_removal(&r, &t, &reason).await })
    }
}

/// Finish-all's max children from the project's policy.
struct PolicyFromLeases(Arc<crate::hub::leases::Policies>);

impl PolicyHook for PolicyFromLeases {
    fn max_children(
        &self,
        project_ref: &ProjectRef,
    ) -> BoxFuture<Result<Option<u32>, crate::hub::leads::error::LeadError>> {
        let (policies, r) = (Arc::clone(&self.0), project_ref.clone());
        Box::pin(async move {
            let policy =
                policies
                    .get(&r)
                    .await
                    .map_err(|e| crate::hub::leads::error::LeadError {
                        code: e.code,
                        message: e.message,
                        fix: e.fix,
                    })?;
            Ok(policy.finish_all.map(|f| f.max_children.get() as u32))
        })
    }

    fn auto_start(
        &self,
        project_ref: &ProjectRef,
    ) -> BoxFuture<Result<bool, crate::hub::leads::error::LeadError>> {
        let (policies, r) = (Arc::clone(&self.0), project_ref.clone());
        Box::pin(async move {
            let policy =
                policies
                    .get(&r)
                    .await
                    .map_err(|e| crate::hub::leads::error::LeadError {
                        code: e.code,
                        message: e.message,
                        fix: e.fix,
                    })?;
            Ok(policy.lead.is_none_or(|l| l.auto_start))
        })
    }
}

/// Everything tasks, slots and leases hook into once the `Hub` exists: the ports' leads half, the lead calls, the
/// stale-lease sweep check, the usage/value bar/receipts hooks on tasks, and the tasks/policy hooks on leads.
pub fn wire(hub: &Arc<Hub>, ports: &HubTaskPorts) {
    ports.bind(hub);
    register_lead_calls(hub);
    let leases = Arc::clone(&hub.leases);
    hub.sweep.register(crate::hub::sweep::SweepCheck {
        name: "stale leases".into(),
        run: Arc::new(move || {
            let leases = Arc::clone(&leases);
            Box::pin(async move { leases.flag_stale().map(|_| ()).map_err(|e| e.to_string()) })
        }),
    });
    let hooks = &hub.tasks.hooks;
    let _ = hooks
        .usage
        .set(Arc::new(UsageFromArea(Arc::clone(&hub.usage))));
    let _ = hooks
        .spawn_check
        .set(Arc::new(ValueBarCheck(Arc::clone(&hub.value_bar))));
    let _ = hooks
        .receipts
        .set(Arc::new(ReceiptsFromArea(Arc::clone(&hub.receipts))));
    let lead_hooks = &hub.leads.ctx.hooks;
    let _ = lead_hooks
        .tasks
        .set(Arc::new(TasksForLeads(Arc::clone(&hub.tasks))));
    let _ = lead_hooks
        .policy
        .set(Arc::new(PolicyFromLeases(Arc::clone(&hub.policies))));
}
