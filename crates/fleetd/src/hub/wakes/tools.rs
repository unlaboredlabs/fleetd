//! wake_set, wake_list and wake_cancel.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ErrorCode, McpToolError, WakeCancelInput, WakeCancelOutput, WakeListInput, WakeListOutput,
    WakeSetInput, WakeSetOutput,
};
use fleetd_contracts::prim::{NonEmpty, True};

use super::{WakeFilter, WakeSet, thread_ref};
use fleetd_contracts::ids::ThreadRef;

use crate::hub::api::{
    Caller, Hub, Registry, ToolError, cap, limits, readable, require, unknown_machine,
    unknown_thread,
};

pub fn register(tools: &mut Registry) {
    tools.add("wake_set", wake_set);
    tools.add("wake_list", wake_list);
    tools.add("wake_cancel", wake_cancel);
}

/// A write that may wait in the queue needs a target the hub has seen, since the node can't vouch for it offline.
fn require_known_thread(hub: &Hub, target: &ThreadRef) -> Result<(), ToolError> {
    if hub.store.machine_get(&target.machine_id)?.is_none() {
        return Err(unknown_machine(&target.machine_id));
    }
    if hub.store.thread_get(target)?.is_none() && !hub.queue.is_connected(&target.machine_id) {
        return Err(unknown_thread(target));
    }
    Ok(())
}

async fn wake_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: WakeSetInput,
) -> Result<WakeSetOutput, ToolError> {
    require(&caller, Role::Operate, Some(&input.target.machine_id))?;
    require_known_thread(&hub, &thread_ref(&input.target))?;
    let set = hub
        .wakes
        .set(WakeSet {
            target: input.target,
            schedule: input.schedule,
            message: input.message,
            once: input.once,
            catch_up: input.catch_up,
            client_request_id: input.client_request_id.into_inner(),
            created_by: caller.key_id.to_string(),
        })
        .map_err(|e| {
            McpToolError::new(ErrorCode::Invalid, format!("Invalid schedule: {}", e.message)).with_fix(
                "Use at (ISO time, future), every (everySec >= 60) or a 5-field cron, with an IANA tz such as Europe/London.",
            )
        })?;
    let next = format!(
        "Call events_wait with types [\"wake.fired\"] to see it fire, or wake_cancel with wakeId {}.",
        set.wake_id
    );
    Ok(WakeSetOutput {
        wake_id: NonEmpty::unchecked(set.wake_id),
        next_run_at: set.next_run_at.into(),
        next: Some(next),
        truncated: None,
    })
}

async fn wake_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: WakeListInput,
) -> Result<WakeListOutput, ToolError> {
    if let Some(m) = &input.machine_id {
        require(&caller, Role::Read, Some(m))?;
    }
    let filter = WakeFilter {
        machine_id: input.machine_id,
        thread_id: input.thread_id,
        state: input.state,
    };
    let all = hub
        .wakes
        .list(&filter)
        .into_iter()
        .filter(|w| readable(&caller, &w.target.machine_id))
        .collect();
    let shown = cap(all, limits::WAKES);
    Ok(WakeListOutput {
        wakes: shown.items,
        next: shown
            .truncated
            .map(|_| "Narrow the list with machineId, threadId or state.".to_string()),
        truncated: shown.truncated,
    })
}

async fn wake_cancel(
    hub: Arc<Hub>,
    caller: Caller,
    input: WakeCancelInput,
) -> Result<WakeCancelOutput, ToolError> {
    let Some(wake) = hub
        .wakes
        .get(&input.wake_id)
        .filter(|w| readable(&caller, &w.target.machine_id))
    else {
        return Err(
            McpToolError::new(ErrorCode::NotFound, format!("No wake {}.", input.wake_id))
                .with_fix("Call wake_list to see wakes."),
        );
    };
    require(&caller, Role::Operate, Some(&wake.target.machine_id))?;
    hub.wakes.cancel(&input.wake_id);
    Ok(WakeCancelOutput {
        ok: True,
        next: None,
        truncated: None,
    })
}
