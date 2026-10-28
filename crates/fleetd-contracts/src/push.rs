//! Phone notifications, end-to-end encrypted (D218, docs/design/push.md). A phone registers its push token and an
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

/// The plaintext a notification seals: JSON, at most [`PUSH_PAYLOAD_MAX`] bytes.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushPayload {
    /// 1. A phone shows its generic text for a version it doesn't know.
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
    /// Money or irreversible: show it even in a Focus.
    pub urgent: Option<bool>,
    /// Sent inside the hub's quiet hours: show it without a sound.
    pub quiet: Option<bool>,
    pub at: Timestamp,
}
