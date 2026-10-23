//! MCP tools of the lead chat (chat_send, chat_history, chat_stop, project_stop), the tools it replaces (each answers where it
//! moved, for one release), and the lead's `workstream_open` call.
use std::sync::{Arc, Weak};

use fleetd_contracts::auth::Role;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult, WorkstreamOpenResult};
use fleetd_contracts::ledger::IntakeChannel;
use fleetd_contracts::mcp::{
    ChatHistoryInput, ChatHistoryOutput, ChatSendInput, ChatSendOutput, ChatStopInput, ErrorCode,
    McpToolError, ProjectStopInput, ProjectStopOutput,
};
use fleetd_contracts::prim::List;
use serde_json::Value;

use super::flow;
use crate::hub::api::{Caller, Hub, Registry, ToolError, require};
use crate::hub::leads::workstreams::IntakeInput;
use crate::hub::link::lead_calls::LeadCallFuture;
use crate::hub::link::{LeadCaller, LeadCalls};

/// The tools the chat replaced, with where each went.
pub const MOVED: &[(&str, &str)] = &[
    (
        "intake_submit",
        "Write to the project's lead with chat_send; the lead turns it into work.",
    ),
    (
        "intake_preview",
        "Pick the project and write to its lead with chat_send.",
    ),
    (
        "order_note",
        "Write to the project's lead with chat_send; it reads you at once.",
    ),
    (
        "order_stop",
        "Stop everything in the project with project_stop, or tell the lead in chat_send.",
    ),
];

pub fn register(tools: &mut Registry) {
    tools.add("chat_send", chat_send);
    tools.add("chat_history", chat_history);
    tools.add("project_stop", project_stop);
    tools.add_raw("chat_stop", chat_stop);
    for (name, fix) in MOVED {
        let fix = *fix;
        tools.add::<Value, Value, _, _>(name, move |_hub: Arc<Hub>, _caller, _input| async move {
            Err(ToolError::new(
                ErrorCode::Invalid,
                format!("{name} moved to the project chat."),
            )
            .with_fix(fix))
        });
    }
}

async fn chat_send(
    hub: Arc<Hub>,
    caller: Caller,
    input: ChatSendInput,
) -> Result<ChatSendOutput, ToolError> {
    flow::send(&hub, &caller, input).await
}

async fn chat_history(
    hub: Arc<Hub>,
    caller: Caller,
    input: ChatHistoryInput,
) -> Result<ChatHistoryOutput, ToolError> {
    let r = input.project_ref.clone();
    require(&caller, Role::Read, Some(&r.machine_id))?;
    let internal = |e| {
        tracing::error!(error = %e, "chat_history");
        crate::hub::api::internal_error()
    };
    if hub.store.project_get(&r).map_err(internal)?.is_some() {
        flow::ensure(&hub, &r).await.map_err(internal)?;
    }
    let (messages, more_before, more_after) = hub
        .chat
        .page(
            &r,
            input.before.map(|s| s.get()),
            input.after.map(|s| s.get()),
            input.limit.get() as usize,
        )
        .map_err(internal)?;
    let state = flow::state(&hub, &r).map_err(internal)?;
    Ok(ChatHistoryOutput {
        messages: List::unchecked(messages),
        more_before,
        more_after,
        state,
        next: None,
        truncated: None,
    })
}

async fn project_stop(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectStopInput,
) -> Result<ProjectStopOutput, ToolError> {
    flow::project_stop(&hub, &caller, input).await
}

/// The key is checked before the input, so the app's probe with `{}` tells "you may stop" (invalid input) from "you
/// may not" (forbidden).
async fn chat_stop(hub: Arc<Hub>, caller: Caller, input: Value) -> Result<Value, ToolError> {
    crate::hub::orders::notes::require_human(&caller, "chat_stop")?;
    let input: ChatStopInput = serde_json::from_value(input)
        .map_err(|e| ToolError::new(ErrorCode::Invalid, e.to_string()))?;
    let output = flow::chat_stop(&hub, &caller, input).await?;
    serde_json::to_value(output)
        .map_err(|e| ToolError::from(crate::hub::store::StoreError::from(e)))
}

/// Registers `workstream_open`: a lead opens its own workstream for work it took from the chat, as a draft it then
/// freezes with `brief`. No intent wake: the lead that opens it already knows.
pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Failed, "The hub is shutting down.")
                })?;
                let LeadCall::WorkstreamOpen(open) = call else {
                    return Err(McpToolError::new(
                        ErrorCode::Invalid,
                        "Not a workstream_open call.",
                    ));
                };
                let outcome = hub
                    .leads
                    .workstreams
                    .open(IntakeInput {
                        project_ref: caller.project_ref.clone(),
                        text: open.text.to_string(),
                        client_request_id: request_id(),
                        channel: IntakeChannel::Lead,
                        by: caller.by.clone(),
                        template: open.template,
                    })
                    .map_err(McpToolError::from)?;
                Ok(LeadCallResult::WorkstreamOpen(WorkstreamOpenResult {
                    next: Some(format!(
                        "{} is a draft: freeze its brief with `brief`, then spawn its agents.",
                        outcome.workstream_id
                    )),
                    workstream_id: outcome.workstream_id,
                    playbook: outcome.playbook,
                }))
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    calls.register("workstream_open", handler);
    // fleetd_status (and so the app's snapshot) carries each readable project's chat state.
    hub.executors.hooks.extend_status(Arc::new(|hub, caller| {
        Box::pin(async move {
            let chats: Vec<_> = flow::states(&hub)
                .into_iter()
                .filter(|s| {
                    crate::hub::api::allows(&caller, Role::Read, Some(&s.project_ref.machine_id))
                })
                .collect();
            let mut out = serde_json::Map::new();
            out.insert(
                "chats".into(),
                serde_json::to_value(chats).unwrap_or_default(),
            );
            Ok(out)
        })
    }));
}

/// Each call opens a new workstream: a fresh key, never deduped.
fn request_id() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
