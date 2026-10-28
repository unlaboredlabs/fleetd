//! The M1 read tools. `events_wait` and `events_list` need only the event log; the others need the executor area, which registers
//! the real handlers (replacing these stubs) from its own module.
use super::Hub;
use super::grants::{can_read, require};
use super::registry::{Caller, Registry, ToolError};
use crate::hub::store::{WaitInput, now_ms};
use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{EventsListInput, EventsListOutput, EventsWaitInput};
use fleetd_contracts::prim::List;
use serde_json::{Value, json};
use std::sync::Arc;

pub fn register(tools: &mut Registry) {
    tools.add("events_wait", events_wait);
    tools.add("events_list", events_list);
}

/// One project's events, newest first, a page back from `before`. Read on the project's machine; the hub's own events
/// (`hubWide`) any key reads, as in `events_wait`.
async fn events_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: EventsListInput,
) -> Result<EventsListOutput, ToolError> {
    let r = &input.project_ref;
    require(&caller, Role::Read, Some(&r.machine_id))?;
    let (events, more) = hub.events.project_page(
        r,
        input.before.map(|s| s.get()),
        input.types.as_deref(),
        input.hub_wide == Some(true),
        input.limit.get() as usize,
    )?;
    Ok(EventsListOutput {
        events: List::unchecked(events),
        more,
        next: None,
        truncated: None,
    })
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
    // Another person's Navi's events are theirs alone (D215).
    let navis = crate::hub::navi::owner::others(&hub.db, &caller)?;
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
            .filter(|e| can_read(&caller, e) && !crate::hub::navi::owner::about(&navis, e))
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
