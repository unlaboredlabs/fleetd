//! Pure view of one thread for thread_tail / actions_list, built from the node's bounded thread snapshot (the newest
//! window of the session) plus the live events after it. Never pages oldest-first.
use std::collections::HashMap;

use fleetd_contracts::sessions::{
    ItemKind, ItemStatus, MessageRole, PendingPermission, RunInfo, ThreadEvent, ThreadItem,
    ThreadMessage,
};
use serde::Serialize;

use super::OpenTool;
use super::shell_mapper::{failure_class, js_len, js_take, keep_tail, normalize_iso};
use crate::hub::usage::time::parse_ms;

#[derive(Debug, Clone, Default)]
pub struct ThreadView {
    pub messages: HashMap<String, ThreadMessage>,
    pub items: HashMap<String, ThreadItem>,
    pub runs: HashMap<String, RunInfo>,
    /// False until the first snapshot arrives.
    pub ready: bool,
}

/// The hub's ActionItem, field for field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub at: String,
    pub kind: &'static str,
    pub status: &'static str,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    pub failed: bool,
}

/// The hub's TailItem: a message or an action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TailRow {
    #[serde(rename = "message")]
    Message {
        at: String,
        role: String,
        text: String,
    },
    #[serde(rename = "action")]
    Action { at: String, action: Action },
}

impl TailRow {
    pub fn at(&self) -> &str {
        match self {
            Self::Message { at, .. } | Self::Action { at, .. } => at,
        }
    }
}

/// Mutates `view` with one thread event. A snapshot (the first frame, or a resume the node can't replay) replaces it.
/// Deltas are live text for app subscribers only; the complete message follows them.
pub fn apply_thread_event(view: &mut ThreadView, event: &ThreadEvent) {
    match event {
        ThreadEvent::Snapshot(snap) => {
            view.messages = snap
                .messages
                .iter()
                .map(|m| (m.id.to_string(), m.clone()))
                .collect();
            view.items = snap
                .items
                .iter()
                .map(|i| (i.id.to_string(), i.clone()))
                .collect();
            view.runs = snap
                .runs
                .iter()
                .map(|r| (r.id.to_string(), r.clone()))
                .collect();
            view.ready = true;
        }
        ThreadEvent::Message(m) => {
            view.messages.insert(m.id.to_string(), m.clone());
        }
        ThreadEvent::Item(i) => {
            view.items.insert(i.id.to_string(), i.clone());
        }
        ThreadEvent::Run(r) => {
            view.runs.insert(r.id.to_string(), r.clone());
        }
        ThreadEvent::Delta { .. } | ThreadEvent::Usage { .. } => {}
    }
}

fn role(r: MessageRole) -> &'static str {
    match r {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
    }
}

pub fn latest_assistant_text(view: &ThreadView) -> Option<String> {
    let mut best: Option<&ThreadMessage> = None;
    for m in view.messages.values() {
        if m.role != MessageRole::Assistant || m.text.trim().is_empty() {
            continue;
        }
        if best.is_none_or(|b| parse_ms(m.created_at.as_str()) >= parse_ms(b.created_at.as_str())) {
            best = Some(m);
        }
    }
    best.map(|m| m.text.clone())
}

pub fn active_run_id(view: &ThreadView) -> Option<String> {
    view.runs
        .values()
        .filter(|r| r.status.is_active())
        .max_by_key(|r| r.ordinal)
        .map(|r| r.id.to_string())
}

fn item_status(s: ItemStatus) -> &'static str {
    match s {
        ItemStatus::Completed => "completed",
        ItemStatus::Failed | ItemStatus::Cancelled => "failed",
        ItemStatus::Running => "running",
    }
}

/// The action an item records, or None for permission prompts and compactions (bookkeeping the agent didn't do).
pub fn to_action(item: &ThreadItem) -> Option<Action> {
    let at = normalize_iso(
        item.completed_at
            .as_ref()
            .unwrap_or(&item.started_at)
            .as_str(),
    );
    let status = item_status(item.status);
    let base = |kind: &'static str, summary: &str, output: Option<&str>, exit_code: Option<i64>| {
        let failed = status == "failed" || exit_code.is_some_and(|c| c != 0);
        Action {
            at: at.clone(),
            kind,
            status,
            summary: js_take(summary, 200).to_owned(),
            output_tail: output.filter(|o| !o.is_empty()).map(|o| keep_tail(o, 1024)),
            exit_code,
            failed,
        }
    };
    let title = |fallback: &str| {
        if item.title.trim().is_empty() {
            fallback.to_owned()
        } else {
            item.title.clone()
        }
    };
    Some(match &item.kind {
        ItemKind::Command {
            command,
            output,
            exit_code,
            ..
        } => base("command", command, output.as_deref(), *exit_code),
        ItemKind::FileChange { path, .. } => base("file_change", path, None, None),
        ItemKind::Tool {
            tool_name, output, ..
        } => base("tool_call", &title(tool_name), output.as_deref(), None),
        ItemKind::ApiRetry {
            attempt,
            max_retries,
            error_status,
            error,
            ..
        } => {
            let status = error_status.map(|s| format!(" {s}")).unwrap_or_default();
            base(
                "other",
                &format!("API retry {attempt}/{max_retries}:{status} {error}"),
                None,
                None,
            )
        }
        ItemKind::NodeRetry {
            attempt,
            of,
            delay_ms,
            reason,
        } => base(
            "other",
            &node_retry_summary(*attempt, *of, *delay_ms, reason.class),
            None,
            None,
        ),
        ItemKind::Error { failure } => {
            let summary = format!(
                "{}: {}",
                failure_class(failure.class),
                failure.message.as_str()
            );
            Action {
                status: "failed",
                failed: true,
                ..base("other", &summary, None, None)
            }
        }
        ItemKind::Permission { .. } | ItemKind::Compaction { .. } => return None,
    })
}

/// The node's own retry of a run after an overloaded, 5xx or network failure, as `actions_list` shows it (the lab
/// asserts this text). An `other` action, so receipts never count it: the agent ran nothing.
pub fn node_retry_summary(
    attempt: u32,
    of: u32,
    delay_ms: u64,
    class: fleetd_contracts::sessions::FailureClass,
) -> String {
    let delay = if delay_ms.is_multiple_of(1000) {
        format!("{} s", delay_ms / 1000)
    } else {
        format!("{delay_ms} ms")
    };
    format!(
        "node retry {attempt}/{of} in {delay}: {}",
        failure_class(class)
    )
}

fn newest_first<T>(xs: &mut [T], at: impl Fn(&T) -> &str) {
    // Stable, like Array.prototype.sort.
    xs.sort_by(|a, b| at(b).cmp(at(a)));
}

/// Items whose output the bounded snapshot cut; fetch them in full with `read_item`.
pub fn omitted_outputs(view: &ThreadView, ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| {
            view.items.get(*id).is_some_and(|i| match &i.kind {
                ItemKind::Command { output_omitted, .. }
                | ItemKind::Tool { output_omitted, .. } => *output_omitted,
                _ => false,
            })
        })
        .cloned()
        .collect()
}

/// Newest-first actions with their item ids.
pub fn actions_of(view: &ThreadView, limit: usize, failed_only: bool) -> Vec<(String, Action)> {
    let mut out: Vec<(String, Action)> = view
        .items
        .values()
        .filter_map(|item| {
            to_action(item)
                .filter(|a| !failed_only || a.failed)
                .map(|a| (item.id.to_string(), a))
        })
        .collect();
    // HashMap order is arbitrary; order equal timestamps by id so output is stable.
    out.sort_by(|a, b| a.0.cmp(&b.0));
    newest_first(&mut out, |(_, a)| &a.at);
    out.truncate(limit);
    out
}

/// Newest-first tail rows with their ids, and whether any text was trimmed to its limit.
pub fn tail_of(
    view: &ThreadView,
    n: usize,
    kinds: Option<&[&str]>,
) -> (Vec<(String, TailRow)>, bool) {
    let want = |k: &str| kinds.is_none_or(|ks| ks.is_empty() || ks.contains(&k));
    let mut truncated = false;
    let mut rows: Vec<(String, TailRow)> = vec![];
    if want("message") {
        let mut messages: Vec<&ThreadMessage> = view.messages.values().collect();
        messages.sort_by(|a, b| a.id.cmp(&b.id));
        for m in messages {
            if m.text.trim().is_empty() {
                continue;
            }
            if js_len(&m.text) > 2000 {
                truncated = true;
            }
            rows.push((
                m.id.to_string(),
                TailRow::Message {
                    at: normalize_iso(m.created_at.as_str()),
                    role: role(m.role).to_owned(),
                    text: keep_tail(&m.text, 2000),
                },
            ));
        }
    }
    if want("action") {
        for (id, action) in actions_of(view, usize::MAX, false) {
            rows.push((
                id,
                TailRow::Action {
                    at: action.at.clone(),
                    action,
                },
            ));
        }
    }
    newest_first(&mut rows, |(_, r)| r.at());
    rows.truncate(n);
    (rows, truncated)
}

const QUESTION_MAX: usize = 1500;

/// What a thread waiting on a human is asking: the tool and what it would do.
pub fn pending_question_text(pending: &PendingPermission) -> String {
    let summary = pending.summary.as_str().trim();
    let text = if summary.is_empty() {
        format!("approve a {} call", pending.tool_name.as_str())
    } else {
        format!("approve {}: {summary}", pending.tool_name.as_str())
    };
    if js_len(&text) > QUESTION_MAX {
        format!("{}…", js_take(&text, QUESTION_MAX - 1))
    } else {
        text
    }
}

/// The open tool calls of `run_id`, if any. A command states its own timeout; other tools state none.
pub fn open_tool(view: &ThreadView, run_id: Option<&str>) -> Option<OpenTool> {
    let mut open = false;
    let mut unstated = false;
    let mut stated: Option<u64> = None;
    for item in view.items.values() {
        let timeout = match &item.kind {
            ItemKind::Command { timeout_ms, .. } => *timeout_ms,
            ItemKind::Tool { .. } => None,
            _ => continue,
        };
        if item.status != ItemStatus::Running {
            continue;
        }
        if run_id.is_some() && item.run_id.as_ref().map(|r| r.as_str()) != run_id {
            continue;
        }
        open = true;
        match timeout.filter(|ms| *ms > 0) {
            None => unstated = true,
            Some(ms) => stated = Some(stated.unwrap_or(0).max(ms)),
        }
    }
    open.then_some(OpenTool {
        stated_timeout_ms: stated,
        unstated,
    })
}
