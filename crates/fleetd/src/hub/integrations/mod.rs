//! A Navi's integrations: Google (Gmail, Calendar and Drive through the person's own xaq), Notion and any other MCP
//! server, each one of the project's MCP servers marked with what it is (`McpServer.integration`). Connecting and
//! revoking are `mcp_server_set` and `mcp_server_remove`: the key or token is sealed in the app to Navi's machine and
//! the hub keeps its fingerprint only.
//!
//! The gate is here, outside the model: [`policy::verdict`] answers each of a session's permission prompts for an MCP
//! tool from a per-tool table. A read runs unasked; a write, send, delete, share or spend asks the person every time
//! with a [`ToolPreview`](fleetd_contracts::integrations::ToolPreview) of exactly who it reaches and what it says; moving
//! money, trading, creating accounts, and sending what looks like a credential are refused even if approved.
//! [`policy::launch_rules`] lists the read tools for a session's `--allowedTools`, so claude doesn't ask for them.
//!
//! Each integration's table is one small module: [`google`] is the xaq adapter (a fleetd-native Google connection could
//! replace that one file), [`notion`] the official Notion server's.
pub mod google;
pub mod notion;
pub mod policy;

#[cfg(test)]
mod tests;
