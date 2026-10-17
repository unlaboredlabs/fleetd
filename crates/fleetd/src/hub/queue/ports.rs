//! What the wakes, queue and webhooks areas take from areas that have not landed yet, as narrow traits shaped like
//! their draft APIs: the executor's writes (#54) and usage's holds (#63). Each owning area implements its trait for
//! its service in a few lines; until then the hub runs with `Offline` and `NoHold`.
use std::future::Future;
use std::pin::Pin;

use fleetd_contracts::auth::{AgentKeyInfo, Role};
use fleetd_contracts::ids::{MachineId, ThreadId, ThreadRef};
use rusqlite::Connection;

use crate::hub::store::{EventLog, HubDb, NewEvent};

pub use crate::hub::store::now_ms;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `HubDb::with` for these areas' own queries. A failed query is a defect here, as in the TS hub.
pub trait DbRun {
    fn run<R>(&self, f: impl FnOnce(&Connection) -> R) -> R;
}

impl DbRun for HubDb {
    fn run<R>(&self, f: impl FnOnce(&Connection) -> R) -> R {
        let mut out = None;
        self.with(|conn| {
            out = Some(f(conn));
            Ok(())
        })
        .expect("hub db");
        out.expect("ran")
    }
}

/// Appends, logging instead of failing: a lost event must not stop delivery.
pub fn emit(events: &EventLog, event: NewEvent) {
    if let Err(error) = events.append(event) {
        tracing::error!(error = %error, "event append failed");
    }
}

/// executor: `ExecutorError`.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ExecutorError {
    #[error("machine {machine_id} has no live T3 connection")]
    MachineNotConnected { machine_id: MachineId },
    #[error("thread {thread_id} is not known on machine {machine_id}")]
    ThreadNotFound {
        machine_id: MachineId,
        thread_id: ThreadId,
    },
    #[error("T3 on {machine_id} refused or failed the {operation} request")]
    T3RequestFailed {
        machine_id: MachineId,
        operation: &'static str,
    },
}

impl ExecutorError {
    /// The TS error tag, as event data carries it.
    pub fn tag(&self) -> &'static str {
        match self {
            Self::MachineNotConnected { .. } => "MachineNotConnected",
            Self::ThreadNotFound { .. } => "ThreadNotFound",
            Self::T3RequestFailed { .. } => "T3RequestFailed",
        }
    }
}

// PORT: executor (#54) implements this for `Executors`.
/// executor: `Executors::{is_connected, await_live, send}`.
pub trait ThreadWriter: Send + Sync {
    fn is_connected(&self, machine_id: &MachineId) -> bool;
    /// Returns once the machine has a live T3 connection, at once if it has one now.
    fn await_live(&self, machine_id: &MachineId) -> BoxFuture<'_, ()>;
    /// Ok carries T3's run id, when it reported one.
    fn send(
        &self,
        target: &ThreadRef,
        message: &str,
        client_request_id: &str,
    ) -> BoxFuture<'_, Result<Option<String>, ExecutorError>>;
}

/// Until the executor lands: no machine is connected, so every write waits in the queue.
pub struct Offline;

impl ThreadWriter for Offline {
    fn is_connected(&self, _: &MachineId) -> bool {
        false
    }
    fn await_live(&self, _: &MachineId) -> BoxFuture<'_, ()> {
        Box::pin(std::future::pending())
    }
    fn send(
        &self,
        target: &ThreadRef,
        _: &str,
        _: &str,
    ) -> BoxFuture<'_, Result<Option<String>, ExecutorError>> {
        let machine_id = target.machine_id.clone();
        Box::pin(async move { Err(ExecutorError::MachineNotConnected { machine_id }) })
    }
}

// PORT: usage (#63) implements this for its service.
/// usage: the hold a paused login or parked thread puts on new turns (TS Usage.hold/whenClear).
pub trait UsageHold: Send + Sync {
    fn hold(&self, target: &ThreadRef) -> BoxFuture<'_, Option<String>>;
    /// Returns once `hold` is clear for the thread.
    fn when_clear(&self, target: &ThreadRef) -> BoxFuture<'_, ()>;
}

/// Until usage lands: nothing is ever held.
pub struct NoHold;

impl UsageHold for NoHold {
    fn hold(&self, _: &ThreadRef) -> BoxFuture<'_, Option<String>> {
        Box::pin(async { None })
    }
    fn when_clear(&self, _: &ThreadRef) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

pub fn is_admin(info: &AgentKeyInfo) -> bool {
    info.grants.iter().any(|g| g.role == Role::Admin)
}
