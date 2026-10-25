//! A project's environment variables (`project_env`), kept by its node in `<node home>/project-env/<project>.json`
//! and added to every claude the node starts for the project. Kept as the node keeps delivered secrets (secrets.rs):
//! a secret is opened with the node's X25519 key, the file is written atomically at mode 0600 in a 0700 directory,
//! plaintext buffers are wiped, and the answer carries only a secret's fingerprint. Errors name a variable, never a
//! value.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::project_settings::{
    EnvSecretSaved, EnvVarName, EnvVarSet, PROJECT_ENV_MAX, env_name_reserved,
};
use fleetd_contracts::secrets::SecretFingerprint;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use super::identity::NodeBoxKey;
use super::secrets::{fingerprint_of, write_atomic};

const DIR: &str = "project-env";

#[derive(Default, Serialize, Deserialize)]
struct EnvFile {
    vars: BTreeMap<String, Entry>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    value: String,
    #[serde(default)]
    secret: bool,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

fn file(home: &Path, project_id: &str) -> PathBuf {
    home.join(DIR).join(format!("{project_id}.json"))
}

fn read_file(home: &Path, project_id: &str) -> std::io::Result<EnvFile> {
    let path = file(home, project_id);
    let text = match std::fs::read(&path) {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(EnvFile::default()),
        Err(e) => return Err(e),
    };
    serde_json::from_slice(&text).map_err(|_| std::io::Error::other("the file does not parse"))
}

fn io_why(error: &std::io::Error) -> String {
    super::util::errno_name(error).unwrap_or_else(|| error.to_string())
}

/// Applies one `project_env`: every change or none. Returns the fingerprint of each secret it saved.
pub fn apply(
    home: &Path,
    project_id: &str,
    set: &[EnvVarSet],
    remove: &[EnvVarName],
    box_key: Option<&NodeBoxKey>,
) -> Result<Vec<EnvSecretSaved>, String> {
    let shown = format!("{DIR}/{project_id}.json");
    let mut env =
        read_file(home, project_id).map_err(|e| format!("cannot read {shown}: {}", io_why(&e)))?;
    let mut saved = Vec::new();
    for name in remove {
        env.vars.remove(name.as_str());
    }
    for change in set {
        let name = change.name();
        if env_name_reserved(name.as_str()) {
            return Err(format!("{name} is set by fleetd itself for every session"));
        }
        let entry = match change {
            EnvVarSet::Plain { value, .. } => Entry {
                value: value.to_string(),
                secret: false,
            },
            EnvVarSet::Secret { sealed, .. } => {
                let Some(box_key) = box_key else {
                    return Err("this node takes no secrets: it has no box key".to_owned());
                };
                let boxed = Zeroizing::new(B64.decode(sealed.as_str()).unwrap_or_default());
                let Some(plain) = box_key.open(&boxed) else {
                    return Err(format!(
                        "{name} was not sealed to this machine's current box key: seal it to its boxPubKey again"
                    ));
                };
                if plain.is_empty() {
                    return Err(format!("{name}'s value is empty"));
                }
                if plain.iter().any(|&b| b == b'\n' || b == b'\r' || b == 0) {
                    return Err(format!("{name} takes a one-line value"));
                }
                let Ok(value) = std::str::from_utf8(&plain) else {
                    return Err(format!("{name}'s value is not UTF-8 text"));
                };
                saved.push(EnvSecretSaved {
                    name: name.clone(),
                    fingerprint: SecretFingerprint::unchecked(fingerprint_of(&plain)),
                });
                Entry {
                    value: value.to_owned(),
                    secret: true,
                }
            }
        };
        env.vars.insert(name.to_string(), entry);
    }
    if env.vars.len() > PROJECT_ENV_MAX {
        return Err(format!(
            "a project takes at most {PROJECT_ENV_MAX} variables; this would make {}",
            env.vars.len()
        ));
    }
    let dir = home.join(DIR);
    super::config::mkdir_private(&dir).map_err(|e| format!("cannot make {DIR}: {}", io_why(&e)))?;
    let path = file(home, project_id);
    if env.vars.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("cannot remove {shown}: {}", io_why(&e)))
            }
            _ => Ok(saved),
        };
    }
    let bytes = Zeroizing::new(serde_json::to_vec(&env).map_err(|e| e.to_string())?);
    write_atomic(&path, &bytes).map_err(|e| format!("cannot write {shown}: {}", io_why(&e)))?;
    Ok(saved)
}

/// The project's variables, for a claude the node starts now. A file that can't be read gives none, logged without
/// its contents.
pub fn vars(home: &Path, project_id: &str) -> Vec<(String, String)> {
    match read_file(home, project_id) {
        Ok(env) => env
            .vars
            .iter()
            .filter(|(name, _)| !env_name_reserved(name))
            .map(|(name, entry)| (name.clone(), entry.value.clone()))
            .collect(),
        Err(e) => {
            tracing::warn!(project_id, "project env not read: {}", io_why(&e));
            Vec::new()
        }
    }
}

/// Deletes the project's file, when its project goes.
pub fn forget(home: &Path, project_id: &str) {
    if let Err(e) = std::fs::remove_file(file(home, project_id))
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(project_id, "project env not removed: {}", io_why(&e));
    }
}

/// Seals `value` as the desktop app does: `crypto_box_seal` to the box key in `home`.
#[cfg(test)]
pub(crate) fn seal(home: &Path, value: &str) -> fleetd_contracts::secrets::SealedSecret {
    let key = super::identity::load_or_create_box_key(home).unwrap();
    let public: [u8; 32] = B64.decode(key.public_key()).unwrap().try_into().unwrap();
    let sealed = crypto_box::PublicKey::from(public)
        .seal(&mut crypto_box::aead::OsRng, value.as_bytes())
        .unwrap();
    fleetd_contracts::secrets::SealedSecret::new(B64.encode(sealed)).unwrap()
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::node::identity::load_or_create_box_key;
    use fleetd_contracts::project_settings::EnvValue;

    fn name(n: &str) -> EnvVarName {
        EnvVarName::new(n).unwrap()
    }

    #[test]
    fn plain_and_secret_variables_reach_the_spawn_and_only_a_fingerprint_comes_back() {
        let home = tempfile::tempdir().unwrap();
        let key = load_or_create_box_key(home.path()).unwrap();
        let set = vec![
            EnvVarSet::Plain {
                name: name("API_URL"),
                value: EnvValue::new("https://staging.example").unwrap(),
            },
            EnvVarSet::Secret {
                name: name("STRIPE_KEY"),
                sealed: seal(home.path(), "sk_test_42"),
            },
        ];
        let saved = apply(home.path(), "p1", &set, &[], Some(&key)).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].name.as_str(), "STRIPE_KEY");
        assert_eq!(saved[0].fingerprint.as_str(), fingerprint_of(b"sk_test_42"));
        assert!(!format!("{saved:?}").contains("sk_test_42"));
        let mut vars = vars(home.path(), "p1");
        vars.sort();
        assert_eq!(
            vars,
            [
                ("API_URL".to_owned(), "https://staging.example".to_owned()),
                ("STRIPE_KEY".to_owned(), "sk_test_42".to_owned()),
            ]
        );
        let path = file(home.path(), "p1");
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&home.path().join(DIR)), 0o700);
        // Another project's are its own.
        assert!(super::vars(home.path(), "p2").is_empty());

        apply(home.path(), "p1", &[], &[name("API_URL")], Some(&key)).unwrap();
        assert_eq!(super::vars(home.path(), "p1").len(), 1);
        apply(home.path(), "p1", &[], &[name("STRIPE_KEY")], Some(&key)).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn a_bad_change_changes_nothing_and_never_names_the_value() {
        let home = tempfile::tempdir().unwrap();
        let key = load_or_create_box_key(home.path()).unwrap();
        let ok = EnvVarSet::Plain {
            name: name("A"),
            value: EnvValue::new("1").unwrap(),
        };
        apply(home.path(), "p", std::slice::from_ref(&ok), &[], Some(&key)).unwrap();
        let other = tempfile::tempdir().unwrap();
        let wrong_key = EnvVarSet::Secret {
            name: name("B"),
            sealed: seal(other.path(), "hunter2"),
        };
        let two_lines = EnvVarSet::Secret {
            name: name("C"),
            sealed: seal(home.path(), "line1\nhunter2"),
        };
        for bad in [wrong_key, two_lines] {
            let error = apply(home.path(), "p", &[bad], &[name("A")], Some(&key)).unwrap_err();
            assert!(!error.contains("hunter2"), "{error}");
            assert_eq!(
                super::vars(home.path(), "p"),
                [("A".to_owned(), "1".to_owned())]
            );
        }
        let reserved = EnvVarSet::Plain {
            name: name("FLEETD_THREAD_ID"),
            value: EnvValue::new("x").unwrap(),
        };
        assert!(apply(home.path(), "p", &[reserved], &[], Some(&key)).is_err());
        forget(home.path(), "p");
        assert!(super::vars(home.path(), "p").is_empty());
    }
}
