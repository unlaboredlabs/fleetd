//! The node link frames, from `fleetd-contracts`, plus the few conversions the node needs to fill them.
pub use fleetd_contracts::hello::{PROTOCOL_VERSION, ProtocolVersion};
pub use fleetd_contracts::ids::{MachineId, Timestamp};
pub use fleetd_contracts::lead_calls::{LeadCallFrame, LeadResultFrame, LeadSocketFrame};
pub use fleetd_contracts::mcp::{ErrorCode, McpToolError};
pub use fleetd_contracts::node_link::{
    CmdCheck, CmdResult, GatedResult, GatedRun, GitEmailFrom, Heartbeat, HubToNode, NodeAction,
    NodeActionKind, NodeActionResult, NodeHello, NodeProbe, NodeT3Endpoint, NodeT3Session,
    NodeT3State, NodeToHub, SecretDeliver, SecretResult, T3RunState, close,
};
pub use fleetd_contracts::prim::{AnyInt, Text};
pub use fleetd_contracts::secrets::{
    SecretFingerprint, SecretSinkKind, parse_secret_sink, secret_env_name,
};

use super::util::{head_utf16, tail_utf16};

/// A hub frame, or `None` for anything the TS decoder would refuse too.
pub fn decode_hub_frame(raw: &str) -> Option<HubToNode> {
    serde_json::from_str(raw).ok()
}

pub fn to_json(frame: &NodeToHub) -> String {
    serde_json::to_string(frame).unwrap_or_default()
}

/// `text` as a bounded wire string, keeping its end when it is too long (an output tail).
pub fn tail_text<const MIN: usize, const MAX: usize>(text: &str) -> Text<MIN, MAX> {
    Text::new(text).unwrap_or_else(|_| Text::unchecked(tail_utf16(text, MAX)))
}

/// `text` as a bounded wire string, keeping its start when it is too long (a message).
pub fn head_text<const MIN: usize, const MAX: usize>(text: &str) -> Text<MIN, MAX> {
    Text::new(text).unwrap_or_else(|_| Text::unchecked(head_utf16(text, MAX)))
}

pub fn exit_code(code: Option<i32>) -> Option<AnyInt> {
    code.map(|c| AnyInt::unchecked(i64::from(c)))
}
