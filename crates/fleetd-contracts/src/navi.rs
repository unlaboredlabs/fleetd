//! Navi's factory bridge (hub/navi/bridge.rs): a Navi's lead writes to another project's lead as an agent, reads the
//! factory in one call, and hears in a wake when what it asked for opens, closes, merges or fails.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::brand;
use crate::checklist::TodoItem;
use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::{IntakeText, WorkstreamId};
use crate::prim::{Count, Line};
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
    pub next: Option<String>,
}

/// `factory_status`: the other projects in one read, or the one named.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FactoryStatusCall {
    /// One project, by title or project id; absent, every project but this one.
    pub project: Option<Line<1, 200>>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FactoryStatusResult {
    pub projects: Vec<FactoryProject>,
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

/// Sent to an agent message's project lead under the text: the handle it passes to `brief` as `asked`.
pub fn ask_footer(handle: &AskHandle) -> String {
    format!(
        "(Ask {handle}. If you open an order for it, pass asked: \"{handle}\" to brief, so Navi hears when it lands.)"
    )
}
