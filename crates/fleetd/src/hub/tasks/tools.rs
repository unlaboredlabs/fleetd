//! MCP tools `tasks_list`, `task_get`, `cap_set` and the lead calls `task_spawn|task_list|task_status|task_message|
//! task_cancel`. TS spec: apps/hub/src/api/FleetApi.ts (those three tools) and apps/hub/src/leads/LeadCallHandler.ts
//! (the task cases).
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult, TaskListResult, TaskResultFrame};
use fleetd_contracts::mcp::{CapSetInput, ErrorCode, TaskGetInput, TasksListInput};
use fleetd_contracts::prim::List;
use fleetd_contracts::tasks::Task;
use serde_json::{Value, json};

use super::ports::TaskError;
use super::{TaskCaller, TaskFilter, Tasks};
use crate::hub::api::{
    Hub, Registry, ToolError, allows, cap, internal_error, require, unknown_project,
};
use crate::hub::slots::CapInput;
use crate::hub::store::StoreError;

const TASK_LIST_LIMIT: usize = 50;

fn unknown_task(task_id: &str) -> ToolError {
    ToolError::new(ErrorCode::NotFound, format!("No task {task_id}."))
        .with_fix("Call tasks_list to see tasks.")
}

/// Adds the three tools to the hub's tool table.
pub fn register(tools: &mut Registry) {
    tools.add("tasks_list", |hub: Arc<Hub>, caller, input: TasksListInput| async move {
        if let Some(r) = &input.project_ref {
            require(&caller, Role::Read, Some(&r.machine_id))?;
        }
        let limit = input.limit.get() as usize;
        // Without a project, read wide and keep what the key may see.
        let filter = TaskFilter {
            project_ref: input.project_ref.clone(),
            state: input.state,
            workstream_id: None,
            limit: if input.project_ref.is_none() { 1000 } else { limit + 1 },
        };
        let listed: Vec<_> = hub.tasks.list(&filter)?.into_iter().filter(|t| allows(&caller, Role::Read, Some(&t.project_ref.machine_id))).collect();
        let shown = cap(listed, limit);
        let next = if shown.truncated.is_some() {
            "Narrow the list with projectRef or state."
        } else {
            "Call task_get for one task's result, or thread_tail on its threadRef for its transcript."
        };
        let mut out = json!({ "tasks": shown.items });
        if shown.truncated.is_some() {
            out["truncated"] = json!(true);
        }
        out["next"] = json!(next);
        Ok::<Value, ToolError>(out)
    });

    tools.add(
        "task_get",
        |hub: Arc<Hub>, caller, input: TaskGetInput| async move {
            let task = match hub.tasks.get(&input.task_id)? {
                Some(task) if allows(&caller, Role::Read, Some(&task.project_ref.machine_id)) => {
                    task
                }
                _ => return Err(unknown_task(input.task_id.as_str())),
            };
            let next = match &task.thread_ref {
                None => format!(
                    "{} has not started{}.",
                    task.task_id.as_str(),
                    task.queued_reason
                        .as_ref()
                        .map_or_else(String::new, |r| format!(": {}", r.as_str()))
                ),
                Some(t) => format!(
                    "Read its transcript with thread_tail (machineId {}, threadId {}).",
                    t.machine_id.as_str(),
                    t.thread_id.as_str()
                ),
            };
            Ok::<Value, ToolError>(json!({ "task": task, "next": next }))
        },
    );

    tools.add("cap_set", |hub: Arc<Hub>, _caller, input: CapSetInput| async move {
        if let Some(share) = &input.share
            && hub.store.project_get(&share.project_ref)?.is_none()
        {
            return Err(unknown_project(&share.project_ref));
        }
        let board = hub.slots.set_cap(CapInput {
            cap: input.cap.map(|c| c.get()),
            share: input.share.map(|s| (s.project_ref, s.share.get())),
        })?;
        Ok::<Value, ToolError>(json!({ "slots": board, "next": "Applied now: queued tasks start as soon as they fit. fleetd_status shows the board." }))
    });
}

fn frame(task: Task) -> TaskResultFrame {
    TaskResultFrame { task, next: None }
}

fn internal(error: StoreError) -> TaskError {
    tracing::error!(%error, "task lead call failed");
    internal_error()
}

/// The task cases of TS LeadCallHandler: `wire::register_lead_calls` routes `task_spawn`, `task_list`,
/// `task_status`, `task_message` and `task_cancel` here with the caller link attributed.
pub async fn lead_call(
    tasks: &Arc<Tasks>,
    caller: &TaskCaller,
    call: LeadCall,
) -> Result<LeadCallResult, TaskError> {
    let r = &caller.project_ref;
    match call {
        LeadCall::TaskSpawn(input) => Ok(LeadCallResult::TaskSpawn(frame(
            tasks.spawn(caller, input).await?,
        ))),
        LeadCall::TaskList(c) => {
            let filter = TaskFilter {
                project_ref: Some(r.clone()),
                state: c.state,
                workstream_id: c.workstream_id,
                limit: TASK_LIST_LIMIT + 1,
            };
            let mut listed = tasks.list(&filter).map_err(internal)?;
            let truncated = listed.len() > TASK_LIST_LIMIT;
            listed.truncate(TASK_LIST_LIMIT);
            Ok(LeadCallResult::TaskList(TaskListResult {
                tasks: List::unchecked(listed),
                truncated: truncated.then_some(true),
                next: None,
            }))
        }
        LeadCall::TaskStatus(c) => match tasks.get(&c.task_id).map_err(internal)? {
            Some(task) if task.project_ref == *r => Ok(LeadCallResult::TaskStatus(frame(task))),
            _ => Err(TaskError::new(
                ErrorCode::NotFound,
                format!("There is no task {} in your project.", c.task_id.as_str()),
            )
            .with_fix("Run `fleetd task list`.")),
        },
        LeadCall::TaskMessage(c) => Ok(LeadCallResult::TaskMessage(frame(
            tasks
                .message(caller, &c.task_id, c.message.as_str())
                .await?,
        ))),
        LeadCall::TaskCancel(c) => {
            let reason = c.reason.as_ref().map(|r| r.as_str());
            Ok(LeadCallResult::TaskCancel(frame(
                tasks.cancel(caller, &c.task_id, reason).await?,
            )))
        }
        _ => Err(TaskError::new(ErrorCode::Invalid, "Not a task call.")
            .with_fix("Use fleetd task spawn|list|status|message|cancel.")),
    }
}
