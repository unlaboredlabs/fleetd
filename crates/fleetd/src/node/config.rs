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
    /// Warm cargo builds each checkout keeps for its next readers and reviewers (node/warm). Absent: 2. 0 keeps none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warm_builds: Option<u64>,
    /// Agents' cargo builds that run at once here; one past them waits its turn (node/build_slots). Absent: one per
    /// 16 GB of memory, at least 1. 0: no turns, all run at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_slots: Option<u64>,
    /// Minutes without a command before a browser, Android or Linux desktop screen ends (Settings › Hub › Machines ›
    /// Screens writes it). Absent: 30. The agents' Mac's screen keeps its own 5.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_idle_minutes: Option<u64>,
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
    /// The agents' Mac's own screen (node/desktop/mac): off unless `enabled` is true, on a Mac whose node runs in the
    /// account at its screen; and `simulators`, the iOS simulators it lends agents at once (node/mac_tool).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac: Option<super::desktop::mac::MacConfig>,
    /// The agents' Mac (node/agents_mac, D298): set only by the installer's `--mac`, never by a screen's switch. The
    /// node is a tool, never a runner, whatever else this file says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents_mac: Option<bool>,
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
    let mut json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file)?).map_err(std::io::Error::other)?;
    lift_screen_idle(&mut json);
    let config: NodeConfig = serde_json::from_value(json).map_err(std::io::Error::other)?;
    if !is_machine_id(&config.machine_id) {
        return Err(std::io::Error::other("invalid machine id"));
    }
    Ok(Some(config))
}

/// An older node.json kept the screens' idle time in each kind's section; the first one found is the one time now.
fn lift_screen_idle(json: &mut serde_json::Value) {
    let Some(root) = json.as_object_mut() else {
        return;
    };
    if root.contains_key("screenIdleMinutes") {
        return;
    }
    let old = ["browser", "device", "desktop", "ios"]
        .iter()
        .find_map(|kind| root.get(*kind)?.get("idleMinutes").cloned());
    if let Some(minutes) = old {
        root.insert("screenIdleMinutes".into(), minutes);
    }
}

/// A development override of a binary or image a screen kind uses, from the node's environment.
fn dev_override(var: &str) -> Option<String> {
    std::env::var(var).ok().filter(|v| !v.is_empty())
}

impl NodeConfig {
    /// Each screen kind's settings as its broker and checks take them: node.json's section, the one idle time, and
    /// the development overrides from the environment.
    pub fn browser_screen(&self) -> super::browser::BrowserConfig {
        super::browser::BrowserConfig {
            idle_minutes: self.screen_idle_minutes,
            chrome: dev_override("FLEETD_CHROME"),
            ffmpeg: dev_override("FLEETD_FFMPEG"),
            ..self.browser.clone().unwrap_or_default()
        }
    }

    pub fn device_screen(&self) -> super::device::DeviceConfig {
        super::device::DeviceConfig {
            idle_minutes: self.screen_idle_minutes,
            ..self.device.clone().unwrap_or_default()
        }
    }

    pub fn ios_screen(&self) -> super::device::ios::IosConfig {
        super::device::ios::IosConfig {
            idle_minutes: self.screen_idle_minutes,
            ..self.ios.clone().unwrap_or_default()
        }
    }

    pub fn desktop_screen(&self) -> super::desktop::DesktopConfig {
        super::desktop::DesktopConfig {
            idle_minutes: self.screen_idle_minutes,
            runtime: dev_override("FLEETD_DESKTOP_RUNTIME"),
            image: dev_override("FLEETD_DESKTOP_IMAGE"),
            xvfb: dev_override("FLEETD_XVFB"),
            ffmpeg: dev_override("FLEETD_FFMPEG"),
            ..self.desktop.clone().unwrap_or_default()
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// An older node.json's screen tuning: its idle time, kept in each kind's section, is the one time now; pools,
    /// binary paths and per-agent sizes are ignored, and it still reads.
    #[test]
    fn an_older_node_json_keeps_its_screens_idle_time_and_ignores_the_rest() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("node.json"),
            r#"{ "hub": "http://devbox:4790", "machineId": "devbox", "name": "devbox", "enrolled": true,
                 "memPerAgentGb": 4, "diskPerAgentGb": 2,
                 "browser": { "pool": 2, "chrome": "/opt/chrome", "idleMinutes": 45 },
                 "desktop": { "backend": "xvfb", "image": "x", "pool": 3, "idleMinutes": 45 } }"#,
        )
        .unwrap();
        let config = read_config(home.path()).unwrap().unwrap();
        assert_eq!(config.screen_idle_minutes, Some(45));
        let browser = config.browser_screen();
        assert_eq!(browser.idle_minutes, Some(45));
        assert_eq!(browser.chrome, std::env::var("FLEETD_CHROME").ok());
        let desktop = config.desktop_screen();
        assert_eq!(desktop.pool, None);
        assert_eq!(
            desktop.backend,
            Some(fleetd_contracts::browser::DesktopBackend::Xvfb)
        );
        assert_eq!(desktop.idle_minutes, Some(45));
        assert_eq!(config.ios_screen().idle_minutes, Some(45));
    }
}
