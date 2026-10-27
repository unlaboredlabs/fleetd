//! A Navi's integrations: Google (Gmail, Calendar and Drive through fleetd's own server, hub/google), Notion and any
//! other MCP server, each one of the project's MCP servers marked with what it is (`McpServer.integration`). Notion and
//! custom servers connect and revoke with `mcp_server_set` and `mcp_server_remove`, Google with `google_connect` and
//! `google_disconnect`: the key or token is sealed on Navi's machine and the hub keeps none of it.
//!
//! The gate is here, outside the model: [`policy::verdict`] answers each of a session's permission prompts for an MCP
//! tool from a per-tool table. A read runs unasked; a write, send, delete, share or spend asks the person every time
//! with a [`ToolPreview`](fleetd_contracts::integrations::ToolPreview) of exactly who it reaches and what it says; moving
//! money, trading, creating accounts, and sending what looks like a credential are refused even if approved.
//! [`policy::launch_rules`] lists the read tools for a session's `--allowedTools`, so claude doesn't ask for them.
//!
//! Each integration's table is one small module: [`google`] for fleetd's own Google server, [`notion`] for the official
//! Notion server.
pub mod google;
pub mod notion;
pub mod policy;

use fleetd_contracts::ids::ProjectRef;
use rusqlite::{OptionalExtension, params};

use crate::hub::store::{HubDb, StoreError};

/// The project kind of a Navi (`ProjectSummary.kind`).
pub const ASSISTANT: &str = "assistant";

/// Whether the project is a Navi. Integrations connect only to one: its lead asks before anything but a read, where a
/// coding project's lead runs with full access and would send unasked.
pub fn is_navi(db: &HubDb, r: &ProjectRef) -> Result<bool, StoreError> {
    let kind: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT json_extract(data, '$.kind') FROM projects WHERE machine_id = ? AND project_id = ?",
            params![r.machine_id.as_str(), r.project_id.as_str()],
            |row| row.get(0),
        )
        .optional()?
        .flatten())
    })?;
    Ok(kind.as_deref() == Some(ASSISTANT))
}

#[cfg(test)]
mod tests;
