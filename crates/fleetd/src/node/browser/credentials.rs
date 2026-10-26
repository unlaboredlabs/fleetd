//! Credential sessions: everything about filling logins lives here, behind three seams the rest of the broker calls.
//! - [`fill_credential`]: the broker's entry point for an agent's `fill_credential`.
//! - [`refusal`]: the proxy asks it, for each of the driver's commands, whether a session that filled a credential
//!   refuses it.
//! - [`outgoing`]: the proxy passes each message for the driver through it.
//!
//! Filling isn't available yet: no session fills, so none is sealed and both hooks let everything through.
use std::sync::Arc;

use fleetd_contracts::browser::{BrowserCallResult, FillCredentialCall};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use serde_json::Value;

use super::Broker;
use super::session::Session;

/// An agent's `fill_credential` in its live session.
pub async fn fill_credential(
    _broker: &Arc<Broker>,
    _thread: &str,
    _call: FillCredentialCall,
) -> Result<BrowserCallResult, McpToolError> {
    Err(McpToolError::new(
        ErrorCode::Invalid,
        "fill_credential is not available on this machine yet.",
    )
    .with_fix("do without it and say so in your result"))
}

/// Why the session refuses the driver's `method`, once it filled a credential; None lets it through.
pub fn refusal(_session: &Session, _method: &str, _params: &Value) -> Option<String> {
    None
}

/// A message from the browser on its way to the driver, as the session lets it go.
pub fn outgoing(_session: &Session, message: Value) -> Value {
    message
}
