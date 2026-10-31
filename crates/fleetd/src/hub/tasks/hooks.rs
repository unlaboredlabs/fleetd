//! What tasks call in the usage area, which lands after them: `hub/serve` (`wire::wire`) sets it once in
//! [`super::TaskHooks`].
use fleetd_contracts::events::HubEvent;
use fleetd_contracts::usage::UsageParked;

use crate::hub::usage::Usage;

/// The parking a `thread.usage_limited` event describes, as usage keeps it.
pub fn parked_of(usage: &Usage, event: &HubEvent) -> Option<UsageParked> {
    // Usage keeps its own copy of the event's wire shape.
    let event: HubEvent = serde_json::from_value(serde_json::to_value(event).ok()?).ok()?;
    let mut parked = crate::hub::usage::classify::parked_of(&event)?;
    // The usage layer's own park of it, once applied, also knows when it tries a limit with no reset again.
    let thread = crate::hub::usage::ports::ThreadRef {
        machine_id: event.machine_id.as_ref()?.to_string(),
        thread_id: event.thread_id.as_ref()?.to_string(),
    };
    if let Some(own) = usage.parked_of(&thread).filter(|p| p.since == parked.since) {
        parked.check_at = own.check_at;
    }
    serde_json::to_value(parked)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
}
