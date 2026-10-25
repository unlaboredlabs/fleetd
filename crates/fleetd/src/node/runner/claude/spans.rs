//! Time spans from claude's stream, built beside the mapper as a pure state machine over the same lines and the same
//! `Now`. Every span of a run is emitted when the run ends: only then is each instant's owner known, so each span
//! carries its exclusive time and the run's uncovered time becomes `runner.other` filler. Per run, the exclusive
//! times add up to the run's wall time exactly.
//!
//! What a stream line tells (spec §2a, §2f): a model message runs from the previous visible event to its
//! `message_stop`; its first phase ends at `message_start` (claude-local work, network, queueing and prefill, which
//! cannot be told apart), its thinking phase ends with its last thinking block, and the rest is output. A tool runs
//! from its `tool_use` block to its `tool_result`; claude does not say when execution starts.
use std::collections::HashMap;

use fleetd_contracts::prim::{Count, Line, Text};
use fleetd_contracts::time::{DecidedBy, SpanExtra, SpanKind, SpanStatus, SpanWire};
use serde_json::Value;

use crate::hub::time::model::rank;
use crate::node::runner::shell::program;
use crate::node::util::head_utf16;
use crate::tiles::{Claim, exclusive};

/// A run with more spans than this keeps the first ones and reports the rest as one `gap`.
pub const MAX_RUN_SPANS: usize = 5000;
const LABEL_MAX: usize = 500;

struct Leaf {
    key: String,
    kind: SpanKind,
    parent: Option<String>,
    start: u64,
    end: u64,
    label: Option<String>,
    exit_code: Option<i64>,
    out_bytes: Option<u64>,
    status: SpanStatus,
    extra: SpanExtra,
    /// Owns no instant: the run envelope, or a message whose phases tile it.
    envelope: bool,
}

struct OpenRun {
    start: u64,
    leaves: Vec<Leaf>,
    dropped: u64,
}

struct OpenMessage {
    id: String,
    opened: u64,
    started: u64,
    /// Content block index -> its type, for `content_block_stop`.
    blocks: HashMap<u64, String>,
    thinking_end: Option<u64>,
    stop_reason: Option<String>,
    output_tokens: Option<u64>,
    thinking_tokens: Option<u64>,
}

struct OpenTool {
    run: Option<String>,
    start: u64,
    name: String,
    label: String,
}

struct OpenWait {
    run: Option<String>,
    key: String,
    parent: Option<String>,
    kind: SpanKind,
    start: u64,
    extra: SpanExtra,
}

#[derive(Default)]
pub struct SpanBuilder {
    session: String,
    runs: HashMap<String, OpenRun>,
    active: Option<String>,
    /// The active run's previous visible stream event: where the next model message starts.
    last_visible: u64,
    message: Option<OpenMessage>,
    tools: HashMap<String, OpenTool>,
    /// Permission prompts by request id.
    permissions: HashMap<String, OpenWait>,
    retry: Option<OpenWait>,
    compaction: Option<OpenWait>,
    seq: u64,
}

impl SpanBuilder {
    pub fn new(session: impl Into<String>) -> Self {
        Self {
            session: session.into(),
            ..Self::default()
        }
    }

    pub fn run_started(&mut self, run: &str, ms: u64) {
        self.runs.entry(run.to_owned()).or_insert(OpenRun {
            start: ms,
            leaves: Vec::new(),
            dropped: 0,
        });
        self.active = Some(run.to_owned());
        self.last_visible = ms;
        self.message = None;
    }

    /// One `stream_event` of the active run.
    pub fn stream(&mut self, ev: &Value, ms: u64) {
        match ev["type"].as_str().unwrap_or_default() {
            "message_start" => {
                self.close_retry(ms);
                let id = ev["message"]["id"].as_str().unwrap_or_default().to_owned();
                self.message = Some(OpenMessage {
                    id,
                    opened: self.last_visible.min(ms),
                    started: ms,
                    blocks: HashMap::new(),
                    thinking_end: None,
                    stop_reason: None,
                    output_tokens: None,
                    thinking_tokens: None,
                });
            }
            "content_block_start" => {
                if let (Some(m), Some(i)) = (&mut self.message, ev["index"].as_u64()) {
                    let kind = ev["content_block"]["type"].as_str().unwrap_or_default();
                    m.blocks.insert(i, kind.to_owned());
                }
            }
            "content_block_stop" => {
                if let (Some(m), Some(i)) = (&mut self.message, ev["index"].as_u64())
                    && m.blocks.get(&i).is_some_and(|k| k == "thinking")
                {
                    m.thinking_end = Some(ms);
                }
            }
            "message_delta" => {
                if let Some(m) = &mut self.message {
                    if let Some(r) = ev["delta"]["stop_reason"].as_str() {
                        m.stop_reason = Some(r.to_owned());
                    }
                    if let Some(n) = ev["usage"]["output_tokens"].as_u64() {
                        m.output_tokens = Some(n);
                    }
                    if let Some(n) =
                        ev["usage"]["output_tokens_details"]["thinking_tokens"].as_u64()
                    {
                        m.thinking_tokens = Some(n);
                    }
                }
            }
            "message_stop" => {
                if let Some(m) = self.message.take() {
                    self.close_message(m, ms, SpanStatus::Ok);
                }
                self.last_visible = ms;
            }
            _ => {}
        }
    }

    fn close_message(&mut self, m: OpenMessage, end: u64, status: SpanStatus) {
        let Some(run) = self.active.clone() else {
            return;
        };
        let key = format!("{}/msg/{}", self.session, m.id);
        let first = m.started.min(end);
        let thinking = m.thinking_end.map(|t| t.clamp(first, end));
        let mut extra = SpanExtra {
            output_tokens: m.output_tokens.and_then(count),
            thinking_tokens: m.thinking_tokens.and_then(count),
            stop_reason: m
                .stop_reason
                .and_then(|r| Line::new(head_utf16(&r, 40)).ok()),
            ..SpanExtra::default()
        };
        if status != SpanStatus::Ok {
            extra.reason = Text::new("the run ended before the message did").ok();
        }
        let phases = [
            (SpanKind::ModelFirstToken, m.opened, first),
            (SpanKind::ModelThinking, first, thinking.unwrap_or(first)),
            (SpanKind::ModelOutput, thinking.unwrap_or(first), end),
        ];
        self.push(
            &run,
            leaf(
                key.clone(),
                SpanKind::ModelMessage,
                None,
                m.opened,
                end,
                None,
                status,
                extra,
                true,
            ),
        );
        for (kind, start, stop) in phases {
            if stop > start {
                let k = format!("{key}/{}", kind.as_str().trim_start_matches("model."));
                self.push(
                    &run,
                    leaf(
                        k,
                        kind,
                        Some(key.clone()),
                        start,
                        stop,
                        None,
                        status,
                        SpanExtra::default(),
                        false,
                    ),
                );
            }
        }
    }

    /// The `assistant` line's `tool_use` block.
    pub fn tool_use(&mut self, id: &str, name: &str, input: &Value, ms: u64) {
        self.tools.insert(
            id.to_owned(),
            OpenTool {
                run: self.active.clone(),
                start: ms,
                name: name.to_owned(),
                label: tool_label(name, input),
            },
        );
    }

    /// The `user` line's `tool_result`. `output` is the full result text, before any cap.
    pub fn tool_result(
        &mut self,
        id: &str,
        output: &str,
        status: SpanStatus,
        exit_code: Option<i64>,
        tool_use_result: Option<&Value>,
        ms: u64,
    ) {
        let Some(tool) = self.tools.remove(id) else {
            return;
        };
        self.last_visible = ms;
        let claude_ms = tool_use_result
            .and_then(|r| r["durationMs"].as_u64())
            .and_then(count);
        self.close_tool(
            id,
            tool,
            ms,
            status,
            exit_code,
            Some(output.len() as u64),
            claude_ms,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn close_tool(
        &mut self,
        id: &str,
        tool: OpenTool,
        end: u64,
        status: SpanStatus,
        exit_code: Option<i64>,
        out_bytes: Option<u64>,
        claude_ms: Option<Count>,
    ) {
        let Some(run) = tool.run.or_else(|| self.active.clone()) else {
            return;
        };
        let kind = tool_kind(&tool.name, &tool.label);
        let extra = SpanExtra {
            tool: Line::new(head_utf16(&tool.name, 120)).ok(),
            runner_ms: claude_ms,
            ..SpanExtra::default()
        };
        let mut l = leaf(
            format!("{}/{id}", self.session),
            kind,
            None,
            tool.start,
            end.max(tool.start),
            Some(tool.label),
            status,
            extra,
            false,
        );
        l.exit_code = exit_code;
        l.out_bytes = out_bytes;
        self.push(&run, l);
    }

    /// `can_use_tool`: the prompt opens; it closes with [`SpanBuilder::answered`] or [`SpanBuilder::withdrawn`].
    pub fn permission(&mut self, request_id: &str, tool_use_id: &str, tool_name: &str, ms: u64) {
        let extra = SpanExtra {
            request_id: Text::new(head_utf16(request_id, 120)).ok(),
            tool: Line::new(head_utf16(tool_name, 120)).ok(),
            ..SpanExtra::default()
        };
        self.permissions.insert(
            request_id.to_owned(),
            OpenWait {
                run: self.active.clone(),
                key: format!("{}/perm/{request_id}", self.session),
                parent: (!tool_use_id.is_empty())
                    .then(|| format!("{}/{tool_use_id}", self.session)),
                kind: SpanKind::WaitPermission,
                start: ms,
                extra,
            },
        );
    }

    pub fn answered(&mut self, request_id: &str, by: Option<DecidedBy>, ms: u64) {
        if let Some(mut w) = self.permissions.remove(request_id) {
            w.extra.decided_by = by;
            self.close_wait(w, ms, SpanStatus::Ok);
        }
    }

    pub fn withdrawn(&mut self, request_id: &str, ms: u64) {
        if let Some(w) = self.permissions.remove(request_id) {
            self.close_wait(w, ms, SpanStatus::Cancelled);
        }
    }

    pub fn api_retry(&mut self, attempt: u32, delay_ms: Option<u64>, status: Option<u16>, ms: u64) {
        self.close_retry(ms);
        self.seq += 1;
        let run = self.active.clone().unwrap_or_default();
        self.retry = Some(OpenWait {
            run: self.active.clone(),
            key: format!("{}/{run}/retry/{}", self.session, self.seq),
            parent: None,
            kind: SpanKind::WaitRetryApi,
            start: ms,
            extra: SpanExtra {
                attempt: count(u64::from(attempt)),
                stated_delay_ms: delay_ms.and_then(count),
                http_status: status.and_then(|s| count(u64::from(s))),
                ..SpanExtra::default()
            },
        });
    }

    fn close_retry(&mut self, ms: u64) {
        if let Some(w) = self.retry.take() {
            self.close_wait(w, ms, SpanStatus::Ok);
        }
    }

    pub fn compacting(&mut self, on: bool, ms: u64) {
        match (on, self.compaction.is_some()) {
            (true, false) => {
                self.seq += 1;
                let run = self.active.clone().unwrap_or_default();
                self.compaction = Some(OpenWait {
                    run: self.active.clone(),
                    key: format!("{}/{run}/compact/{}", self.session, self.seq),
                    parent: None,
                    kind: SpanKind::Compaction,
                    start: ms,
                    extra: SpanExtra::default(),
                });
            }
            (false, true) => {
                let w = self.compaction.take().expect("checked");
                self.close_wait(w, ms, SpanStatus::Ok);
            }
            _ => {}
        }
    }

    fn close_wait(&mut self, w: OpenWait, end: u64, status: SpanStatus) {
        let Some(run) = w.run.or_else(|| self.active.clone()) else {
            return;
        };
        let l = leaf(
            w.key,
            w.kind,
            w.parent,
            w.start,
            end.max(w.start),
            None,
            status,
            w.extra,
            false,
        );
        self.push(&run, l);
    }

    fn push(&mut self, run: &str, l: Leaf) {
        let Some(open) = self.runs.get_mut(run) else {
            return;
        };
        if open.leaves.len() >= MAX_RUN_SPANS {
            open.dropped += 1;
        } else {
            open.leaves.push(l);
        }
    }

    /// The run ended at `ms`: whatever it left open is cut, every span of the run comes back with its exclusive
    /// time, and the uncovered time is `runner.other`. Nothing when the run never started.
    pub fn run_ended(
        &mut self,
        run: &str,
        status: SpanStatus,
        durations: (Option<u64>, Option<u64>),
        ms: u64,
    ) -> Vec<SpanWire> {
        if !self.runs.contains_key(run) {
            return Vec::new();
        }
        let is_active = self.active.as_deref() == Some(run);
        if is_active {
            if let Some(m) = self.message.take() {
                self.close_message(m, ms, SpanStatus::Incomplete);
            }
            if let Some(w) = self.retry.take() {
                self.close_wait(w, ms, SpanStatus::Incomplete);
            }
            if let Some(w) = self.compaction.take() {
                self.close_wait(w, ms, SpanStatus::Incomplete);
            }
        }
        let mut cut: Vec<String> = self
            .tools
            .iter()
            .filter(|(_, t)| t.run.as_deref().is_none_or(|r| r == run))
            .map(|(id, _)| id.clone())
            .collect();
        cut.sort();
        for id in cut {
            let tool = self.tools.remove(&id).expect("listed");
            let mut tool = tool;
            tool.run = Some(run.to_owned());
            self.close_tool(&id, tool, ms, SpanStatus::Cancelled, None, None, None);
        }
        let mut waits: Vec<String> = self
            .permissions
            .iter()
            .filter(|(_, w)| w.run.as_deref().is_none_or(|r| r == run))
            .map(|(id, _)| id.clone())
            .collect();
        waits.sort();
        for id in waits {
            let w = self.permissions.remove(&id).expect("listed");
            self.close_wait(w, ms, SpanStatus::Cancelled);
        }
        if is_active {
            self.active = None;
        }
        let open = self.runs.remove(run).expect("checked");
        finish(&self.session, run, open, status, durations, ms)
    }
}

/// Groups overlapping tool calls, tiles the run and turns its leaves into wire spans.
fn finish(
    session: &str,
    run: &str,
    mut open: OpenRun,
    status: SpanStatus,
    (duration_ms, duration_api_ms): (Option<u64>, Option<u64>),
    end: u64,
) -> Vec<SpanWire> {
    let start = open.start.min(end);
    for l in &mut open.leaves {
        l.start = l.start.clamp(start, end);
        l.end = l.end.clamp(l.start, end);
    }
    group_parallel(session, run, &mut open.leaves);
    let claims: Vec<Claim> = open
        .leaves
        .iter()
        .map(|l| Claim {
            start: l.start,
            end: l.end,
            rank: if l.envelope { 0 } else { rank(l.kind).max(1) },
        })
        .collect();
    let tiles = crate::tiles::tile(&claims, start, end);
    let (excl, _) = exclusive(&claims, start, end);
    let mut out: Vec<SpanWire> = Vec::with_capacity(open.leaves.len() + 4);
    let run_key = format!("{session}/{run}/run");
    let mut fillers = 0;
    for t in tiles.iter().filter(|t| t.owner.is_none()) {
        fillers += 1;
        out.push(wire(
            session,
            run,
            leaf(
                format!("{session}/{run}/other/{fillers}"),
                SpanKind::RunnerOther,
                Some(run_key.clone()),
                t.start,
                t.end,
                None,
                SpanStatus::Ok,
                SpanExtra::default(),
                false,
            ),
            Some(t.end - t.start),
        ));
    }
    if open.dropped > 0 {
        let gap = leaf(
            format!("{session}/{run}/gap/1"),
            SpanKind::Gap,
            Some(run_key.clone()),
            start,
            end,
            None,
            SpanStatus::Incomplete,
            SpanExtra {
                count: count(open.dropped),
                reason: Text::new(format!("the run had more than {MAX_RUN_SPANS} spans")).ok(),
                ..SpanExtra::default()
            },
            true,
        );
        out.push(wire(session, run, gap, Some(0)));
    }
    for (l, ms) in open.leaves.into_iter().zip(excl) {
        let mut l = l;
        if l.parent.is_none() {
            l.parent = Some(run_key.clone());
        }
        out.push(wire(session, run, l, Some(ms)));
    }
    let envelope = leaf(
        run_key,
        SpanKind::Run,
        None,
        start,
        end,
        None,
        status,
        SpanExtra {
            duration_ms: duration_ms.and_then(count),
            duration_api_ms: duration_api_ms.and_then(count),
            ..SpanExtra::default()
        },
        true,
    );
    out.push(wire(session, run, envelope, Some(0)));
    out.sort_by_key(|s| (s.start_ms.get(), s.key.to_string()));
    out
}

/// Where two or more tool calls overlap, one `tools.parallel` span owns the overlap and becomes their parent.
fn group_parallel(session: &str, run: &str, leaves: &mut Vec<Leaf>) {
    let tools: Vec<usize> = (0..leaves.len())
        .filter(|&i| rank(leaves[i].kind) == 6 && leaves[i].end > leaves[i].start)
        .collect();
    if tools.len() < 2 {
        return;
    }
    let mut edges: Vec<(u64, i32)> = tools
        .iter()
        .flat_map(|&i| [(leaves[i].start, 1), (leaves[i].end, -1)])
        .collect();
    edges.sort_unstable();
    let mut regions: Vec<(u64, u64)> = Vec::new();
    let (mut depth, mut open_at) = (0, None);
    for (t, d) in edges {
        depth += d;
        match (depth >= 2, open_at) {
            (true, None) => open_at = Some(t),
            (false, Some(s)) => {
                if t > s {
                    regions.push((s, t));
                }
                open_at = None;
            }
            _ => {}
        }
    }
    for (n, (s, e)) in regions.into_iter().enumerate() {
        let key = format!("{session}/{run}/par/{}", n + 1);
        for &i in &tools {
            if leaves[i].start < e && leaves[i].end > s {
                leaves[i].parent = Some(key.clone());
            }
        }
        leaves.push(leaf(
            key,
            SpanKind::ToolsParallel,
            None,
            s,
            e,
            None,
            SpanStatus::Ok,
            SpanExtra::default(),
            false,
        ));
    }
}

#[allow(clippy::too_many_arguments)]
fn leaf(
    key: String,
    kind: SpanKind,
    parent: Option<String>,
    start: u64,
    end: u64,
    label: Option<String>,
    status: SpanStatus,
    extra: SpanExtra,
    envelope: bool,
) -> Leaf {
    Leaf {
        key,
        kind,
        parent,
        start,
        end,
        label,
        exit_code: None,
        out_bytes: None,
        status,
        extra,
        envelope,
    }
}

fn wire(session: &str, run: &str, l: Leaf, excl: Option<u64>) -> SpanWire {
    let extra = (l.extra != SpanExtra::default()).then_some(l.extra);
    SpanWire {
        key: Text::unchecked(head_utf16(&l.key, 300)),
        kind: l.kind,
        session_id: fleetd_contracts::ids::ThreadId::unchecked(session),
        run_id: Text::new(head_utf16(run, 120)).ok(),
        parent: l.parent.map(|p| Text::unchecked(head_utf16(&p, 300))),
        start_ms: count(l.start).unwrap_or_default(),
        end_ms: count(l.end).unwrap_or_default(),
        excl_ms: excl.and_then(count),
        label: l.label.map(|t| Text::unchecked(head_utf16(&t, LABEL_MAX))),
        exit_code: l.exit_code.and_then(|c| c.try_into().ok()),
        out_bytes: l.out_bytes.and_then(count),
        status: l.status,
        extra,
    }
}

fn count(n: u64) -> Option<Count> {
    i64::try_from(n).ok().and_then(|n| Count::try_from(n).ok())
}

/// The command, the path or the tool's main argument.
fn tool_label(name: &str, input: &Value) -> String {
    let field = |k: &str| input[k].as_str().filter(|s| !s.is_empty());
    let text = match name {
        "Bash" => field("command"),
        "Read" | "Edit" | "MultiEdit" | "Write" => field("file_path"),
        "NotebookEdit" => field("notebook_path"),
        "Grep" | "Glob" => field("pattern"),
        "LS" => field("path"),
        "WebFetch" => field("url"),
        "WebSearch" => field("query"),
        _ => None,
    };
    match text {
        Some(t) => head_utf16(t, LABEL_MAX).to_owned(),
        None if name.starts_with("mcp__") => {
            let first = input
                .as_object()
                .and_then(|o| o.iter().next())
                .map(|(k, v)| match v {
                    Value::String(s) => format!(" {k}={}", head_utf16(s, 200)),
                    other => format!(" {k}={}", head_utf16(&other.to_string(), 200)),
                })
                .unwrap_or_default();
            format!("{name}{first}")
        }
        None => name.to_owned(),
    }
}

fn tool_kind(name: &str, label: &str) -> SpanKind {
    match name {
        "Bash" => match program(label) {
            Some("git" | "gh") => SpanKind::Git,
            _ => SpanKind::ToolBash,
        },
        "Read" | "Grep" | "Glob" | "LS" => SpanKind::ToolRead,
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => SpanKind::ToolEdit,
        "WebFetch" | "WebSearch" => SpanKind::ToolWeb,
        n if n.starts_with("mcp__") => SpanKind::ToolMcp,
        _ => SpanKind::ToolOther,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlapping_tool_calls_share_one_group_and_every_run_tiles_exactly() {
        let mut b = SpanBuilder::new("s");
        b.run_started("r", 1000);
        b.tool_use(
            "a",
            "Bash",
            &serde_json::json!({"command": "sleep 3"}),
            1100,
        );
        b.tool_use("b", "Read", &serde_json::json!({"file_path": "/x"}), 1200);
        b.tool_result("b", "x", SpanStatus::Ok, None, None, 1300);
        b.tool_result("a", "ok", SpanStatus::Ok, Some(0), None, 1500);
        let spans = b.run_ended("r", SpanStatus::Ok, (None, None), 2000);
        let excl: i64 = spans.iter().map(|s| s.excl_ms.map_or(0, |e| e.get())).sum();
        assert_eq!(excl, 1000);
        let group = spans
            .iter()
            .find(|s| s.kind == SpanKind::ToolsParallel)
            .unwrap();
        assert_eq!((group.start_ms.get(), group.end_ms.get()), (1200, 1300));
        assert_eq!(group.excl_ms.unwrap().get(), 100);
        let bash = spans.iter().find(|s| s.kind == SpanKind::ToolBash).unwrap();
        assert_eq!(bash.excl_ms.unwrap().get(), 300);
        assert_eq!(bash.parent.as_deref(), Some("s/r/par/1"));
        assert_eq!(bash.out_bytes.unwrap().get(), 2);
    }
}
