//! Steering an agent mid-run (docs/build/steering-spec.md §7): the two send modes, a receipt for every steer, and
//! the steer box on each agent. The receipt's stages are decided by the hub from claude's own frames; this module
//! only words them and keeps the newest of what it was told.

pub mod fixture;
pub mod receipts;
pub mod sheet;

use fleetd_contracts::ids::ThreadRef;
use fleetd_contracts::mcp::IntakeRef;

pub use fleetd_contracts::mcp::{SteerSendInput, SteerSendOutput, SteerWithdrawInput, SteerWithdrawOutput, SteersListInput, SteersListOutput};
pub use fleetd_contracts::steer::{DeliveredHow, Steer, SteerBy, SteerMode, SteerStage, SteerTarget};

/// The task id a steer was sent to; None for the lead.
pub fn task_of(target: &SteerTarget) -> Option<&str> {
    match target {
        SteerTarget::Task { task_id } => Some(task_id.as_str()),
        SteerTarget::Lead { .. } => None,
    }
}

/// The key decides the mode: Enter queues for the next step, ⌘Enter (or the secondary button) interrupts.
pub fn mode_for(interrupt: bool) -> SteerMode {
    if interrupt { SteerMode::Now } else { SteerMode::Queue }
}

/// A steer the app sent and the hub has not answered yet (or refused): shown where its receipt will be.
#[derive(Clone, Debug, PartialEq)]
pub struct Sending {
    pub request_id: String,
    pub target: SteerTarget,
    pub workstream_id: String,
    pub text: String,
    pub mode: SteerMode,
    pub attachments: Vec<String>,
    pub refs: Vec<IntakeRef>,
    pub at: String,
    pub error: Option<String>,
}

/// Who a steer box is aimed at.
#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub target: SteerTarget,
    /// "the lead", "T31".
    pub name: String,
    /// "lead", "implementer", "reviewer".
    pub role: String,
    pub lane_id: String,
    pub thread: Option<ThreadRef>,
}

impl Agent {
    pub fn is_lead(&self) -> bool {
        matches!(self.target, SteerTarget::Lead { .. })
    }

    /// "the lead's" / "T31's".
    pub fn possessive(&self) -> String {
        format!("{}'s", self.name)
    }
}
