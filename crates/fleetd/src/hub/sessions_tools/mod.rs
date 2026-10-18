//! MCP tools over node sessions: thread_answer (the way out of `thread.waiting`),
//! project_add and project_remove.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::{MachineId, ProjectId};
use fleetd_contracts::mcp::{
    ErrorCode, PermissionAnswer, ProjectAddInput, ProjectRemoveInput, ThreadAnswerInput,
};
use fleetd_contracts::model::{ThreadStatus, ThreadSummary};
use serde_json::{Value, json};

use crate::hub::api::{
    Caller, Hub, Registry, ToolError, allows, is_human, offline, require, unknown_machine,
};
use crate::hub::approvals::{Caller as ApprovalCaller, ThreadAnswer};
use crate::hub::executor::tools::from_executor;

pub fn register(tools: &mut Registry) {
    tools.add("thread_answer", thread_answer);
    tools.add("project_add", project_add);
    tools.add("project_remove", project_remove);
}

async fn thread_answer(
    hub: Arc<Hub>,
    caller: Caller,
    input: ThreadAnswerInput,
) -> Result<Value, ToolError> {
    let grants = caller.clone();
    let allows_operate =
        move |m: &str| MachineId::new(m).is_ok_and(|m| allows(&grants, Role::Operate, Some(&m)));
    let who = ApprovalCaller {
        human: is_human(&caller),
        name: &caller.name,
        allows_operate: &allows_operate,
    };
    let answer = ThreadAnswer {
        machine_id: input.machine_id.to_string(),
        thread_id: input.thread_id.to_string(),
        request_id: input.request_id.map(|r| r.to_string()),
        allow: input.decision == PermissionAnswer::Allow,
        message: input.message.map(|m| m.to_string()),
    };
    hub.approvals
        .answer_thread(&who, answer)
        .await
        .map_err(crate::hub::approvals::tools::refusal)
}

fn connected(hub: &Hub, machine_id: &MachineId) -> Result<(), ToolError> {
    if hub.store.machine_get(machine_id)?.is_none() {
        return Err(unknown_machine(machine_id));
    }
    if !hub.executors.is_connected(machine_id) {
        return Err(offline(machine_id));
    }
    Ok(())
}

/// The directory as the node stores it, and the title it gets when none is given: the directory's name.
fn normalized(path: &str) -> (&str, &str) {
    let path = path.strip_suffix('/').unwrap_or(path);
    (path, path.rsplit('/').next().unwrap_or(path))
}

async fn project_add(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectAddInput,
) -> Result<Value, ToolError> {
    let m = &input.machine_id;
    require(&caller, Role::Operate, Some(m))?;
    connected(&hub, m)?;
    let (path, name) = normalized(input.path.as_str());
    let existing = hub.executors.project_at(m, path);
    let created = existing.is_none();
    let project_id =
        existing.unwrap_or_else(|| ProjectId::unchecked(crate::hub::executor::new_uuid().as_str()));
    // The same directory again is the same project; a title renames it.
    if created || input.title.is_some() {
        let title = input.title.as_deref().unwrap_or(name);
        hub.executors
            .project_upsert(m, &project_id, title, path)
            .await
            .map_err(from_executor)?;
    }
    Ok(json!({
        "projectId": project_id,
        "created": created,
        "next": format!("Send it an order with intake_submit; its lead starts with the first one. Or launch a thread with thread_launch on {m}."),
    }))
}

async fn project_remove(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectRemoveInput,
) -> Result<Value, ToolError> {
    let m = &input.machine_id;
    require(&caller, Role::Operate, Some(m))?;
    connected(&hub, m)?;
    let r = fleetd_contracts::ids::ProjectRef {
        machine_id: m.clone(),
        project_id: input.project_id.clone(),
    };
    let active = active_threads(&hub.store.threads_by_project(&r, i64::MAX)?);
    if !active.is_empty() {
        let n = active.len();
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "Project {} on {m} has {n} active thread{} (running or waiting on a permission prompt): {}.",
                input.project_id,
                if n == 1 { "" } else { "s" },
                active.join(", ")
            ),
        )
        .with_fix("Answer or interrupt them (thread_answer, thread_interrupt) or let them finish, then remove it."));
    }
    hub.executors
        .project_remove(m, &input.project_id)
        .await
        .map_err(from_executor)?;
    Ok(json!({
        "ok": true,
        "next": "Its files, branches and worktrees stay on the machine; project_add brings it back.",
    }))
}

/// Threads whose run is still active: running (queued and starting included) or waiting on a prompt. Stale rows
/// never run again.
fn active_threads(threads: &[ThreadSummary]) -> Vec<String> {
    threads
        .iter()
        .filter(|t| !t.stale && matches!(t.status, ThreadStatus::Running | ThreadStatus::Waiting))
        .map(|t| t.thread_id.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{active_threads, normalized};
    use fleetd_contracts::mcp::{ProjectAddInput, ThreadAnswerInput};
    use serde_json::json;

    #[test]
    fn project_paths_are_absolute_directories_and_name_their_project() {
        let add = |path: &str| {
            serde_json::from_value::<ProjectAddInput>(json!({ "machineId": "forge", "path": path }))
        };
        for bad in [
            "src/app",
            "/",
            "/home/../etc",
            "/home/./me",
            "/home//me",
            "/a\nb",
            "",
        ] {
            assert!(add(bad).is_err(), "{bad:?} refused");
        }
        let ok = add("/home/me/src/app/").unwrap();
        assert_eq!(normalized(ok.path.as_str()), ("/home/me/src/app", "app"));
        assert_eq!(normalized("/srv/x"), ("/srv/x", "x"));
        assert!(
            serde_json::from_value::<ProjectAddInput>(
                json!({ "machineId": "forge", "path": "/srv/x", "title": "" })
            )
            .is_err(),
            "an empty title is refused, not defaulted"
        );
    }

    #[test]
    fn thread_answer_takes_a_deny_message_only_with_deny() {
        let answer = |extra: serde_json::Value| {
            let mut input = json!({ "machineId": "forge", "threadId": "7f0c" });
            input
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            serde_json::from_value::<ThreadAnswerInput>(input)
        };
        assert!(answer(json!({ "decision": "allow" })).is_ok());
        assert!(answer(json!({ "decision": "deny", "message": "use the test db" })).is_ok());
        assert!(answer(json!({ "decision": "allow", "message": "x" })).is_err());
        assert!(answer(json!({ "decision": "maybe" })).is_err());
        assert!(answer(json!({ "decision": "deny", "requestId": "" })).is_err());
        assert!(answer(json!({})).is_err(), "a decision is required");
    }

    #[test]
    fn a_project_with_a_running_or_waiting_thread_is_not_removed() {
        let thread = |id: &str, status: &str, stale: bool| {
            serde_json::from_value::<fleetd_contracts::model::ThreadSummary>(json!({
                "machineId": "forge", "threadId": id, "projectId": "p1", "title": "t", "status": status,
                "headline": "", "latestMessageTail": "", "lastProgressAt": "2026-10-18T10:00:00.000Z",
                "stale": stale, "asOf": "2026-10-18T10:00:00.000Z",
            }))
            .unwrap()
        };
        let threads = [
            thread("a", "running", false),
            thread("b", "waiting", false),
            thread("c", "completed", false),
            thread("d", "idle", false),
            thread("e", "running", true),
        ];
        assert_eq!(active_threads(&threads), ["a", "b"]);
        assert!(active_threads(&threads[2..]).is_empty());
    }
}
