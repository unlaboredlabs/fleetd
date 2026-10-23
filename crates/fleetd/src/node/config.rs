//! `<node home>/node.json`. Holds no secrets: the enroll token is used once in memory and never stored.
use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use fleetd_contracts::sessions::SessionRole;
use serde::{Deserialize, Serialize};

use super::runner::claude::CacheTtl;

pub fn default_node_home() -> PathBuf {
    crate::home::fleetd_dir().join("node")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeConfig {
    pub hub: String,
    pub machine_id: String,
    pub name: String,
    pub tags: Vec<String>,
    /// Directories the hub's `cmd` checks may run in (and below). Absent: the user's home directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cmd_roots: Option<Vec<String>>,
    /// A dedicated claude config dir (`CLAUDE_CONFIG_DIR`) for this machine's sessions. Absent: the user's own
    /// claude setup, as their own `claude` sees it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_config_dir: Option<String>,
    /// Below this many GB free where the worktrees live, the hub starts no new agents here. Absent: 10% of the
    /// volume or 20 GB, whichever is larger. 0 turns the disk pause off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_free_gb: Option<u64>,
    /// The prompt cache TTL per session role (`lead`, `worker`, `plain`), over the role's default
    /// ([`PROMPT_CACHE_TTL`](crate::node::runner::claude::PROMPT_CACHE_TTL)). Read at each session start.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub prompt_cache_ttl: HashMap<SessionRole, CacheTtl>,
    /// True once the hub has accepted this node's key.
    pub enrolled: bool,
}

fn config_file(home: &Path) -> PathBuf {
    home.join("node.json")
}

pub fn is_machine_id(id: &str) -> bool {
    fleetd_contracts::ids::MachineId::new(id).is_ok()
}

/// `Ok(None)` when there is no config; `Err` when it is unreadable or does not decode.
pub fn read_config(home: &Path) -> std::io::Result<Option<NodeConfig>> {
    let file = config_file(home);
    if !file.exists() {
        return Ok(None);
    }
    let config: NodeConfig =
        serde_json::from_str(&std::fs::read_to_string(&file)?).map_err(std::io::Error::other)?;
    if !is_machine_id(&config.machine_id) {
        return Err(std::io::Error::other("invalid machine id"));
    }
    Ok(Some(config))
}

pub fn mkdir_private(dir: &Path) -> std::io::Result<()> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

pub fn write_config(home: &Path, config: &NodeConfig) -> std::io::Result<()> {
    mkdir_private(home)?;
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(config).map_err(std::io::Error::other)?
    );
    // Like writeFileSync with a mode: 0600 when created, an existing file keeps its mode.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(config_file(home))?;
    file.write_all(text.as_bytes())
}
