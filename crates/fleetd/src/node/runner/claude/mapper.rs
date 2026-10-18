//! claude's stream-json, both ways, as a pure state machine: stdout [`Line`]s in, [`RunnerEvent`]s out, and the
//! stdin lines fleetd writes (user messages, permission answers, interrupts). No I/O and no clock: the session task
//! feeds it lines and the time, so every fixture replays through exactly the code that runs in production.
//!
//! Run accounting: every [`StreamMapper::send`] opens a run, and every open run ends with exactly one
//! [`RunnerEvent::RunEnded`]: from its `result`, from a `command_lifecycle` cancelled/completed that came without one
//! (a queued message cancelled by an interrupt), or from the process exit (a crash, a refusal such as "Session ID … is
//! already in use", or a kill).
use std::collections::HashMap;
use std::sync::Arc;

use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::prim::{NonEmpty, Text};
use fleetd_contracts::sessions::{
    FailureClass, ItemKind, ItemStatus, PermissionDecision, RunFailure, RunUsage, ThreadItem,
};
use serde_json::{Value, json};

use super::protocol::{
    Assistant, Block, CommandLifecycle, ControlRequest, Input, InputMessage, Line, ResultLine,
    StreamEvent, System, User, UserContent,
};
use crate::node::runner::conformance::missing_init_capabilities;
use crate::node::runner::failure::FailureEvidence;
use crate::node::runner::{ExitInfo, RateLimit, RunOutcome, RunnerEvent};
use crate::node::util::{head_utf16, tail_utf16};

/// Turns what claude left behind into a failure (R2's `failure::classify` in production).
pub type Classify = Arc<dyn Fn(&FailureEvidence) -> Option<RunFailure> + Send + Sync>;

const STDERR_TAIL: usize = 4000;
const MESSAGE_MAX: usize = 4000;

/// The time a line was read.
#[derive(Clone, Debug)]
pub struct Now {
    pub at: Timestamp,
    pub ms: u64,
}

impl Now {
    pub fn system() -> Self {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        Self {
            at: Timestamp::from(crate::node::util::now_iso()),
            ms,
        }
    }
}

/// What one stdout line produced.
#[derive(Debug, Default)]
pub struct Mapped {
    pub events: Vec<RunnerEvent>,
    /// stdin lines to write back at once (answers to control requests fleetd does not handle).
    pub replies: Vec<Input>,
}

struct OpenTool {
    run_id: Option<String>,
    title: String,
    started_at: Timestamp,
    kind: ItemKind,
}

struct PendingPermission {
    input: Value,
    tool_name: String,
    summary: String,
}

/// The synthetic assistant message claude sends before an API-error `result`.
struct AssistantError {
    error: Option<String>,
    status: Option<u16>,
    text: String,
}

pub struct StreamMapper {
    session_id: String,
    classify: Classify,
    /// Runs sent and not yet ended, oldest first.
    open_runs: Vec<String>,
    /// The run claude is executing (`command_lifecycle` started).
    active_run: Option<String>,
    tools: HashMap<String, OpenTool>,
    permissions: HashMap<String, PendingPermission>,
    /// The streaming message's id and the text-block ids by content-block index, so deltas and the complete
    /// [`RunnerEvent::AssistantText`] share an id.
    streaming: Option<String>,
    stream_text_blocks: HashMap<u64, String>,
    stream_text_count: usize,
    /// Text blocks already emitted per complete message id: claude sends one `assistant` line per block.
    text_blocks: Option<(String, usize)>,
    assistant_error: Option<AssistantError>,
    rate_limit: Option<RateLimit>,
    compacting: bool,
    /// The id of an interrupt in flight; tool errors until the run ends are cancellations, not failures.
    interrupt: Option<String>,
    interrupts_sent: u64,
    /// Shutdown was requested: a run cut by the exit is Interrupted, not Failed.
    stopping: bool,
    stderr_tail: String,
    run_stderr: String,
    minted: u64,
    warned_capabilities: bool,
}

impl StreamMapper {
    pub fn new(session_id: impl Into<String>, classify: Classify) -> Self {
        Self {
            session_id: session_id.into(),
            classify,
            open_runs: Vec::new(),
            active_run: None,
            tools: HashMap::new(),
            permissions: HashMap::new(),
            streaming: None,
            stream_text_blocks: HashMap::new(),
            stream_text_count: 0,
            text_blocks: None,
            assistant_error: None,
            rate_limit: None,
            compacting: false,
            interrupt: None,
            interrupts_sent: 0,
            stopping: false,
            stderr_tail: String::new(),
            run_stderr: String::new(),
            minted: 0,
            warned_capabilities: false,
        }
    }

    /// The user message that starts run `run_id`. claude echoes the uuid on `command_lifecycle` and the `result`.
    pub fn send(&mut self, run_id: &str, text: &str) -> Input {
        self.open_runs.push(run_id.to_owned());
        Input::User {
            message: InputMessage {
                role: "user",
                content: text.to_owned(),
            },
            parent_tool_use_id: None,
            session_id: String::new(),
            uuid: run_id.to_owned(),
        }
    }

    pub fn interrupt(&mut self) -> Input {
        self.interrupts_sent += 1;
        let request_id = format!("fleetd-int-{}", self.interrupts_sent);
        self.interrupt = Some(request_id.clone());
        Input::ControlRequest {
            request_id,
            request: json!({"subtype": "interrupt"}),
        }
    }

    /// The answer to a pending `can_use_tool`; `None` when claude no longer waits for it. An allow without an edited
    /// input sends the original one: claude requires `updatedInput` on every allow.
    pub fn answer(&mut self, request_id: &str, decision: &PermissionDecision) -> Option<Input> {
        let pending = self.permissions.remove(request_id)?;
        let response = match decision {
            PermissionDecision::Allow { updated_input } => json!({
                "behavior": "allow",
                "updatedInput": updated_input.clone().unwrap_or(pending.input),
            }),
            PermissionDecision::Deny { message } => {
                json!({"behavior": "deny", "message": message.as_str()})
            }
        };
        Some(Input::ControlResponse {
            response: json!({"subtype": "success", "request_id": request_id, "response": response}),
        })
    }

    pub fn has_open_run(&self) -> bool {
        !self.open_runs.is_empty()
    }

    pub fn stopping(&mut self) {
        self.stopping = true;
    }

    /// One stderr line. Kept for the exit and for the failure message of the run it belongs to.
    pub fn stderr(&mut self, line: &str) {
        for buf in [&mut self.stderr_tail, &mut self.run_stderr] {
            if !buf.is_empty() {
                buf.push('\n');
            }
            buf.push_str(line);
            if buf.len() > STDERR_TAIL * 2 {
                *buf = tail_utf16(buf, STDERR_TAIL).to_owned();
            }
        }
    }

    pub fn stderr_tail(&self) -> String {
        tail_utf16(&self.stderr_tail, STDERR_TAIL).to_owned()
    }

    pub fn feed(&mut self, line: Line, now: &Now) -> Mapped {
        let mut out = Mapped::default();
        match line {
            Line::System(system) => self.system(system, now, &mut out.events),
            Line::Assistant(assistant) => self.assistant(assistant, now, &mut out.events),
            Line::User(user) => self.user(user, now, &mut out.events),
            Line::StreamEvent(event) => self.stream_event(event, &mut out.events),
            Line::Result(result) => self.result(result, now, &mut out.events),
            Line::ControlRequest(request) => self.control_request(request, &mut out),
            Line::ControlResponse(response) => {
                let body = response.response;
                if body.subtype != "success" {
                    tracing::warn!(
                        "claude refused control request {}: {}",
                        body.request_id,
                        body.error.unwrap_or_default()
                    );
                }
                // An interrupt with no run to stop must not mark the next run's tool errors as cancellations.
                if self.interrupt.as_deref() == Some(body.request_id.as_str())
                    && self.active_run.is_none()
                {
                    self.interrupt = None;
                }
            }
            Line::ControlCancelRequest(cancel) => {
                if let Some(p) = self.permissions.remove(&cancel.request_id) {
                    let item = self.item(
                        cancel.request_id.clone(),
                        ItemStatus::Cancelled,
                        format!("{} {}", p.tool_name, p.summary),
                        now.at.clone(),
                        Some(now),
                        ItemKind::Permission {
                            request_id: cancel.request_id,
                            tool_name: p.tool_name,
                            summary: p.summary,
                            decision: None,
                        },
                    );
                    out.events.push(RunnerEvent::Item(item));
                }
            }
            Line::RateLimitEvent(event) => {
                let info = event.rate_limit_info;
                let limit = RateLimit {
                    status: info.status,
                    resets_at: info.resets_at,
                    limit_type: info.rate_limit_type,
                    utilization: info.utilization,
                };
                self.rate_limit = Some(limit.clone());
                out.events.push(RunnerEvent::RateLimit(limit));
            }
            Line::CommandLifecycle(lifecycle) => self.lifecycle(lifecycle, now, &mut out.events),
            Line::Other => {}
        }
        out
    }

    /// The process ended: every run still open ends here, then [`RunnerEvent::Exited`].
    pub fn exited(&mut self, exit: ExitInfo, now: &Now) -> Vec<RunnerEvent> {
        let mut events = Vec::new();
        for run_id in self.open_runs.clone() {
            let outcome = if self.stopping || self.interrupt.is_some() {
                RunOutcome::Interrupted
            } else {
                let assistant = self.assistant_error.take();
                RunOutcome::Failed(self.failure(FailureEvidence {
                    is_error: false,
                    assistant_error: assistant.as_ref().and_then(|a| a.error.clone()),
                    api_error_status: assistant.as_ref().and_then(|a| a.status),
                    text: assistant.map(|a| a.text).unwrap_or_default(),
                    terminal_reason: None,
                    startup_failure_reason: None,
                    rate_limit: self.rate_limit.clone(),
                    exit: Some(exit.clone()),
                    stderr: self.run_stderr(),
                    now_ms: now.ms,
                }))
            };
            self.end_run(run_id, outcome, None, now, &mut events);
        }
        events.push(RunnerEvent::Exited(exit));
        events
    }

    fn system(&mut self, system: System, now: &Now, events: &mut Vec<RunnerEvent>) {
        match system.subtype.as_str() {
            "init" => {
                let missing =
                    missing_init_capabilities(system.capabilities.as_deref().unwrap_or_default());
                if !missing.is_empty() && !self.warned_capabilities {
                    self.warned_capabilities = true;
                    tracing::warn!(
                        "claude's stream-json lacks {missing:?}; interrupts and queued sends may misbehave"
                    );
                }
                events.push(RunnerEvent::Init {
                    version: system.claude_code_version.unwrap_or_default(),
                    model: system.model.unwrap_or_default(),
                    cwd: system.cwd.unwrap_or_default(),
                });
            }
            "status" => {
                let compacting = system.status.as_deref() == Some("compacting");
                if compacting != self.compacting {
                    self.compacting = compacting;
                    events.push(RunnerEvent::Compacting(compacting));
                }
            }
            "compact_boundary" => {
                let meta = system.compact_metadata;
                let id = system.uuid.unwrap_or_else(|| self.mint("compact"));
                let trigger = meta.as_ref().map_or("auto".into(), |m| m.trigger.clone());
                let item = self.item(
                    id,
                    ItemStatus::Completed,
                    format!("Compacted the context ({trigger})"),
                    now.at.clone(),
                    Some(now),
                    ItemKind::Compaction {
                        trigger,
                        pre_tokens: meta.as_ref().and_then(|m| m.pre_tokens),
                        post_tokens: meta.as_ref().and_then(|m| m.post_tokens),
                    },
                );
                events.push(RunnerEvent::Item(item));
            }
            "api_retry" => {
                let id = system.uuid.unwrap_or_else(|| self.mint("retry"));
                let attempt = system.attempt.unwrap_or(0);
                let max_retries = system.max_retries.unwrap_or(0);
                let error = system.error.unwrap_or_default();
                let status = system
                    .error_status
                    .map_or(String::new(), |s| format!(" ({s})"));
                let item = self.item(
                    id,
                    ItemStatus::Completed,
                    format!("claude retried the API call {attempt}/{max_retries}: {error}{status}"),
                    now.at.clone(),
                    Some(now),
                    ItemKind::ApiRetry {
                        attempt,
                        max_retries,
                        error_status: system.error_status,
                        error,
                    },
                );
                events.push(RunnerEvent::Item(item));
            }
            _ => {}
        }
    }

    fn lifecycle(&mut self, lifecycle: CommandLifecycle, now: &Now, events: &mut Vec<RunnerEvent>) {
        let run_id = lifecycle.command_uuid;
        match lifecycle.state.as_str() {
            "started" => {
                if !self.open_runs.contains(&run_id) {
                    self.open_runs.push(run_id.clone());
                }
                self.active_run = Some(run_id.clone());
                self.run_stderr.clear();
                self.assistant_error = None;
                events.push(RunnerEvent::RunStarted { run_id });
            }
            // After a `result` these are bookkeeping; without one the message never ran to a result.
            state @ ("cancelled" | "completed") if self.open_runs.contains(&run_id) => {
                let outcome = if state == "cancelled" {
                    RunOutcome::Interrupted
                } else {
                    RunOutcome::Completed {
                        text: String::new(),
                    }
                };
                self.end_run(run_id, outcome, None, now, events);
            }
            _ => {}
        }
    }

    fn stream_event(&mut self, event: StreamEvent, events: &mut Vec<RunnerEvent>) {
        if event.parent_tool_use_id.is_some() {
            return;
        }
        let ev = &event.event;
        match ev["type"].as_str().unwrap_or_default() {
            "message_start" => {
                self.streaming = ev["message"]["id"]
                    .as_str()
                    .map(str::to_owned)
                    .or(event.api_message_id);
                self.stream_text_blocks.clear();
                self.stream_text_count = 0;
            }
            "content_block_start" if ev["content_block"]["type"] == "text" => {
                let message = self.streaming.clone().or(event.api_message_id);
                if let (Some(message), Some(index)) = (message, ev["index"].as_u64()) {
                    let id = text_id(&message, self.stream_text_count);
                    self.stream_text_count += 1;
                    self.stream_text_blocks.insert(index, id);
                }
            }
            "content_block_delta" if ev["delta"]["type"] == "text_delta" => {
                let append = ev["delta"]["text"].as_str().unwrap_or_default();
                let id = ev["index"]
                    .as_u64()
                    .and_then(|i| self.stream_text_blocks.get(&i).cloned())
                    .or_else(|| self.streaming.clone())
                    .or(event.api_message_id);
                if let Some(message_id) = id
                    && !append.is_empty()
                {
                    events.push(RunnerEvent::Delta {
                        message_id,
                        append: append.to_owned(),
                    });
                }
            }
            _ => {}
        }
    }

    fn assistant(&mut self, assistant: Assistant, now: &Now, events: &mut Vec<RunnerEvent>) {
        if assistant.parent_tool_use_id.is_some() {
            return;
        }
        let message = assistant.message;
        if assistant.error.is_some() {
            // Not the model speaking: claude's own error text. It becomes the run's failure, not its reply, so the
            // hub never reads "Not logged in · Please run /login" as the agent's answer.
            self.assistant_error = Some(AssistantError {
                error: assistant.error,
                status: assistant.api_error_status,
                text: block_texts(&message.content),
            });
            return;
        }
        for block in message.content {
            match block {
                Block::Text { text } => {
                    let ordinal = match &mut self.text_blocks {
                        Some((id, count)) if *id == message.id => {
                            *count += 1;
                            *count - 1
                        }
                        slot => {
                            *slot = Some((message.id.clone(), 1));
                            0
                        }
                    };
                    events.push(RunnerEvent::AssistantText {
                        message_id: text_id(&message.id, ordinal),
                        text,
                    });
                }
                Block::ToolUse { id, name, input } => {
                    let (kind, title) = tool_kind(&name, input);
                    let tool = OpenTool {
                        run_id: self.active_run.clone(),
                        title: title.clone(),
                        started_at: now.at.clone(),
                        kind: kind.clone(),
                    };
                    self.tools.insert(id.clone(), tool);
                    let item =
                        self.item(id, ItemStatus::Running, title, now.at.clone(), None, kind);
                    events.push(RunnerEvent::Item(item));
                }
                _ => {}
            }
        }
    }

    fn user(&mut self, user: User, now: &Now, events: &mut Vec<RunnerEvent>) {
        if user.parent_tool_use_id.is_some() || user.is_replay {
            return;
        }
        let UserContent::Blocks(blocks) = user.message.content else {
            return;
        };
        for block in blocks {
            let Block::ToolResult {
                tool_use_id,
                content,
                is_error,
            } = block
            else {
                continue;
            };
            let Some(tool) = self.tools.remove(&tool_use_id) else {
                continue;
            };
            let output = result_text(&content);
            let status = match (is_error, self.interrupt.is_some()) {
                (false, _) => ItemStatus::Completed,
                (true, true) => ItemStatus::Cancelled,
                (true, false) => ItemStatus::Failed,
            };
            let kind = match tool.kind {
                ItemKind::Command {
                    command,
                    timeout_ms,
                    ..
                } => ItemKind::Command {
                    command,
                    timeout_ms,
                    exit_code: match status {
                        ItemStatus::Completed => Some(0),
                        _ => exit_code(&output),
                    },
                    output: Some(output),
                    output_omitted: false,
                },
                ItemKind::Tool {
                    tool_name, input, ..
                } => ItemKind::Tool {
                    tool_name,
                    input,
                    output: Some(output),
                    output_omitted: false,
                },
                other => other,
            };
            let mut item = self.item(
                tool_use_id,
                status,
                tool.title,
                tool.started_at,
                Some(now),
                kind,
            );
            item.run_id = tool.run_id.and_then(|r| NonEmpty::new(r).ok());
            events.push(RunnerEvent::Item(item));
        }
    }

    fn control_request(&mut self, request: ControlRequest, out: &mut Mapped) {
        let body = request.request;
        if body.subtype != "can_use_tool" {
            // Anything else claude asks would wait forever for an answer nobody sends.
            out.replies.push(Input::ControlResponse {
                response: json!({
                    "subtype": "error",
                    "request_id": request.request_id,
                    "error": format!("fleetd does not handle {}", body.subtype),
                }),
            });
            return;
        }
        let tool_name = body.tool_name.unwrap_or_default();
        let input = body.input.unwrap_or(Value::Null);
        let summary = permission_summary(
            &tool_name,
            &input,
            body.description.as_deref(),
            body.blocked_path.as_deref(),
        );
        self.permissions.insert(
            request.request_id.clone(),
            PendingPermission {
                input: input.clone(),
                tool_name: tool_name.clone(),
                summary: summary.clone(),
            },
        );
        out.events.push(RunnerEvent::PermissionRequest {
            request_id: request.request_id,
            tool_use_id: body.tool_use_id.unwrap_or_default(),
            tool_name,
            input,
            summary,
        });
    }

    fn result(&mut self, result: ResultLine, now: &Now, events: &mut Vec<RunnerEvent>) {
        let Some(run_id) = result
            .user_message_uuid
            .clone()
            .or_else(|| self.active_run.clone())
            .or_else(|| self.open_runs.first().cloned())
        else {
            return;
        };
        let usage = result.usage.as_ref().map(|u| RunUsage {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cache_read_input_tokens: u.cache_read_input_tokens,
            cache_creation_input_tokens: u.cache_creation_input_tokens,
            cost_usd: result.total_cost_usd,
        });
        let aborted = result
            .terminal_reason
            .as_deref()
            .is_some_and(|r| r.starts_with("aborted"));
        let outcome = if aborted
            || (self.interrupt.is_some() && result.subtype == "error_during_execution")
        {
            RunOutcome::Interrupted
        } else if !result.is_error && result.subtype == "success" {
            RunOutcome::Completed {
                text: result.result.unwrap_or_default(),
            }
        } else {
            let assistant = self.assistant_error.take();
            let text = result
                .result
                .clone()
                .filter(|t| !t.is_empty())
                .or_else(|| assistant.as_ref().map(|a| a.text.clone()))
                .or_else(|| result.errors.as_ref().map(|e| e.join("\n")))
                .unwrap_or_default();
            RunOutcome::Failed(
                self.failure(FailureEvidence {
                    is_error: result.is_error,
                    assistant_error: assistant.as_ref().and_then(|a| a.error.clone()),
                    api_error_status: result
                        .api_error_status
                        .or(assistant.as_ref().and_then(|a| a.status)),
                    text,
                    terminal_reason: result.terminal_reason,
                    startup_failure_reason: result.startup_failure_reason,
                    rate_limit: self.rate_limit.clone(),
                    exit: None,
                    stderr: self.run_stderr(),
                    now_ms: now.ms,
                }),
            )
        };
        self.end_run(run_id, outcome, usage, now, events);
    }

    fn end_run(
        &mut self,
        run_id: String,
        outcome: RunOutcome,
        usage: Option<RunUsage>,
        now: &Now,
        events: &mut Vec<RunnerEvent>,
    ) {
        // A tool call the run never finished (killed mid-tool) must not stay "running" forever.
        let mut cut: Vec<String> = self
            .tools
            .iter()
            .filter(|(_, t)| t.run_id.as_deref().is_none_or(|r| r == run_id.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
        cut.sort();
        for id in cut {
            let tool = self.tools.remove(&id).expect("listed above");
            let mut item = self.item(
                id,
                ItemStatus::Cancelled,
                tool.title,
                tool.started_at,
                Some(now),
                tool.kind,
            );
            item.run_id = NonEmpty::new(run_id.clone()).ok();
            events.push(RunnerEvent::Item(item));
        }
        if self.compacting {
            self.compacting = false;
            events.push(RunnerEvent::Compacting(false));
        }
        if let RunOutcome::Failed(failure) = &outcome {
            let id = format!("{run_id}-error");
            let title = failure
                .message
                .lines()
                .next()
                .unwrap_or_default()
                .to_owned();
            let mut item = self.item(
                id,
                ItemStatus::Failed,
                title,
                now.at.clone(),
                Some(now),
                ItemKind::Error {
                    failure: failure.clone(),
                },
            );
            item.run_id = NonEmpty::new(run_id.clone()).ok();
            events.push(RunnerEvent::Item(item));
        }
        self.open_runs.retain(|r| *r != run_id);
        if self.active_run.as_deref() == Some(run_id.as_str()) {
            self.active_run = None;
        }
        self.interrupt = None;
        self.assistant_error = None;
        events.push(RunnerEvent::RunEnded {
            run_id,
            outcome,
            usage,
        });
    }

    /// The classified failure. The classifier puts claude's stderr for the run under its text (T3 dropped it).
    fn failure(&self, evidence: FailureEvidence) -> RunFailure {
        (self.classify)(&evidence).unwrap_or_else(|| RunFailure {
            class: if evidence.exit.is_some() {
                FailureClass::ProcessExited
            } else {
                FailureClass::Other
            },
            message: Text::new(head_utf16(evidence.text.trim(), MESSAGE_MAX))
                .unwrap_or_else(|_| Text::unchecked("claude ended the run with an error")),
            api_status: evidence.api_error_status,
            reset_at: None,
            retries: 0,
        })
    }

    /// stderr since the active run started (since the process started, before any run).
    fn run_stderr(&self) -> String {
        tail_utf16(&self.run_stderr, STDERR_TAIL).to_owned()
    }

    fn item(
        &self,
        id: String,
        status: ItemStatus,
        title: String,
        started_at: Timestamp,
        completed: Option<&Now>,
        kind: ItemKind,
    ) -> ThreadItem {
        let updated_at = completed.map_or(started_at.clone(), |n| n.at.clone());
        ThreadItem {
            id: NonEmpty::new(id).unwrap_or_else(|_| NonEmpty::unchecked("item")),
            run_id: self.active_run.clone().and_then(|r| NonEmpty::new(r).ok()),
            status,
            title,
            started_at,
            completed_at: completed.map(|n| n.at.clone()),
            updated_at,
            kind,
        }
    }

    fn mint(&mut self, what: &str) -> String {
        self.minted += 1;
        format!("{}-{what}-{}", self.session_id, self.minted)
    }
}

/// The id of a message's `ordinal`-th text block: the message id itself for the first, so the usual one-block reply
/// keeps claude's id.
fn text_id(message_id: &str, ordinal: usize) -> String {
    if ordinal == 0 {
        message_id.to_owned()
    } else {
        format!("{message_id}:{ordinal}")
    }
}

fn block_texts(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A tool_result's content: a string, or text blocks.
fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Bash reports a failing command as "Exit code N" on the result's first line.
fn exit_code(output: &str) -> Option<i64> {
    output
        .strip_prefix("Exit code ")?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input[key].as_str().filter(|s| !s.is_empty())
}

fn tool_kind(name: &str, input: Value) -> (ItemKind, String) {
    match name {
        "Bash" => {
            let command = str_field(&input, "command").unwrap_or_default().to_owned();
            let title = str_field(&input, "description")
                .unwrap_or(command.as_str())
                .to_owned();
            let kind = ItemKind::Command {
                timeout_ms: input["timeout"].as_u64(),
                command,
                output: None,
                output_omitted: false,
                exit_code: None,
            };
            (kind, title)
        }
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => {
            let path = str_field(&input, "file_path")
                .or(str_field(&input, "notebook_path"))
                .unwrap_or_default()
                .to_owned();
            let title = format!("{name} {path}");
            let kind = ItemKind::FileChange {
                tool_name: name.to_owned(),
                path,
            };
            (kind, title)
        }
        _ => {
            let kind = ItemKind::Tool {
                tool_name: name.to_owned(),
                input,
                output: None,
                output_omitted: false,
            };
            (kind, name.to_owned())
        }
    }
}

/// One line for a person deciding: the command, the path, or the tool's own description.
fn permission_summary(
    tool_name: &str,
    input: &Value,
    description: Option<&str>,
    blocked_path: Option<&str>,
) -> String {
    let text = match tool_name {
        "Bash" => str_field(input, "command"),
        _ => str_field(input, "file_path").or(str_field(input, "notebook_path")),
    }
    .or(description.filter(|d| !d.is_empty()))
    .or(blocked_path)
    .unwrap_or(tool_name);
    let first = head_utf16(text.lines().next().unwrap_or_default(), 1990);
    if first.len() < text.trim_end().len() {
        format!("{first} …")
    } else {
        first.to_owned()
    }
}

#[cfg(test)]
mod tests;
