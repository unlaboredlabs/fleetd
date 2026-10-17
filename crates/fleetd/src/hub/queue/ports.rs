//! What the wakes, queue and webhooks areas take from other areas, as narrow traits: the executor's writes and
//! usage's holds (implemented for `Usage` in `usage::wire`).
use std::future::Future;
use std::pin::Pin;

use fleetd_contracts::auth::{AgentKeyInfo, Role};
use fleetd_contracts::ids::{MachineId, ThreadId, ThreadRef};
use rusqlite::Connection;

use crate::hub::executor;
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

impl From<executor::ExecutorError> for ExecutorError {
    fn from(error: executor::ExecutorError) -> Self {
        match error {
            executor::ExecutorError::MachineNotConnected { machine_id } => {
                Self::MachineNotConnected { machine_id }
            }
            executor::ExecutorError::ThreadNotFound {
                machine_id,
                thread_id,
            } => Self::ThreadNotFound {
                machine_id,
                thread_id,
            },
            executor::ExecutorError::T3RequestFailed {
                machine_id,
                operation,
                cause,
            } => {
                tracing::warn!(machine_id = %machine_id, cause = %cause, "T3 {} request failed", operation.as_str());
                Self::T3RequestFailed {
                    machine_id,
                    operation: operation.as_str(),
                }
            }
        }
    }
}

impl From<ExecutorError> for executor::ExecutorError {
    fn from(error: ExecutorError) -> Self {
        match error {
            ExecutorError::MachineNotConnected { machine_id } => {
                Self::MachineNotConnected { machine_id }
            }
            ExecutorError::ThreadNotFound {
                machine_id,
                thread_id,
            } => Self::ThreadNotFound {
                machine_id,
                thread_id,
            },
            // The queue only sends, so the operation is always a send.
            ExecutorError::T3RequestFailed { machine_id, .. } => Self::T3RequestFailed {
                machine_id,
                operation: executor::T3Operation::Send,
                cause: String::new(),
            },
        }
    }
}

impl ThreadWriter for executor::Executors {
    fn is_connected(&self, machine_id: &MachineId) -> bool {
        executor::Executors::is_connected(self, machine_id)
    }
    fn await_live(&self, machine_id: &MachineId) -> BoxFuture<'_, ()> {
        let machine_id = machine_id.clone();
        Box::pin(async move { executor::Executors::await_live(self, &machine_id).await })
    }
    fn send(
        &self,
        target: &ThreadRef,
        message: &str,
        client_request_id: &str,
    ) -> BoxFuture<'_, Result<Option<String>, ExecutorError>> {
        let (target, message, id) = (
            target.clone(),
            message.to_owned(),
            client_request_id.to_owned(),
        );
        Box::pin(async move {
            executor::Executors::send(self, &target, &message, &id)
                .await
                .map(|sent| sent.run_id)
                .map_err(Into::into)
        })
    }
}

/// `thread_send` goes through the queue, as TS FleetApi's `writes.send`.
pub struct QueueWriter(pub std::sync::Arc<super::WriteQueue>);

impl executor::OfflineWriter for QueueWriter {
    fn send<'a>(
        &'a self,
        thread_ref: &'a ThreadRef,
        message: &'a str,
        client_request_id: &'a str,
    ) -> BoxFuture<'a, Result<executor::WriteOutcome, executor::ExecutorError>> {
        Box::pin(async move {
            self.0
                .send(thread_ref, message, client_request_id, None)
                .await
                .map(|sent| executor::WriteOutcome {
                    run_id: sent.run_id,
                    queued: sent.queued,
                    queued_until: sent.queued_until,
                })
                .map_err(Into::into)
        })
    }
}

/// usage: the hold a paused login or parked thread puts on new turns (TS Usage.hold/whenClear).
pub trait UsageHold: Send + Sync {
    fn hold(&self, target: &ThreadRef) -> BoxFuture<'_, Option<String>>;
    /// Returns once `hold` is clear for the thread.
    fn when_clear(&self, target: &ThreadRef) -> BoxFuture<'_, ()>;
}

/// Nothing is ever held (tests).
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
