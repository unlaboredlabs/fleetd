//! Hub links (D194): a Navi on one hub opens and follows work in projects on another. On the other hub ("there"), a
//! person mints a link key that acts as them, at their grants there, optionally limited to chosen projects. The hub
//! with the Navi ("here") keeps it sealed and calls `/link/v1` there with it. Either side revokes it.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::IntakeText;
use crate::mcp::McpToolError;
use crate::navi::AskHandle;
use crate::people::PersonRef;
use crate::prim::Line;

brand!(
    /// "hl_" plus 8 lowercase base32 characters, unique per hub: a link minted on this hub or kept on it.
    HubLinkId, name = "HubLinkId", pattern = r"^hl_[a-z2-7]{8}$"
);

/// A free-text name for the other hub ("personal", "acme"), chosen by the person: what the Navi passes as `hub`.
pub type HubLabel = Line<1, 40>;

/// The prefix every link key starts with, before 52 lowercase base32 characters.
pub const LINK_KEY_PREFIX: &str = "flk_";
/// The longest a feed read waits for news, in seconds.
pub const FEED_WAIT_MAX_SEC: u64 = 25;

/// What `/link/v1` answers when it refuses. `dead` comes only with 401, for a key that is dead for good: unknown to the
/// hub, revoked, expired, or its person removed. Only that makes the hub with the Navi mark the link revoked; any other
/// refusal, a store failure (500) or a 401 without it leaves the link as it was.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LinkRefusal {
    #[serde(flatten)]
    pub error: McpToolError,
    pub dead: Option<bool>,
}

/// A link minted on this hub, as its person and the hub's admins see it. The key itself is shown once, at minting.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IssuedLink {
    pub link_id: HubLinkId,
    /// What the person called the hub it is for; requests through it read "asked via <label> Navi".
    pub label: HubLabel,
    /// "flk_" plus the first 6 characters of the key's body.
    pub prefix: String,
    /// The projects it reaches; absent: every project its person reaches.
    pub projects: Option<Vec<ProjectRef>>,
    /// The device that minted it. The link acts as its person, at their role, and stops when they leave the hub; a
    /// link from before people acts at this device's grants and dies with it.
    pub key_id: String,
    pub device: String,
    /// Its person, on a hub with people.
    pub person: Option<PersonRef>,
    pub created_at: Timestamp,
    pub last_used_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-open" = true))]
pub enum HubLinkState {
    /// The last call there went through.
    Ok,
    /// The last call there didn't: the other hub is down or this hub can't reach it.
    Unreachable,
    /// The other hub refused the key: revoked or expired there, or its person removed.
    Revoked,
}

/// A link this hub keeps for one of its Navis. The key stays sealed in the hub; nothing returns it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HubLink {
    pub link_id: HubLinkId,
    pub navi: ProjectRef,
    pub label: HubLabel,
    /// The other hub's URL: https, or http over a tailnet or this machine.
    pub url: String,
    pub state: HubLinkState,
    /// Why it is unreachable or revoked, in the words the person reads.
    pub error: Option<String>,
    pub checked_at: Option<Timestamp>,
    pub created_at: Timestamp,
}

/// One project a link reaches.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LinkProject {
    pub project_ref: ProjectRef,
    pub title: String,
}

/// `GET /link/v1/hello`: the link as the other hub sees it, and where its feed starts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LinkHello {
    pub label: HubLabel,
    pub projects: Vec<LinkProject>,
    /// The event log head there: the feed's first `after`.
    pub cursor: i64,
}

/// `POST /link/v1/ask`: `project_message` through the link.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LinkAskCall {
    pub project: Line<1, 200>,
    pub text: IntakeText,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LinkAskResult {
    /// The ask's handle there.
    pub handle: AskHandle,
    pub project_ref: ProjectRef,
    pub title: String,
    pub lead_waiting: Option<String>,
}

/// `GET /link/v1/feed?after=<cursor>&wait=<sec>`: what happened to the link's asks since `after`, waiting up to
/// `wait` seconds for some.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LinkFeed {
    pub cursor: i64,
    pub more: bool,
    pub items: Vec<LinkFeedItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LinkFeedItem {
    /// The ask's handle there.
    pub handle: AskHandle,
    /// The project's title there.
    pub title: String,
    /// "its lead opened order W3 \"Gift cards\"", "PR #42 (acme/shop) of order W3 merged", ….
    pub what: String,
}

/// A linked hub as `factory_status` lists it for the Navi.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LinkedHub {
    pub label: HubLabel,
    pub state: HubLinkState,
    pub error: Option<String>,
}
