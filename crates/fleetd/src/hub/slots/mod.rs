//! The slot board: a global cap on running turns, per-project shares, and a FIFO queue within priority.
//! A slot is held while a lead's or task's T3 thread is running, read from the executor's thread events, and
//! from a grant until that thread first runs. Threads that belong to no lead or task are not counted.
//! TS spec: apps/hub/src/slots/Slots.ts.
pub mod board;

use std::sync::Arc;

use fleetd_contracts::ids::{ProjectRef, ThreadRef};
use fleetd_contracts::tasks::{SlotState, TaskKind};

pub use board::{Grant, SlotPriority, blocker, reserved_band};

pub const DEFAULT_CAP: i64 = 40;

pub fn priority_of(kind: TaskKind) -> SlotPriority {
    match kind {
        TaskKind::Review => SlotPriority::Review,
        _ => SlotPriority::Work,
    }
}

/// The slot holder for a project's lead turns. Tasks hold under their TaskId.
pub fn lead_holder(r: &ProjectRef) -> String {
    format!("lead:{}/{}", r.machine_id.as_str(), r.project_id.as_str())
}

pub struct SlotRequest {
    /// A TaskId, or `lead_holder(project_ref)`.
    pub holder: String,
    pub project_ref: ProjectRef,
    pub priority: SlotPriority,
}

/// A listener run after a slot frees (see `Slots::on_release`).
pub type ReleaseListener = Arc<dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync>;

pub struct SlotsOptions {
    /// The cap until `cap_set` stores one.
    pub default_cap: Option<i64>,
}

pub struct CapInput {
    pub cap: Option<i64>,
    pub share: Option<(ProjectRef, i64)>,
}

pub struct Slots {/* board under a mutex, db, listeners */}

impl Slots {
    /// Loads the board, rebuilds held claims from stored thread status, and starts following thread events.
    pub async fn start(_hub: &crate::hub::api::Hub, _options: SlotsOptions) -> Arc<Self> { todo!() }
    /// Takes a slot now, or queues the request (FIFO within priority) and says why.
    pub async fn acquire(&self, _request: SlotRequest) -> Grant { todo!() }
    /// The holder's slot follows `thread` from now on.
    pub async fn bind(&self, _holder: &str, _thread: &ThreadRef) { todo!() }
    /// Drops the holder's slot or queued request, then re-evaluates the queue.
    pub async fn release(&self, _holder: &str) { todo!() }
    /// Runs `listener` after a slot frees or the cap changes; also once on registering.
    pub async fn on_release(&self, _listener: ReleaseListener) { todo!() }
    /// `cap_set`: persisted; applies at once.
    pub async fn set_cap(&self, _input: CapInput) -> SlotState { todo!() }
    pub async fn state(&self) -> SlotState { todo!() }
}
