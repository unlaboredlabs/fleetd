//! `<node home>/node.json`. Holds no secrets: the enroll token is used once in memory and never stored.
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub fn default_node_home() -> PathBuf {
    crate::home::fleetd_dir().join("node")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeConfig {
    pub hub: String,
    pub machine_id: String,
    pub name: String,
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
    /// GB of memory to allow per agent when the hub sizes this machine's cap. Absent or 0: 2 GB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_per_agent_gb: Option<u64>,
    /// GB of disk to allow per new agent's worktree when the hub decides how many more fit. Absent or 0: 5 GB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_per_agent_gb: Option<u64>,
    /// Warm cargo builds each checkout keeps for its next readers and reviewers (node/warm). Absent: 2. 0 keeps none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warm_builds: Option<u64>,
    /// True once the hub has accepted this node's key.
    pub enrolled: bool,
    /// Browser sessions for agents (node/browser): on unless `enabled` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<super::browser::BrowserConfig>,
    /// Android sessions for agents (node/device): on where opted in (`enabled` true) or installed already, and KVM opens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<super::device::DeviceConfig>,
    /// iOS sessions for agents (node/device/ios): on a Mac where its golden simulator is made, or `enabled` opts in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ios: Option<super::device::ios::IosConfig>,
    /// Linux desktop sessions for agents (node/desktop): on where the machine has docker, podman or Xvfb unless
    /// `enabled` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<super::desktop::DesktopConfig>,
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
