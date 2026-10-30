//! People's 1Password service account tokens (D235), on the node: one file each in
//! `<node home>/onepassword-tokens/<person id>.json`, kept as a Claude subscription is (claude_accounts.rs): opened
//! with the node's box key, written atomically at mode 0600 in a 0700 directory, plaintext buffers wiped, errors
//! naming the person, never a value.
//!
//! A session launched with a person (`SessionLaunch::onepassword`) has their token among its secrets as
//! `OP_SERVICE_ACCOUNT_TOKEN` when its project and order have none of their own ([`fallback`]), so fill_credential
//! uses it and its reports mask it. It never reaches an environment: spawn, setup commands and MCP servers read the
//! project's and order's variables only.
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::people::PersonId;
use fleetd_contracts::secrets::{SealedSecret, SecretFingerprint};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use super::browser::onepassword::TOKEN_ENV;
use super::identity::NodeBoxKey;
use super::project_env::Vars;
use super::secrets::{fingerprint_of, write_atomic};

const DIR: &str = "onepassword-tokens";
/// A token is one line; anything longer is no token.
const VALUE_MAX: usize = 4096;

/// One `apply` at a time.
static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Serialize, Deserialize)]
struct TokenFile {
    value: String,
}

impl Drop for TokenFile {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

fn path(home: &Path, person: &PersonId) -> PathBuf {
    home.join(DIR).join(format!("{person}.json"))
}

fn io_why(error: &std::io::Error) -> String {
    super::util::errno_name(error).unwrap_or_else(|| error.to_string())
}

/// The person's token, when the node holds one. Fails only when its file can't be read.
pub fn read(home: &Path, person: &PersonId) -> Result<Option<Zeroizing<String>>, String> {
    let bytes = match std::fs::read(path(home, person)) {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!(
                "cannot read {person}'s 1Password token: {}",
                io_why(&e)
            ));
        }
    };
    let file: TokenFile = serde_json::from_slice(&bytes)
        .map_err(|_| format!("{person}'s 1Password token file does not parse"))?;
    Ok(Some(Zeroizing::new(file.value.clone())))
}

/// Saves the person's token, or forgets it with `None`. The fingerprint of the token held afterwards.
pub fn apply(
    home: &Path,
    person: &PersonId,
    sealed: Option<&SealedSecret>,
    box_key: Option<&NodeBoxKey>,
) -> Result<Option<SecretFingerprint>, String> {
    let _writing = WRITING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let file = path(home, person);
    let Some(sealed) = sealed else {
        return match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!(
                "cannot remove {person}'s 1Password token: {}",
                io_why(&e)
            )),
            _ => Ok(None),
        };
    };
    let Some(box_key) = box_key else {
        return Err("this node takes no secrets: it has no box key".to_owned());
    };
    let boxed = Zeroizing::new(B64.decode(sealed.as_str()).unwrap_or_default());
    let Some(plain) = box_key.open(&boxed) else {
        return Err(
            "the 1Password token was not sealed to this machine's current box key: seal it to its boxPubKey again"
                .to_owned(),
        );
    };
    let Ok(text) = std::str::from_utf8(&plain) else {
        return Err("the 1Password token is not UTF-8 text".to_owned());
    };
    let value = Zeroizing::new(text.trim().to_owned());
    if value.is_empty() || value.len() > VALUE_MAX || value.chars().any(char::is_control) {
        return Err("the 1Password token is not one line of at most 4 KiB".to_owned());
    }
    let fingerprint = SecretFingerprint::unchecked(fingerprint_of(value.as_bytes()));
    if let Some(dir) = file.parent() {
        super::config::mkdir_private(dir)
            .map_err(|e| format!("cannot make {}: {}", dir.display(), io_why(&e)))?;
    }
    let saved = TokenFile {
        value: value.to_string(),
    };
    let bytes = Zeroizing::new(serde_json::to_vec(&saved).map_err(|e| e.to_string())?);
    write_atomic(&file, &bytes)
        .map_err(|e| format!("cannot write {person}'s 1Password token: {}", io_why(&e)))?;
    Ok(Some(fingerprint))
}

/// The person's token as `OP_SERVICE_ACCOUNT_TOKEN`, for a session whose project and order (`secrets`) have none: the
/// project's or order's own always wins. Nothing without a person, or when the node holds no token of theirs.
pub fn fallback(
    home: &Path,
    person: Option<&PersonId>,
    secrets: &[(String, String)],
) -> Result<Vars, String> {
    let Some(person) = person else {
        return Ok(Vec::new());
    };
    if secrets.iter().any(|(name, _)| name == TOKEN_ENV) {
        return Ok(Vec::new());
    }
    Ok(read(home, person)?
        .map(|token| vec![(TOKEN_ENV.to_owned(), token.to_string())])
        .unwrap_or_default())
}
