//! Phone notifications, end-to-end encrypted (D218). A phone registers its push token and an
//! X25519 public key with the hub for its person (`push_device_register`). When something needs that person, the hub
//! seals a [`PushPayload`] to each of their devices (a libsodium sealed box) and hands the ciphertext to its push
//! relay (`fleetd push-relay`), which forwards it to APNs or FCM without ever reading it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::chat::{ChatMessageId, ChatRequestId};
use crate::ids::{MachineId, ProjectId, ThreadId, Timestamp};
use crate::prim::Line;

/// The most push devices one person registers.
pub const PUSH_DEVICES_MAX: usize = 20;
/// The most bytes of a sealed payload's JSON: with the sealed box's 48 bytes and base64, it fits APNs's and FCM's 4 KB.
pub const PUSH_PAYLOAD_MAX: usize = 2400;

brand!(
    /// "pd_" plus 8 lowercase base32 characters, unique per hub.
    PushDeviceId, name = "PushDeviceId", pattern = r"^pd_[a-z2-7]{8}$"
);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PushPlatform {
    Ios,
    Android,
}

impl PushPlatform {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ios => "ios",
            Self::Android => "android",
        }
    }
}

/// A phone that gets its person's notifications. Its token and key stay on the hub.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushDevice {
    pub device_id: PushDeviceId,
    pub platform: PushPlatform,
    pub name: Line<1, 80>,
    pub created_at: Timestamp,
    /// The last notification the relay took for it.
    pub last_sent_at: Option<Timestamp>,
}

/// What a notification is about, for the phone to pick its action.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(extend("x-open" = true))]
pub enum PushKind {
    /// A Navi's or a project lead's message in the chat.
    Message,
    /// A command, secret or other request waiting for the person's answer: `requestId` names it.
    Approval,
    /// An order landed or stopped.
    Order,
    /// Anything else the hub marks as needing the person (a machine down under running work, a usage limit).
    Alert,
}

/// What a person can do from the notification itself, as its iOS category (Android buttons). Absent: only open it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(extend("x-open" = true))]
pub enum PushCategory {
    /// Approve or Deny: an approval whose whole command or prompt is the body, and none of money, irreversible or a
    /// send (D183/D193).
    Approve,
    /// Review in the app: an approval that is shown on its full card first.
    Review,
    /// Reply into the chat: a Navi's or a lead's message.
    Reply,
}

/// The plaintext a notification seals: JSON, at most [`PUSH_PAYLOAD_MAX`] bytes. Fields are only ever added under
/// `v` 1, each optional: an app ignores the ones it doesn't know.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushPayload {
    /// 1. A phone shows its generic text for a version it doesn't know; a new field doesn't change it.
    pub v: u8,
    pub kind: PushKind,
    /// The Navi's or project's title, or "fleetd".
    pub title: String,
    /// The message's text or the event's summary, cut to fit.
    pub body: String,
    /// The hub's URL, for a phone paired with several hubs.
    pub hub: String,
    pub machine_id: Option<MachineId>,
    pub project_id: Option<ProjectId>,
    pub thread_id: Option<ThreadId>,
    pub message_id: Option<ChatMessageId>,
    pub request_id: Option<ChatRequestId>,
    /// A screen whose agent asks the person to take it over (`request_takeover`): tapping opens its live view.
    pub session_id: Option<crate::browser::BrowserSessionId>,
    /// Money or irreversible: show it even in a Focus.
    pub urgent: Option<bool>,
    /// Sent inside the hub's quiet hours: show it without a sound.
    pub quiet: Option<bool>,
    pub category: Option<PushCategory>,
    /// How many things need the person now (open requests, chats waiting on them): the app icon's badge.
    pub badge: Option<u32>,
    pub at: Timestamp,
}
