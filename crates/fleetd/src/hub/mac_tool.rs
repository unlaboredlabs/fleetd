//! The agents' Mac, the hub's half (D298): `mac_where` names the online machine whose node lists [`CAP_MAC_TOOL`] and
//! its key, `mac_send` passes one step an agent's node sealed to it on, with who the caller is, and brings back the
//! sealed answer. The hub never opens either. Every project's agents may use the Mac; Navis never.
use std::sync::{Arc, Weak};
use std::time::Duration;

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mac::{MacCaller, MacSendCall, MacSendResult, MacWhereResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};

use crate::hub::api::Hub;
use crate::hub::link::lead_calls::{CallerAgent, LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};
use crate::hub::store::StoreError;

pub const OPS: [&str; 2] = ["mac_where", "mac_send"];

/// The longest step: a first push indexes a whole tree on the Mac. The agent's node waits a little longer
/// (node/mac_tool `SEND_WAIT`), so the hub always answers first.
pub const SEND_WAIT: Duration = Duration::from_secs(170);

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                match call {
                    LeadCall::MacWhere(_) => where_(&hub, &caller).map(LeadCallResult::MacWhere),
                    LeadCall::MacSend(call) => send(&hub, &caller, call).await,
                    other => Err(McpToolError::new(
                        ErrorCode::Invalid,
                        format!("{} is not a call for the agents' Mac.", op_of(&other)),
                    )),
                }
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

fn failed(e: StoreError) -> McpToolError {
    tracing::error!(error = %e, "agents' Mac store");
    McpToolError::new(ErrorCode::Failed, "The hub failed to answer that request.")
}

/// Who may use the Mac: an agent's session (a lead's or a task's), never a person's shell.
fn caller_of(caller: &LeadCaller) -> Result<(), McpToolError> {
    if matches!(
        caller.agent,
        CallerAgent::Person | CallerAgent::MemoryRefresh
    ) {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            "The agents' Mac is for agents' sessions, and this call comes from none.",
        ));
    }
    Ok(())
}

/// The agents' Mac and its key ([`crate::hub::machine_roles::mac_machine`]).
fn the_mac(
    hub: &Hub,
) -> Result<(MachineId, Option<fleetd_contracts::secrets::BoxPublicKey>), McpToolError> {
    let machine_id = crate::hub::machine_roles::mac_machine(hub).ok_or_else(|| {
        McpToolError::new(
            ErrorCode::MachineOffline,
            "No agents' Mac is online: none joined this hub, it's turned off, or it's waiting for its account to log in \
             again after a restart.",
        )
        .with_fix(
            "do without the Mac and say so in your result; an admin connects one in Settings › Hub › Machines",
        )
    })?;
    let key = hub
        .store
        .machine_get(&machine_id)
        .map_err(failed)?
        .and_then(|m| m.box_pub_key);
    Ok((machine_id, key))
}

fn where_(hub: &Hub, caller: &LeadCaller) -> Result<MacWhereResult, McpToolError> {
    caller_of(caller)?;
    let (machine_id, key) = the_mac(hub)?;
    let box_pub_key = key.ok_or_else(|| {
        McpToolError::new(
            ErrorCode::Failed,
            format!("{machine_id}, the agents' Mac, has no key to seal to."),
        )
        .with_fix("ask an admin to update fleetd on the Mac")
    })?;
    Ok(MacWhereResult {
        machine_id,
        box_pub_key,
    })
}

async fn send(
    hub: &Hub,
    caller: &LeadCaller,
    call: MacSendCall,
) -> Result<LeadCallResult, McpToolError> {
    caller_of(caller)?;
    let (machine_id, _) = the_mac(hub)?;
    if machine_id != call.machine_id {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!(
                "{} is not the agents' Mac any more; {machine_id} is.",
                call.machine_id
            ),
        )
        .with_fix("run the command again"));
    }
    let who = MacCaller {
        machine_id: caller.project_ref.machine_id.clone(),
        project_id: caller.project_ref.project_id.clone(),
        task_id: match &caller.agent {
            CallerAgent::Task(t) => Some(t.clone()),
            _ => None,
        },
        thread_id: call.thread_id.clone(),
    };
    let answer = hub
        .node_commands
        .mac_call(&machine_id, &who, &call.sealed, SEND_WAIT)
        .await
        .map_err(|e| {
            McpToolError::new(
                ErrorCode::MachineOffline,
                format!("{machine_id}, the agents' Mac, did not answer: {e}."),
            )
            .with_fix("try again shortly; if it keeps failing, do without the Mac and say so in your result")
        })?;
    match (answer.sealed, answer.error) {
        (Some(sealed), _) => Ok(LeadCallResult::MacSend(MacSendResult { sealed })),
        (None, Some(error)) => Err(error),
        (None, None) => Err(McpToolError::new(
            ErrorCode::Failed,
            format!("{machine_id}, the agents' Mac, sent an empty answer."),
        )),
    }
}

#[cfg(test)]
#[path = "mac_tool_tests.rs"]
mod tests;
