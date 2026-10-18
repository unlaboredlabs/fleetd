//! `<node home>/node.json`. Holds no secrets: the enroll token is used once in memory and never stored.
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub fn default_node_home() -> PathBuf {
    super::util::home_dir().join(".fleetd").join("node")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeConfig {
    pub hub: String,
    pub machine_id: String,
    pub name: String,
    pub tags: Vec<String>,
    /// Empty for a node joined without T3 (its sessions run on the node's own runner).
    #[serde(default)]
    pub t3_home: String,
    #[serde(default)]
    pub t3_url: String,
    /// argv prefix that runs T3's CLI, e.g. ["t3"] or ["node", "<t3-src>/apps/server/src/bin.ts"].
    #[serde(default)]
    pub t3_cmd: Vec<String>,
    /// argv that restarts T3 after it fails its health checks. Absent: the node reports T3 down but never restarts it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t3_restart_cmd: Option<Vec<String>>,
    /// Directories the hub's `cmd` checks may run in (and below). Absent: the user's home directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cmd_roots: Option<Vec<String>>,
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
