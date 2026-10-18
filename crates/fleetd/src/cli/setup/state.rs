//! `<hub home>/setup.json`: written by `fleetd init`, read by `machine add/remove` and `uninstall`. No secrets.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::units::Platform;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

/// What `fleetd machine add` set up on a machine, so `machine remove` can undo it with only the id.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineRecord {
    pub ssh_host: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ssh_config: Option<String>,
    /// The hub's own machine, set up without SSH.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub local: bool,
    pub platform: Platform,
    pub home: String,
    pub config_home: String,
    pub uid: u32,
    pub unit_suffix: String,
    pub t3_port: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    pub listen: String,
    /// Where devices and nodes reach the hub.
    pub url: String,
    pub unit_suffix: String,
    /// Commit identity for every T3 and node fleetd sets up (public repos want the GitHub noreply address).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub git_identity: Option<GitIdentity>,
    pub machines: BTreeMap<String, MachineRecord>,
}

pub fn setup_file(home: &Path) -> PathBuf {
    home.join("setup.json")
}

pub fn read_setup(home: &Path) -> Result<Option<SetupState>, String> {
    let file = setup_file(home);
    if !file.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&file)
        .map_err(|error| format!("cannot read {}: {error}", file.display()))?;
    let state: SetupState = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid: {error}", file.display()))?;
    if let Some(bad) = state
        .machines
        .keys()
        .find(|id| !crate::cli::is_machine_id(id))
    {
        return Err(format!(
            "{} is not valid: '{bad}' is not a machine id",
            file.display()
        ));
    }
    Ok(Some(state))
}

pub fn write_setup(home: &Path, state: &SetupState) -> Result<(), String> {
    super::mkdir_private(home)?;
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(state).expect("setup state serializes")
    );
    super::write_private(&setup_file(home), &text)
}

/// `Name <email>`, as git prints an identity.
pub fn parse_git_identity(value: &str) -> Option<GitIdentity> {
    let value = value.trim();
    let open = value.find('<')?;
    let inner = value[open + 1..].strip_suffix('>')?.trim();
    let name = value[..open].trim();
    let bad = |text: &str| text.contains(['<', '>']);
    let (local, domain) = inner.split_once('@')?;
    if name.is_empty()
        || bad(name)
        || bad(inner)
        || inner.chars().any(char::is_whitespace)
        || local.is_empty()
        || domain.is_empty()
    {
        return None;
    }
    Some(GitIdentity {
        name: name.to_owned(),
        email: inner.to_owned(),
    })
}

pub fn is_noreply(identity: &GitIdentity) -> bool {
    identity
        .email
        .to_lowercase()
        .ends_with("@users.noreply.github.com")
}

/// Commits made by agents and by the node carry this identity, without touching the machine's own git config.
pub fn git_identity_env(identity: Option<&GitIdentity>) -> Vec<(String, String)> {
    match identity {
        None => vec![],
        Some(id) => vec![
            ("GIT_AUTHOR_NAME".into(), id.name.clone()),
            ("GIT_AUTHOR_EMAIL".into(), id.email.clone()),
            ("GIT_COMMITTER_NAME".into(), id.name.clone()),
            ("GIT_COMMITTER_EMAIL".into(), id.email.clone()),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_git_identity() {
        assert_eq!(
            parse_git_identity("wynn-dev <66362261+wynn-dev@users.noreply.github.com>"),
            Some(GitIdentity {
                name: "wynn-dev".into(),
                email: "66362261+wynn-dev@users.noreply.github.com".into()
            })
        );
        assert_eq!(
            parse_git_identity("  Wynn Dev  < a@b >  ").map(|i| i.name),
            Some("Wynn Dev".into())
        );
        assert_eq!(parse_git_identity("no email"), None);
        assert_eq!(parse_git_identity("<a@b>"), None);
    }
}
