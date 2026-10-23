//! MCP tools of the lead chat (chat_send, chat_history, chat_stop, project_stop) and the chat state in `fleetd_status`.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ChatHistoryInput, ChatHistoryOutput, ChatSendInput, ChatSendOutput, ChatStopInput, ErrorCode,
    ProjectStopInput, ProjectStopOutput,
};
use fleetd_contracts::prim::List;
use serde_json::Value;

use super::flow;
use crate::hub::api::{Caller, Hub, Registry, ToolError, require};

pub fn register(tools: &mut Registry) {
    tools.add("chat_send", chat_send);
    tools.add("chat_history", chat_history);
    tools.add("project_stop", project_stop);
    tools.add_raw("chat_stop", chat_stop);
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

pub fn extend_status(hub: &Arc<Hub>) {
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
