//! A Navi's own Google connection (contracts `google`), on the hub: the admin's OAuth client with each machine's
//! fingerprint of its secret (`google_client`), and each Navi's account address and scopes (`google_accounts`). The
//! secret and the tokens stay on the Navi's node (node/google). A Navi with an account gets the native server `google`
//! in its lead's MCP servers ([`server`]), which the integrations policy reads as Google's.
#[cfg(test)]
mod tests;
pub mod tools;

use fleetd_contracts::google::{GOOGLE_MCP_ARG, GOOGLE_SERVER, GoogleAccount, GoogleClient};
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::integrations::{IntegrationKind, McpIntegration};
use fleetd_contracts::mcp_servers::{
    McpArg, McpRoles, McpScope, McpServer, McpServerName, McpTransport,
};
use fleetd_contracts::prim::Line;
use rusqlite::{OptionalExtension, params};

use crate::hub::store::{HubDb, StoreError};

pub struct GoogleStore<'a> {
    db: &'a HubDb,
}

impl HubDb {
    pub fn google(&self) -> GoogleStore<'_> {
        GoogleStore { db: self }
    }
}

impl GoogleStore<'_> {
    pub fn client(&self) -> Result<Option<GoogleClient>, StoreError> {
        let data: Option<String> = self.db.with(|c| {
            Ok(
                c.query_row("SELECT data FROM google_client WHERE id = 1", [], |row| {
                    row.get(0)
                })
                .optional()?,
            )
        })?;
        Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
    }

    pub fn put_client(&self, client: &GoogleClient) -> Result<(), StoreError> {
        let data = serde_json::to_string(client)?;
        self.db.with(|c| {
            c.execute(
                "INSERT INTO google_client (id, data) VALUES (1, ?)
                 ON CONFLICT (id) DO UPDATE SET data = excluded.data",
                params![data],
            )?;
            Ok(())
        })
    }

    pub fn account(&self, r: &ProjectRef) -> Result<Option<GoogleAccount>, StoreError> {
        let data: Option<String> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT data FROM google_accounts WHERE machine_id = ? AND project_id = ?",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
    }

    /// Every Navi's account.
    pub fn accounts(&self) -> Result<Vec<GoogleAccount>, StoreError> {
        self.db.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT data FROM google_accounts ORDER BY machine_id, project_id",
            )?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows
                .iter()
                .filter_map(|d| serde_json::from_str(d).ok())
                .collect())
        })
    }

    /// The addresses Navis other than `r` are connected to.
    pub fn others_in_use(&self, r: &ProjectRef) -> Result<Vec<Line<1, 320>>, StoreError> {
        Ok(self
            .accounts()?
            .into_iter()
            .filter(|a| &a.project_ref != r)
            .map(|a| a.email)
            .collect())
    }

    pub fn put_account(&self, account: &GoogleAccount) -> Result<(), StoreError> {
        let r = &account.project_ref;
        let mut kept = account.clone();
        // Whether it lapsed is the node's to say, each time it is asked.
        kept.lapsed = None;
        let data = serde_json::to_string(&kept)?;
        self.db.with(|c| {
            c.execute(
                "INSERT INTO google_accounts (machine_id, project_id, data) VALUES (?, ?, ?)
                 ON CONFLICT (machine_id, project_id) DO UPDATE SET data = excluded.data",
                params![r.machine_id.as_str(), r.project_id.as_str(), data],
            )?;
            Ok(())
        })
    }

    pub fn remove_account(&self, r: &ProjectRef) -> Result<bool, StoreError> {
        self.db.with(|c| {
            Ok(c.execute(
                "DELETE FROM google_accounts WHERE machine_id = ? AND project_id = ?",
                params![r.machine_id.as_str(), r.project_id.as_str()],
            )? > 0)
        })
    }
}

/// Whether `s` is the native server [`server`] makes: named `google`, run as `fleetd google-mcp`, marked Google. Only
/// it gets Google's table in the integrations policy; any other server marked Google is a custom one.
pub fn is_native(s: &McpServer) -> bool {
    let McpTransport::Stdio { command, args } = &s.transport else {
        return false;
    };
    s.name.as_str() == GOOGLE_SERVER
        && command.as_str() == "fleetd"
        && args.len() == 1
        && args[0].as_str() == GOOGLE_MCP_ARG
        && s.integration.as_ref().map(|i| i.kind) == Some(IntegrationKind::Google)
}

/// The native server as a Navi's sessions get it: `fleetd google-mcp`, for its lead only, which its node runs with
/// its own binary and the Navi's tokens (node/mcp_servers.rs). It replaces a configured server of the same name there.
pub fn server(account: &GoogleAccount) -> McpServer {
    let r = &account.project_ref;
    McpServer {
        scope: McpScope::Project {
            machine_id: r.machine_id.clone(),
            project_id: r.project_id.clone(),
        },
        name: McpServerName::unchecked(GOOGLE_SERVER),
        enabled: true,
        roles: McpRoles {
            lead: true,
            writers: false,
            reviewers: false,
        },
        transport: McpTransport::Stdio {
            command: McpArg::unchecked("fleetd"),
            args: vec![McpArg::unchecked(GOOGLE_MCP_ARG)],
        },
        env: Vec::new(),
        headers: Vec::new(),
        updated_at: account.connected_at.clone(),
        // What the tool policy reads its tools by (hub/integrations/google.rs).
        integration: Some(McpIntegration {
            kind: IntegrationKind::Google,
            read_tools: Default::default(),
        }),
    }
}
