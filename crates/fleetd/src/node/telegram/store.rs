//! What the node keeps for one Navi's bridge, in `<node home>/telegram/<project id>/` (mode 0700): the bot token in
//! `token.json` (0600, as a 1Password token is kept, onepassword_tokens.rs), and in `state.json` the read offset, the
//! paired account, a pairing code's hash, the journal of what came in and the bot as Test last saw it. Files that came
//! in wait in `files/` until the hub reads them.
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::ids::ProjectId;
use fleetd_contracts::secrets::{SealedSecret, SecretFingerprint};
use fleetd_contracts::telegram::{TelegramBot, TelegramEvent, TelegramPerson};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::node::identity::NodeBoxKey;
use crate::node::secrets::{fingerprint_of, write_atomic};

pub const DIR: &str = "telegram";
const TOKEN_FILE: &str = "token.json";
const STATE_FILE: &str = "state.json";
pub const FILES: &str = "files";
/// The journal keeps at most this many events; the hub takes them long before.
pub const JOURNAL_MAX: usize = 200;

pub fn dir(home: &Path, project: &ProjectId) -> PathBuf {
    home.join(DIR).join(project.as_str())
}

/// The projects with a token on this node.
pub fn projects(home: &Path) -> Vec<ProjectId> {
    let Ok(entries) = std::fs::read_dir(home.join(DIR)) else {
        return Vec::new();
    };
    let mut out: Vec<ProjectId> = entries
        .flatten()
        .filter(|e| e.path().join(TOKEN_FILE).is_file())
        .filter_map(|e| e.file_name().to_str().map(ProjectId::unchecked))
        .collect();
    out.sort();
    out
}

#[derive(Serialize, Deserialize)]
struct TokenFile {
    value: String,
}

impl Drop for TokenFile {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

/// A pending pairing link: the sha256 of its code, and when it stops working.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub code_sha256: String,
    pub expires_ms: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub fingerprint: Option<SecretFingerprint>,
    /// The next update_id to ask getUpdates for: everything before it was handled.
    pub offset: i64,
    pub paired: Option<TelegramPerson>,
    pub pairing: Option<Pairing>,
    pub paused: bool,
    /// The last journal seq given out; never goes back, a new token's included, so the hub's cursor stays good.
    pub seq: i64,
    pub journal: Vec<TelegramEvent>,
    pub bot: Option<TelegramBot>,
}

fn io_why(error: &std::io::Error) -> String {
    crate::node::util::errno_name(error).unwrap_or_else(|| error.to_string())
}

pub fn read_token(home: &Path, project: &ProjectId) -> Result<Option<Zeroizing<String>>, String> {
    let bytes = match std::fs::read(dir(home, project).join(TOKEN_FILE)) {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!(
                "cannot read the Telegram bot token: {}",
                io_why(&e)
            ));
        }
    };
    let file: TokenFile = serde_json::from_slice(&bytes)
        .map_err(|_| "the Telegram bot token file does not parse".to_owned())?;
    Ok(Some(Zeroizing::new(file.value.clone())))
}

/// A token as @BotFather gives it: the bot's id, a colon, and 30 or more of `A-Za-z0-9_-`.
pub fn token_shaped(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else {
        return false;
    };
    !id.is_empty()
        && id.len() <= 20
        && id.bytes().all(|b| b.is_ascii_digit())
        && secret.len() >= 30
        && secret.len() <= 100
        && secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Opens the sealed token and saves it, starting the bridge afresh (no paired account, no offset, an empty journal);
/// the seq goes on. Its fingerprint.
pub fn save_token(
    home: &Path,
    project: &ProjectId,
    sealed: &SealedSecret,
    box_key: Option<&NodeBoxKey>,
) -> Result<SecretFingerprint, String> {
    let Some(box_key) = box_key else {
        return Err("this node takes no secrets: it has no box key".to_owned());
    };
    let boxed = Zeroizing::new(B64.decode(sealed.as_str()).unwrap_or_default());
    let Some(plain) = box_key.open(&boxed) else {
        return Err(
            "the bot token was not sealed to this machine's current box key: seal it to its boxPubKey again"
                .to_owned(),
        );
    };
    let Ok(text) = std::str::from_utf8(&plain) else {
        return Err("the bot token is not UTF-8 text".to_owned());
    };
    let value = Zeroizing::new(text.trim().to_owned());
    if !token_shaped(&value) {
        return Err(
            "that isn't a bot token: @BotFather gives one like 123456789:AAH… (digits, a colon, then letters)"
                .to_owned(),
        );
    }
    let fingerprint = SecretFingerprint::unchecked(fingerprint_of(value.as_bytes()));
    let d = dir(home, project);
    crate::node::config::mkdir_private(&d)
        .map_err(|e| format!("cannot make {}: {}", d.display(), io_why(&e)))?;
    let saved = TokenFile {
        value: value.to_string(),
    };
    let bytes = Zeroizing::new(serde_json::to_vec(&saved).map_err(|e| e.to_string())?);
    write_atomic(&d.join(TOKEN_FILE), &bytes)
        .map_err(|e| format!("cannot write the Telegram bot token: {}", io_why(&e)))?;
    let seq = read_state(home, project).seq;
    let _ = std::fs::remove_dir_all(d.join(FILES));
    write_state(
        home,
        project,
        &State {
            fingerprint: Some(fingerprint.clone()),
            seq,
            ..State::default()
        },
    )?;
    Ok(fingerprint)
}

/// Forgets the bridge: token, state and files.
pub fn forget(home: &Path, project: &ProjectId) -> Result<(), String> {
    match std::fs::remove_dir_all(dir(home, project)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!(
            "cannot remove the Telegram bridge's files: {}",
            io_why(&e)
        )),
        _ => Ok(()),
    }
}

/// The saved state; a missing or unreadable file reads as a fresh one.
pub fn read_state(home: &Path, project: &ProjectId) -> State {
    std::fs::read(dir(home, project).join(STATE_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn write_state(home: &Path, project: &ProjectId, state: &State) -> Result<(), String> {
    let d = dir(home, project);
    crate::node::config::mkdir_private(&d)
        .map_err(|e| format!("cannot make {}: {}", d.display(), io_why(&e)))?;
    let bytes = serde_json::to_vec(state).map_err(|e| e.to_string())?;
    write_atomic(&d.join(STATE_FILE), &bytes)
        .map_err(|e| format!("cannot write the Telegram bridge's state: {}", io_why(&e)))
}

pub fn file_path(home: &Path, project: &ProjectId, key: &str) -> Option<PathBuf> {
    let safe = !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    safe.then(|| dir(home, project).join(FILES).join(key))
}
