//! Pure view of one thread for thread_tail / actions_list, built from T3's bounded thread snapshot (the newest window
//! of the thread) plus the live events after it. Never pages oldest-first. TS spec: apps/hub/src/executor/ThreadView.ts
//! and ThreadWatch.ts (`open_tool`).
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use super::OpenTool;
use super::limit::{normalize_iso, parse_ms};
use super::shell_mapper::{js_len, js_take, keep_tail};
use super::t3::{
    Message, Run, RuntimeRequest, ThreadEvent, ThreadStreamItem, TurnItem, TurnItemKind,
};

#[derive(Debug, Clone, Default)]
pub struct ThreadView {
    pub messages: HashMap<String, Message>,
    pub items: HashMap<String, TurnItem>,
    pub runs: HashMap<String, Run>,
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

/// Mutates `view` with one thread stream item. A snapshot (first frame, or a resume past the replay budget) replaces it.
pub fn apply_thread_item(view: &mut ThreadView, item: &ThreadStreamItem) {
    match item {
        ThreadStreamItem::Snapshot(snap) => {
            let p = &snap.projection;
            view.messages = p
                .messages
                .iter()
                .map(|m| (m.id.clone(), m.clone()))
                .collect();
            view.items = p
                .turn_items
                .iter()
                .map(|i| (i.id.clone(), i.clone()))
                .collect();
            view.runs = p.runs.iter().map(|r| (r.id.clone(), r.clone())).collect();
            view.ready = true;
        }
        ThreadStreamItem::Event(e) => match &e.event {
            ThreadEvent::MessageUpdated(m) => {
                view.messages
                    .insert(m.payload.id.clone(), m.payload.clone());
            }
            ThreadEvent::TurnItemUpdated(i) => {
                view.items.insert(i.payload.id.clone(), i.payload.clone());
            }
            ThreadEvent::RunCreated(r) | ThreadEvent::RunUpdated(r) => {
                view.runs.insert(r.payload.id.clone(), r.payload.clone());
            }
            ThreadEvent::Other => {}
        },
        ThreadStreamItem::Synchronized | ThreadStreamItem::Other => {}
    }
}

pub fn latest_assistant_text(view: &ThreadView) -> Option<String> {
    let mut best: Option<&Message> = None;
    for m in view.messages.values() {
        if m.role != "assistant" || m.text.trim().is_empty() {
            continue;
        }
        if best.is_none_or(|b| parse_ms(&m.created_at) >= parse_ms(&b.created_at)) {
            best = Some(m);
        }
    }
    best.map(|m| m.text.clone())
}

pub fn active_run_id(view: &ThreadView) -> Option<String> {
    view.runs
        .values()
        .filter(|r| {
            matches!(
                r.status.as_str(),
                "preparing" | "queued" | "starting" | "running" | "waiting"
            )
        })
        .max_by_key(|r| r.ordinal)
        .map(|r| r.id.clone())
}

static EXIT_CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bExit code (\d+)\b").expect("static regex"));

/// Parses the "Exit code N" T3's Claude adapter puts in a failed command's output.
pub fn parse_exit_code(output: Option<&str>) -> Option<i64> {
    EXIT_CODE.captures(output?).and_then(|c| c[1].parse().ok())
}

fn item_status(s: &str) -> &'static str {
    match s {
        "completed" => "completed",
        "failed" | "cancelled" | "interrupted" => "failed",
        _ => "running",
    }
}

fn stringify(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// The action a turn item records, or None for messages, reasoning, plans and bookkeeping (T3's own workspace step
/// included).
pub fn to_action(item: &TurnItem) -> Option<Action> {
    let at = normalize_iso(
        item.completed_at
            .as_deref()
            .or(item.started_at.as_deref())
            .unwrap_or(&item.updated_at),
    );
    let status = item_status(&item.status);
    let base = |kind: &'static str,
                summary: &str,
                output: Option<String>,
                exit_code: Option<i64>,
                failed: bool| {
        let failed = status == "failed" || failed || exit_code.is_some_and(|c| c != 0);
        Action {
            at: at.clone(),
            kind,
            status,
            summary: js_take(summary, 200).to_owned(),
            output_tail: output
                .filter(|o| !o.is_empty())
                .map(|o| keep_tail(&o, 1024)),
            exit_code,
            failed,
        }
    };
    Some(match &item.kind {
        TurnItemKind::CommandExecution(c) => {
            // T3 records its own workspace step as a command in every run; the agent ran nothing, so receipts must
            // not count it.
            if item.id.contains(":native-item:workspace-preparation") {
                return None;
            }
            let exit_code = c.exit_code.or_else(|| parse_exit_code(c.output.as_deref()));
            base(
                "command",
                &c.input,
                c.output.clone(),
                exit_code,
                c.output_indicates_failure == Some(true),
            )
        }
        TurnItemKind::FileChange(f) => base("file_change", &f.file_name, None, None, false),
        TurnItemKind::DynamicTool(d) => base(
            "tool_call",
            d.tool_name
                .as_deref()
                .or(item.title.as_deref())
                .unwrap_or("tool"),
            stringify(d.output.as_ref()),
            None,
            false,
        ),
        TurnItemKind::FileSearch(f) => base(
            "tool_call",
            &format!("file search: {}", f.pattern.as_deref().unwrap_or("")),
            None,
            None,
            false,
        ),
        TurnItemKind::WebSearch(w) => base(
            "tool_call",
            &format!(
                "web search: {}",
                w.patterns.as_deref().unwrap_or_default().join(", ")
            ),
            None,
            None,
            false,
        ),
        TurnItemKind::Subagent(a) => base(
            "tool_call",
            &format!("subagent: {}", a.prompt),
            a.result.clone(),
            None,
            false,
        ),
        TurnItemKind::Error(e) => {
            let summary = format!("{}: {}", e.failure.class, e.failure.message);
            Action {
                status: "failed",
                failed: true,
                ..base("other", &summary, None, None, false)
            }
        }
        _ => return None,
    })
}

fn newest_first<T>(xs: &mut [T], at: impl Fn(&T) -> &str) {
    // Stable, like Array.prototype.sort.
    xs.sort_by(|a, b| at(b).cmp(at(a)));
}

/// Command items whose output the bounded snapshot withheld; fetch them in full with getTurnItem.
pub fn omitted_outputs(view: &ThreadView, ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| {
            view.items.get(*id).is_some_and(|i| match &i.kind {
                TurnItemKind::CommandExecution(c) => c.output_omitted == Some(true),
                TurnItemKind::DynamicTool(d) => d.output_omitted == Some(true),
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
                .map(|a| (item.id.clone(), a))
        })
        .collect();
    // HashMap order is arbitrary where TS kept insertion order; order equal timestamps by id so output is stable.
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
        let mut messages: Vec<&Message> = view.messages.values().collect();
        messages.sort_by(|a, b| a.id.cmp(&b.id));
        for m in messages {
            if m.text.trim().is_empty() {
                continue;
            }
            if js_len(&m.text) > 2000 {
                truncated = true;
            }
            rows.push((
                m.id.clone(),
                TailRow::Message {
                    at: normalize_iso(&m.created_at),
                    role: m.role.clone(),
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

/// What a thread waiting on a human is asking, from its pending runtime request and the turn item that shows it: the
/// questions of a user-input request (with their options), or an approval's prompt. None when nothing is pending.
pub fn pending_question_text(
    runtime_requests: &[RuntimeRequest],
    turn_items: &[TurnItem],
) -> Option<String> {
    let pending = runtime_requests.iter().rfind(|r| r.status == "pending")?;
    let item = turn_items.iter().find(|i| match &i.kind {
        TurnItemKind::UserInputRequest(u) => u.request_id == pending.id,
        TurnItemKind::ApprovalRequest(a) => a.request_id == pending.id,
        _ => false,
    });
    let text = match item.map(|i| &i.kind) {
        Some(TurnItemKind::UserInputRequest(u)) => u
            .questions
            .iter()
            .map(|q| {
                let options = q
                    .options
                    .iter()
                    .map(|o| o.label.as_str())
                    .collect::<Vec<_>>()
                    .join(" | ");
                if options.is_empty() {
                    q.question.clone()
                } else {
                    format!("{} (options: {options})", q.question)
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(TurnItemKind::ApprovalRequest(a)) => a
            .prompt
            .clone()
            .unwrap_or_else(|| format!("approve a {} request", a.request_kind)),
        _ => format!("a pending {} request", pending.kind),
    };
    Some(if js_len(&text) > QUESTION_MAX {
        format!("{}…", js_take(&text, QUESTION_MAX - 1))
    } else {
        text
    })
}

/// A tool's own `timeout` (ms), as Claude's tools take it, when T3 passes the input through.
fn stated_timeout(item: &TurnItem) -> Option<u64> {
    let TurnItemKind::DynamicTool(d) = &item.kind else {
        return None;
    };
    let t = d.input.as_object()?.get("timeout")?.as_f64()?;
    (t.is_finite() && t > 0.0).then_some(t as u64)
}

/// The open tool calls of `run_id`, if any.
pub fn open_tool(view: &ThreadView, run_id: Option<&str>) -> Option<OpenTool> {
    let mut open = false;
    let mut unstated = false;
    let mut stated: Option<u64> = None;
    for item in view.items.values() {
        let tool = matches!(
            item.kind,
            TurnItemKind::CommandExecution(_)
                | TurnItemKind::DynamicTool(_)
                | TurnItemKind::Subagent(_)
                | TurnItemKind::WebSearch(_)
                | TurnItemKind::FileSearch(_)
        );
        if !tool || !matches!(item.status.as_str(), "pending" | "running") {
            continue;
        }
        if run_id.is_some() && item.run_id.as_deref() != run_id {
            continue;
        }
        open = true;
        match stated_timeout(item) {
            None => unstated = true,
            Some(ms) => stated = Some(stated.unwrap_or(0).max(ms)),
        }
    }
    open.then_some(OpenTool {
        stated_timeout_ms: stated,
        unstated,
    })
}

/// Distinct sorted checkpoint paths (ThreadWorkspace.changes).
pub fn checkpoint_paths<'a>(paths: impl Iterator<Item = &'a str>) -> Vec<String> {
    let set: HashSet<&str> = paths.collect();
    let mut out: Vec<String> = set.into_iter().map(str::to_owned).collect();
    out.sort();
    out
}
