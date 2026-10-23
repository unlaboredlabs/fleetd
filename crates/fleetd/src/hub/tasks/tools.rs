//! MCP tools `tasks_list`, `task_get`, `cap_set` and the lead calls `task_spawn|task_list|task_message|
//! task_cancel`.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::effort::TaskProfile;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult, TaskListResult, TaskResultFrame};
use fleetd_contracts::mcp::{CapSetInput, ErrorCode, TaskGetInput, TasksListInput};
use fleetd_contracts::prim::List;
use fleetd_contracts::tasks::{Task, TaskKind};
use serde_json::{Value, json};

use super::cap::{CapChange, ProjectCap};
use super::ports::TaskError;
use super::{TaskCaller, TaskFilter, Tasks};
use crate::hub::api::{
    Hub, Registry, ToolError, allows, allows_everywhere, cap, forbidden, internal_error, require,
    unknown_project,
};
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

    tools.add(
        "cap_set",
        |hub: Arc<Hub>, caller, input: CapSetInput| async move {
            if input.cap.is_some() && !allows_everywhere(&caller, Role::Admin) {
                return Err(forbidden(Role::Admin, None));
            }
            if let Some(p) = &input.project {
                require(&caller, Role::Operate, Some(&p.project_ref.machine_id))?;
                if hub.store.project_get(&p.project_ref)?.is_none() {
                    return Err(unknown_project(&p.project_ref));
                }
            }
            let outcome = hub
                .tasks
                .set_caps(CapChange {
                    cap: input.cap.map(|c| c.get()),
                    project: input.project.map(|p| ProjectCap {
                        project_ref: p.project_ref,
                        max_agents: p.max_agents.get(),
                        pause_extras: p.pause_extras.unwrap_or(false),
                    }),
                })
                .await
                .map_err(|e| {
                    let error = ToolError::new(e.code, e.message);
                    match e.fix {
                        Some(fix) => error.with_fix(fix),
                        None => error,
                    }
                })?;
            Ok::<Value, ToolError>(json!({
                "slots": outcome.slots,
                "paused": (!outcome.paused.is_empty()).then_some(outcome.paused),
                "next": outcome.next,
            }))
        },
    );
}

fn frame(task: Task) -> TaskResultFrame {
    TaskResultFrame {
        task,
        steer_id: None,
        next: None,
    }
}

fn internal(error: StoreError) -> TaskError {
    tracing::error!(%error, "task lead call failed");
    internal_error()
}

/// The task lead calls: `wire::register_lead_calls` routes `task_spawn`, `task_list`,
/// `task_message` and `task_cancel` here with the caller link attributed.
pub async fn lead_call(
    tasks: &Arc<Tasks>,
    caller: &TaskCaller,
    call: LeadCall,
) -> Result<LeadCallResult, TaskError> {
    let r = &caller.project_ref;
    match call {
        LeadCall::TaskSpawn(input) => {
            let asked = input.profile;
            let task = tasks.spawn(caller, input).await?;
            let mut next = match (tasks.queued_next(&task), tasks.also_writing(&task).await) {
                (Some(queued), Some(also)) => Some(format!("{queued} {also}")),
                (queued, also) => queued.or(also),
            };
            if asked == Some(TaskProfile::Medium) && task.profile == TaskProfile::High {
                let why = if task.kind == TaskKind::Review {
                    "It runs high: reviews always do."
                } else {
                    "It runs high: medium is off in this project."
                };
                next = Some(match next {
                    Some(n) => format!("{why} {n}"),
                    None => why.to_owned(),
                });
            }
            Ok(LeadCallResult::TaskSpawn(TaskResultFrame {
                next,
                ..frame(task)
            }))
        }
        LeadCall::TaskList(c) => {
            if let Some(id) = &c.task_id {
                return match tasks.get(id).map_err(internal)? {
                    Some(task) if task.project_ref == *r => {
                        Ok(LeadCallResult::TaskList(TaskListResult {
                            tasks: List::unchecked(vec![task]),
                            truncated: None,
                            next: None,
                        }))
                    }
                    _ => Err(TaskError::new(
                        ErrorCode::NotFound,
                        format!("There is no task {} in your project.", id.as_str()),
                    )
                    .with_fix("Call `agents` without taskId.")),
                };
            }
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
            .with_fix("Use spawn_agent, agents, message_agent or stop_agent.")),
    }
}
