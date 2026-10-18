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
    /// Subscribe to `live` frames, replacing any earlier subscription: every open order's lanes when `board`, and
    /// the focused order's lanes, its project's lead and their streamed text when `focus` is set. Neither: stop.
    /// Send it again on window activation; the first frame after each one is `full`.
    Live {
        board: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        focus: Option<WorkstreamId>,
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
}
