//! A refusal in the `{ code, message, fix }` shape of McpToolError, for MCP tools and lead-side calls alike.
use fleetd_contracts::mcp::{ErrorCode, McpToolError};

use crate::hub::store::StoreError;

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct LeadError {
    pub code: ErrorCode,
    pub message: String,
    pub fix: Option<String>,
}

impl LeadError {
    pub fn new(code: ErrorCode, message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            fix: Some(fix.into()),
        }
    }

    pub fn bare(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            fix: None,
        }
    }

    pub fn not_found(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message, fix)
    }

    pub fn invalid(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message, fix)
    }

    /// The executor could not reach the machine.
    pub fn machine_offline(machine_id: &fleetd_contracts::ids::MachineId) -> Self {
        Self::new(
            ErrorCode::MachineOffline,
            format!("Machine {machine_id} has no live T3 connection."),
            "Wait for the machine to come back online (fleetd_status shows it), then retry.",
        )
    }

    /// Any other executor failure.
    pub fn t3_error(message: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::T3Error,
            message,
            "Retry; if it keeps failing, check the machine's T3 with fleetd_status.",
        )
    }

    pub fn no_project(r: &fleetd_contracts::ids::ProjectRef) -> Self {
        Self::not_found(
            format!("No project {} on machine {}.", r.project_id, r.machine_id),
            "Call projects_list for the known projects.",
        )
    }
}

/// A database failure refuses the one call, as the framework does for tools.
impl From<StoreError> for LeadError {
    fn from(error: StoreError) -> Self {
        tracing::error!(%error, "hub database failure in leads");
        LeadError::bare(ErrorCode::T3Error, "The hub failed to answer that request.")
    }
}

impl From<serde_json::Error> for LeadError {
    fn from(e: serde_json::Error) -> Self {
        LeadError::bare(ErrorCode::Invalid, format!("Invalid JSON: {e}"))
    }
}

/// Also the lead-call refusal: `link::LeadCallRefused` is `McpToolError`.
impl From<LeadError> for McpToolError {
    fn from(e: LeadError) -> Self {
        McpToolError {
            code: e.code,
            message: e.message,
            fix: e.fix,
        }
    }
}
