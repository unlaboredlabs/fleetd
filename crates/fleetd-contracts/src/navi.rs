//! Navi's factory bridge (hub/navi/bridge.rs): a Navi's lead writes to another project's lead as an agent, reads the
//! factory in one call, and hears in a wake when what it asked for opens, closes, merges or fails.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::chat::{ChatAuthor, ChatMessageId};
use crate::checklist::TodoItem;
use crate::hub_links::{HubLabel, LinkedHub};
use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::{IntakeText, WorkstreamId, WorkstreamState};
use crate::prim::{Count, Int, Line};
use crate::status::{LastMerged, ProjectRowState};

brand!(
    /// "N" plus a positive integer, unique per hub: one `project_message`, e.g. "N3".
    AskHandle, name = "AskHandle", pattern = r"^N[1-9][0-9]*$"
);

/// `project_message`: Navi writes to another project's lead in its chat, as the agent "Navi <its title>", never as
/// the person. The lead reads it as input, never as the person's answer or approval.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectMessageCall {
    /// The project: its title, as factory_status names it, or its project id.
    pub project: Line<1, 200>,
    pub text: IntakeText,
    /// A linked hub, by its label: the project is there. Absent: this hub.
    pub hub: Option<HubLabel>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMessageResult {
    /// What the wakes about this message name; the project's lead passes it to `brief` as `asked`.
    pub handle: AskHandle,
    pub project_ref: ProjectRef,
    pub title: String,
    /// Why the message waits instead of reaching the lead now, when it does: it goes in as soon as it can.
    pub lead_waiting: Option<String>,
    /// The linked hub it went to, when not this one.
    pub hub: Option<HubLabel>,
    pub next: Option<String>,
}

/// `factory_status`: the other projects in one read, or the one named.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FactoryStatusCall {
    /// One project, by title or project id; absent, every project but this one.
    pub project: Option<Line<1, 200>>,
    /// A linked hub, by its label: its projects this Navi reaches through the link. Absent: this hub.
    pub hub: Option<HubLabel>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FactoryStatusResult {
    pub projects: Vec<FactoryProject>,
    /// This hub's read: the hubs this Navi is linked to, each with whether it answers.
    pub hubs: Option<Vec<LinkedHub>>,
    pub next: Option<String>,
}

/// One project as the factory sees it now.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FactoryProject {
    pub project_ref: ProjectRef,
    pub title: String,
    pub state: ProjectRowState,
    /// Blocked only: why.
    pub blocked_reason: Option<String>,
    /// A check red on main, and whether a fix is under way.
    pub warning: Option<String>,
    pub agents_running: Count,
    pub open_orders: Vec<FactoryOrder>,
    /// Its checklist items not done yet.
    pub checklist: Vec<TodoItem>,
    pub last_merged: Option<LastMerged>,
    /// Landed on its repos over the last 7 days.
    pub merged_7d: Option<Count>,
    /// This Navi's messages to it, newest first, with the orders opened for each.
    pub asks: Vec<FactoryAsk>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FactoryOrder {
    pub workstream_id: WorkstreamId,
    pub title: String,
    /// The lead's latest one-line headline for it.
    pub headline: Option<String>,
    /// The Navi message it was opened for, when one.
    pub asked: Option<AskHandle>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FactoryAsk {
    pub handle: AskHandle,
    /// Its first line, cut to 120 characters.
    pub text: String,
    pub at: Timestamp,
    pub orders: Vec<WorkstreamId>,
}

/// Hits `chat_search` returns per page, newest first.
pub const CHAT_SEARCH_PAGE: usize = 20;
/// Messages `chat_read` returns at most on each side of the one it reads around.
pub const CHAT_READ_SIDE_MAX: i64 = 10;

/// `chat_search`: a Navi searches its own chat, all of it, by words.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChatSearchCall {
    /// The words a message holds, every one of them, in any order and case: "dentist saturday".
    pub words: Line<1, 200>,
    /// From this day (2026-10-20) or time (2026-10-20T09:00:00Z), in UTC. Absent: from the chat's start.
    pub from: Option<Line<10, 40>>,
    /// Up to this day, all of it, or this time, in UTC. Absent: up to now.
    pub to: Option<Line<10, 40>>,
    /// The next page: the hits older than this message, the last one of the page before.
    pub before: Option<ChatMessageId>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChatSearchResult {
    /// Newest first, each text cut around the first of the words.
    pub messages: Vec<RecalledMessage>,
    /// Older hits are left: pass the last message's id as `before`.
    pub more: Option<bool>,
    pub next: Option<String>,
}

/// `chat_read`: the messages around one of a Navi's own chat, in order.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatReadCall {
    /// The message, by its id from chat_search.
    pub message_id: ChatMessageId,
    /// How many messages before it; absent, 5.
    pub before: Option<Int<0, CHAT_READ_SIDE_MAX>>,
    /// How many after it; absent, 5.
    pub after: Option<Int<0, CHAT_READ_SIDE_MAX>>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatReadResult {
    /// Oldest first, the one asked for among them.
    pub messages: Vec<RecalledMessage>,
    /// The chat goes on before the first of them, and after the last.
    pub more_before: bool,
    pub more_after: bool,
    pub next: Option<String>,
}

/// One message of a Navi's chat, as it reads it back.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecalledMessage {
    pub message_id: ChatMessageId,
    pub at: Timestamp,
    /// human: the person; lead: the Navi itself; agent: an agent or integration writing in; system: fleetd.
    pub author: ChatAuthor,
    /// The name it was written under: the person's device, or the agent's.
    pub by: Option<String>,
    pub text: String,
    /// The text was cut; chat_read with before and after 0 reads it whole.
    pub cut: Option<bool>,
}

/// The most asks `navi_asks` returns, newest first.
pub const NAVI_ASKS_MAX: usize = 100;

/// One ask in `navi_asks` (the app's read of a Navi's asked work): where it went, its words, and the orders opened
/// for it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NaviAsk {
    pub handle: AskHandle,
    pub to: ProjectRef,
    pub to_title: String,
    /// The Navi's words, without the line telling the lead about the handle.
    pub text: String,
    pub at: Timestamp,
    pub orders: Vec<NaviAskOrder>,
}

/// An order opened for an ask, as it stands now.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NaviAskOrder {
    pub workstream_id: WorkstreamId,
    pub title: String,
    pub state: WorkstreamState,
    /// The lead's latest one-line headline for it.
    pub headline: Option<String>,
}

/// Sent to an agent message's project lead under the text: the handle it passes to `brief` as `asked`.
pub fn ask_footer(handle: &AskHandle) -> String {
    format!(
        "(Ask {handle}. If you open an order for it, pass asked: \"{handle}\" to brief, so Navi hears when it lands.)"
    )
}
