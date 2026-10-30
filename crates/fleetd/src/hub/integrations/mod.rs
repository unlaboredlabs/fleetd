//! A Navi's integrations: its project's MCP servers, connected and revoked with `mcp_server_set` and
//! `mcp_server_remove`: a key or token is sealed on Navi's machine and the hub keeps none of it.
//!
//! The gate is here, outside the model: [`policy::verdict`] answers each of a session's permission prompts for an MCP
//! tool. A tool the person marked as reading runs unasked; anything else asks the person every time with a
//! [`ToolPreview`](fleetd_contracts::integrations::ToolPreview) of its whole input; moving money, trading, creating
//! accounts, and sending what looks like a credential are refused even if approved. [`policy::launch_rules`] lists the
//! read tools for a session's `--allowedTools`, so claude doesn't ask for them.
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
