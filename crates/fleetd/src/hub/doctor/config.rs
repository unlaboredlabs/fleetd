//! What the doctor reads from `<hub home>/setup.json`, which `fleetd init` and `fleetd machine add` write: the hub's
//! address, the commit identity, and how each machine was set up. Only the fields the doctor needs; the file may be
//! absent (a lab or hand-joined fleet). TS: apps/hub/src/doctor/config.ts.
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubConfig {
    /// Where devices and nodes reach the hub.
    pub url: Option<String>,
    pub unit_suffix: Option<String>,
    pub git_identity: Option<GitIdentity>,
    #[serde(default)]
    pub machines: BTreeMap<String, MachineSetup>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSetup {
    pub ssh_host: String,
    /// "linux" or "darwin".
    pub platform: Platform,
    pub uid: u32,
    pub unit_suffix: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Linux,
    Darwin,
}

/// The setup record, or why it could not be read; an absent file is an empty one.
pub fn read_hub_config(home: &Path) -> (HubConfig, Option<String>) {
    let file = home.join("setup.json");
    let Ok(text) = std::fs::read_to_string(&file) else { return (HubConfig::default(), None) };
    match serde_json::from_str(&text) {
        Ok(config) => (config, None),
        Err(e) => {
            let first = e.to_string();
            (HubConfig::default(), Some(format!("{} is not valid: {}", file.display(), first.lines().next().unwrap_or(""))))
        }
    }
}

/// The command that restarts a fleetd service, named as the CLI's setup names its units.
pub fn restart_command(role: &str, setup: Option<&MachineSetup>) -> String {
    match setup {
        Some(s) if s.platform == Platform::Darwin => format!("launchctl kickstart -k gui/{}/sh.fleetd.{role}{}", s.uid, s.unit_suffix),
        _ => format!("systemctl --user restart fleetd-{role}{}.service", setup.map_or("", |s| s.unit_suffix.as_str())),
    }
}
