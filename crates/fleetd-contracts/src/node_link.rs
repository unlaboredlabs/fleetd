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
use crate::ledger::{DecisionKey, EnvName, GatedArgv, GatedCwd, GatedTimeoutSec, SecretEnv};
use crate::model::SleptSpan;
use crate::prim::{AnyInt, Count, Finite, Int, List, NonEmpty, NonNegative, Text};
use crate::secrets::{BoxPublicKey, SealedSecret, SecretFingerprint, SecretSink};
use crate::sessions::{
    CloneProgressFrame, MachineEventFrame, SessionCallFrame, SessionReplyFrame, ThreadEventFrame,
};
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

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeHello {
    pub machine_id: MachineId,
    pub name: String,
    pub tags: Vec<String>,
    pub node_version: String,
    pub protocol: ProtocolVersion,
    /// ed25519 public key, base64.
    pub pub_key: NonEmpty,
    /// Signature over the hub's challenge nonce (its UTF-8 bytes), base64.
    pub sig: NonEmpty,
    /// One-time token from `fleetd hub token create`; sent only until the hub has registered `pub_key`.
    pub enroll_token: Option<NonEmpty>,
    /// M8: the X25519 key the desktop app seals this machine's secrets to. Absent on nodes from before M8.
    pub box_pub_key: Option<BoxPublicKey>,
    /// Calls this node understands beyond the protocol's base set, e.g. [`CAP_REPOS`]. A node drops its link on a
    /// frame it can't decode, so the hub sends newer calls only to nodes that list them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
}

/// `repo_scan`, `repo_inspect`, `repo_clone` and `gh_repo_list` (adding a project).
pub const CAP_REPOS: &str = "repos";

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HubWelcome {
    pub hub_id: String,
    pub protocol: ProtocolVersion,
    pub nonce: Option<String>,
}

/// Both directions every 15 s; a link silent for 45 s is offline.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Heartbeat {
    pub at: Timestamp,
    /// Node -> hub only; absent from older nodes and when the machine's figures can't be read.
    pub load: Option<NodeLoad>,
}

/// What a machine reports about itself with each heartbeat.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeLoad {
    /// Logical CPUs.
    pub cpus: Int<1, 4096>,
    /// The 1-minute load average.
    pub load1: NonNegative,
    /// Memory in use (total minus available), percent.
    pub mem_used_pct: Option<Int<0, 100>>,
    /// The latest claude.ai subscription limit of each type claude reported. Empty behind API keys and gateways,
    /// which send none.
    #[serde(default)]
    pub limits: List<LoginLimit, 0, 4>,
}

/// One claude.ai usage window, as claude's `rate_limit_event` last reported it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginLimit {
    /// claude's own name for the window, e.g. "five_hour", "seven_day".
    pub limit_type: Text<1, 40>,
    /// 0 to 1 as claude sends it; absent when it sent none.
    pub utilization: Option<NonNegative>,
    pub resets_at: Option<Timestamp>,
    /// allowed, allowed_warning or rejected.
    pub status: Text<1, 40>,
    /// When claude reported it; absent from older nodes. Without it a reading's age is unknown.
    #[serde(default)]
    pub observed_at: Option<Timestamp>,
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
    /// The secret's name; `secret_env` entries name the secret by it.
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

/// Hub -> node: run an approved request's stored command, confined like a `cmd_check`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatedRun {
    pub id: NonEmpty,
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

/// `probe` reads the commit email the node's service uses and the free space on the filesystem holding its home
/// directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NodeActionKind {
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
    /// The node's GIT_AUTHOR_EMAIL (setup puts the identity in the node unit), else `git config --global
    /// user.email`; absent when neither is set.
    pub git_email: Option<Text<0, 320>>,
    pub git_email_from: Option<GitEmailFrom>,
    pub disk_path: String,
    pub disk_free_bytes: Finite,
    /// Settings that make the machine sleep when idle on AC power; empty when none do. Absent from older nodes.
    pub idle_sleep: Option<List<IdleSleep, 0, 8>>,
}

/// One setting that puts the machine to sleep when idle on AC, and the exact change that stops it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IdleSleep {
    /// Where it is set, e.g. "KDE power management", "logind IdleAction".
    pub source: Text<1, 80>,
    /// "sleeps", "hibernates" or "shuts down".
    pub action: Text<1, 40>,
    pub after_sec: Option<Count>,
    pub fix: Text<1, 400>,
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

/// Node -> hub: time spans from the node's outbox rows `fromRid..=toRid`, oldest first. A resend after a
/// reconnect repeats rows; the hub stores each span once by its key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpansFrame {
    pub from_rid: u64,
    pub to_rid: u64,
    pub spans: List<crate::time::SpanWire, 0, 256>,
}

/// Hub -> node: every outbox row up to `upto` is stored on the hub; the node may delete them. With `rewind`, the
/// hub did not store a frame (its writer was full, or a frame before it was lost): the node sends again from `upto`.
#[skip_serializing_none]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SpansAck {
    pub upto: u64,
    pub rewind: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "t", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum NodeToHub {
    Hello(NodeHello),
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
    /// After the machine woke: how long it slept, once per sleep.
    Slept(SleptSpan),
    Spans(SpansFrame),
    CloneProgress(CloneProgressFrame),
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
    SpansAck(SpansAck),
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
    fn a_sleep_ends_after_it_starts() {
        let slept = r#"{"t":"slept","fromMs":1760000000000,"toMs":1760000646000}"#;
        let decoded: NodeToHub = serde_json::from_str(slept).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), slept);
        let backwards = r#"{"t":"slept","fromMs":1760000646000,"toMs":1760000000000}"#;
        assert!(serde_json::from_str::<NodeToHub>(backwards).is_err());
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
