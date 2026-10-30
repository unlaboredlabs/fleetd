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

/// What a session drives: a fresh Chrome with an empty profile (`browser`, driven with agent-browser), or a fresh
/// `-read-only` copy of an Android emulator booted from its Quick Boot snapshot (`android`, driven with agent-device at
/// the copy's serial), a fresh clone of an iOS simulator from the node's settled golden device (`ios`, driven with
/// agent-device at the clone's udid), or an X display of its own with a window manager (`linux_desktop`, driven with
/// the agent's `desktop` tool), in a fresh container or else beside a fresh home directory. Every kind shares the
/// session tools, the action log, the video and the hub's storage; only a browser recording has a `dom` file, and an
/// iOS one's video is `video_mp4`. A node hosts android sessions when it lists the `session_android` capability, iOS
/// ones when it lists `session_ios`, and desktop ones when it lists `session_linux_desktop`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum SessionKind {
    #[default]
    Browser,
    Android,
    Ios,
    LinuxDesktop,
}

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Android => "android",
            Self::Ios => "ios",
            Self::LinuxDesktop => "linux_desktop",
        }
    }
}

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
    /// `video.mp4`: H.264 from the iOS simulator's own recording (`simctl io recordVideo`), in its screen's pixels.
    VideoMp4,
}

impl RecordingFile {
    pub const ALL: [RecordingFile; 4] = [Self::Actions, Self::Dom, Self::Video, Self::VideoMp4];

    pub fn file_name(self) -> &'static str {
        match self {
            Self::Actions => "actions.jsonl",
            Self::Dom => "dom.jsonl",
            Self::Video => "video.webm",
            Self::VideoMp4 => "video.mp4",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Actions => "actions",
            Self::Dom => "dom",
            Self::Video => "video",
            Self::VideoMp4 => "video_mp4",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Actions | Self::Dom => "application/x-ndjson",
            Self::Video => "video/webm",
            Self::VideoMp4 => "video/mp4",
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
    #[serde(default)]
    pub kind: SessionKind,
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
    /// The person who opened it themselves (`screen_open`): a person's screen, theirs to drive from its start. Absent
    /// for an agent's.
    pub opened_by: Option<crate::people::PersonRef>,
}

/// A person's `screen_open` waiting for a slot on a full machine: it takes the next one free there, ahead of every
/// agent's start, and gives up after [`SCREEN_WAIT_MINUTES`].
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScreenWait {
    pub wait_id: NonEmpty,
    pub project_ref: ProjectRef,
    pub kind: SessionKind,
    pub machine_id: crate::ids::MachineId,
    pub since: Timestamp,
    /// People's waits for that machine before this one.
    pub ahead: Count,
    /// The PR whose build goes into the screen when it opens.
    pub pr: Option<ScreenPr>,
}

/// A PR of the project's for a person's screen (`screen_open`): its CI build is installed in an iOS or Android screen
/// before the person gets it. The build is the newest artifact of a CI run on the PR's head whose name says `ios` (a
/// zipped simulator `.app`) or `android`/`apk` (an `.apk`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPr {
    pub repo: crate::train::GitHubRepo,
    pub number: crate::prim::Positive,
}

/// How long a person's wait for a slot lasts before the hub gives it up.
pub const SCREEN_WAIT_MINUTES: i64 = 30;

/// One line of `actions.jsonl`: a tool call of the agent's that drove the browser (an `agent-browser` command, a
/// session tool), or a person's step (`takeover`, `handback`; their input is not logged key by key).
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
    /// The element the step clicked or typed into, as the node saw it just before; absent for a step that did
    /// neither.
    pub target: Option<StepTarget>,
}

/// The element a step acted on: the one under its click, or the one focused when it typed. The node reads it over
/// its own connection just before the driver's input reaches the page.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StepTarget {
    /// The ref the agent named it by in its command (`@e3`), when it used one.
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    /// A CSS selector for it in the page as it was: from the nearest ancestor with an id, by tag and position.
    pub selector: String,
    /// Chrome's id for its DOM node (`backendNodeId`), stable for the page's life.
    pub backend_node_id: Option<u64>,
    /// Where it was on screen, in the video frame's pixels (1280×800, the live view's too).
    pub frame_box: Option<FrameBox>,
}

/// A rectangle in the frame's pixels, from its top left corner.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FrameBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// One line of `dom.jsonl`: the page's HTML as the node's own connection read it after the action `seq`, scrubbed.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DomSnapshot {
    pub seq: u64,
    pub offset_ms: u64,
    pub url: String,
    pub title: String,
    pub html: String,
    /// The element step `seq` acted on, as its action line has it: outline its `frameBox` on the video at the step's
    /// `offsetMs`, and find its `selector` in `html`.
    pub target: Option<StepTarget>,
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
    #[serde(default)]
    pub kind: SessionKind,
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
    Desktop(DesktopCall),
    Device(DeviceCall),
}

impl BrowserCall {
    pub fn op(&self) -> &'static str {
        match self {
            Self::SessionStart(_) => "session_start",
            Self::SessionEnd(_) => "session_end",
            Self::FillCredential(_) => "fill_credential",
            Self::RequestTakeover(_) => "request_takeover",
            Self::Desktop(_) => "desktop",
            Self::Device(_) => "device",
        }
    }
}

/// `device`: an agent-device command for the agent's iOS screen on another machine than its own, which its node sends
/// through the hub to the node hosting the screen (node/device/remote.rs). The agent's `agent-device` asks for a `run`
/// with its arguments; its node sends the files the command reads first (`put`, a piece at a time), the command as
/// the screen's node will run it, then fetches the files it wrote (`get`). Never a tool: the agent's node refuses a
/// `put` or `get` from a process in the session. Between the two nodes each step goes `sealed`, so the hub carries
/// ciphertext alone, and the screen's node runs nothing that doesn't open.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum DeviceCall {
    Run {
        args: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Put {
        name: String,
        /// The file's bytes on the screen's node so far: each piece follows the last.
        offset: u64,
        data_b64: String,
    },
    Get {
        name: String,
        offset: u64,
    },
    /// Another step, sealed with the session's relay key: `count` numbers the agent's steps, each above the last.
    #[serde(rename_all = "camelCase")]
    Sealed {
        count: u64,
        data_b64: String,
    },
}

/// A `device` step's answer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum DeviceDone {
    #[serde(rename_all = "camelCase")]
    Run {
        stdout: String,
        stderr: String,
        exit_code: i32,
        /// The files the command wrote, for `get`.
        files: Vec<DeviceFile>,
    },
    Put {
        bytes: u64,
    },
    /// One piece; the file is gone from the screen's node once its last piece was read.
    #[serde(rename_all = "camelCase")]
    Get {
        data_b64: String,
        total: u64,
    },
    /// The answer to a sealed step, sealed back under its count.
    #[serde(rename_all = "camelCase")]
    Sealed {
        data_b64: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DeviceFile {
    pub name: String,
    pub bytes: u64,
}

/// `session_start`: a fresh Chrome with an empty profile (or with `kind` android, a fresh Android emulator; `ios`, a
/// fresh iOS simulator), for this agent only, recorded until `session_end`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStartCall {
    /// What you need the browser for, in one line; the person replaying it sees it.
    pub purpose: BrowserPurpose,
    /// `android` for an Android emulator, `ios` for an iOS simulator, each driven with agent-device; `linux_desktop`
    /// for a Linux desktop, driven with the `desktop` tool; absent for a browser.
    pub kind: Option<SessionKind>,
}

/// `session_end`: closes the browser and throws its profile away; the recording goes to the hub.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionEndCall {}

/// `fill_credential`: the node reads a 1Password reference and types its value into the page, only on the item's own
/// website, then submits the field's form in the same step; the value never comes back. From the first fill on, the
/// session refuses whatever would read a filled value back.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FillCredentialCall {
    /// A 1Password secret reference: `op://<vault>/<item>/<field>`, `?attribute=otp` for a one-time code.
    #[serde(rename = "ref")]
    pub reference: OpReference,
    /// The field to fill: a CSS selector (`input[name=password]`, `#otp`).
    pub target: Text<1, 500>,
    /// False to fill without submitting, for a field before the last of its form (a username before its password).
    /// Absent: true.
    pub submit: Option<bool>,
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

/// `desktop`: one action on the agent's Linux desktop session, in the words of Anthropic's computer-use tool, plus
/// `launch`. Coordinates are in the screenshot's pixels.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DesktopCall {
    pub action: DesktopAction,
    /// `[x, y]`: where to click, move the mouse to, scroll at, or end a drag.
    pub coordinate: Option<[Int<0, 8192>; 2]>,
    /// `[x, y]`: where a `left_click_drag` starts.
    pub start_coordinate: Option<[Int<0, 8192>; 2]>,
    /// `type`: the text. `key`: keys as xdotool names them, `+` between those pressed together (`Return`,
    /// `ctrl+s`, `alt+F4`). `launch`: a shell command started on the desktop (`xterm`, `./target/debug/app`).
    pub text: Option<Text<1, 10_000>>,
    pub scroll_direction: Option<ScrollDirection>,
    /// Wheel clicks; absent: 3.
    pub scroll_amount: Option<Int<1, 50>>,
    /// `wait`: seconds; absent: 1.
    pub duration: Option<Int<1, 30>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DesktopAction {
    Screenshot,
    LeftClick,
    RightClick,
    MiddleClick,
    DoubleClick,
    TripleClick,
    MouseMove,
    LeftClickDrag,
    Type,
    Key,
    Scroll,
    Wait,
    CursorPosition,
    Launch,
}

impl DesktopAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Screenshot => "screenshot",
            Self::LeftClick => "left_click",
            Self::RightClick => "right_click",
            Self::MiddleClick => "middle_click",
            Self::DoubleClick => "double_click",
            Self::TripleClick => "triple_click",
            Self::MouseMove => "mouse_move",
            Self::LeftClickDrag => "left_click_drag",
            Self::Type => "type",
            Self::Key => "key",
            Self::Scroll => "scroll",
            Self::Wait => "wait",
            Self::CursorPosition => "cursor_position",
            Self::Launch => "launch",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

/// Where a desktop session's apps run: in a fresh container of the node's pinned image (docker or podman), or as the
/// node's user on an Xvfb display of their own with a fresh home directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum DesktopBackend {
    Container,
    Xvfb,
}

impl DesktopBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Container => "container",
            Self::Xvfb => "xvfb",
        }
    }
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
    Desktop(DesktopDone),
    Device(DeviceDone),
}

/// The session's browser, ready for the agent's `agent-browser`; or its emulator, ready for `agent-device`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionStarted {
    pub session_id: BrowserSessionId,
    /// A browser's: the node's CDP proxy for this agent's session, as its `AGENT_BROWSER_CDP` already names it.
    pub cdp: Option<Text<1, 200>>,
    /// An emulator's adb serial (`emulator-5554`), which the session's agent-device config already names.
    pub serial: Option<Text<1, 100>>,
    /// A simulator's udid, which the session's agent-device config already names.
    pub udid: Option<Text<1, 100>>,
    /// A desktop's: where its apps run.
    pub desktop: Option<DesktopBackend>,
    /// A desktop container's: the agent's worktree, read-only at this path in it.
    pub worktree: Option<Text<1, 4096>>,
    pub start_ms: u64,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionEnded {
    pub session_id: BrowserSessionId,
    #[serde(default)]
    pub kind: SessionKind,
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

/// A desktop action done: what happened, and for `screenshot` the screen.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDone {
    pub message: String,
    /// A JPEG, base64.
    pub jpeg_b64: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverRequested {
    pub message: String,
}

// ---- live view and takeover: the app <-> the hub (app.rs `browser_watch`, `browser_input`, `browser_frame`), the
// hub <-> the node (node_link.rs), and `browser_control` ----

/// One screencast frame of a live session, for the person watching. Ephemeral: the hub keeps only the newest per
/// session, and a slow link skips frames rather than queueing them.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFrame {
    pub session_id: BrowserSessionId,
    /// 1, 2, ... per watch; a frame older than one already shown is dropped.
    pub seq: u64,
    /// A JPEG, base64.
    pub jpeg_b64: NonEmpty,
    /// The image's size in pixels: `browser_input` coordinates are in it.
    pub width: Int<1, 8192>,
    pub height: Int<1, 8192>,
    /// The page the frame shows, when the node knows it.
    pub url: Option<Text<0, 2000>>,
    pub control: BrowserControl,
}

/// A mouse button, as CDP names it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    #[default]
    None,
    Left,
    Middle,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MouseAction {
    Pressed,
    Released,
    Moved,
    Wheel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum KeyAction {
    Down,
    Up,
}

/// Alt 1, Ctrl 2, Meta 4, Shift 8, summed, as CDP's `modifiers`.
pub type Modifiers = Int<0, 15>;

/// A person's input to a session they have control of (`control` human). Coordinates are in the last frame's pixels;
/// the node scales them to the page.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum BrowserInput {
    Mouse {
        action: MouseAction,
        x: f64,
        y: f64,
        #[serde(default)]
        button: MouseButton,
        /// 1 for a click, 2 for a double click.
        #[serde(default)]
        click_count: Int<0, 3>,
        #[serde(default)]
        delta_x: f64,
        #[serde(default)]
        delta_y: f64,
        #[serde(default)]
        modifiers: Modifiers,
    },
    /// A key as the browser's `KeyboardEvent` names it (`key` "Enter", `code` "Enter"); `text` for one that types.
    Key {
        action: KeyAction,
        key: Text<1, 64>,
        code: Option<Text<1, 64>>,
        text: Option<Text<1, 16>>,
        #[serde(default)]
        modifiers: Modifiers,
    },
    /// Text typed or pasted at once.
    Text { text: Text<1, 10_000> },
}

/// Who should drive a live session: `human` takes it over from the agent; `agent` hands it back, and the session is
/// `handing_back` until the agent's next command, which sees the page as the person left it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BrowserControlTo {
    Human,
    Agent,
}

/// The node's lead call for an agent's `request_takeover`: the hub lists it under "waiting on you" until a person
/// takes control or the session ends.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTakeoverCall {
    pub session_id: BrowserSessionId,
    pub reason: Line<1, 500>,
}

/// Hub -> node: the frames of a session, from now on (`on`) or no more.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWatchFrame {
    pub session_id: BrowserSessionId,
    pub on: bool,
}

/// Hub -> node: a person's input, or a change of control, for a session.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInputFrame {
    pub session_id: BrowserSessionId,
    pub input: BrowserInput,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlFrame {
    pub session_id: BrowserSessionId,
    pub control: BrowserControlTo,
    /// "human:<device>", for the action log.
    pub by: Text<1, 200>,
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
