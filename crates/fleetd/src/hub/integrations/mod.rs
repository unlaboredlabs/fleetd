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

use crate::hub::store::{HubDb, StoreError};

/// Whether the project is a Navi, as the hub keeps it in `assistants` (what `ProjectSummary.kind` says too; the
/// project row a node reports has no kind). Integrations connect only to one: its lead asks before anything but a
/// read, where a coding project's lead runs with full access and would send unasked.
pub fn is_navi(db: &HubDb, r: &ProjectRef) -> Result<bool, StoreError> {
    db.with(|c| Ok(crate::hub::navi::store::of(c, r)?.is_some()))
}

#[cfg(test)]
mod tests;
