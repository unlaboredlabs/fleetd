//! The agents' Mac (D298): a Mac whose node runs as a standard `agents` user lends its shell, builds and iOS
//! simulators to agents on every machine at once. An agent's `fleetd mac` asks its own node ([`client`]), which seals
//! each step to the Mac's node and sends it through the hub (hub/mac_tool.rs); the Mac's node ([`host`]) opens it,
//! runs it in the agent's own folder there and seals the answer back. The hub passes sealed bytes and says who calls.
//!
//! Each step is a sealed box to the Mac's key holding the step, when it was made, a nonce the Mac takes only once, and
//! a fresh key for the answer, so only the agent's node opens what comes back.

pub mod activity;
pub mod client;
pub mod host;
pub mod jobs;
pub mod push;
pub mod queue;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::mac::{MacCallFrame, MacEnv, MacJob, MacResultFrame};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use serde::{Deserialize, Serialize};

/// node.json's `mac`, which the agents' Mac's screen reads too (node/desktop/mac).
pub use crate::node::desktop::mac::MacConfig as MacToolConfig;

/// A step for the agents' Mac, answered by this node's host; refused where this node isn't the Mac.
pub async fn answer(host: &Option<Arc<host::Host>>, call: MacCallFrame) -> MacResultFrame {
    match host {
        Some(host) => host.answer(call).await,
        None => MacResultFrame {
            id: call.id,
            sealed: None,
            error: Some(McpToolError::new(
                ErrorCode::Invalid,
                "This machine isn't the agents' Mac.",
            )),
        },
    }
}

/// The most of a file one step carries: well inside the hub link's frames, base64 and sealing included.
pub const PIECE: usize = 2 << 20;
/// The most a push sends.
pub const PUSH_MAX: u64 = 2 << 30;
/// The most a pull brings back.
pub const PULL_MAX: u64 = 1 << 30;
/// The most output one `logs` step carries.
pub const LOGS_MAX: usize = 256 << 10;
/// How far a step's clock may be from the Mac's: older ones are refused, as are nonces seen within it.
pub const SKEW_MS: i64 = 5 * 60_000;

/// A step from the agent's node to the Mac's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum Step {
    /// The snapshots of the project the Mac already holds.
    Have,
    /// One piece of a file for the next step, at `offset`: in `data_b64`, or, to a Mac whose `have` said `raw`, as the
    /// raw bytes after the sealed step's JSON ([`seal_step`]) with `data_b64` empty.
    #[serde(rename_all = "camelCase")]
    Put {
        name: String,
        offset: u64,
        data_b64: String,
    },
    /// The agent's folder becomes `snapshot`, from what the Mac holds and the pack put as `pack`.
    Checkout {
        snapshot: String,
        pack: Option<String>,
    },
    Run {
        args: Vec<String>,
        env: Vec<MacEnv>,
        background: bool,
    },
    Logs {
        job: u32,
        offset: u64,
    },
    Ps,
    Kill {
        job: u32,
    },
    /// One piece of a file or folder (as a tar.gz) in the agent's folder. `raw`: the piece may come as raw bytes after
    /// the answer's JSON ([`seal_answer`]) rather than in `data_b64`; an older Mac ignores it and sends base64.
    Get {
        path: String,
        offset: u64,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        raw: bool,
    },
    /// `device`: a device type of the agent's choosing; absent, the golden's (an older agent's node sends none).
    /// `wait`: none free, the agent joins the line ([`queue`]) and hears its place; an older node sends none.
    SimStart {
        #[serde(default)]
        device: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        wait: bool,
    },
    SimEnd,
}

/// The Mac's answer to a [`Step`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum Done {
    Have {
        snapshots: Vec<String>,
        /// This Mac takes a `put`'s piece as raw bytes after the step (an older one says nothing: base64 then).
        #[serde(default)]
        raw: bool,
    },
    Put {
        bytes: u64,
    },
    Checkout {
        folder: String,
    },
    Run {
        job: u32,
    },
    #[serde(rename_all = "camelCase")]
    Logs {
        data_b64: String,
        offset: u64,
        done: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
    },
    Ps {
        jobs: Vec<MacJob>,
    },
    Kill {
        job: u32,
        killed: bool,
    },
    #[serde(rename_all = "camelCase")]
    Get {
        data_b64: String,
        total: u64,
        folder: bool,
    },
    SimStart {
        udid: String,
        device: String,
    },
    SimQueued {
        place: u32,
        #[serde(default)]
        secs: Option<u64>,
        why: String,
    },
    SimEnd {
        ended: bool,
    },
}

/// iOS simulators agents may have booted at once on a Mac with `mem_bytes` of memory: a simulator takes about 3 GB,
/// and the Mac keeps 8 GB for itself (about 2 on 16 GB, 8 on 32 GB), at least 1.
pub fn sim_budget(mem_bytes: u64) -> u32 {
    let gb = mem_bytes >> 30;
    (gb.saturating_sub(8) / 3).max(1) as u32
}

/// The Mac's memory (`sysctl -n hw.memsize`); 16 GB when it can't be read.
pub fn mem_bytes() -> u64 {
    std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(16 << 30)
}

/// What goes inside the sealed box.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    /// The agent's session, as its node knows it: the Mac checks it against the hub's word.
    pub thread: String,
    pub at_ms: i64,
    pub nonce: String,
    /// The key the answer is sealed with, used once.
    pub answer_key: String,
    pub step: Step,
}

/// The answer inside its seal.
#[derive(Debug, Serialize, Deserialize)]
pub struct Answer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<Done>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<McpToolError>,
}

/// A step and the raw bytes that follow its JSON (a `put`'s piece, or none), sealed to the Mac's key `to`.
pub fn seal_step(to: &[u8; 32], envelope: &Envelope, raw: &[u8]) -> Option<String> {
    let mut plain = zeroize::Zeroizing::new(serde_json::to_vec(envelope).ok()?);
    plain.extend_from_slice(raw);
    seal_to(to, &plain)
}

/// A JSON value at the start of `plain`, and the raw bytes after it.
pub fn split_raw<T: serde::de::DeserializeOwned>(
    plain: &[u8],
) -> Result<(T, &[u8]), serde_json::Error> {
    use serde::de::Error as _;
    let mut values = serde_json::Deserializer::from_slice(plain).into_iter::<T>();
    let value = values
        .next()
        .ok_or_else(|| serde_json::Error::custom("nothing to read"))??;
    Ok((value, &plain[values.byte_offset()..]))
}

/// `plain`, sealed to the raw X25519 key `to`, base64.
pub fn seal_to(to: &[u8; 32], plain: &[u8]) -> Option<String> {
    crypto_box::PublicKey::from(*to)
        .seal(&mut crypto_box::aead::OsRng, plain)
        .ok()
        .map(|sealed| B64.encode(sealed))
}

fn answer_box(key: &[u8; 32]) -> crypto_secretbox::XSalsa20Poly1305 {
    use crypto_secretbox::KeyInit;
    crypto_secretbox::XSalsa20Poly1305::new(crypto_secretbox::Key::from_slice(key))
}

/// The answer and the raw bytes after its JSON (a `get` step's piece when it asked for `raw`, else none), sealed with
/// the step's own answer key (fresh for each step, so one fixed nonce is safe).
pub fn seal_answer(key: &[u8; 32], answer: &Answer, raw: &[u8]) -> String {
    use crypto_secretbox::aead::Aead;
    let mut plain =
        zeroize::Zeroizing::new(serde_json::to_vec(answer).expect("an answer serializes"));
    plain.extend_from_slice(raw);
    let sealed = answer_box(key)
        .encrypt(&crypto_secretbox::Nonce::default(), plain.as_slice())
        .expect("sealing fits");
    B64.encode(sealed)
}

pub fn open_answer(key: &[u8; 32], sealed_b64: &str) -> Option<(Answer, Vec<u8>)> {
    use crypto_secretbox::aead::Aead;
    let sealed = B64.decode(sealed_b64).ok()?;
    let plain = zeroize::Zeroizing::new(
        answer_box(key)
            .decrypt(&crypto_secretbox::Nonce::default(), sealed.as_slice())
            .ok()?,
    );
    let (answer, raw) = split_raw(&plain).ok()?;
    Some((answer, raw.to_vec()))
}

/// A name safe as one path part: what an agent's folder and a project's mirror are called on the Mac.
pub fn safe_part(name: &str) -> Option<String> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    ok.then(|| name.to_owned())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}
