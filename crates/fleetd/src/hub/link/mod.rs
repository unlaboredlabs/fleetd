//! The node link server, the lead-call registry and the commands the hub runs on nodes over the links.
pub mod commands;
pub mod cwd;
pub mod lead_calls;
pub mod server;

pub use commands::{NodeActions, NodeCommandError, NodeCommands};
pub use lead_calls::{LeadCallHandler, LeadCallRefused, LeadCaller, LeadCalls};
pub use server::NodeLinkServer;

/// The node WebSocket route (`GET /node/link`): runs one node link until the socket ends.
pub async fn handle(
    hub: std::sync::Arc<crate::hub::api::Hub>,
    socket: axum::extract::ws::WebSocket,
) {
    hub.link.handle(socket).await;
}
