//! The MCP servers fleetd gives its agents (Settings › Hub › Every project › Tools & skills, and each project's MCP section):
//! `mcp_servers_get`, `mcp_server_set`, `mcp_server_remove`, `mcp_settings_set` and `mcp_server_test`, and what the
//! hub keeps of them: one `mcp_servers` row per server (a global one's machine and project are empty) and
//! `mcp_settings.user_servers`.
//!
//! A secret value in a server's env or headers is sealed in the desktop app to each machine's box key; the hub relays
//! each box to its node in the same call and keeps only the fingerprint that node computed, per machine. A session's
//! launch (and a send, once they changed) carries its project's servers with each secret by name only, and the node
//! puts the value into the config it writes for claude.
#[cfg(test)]
mod tests;
pub mod tools;

use std::collections::BTreeMap;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::mcp_servers::{
    McpScope, McpSecretScope, McpServer, McpServerName, McpSessionConfig, McpSessionServer,
    McpSessionValue, McpValue,
};
use fleetd_contracts::project_settings::EnvVarKind;
use rusqlite::{OptionalExtension, params};

use crate::hub::store::{HubDb, StoreError};

/// `(machine_id, project_id)` of a scope's rows: empty for a global server.
fn scope_key(scope: &McpScope) -> (&str, &str) {
    match scope {
        McpScope::Global => ("", ""),
        McpScope::Project {
            machine_id,
            project_id,
        } => (machine_id.as_str(), project_id.as_str()),
    }
}

/// Where the node of a session keeps a server's secrets.
pub fn secret_scope(scope: &McpScope) -> McpSecretScope {
    match scope {
        McpScope::Global => McpSecretScope::Global,
        McpScope::Project { project_id, .. } => McpSecretScope::Project {
            project_id: project_id.clone(),
        },
    }
}

/// A server as a session on `machine_id` gets it: plain values as they are, a secret by name. `None` when that
/// machine's node doesn't hold all of its secrets, so it would start without them.
pub fn for_session(server: &McpServer, machine_id: &MachineId) -> Option<McpSessionServer> {
    if !server.secrets_missing_on(machine_id).is_empty() {
        return None;
    }
    let values = |list: &[McpValue]| -> Vec<McpSessionValue> {
        list.iter()
            .map(|v| match (&v.kind, &v.value) {
                (EnvVarKind::Plain, Some(value)) => McpSessionValue::Plain {
                    name: v.name.clone(),
                    value: value.clone(),
                },
                _ => McpSessionValue::Secret {
                    name: v.name.clone(),
                },
            })
            .collect()
    };
    Some(McpSessionServer {
        name: server.name.clone(),
        secrets: secret_scope(&server.scope),
        roles: server.roles,
        transport: server.transport.clone(),
        env: values(&server.env),
        headers: values(&server.headers),
    })
}

pub struct McpServerStore<'a> {
    db: &'a HubDb,
}

impl HubDb {
    pub fn mcp_servers(&self) -> McpServerStore<'_> {
        McpServerStore { db: self }
    }
}

impl McpServerStore<'_> {
    /// A scope's servers, by name.
    pub fn list(&self, scope: &McpScope) -> Result<Vec<McpServer>, StoreError> {
        let (m, p) = scope_key(scope);
        self.db.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT data FROM mcp_servers WHERE machine_id = ? AND project_id = ? ORDER BY name",
            )?;
            let rows = stmt
                .query_map(params![m, p], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows
                .iter()
                .filter_map(|data| serde_json::from_str(data).ok())
                .collect())
        })
    }

    pub fn get(
        &self,
        scope: &McpScope,
        name: &McpServerName,
    ) -> Result<Option<McpServer>, StoreError> {
        let (m, p) = scope_key(scope);
        let data: Option<String> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT data FROM mcp_servers WHERE machine_id = ? AND project_id = ? AND name = ?",
                params![m, p, name.as_str()],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
    }

    pub fn put(&self, server: &McpServer) -> Result<(), StoreError> {
        let (m, p) = scope_key(&server.scope);
        let data = serde_json::to_string(server)?;
        self.db.with(|c| {
            c.execute(
                "INSERT INTO mcp_servers (machine_id, project_id, name, data) VALUES (?, ?, ?, ?)
                 ON CONFLICT (machine_id, project_id, name) DO UPDATE SET data = excluded.data",
                params![m, p, server.name.as_str(), data],
            )?;
            Ok(())
        })
    }

    /// The secrets a node is yet to forget for a server the hub no longer has (an older hub's built-in integrations,
    /// dropped by a migration): machine, where the node keeps them, server.
    pub fn forgets(&self) -> Result<Vec<(MachineId, McpSecretScope, McpServerName)>, StoreError> {
        self.db.with(|c| {
            let mut stmt =
                c.prepare_cached("SELECT machine_id, project_id, name FROM mcp_secret_forgets")?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows
                .into_iter()
                .filter_map(|(m, p, name)| {
                    let scope = match p.as_str() {
                        "" => McpSecretScope::Global,
                        _ => McpSecretScope::Project {
                            project_id: ProjectId::new(p).ok()?,
                        },
                    };
                    Some((
                        MachineId::new(m).ok()?,
                        scope,
                        McpServerName::new(name).ok()?,
                    ))
                })
                .collect())
        })
    }

    /// The node forgot them.
    pub fn forgot(
        &self,
        machine_id: &MachineId,
        scope: &McpSecretScope,
        name: &McpServerName,
    ) -> Result<(), StoreError> {
        let project_id = match scope {
            McpSecretScope::Global => "",
            McpSecretScope::Project { project_id } => project_id.as_str(),
        };
        self.db.with(|c| {
            c.execute(
                "DELETE FROM mcp_secret_forgets WHERE machine_id = ? AND project_id = ? AND name = ?",
                params![machine_id.as_str(), project_id, name.as_str()],
            )?;
            Ok(())
        })
    }

    pub fn remove(&self, scope: &McpScope, name: &McpServerName) -> Result<bool, StoreError> {
        let (m, p) = scope_key(scope);
        self.db.with(|c| {
            Ok(c.execute(
                "DELETE FROM mcp_servers WHERE machine_id = ? AND project_id = ? AND name = ?",
                params![m, p, name.as_str()],
            )? > 0)
        })
    }

    /// Whether agents also get the person's own MCP servers: on until a person turns it off.
    pub fn user_servers(&self) -> Result<bool, StoreError> {
        let saved: Option<i64> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT value FROM mcp_settings WHERE key = 'user_servers'",
                [],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        Ok(saved.is_none_or(|v| v != 0))
    }

    pub fn set_user_servers(&self, on: bool) -> Result<(), StoreError> {
        self.db.with(|c| {
            c.execute(
                "INSERT INTO mcp_settings (key, value) VALUES ('user_servers', ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![on as i64],
            )?;
            Ok(())
        })
    }

    /// The servers a project's sessions are configured from, by name: the global ones, the project's own over them, and
    /// in a repo checkout another project holds that project's servers too, over the checkout's own; with several, the
    /// one that added it first wins a name (W79). What the hub's tool policy (`hub/integrations`) reads a session's MCP
    /// tools against.
    pub fn servers_for(&self, r: &ProjectRef) -> Result<Vec<McpServer>, StoreError> {
        let holders = self
            .db
            .with(|c| Ok(crate::hub::repos::store::holders(c, r)?))?;
        let mut by_name: BTreeMap<String, McpServer> = self
            .list(&McpScope::Global)?
            .into_iter()
            .map(|s| (s.name.to_string(), s))
            .collect();
        // Later ones replace earlier ones: the checkout's own, then its holders newest first, the oldest winning.
        for project in std::iter::once(r).chain(holders.iter().rev().map(|(p, _)| p)) {
            let servers = self.list(&McpScope::Project {
                machine_id: project.machine_id.clone(),
                project_id: project.project_id.clone(),
            })?;
            by_name.extend(servers.into_iter().map(|s| (s.name.to_string(), s)));
        }
        Ok(by_name.into_values().collect())
    }

    /// What a session of the project gets: [`Self::servers_for`]'s enabled ones (a project's server replaces a global one
    /// even while it is off, which turns that one off there). A server none of whose roles is on, or whose secrets aren't
    /// all on the project's machine, is left out.
    pub fn session_config(&self, r: &ProjectRef) -> Result<McpSessionConfig, StoreError> {
        let servers = self
            .servers_for(r)?
            .iter()
            .filter(|s| s.enabled && s.roles.any())
            .filter_map(|s| for_session(s, &r.machine_id))
            .collect();
        Ok(McpSessionConfig {
            user_servers: self.user_servers()?,
            servers,
        })
    }
}

pub fn now(hub: &crate::hub::api::Hub) -> Timestamp {
    crate::hub::checks::now_ts(hub.clock.as_ref())
}
