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
use crate::prim::{Line, NonEmpty, Text};

/// Chosen by the client; echoed on the call's `result` or `error`.
pub type AppCallId = Text<1, 64>;

/// The client messages this hub reads beyond protocol 1's first set, named in `ready`'s `features`. A client sends
/// one of them only to a hub that names it, so an older hub never sees a message it can't read.
/// - `presence`: the app's once-a-minute focus and input.
/// - `browser_sessions`: browser sessions' live view and takeover. `browser_watch` and `browser_input` are read, the
///   hub relays `browser_frame`s, and the `browser_sessions`, `browser_recording_get` and `browser_control` tools and
///   the `browser.session` event exist. A machine whose node is older answers a watch or a takeover with
///   `machine_offline`.
/// - `navi_asks`: the `navi_asks` tool, a Navi's asks of other projects and the orders opened for them.
/// - `screen_open`: people open and end screens of their own (the `screen_open` and `screen_end` tools), so the app
///   shows New screen.
/// - `navi_skills`: a hub-kept skill's versions (`skill_get`'s `versions` and `version`), `skill_revert`, `skill_off`,
///   and a skill list's `changed`, `off` and `lastUsedAt`: a Navi's Skills.
///
/// The desktop app's `features.test.ts` checks that every feature it gates on is named here.
pub const APP_FEATURES: [&str; 5] = [
    "presence",
    "browser_sessions",
    "navi_asks",
    "screen_open",
    "navi_skills",
];

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
    /// Sent only to a hub whose `ready` names `presence` in its features.
    /// Once a minute while app presence is on (Settings › General, on by default): whether a window is focused,
    /// the project on screen, and whether there was input in the last minute. Only that: never keystrokes or
    /// content. A human key's minute with all three becomes an `app.presence` event; anything else is dropped.
    Presence {
        /// Chosen by the client; the hub echoes it only on the error for a frame it can't read.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<AppCallId>,
        focused: bool,
        input: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<crate::ids::ProjectRef>,
    },
    /// Sent only to a hub whose `ready` names `browser_sessions` in its features.
    /// Watch one live browser session: `browser_frame`s from now on, replacing any earlier watch; without `session`,
    /// stop. A key that can read the session's machine may watch. Send it again after a reconnect.
    BrowserWatch {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<crate::browser::BrowserSessionId>,
    },
    /// Sent only to a hub whose `ready` names `browser_sessions` in its features.
    /// A person's mouse or keys for a session they took over (`browser_control` human): a human key with operate on
    /// its machine. Refused with an `error` (no id) while the session isn't theirs to drive; never answered otherwise.
    BrowserInput {
        session: crate::browser::BrowserSessionId,
        input: crate::browser::BrowserInput,
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
        /// The newer client messages it reads ([`APP_FEATURES`]). Absent from older hubs: send them none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        features: Option<Vec<Line<1, 64>>>,
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
    /// On the browser watch only: the watched session's newest screen. Ephemeral: a slow link drops frames.
    BrowserFrame(crate::browser::BrowserFrame),
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
        // A hub that reads presence says so; one that doesn't names no features.
        let newer = json!({ "t": "ready", "protocol": 1, "features": APP_FEATURES });
        let ready: AppServerMessage = serde_json::from_value(newer.clone()).unwrap();
        assert_eq!(serde_json::to_value(&ready).unwrap(), newer);
        assert!(matches!(
            serde_json::from_value(frame).unwrap(),
            AppServerMessage::Ready { features: None, .. }
        ));

        let older = json!({ "t": "ready", "protocol": 1 });
        let ready: AppServerMessage = serde_json::from_value(older.clone()).unwrap();
        assert!(matches!(
            ready,
            AppServerMessage::Ready { version: None, .. }
        ));
        assert_eq!(serde_json::to_value(&ready).unwrap(), older);
    }

    #[test]
    fn a_presence_frame_holds_three_facts_and_nothing_else() {
        let frame = json!({
            "t": "presence",
            "id": "p1",
            "focused": true,
            "input": true,
            "project": { "machineId": "devbox", "projectId": "p1" },
        });
        let message: AppClientMessage = serde_json::from_value(frame.clone()).unwrap();
        assert_eq!(serde_json::to_value(&message).unwrap(), frame);
        // Anything else a client adds is not kept.
        let padded = json!({ "t": "presence", "focused": false, "input": false, "text": "typed" });
        let message: AppClientMessage = serde_json::from_value(padded).unwrap();
        assert_eq!(
            serde_json::to_value(&message).unwrap(),
            json!({ "t": "presence", "focused": false, "input": false })
        );
    }
}
