//! What the wakes and queue areas take from other areas, as narrow traits: the executor's writes and
//! usage's holds (implemented for `Usage` in `usage::wire`).
use std::future::Future;
use std::pin::Pin;

use fleetd_contracts::auth::{AgentKeyInfo, Role};
use fleetd_contracts::ids::{MachineId, ThreadId, ThreadRef};
use fleetd_contracts::sessions::SendMode;
use fleetd_contracts::steer::SteerId;
use rusqlite::Connection;

use crate::hub::executor;
use crate::hub::store::{EventLog, HubDb, NewEvent};

pub use crate::hub::store::now_ms;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `HubDb::with` for these areas' own queries. A failed query is a defect here.
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
    #[error("machine {machine_id} has no live node link")]
    MachineNotConnected { machine_id: MachineId },
    #[error("thread {thread_id} is not known on machine {machine_id}")]
    ThreadNotFound {
        machine_id: MachineId,
        thread_id: ThreadId,
    },
    /// `message` and `fix` are the node's own words (claude not logged in, and the command that logs it in).
    #[error("the node on {machine_id} refused or failed the {operation} request: {message}")]
    NodeRequestFailed {
        machine_id: MachineId,
        operation: &'static str,
        message: String,
        fix: Option<String>,
    },
}

/// How a write reaches a running thread: plain (wakes, nudges), or as a steer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SendOpts {
    pub mode: SendMode,
    pub steer: Option<SteerId>,
    /// Older steers the same message carries; each gets its own receipts.
    pub riders: Vec<SteerId>,
}

/// A message the node took.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sent {
    pub run_id: Option<String>,
    /// It waits behind the thread's active run.
    pub behind_run: bool,
}

impl ExecutorError {
    /// The error tag, as event data carries it.
    pub fn tag(&self) -> &'static str {
        match self {
            Self::MachineNotConnected { .. } => "MachineNotConnected",
            Self::ThreadNotFound { .. } => "ThreadNotFound",
            Self::NodeRequestFailed { .. } => "NodeRequestFailed",
        }
    }
}

/// executor: `Executors::{is_connected, await_live, send}`.
pub trait ThreadWriter: Send + Sync {
    fn is_connected(&self, machine_id: &MachineId) -> bool;
    /// Returns once the machine takes writes (its link is live and it is online), at once if it does now.
    fn await_live(&self, machine_id: &MachineId) -> BoxFuture<'_, ()>;
    fn send(
        &self,
        target: &ThreadRef,
        message: &str,
        client_request_id: &str,
    ) -> BoxFuture<'_, Result<Sent, ExecutorError>>;
    /// `send` with a mode; writers that only send plainly ignore it.
    fn send_with<'a>(
        &'a self,
        target: &'a ThreadRef,
        message: &'a str,
        client_request_id: &'a str,
        _opts: &'a SendOpts,
    ) -> BoxFuture<'a, Result<Sent, ExecutorError>> {
        self.send(target, message, client_request_id)
    }
    /// Why a machine that is linked can't take a message at all (its runner is logged out or out of range), so a
    /// send fails at once with the runner's words instead of waiting as if the machine were offline.
    fn refusal(&self, _machine_id: &MachineId) -> Option<ExecutorError> {
        None
    }
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
            executor::ExecutorError::NodeRequestFailed {
                machine_id,
                operation,
                message,
                fix,
            } => {
                tracing::warn!(machine_id = %machine_id, message = %message, "node {} request failed", operation.as_str());
                Self::NodeRequestFailed {
                    machine_id,
                    operation: operation.as_str(),
                    message,
                    fix,
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
            ExecutorError::NodeRequestFailed {
                machine_id,
                message,
                fix,
                ..
            } => Self::NodeRequestFailed {
                machine_id,
                operation: executor::NodeOperation::Send,
                message,
                fix,
            },
        }
    }
}

/// The queue writes only to a machine announced online by its runner's verdict: never to a degraded one, and only
/// after `machine.online` is in the log.
impl ThreadWriter for executor::Executors {
    fn is_connected(&self, machine_id: &MachineId) -> bool {
        executor::Executors::is_ready(self, machine_id)
    }
    fn await_live(&self, machine_id: &MachineId) -> BoxFuture<'_, ()> {
        let machine_id = machine_id.clone();
        Box::pin(async move { executor::Executors::await_ready(self, &machine_id).await })
    }
    fn refusal(&self, machine_id: &MachineId) -> Option<ExecutorError> {
        // Only while linked: a machine that is away waits in the queue whatever its runner said last.
        if !executor::Executors::is_connected(self, machine_id) {
            return None;
        }
        executor::Executors::runner_refusal(self, machine_id, executor::NodeOperation::Send)
            .map(Into::into)
    }
    fn send(
        &self,
        target: &ThreadRef,
        message: &str,
        client_request_id: &str,
    ) -> BoxFuture<'_, Result<Sent, ExecutorError>> {
        let opts = SendOpts::default();
        let (target, message, id) = (
            target.clone(),
            message.to_owned(),
            client_request_id.to_owned(),
        );
        Box::pin(async move {
            executor::Executors::send_with(self, &target, &message, &id, &opts)
                .await
                .map(|sent| Sent {
                    run_id: sent.run_id,
                    behind_run: sent.queued,
                })
                .map_err(Into::into)
        })
    }
    fn send_with<'a>(
        &'a self,
        target: &'a ThreadRef,
        message: &'a str,
        client_request_id: &'a str,
        opts: &'a SendOpts,
    ) -> BoxFuture<'a, Result<Sent, ExecutorError>> {
        Box::pin(async move {
            executor::Executors::send_with(self, target, message, client_request_id, opts)
                .await
                .map(|sent| Sent {
                    run_id: sent.run_id,
                    behind_run: sent.queued,
                })
                .map_err(Into::into)
        })
    }
}

/// usage: the hold a paused login or parked thread puts on new turns.
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
