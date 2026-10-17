//! Area leases: one writer per area within a project, from spawn until the task ends. A task takes all of its
//! areas at once or none of them, so no task ever holds some areas while waiting for others, and two tasks can
//! never deadlock on each other's areas. The hub never releases a lease on its own; one held past 4 h is flagged.
//! TS spec: apps/hub/src/leases/Leases.ts.
pub mod policy;

use std::sync::Arc;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::tasks::{AreaName, Lease, TaskId};

use crate::hub::slots::Grant;

pub use policy::{Policies, PolicySource, parse_policy};

pub const STALE_AFTER_MS: i64 = 4 * 60 * 60_000;

pub struct LeaseRequest<'a> {
    pub project_ref: &'a ProjectRef,
    pub task_id: &'a TaskId,
    pub areas: &'a [AreaName],
}

#[derive(Default)]
pub struct LeaseFilter {
    pub project_ref: Option<ProjectRef>,
    pub task_id: Option<TaskId>,
}

pub struct Leases {/* db, event log, clock */}

impl Leases {
    pub fn new(_hub: &crate::hub::api::Hub) -> Arc<Self> { todo!() }
    /// Takes every area for the task, or none; the reason names every conflict.
    pub async fn acquire(&self, _request: LeaseRequest<'_>) -> Grant { todo!() }
    /// Drops every lease the task holds and returns them.
    pub async fn release(&self, _task_id: &TaskId) -> Vec<Lease> { todo!() }
    /// Oldest first, for the digest.
    pub async fn list(&self, _filter: LeaseFilter) -> Vec<Lease> { todo!() }
    /// Emits `lease.stale` once for each lease held over 4 h; registered on the 5-min sweep. Returns how many.
    pub async fn flag_stale(&self) -> usize { todo!() }
}
