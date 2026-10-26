//! Browser sessions (W46): an agent starts one with `session_start`, drives a fresh Chrome of its own with the
//! `agent-browser` CLI (which its node points at the session through a CDP proxy of its own), and ends it with
//! `session_end`. The node records the session from its own connection to the browser (a video from the screencast,
//! the page's DOM after each step, one action-log line per tool call that drove it), scrubs every secret it knows from
//! the text before anything leaves the machine, and uploads the recording to the hub, which keeps it for
//! `browser_sessions` and `browser_recording_get` until retention (30 days or 20 GB per project by default,
//! `browser_retention_set`) drops it.
//!
//! Three wires carry it:
//! - the agent's fleetd tools and its node, on the node's socket: [`BrowserCallFrame`] and [`BrowserResultFrame`];
//! - the node and the hub, as lead calls the node makes for the session: [`BrowserSessionCall`] and
//!   [`BrowserRecordingPartCall`] (refused when a process in a session sends one itself);
//! - the hub and the app: the `browser_*` tools and the `browser.session` event ([`BrowserSessionEventData`]).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{ProjectRef, ThreadId, Timestamp};
use crate::mcp::McpToolError;
use crate::prim::{Count, Int, Line, List, NonEmpty, Text};
use crate::tasks::{AbsolutePath, TaskId};
use crate::{brand, checked};

brand!(
    /// "B" plus 32 hex digits, minted by the node when the session starts: unique per hub.
    BrowserSessionId, name = "BrowserSessionId", pattern = r"^B[0-9a-f]{32}$"
);

/// What the agent opened the session for, in one line ("Check the signup form on staging").
pub type BrowserPurpose = Line<1, 200>;

/// Where a session is. live → uploading → recorded; lost when the node could not record or upload it; expired once
/// retention deleted its recording (its row stays).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum BrowserSessionState {
    Live,
    Uploading,
    Recorded,
    Lost,
    Expired,
}

impl BrowserSessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Uploading => "uploading",
            Self::Recorded => "recorded",
            Self::Lost => "lost",
            Self::Expired => "expired",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        [
            Self::Live,
            Self::Uploading,
            Self::Recorded,
            Self::Lost,
            Self::Expired,
        ]
        .into_iter()
        .find(|state| state.as_str() == s)
    }
}

/// Who drives a live session's browser. A person takes it over (human) and hands it back (handing_back, until the
/// agent's next tool call sees the page as the person left it, then agent). While it isn't the agent's, the agent's
/// browser tools answer that a person has control.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum BrowserControl {
    #[default]
    Agent,
    Human,
    HandingBack,
}

/// The files of a recording, each scrubbed on the node before upload.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum RecordingFile {
    /// `actions.jsonl`: one [`BrowserAction`] per line, in order.
    Actions,
    /// `dom.jsonl`: one [`DomSnapshot`] per line, after each step that changed the page.
    Dom,
    /// `video.webm`: VP9 from the node's own screencast of the page, 1280×800. Absent when the node has no ffmpeg.
    Video,
}

impl RecordingFile {
    pub const ALL: [RecordingFile; 3] = [Self::Actions, Self::Dom, Self::Video];

    pub fn file_name(self) -> &'static str {
        match self {
            Self::Actions => "actions.jsonl",
            Self::Dom => "dom.jsonl",
            Self::Video => "video.webm",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Actions => "actions",
            Self::Dom => "dom",
            Self::Video => "video",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Actions | Self::Dom => "application/x-ndjson",
            Self::Video => "video/webm",
        }
    }
}

/// A stored file of a recording.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRecordingEntry {
    pub file: RecordingFile,
    pub bytes: Count,
}

/// One session as the hub keeps it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSession {
    pub session_id: BrowserSessionId,
    pub project_ref: ProjectRef,
    /// The agent's session (its thread on the project's machine).
    pub thread_id: ThreadId,
    /// The task whose agent opened it; absent for the project's lead.
    pub task_id: Option<TaskId>,
    pub purpose: BrowserPurpose,
    pub state: BrowserSessionState,
    pub control: BrowserControl,
    pub started_at: Timestamp,
    pub ended_at: Option<Timestamp>,
    /// The recording's files on the hub; empty until it is recorded, and again once it expired.
    #[serde(default)]
    pub files: List<BrowserRecordingEntry, 0, 3>,
    /// What the agent said it needs a person for, while it waits for one (`request_takeover`).
    pub takeover_reason: Option<Line<1, 500>>,
    /// How many logins the node filled from 1Password; never their values.
    #[serde(default)]
    pub credentials_filled: Count,
    /// Why a session is lost, or what its recording lacks ("no video: this machine has no ffmpeg").
    pub note: Option<Text<0, 500>>,
}

/// One line of `actions.jsonl`: a tool call of the agent's that drove the browser (an `agent-browser` command, a
/// session tool), or a person's takeover step.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAction {
    /// 1, 2, ... in the order the calls started.
    pub seq: u64,
    pub at: Timestamp,
    /// From the session's start: where the call is in the video.
    pub offset_ms: u64,
    /// `agent-browser` for a command (its words in `args.command`), or fleetd's step (`session_start`,
    /// `fill_credential`, `takeover`, ...).
    pub tool: String,
    /// The call's arguments, scrubbed.
    pub args: serde_json::Value,
    pub ok: bool,
    /// The start of the result's text, scrubbed.
    pub result: Option<String>,
    pub duration_ms: u64,
    /// The page after it, when the node could read it.
    pub url: Option<String>,
}

/// One line of `dom.jsonl`: the page's HTML as the node's own connection read it after the action `seq`, scrubbed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DomSnapshot {
    pub seq: u64,
    pub offset_ms: u64,
    pub url: String,
    pub title: String,
    pub html: String,
}

/// How long the hub keeps recordings: each for `retentionDays`, and a project's together up to `maxGbPerProject`
/// (its oldest go first).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRetention {
    pub retention_days: BrowserRetentionDays,
    pub max_gb_per_project: BrowserMaxGb,
}

pub type BrowserRetentionDays = Int<1, 365>;
pub type BrowserMaxGb = Int<1, 10_000>;

pub const DEFAULT_RETENTION_DAYS: i64 = 30;
pub const DEFAULT_MAX_GB_PER_PROJECT: i64 = 20;

/// The piece of a recording one `browser_recording_get` returns, and the node uploads per call, decoded.
pub const RECORDING_PART_BYTES: usize = 512 * 1024;

/// `browser.session`: a session started, changed hands, ended or its recording landed. The rest comes from
/// `browser_sessions`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionEventData {
    pub project_ref: ProjectRef,
    pub session_id: BrowserSessionId,
    pub state: BrowserSessionState,
    pub control: BrowserControl,
    pub task_id: Option<TaskId>,
}

// ---- node -> hub, as lead calls the node makes on a session's behalf ----

/// The session as the node has it now: sent when it starts, when its state or control changes, and when its
/// recording is uploaded (`recorded`, with its files) or can't be (`lost`, with a note).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionCall {
    pub session_id: BrowserSessionId,
    /// The agent's session the browser is for.
    pub thread_id: ThreadId,
    pub purpose: BrowserPurpose,
    pub state: BrowserSessionState,
    #[serde(default)]
    pub control: BrowserControl,
    pub started_at: Timestamp,
    pub ended_at: Option<Timestamp>,
    #[serde(default)]
    pub files: List<BrowserRecordingEntry, 0, 3>,
    #[serde(default)]
    pub credentials_filled: Count,
    pub note: Option<Text<0, 500>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionResult {
    pub session_id: BrowserSessionId,
    pub state: BrowserSessionState,
}

/// One piece of a recording's file, in order from offset 0. A piece at an offset the hub already has is taken again
/// (a retry after a dropped answer); one past it is refused.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRecordingPartCall {
    pub session_id: BrowserSessionId,
    pub file: RecordingFile,
    pub offset: Count,
    /// At most [`RECORDING_PART_BYTES`] decoded.
    pub data_b64: NonEmpty,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRecordingPartResult {
    pub session_id: BrowserSessionId,
    pub file: RecordingFile,
    /// The file's bytes on the hub after this piece.
    pub bytes: Count,
}

// ---- the agent's browser-mcp <-> its node, on the node's socket ----

/// A browser tool call of an agent's (`fleetd agent-mcp`); the node names the session it comes from by the calling
/// process, as for a lead call, and answers it itself.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCallFrame {
    pub id: NonEmpty,
    /// The caller's working directory: the node's calls to the hub for the session go out from it.
    pub cwd: AbsolutePath,
    pub call: BrowserCall,
    pub thread_id: Option<ThreadId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BrowserCall {
    SessionStart(SessionStartCall),
    SessionEnd(SessionEndCall),
    FillCredential(FillCredentialCall),
    RequestTakeover(RequestTakeoverCall),
}

impl BrowserCall {
    pub fn op(&self) -> &'static str {
        match self {
            Self::SessionStart(_) => "session_start",
            Self::SessionEnd(_) => "session_end",
            Self::FillCredential(_) => "fill_credential",
            Self::RequestTakeover(_) => "request_takeover",
        }
    }
}

/// `session_start`: a fresh Chrome with an empty profile, for this agent only, recorded until `session_end`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStartCall {
    /// What you need the browser for, in one line; the person replaying it sees it.
    pub purpose: BrowserPurpose,
}

/// `session_end`: closes the browser and throws its profile away; the recording goes to the hub.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionEndCall {}

/// `fill_credential`: the node reads a 1Password reference and types its value into the page; the value never comes
/// back.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FillCredentialCall {
    /// A 1Password secret reference: `op://<vault>/<item>/<field>`, `?attribute=otp` for a one-time code.
    #[serde(rename = "ref")]
    pub reference: OpReference,
    /// The field to fill: a CSS selector (`input[name=password]`, `#otp`).
    pub target: Text<1, 500>,
}

brand!(
    /// A 1Password secret reference, `op://vault/item/field` or `op://vault/item/section/field`, optionally
    /// `?attribute=otp` (or another attribute).
    OpReference, name = "OpReference", pattern = r"^op://[^/?\r\n]+/[^/?\r\n]+(/[^/?\r\n]+){1,2}(\?attribute=[a-z]+)?$"
);

/// `request_takeover`: ask a person to take the browser over (a captcha, a confirmation only they can give). It shows
/// under "waiting on you"; the agent carries on, and its browser tools answer that a person has control until they
/// hand it back.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RequestTakeoverCall {
    /// What the person should do, in one line.
    pub reason: Line<1, 500>,
}

/// The node's answer, on the socket. Exactly one of `result` and `error`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self")]
pub struct BrowserResultFrame {
    pub id: NonEmpty,
    pub result: Option<BrowserCallResult>,
    pub error: Option<McpToolError>,
}
checked!(BrowserResultFrame, |frame| {
    if frame.result.is_none() == frame.error.is_none() {
        return Err("exactly one of result and error".into());
    }
    Ok(())
});

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BrowserCallResult {
    SessionStart(SessionStarted),
    SessionEnd(SessionEnded),
    FillCredential(Filled),
    RequestTakeover(TakeoverRequested),
}

/// The session's browser, ready for the agent's `agent-browser`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionStarted {
    pub session_id: BrowserSessionId,
    /// The node's CDP proxy for this agent's session, as its `AGENT_BROWSER_CDP` already names it.
    pub cdp: Text<1, 200>,
    pub start_ms: u64,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionEnded {
    pub session_id: BrowserSessionId,
    /// The recording's files as the node will upload them.
    pub files: Vec<BrowserRecordingEntry>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Filled {
    /// What was filled, never with the value: "Filled input[name=password] from op://Team/Shop/password."
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverRequested {
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn op_references_name_a_field_and_may_ask_for_its_one_time_code() {
        for ok in [
            "op://Team/Shop/password",
            "op://Team/Shop login/username",
            "op://Team/Shop/Security/one-time password?attribute=otp",
        ] {
            let decoded = serde_json::from_value::<FillCredentialCall>(
                json!({ "ref": ok, "target": "#field" }),
            );
            assert!(decoded.is_ok(), "{ok}");
        }
        for bad in [
            "op://Team",
            "op://Team/Shop",
            "https://Team/Shop/password",
            "op://Team/Shop/a/b/c",
        ] {
            assert!(
                serde_json::from_value::<FillCredentialCall>(json!({ "ref": bad, "target": "#f" }))
                    .is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_result_frame_carries_exactly_one_of_result_and_error() {
        let ok =
            json!({ "id": "1", "result": { "op": "takeover_requested_never", "message": "x" } });
        assert!(
            serde_json::from_value::<BrowserResultFrame>(ok).is_err(),
            "an unknown op"
        );
        let ok = json!({ "id": "1", "result": { "op": "request_takeover", "message": "x" } });
        assert!(serde_json::from_value::<BrowserResultFrame>(ok).is_ok());
        let neither = json!({ "id": "1" });
        assert!(serde_json::from_value::<BrowserResultFrame>(neither).is_err());
    }

    #[test]
    fn states_read_back_from_their_names() {
        for s in [
            BrowserSessionState::Live,
            BrowserSessionState::Uploading,
            BrowserSessionState::Recorded,
            BrowserSessionState::Lost,
            BrowserSessionState::Expired,
        ] {
            assert_eq!(BrowserSessionState::parse(s.as_str()), Some(s));
            assert_eq!(serde_json::to_value(s).unwrap(), json!(s.as_str()));
        }
    }
}
