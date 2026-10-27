//! The Claude accounts sessions run on (teams step 8), on the node: the hub's API key and endpoint, and each person's
//! subscription token, one file each in `<node home>/claude-accounts/<hub | person id>.json`, kept as a project's
//! secret variables are (project_env.rs). A secret is opened with the node's box key, files are written atomically
//! at mode 0600 in 0700 directories, plaintext buffers are wiped, and errors name an account, never show a value.
//!
//! A session launched on an account reads it at each start of its claude ([`env_for`]): its variables replace every
//! credential and gateway of the machine's own setup ([`ACCOUNT_CLEARS`]), and its value is masked in all the
//! session reports. One whose account is gone fails to start rather than fall back to the machine's login.
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::claude_accounts::{
    ACCOUNT_CLEARS, API_KEY_ENV, BASE_URL_ENV, ClaudeAccount, ClaudeSecretSet, OAUTH_TOKEN_ENV,
};
use fleetd_contracts::secrets::SecretFingerprint;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use super::identity::NodeBoxKey;
use super::project_env::Vars;
use super::secrets::{fingerprint_of, write_atomic};

const DIR: &str = "claude-accounts";
/// A key or token is one line; anything longer is no credential.
const VALUE_MAX: usize = 4096;

/// One `apply` at a time: each reads its file, changes it and writes it back.
static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Serialize, Deserialize)]
struct AccountFile {
    value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    endpoint: Option<String>,
}

impl Drop for AccountFile {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

fn path(home: &Path, account: &ClaudeAccount) -> PathBuf {
    home.join(DIR).join(format!("{}.json", account.key()))
}

/// "the hub's API key", "p_abcdefgh's subscription": what errors name.
fn shown(account: &ClaudeAccount) -> String {
    match account {
        ClaudeAccount::Hub => "the hub's API key".to_owned(),
        ClaudeAccount::Person { person_id } => format!("{person_id}'s subscription"),
    }
}

fn io_why(error: &std::io::Error) -> String {
    super::util::errno_name(error).unwrap_or_else(|| error.to_string())
}

fn read(home: &Path, account: &ClaudeAccount) -> Result<Option<AccountFile>, String> {
    let bytes = match std::fs::read(path(home, account)) {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {}", shown(account), io_why(&e))),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| format!("{}'s file does not parse", shown(account)))
}

/// Saves the account's secret (a new value, or a new endpoint for the one held), or forgets it with `None`. The
/// fingerprint of the value held afterwards; none once forgotten.
pub fn apply(
    home: &Path,
    account: &ClaudeAccount,
    set: Option<&ClaudeSecretSet>,
    box_key: Option<&NodeBoxKey>,
) -> Result<Option<SecretFingerprint>, String> {
    let _writing = WRITING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let file = path(home, account);
    let Some(set) = set else {
        return match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("cannot remove {}: {}", shown(account), io_why(&e)))
            }
            _ => Ok(None),
        };
    };
    if set.endpoint.is_some() && *account != ClaudeAccount::Hub {
        return Err("only the hub's API key takes an endpoint".to_owned());
    }
    let value = match &set.sealed {
        None => match read(home, account)? {
            Some(held) => Zeroizing::new(held.value.clone()),
            None => {
                return Err(format!(
                    "this machine holds no {}: seal it again",
                    shown(account)
                ));
            }
        },
        Some(sealed) => {
            let Some(box_key) = box_key else {
                return Err("this node takes no secrets: it has no box key".to_owned());
            };
            let boxed = Zeroizing::new(B64.decode(sealed.as_str()).unwrap_or_default());
            let Some(plain) = box_key.open(&boxed) else {
                return Err(format!(
                    "{} was not sealed to this machine's current box key: seal it to its boxPubKey again",
                    shown(account)
                ));
            };
            let Ok(text) = std::str::from_utf8(&plain) else {
                return Err(format!("{} is not UTF-8 text", shown(account)));
            };
            let text = Zeroizing::new(text.trim().to_owned());
            if text.is_empty() {
                return Err(format!("{} is empty", shown(account)));
            }
            if text.len() > VALUE_MAX || text.chars().any(char::is_control) {
                return Err(format!(
                    "{} is not one line of at most 4 KiB",
                    shown(account)
                ));
            }
            text
        }
    };
    let fingerprint = SecretFingerprint::unchecked(fingerprint_of(value.as_bytes()));
    let saved = AccountFile {
        value: value.to_string(),
        endpoint: set.endpoint.as_ref().map(|e| e.to_string()),
    };
    if let Some(dir) = file.parent() {
        super::config::mkdir_private(dir)
            .map_err(|e| format!("cannot make {}: {}", dir.display(), io_why(&e)))?;
    }
    let bytes = Zeroizing::new(serde_json::to_vec(&saved).map_err(|e| e.to_string())?);
    write_atomic(&file, &bytes)
        .map_err(|e| format!("cannot write {}: {}", shown(account), io_why(&e)))?;
    Ok(Some(fingerprint))
}

/// The variables a claude on `account` gets, and its secret by the variable's name for masking. Fails when the node
/// doesn't hold the account: such a session must not start on the machine's own login instead.
pub fn env_for(home: &Path, account: &ClaudeAccount) -> Result<(Vars, Vars), String> {
    let Some(file) = read(home, account)? else {
        return Err(format!(
            "this machine holds no {}: connect it again while the machine is online",
            shown(account)
        ));
    };
    let name = account_var(account);
    let mut vars = vec![(name.to_owned(), file.value.clone())];
    if let (ClaudeAccount::Hub, Some(endpoint)) = (account, &file.endpoint) {
        vars.push((BASE_URL_ENV.to_owned(), endpoint.clone()));
    }
    let secrets = vec![(name.to_owned(), file.value.clone())];
    Ok((vars, secrets))
}

/// The account's secret by its variable's name, for masking a session's fleetd calls: none once the node no longer
/// holds it (disconnected, removed, or re-sealed without this machine). Fails only when its file can't be read. A
/// session whose claude still runs keeps the value it started with masked: the caller adds what it spawned with.
pub fn secrets_checked(home: &Path, account: &ClaudeAccount) -> Result<Vars, String> {
    Ok(match read(home, account)? {
        Some(file) => vec![(account_var(account).to_owned(), file.value.clone())],
        None => Vec::new(),
    })
}

fn account_var(account: &ClaudeAccount) -> &'static str {
    match account {
        ClaudeAccount::Hub => API_KEY_ENV,
        ClaudeAccount::Person { .. } => OAUTH_TOKEN_ENV,
    }
}

/// `env` with the account's variables in place of every credential and gateway the machine's own setup set.
pub fn put_on(env: &mut Vars, account_vars: Vars) {
    env.retain(|(k, _)| !ACCOUNT_CLEARS.contains(&k.as_str()));
    env.extend(account_vars);
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::people::PersonId;

    use super::super::identity::load_or_create_box_key;
    use super::super::project_env::seal;

    fn alice() -> ClaudeAccount {
        ClaudeAccount::Person {
            person_id: PersonId::unchecked("p_aaaaaaaa"),
        }
    }

    /// `value` sealed as the app seals it, to the box key in `home`.
    fn sealed(home: &Path, value: &str) -> ClaudeSecretSet {
        ClaudeSecretSet {
            sealed: Some(seal(home, value)),
            endpoint: None,
        }
    }

    #[test]
    fn a_person_s_token_reaches_their_sessions_only_and_replaces_the_machine_s_login() {
        let home = tempfile::tempdir().unwrap();
        let key = load_or_create_box_key(home.path()).unwrap();
        let print = apply(
            home.path(),
            &alice(),
            Some(&sealed(home.path(), "tok-alice\n")),
            Some(&key),
        )
        .unwrap()
        .unwrap();
        assert_eq!(print.as_str(), fingerprint_of(b"tok-alice"));
        let (vars, secrets) = env_for(home.path(), &alice()).unwrap();
        assert_eq!(
            vars,
            vec![(OAUTH_TOKEN_ENV.to_owned(), "tok-alice".to_owned())]
        );
        assert_eq!(secrets, vars);
        // Bob has none here: his session refuses to start instead of running on someone else's.
        let bob = ClaudeAccount::Person {
            person_id: PersonId::unchecked("p_bbbbbbbb"),
        };
        let refused = env_for(home.path(), &bob).unwrap_err();
        assert!(refused.contains("p_bbbbbbbb's subscription"), "{refused}");
        assert!(!refused.contains("tok-alice"));
        let mut env = vec![
            ("PATH".to_owned(), "/bin".to_owned()),
            ("ANTHROPIC_API_KEY".to_owned(), "machine-key".to_owned()),
            ("ANTHROPIC_BASE_URL".to_owned(), "http://gw".to_owned()),
        ];
        put_on(&mut env, vars);
        assert_eq!(
            env,
            vec![
                ("PATH".to_owned(), "/bin".to_owned()),
                (OAUTH_TOKEN_ENV.to_owned(), "tok-alice".to_owned()),
            ]
        );
        assert_eq!(
            apply(home.path(), &alice(), None, Some(&key)).unwrap(),
            None
        );
        assert!(env_for(home.path(), &alice()).is_err());
    }

    #[test]
    fn the_hub_s_key_takes_an_endpoint_kept_over_a_change_of_endpoint_alone() {
        let home = tempfile::tempdir().unwrap();
        let key = load_or_create_box_key(home.path()).unwrap();
        apply(
            home.path(),
            &ClaudeAccount::Hub,
            Some(&sealed(home.path(), "sk-hub")),
            Some(&key),
        )
        .unwrap();
        let endpoint_only = ClaudeSecretSet {
            sealed: None,
            endpoint: Some(
                fleetd_contracts::claude_accounts::ClaudeEndpoint::unchecked(
                    "https://gw.devbox.example",
                ),
            ),
        };
        let print = apply(
            home.path(),
            &ClaudeAccount::Hub,
            Some(&endpoint_only),
            Some(&key),
        )
        .unwrap();
        assert_eq!(print.unwrap().as_str(), fingerprint_of(b"sk-hub"));
        let (vars, secrets) = env_for(home.path(), &ClaudeAccount::Hub).unwrap();
        assert_eq!(
            vars,
            vec![
                (API_KEY_ENV.to_owned(), "sk-hub".to_owned()),
                (
                    BASE_URL_ENV.to_owned(),
                    "https://gw.devbox.example".to_owned()
                ),
            ]
        );
        assert_eq!(secrets, vec![(API_KEY_ENV.to_owned(), "sk-hub".to_owned())]);
        // A person's token takes no endpoint, and nothing is kept without a value.
        assert!(apply(home.path(), &alice(), Some(&endpoint_only), Some(&key)).is_err());
        let keep = ClaudeSecretSet {
            sealed: None,
            endpoint: None,
        };
        assert!(apply(home.path(), &alice(), Some(&keep), Some(&key)).is_err());
    }

    #[test]
    fn a_box_for_another_machine_or_with_a_line_break_is_refused_and_never_shown() {
        let home = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let ours = load_or_create_box_key(home.path()).unwrap();
        let wrong = apply(
            home.path(),
            &alice(),
            Some(&sealed(other.path(), "tok")),
            Some(&ours),
        )
        .unwrap_err();
        assert!(wrong.contains("not sealed to this machine"), "{wrong}");
        let two = apply(
            home.path(),
            &alice(),
            Some(&sealed(home.path(), "tok\nmore")),
            Some(&ours),
        )
        .unwrap_err();
        assert!(two.contains("one line") && !two.contains("tok"), "{two}");
    }
}
