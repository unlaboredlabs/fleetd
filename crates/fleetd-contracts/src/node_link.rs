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
use crate::ids::{MachineId, ProjectId, ThreadId, Timestamp};
use crate::lead_calls::{LeadCallFrame, LeadResultFrame};
use crate::ledger::{DecisionKey, EnvName, GatedArgv, GatedCwd, GatedTimeoutSec, SecretEnv};
use crate::model::SleptSpan;
use crate::prim::{AnyInt, Count, Int, List, NonEmpty, NonNegative, Text};
use crate::secrets::{BoxPublicKey, SealedSecret, SecretFingerprint, SecretSink};
use crate::sessions::{
    CloneProgressFrame, MachineEventFrame, SessionCallFrame, SessionReplyFrame, ThreadEventFrame,
};
use crate::tasks::AbsolutePath;

/// WebSocket close codes the hub ends a link with.
pub mod close {
    /// A handshake frame that does not decode or arrives out of order, compressed data that does not inflate, or more
    /// frames that do not decode than a link takes in a minute. One such frame alone is refused, not the link.
    pub const BAD_FRAME: u16 = 4000;
    /// Bad signature, unknown key, or an invalid, used or expired enroll token. Retrying will not help.
    pub const UNAUTHORIZED: u16 = 4001;
    /// The two sides speak different protocol versions. Retrying will not help.
    pub const PROTOCOL_MISMATCH: u16 = 4002;
    /// A newer link for the same machine took over.
    pub const REPLACED: u16 = 4003;
    /// No frame for 45 s.
    pub const HEARTBEAT_TIMEOUT: u16 = 4008;
    /// WebSocket's "Service Restart": the hub is stopping (an update, a restart) and comes back within a moment, so the
    /// node redials every 250 ms for a minute rather than back off.
    pub const RESTART: u16 = 1012;
    /// The longest close reason a WebSocket carries; the hub cuts a longer one short.
    pub const REASON_MAX_BYTES: usize = 123;
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
    /// Always empty: machines have no tags. Kept for older hubs, which require the list.
    #[serde(default)]
    pub tags: Vec<String>,
    pub node_version: String,
    pub protocol: ProtocolVersion,
    /// ed25519 public key, base64.
    pub pub_key: NonEmpty,
    /// Signature over the hub's challenge nonce (its UTF-8 bytes), base64.
    pub sig: NonEmpty,
    /// One-time token from `fleetd pair --worker` or `machine add`; sent only until the hub has registered `pub_key`.
    pub enroll_token: Option<NonEmpty>,
    /// M8: the X25519 key the desktop app seals this machine's secrets to. Absent on nodes from before M8.
    pub box_pub_key: Option<BoxPublicKey>,
    /// Calls this node understands beyond the protocol's base set, e.g. [`CAP_REPOS`]. A node drops its link on a
    /// frame it can't decode, so the hub sends newer calls only to nodes that list them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    /// A hash of the OS's id for this computer (`/etc/machine-id`, `IOPlatformUUID`): the hub never enrolls a second
    /// computer under a machine id that is already another's. Absent from older nodes and OSes without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_fingerprint: Option<String>,
}

/// `repo_scan`, `repo_inspect`, `repo_clone` and `gh_repo_list` (adding a project).
pub const CAP_REPOS: &str = "repos";

/// `SessionWorkspace::Detached`: read and review tasks in a worktree of their own. An older node gets `Root`.
pub const CAP_DETACHED: &str = "detached_worktree";

/// `landed_log` (factory metrics for a repo whose host fleetd can't read).
pub const CAP_LANDED_LOG: &str = "landed_log";

/// `project_env`, `project_worktrees`, and `project_remove` with `removeWorktrees` (a project's settings).
pub const CAP_PROJECT_SETTINGS: &str = "project_settings";

/// `project_env_copy`: a project's variables copied to a repo checkout it holds (W79).
pub const CAP_PROJECT_ENV_COPY: &str = "project_env_copy";

/// The node takes `mcp_secrets` and `mcp_test`, and a launch's and a send's MCP servers.
pub const CAP_MCP_SERVERS: &str = "mcp_servers";

/// `skills_list` (a project's repo skills, for Settings → Skills). Hub-kept skills ride on `launch`, which an older
/// node ignores.
pub const CAP_SKILLS: &str = "skills";

/// `has_file`: whether a file under the project's `.fleetd/attachments/` already holds given bytes, so the hub sends
/// a held chat message's files once rather than on every retry. An older node gets every file each time.
pub const CAP_HAS_FILE: &str = "has_file";

/// `order:` secret sinks and `order_env_drop` (a variable for one order's agents), and the masking of a session's own
/// fleetd tool calls.
pub const CAP_ORDER_ENV: &str = "order_env";

/// `SessionLaunch::setup`: a project's setup commands, run in each new worktree before its agent starts.
pub const CAP_WORKTREE_SETUP: &str = "worktree_setup";

/// `SessionLaunch::allowed_only`: the node holds a session to its allowed tools. A node without it would start the
/// session with every runtime tool claude lets run unasked (reading its folder among them), so the hub starts such a
/// session only on a node that lists it.
pub const CAP_ALLOWED_ONLY: &str = "allowed_only";

/// `SessionLaunch::isolated`: an empty folder of the node's own and user settings only, for a turn whose input must
/// be the hub's alone. The hub runs a Navi's approval checker only on a node that lists it.
pub const CAP_ISOLATED: &str = "isolated";

/// Browser sessions' live view and takeover: `browser_watch`, `browser_input` and `browser_control`, and the node's
/// `browser_frame`s.
pub const CAP_BROWSER: &str = "browser";

/// The node hosts android sessions now (`session_start` with kind android): KVM is usable and its pinned Android SDK,
/// emulator image, agent-device and scrcpy server are installed. Listed at each link's hello, so a node that finishes
/// installing lists it from its next link; [`NodeLoad::android`] says why a node doesn't.
pub const CAP_SESSION_ANDROID: &str = "session_android";

/// The node hosts iOS sessions now (`session_start` with kind ios): Xcode's simctl works, an iOS runtime is installed,
/// and the node's golden simulator, with agent-device's runner built for it, is made. Listed at each link's hello;
/// [`NodeLoad::ios`] says why a node doesn't.
pub const CAP_SESSION_IOS: &str = "session_ios";

/// The node hosts Linux desktop sessions now (`session_start` with kind linux_desktop): its container runtime has the
/// pinned image, or it has an Xvfb. Listed at each link's hello; [`NodeLoad::desktop`] says why a node doesn't.
pub const CAP_SESSION_DESKTOP: &str = "session_linux_desktop";

/// `node_action` `update`: the node updates itself to a build its hub names. A node without it drops the link on
/// the frame, so the hub asks only nodes that list it.
pub const CAP_SELF_UPDATE: &str = "self_update";

/// `claude_install`: the node takes `node_action` `claude`, and brings its Claude Code to a version with `claude install`.
pub const CAP_CLAUDE_INSTALL: &str = "claude_install";

/// `claude_login`: the node takes `node_action` `claude_login` and `claude_login_code`, and logs its Claude Code in with
/// `claude auth login`, the person signing in on their own device (Settings › Hub › Machines).
pub const CAP_CLAUDE_LOGIN: &str = "claude_login";

/// `update_fetch`: the node takes `node_action` `fetch`, and downloads the hub's next build while the hub updates.
pub const CAP_UPDATE_FETCH: &str = "update_fetch";

/// `update_hold`: the node takes `node_action` `hold`: it holds its agents' tool calls that haven't started yet, so they
/// reach a step's end before its update's restart, and answers how many are still mid-step.
pub const CAP_UPDATE_HOLD: &str = "update_hold";

/// `session_host`: the node hosts sessions for agents on other machines (machine_roles.rs).
pub const CAP_SESSION_HOST: &str = "session_host";

/// `SessionRole::Assistant` (a Navi's lead) and a relative `project_upsert` root under the node's home (its folder).
pub const CAP_ASSISTANT: &str = "assistant";

/// `navi_signins`: a Navi's browser sessions keep its own profile between sessions, and the node takes
/// `navi_signins_forget`, which deletes it (D221).
pub const CAP_NAVI_SIGNINS: &str = "navi_signins";

/// `folder_make`: the node makes a new project's folder (and `git init`s it when asked).
pub const CAP_FOLDER_MAKE: &str = "folder_make";

/// `session_end`: the node takes [`SessionEndFrame`], and ends an agent session's screen when the hub says its task
/// ended.
pub const CAP_SESSION_END: &str = "session_end";

/// The node seals its agents' session secrets and relay key to the machine that will host a session, and opens what
/// is sealed to it: the hub places sessions across machines only between nodes that list it.
pub const CAP_SESSION_SEAL: &str = "session_seal";

/// The node keeps Claude accounts' secrets (`claude_account_secret`, `claude_account_test`) and runs a launch's
/// `claudeAccount` on them (teams step 8).
pub const CAP_CLAUDE_ACCOUNTS: &str = "claude_accounts";

/// The node seals a Claude account's secret it holds to another machine's box key (`claude_account_reseal`): a cloud
/// machine gets the hub's Claude configuration from a machine that holds it, through the hub as ciphertext only.
pub const CAP_CLAUDE_RESEAL: &str = "claude_reseal";

/// The node keeps people's 1Password tokens (`onepassword_token`, `onepassword_test`) and gives a launch's
/// `onepassword` person's token to its fill_credential when its project and order have none.
pub const CAP_ONEPASSWORD: &str = "onepassword";

/// The node lists a person's 1Password Credit Card items (`onepassword_cards`) and fills an approved purchase's card
/// (`purchase_request`, `purchase_fill`; D265).
pub const CAP_ONEPASSWORD_CARDS: &str = "onepassword_cards";

/// `claude_models`: the node lists the models the hub's API key offers, for the profiles' model picker.
pub const CAP_CLAUDE_MODELS: &str = "claude_models";

/// The node takes a launch's profile by any name, effort `xhigh` and `fast` (W146). The hub sends an older one `high`
/// or `medium` and an effort it knows.
pub const CAP_PROFILE_NAMES: &str = "profile_names";

/// The node passes a launch's `systemPrompt` to its runner at every start of the session (W218).
pub const CAP_SYSTEM_PROMPT: &str = "system_prompt";

/// `node_action` `screens`: the node turns a kind of screen on or off and sets their idle timeout in its node.json, from
/// Settings › Hub › Machines › Screens (W268).
pub const CAP_SCREEN_SETTINGS: &str = "screen_settings";

/// `project_remove` with `erase` (and `removeFolder`): the node deletes a Navi's sessions, Claude Code's transcripts of
/// them and the attachments in its folder, and the folder itself when asked (D287 navi.delete-erases).
pub const CAP_NAVI_ERASE: &str = "navi_erase";

/// `project_remove` erases any project as it does a Navi (D310): its sessions, transcripts and attachments, and with
/// `removeFolder` its folder, wherever it is but the person's home, the node's, a folder above either, or one holding
/// another project.
pub const CAP_PROJECT_ERASE: &str = "project_erase";

/// A purchase or a 1Password secure input the hub opens already approved (D310) is filled at once: the node tells its
/// lead to fill now rather than wait for an answer. To a node that doesn't list it, the hub still asks the person.
pub const CAP_NO_ASK_FILL: &str = "no_ask_fill";

/// A person's browser screen for any project on its own machine runs on the profile that project keeps (D310): the
/// hub names a project that isn't a Navi in `session_host` only to a node listing it.
pub const CAP_PROJECT_SIGNINS: &str = "project_signins";

/// Every lead runs in `manual` permission mode without a sandbox (D310): the node allows unasked what a full-access
/// lead does (`LEAD_ALLOWED`), answers its commands itself, and sends only a fetch, a first site visit and a send on to
/// the hub; the assistant role is a lead that does its own work (a project with no repo). The hub starts every lead
/// so on a node listing it, and as before on one that doesn't.
pub const CAP_ONE_LEAD_MODE: &str = "one_lead_mode";

/// `mac_tool`: the node is the agents' Mac (D298), a macOS node, in any account (D309), with the Mac turned on.
/// It takes `mac_call`, and the hub sends agents' `fleetd mac` steps to the online node that lists it.
pub const CAP_MAC_TOOL: &str = "mac_tool";

/// The node is the agents' Mac (D298: node.json's `agentsMac`, which only the installer's `--mac` sets): a tool, never a
/// runner. It runs no claude and no Navis, takes no sealed secret, and lists none of the calls that carry them; the hub
/// keeps its agents role off whatever the setting. Listed whatever its checks say (`mac_tool` only while they pass), so
/// the hub knows the machine even while its tool is off.
pub const CAP_AGENTS_MAC: &str = "agents_mac";

/// `link_deflate`: the node inflates the hub's compressed frames. A compressed frame is a Binary message of RFC 7692
/// permessage-deflate data with context takeover (one raw-DEFLATE stream per direction per link, each message
/// sync-flushed without its trailing `00 00 ff ff`); a Text message is always plain JSON. The hub compresses only
/// after a hello that lists this, and an older node never sees one. The hub lists [`HUB_CAP_LINK_DEFLATE`] for the
/// other direction.
pub const CAP_LINK_DEFLATE: &str = "link_deflate";

/// The node runs the Rust build of its `nodeVersion` (docs/cutover/bun.md), and takes [`NodeUpdate::flavour`]. A node
/// that lists neither this nor [`CAP_BUILD_BUN`] is older and says nothing of its flavour.
pub const CAP_BUILD_RUST: &str = "build_rust";

/// The node runs the Bun build of its `nodeVersion` (experimental/bun), and takes [`NodeUpdate::flavour`].
pub const CAP_BUILD_BUN: &str = "build_bun";

/// `gated_run` with `requestId`: an approved command outlives a dropped link and the node's result of it is kept on disk,
/// so the hub asks for it with `gated_resume` once the link is back, after its own restart too.
pub const CAP_GATED_RESUME: &str = "gated_resume";

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HubWelcome {
    pub hub_id: String,
    pub protocol: ProtocolVersion,
    pub nonce: Option<String>,
    /// Calls this hub takes beyond the protocol's base set, e.g. [`HUB_CAP_SESSION_ROUTE`]. An older hub drops the
    /// link on a frame it can't decode, so the node sends newer calls only to hubs that list them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
}

/// The hub takes `session_route`, and places every session an agent starts (machine_roles.rs).
pub const HUB_CAP_SESSION_ROUTE: &str = "session_route";

/// The hub inflates the node's compressed frames ([`CAP_LINK_DEFLATE`] says how): the node compresses only after a
/// welcome that lists this.
pub const HUB_CAP_LINK_DEFLATE: &str = "link_deflate";

/// Both directions every 15 s; a link silent for 45 s is offline.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Heartbeat {
    pub at: Timestamp,
    /// Node -> hub only; absent from older nodes and when the machine's figures can't be read.
    pub load: Option<NodeLoad>,
    /// Node -> hub only: the latest step of each session live here, newest first. Absent from older nodes.
    #[serde(default, skip_serializing_if = "<[_]>::is_empty")]
    pub steps: List<crate::browser::ScreenStep, 0, { crate::browser::SCREEN_STEPS_MAX }>,
    /// Node -> hub only: what keeps the machine busy now. Absent from older nodes.
    pub busy: Option<NodeBusy>,
}

/// What keeps a machine busy, as its node counts it at each heartbeat. A cloud machine is idle, and may be stopped,
/// only while every count is 0 (hub/pool); nothing in it is lost by a stop, it only waits for the next wake.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeBusy {
    /// Agent sessions with a run going.
    pub threads: u32,
    /// Screens live here: browsers, Android emulators, iOS simulators and desktops, its own agents' and others'.
    pub screens: u32,
    /// Screen recordings that ended within [`UPLOAD_BUSY_SECS`] and wait to reach the hub. An older one goes at a later
    /// wake, so it doesn't keep the machine up.
    pub uploads: u32,
    /// Of `screens`, those hosted here for agents on other machines.
    pub hosted: u32,
}

impl NodeBusy {
    /// Nothing runs, nothing is live and nothing waits to upload.
    pub fn idle(&self) -> bool {
        self.threads == 0 && self.screens == 0 && self.uploads == 0 && self.hosted == 0
    }
}

/// How long an ended recording that hasn't reached the hub keeps its machine busy.
pub const UPLOAD_BUSY_SECS: u64 = 30 * 60;

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
    /// Physical memory; absent from older nodes and when it can't be read.
    pub mem_total_bytes: Option<Count>,
    /// Memory to allow per agent when sizing the machine's cap: an older node's node.json `memPerAgentGb`, or its
    /// 2 GB default. A node now sends none: the hub sizes it.
    pub mem_per_agent_bytes: Option<Count>,
    /// Disk to allow per new agent's worktree: an older node's node.json `diskPerAgentGb`, or its 5 GB default. A
    /// node now sends none: the hub counts 5 GB.
    pub disk_per_agent_bytes: Option<Count>,
    /// The latest claude.ai subscription limit of each type claude reported. Empty behind API keys and gateways,
    /// which send none.
    #[serde(default)]
    pub limits: List<LoginLimit, 0, 4>,
    /// The volume holding the node's worktrees and build cache; absent from older nodes and when it can't be read.
    pub disk: Option<NodeDisk>,
    /// Whether the machine's own network hardware holds an IPv4 address; absent off Linux, on a machine with no network
    /// hardware of its own (a container), and from older nodes.
    pub network: Option<NodeNetwork>,
    /// What the machine can host for sessions (a browser, an Android emulator, an iOS simulator, a desktop); absent
    /// from older nodes.
    pub hosts: Option<crate::machine_roles::HostChecks>,
    /// Whether the machine can host android sessions; absent where node.json turns them off and from older nodes.
    pub android: Option<AndroidHealth>,
    /// Whether the machine can host iOS sessions; absent off macOS, where node.json turns them off, on a Mac without
    /// Xcode that didn't opt in, and from older nodes.
    pub ios: Option<IosHealth>,
    /// Whether the machine can host Linux desktop sessions, and in what; absent where node.json turns them off and
    /// from older nodes.
    pub desktop: Option<DesktopHealth>,
    /// The agents' Mac's setup checks, run by its node as its own user with no admin; absent on any other machine and
    /// from older nodes.
    pub mac: Option<MacHealth>,
}

/// One setup check of the agents' Mac (docs: agents-mac.md), named as the doctor shows it: `<machine>/mac_<id>`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum MacCheckId {
    /// Legacy: older nodes checked their user was a standard one. The Mac may run in any account now, an admin's
    /// included (D309); these four are read from an older node and shown, but no longer in [`MacCheckId::ALL`].
    StandardUser,
    /// Legacy: no other user's home under /Users opened for it.
    OtherHomes,
    /// Legacy: no Apple ID was signed in for it.
    NoAppleId,
    /// Legacy: it held no FileVault secure token.
    NoSecureToken,
    /// It is in `_developer`, so simulators and debugging need no admin prompt.
    Developer,
    /// A full Xcode is selected, its licence accepted and its first launch run.
    Xcode,
    /// An iOS simulator runtime is installed.
    IosRuntime,
    /// The node may control the computer (Accessibility).
    Accessibility,
    /// The node may record the screen (Screen Recording).
    ScreenRecording,
    /// Its GUI session is the one on the Mac's screen: "console", or "background" behind another user's.
    GuiSession,
    /// The node's pinned Node.js, agent-device and agent-desktop are installed.
    Tools,
    /// The node holds its keep-awake assertion.
    KeepAwake,
}

impl MacCheckId {
    /// The checks a node runs now, in the order the guide shows them.
    pub const ALL: [MacCheckId; 8] = [
        Self::Developer,
        Self::Xcode,
        Self::IosRuntime,
        Self::Accessibility,
        Self::ScreenRecording,
        Self::GuiSession,
        Self::Tools,
        Self::KeepAwake,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::StandardUser => "standard_user",
            Self::OtherHomes => "other_homes",
            Self::NoAppleId => "no_apple_id",
            Self::NoSecureToken => "no_secure_token",
            Self::Developer => "developer",
            Self::Xcode => "xcode",
            Self::IosRuntime => "ios_runtime",
            Self::Accessibility => "accessibility",
            Self::ScreenRecording => "screen_recording",
            Self::GuiSession => "gui_session",
            Self::Tools => "tools",
            Self::KeepAwake => "keep_awake",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum MacCheckState {
    Ok,
    /// Works, short of what's recommended (a GUI session in the background).
    Warn,
    Fail,
    /// The node couldn't tell, or is still at it (installing its tools).
    Unknown,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MacCheck {
    pub id: MacCheckId,
    pub state: MacCheckState,
    /// Plain words: what the node found.
    pub message: Text<0, 500>,
    /// What the person does about it, and where: in their own (admin) account, or at the Mac, in the account it joined from.
    pub fix: Option<Text<0, 300>>,
    /// The exact command `fix` runs, to paste where it says, when there is one.
    pub command: Option<Text<0, 300>>,
}

/// The agents' Mac's setup, as its node checked it last (each heartbeat reads the quick checks again; the slow ones,
/// such as Xcode's, every few minutes and on a Test).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MacHealth {
    /// The macOS user the node runs as.
    pub user: Text<1, 64>,
    pub checks: List<MacCheck, 0, 16>,
}

/// Where a node's iOS sessions stand, for the doctor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum IosState {
    /// The golden simulator is made: sessions start.
    Ready,
    /// Xcode and an iOS runtime work, but the machine isn't opted in: node.json's `ios.enabled` makes the golden.
    Wanted,
    /// Making the golden simulator: one boot left to settle, and agent-device's runner built for it.
    Preparing,
    /// Can't run here until a person fixes something (no Xcode, no iOS runtime, no Node.js, or the golden failed).
    Unavailable,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IosHealth {
    pub state: IosState,
    /// Plain words: the runtime and device sessions use, or what is wrong.
    pub message: Text<0, 500>,
    /// The command a person runs to fix it, when there is one.
    pub fix: Option<Text<0, 500>>,
}

/// Where a node's android sessions stand, for the doctor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum AndroidState {
    /// Installed, with KVM usable: sessions start.
    Ready,
    /// Not installed yet; the first android `session_start` installs it.
    Wanted,
    Installing,
    /// Can't run here until a person fixes something (no KVM, or the install failed).
    Unavailable,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AndroidHealth {
    pub state: AndroidState,
    /// Plain words: what is installed, or what is wrong.
    pub message: Text<0, 500>,
    /// The command a person runs to fix it, when there is one.
    pub fix: Option<Text<0, 500>>,
}

/// Where a node's Linux desktop sessions stand, for the doctor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum DesktopState {
    Ready,
    /// The container runtime is building the pinned image.
    Preparing,
    /// Neither a container runtime nor an Xvfb, or the image failed to build.
    Unavailable,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHealth {
    pub state: DesktopState,
    /// What sessions run in: a container where the node has docker or podman, else Xvfb.
    pub backend: Option<crate::browser::DesktopBackend>,
    /// Plain words: what sessions use, or what is missing.
    pub message: Text<0, 500>,
    /// The command a person runs to fix it, when there is one.
    pub fix: Option<Text<0, 500>>,
}

/// Space on the volume holding a node's worktrees and build cache.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeDisk {
    /// Free for the node's user.
    pub free_bytes: Count,
    pub total_bytes: Count,
    /// Below this the hub starts no new agents there: node.json's `minFreeGb`, else 10% of the volume or 20 GB,
    /// whichever is larger.
    pub min_free_bytes: Count,
}

/// The machine's IPv4, as its node reads its network interfaces (node/network.rs): only those of its own hardware
/// count, not loopback, tunnels (Tailscale), bridges or containers' veths.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeNetwork {
    /// One of them holds a routable IPv4 address: not 169.254.x link-local, which is what's left when DHCP times out.
    pub ipv4: bool,
    /// While `ipv4` is false, the interface to bring back: the one holding a link-local address, else the first.
    pub iface: Option<Text<1, 64>>,
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
    pub timeout_sec: GatedTimeoutSec,
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
    /// An env: or order: sink's variable; absent means `secret_env_name(secret_key)`.
    pub env_name: Option<EnvName>,
    /// An order: sink's project, whose agents the order's are. Only nodes listing [`CAP_ORDER_ENV`] get one.
    pub project_id: Option<ProjectId>,
    /// A fill: sink's request (a Navi's secure input): the one field of its browser session this value fills.
    pub request_id: Option<crate::chat::ChatRequestId>,
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
    /// The approval it runs for. A node listing [`CAP_GATED_RESUME`] keeps the run going and its result kept under it
    /// when the link drops, for a `gated_resume`; it never runs one request twice.
    pub request_id: Option<crate::chat::ChatRequestId>,
}

/// Hub -> node, only to nodes listing [`CAP_GATED_RESUME`]: the result of the approved command it ran for
/// `requestId`, whose `gated_result` the hub lost to a dropped link or its own restart. Answered by a `gated_result`
/// once the command ends, at once when it already did, and with `unknown` when the node has no result for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatedResume {
    pub id: NonEmpty,
    pub request_id: crate::chat::ChatRequestId,
    pub timeout_sec: GatedTimeoutSec,
}

/// Node -> hub, one per `gated_run` or `gated_resume`.
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
    /// Only answering a `gated_resume`: why the node has no result for it (it restarted while the command ran, or
    /// never got it). The command may have run.
    pub unknown: Option<FrameError>,
}

/// `probe` reads the commit email the node's service uses and the free space on the filesystem holding its home
/// directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NodeActionKind {
    Probe,
    /// Install `update.version` of `update.channel`, checked against the release's SHA256SUMS, then restart the
    /// node's service; the previous binary comes back if the new one doesn't come up. Answered before the restart.
    Update,
    /// Download `update.version` of `update.channel` and check it against the release's SHA256SUMS, for the `update`
    /// that follows once the hub runs it; nothing is installed or restarted. Answered at once, before the download.
    /// Only for a node that lists [`CAP_UPDATE_FETCH`].
    Fetch,
    /// Bring the machine's Claude Code to `claude` with `claude install`, and keep its own background update off.
    /// Nothing restarts: sessions running keep the binary they started with, new ones start on the new one. A failed
    /// install keeps the version there was. Answered once done. Only for a node that lists [`CAP_CLAUDE_INSTALL`].
    Claude,
    /// Start `claude auth login` with the runner's environment, and answer with the sign-in URL it prints
    /// (`login_url`). The login waits for its code, at most 10 minutes; a new one replaces it. Only for a node that
    /// lists [`CAP_CLAUDE_LOGIN`].
    ClaudeLogin,
    /// Give the waiting login the code its sign-in page showed (`code`), and answer once it has ended. Claude Code
    /// keeps its token on the machine: it never comes back. Only for a node that lists [`CAP_CLAUDE_LOGIN`].
    ClaudeLoginCode,
    /// Ahead of `update`: hold every agent's tool call that hasn't started yet, for [`HOLD_LEASE_SECS`] from now, so
    /// the restart finds its agents between steps; the tool calls already running carry on. Answered at once with how
    /// many sessions are still mid-step (`steps`). Only for a node that lists [`CAP_UPDATE_HOLD`].
    Hold,
    /// Write `screens` into the node's node.json: a kind of screen turned on (which installs what it needs, as the
    /// file's own opt-in does) or off, or the idle timeout of every kind. The node restarts itself to apply it once no
    /// screen is live there. Answered at once with the machine's host checks as they are now (`hosts`). Only for a
    /// node that lists [`CAP_SCREEN_SETTINGS`].
    Screens,
}

/// Hub -> node: M11 doctor's probe, and the hub's update of its nodes.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NodeAction {
    pub id: NonEmpty,
    pub action: NodeActionKind,
    /// `update` and `fetch` only.
    pub update: Option<NodeUpdate>,
    /// `claude` only: the Claude Code version to install, as `claude --version` prints its number.
    pub claude: Option<Text<1, 40>>,
    /// `claude_login_code` only: the code the sign-in page showed.
    pub code: Option<Text<1, 500>>,
    /// `screens` only.
    pub screens: Option<crate::machine_roles::ScreenSettings>,
    /// `hold` only: when the node's sessions carry on through its restart (its answer's `hosted`), hold nothing, and
    /// count only the sessions mid-step that aren't hosted (a Navi's); else hold every one, as without it. An older
    /// node ignores it and holds every one, answering no `hosted`.
    pub unhosted: Option<bool>,
}

/// How long a `hold` lasts unless the hub asks again: a hub that stops asking (it went away, the update ended without
/// a restart) lets every held tool call go within it.
pub const HOLD_LEASE_SECS: u64 = 60;

/// The build a node updates to: what its hub runs now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NodeUpdate {
    pub version: Text<1, 200>,
    /// Edge goes out as `nightly`, its name before D203: a node from then refuses a channel it doesn't know, and every
    /// node reads `nightly` as edge. Its release, `nightly`, keeps the newest edge build for them.
    #[serde(serialize_with = "edge_as_nightly")]
    pub channel: crate::mcp::HubChannel,
    /// The build's flavour: the hub's own. A node on the other one switches to it; one from before ignores it and
    /// installs its own flavour of `version`, then, listing [`CAP_BUILD_RUST`] or [`CAP_BUILD_BUN`], takes it next.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flavour: Option<BuildFlavour>,
}

/// Which implementation a fleetd build is: the Rust one, or the Bun/TypeScript port. A release ships both of each
/// version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum BuildFlavour {
    Rust,
    Bun,
    /// A flavour this build doesn't know (a newer hub). Never sent.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

fn edge_as_nightly<S: serde::Serializer>(
    channel: &crate::mcp::HubChannel,
    to: S,
) -> Result<S::Ok, S::Error> {
    match channel {
        crate::mcp::HubChannel::Edge => to.serialize_str("nightly"),
        other => other.serialize(to),
    }
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
    /// `update` that failed: where. Nothing was changed.
    pub stage: Option<crate::mcp::UpdateStage>,
    /// `claude_login` that started: where the person signs in.
    pub login_url: Option<Text<1, 4000>>,
    /// `hold`: the sessions still mid-step, a tool call of theirs running; with `unhosted` and `hosted`, only those not
    /// hosted.
    pub steps: Option<u32>,
    /// `hold` with `unhosted`: the host protocol of the node's session hosts (runner/host.rs), when each runs in a
    /// systemd scope of its own that outlives the node, so its agent carries on through the restart. Absent without
    /// scopes (their hosts die with the node), and from an older node. A hub whose build speaks another host protocol
    /// holds every agent, as the restarted node won't take the hosts back.
    pub hosted: Option<u32>,
    /// `screens`: what the machine can host with the new settings.
    pub hosts: Option<crate::machine_roles::HostChecks>,
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
    /// A watched browser session's screen; only while the hub watches it.
    BrowserFrame(crate::browser::BrowserFrame),
    SessionHostResult(crate::machine_roles::SessionHostResult),
    MacResult(crate::mac::MacResultFrame),
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
    /// Only to nodes listing [`CAP_GATED_RESUME`].
    GatedResume(GatedResume),
    NodeAction(NodeAction),
    SessionCall(SessionCallFrame),
    SpansAck(SpansAck),
    /// Only to nodes listing [`CAP_BROWSER`].
    BrowserWatch(crate::browser::BrowserWatchFrame),
    BrowserInput(crate::browser::BrowserInputFrame),
    BrowserControl(crate::browser::BrowserControlFrame),
    /// Only to nodes that list [`CAP_SESSION_HOST`].
    SessionHost(crate::machine_roles::SessionHostFrame),
    /// Only to the node that lists [`CAP_MAC_TOOL`].
    MacCall(crate::mac::MacCallFrame),
    /// Only to nodes that list [`CAP_SESSION_HOST`].
    RelayDial(crate::machine_roles::RelayDialFrame),
    /// Only to nodes that list [`CAP_SESSION_HOST`].
    SessionStep(crate::machine_roles::SessionStepFrame),
    /// Only to nodes that list [`CAP_SESSION_END`].
    SessionEnd(SessionEndFrame),
}

/// Hub -> node: the task of the agent session `threadId` ended, and its screen `sessionId` is still live on the hub:
/// the node ends that screen (a browser, a device, a desktop; one hosted elsewhere too) and kills its processes.
/// Nothing when the agent session no longer holds it; any other screen of it stays.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionEndFrame {
    pub thread_id: ThreadId,
    pub session_id: crate::browser::BrowserSessionId,
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
    fn an_edge_update_reaches_a_node_from_before_edge_as_nightly() {
        use crate::mcp::HubChannel;
        let update = NodeUpdate {
            version: Text::unchecked("0.0.0-edge.202610271703+bd87c55".to_owned()),
            channel: HubChannel::Edge,
            flavour: None,
        };
        let sent = serde_json::to_value(&update).unwrap();
        assert_eq!(sent["channel"], "nightly");
        assert_eq!(serde_json::from_value::<NodeUpdate>(sent).unwrap(), update);
        let stable = NodeUpdate {
            channel: HubChannel::Stable,
            ..update
        };
        assert_eq!(serde_json::to_value(&stable).unwrap()["channel"], "stable");
    }

    /// A node from before flavours reads an update naming one as it always did, and a flavour it doesn't know (a newer
    /// hub's) isn't a frame it can't decode.
    #[test]
    fn an_update_names_its_flavour_and_older_nodes_read_it_still() {
        let bun =
            r#"{"version":"0.0.0-edge.202611091200+aaaaaaa","channel":"nightly","flavour":"bun"}"#;
        let update: NodeUpdate = serde_json::from_str(bun).unwrap();
        assert_eq!(update.flavour, Some(BuildFlavour::Bun));
        assert_eq!(serde_json::to_string(&update).unwrap(), bun);
        let newer =
            r#"{"version":"0.0.0-edge.202611091200+aaaaaaa","channel":"nightly","flavour":"zig"}"#;
        assert_eq!(
            serde_json::from_str::<NodeUpdate>(newer).unwrap().flavour,
            Some(BuildFlavour::Unknown)
        );
        let none = serde_json::to_value(NodeUpdate {
            flavour: None,
            ..update
        })
        .unwrap();
        assert!(none.get("flavour").is_none());
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
    fn an_older_nodes_swap_and_memory_pressure_figures_are_ignored() {
        let load: NodeLoad = serde_json::from_str(
            r#"{"cpus":32,"load1":3.5,"memUsedPct":41,"swapUsedPct":100,"memPressurePct":23.45}"#,
        )
        .unwrap();
        assert_eq!(load.mem_used_pct, Some(Int::unchecked(41)));
        let sent = serde_json::to_value(&load).unwrap();
        assert!(sent.get("swapUsedPct").is_none() && sent.get("memPressurePct").is_none());
    }
}
