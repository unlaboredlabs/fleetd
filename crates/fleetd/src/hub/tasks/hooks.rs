//! What tasks call in areas that land after them (or whose APIs are still moving). Those areas implement these
//! traits and `hub/serve` passes them in, so the tasks area depends on behaviour, not on their structs.
use fleetd_contracts::events::HubEvent;
use fleetd_contracts::ids::{MachineId, ThreadRef};
use fleetd_contracts::ledger::Workstream;
use fleetd_contracts::tasks::TaskResult;
use fleetd_contracts::usage::UsageParked;

use super::ports::TaskError;
use super::{SpawnInput, TaskCaller};

pub use super::ports::BoxFut;

/// M6 value bar (valuebar area): serves, done workstreams and review rounds. Called before the spawn takes the
/// tasks lock, since it may ask GitHub for a PR head.
pub trait SpawnCheck: Send + Sync {
    fn check_spawn<'a>(
        &'a self,
        caller: &'a TaskCaller,
        input: &'a SpawnInput,
        workstream: &'a Workstream,
    ) -> BoxFut<'a, Result<(), TaskError>>;
}

/// M6 receipts (receipts area): what the thread actually ran, counted from its items, added to the result.
pub trait ResultReceipts: Send + Sync {
    fn attach<'a>(&'a self, thread: &'a ThreadRef, result: TaskResult) -> BoxFut<'a, TaskResult>;
    /// The result's receipts line for the lead wake, absent on results without receipts.
    fn line(&self, result: &TaskResult) -> Option<String>;
}

/// M4 usage (usage area).
pub trait UsageGate: Send + Sync {
    /// Why a new turn may not start on the machine now, as a queued reason ("usage: paused until …").
    fn gate(&self, machine_id: &MachineId) -> Option<String>;
    /// The parking a `thread.usage_limited` event describes.
    fn parked_of(&self, event: &HubEvent) -> Option<UsageParked>;
}
