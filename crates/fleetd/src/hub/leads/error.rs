//! A refusal in the `{ code, message, fix }` shape of McpToolError, for MCP tools and lead-side calls alike.
use fleetd_contracts::mcp::{ErrorCode, McpToolError};

use crate::hub::executor::ExecutorError;
use crate::hub::link::LeadCallRefused;
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
        Self { code, message: message.into(), fix: Some(fix.into()) }
    }

    pub fn bare(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), fix: None }
    }

    pub fn not_found(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message, fix)
    }

    pub fn invalid(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message, fix)
    }

    pub fn no_project(r: &fleetd_contracts::ids::ProjectRef) -> Self {
        Self::not_found(
            format!("No project {} on machine {}.", r.project_id, r.machine_id),
            "Call projects_list for the known projects.",
        )
    }
}

impl From<ExecutorError> for LeadError {
    fn from(error: ExecutorError) -> Self {
        match error {
            ExecutorError::MachineNotConnected { machine_id } => LeadError::new(
                ErrorCode::MachineOffline,
                format!("Machine {machine_id} has no live T3 connection."),
                "Wait for the machine to come back online (fleetd_status shows it), then retry.",
            ),
            other => LeadError::new(
                ErrorCode::T3Error,
                other.to_string(),
                "Retry; if it keeps failing, check the machine's T3 with fleetd_status.",
            ),
        }
    }
}

/// The TS hub died on a database failure; here it refuses the one call instead.
impl From<StoreError> for LeadError {
    fn from(error: StoreError) -> Self {
        tracing::error!(%error, "hub database failure in leads");
        LeadError::bare(ErrorCode::Invalid, format!("The hub's database failed: {error}"))
    }
}

impl From<LeadError> for LeadCallRefused {
    fn from(e: LeadError) -> Self {
        LeadCallRefused { code: crate::hub::leads::digest::serde_plain(&e.code), message: e.message, fix: e.fix }
    }
}

impl From<LeadError> for McpToolError {
    fn from(e: LeadError) -> Self {
        McpToolError { code: e.code, message: e.message, fix: e.fix }
    }
}
