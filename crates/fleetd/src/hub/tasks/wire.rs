//! Tasks and slots over the rest of the hub: the executor and node commands (built before tasks) and leads
//! (built after, so reached through the `Hub` once it exists). Also the hooks other areas fill in on tasks, and the
//! hooks tasks fill in on leads.
use std::sync::{Arc, OnceLock, Weak};

use fleetd_contracts::events::HubEvent;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadId, ThreadRef, Timestamp};
use fleetd_contracts::lead_calls::{AskLeadResult, LeadCall, LeadCallResult};
use fleetd_contracts::ledger::{Brief, Workstream, WorkstreamId};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::mcp_servers::McpAgentRole;
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::projects::github_repo;
use fleetd_contracts::sessions::{SessionWorkspace, WorktreeBase};
use fleetd_contracts::tasks::TaskId;
use fleetd_contracts::usage::UsageParked;
use fleetd_contracts::work::{WorkMatch, WorkScope};

use super::hooks::UsageGate;
use super::ports::{
    BoxFut, BranchPrError, CmdOutput, LaunchRequest, PortError, TaskPorts, ThreadChanges, WakeKind,
};
use super::{TaskCaller, Tasks};
use crate::hub::api::Hub;
use crate::hub::executor::{ExecutorError, Executors, LaunchInput, LaunchOptions};
use crate::hub::leads::hooks::{BoxFuture, TasksHook};
use crate::hub::leads::wakes::{LineKind, Trigger};
use crate::hub::link::commands::CommandInput;
use crate::hub::link::lead_calls::{AgentDirectory, CallerAgent, LeadCallFuture};
use crate::hub::link::{LeadCallHandler, LeadCaller, NodeCommands};
use crate::hub::store::StoreError;
use crate::hub::work::{Observed, matcher};

pub(crate) fn port_error(error: ExecutorError) -> PortError {
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

    fn live_since(&self, machine_id: &MachineId) -> Option<i64> {
        self.executors.live_since(machine_id)
    }

    fn launch<'a>(
        &'a self,
        machine_id: &'a MachineId,
        request: LaunchRequest,
    ) -> BoxFut<'a, Result<(ThreadId, Option<WorktreeBase>), PortError>> {
        Box::pin(async move {
            let project = ProjectRef {
                machine_id: machine_id.clone(),
                project_id: request.project_id.clone(),
            };
            // A new worktree is set up first, by a node that can.
            let setup = match (&request.worktree, self.hub()) {
                (Some(_), Some(hub))
                    if hub
                        .link
                        .node_can(machine_id, fleetd_contracts::node_link::CAP_WORKTREE_SETUP) =>
                {
                    hub.db
                        .project_settings()
                        .setup(&project)
                        .map_err(|e| PortError::Failed(e.to_string()))?
                }
                _ => None,
            };
            let input = LaunchInput {
                project_id: request.project_id,
                prompt: request.prompt,
                profile: request.profile,
                runtime_mode: RuntimeMode::FullAccess,
                title: Some(request.title),
                client_request_id: request.client_request_id,
            };
            let workspace = match request.worktree {
                None => None,
                Some(w) => {
                    let base_ref = NonEmpty::new(w.base_ref)
                        .map_err(|_| PortError::Failed("a worktree needs a base ref".into()))?;
                    Some(match w.branch {
                        Some(branch) => SessionWorkspace::Worktree {
                            base_ref,
                            branch: NonEmpty::new(branch).map_err(|_| {
                                PortError::Failed("a worktree needs a branch".into())
                            })?,
                            from_session: w.from,
                        },
                        None => SessionWorkspace::Detached {
                            base_ref,
                            pr: w.pr.and_then(|pr| NonEmpty::new(pr).ok()),
                        },
                    })
                }
            };
            let mcp_role = match request.kind {
                fleetd_contracts::tasks::TaskKind::Write => McpAgentRole::Writer,
                fleetd_contracts::tasks::TaskKind::Read
                | fleetd_contracts::tasks::TaskKind::Review => McpAgentRole::Reviewer,
            };
            let options = LaunchOptions {
                workspace,
                role: fleetd_contracts::sessions::SessionRole::Worker,
                mcp_role: Some(mcp_role),
                order_id: request.order_id,
                setup,
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

    fn started_run(&self, thread: &ThreadRef) -> Option<String> {
        self.executors.started_run(thread)
    }

    fn recreated_from(&self, thread: &ThreadRef) -> Option<super::ports::Rebuilt> {
        self.executors.recreated_from(thread)
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

    fn stop<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Result<(), PortError>> {
        Box::pin(async move { self.executors.stop(thread, false).await.map_err(port_error) })
    }

    fn remove_worktree<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Result<(), PortError>> {
        Box::pin(async move { self.executors.stop(thread, true).await.map_err(port_error) })
    }

    fn paused(&self, machine_id: &MachineId) -> Option<String> {
        self.hub()?.link.paused(machine_id)
    }

    fn detached_worktrees(&self, machine_id: &MachineId) -> bool {
        self.hub().is_some_and(|hub| {
            hub.link
                .node_can(machine_id, fleetd_contracts::node_link::CAP_DETACHED)
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
    ) -> BoxFut<'a, Result<Option<String>, PortError>> {
        Box::pin(async move {
            self.executors
                .default_branch(machine_id, cwd)
                .await
                .map_err(port_error)
        })
    }

    fn work_scope<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
    ) -> BoxFut<'a, Result<Option<WorkScope>, StoreError>> {
        Box::pin(async move {
            match self.hub() {
                Some(hub) => hub.work.scope_of(project_ref),
                None => Ok(None),
            }
        })
    }

    fn work_bind(
        &self,
        project_ref: &ProjectRef,
    ) -> BoxFut<'static, Result<Option<WorkScope>, StoreError>> {
        let (hub, project) = (self.hub(), project_ref.clone());
        Box::pin(async move {
            match hub {
                Some(hub) => crate::hub::work::bind_from_root(&hub, &project).await,
                None => Ok(None),
            }
        })
    }

    fn work_observe<'a>(
        &'a self,
        scope: &'a WorkScope,
        timeout: std::time::Duration,
    ) -> BoxFut<'a, Result<Observed, StoreError>> {
        Box::pin(async move {
            match self.hub() {
                Some(hub) => hub.work.observe(scope, Some(timeout)).await,
                None => Ok(Observed::default()),
            }
        })
    }

    fn work_match(
        &self,
        scope: &WorkScope,
        intent: &matcher::Work,
        paths: &std::collections::HashMap<TaskId, Vec<String>>,
    ) -> Result<Vec<WorkMatch>, StoreError> {
        match self.hub() {
            Some(hub) => hub.work.check_observed(scope, intent, paths),
            None => Ok(Vec::new()),
        }
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

    fn pr_found(&self, task_id: &TaskId) {
        let Some(hub) = self.hub() else { return };
        let task_id = task_id.clone();
        tokio::spawn(async move { hub.train.on_task_pr(task_id.as_str()).await });
    }

    fn pending_question<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Option<String>> {
        Box::pin(async move { self.executors.pending_question(thread).await.ok().flatten() })
    }

    fn branch_pr<'a>(
        &'a self,
        remote: &'a str,
        branch: &'a str,
    ) -> BoxFut<'a, Result<Option<String>, BranchPrError>> {
        use crate::hub::train::github::{GhErrorKind, Pull};
        Box::pin(async move {
            let repo = github_repo(remote).ok_or(BranchPrError::NoReader)?;
            let hub = self
                .hub()
                .ok_or_else(|| BranchPrError::Unread("the hub is starting".into()))?;
            let owner = repo.as_str().split('/').next().unwrap_or_default();
            let path = format!(
                "repos/{}/pulls?head={owner}:{branch}&state=all&per_page=10",
                repo.as_str()
            );
            let answer = hub.train.github().get(&path).await.map_err(|e| {
                tracing::warn!(remote, branch, error = %e.message, "tasks: branch PR not read");
                match e.kind {
                    GhErrorKind::Auth => BranchPrError::Refused("gh not logged in".into()),
                    GhErrorKind::Missing => BranchPrError::Refused("gh not installed".into()),
                    GhErrorKind::Failed => BranchPrError::Unread(e.message),
                }
            })?;
            let value = answer.map_err(|(status, message)| {
                tracing::warn!(remote, branch, status, %message, "tasks: branch PR not read");
                super::pr::host_error(status, &message)
            })?;
            let pulls: Vec<Pull> = serde_json::from_value(value).map_err(|_| {
                BranchPrError::Unread(format!("gh api {path} returned an unexpected shape"))
            })?;
            let pull = pulls
                .iter()
                .find(|p| p.state == "open")
                .or_else(|| pulls.iter().find(|p| p.merged || p.merged_at.is_some()));
            Ok(pull.map(|p| format!("https://github.com/{}/pull/{}", repo.as_str(), p.number)))
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
        Some(stored)
    }

    fn medium_allowed(&self, project_ref: &ProjectRef) -> bool {
        let Some(hub) = self.hub() else { return false };
        hub.leads
            .leads
            .medium_allowed(project_ref)
            .unwrap_or_else(|error| {
                // Unread, a task runs high: the safe side.
                tracing::warn!(message = %error.message, "the project's medium switch was not read");
                false
            })
    }

    fn wake(&self, project_ref: &ProjectRef, kind: WakeKind, text: String) {
        let Some(hub) = self.hub() else { return };
        let kind = match kind {
            WakeKind::TaskResult => LineKind::TaskResult,
            WakeKind::TaskWaiting => LineKind::TaskWaiting,
            WakeKind::CapRaised => LineKind::CapRaised,
            WakeKind::Recovery => LineKind::Recovery,
            WakeKind::RecoveryPaused => LineKind::RecoveryPaused,
            WakeKind::Quiet => LineKind::Quiet,
        };
        hub.leads
            .wakes
            .trigger(project_ref, Trigger::Line { kind, text });
    }

    fn done_when_text(&self, brief: &Brief) -> String {
        crate::hub::leads::digest::done_when_text(&brief.done_when, 2000)
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

pub const LEAD_CALL_OPS: [&str; 5] = [
    "task_spawn",
    "task_list",
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
        let event: HubEvent = serde_json::from_value(serde_json::to_value(event).ok()?).ok()?;
        let mut parked = crate::hub::usage::classify::parked_of(&event)?;
        // The usage layer's own park of it, once applied, also knows when it tries a limit with no reset again.
        let thread = crate::hub::usage::ports::ThreadRef {
            machine_id: event.machine_id.as_ref()?.to_string(),
            thread_id: event.thread_id.as_ref()?.to_string(),
        };
        if let Some(own) = self
            .0
            .parked_of(&thread)
            .filter(|p| p.since == parked.since)
        {
            parked.check_at = own.check_at;
        }
        serde_json::to_value(parked)
            .ok()
            .and_then(|v| serde_json::from_value(v).ok())
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
    ) -> Vec<String> {
        self.0.digest_lines(project_ref, since, limit)
    }
    fn agents(&self, project_ref: &ProjectRef) -> crate::hub::leads::events::AgentsLine {
        self.0.agents(project_ref)
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

/// Everything tasks and slots hook into once the `Hub` exists: the ports' leads half, the lead calls, the
/// usage hook on tasks, and the tasks hook on leads.
pub fn wire(hub: &Arc<Hub>, ports: &HubTaskPorts) {
    ports.bind(hub);
    register_lead_calls(hub);
    let hooks = &hub.tasks.hooks;
    let _ = hooks
        .usage
        .set(Arc::new(UsageFromArea(Arc::clone(&hub.usage))));
    let lead_hooks = &hub.leads.ctx.hooks;
    let _ = lead_hooks
        .tasks
        .set(Arc::new(TasksForLeads(Arc::clone(&hub.tasks))));
    let tasks = Arc::clone(&hub.tasks);
    hub.sweep.register(crate::hub::sweep::SweepCheck {
        name: "unreachable-tasks".into(),
        run: Arc::new(move || {
            let result = tasks.unreachable().map_err(|e| e.to_string());
            Box::pin(async move { result })
        }),
    });
    // Orphaned tasks, sessions nobody owns, and breakers whose quiet spell is over.
    let tasks = Arc::downgrade(&hub.tasks);
    hub.sweep.register(crate::hub::sweep::SweepCheck {
        name: "tasks".into(),
        run: Arc::new(move || {
            let tasks = tasks.upgrade();
            Box::pin(async move {
                match tasks {
                    Some(tasks) => tasks.sweep().await,
                    None => Ok(()),
                }
            })
        }),
    });
}
