//! The vault (W549, fleetd-contracts vault.rs). It lives in fleetd's Bun build; this build registers its tools so a
//! rolled-back hub answers each one plainly instead of as unknown. Env vars keep working without it: the Bun hub
//! delivers them through the node's own files and keeps the `project_env` and `order_env` rows.
use fleetd_contracts::mcp::ErrorCode;
use serde_json::Value;

use crate::hub::api::{Registry, error};

pub fn register(tools: &mut Registry) {
    for name in [
        "vault_list",
        "vault_get",
        "vault_save",
        "vault_delete",
        "vault_restore",
        "vault_reveal",
        "vault_share_set",
        "vault_audit",
        "vault_status",
        "vault_unlock",
        "vault_rotate",
        "vault_import_search",
        "vault_import",
    ] {
        tools.add_raw(name, |_hub, _caller, _input: Value| async {
            Err::<Value, _>(error(
                ErrorCode::Failed,
                "The vault needs fleetd's Bun build.",
                "run `fleetd update --flavour bun`",
            ))
        });
    }
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::mcp::McpToolName;

    #[test]
    fn every_vault_tool_of_the_contracts_is_registered() {
        let tools = crate::hub::api::registry();
        for tool in McpToolName::ALL {
            if tool.as_str().starts_with("vault_") {
                assert!(tools.contains(tool.as_str()), "{}", tool.as_str());
            }
        }
    }
}
