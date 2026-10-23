//! What tasks call in areas that land after them (or whose APIs are still moving). Those areas implement these
//! traits and `hub/serve` passes them in, so the tasks area depends on behaviour, not on their structs.
use fleetd_contracts::events::HubEvent;
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::usage::UsageParked;

/// M4 usage (usage area).
pub trait UsageGate: Send + Sync {
    /// Why a new turn may not start on the machine now, as a queued reason ("usage: paused until …").
    fn gate(&self, machine_id: &MachineId) -> Option<String>;
    /// The parking a `thread.usage_limited` event describes.
    fn parked_of(&self, event: &HubEvent) -> Option<UsageParked>;
}
