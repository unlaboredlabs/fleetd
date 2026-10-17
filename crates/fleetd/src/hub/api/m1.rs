//! The M1 read tools. `events_wait` needs only the event log; the others need the executor area, which registers
//! the real handlers (replacing these stubs) from its own module.
use super::Hub;
use super::grants::{can_read, require};
use super::registry::{Caller, Registry, ToolError};
use crate::hub::store::{WaitInput, now_ms};
use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::EventsWaitInput;
use serde_json::{Value, json};
use std::sync::Arc;

pub fn register(tools: &mut Registry) {
    tools.add("events_wait", events_wait);
}

/// Returns at once if visible events exist after `cursor`, otherwise long-polls to `timeoutSec`, waiting through
/// events on machines this key can't see.
async fn events_wait(
    hub: Arc<Hub>,
    caller: Caller,
    input: EventsWaitInput,
) -> Result<Value, ToolError> {
    if let Some(machine_id) = &input.machine_id {
        require(&caller, Role::Read, Some(machine_id))?;
    }
    let mut cursor = input.cursor.map_or_else(|| hub.events.head(), |c| c.get());
    let deadline = now_ms(hub.clock.as_ref()) + input.timeout_sec.get() * 1000;
    loop {
        let remaining = ((deadline - now_ms(hub.clock.as_ref())).max(0) as u64).div_ceil(1000);
        let page = hub
            .events
            .wait(WaitInput {
                cursor: Some(cursor),
                types: input.types.clone(),
                machine_id: input.machine_id.clone(),
                timeout_sec: remaining,
            })
            .await?;
        cursor = cursor.max(page.cursor);
        let total = page.events.len();
        let visible: Vec<_> = page
            .events
            .into_iter()
            .filter(|e| can_read(&caller, e))
            .collect();
        if !visible.is_empty() || total == 0 || (remaining == 0 && !page.more) {
            let next = if page.more {
                format!("More events are ready: call events_wait with cursor {cursor} now.")
            } else {
                format!("Call events_wait with cursor {cursor} to keep waiting.")
            };
            return Ok(
                json!({ "events": visible, "cursor": cursor, "more": page.more, "next": next }),
            );
        }
    }
}
