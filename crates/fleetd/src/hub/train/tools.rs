//! `changes_list`, `train_get` and `train_freeze` (api/FleetApi.ts).
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{ChangesListInput, ErrorCode, TrainFreezeInput, TrainGetInput};
use serde_json::{Value, json};

use super::records::ListFilter;
use super::rules::freeze_key;
use super::service::TrainError;
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, allows, allows_everywhere, cap, is_human, require,
};

pub fn register(tools: &mut Registry) {
    tools.add("changes_list", changes_list);
    tools.add("train_get", train_get);
    tools.add("train_freeze", train_freeze);
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

fn unknown_train(repo: &str) -> ToolError {
    ToolError::new(ErrorCode::NotFound, format!("No merge train for {repo}; a repo gets one when its first PR is enqueued."))
        .with_fix(format!("To hold it before then, record the decision {} = true with decisions_record at its project's scope.", freeze_key(repo)))
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
        "train_get shows a repo's train; only the train merges."
    };
    let mut out = json!({ "changes": shown.items, "next": next });
    if let Some(t) = shown.truncated {
        out["truncated"] = json!(t);
    }
    Ok(out)
}

async fn train_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: TrainGetInput,
) -> Result<Value, ToolError> {
    let repo = input.repo.as_str();
    let row = hub.train.records().train(repo);
    if !row.is_some_and(|r| allows(&caller, Role::Read, Some(&r.project_ref.machine_id))) {
        return Err(unknown_train(repo));
    }
    let state = hub.train.state(repo);
    let next = if state.frozen {
        format!(
            "Frozen by {}; train_freeze with frozen false resumes it.",
            freeze_key(repo)
        )
    } else {
        "changes_list with this repo shows each Change; events_wait for pr.merged.".to_string()
    };
    Ok(json!({ "train": state, "next": next }))
}

async fn train_freeze(
    hub: Arc<Hub>,
    caller: Caller,
    input: TrainFreezeInput,
) -> Result<Value, ToolError> {
    let repo = input.repo.as_str();
    let Some(row) = hub
        .train
        .records()
        .train(repo)
        .filter(|r| allows(&caller, Role::Read, Some(&r.project_ref.machine_id)))
    else {
        return Err(unknown_train(repo));
    };
    require(&caller, Role::Operate, Some(&row.project_ref.machine_id))?;
    let key = freeze_key(repo);
    let host = hub.train.host();
    let failed = |message: String| ToolError::new(ErrorCode::Invalid, message);
    if input.frozen {
        let human = is_human(&caller);
        let by = if human {
            format!("human:{}", caller.name)
        } else {
            caller.name.clone()
        };
        let why = input.reason.as_ref().map(|r| r.as_str());
        host.record_decision(&key, &row.project_ref, "true", why, human, &by)
            .map_err(failed)?;
    } else {
        // Every active freeze along the chain goes: a project one may hide a global one behind it.
        while let Some(active) = host.resolve_decision(&key, &row.project_ref) {
            if active.global && !allows_everywhere(&caller, Role::Operate) {
                return Err(ToolError::new(
                    ErrorCode::Forbidden,
                    format!("{} freezes {repo} globally; this key has no operate grant on every machine.", active.decision_id),
                )
                .with_fix("Use a key with an operate grant on * machines."));
            }
            host.retire_decision(&active.decision_id).map_err(failed)?;
        }
    }
    let mut train = serde_json::to_value(hub.train.state(repo)).unwrap_or_default();
    train["frozen"] = json!(input.frozen);
    let (verb, event) = if input.frozen {
        ("holds", "train.frozen")
    } else {
        ("resumes", "train.resumed")
    };
    Ok(
        json!({ "train": train, "next": format!("The train {verb} on its next pass (within 15 s) and emits {event}.") }),
    )
}
