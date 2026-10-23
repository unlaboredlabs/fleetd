//! `changes_list`.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{ChangesListInput, ErrorCode};
use serde_json::{Value, json};

use super::records::ListFilter;
use super::service::TrainError;
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, cap, require};

pub fn register(tools: &mut Registry) {
    tools.add("changes_list", changes_list);
}

/// The train's `{ code, message, fix }` as a tool error.
pub fn tool_error(e: TrainError) -> ToolError {
    let code = if e.code == "not_found" {
        ErrorCode::NotFound
    } else {
        ErrorCode::Invalid
    };
    let error = ToolError::new(code, e.message);
    match e.fix {
        Some(fix) => error.with_fix(fix),
        None => error,
    }
}

async fn changes_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: ChangesListInput,
) -> Result<Value, ToolError> {
    if let Some(r) = &input.project_ref {
        require(&caller, Role::Read, Some(&r.machine_id))?;
    }
    let limit = input.limit.get();
    let filter = ListFilter {
        limit: if input.project_ref.is_some() {
            limit + 1
        } else {
            1000
        },
        project_ref: input.project_ref,
        repo: input.repo.map(|r| r.to_string()),
        state: input.state,
    };
    let all: Vec<_> = hub
        .train
        .list(&filter)
        .into_iter()
        .filter(|c| allows(&caller, Role::Read, Some(&c.project_ref.machine_id)))
        .collect();
    let shown = cap(all, limit as usize);
    let next = if shown.truncated.is_some() {
        "Narrow the list with projectRef, repo or state."
    } else {
        "Only the train merges; events_wait for pr.merged."
    };
    let mut out = json!({ "changes": shown.items, "next": next });
    if let Some(t) = shown.truncated {
        out["truncated"] = json!(t);
    }
    Ok(out)
}
