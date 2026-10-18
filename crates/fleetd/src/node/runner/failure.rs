//! Classifies a failed run from what claude said, structured fields first and text second. The text rules are the
//! hub's `executor/limit.rs` ones (gateway texts included), moved here so the node decides once.
use fleetd_contracts::sessions::RunFailure;

use super::{ExitInfo, RateLimit};

/// What claude left behind for one failed run.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FailureEvidence {
    /// The synthetic assistant message's `error`: authentication_failed, rate_limit, overloaded, server_error, ….
    pub assistant_error: Option<String>,
    pub api_error_status: Option<u16>,
    /// The result text, else the assistant error text.
    pub text: String,
    pub terminal_reason: Option<String>,
    /// The latest `rate_limit_event` of the session.
    pub rate_limit: Option<RateLimit>,
    /// Set when the process ended without a result.
    pub exit: Option<ExitInfo>,
    /// Epoch ms, for relative resets ("reset after 1h2m").
    pub now_ms: u64,
}

/// `None` when the evidence shows no failure (a clean result).
pub fn classify(_evidence: &FailureEvidence) -> Option<RunFailure> {
    todo!("runner failure and version slice")
}

/// The node's own bounded retry for Overloaded and Network, after claude's internal retries gave up: the delay
/// before retry `attempt` (1-based), or `None` once the run should fail loudly.
pub fn retry_delay_ms(_attempt: u32) -> Option<u64> {
    todo!("runner failure and version slice")
}
