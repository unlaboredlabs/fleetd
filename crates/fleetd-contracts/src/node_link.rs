//! Node link: WebSocket JSON, one message per frame, discriminated by "t".
//!
//! Hub sends `challenge` first; node answers `hello` signed over that nonce; hub replies `welcome`. The hub refuses or
//! ends a link by closing the socket with one of the [`close`] codes and a plain-language reason.
//!
//! Frame structs carry no `t`; [`NodeToHub`] and [`HubToNode`] add it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::checked;
use crate::hello::ProtocolVersion;
use crate::ids::{MachineId, Timestamp};
use crate::lead_calls::{LeadCallFrame, LeadResultFrame};
use crate::ledger::{AskId, DecisionKey, EnvName, GatedArgv, GatedCwd, GatedTimeoutSec, SecretEnv};
use crate::prim::{AnyInt, Finite, Int, List, NonEmpty, Text};
use crate::secrets::{BoxPublicKey, SealedSecret, SecretFingerprint, SecretSink};
use crate::sessions::{MachineEventFrame, SessionCallFrame, SessionReplyFrame, ThreadEventFrame};
use crate::tasks::AbsolutePath;

/// WebSocket close codes the hub ends a link with.
pub mod close {
    /// A frame that does not decode, or arrives out of order.
    pub const BAD_FRAME: u16 = 4000;
    /// Bad signature, unknown key, or an invalid, used or expired enroll token. Retrying will not help.
    pub const UNAUTHORIZED: u16 = 4001;
    /// The two sides speak different protocol versions. Retrying will not help.
    pub const PROTOCOL_MISMATCH: u16 = 4002;
    /// A newer link for the same machine took over.
    pub const REPLACED: u16 = 4003;
    /// No frame for 45 s.
    pub const HEARTBEAT_TIMEOUT: u16 = 4008;
}

/// Both directions every 15 s.
pub const HEARTBEAT_INTERVAL_SECS: u64 = 15;
/// A link silent this long is offline.
pub const HEARTBEAT_TIMEOUT_SECS: u64 = 45;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HubChallenge {
    pub nonce: NonEmpty,
}

/// Where and which T3 the node supervises.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NodeT3Endpoint {
    /// Loopback or tailnet URL the hub can reach.
    pub url: String,
    pub version: String,
    pub protocol: AnyInt,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeHello {
    pub machine_id: MachineId,
    pub name: String,
    pub tags: Vec<String>,
    pub node_version: String,
    pub protocol: ProtocolVersion,
    /// Absent when T3 is down at node start; the hub shows the machine as degraded.
    pub t3: Option<NodeT3Endpoint>,
    /// ed25519 public key, base64.
    pub pub_key: NonEmpty,
    /// Signature over the hub's challenge nonce (its UTF-8 bytes), base64.
    pub sig: NonEmpty,
    /// One-time token from `fleetd hub token create`; sent only until the hub has registered `pub_key`.
    pub enroll_token: Option<NonEmpty>,
    /// M8: the X25519 key the desktop app seals this machine's secrets to. Absent on nodes from before M8.
    pub box_pub_key: Option<BoxPublicKey>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HubWelcome {
    pub hub_id: String,
    pub protocol: ProtocolVersion,
    pub nonce: Option<String>,
}

/// Sent on connect and on each re-mint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeT3Session {
    pub bearer: NonEmpty,
    pub expires_at: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum T3RunState {
    Up,
    Down,
    Restarting,
}

/// The node's view of its local T3, sent when it changes.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NodeT3State {
    pub state: T3RunState,
    pub reason: Option<String>,
    /// Sent with "up", so the hub can attach a machine whose T3 was down when the node said hello.
    pub t3: Option<NodeT3Endpoint>,
    pub at: Timestamp,
}

/// Both directions every 15 s; a link silent for 45 s is offline.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Heartbeat {
    pub at: Timestamp,
}

/// Hub -> node: run a `cmd` check. argv only, never through a shell.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CmdCheck {
    pub id: NonEmpty,
    /// Absolute; the project workspace unless the check says otherwise.
    pub cwd: AbsolutePath,
    pub argv: List<String, 1, 64>,
    pub timeout_sec: Int<1, 3600>,
}

/// Node -> hub, one per `cmd_check`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CmdResult {
    pub id: NonEmpty,
    /// Null when the process did not exit on its own: it timed out, was killed by a signal, or could not start.
    #[serialize_always]
    #[schemars(with = "crate::prim::NullOr<AnyInt>")]
    pub exit_code: Option<AnyInt>,
    /// Last 2000 characters of stdout and stderr interleaved, secrets scrubbed; the start error when it could not
    /// start.
    pub output_tail: Text<0, 2000>,
    pub timed_out: bool,
}

pub type FrameError = Text<1, 500>;

/// Hub -> node: a secret sealed in the desktop app to this node's `box_pub_key`; the hub never sees the plaintext.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretDeliver {
    pub id: NonEmpty,
    /// On this machine.
    pub sink: SecretSink,
    pub sealed: SealedSecret,
    /// The ask's key; `secret_env` entries name the secret by it.
    pub secret_key: DecisionKey,
    /// An env: sink's variable; absent means `secret_env_name(secret_key)`.
    pub env_name: Option<EnvName>,
}

/// Node -> hub, one per `secret_deliver`: the sink was written (0600) and the buffer wiped, or why not.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self")]
pub struct SecretResult {
    pub id: NonEmpty,
    pub fingerprint: Option<SecretFingerprint>,
    /// Plain language, never the value: a sink outside the command roots, a box that does not open, a write error.
    pub error: Option<FrameError>,
}
checked!(SecretResult, |frame| {
    if frame.fingerprint.is_none() == frame.error.is_none() {
        return Err("exactly one of fingerprint and error".into());
    }
    Ok(())
});

/// Hub -> node: run an approved ask's stored command, confined like a `cmd_check`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatedRun {
    pub id: NonEmpty,
    pub ask_id: AskId,
    pub argv: GatedArgv,
    /// The spec's cwd, or the project workspace when it has none: the node never picks one itself.
    pub cwd: GatedCwd,
    pub timeout_sec: GatedTimeoutSec,
    /// Read from the node's own sinks and scrubbed from the output.
    pub secret_env: Option<SecretEnv>,
}

/// Node -> hub, one per `gated_run`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatedResult {
    pub id: NonEmpty,
    /// Null when the process did not exit on its own: it timed out, was killed by a signal, or could not start.
    #[serialize_always]
    #[schemars(with = "crate::prim::NullOr<AnyInt>")]
    pub exit_code: Option<AnyInt>,
    /// Last 2000 characters of stdout and stderr interleaved, with every injected secret value scrubbed.
    pub output_tail: Text<0, 2000>,
    pub timed_out: bool,
    /// Why it did not run: a cwd outside the command roots, a missing secret, a start error.
    pub error: Option<FrameError>,
}

/// `remint_session` mints a fresh T3 session for the hub now; `restart_t3` runs the node's own T3 restart command
/// (none configured: refused); `probe` reads the commit email the node's services use and the free space on the
/// filesystem holding its home directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NodeActionKind {
    RemintSession,
    RestartT3,
    Probe,
}

/// Hub -> node, M11 doctor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NodeAction {
    pub id: NonEmpty,
    pub action: NodeActionKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GitEmailFrom {
    Env,
    GitConfig,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeProbe {
    /// The node's GIT_AUTHOR_EMAIL (setup puts the identity in the T3 and node units), else `git config --global
    /// user.email`; absent when neither is set.
    pub git_email: Option<Text<0, 320>>,
    pub git_email_from: Option<GitEmailFrom>,
    pub disk_path: String,
    pub disk_free_bytes: Finite,
}

/// Node -> hub, one per `node_action`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NodeActionResult {
    pub id: NonEmpty,
    pub ok: bool,
    /// Plain language: what happened, or why it did not.
    pub message: Text<0, 500>,
    /// `probe` only.
    pub probe: Option<NodeProbe>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "t", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum NodeToHub {
    Hello(NodeHello),
    #[serde(rename = "t3session")]
    T3Session(NodeT3Session),
    #[serde(rename = "t3state")]
    T3State(NodeT3State),
    #[serde(rename = "hb")]
    Heartbeat(Heartbeat),
    LeadCall(LeadCallFrame),
    CmdResult(CmdResult),
    SecretResult(SecretResult),
    GatedResult(GatedResult),
    NodeActionResult(NodeActionResult),
    SessionReply(SessionReplyFrame),
    MachineEvent(MachineEventFrame),
    ThreadEvent(ThreadEventFrame),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "t", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum HubToNode {
    Challenge(HubChallenge),
    Welcome(HubWelcome),
    #[serde(rename = "hb")]
    Heartbeat(Heartbeat),
    LeadResult(LeadResultFrame),
    CmdCheck(CmdCheck),
    SecretDeliver(SecretDeliver),
    GatedRun(GatedRun),
    NodeAction(NodeAction),
    SessionCall(SessionCallFrame),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_result_carries_exactly_one_of_fingerprint_and_error() {
        let ok = r#"{"t":"secret_result","id":"s1","fingerprint":"ab12cd34"}"#;
        assert!(serde_json::from_str::<NodeToHub>(ok).is_ok());
        for bad in [
            r#"{"t":"secret_result","id":"s1"}"#,
            r#"{"t":"secret_result","id":"s1","fingerprint":"ab12cd34","error":"no"}"#,
        ] {
            assert!(serde_json::from_str::<NodeToHub>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn frames_round_trip_with_their_tag() {
        let frame =
            r#"{"t":"cmd_result","id":"c1","exitCode":null,"outputTail":"","timedOut":true}"#;
        let decoded: NodeToHub = serde_json::from_str(frame).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), frame);
        let hb = r#"{"t":"hb","at":"2026-10-17T10:00:00.000Z"}"#;
        assert_eq!(
            serde_json::to_string(&serde_json::from_str::<HubToNode>(hb).unwrap()).unwrap(),
            hb
        );
    }
}
