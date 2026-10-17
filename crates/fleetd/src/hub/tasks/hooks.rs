//! What tasks call in areas that land after them. Those areas implement these traits; `hub/serve` passes them in.
use std::future::Future;
use std::pin::Pin;

use fleetd_contracts::ids::ThreadRef;
use fleetd_contracts::ledger::Workstream;
use fleetd_contracts::tasks::TaskResult;

use crate::hub::leads::LeadError;

use super::{SpawnInput, TaskCaller};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// M6 value bar (valuebar area): serves, done workstreams and review rounds. Called before the spawn takes the
/// tasks lock, since it may ask GitHub for a PR head. TS: ValueBar.checkSpawn.
pub trait SpawnCheck: Send + Sync {
    fn check_spawn<'a>(&'a self, caller: &'a TaskCaller, input: &'a SpawnInput, workstream: &'a Workstream) -> BoxFut<'a, Result<(), LeadError>>;
}

/// M6 receipts (receipts area): what the thread actually ran, counted from its items, added to the result.
/// TS: Receipts.attach.
pub trait ResultReceipts: Send + Sync {
    fn attach<'a>(&'a self, thread: &'a ThreadRef, result: TaskResult) -> BoxFut<'a, TaskResult>;
}

/// Until the valuebar area lands: every spawn passes.
pub struct NoSpawnCheck;
impl SpawnCheck for NoSpawnCheck {
    fn check_spawn<'a>(&'a self, _: &'a TaskCaller, _: &'a SpawnInput, _: &'a Workstream) -> BoxFut<'a, Result<(), LeadError>> {
        Box::pin(async { Ok(()) })
    }
}

/// Until the receipts area lands: the result as is.
pub struct NoReceipts;
impl ResultReceipts for NoReceipts {
    fn attach<'a>(&'a self, _: &'a ThreadRef, result: TaskResult) -> BoxFut<'a, TaskResult> {
        Box::pin(async move { result })
    }
}
