//! Where the hub URL and agent key live: one OS keychain entry (macOS Keychain, Windows Credential
//! Manager, the Secret Service on Linux), never a file. Calls block on the OS, so run them off the
//! UI thread.

use serde::{Deserialize, Serialize};

const SERVICE: &str = "fleetd";
#[cfg(not(test))]
const ACCOUNT: &str = "hub";
// Tests never touch the real entry.
#[cfg(test)]
const ACCOUNT: &str = "hub-test";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub url: String,
    pub key: String,
}

/// For scripted runs: both set means use them for this run and store nothing.
pub fn from_env() -> Option<Saved> {
    let url = std::env::var("FLEETD_HUB_URL").ok().filter(|v| !v.is_empty())?;
    let key = std::env::var("FLEETD_AGENT_KEY").ok().filter(|v| !v.is_empty())?;
    Some(Saved { url, key })
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("No OS keychain available ({e})."))
}

pub fn load() -> Result<Option<Saved>, String> {
    match entry()?.get_password() {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|_| "The saved hub entry in the keychain is unreadable.".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Couldn't read the OS keychain ({e}).")),
    }
}

pub fn save(saved: &Saved) -> Result<(), String> {
    let text = serde_json::to_string(saved).unwrap();
    entry()?.set_password(&text).map_err(|e| format!("Couldn't save to the OS keychain ({e})."))
}

pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Couldn't remove the key from the OS keychain ({e}).")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs an OS keychain (CI has none): `cargo test -p fleetd-app -- --ignored keychain`.
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        let saved = Saved { url: "http://127.0.0.1:4790".into(), key: "fld_test".into() };
        save(&saved).unwrap();
        assert_eq!(load().unwrap(), Some(saved));
        clear().unwrap();
        assert_eq!(load().unwrap(), None);
        clear().unwrap();
    }
}
