//! MCP tools over node sessions: thread_answer, the way out of `thread.waiting`. Projects are in hub/projects.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::mcp::{PermissionAnswer, ThreadAnswerInput};
use serde_json::Value;

use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, is_human};
use crate::hub::approvals::{Caller as ApprovalCaller, ThreadAnswer};

pub fn register(tools: &mut Registry) {
    tools.add("thread_answer", thread_answer);
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

#[cfg(test)]
mod tests {
    use fleetd_contracts::mcp::ThreadAnswerInput;
    use serde_json::json;

    #[test]
    fn thread_answer_takes_a_deny_message_only_with_deny() {
        let answer = |extra: serde_json::Value| {
            let mut input = json!({ "machineId": "devbox", "threadId": "7f0c" });
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
}
