//! MCP servers fleetd gives its agents (Settings › MCP servers in the desktop app): hub-wide ones for every project,
//! and a project's own, which replace a hub-wide one of the same name. Each is a stdio command or an HTTP or SSE URL,
//! on or off, for the roles chosen (the lead, writers, reviewers), and reaches each agent's claude through the
//! `--mcp-config` its node writes for it. fleetd's own tools server is always there and can't be replaced.
//!
//! A server's env (stdio) or headers (HTTP, SSE) may hold secrets. A secret is sealed in the desktop app to each
//! machine's box key, as a project's secret variables are: the hub relays the boxes and keeps only each node's
//! fingerprint, a session gets a secret's name, and its node puts the value into the config it writes for claude.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{MachineId, ProjectId, Timestamp};
use crate::project_settings::{EnvValue, EnvVarKind};
use crate::secrets::{SealedSecret, SecretFingerprint};

/// fleetd's own tools server (`fleetd agent-mcp`): no configured server may take its name.
pub const FLEETD_SERVER: &str = "fleetd";

/// Servers one scope (the hub, or a project) may have.
pub const MCP_SERVERS_MAX: usize = 50;

/// Values (env or headers) one server may have.
pub const MCP_VALUES_MAX: usize = 50;

brand!(
    /// A server's name, as claude shows its tools (`mcp__<name>__<tool>`): letters, digits, `_` and `-`, at most 64.
    McpServerName,
    name = "McpServerName",
    pattern = r"^[A-Za-z0-9_-]{1,64}$"
);

/// No configured server may be called `fleetd`, in any case.
pub fn mcp_name_reserved(name: &str) -> bool {
    name.eq_ignore_ascii_case(FLEETD_SERVER)
}

brand!(
    /// An env variable's or an HTTP header's name: an HTTP token, at most 128 characters. An env name is also checked
    /// as a shell name.
    McpValueName,
    name = "McpValueName",
    pattern = r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$"
);

brand!(
    /// A stdio server's command or one of its arguments: up to 4 KiB, no NUL.
    McpArg,
    name = "McpArg",
    check = |s| s.len() <= 4096 && !s.contains('\0'),
    expected = "at most 4 KiB with no NUL"
);

brand!(
    /// An http or https URL.
    McpUrl,
    name = "McpUrl",
    check = |s| s.len() <= 2048 && crate::prim::is_http_url(s),
    expected = "an http or https URL of at most 2048 characters"
);

/// Where a server is configured.
#[derive(
    Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum McpScope {
    /// Every project on every machine.
    Global,
    /// One project; replaces a global server of the same name there.
    #[serde(rename_all = "camelCase")]
    Project {
        machine_id: MachineId,
        project_id: ProjectId,
    },
}

/// Which of fleetd's agents get a server. A plain thread a person starts gets none.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpRoles {
    /// The project's lead.
    pub lead: bool,
    /// Write tasks' agents.
    pub writers: bool,
    /// Review and read tasks' agents: the ones that only read.
    pub reviewers: bool,
}

/// The role one session has among those [`McpRoles`] names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum McpAgentRole {
    Lead,
    Writer,
    Reviewer,
}

impl McpRoles {
    pub fn has(&self, role: McpAgentRole) -> bool {
        match role {
            McpAgentRole::Lead => self.lead,
            McpAgentRole::Writer => self.writers,
            McpAgentRole::Reviewer => self.reviewers,
        }
    }

    pub fn any(&self) -> bool {
        self.lead || self.writers || self.reviewers
    }
}

/// How claude reaches a server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransport {
    /// A command the agent's claude starts on the machine, in the agent's working directory, speaking MCP over its
    /// stdin and stdout. Its env adds to the agent's own.
    Stdio {
        command: McpArg,
        #[serde(default)]
        args: Vec<McpArg>,
    },
    /// MCP's streamable HTTP, with the server's headers on every request.
    Http { url: McpUrl },
    /// MCP's older HTTP with server-sent events, with the server's headers on every request.
    Sse { url: McpUrl },
}

impl McpTransport {
    pub fn is_stdio(&self) -> bool {
        matches!(self, McpTransport::Stdio { .. })
    }
}

/// The machine a secret value was sealed to, with the fingerprint its node computed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpSealedOn {
    pub machine_id: MachineId,
    pub fingerprint: SecretFingerprint,
}

/// One env variable or header as the hub keeps it: a plain one's value, or the machines a secret's node holds it on.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpValue {
    pub name: McpValueName,
    pub kind: EnvVarKind,
    /// A plain value.
    pub value: Option<EnvValue>,
    /// A secret's: each machine whose node holds it. A project server's, its machine.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sealed_on: Vec<McpSealedOn>,
}

/// One configured server as the hub keeps it. A secret has no value here.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub scope: McpScope,
    pub name: McpServerName,
    pub enabled: bool,
    pub roles: McpRoles,
    pub transport: McpTransport,
    /// A stdio server's env.
    #[serde(default)]
    pub env: Vec<McpValue>,
    /// An HTTP or SSE server's headers.
    #[serde(default)]
    pub headers: Vec<McpValue>,
    /// What it is to a Navi (Google, Notion or custom), for the hub's tool policy; none for a server added before
    /// integrations, which counts as custom.
    pub integration: Option<crate::integrations::McpIntegration>,
    pub updated_at: Timestamp,
}

impl McpServer {
    pub fn values(&self) -> impl Iterator<Item = (McpField, &McpValue)> {
        self.env
            .iter()
            .map(|v| (McpField::Env, v))
            .chain(self.headers.iter().map(|v| (McpField::Header, v)))
    }

    /// Secrets whose value the node of `machine_id` doesn't hold: the server can't start there.
    pub fn secrets_missing_on(&self, machine_id: &MachineId) -> Vec<McpValueName> {
        self.values()
            .filter(|(_, v)| {
                v.kind == EnvVarKind::Secret
                    && !v.sealed_on.iter().any(|s| &s.machine_id == machine_id)
            })
            .map(|(_, v)| v.name.clone())
            .collect()
    }
}

/// Which list of a server a value is in.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum McpField {
    Env,
    Header,
}

/// One machine's box of a secret value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpSeal {
    pub machine_id: MachineId,
    /// `crypto_box_seal` of the value to that machine's `boxPubKey`: up to 64 KiB, no NUL.
    pub sealed: SealedSecret,
}

/// One env variable or header of a server being saved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum McpValueSet {
    Plain {
        name: McpValueName,
        value: EnvValue,
    },
    /// The value sealed to each machine that runs the server: a project server's machine, or for a global one every
    /// machine the app knows a box key of.
    Secret {
        name: McpValueName,
        sealed: Vec<McpSeal>,
    },
    /// The secret already saved under this name, as it is: what editing the rest of a server sends.
    Keep {
        name: McpValueName,
    },
}

impl McpValueSet {
    pub fn name(&self) -> &McpValueName {
        match self {
            McpValueSet::Plain { name, .. }
            | McpValueSet::Secret { name, .. }
            | McpValueSet::Keep { name } => name,
        }
    }
}

/// Where a session's node keeps a server's secrets: hub-wide, or the project's.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum McpSecretScope {
    Global,
    #[serde(rename_all = "camelCase")]
    Project {
        project_id: ProjectId,
    },
}

/// Hub -> node: one secret of a server, sealed to the node's box key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct McpSecretSet {
    pub field: McpField,
    pub name: McpValueName,
    pub sealed: SealedSecret,
}

/// A secret already on the node: which list of its server, and its name.
#[derive(
    Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
pub struct McpSecretKey {
    pub field: McpField,
    pub name: McpValueName,
}

/// A secret the node saved, with the fingerprint of its value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct McpSecretSaved {
    pub field: McpField,
    pub name: McpValueName,
    pub fingerprint: SecretFingerprint,
}

/// A value of a server as a session gets it: a plain one's value, or a secret's name, which the node resolves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum McpSessionValue {
    Plain { name: McpValueName, value: EnvValue },
    Secret { name: McpValueName },
}

impl McpSessionValue {
    pub fn name(&self) -> &McpValueName {
        match self {
            McpSessionValue::Plain { name, .. } | McpSessionValue::Secret { name } => name,
        }
    }
}

/// One server as a session gets it, with no secret's value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpSessionServer {
    pub name: McpServerName,
    /// Where its secrets are on the node.
    pub secrets: McpSecretScope,
    pub roles: McpRoles,
    pub transport: McpTransport,
    #[serde(default)]
    pub env: Vec<McpSessionValue>,
    #[serde(default)]
    pub headers: Vec<McpSessionValue>,
}

/// The MCP servers a session's claude gets, besides fleetd's own: the enabled ones of its project and the global ones
/// it doesn't replace, each for its roles (the node gives a session only those of its role).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpSessionConfig {
    /// The person's own MCP servers in their claude setup (`~/.claude.json`, a repo's `.mcp.json`) too. Off: claude
    /// runs with `--strict-mcp-config`, fleetd's servers only.
    pub user_servers: bool,
    #[serde(default)]
    pub servers: Vec<McpSessionServer>,
}

/// One tool a server lists.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
    /// The server says the tool only reads (MCP's `readOnlyHint`): the connect screen offers it as one to run unasked.
    pub read_only: Option<bool>,
    /// What the hub's tool policy does with it (`hub/integrations`), filled in by the hub.
    pub policy: Option<crate::integrations::ToolPolicy>,
}

/// What a connection test found: the tools a server lists, or why it couldn't be reached.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    /// The name and version the server gave, e.g. `github-mcp 1.2.0`.
    pub server: Option<String>,
    #[serde(default)]
    pub tools: Vec<McpToolInfo>,
    /// Why the test failed: what went wrong, the server's stderr tail for a command.
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_urls() {
        for good in ["github", "my_db-2", "A"] {
            assert!(McpServerName::new(good).is_ok(), "{good}");
        }
        for bad in ["", "a b", "a.b", "é", &"x".repeat(65)] {
            assert!(McpServerName::new(bad).is_err(), "{bad}");
        }
        assert!(mcp_name_reserved("fleetd") && mcp_name_reserved("FleetD"));
        assert!(!mcp_name_reserved("fleetd2"));
        assert!(McpValueName::new("Authorization").is_ok());
        assert!(McpValueName::new("X-Api-Key").is_ok());
        assert!(McpValueName::new("a b").is_err());
        assert!(McpUrl::new("https://mcp.example.com/mcp").is_ok());
        assert!(McpUrl::new("file:///etc/passwd").is_err());
        assert!(McpArg::new("a\0").is_err());
    }

    #[test]
    fn a_secret_missing_on_a_machine_is_named() {
        let server: McpServer = serde_json::from_value(serde_json::json!({
            "scope": { "kind": "global" },
            "name": "github",
            "enabled": true,
            "roles": { "lead": true, "writers": true, "reviewers": false },
            "transport": { "type": "http", "url": "https://api.example.com/mcp" },
            "headers": [
                { "name": "Authorization", "kind": "secret",
                  "sealedOn": [{ "machineId": "devbox", "fingerprint": "0123abcd" }] },
                { "name": "X-Team", "kind": "plain", "value": "core" }
            ],
            "updatedAt": "2026-10-26T00:00:00Z"
        }))
        .unwrap();
        assert!(
            server
                .secrets_missing_on(&MachineId::unchecked("devbox"))
                .is_empty()
        );
        assert_eq!(
            server.secrets_missing_on(&MachineId::unchecked("laptop")),
            [McpValueName::unchecked("Authorization")]
        );
        assert!(
            server.roles.has(McpAgentRole::Writer) && !server.roles.has(McpAgentRole::Reviewer)
        );
    }
}
