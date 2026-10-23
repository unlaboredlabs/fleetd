//! The agents view: every agent across the projects a key may read (`agents_list`), and one agent's recent steps and
//! text (`agent_work`).
//!
//! Both are reads. `agents_list` is refetched on the durable events that change who runs (task, lead and PR events);
//! the live values of each row (status, what it is doing, tokens) arrive on the live subscription's board lanes,
//! keyed by the row's `laneId`. `agent_work` is refetched on its thread's events; `live { agent }` streams that one
//! agent's text as it is written.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::live::AgentLane;
use crate::mcp::TailRole;
use crate::model::ActionItem;
use crate::prim::{NonEmpty, Text};

/// The most rows `agents_list` answers.
pub const AGENTS_MAX: usize = 100;
/// The most steps one `agent_work` page holds.
pub const WORK_PAGE_MAX: usize = 40;
/// The hub keeps an encoded `agent_work` page under this; a page that would pass it ends early with `before` set.
pub const WORK_PAGE_MAX_BYTES: usize = 48 * 1024;

/// One agent: a task, or a project's lead, with its project.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentRow {
    /// Role, title, status, model, startedAt, its PR, and live values at read time.
    #[serde(flatten)]
    pub lane: AgentLane,
    pub project_ref: ProjectRef,
    pub project_title: Text<0, 200>,
    /// The work it belongs to; `live { focus }` with it streams this agent's text too. Absent for a lead.
    pub workstream_id: Option<WorkstreamId>,
}

/// An opaque cursor into an agent's steps: pass `before` back to read the page before it.
pub type WorkCursor = Text<1, 200>;

/// A message the agent or its person wrote. Secrets are replaced by `[secret]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WorkMessage {
    pub id: NonEmpty,
    pub at: Timestamp,
    pub role: TailRole,
    /// The last 2000 characters of a longer message.
    pub text: Text<0, 2000>,
}

/// A command, file edit or tool call. Secrets in its summary and output are replaced by `[secret]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WorkAction {
    pub id: NonEmpty,
    pub at: Timestamp,
    pub action: ActionItem,
}

/// One step of an agent's work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkStep {
    Message(WorkMessage),
    Action(WorkAction),
}

impl WorkStep {
    pub fn id(&self) -> &str {
        match self {
            Self::Message(m) => &m.id,
            Self::Action(a) => &a.id,
        }
    }
}
