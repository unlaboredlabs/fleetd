//! App WebSocket at /app: JSON, one message per frame, discriminated by "t".

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::events::HubEvent;
use crate::hello::ProtocolVersion;
use crate::ids::EventSeq;
use crate::ledger::WorkstreamId;
use crate::live::LiveFrame;
use crate::mcp::{ErrorCode, FleetStatus};
use crate::prim::{NonEmpty, Text};

/// Chosen by the client; echoed on the call's `result` or `error`.
pub type AppCallId = Text<1, 64>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "t", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AppClientMessage {
    Auth {
        key: NonEmpty,
    },
    Snapshot {},
    /// Stream HubEvents after `cursor` as they happen.
    Events {
        cursor: EventSeq,
    },
    /// Call one MCP tool with the session's key: same tools, grants and limits as /mcp. `input` is the tool's input;
    /// answered by a `result` or an `error` carrying the same `id`.
    Call {
        id: AppCallId,
        tool: NonEmpty,
        input: serde_json::Value,
    },
    /// Subscribe to `live` frames, replacing any earlier subscription: every agent's lane (each running, queued or
    /// waiting task and each project's lead) when `board`; the focused order's lanes, its project's lead and their
    /// streamed text when `focus` is set; and one agent's lane and streamed text, at the focus rate, when `agent` is
    /// set (an `agents_list` row's `laneId`). None of them: stop. Send it again on window activation; the first frame
    /// after each one is `full`.
    Live {
        board: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        focus: Option<WorkstreamId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<crate::live::LaneId>,
    },
    /// Subscribe to `chat_delta` frames of one project's chat, replacing any earlier one; without `project`, stop.
    /// Send it again after a reconnect.
    Chat {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<crate::ids::ProjectRef>,
    },
}

/// A `call` failed, or (without `id`) the session did.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AppError {
    /// Present when this answers a `call`.
    pub id: Option<AppCallId>,
    pub code: ErrorCode,
    pub message: String,
    pub fix: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "t", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AppServerMessage {
    /// Sent once the key is accepted.
    Ready {
        protocol: ProtocolVersion,
        /// The hub's fleetd version, as hub_info reports it. Absent from older hubs.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    /// Answer to `snapshot`: the fleetd_status data.
    Snapshot(FleetStatus),
    Event(HubEvent),
    /// A `call` succeeded; `output` is the tool's output.
    Result {
        id: AppCallId,
        output: serde_json::Value,
    },
    Error(AppError),
    /// On the live subscription only. Ephemeral: a slow link drops intermediate frames.
    Live(LiveFrame),
    /// On the chat subscription only: the lead's reply as it streams. Ephemeral and never replayed.
    ChatDelta(crate::chat::ChatDelta),
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn ready_carries_the_hub_version_and_reads_an_older_hubs_frame() {
        let frame =
            json!({ "t": "ready", "protocol": 1, "version": "0.0.0-nightly.202610221107+333368c" });
        let ready: AppServerMessage = serde_json::from_value(frame.clone()).unwrap();
        assert_eq!(serde_json::to_value(&ready).unwrap(), frame);

        let older = json!({ "t": "ready", "protocol": 1 });
        let ready: AppServerMessage = serde_json::from_value(older.clone()).unwrap();
        assert!(matches!(
            ready,
            AppServerMessage::Ready { version: None, .. }
        ));
        assert_eq!(serde_json::to_value(&ready).unwrap(), older);
    }
}
