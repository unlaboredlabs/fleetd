//! The MCP surface: the fleet status view and the tool error shape. The static tool table lands with the rest of the
//! tool types.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::events::HubEvent;
use crate::ids::EventSeq;
use crate::model::{Machine, ProjectSummary};
use crate::prim::List;
use crate::tasks::SlotState;

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FleetStatus {
    pub machines: Vec<Machine>,
    pub projects: List<ProjectSummary, 0, 50>,
    /// Latest failed, waiting and usage-limited events, and PRs the merge train sent back to their authors.
    pub attention: List<HubEvent, 0, 10>,
    pub cursor: EventSeq,
    /// Absent until the hub runs the slot board (M5).
    pub slots: Option<SlotState>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    MachineOffline,
    NotFound,
    Forbidden,
    Invalid,
    T3Error,
}

/// Sent as an MCP tool error result whose text is this JSON.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct McpToolError {
    pub code: ErrorCode,
    pub message: String,
    /// What to do next.
    pub fix: Option<String>,
}

impl McpToolError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            fix: None,
        }
    }
    pub fn with_fix(mut self, fix: impl Into<String>) -> Self {
        self.fix = Some(fix.into());
        self
    }
}

impl std::fmt::Display for McpToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)?;
        if let Some(fix) = &self.fix {
            write!(f, " ({fix})")?;
        }
        Ok(())
    }
}

impl std::error::Error for McpToolError {}
