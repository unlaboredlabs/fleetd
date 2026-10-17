//! What tasks call in areas that land after them (or whose APIs are still moving). Those areas implement these
//! traits and `hub/serve` passes them in, so the tasks area depends on behaviour, not on their structs.
use std::future::Future;
use std::pin::Pin;

use fleetd_contracts::events::HubEvent;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef};
use fleetd_contracts::ledger::{Workstream, WorkstreamId};
use fleetd_contracts::tasks::{TaskId, TaskResult};
use fleetd_contracts::usage::UsageParked;

use super::resolve::ModelEffort;
use super::{SpawnInput, TaskCaller};
use crate::hub::leads::LeadError;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// M6 value bar (valuebar area): serves, done workstreams and review rounds. Called before the spawn takes the
/// tasks lock, since it may ask GitHub for a PR head. TS: ValueBar.checkSpawn.
pub trait SpawnCheck: Send + Sync {
    fn check_spawn<'a>(
        &'a self,
        caller: &'a TaskCaller,
        input: &'a SpawnInput,
        workstream: &'a Workstream,
    ) -> BoxFut<'a, Result<(), LeadError>>;
}

/// M6 receipts (receipts area): what the thread actually ran, counted from its items, added to the result.
/// TS: Receipts.attach.
pub trait ResultReceipts: Send + Sync {
    fn attach<'a>(&'a self, thread: &'a ThreadRef, result: TaskResult) -> BoxFut<'a, TaskResult>;
}

/// The lead wake a task triggers. TS: LeadWakes Trigger kinds `task_result` and `task_waiting`.
#[derive(Clone, Debug)]
pub enum TaskWake {
    Result {
        task_id: TaskId,
        title: String,
        result: TaskResult,
    },
    Waiting {
        task_id: TaskId,
        title: String,
        question: String,
    },
}

/// What tasks read and trigger in the leads area (LeadRecords, LeadWakes).
pub trait TaskLeads: Send + Sync {
    fn workstream(&self, workstream_id: &WorkstreamId) -> Option<Workstream>;
    /// The project's lead settings (model, effort), if any were set.
    fn project_settings(&self, project_ref: &ProjectRef) -> Option<ModelEffort>;
    /// Queues a trigger; LeadWakes debounces it into one wake.
    fn wake(&self, project_ref: &ProjectRef, wake: TaskWake);
}

/// M4 usage (usage area).
pub trait UsageGate: Send + Sync {
    /// Why a new turn may not start on the machine now, as a queued reason ("usage: paused until …").
    fn gate(&self, machine_id: &MachineId) -> Option<String>;
    /// The parking a `thread.usage_limited` event describes. TS: usage/classify.ts parkedOf.
    fn parked_of(&self, event: &HubEvent) -> Option<UsageParked>;
}
