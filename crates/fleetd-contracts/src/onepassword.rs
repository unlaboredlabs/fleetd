//! A person's 1Password (D235): a service account token pasted once in Settings › Your accounts, sealed in the desktop
//! app to each machine's box key as a Claude subscription is (`claude_accounts.rs`). The hub relays the boxes and keeps
//! only each node's fingerprint; the node keeps the token for its 1Password helper, which reads it on stdin, and never
//! puts it in an agent's, a setup command's or an MCP server's environment.
//!
//! Whose token a session's `fill_credential` uses: its project's or order's own `OP_SERVICE_ACCOUNT_TOKEN` variable
//! when there is one, else the token of the person whose work it is, by the rule Claude accounts use: a Navi's owner
//! for its lead and agents, the person who started the order for a project's tasks. A project's lead and work nobody
//! started (automations, train fixes) have no person, so only a variable serves them.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::claude_accounts::ClaudeSealedOn;
use crate::ids::{MachineId, Timestamp};

/// A person's saved token: never the token, only where it is.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OnePasswordToken {
    /// Each machine whose node holds it. Work on a machine missing here has no token from the person.
    pub sealed_on: Vec<ClaudeSealedOn>,
    pub saved_at: Timestamp,
    pub last_test: Option<OnePasswordTest>,
}

/// The last Test of a token: the vaults it reads, listed with the 1Password SDK on one machine.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OnePasswordTest {
    pub at: Timestamp,
    pub machine_id: MachineId,
    pub ok: bool,
    /// The names of the vaults it can read.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vaults: Vec<String>,
    /// What went wrong, in plain words with the token masked; absent when it worked.
    pub error: Option<String>,
}
