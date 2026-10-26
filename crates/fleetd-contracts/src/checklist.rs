//! A project's checklist: the lead's to-do list, which the human sees in the panel beside the chat. The lead keeps it
//! with `checklist`; the app reads it with `checklist_get` and reads it again on `checklist.changed`. Read-only for the
//! human. Nothing is derived from it: no figure, no estimate, only what the lead says each item is at.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::checked;
use crate::ids::{ProjectRef, Timestamp};
use crate::ledger::WorkstreamId;
use crate::prim::{Count, Line, List, Positive};
use crate::tasks::TaskId;
use crate::train::GitHubPrUrl;

/// Items on one project's list.
pub const CHECKLIST_MAX: usize = 50;

/// One item, in plain words for the human: at most 200 characters, no line breaks.
pub type TodoText = Line<1, 200>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TodoState {
    #[default]
    Todo,
    Doing,
    Done,
}

/// What an item is about, any of: its PR, the agent on it (its task), its workstream.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TodoLink {
    pub pr: Option<GitHubPrUrl>,
    pub task_id: Option<TaskId>,
    pub workstream_id: Option<WorkstreamId>,
}

impl TodoLink {
    pub fn is_empty(&self) -> bool {
        self.pr.is_none() && self.task_id.is_none() && self.workstream_id.is_none()
    }
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    /// Unique in its project, never reused.
    pub id: Positive,
    pub text: TodoText,
    pub state: TodoState,
    pub link: Option<TodoLink>,
    pub updated_at: Timestamp,
}

/// One change to the list: without `id` it adds an item (text required, state todo unless given); with `id` it sets
/// that item's text, state or link, or with `remove` takes it off.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct TodoEdit {
    pub id: Option<Positive>,
    pub text: Option<TodoText>,
    pub state: Option<TodoState>,
    /// Replaces the item's link; `{}` clears it.
    pub link: Option<TodoLink>,
    pub remove: Option<bool>,
}
checked!(TodoEdit, |edit| {
    let removing = edit.remove == Some(true);
    match edit.id {
        None if removing => Err("remove needs the item's id".into()),
        None if edit.text.is_none() => Err("a new item needs text".into()),
        Some(_)
            if removing && (edit.text.is_some() || edit.state.is_some() || edit.link.is_some()) =>
        {
            Err("remove takes only the id".into())
        }
        Some(_)
            if !removing && edit.text.is_none() && edit.state.is_none() && edit.link.is_none() =>
        {
            Err("give text, state, link or remove with an id".into())
        }
        _ => Ok(()),
    }
});

/// `checklist`: changes in order, applied together or not at all. With `replace` the list becomes exactly `items`,
/// all new (no ids); `replace` with no items clears it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase")]
pub struct ChecklistCall {
    #[serde(default)]
    pub items: List<TodoEdit, 0, CHECKLIST_MAX>,
    pub replace: Option<bool>,
}
checked!(ChecklistCall, |call| {
    if call.replace == Some(true) {
        if call.items.iter().any(|e| e.id.is_some()) {
            return Err("replace sets the whole list: leave ids out".into());
        }
    } else if call.items.is_empty() {
        return Err("give items to change, or replace to set the whole list".into());
    }
    Ok(())
});

/// The list after the call, in order.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChecklistResult {
    pub items: List<TodoItem, 0, CHECKLIST_MAX>,
    pub next: Option<String>,
}

/// `checklist.changed`. The items are not in the event; checklist_get reads them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistChangedData {
    pub project_ref: ProjectRef,
    pub done: Count,
    pub total: Count,
    pub by: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(value: serde_json::Value) -> Result<ChecklistCall, String> {
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    #[test]
    fn an_edit_adds_with_text_changes_by_id_and_removes_by_id_alone() {
        assert!(call(json!({ "items": [{ "text": "Ship the panel" }] })).is_ok());
        assert!(call(json!({ "items": [{ "id": 2, "state": "done" }] })).is_ok());
        assert!(call(json!({ "items": [{ "id": 2, "remove": true }] })).is_ok());
        assert!(call(json!({ "items": [{ "id": 2, "link": {} }] })).is_ok());
        let refused = |v, why: &str| assert!(call(v).unwrap_err().contains(why));
        refused(
            json!({ "items": [{ "state": "doing" }] }),
            "a new item needs text",
        );
        refused(
            json!({ "items": [{ "remove": true }] }),
            "remove needs the item's id",
        );
        refused(
            json!({ "items": [{ "id": 2, "remove": true, "state": "done" }] }),
            "remove takes only the id",
        );
        refused(
            json!({ "items": [{ "id": 2 }] }),
            "give text, state, link or remove",
        );
        refused(json!({ "items": [] }), "give items to change");
        refused(
            json!({ "items": [{ "id": 1, "text": "x" }], "replace": true }),
            "leave ids out",
        );
        refused(json!({ "items": [{ "text": "x\ny" }] }), "");
        assert!(call(json!({ "replace": true })).is_ok());
    }

    #[test]
    fn a_link_names_a_github_pr_a_task_or_a_workstream() {
        let edit = json!({ "text": "t", "link": { "pr": "https://github.com/acme/app/pull/4", "taskId": "T3", "workstreamId": "W2" } });
        assert!(call(json!({ "items": [edit] })).is_ok());
        assert!(call(json!({ "items": [{ "text": "t", "link": { "taskId": "3" } }] })).is_err());
        assert!(
            call(json!({ "items": [{ "text": "t", "link": { "pr": "https://example.com/x" } }] }))
                .is_err()
        );
    }
}
