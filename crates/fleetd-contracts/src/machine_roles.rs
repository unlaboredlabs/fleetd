//! Machine roles (W46): each machine runs agents, sessions (browsers and devices), or both, with a session cap of its
//! own, separate from its agent slots. Each node reports what it can host ([`HostCheck`], with its heartbeat's load),
//! and the hub places every session an agent starts: on the agent's own machine when it hosts sessions, can run this
//! kind and has a free session slot, else (when the hub places sessions elsewhere) on another machine that can, else a
//! plain refusal.
//!
//! A session placed elsewhere is hosted by the runner's node under a [`HostKey`] the hub mints: the agent's node
//! relays the agent's session tools to the hub ([`SessionRouteCall`]), which sends them on to the runner
//! ([`SessionHostFrame`]); the runner reports the session in the agent's name.
//!
//! What the session streams (CDP for a browser; later a device's screen) goes through a relay on the hub: the agent's
//! node connects to `/relay/<token>` with the session's [`RelayToken`], which only the hub and that node hold, and the
//! hub asks the runner's node to connect a channel of its own ([`RelayDialFrame`]) to the session's local end. The
//! hub pipes the two, frame for frame, and logs neither frames nor payloads.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::browser::{BrowserCallFrame, BrowserResultFrame};
use crate::ids::MachineId;
use crate::prim::{Count, Int, Line, List, NonEmpty};

/// What a machine is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MachineRole {
    /// It runs agents: its projects' leads and tasks.
    Agents,
    /// It hosts browser and device sessions, its own agents' and other machines'.
    Sessions,
}

impl MachineRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agents => "agents",
            Self::Sessions => "sessions",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        [Self::Agents, Self::Sessions]
            .into_iter()
            .find(|r| r.as_str() == s)
    }
}

/// A kind of session a machine can host.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum SessionHost {
    /// A fresh Chrome per session.
    #[default]
    Browser,
    /// An Android emulator: the Android SDK, with KVM on Linux.
    Android,
    /// An iOS simulator: Xcode on macOS.
    Ios,
    /// A Linux desktop: docker or Xvfb.
    Desktop,
}

impl SessionHost {
    pub const ALL: [SessionHost; 4] = [Self::Browser, Self::Android, Self::Ios, Self::Desktop];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Android => "android",
            Self::Ios => "ios",
            Self::Desktop => "desktop",
        }
    }

    /// For the sentences people read: "a browser", "an iOS simulator".
    pub fn noun(self) -> &'static str {
        match self {
            Self::Browser => "a browser",
            Self::Android => "an Android emulator",
            Self::Ios => "an iOS simulator",
            Self::Desktop => "a desktop",
        }
    }
}

/// Whether a machine can host one kind of session, and why, in plain words: "Chrome 131 at /usr/bin/google-chrome",
/// "Android SDK at ~/Android/Sdk, but no /dev/kvm".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostCheck {
    pub host: SessionHost,
    pub ready: bool,
    pub detail: Line<1, 300>,
}

/// What a node can host, one check per kind.
pub type HostChecks = List<HostCheck, 0, 4>;

/// A machine's session cap a person set.
pub type MaxSessions = Int<1, 64>;

/// A machine as Settings > Machines shows it: its roles, its session slots and what it can host.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineRolesEntry {
    pub machine_id: MachineId,
    pub name: String,
    /// Its node is linked to the hub now.
    pub online: bool,
    pub roles: List<MachineRole, 1, 2>,
    /// The sessions it hosts at once: a person's setting, else what it fits.
    pub max_sessions: Count,
    /// A person's setting; absent: auto.
    pub max_sessions_set: Option<MaxSessions>,
    /// Where `maxSessions` comes from: "set", "auto: 8 CPUs, 16 GB".
    pub max_sessions_why: Line<1, 200>,
    /// Its sessions live now, its own agents' and other machines'.
    pub sessions_live: Count,
    /// What it can host, as its node last reported; empty until it reports.
    #[serde(default)]
    pub hosts: HostChecks,
    /// Its node hosts sessions for agents on other machines (newer nodes).
    pub hosts_others: bool,
}

brand!(
    /// "H" plus 32 hex digits, minted by the hub for a session it placed on another machine than its agent's: the
    /// runner's node hosts the session under it.
    HostKey, name = "HostKey", pattern = r"^H[0-9a-f]{32}$"
);

// ---- the agent's node -> hub, as a lead call the node makes for its agent ----

/// One of an agent's session tool calls, which its node hands to the hub: `session_start` to be placed, and the rest
/// of a session the hub placed elsewhere. Refused when a process in a session sends it itself.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionRouteCall {
    /// The agent's call as its node got it, naming the agent's session.
    pub frame: BrowserCallFrame,
    #[serde(default)]
    pub host: SessionHost,
}

/// Where the call goes. `here`: the node answers it itself, the session runs on the agent's machine; else `answer` is
/// the runner's.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionRouteResult {
    pub runner: MachineId,
    pub here: bool,
    pub answer: Option<BrowserResultFrame>,
    /// The agent's side of the session's relay on the hub, in the answer to the start that placed it elsewhere: its
    /// node connects the agent's driver to `/relay/<relay>`. Held by that node alone; never given to the agent.
    pub relay: Option<RelayToken>,
}

brand!(
    /// 64 hex digits: one side of a session's relay on the hub. The hub keeps only its SHA-256.
    RelayToken, name = "RelayToken", pattern = r"^[0-9a-f]{64}$"
);

/// Where a relay's paths start on the hub.
pub const RELAY_PATH: &str = "/relay/";

/// What a relay carries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum RelayStream {
    /// A browser's DevTools protocol: the session's CDP proxy on the runner.
    #[default]
    Cdp,
}

/// Hub -> the runner's node: an agent's driver connected to a session it hosts; connect a channel to `/relay/<token>`
/// (good once, for seconds) and pipe it to the session's `stream`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelayDialFrame {
    pub host_key: HostKey,
    pub token: RelayToken,
    #[serde(default)]
    pub stream: RelayStream,
}

/// A finished command of the agent's that drove a session hosted elsewhere (`agent-browser ...`), which its node hands
/// to the hub for the runner's recording: a line in the action log, and the page after it in the trace. Masked with
/// the agent's session's secrets before it leaves the agent's machine.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionStepCall {
    pub thread_id: crate::ids::ThreadId,
    /// Boxed: every lead call frame is as large as its largest call.
    pub item: Box<crate::sessions::ThreadItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionStepResult {
    /// It went to the runner: the agent's session has one hosted elsewhere.
    pub forwarded: bool,
}

// ---- hub -> the runner's node, and back ----

/// A session tool call the runner's node answers for an agent on another machine, as for one of its own sessions
/// named `hostKey`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionHostFrame {
    pub id: NonEmpty,
    pub host_key: HostKey,
    pub frame: BrowserCallFrame,
}

/// Hub -> the runner's node: a step of the agent's for the recording of the session it hosts under `hostKey`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionStepFrame {
    pub host_key: HostKey,
    pub item: crate::sessions::ThreadItem,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionHostResult {
    pub id: NonEmpty,
    pub frame: BrowserResultFrame,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roles_and_hosts_read_back_from_their_names() {
        for r in [MachineRole::Agents, MachineRole::Sessions] {
            assert_eq!(MachineRole::parse(r.as_str()), Some(r));
            assert_eq!(serde_json::to_value(r).unwrap(), json!(r.as_str()));
        }
        for h in SessionHost::ALL {
            assert_eq!(serde_json::to_value(h).unwrap(), json!(h.as_str()));
        }
    }

    #[test]
    fn a_route_call_is_for_a_browser_unless_it_says_otherwise() {
        let call: SessionRouteCall = serde_json::from_value(json!({
            "frame": { "id": "1", "cwd": "/w", "call": { "op": "session_end" }, "threadId": "t1" }
        }))
        .unwrap();
        assert_eq!(call.host, SessionHost::Browser);
    }
}
