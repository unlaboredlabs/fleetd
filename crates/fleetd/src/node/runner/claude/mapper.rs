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
    FailureClass, ItemKind, ItemStatus, PermissionDecision, RunFailure, RunUsage, SendMode,
    SendNow, ThreadItem,
};
use fleetd_contracts::time::{DecidedBy, SpanStatus};
use serde_json::{Value, json};

use super::protocol::{
    Assistant, Block, CommandLifecycle, ControlRequest, Input, InputMessage, Line, ResultLine,
    StreamEvent, System, User, UserContent,
};
use super::spans::SpanBuilder;
use crate::node::runner::conformance::{
    SEND_NOW_CAPABILITY, auto_memory_on, missing_init_capabilities,
};
use crate::node::runner::failure::FailureEvidence;
use crate::node::runner::{ExitInfo, RateLimit, RunOutcome, RunnerEvent};
use crate::node::util::{head_utf16, tail_utf16};

/// Turns what claude left behind into a failure (R2's `failure::classify` in production).
pub type Classify = Arc<dyn Fn(&FailureEvidence) -> Option<RunFailure> + Send + Sync>;

const STDERR_TAIL: usize = 4000;
const MESSAGE_MAX: usize = 4000;
const THINKING_TITLE_MAX: usize = 120;

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

/// A control request fleetd sent whose answer it reads.
enum Control {
    /// A mode-`now` send's stop (`send_now`, or an interrupt in its place).
    Stop {
        run_id: String,
        stopped_tool: Option<String>,
    },
    Withdraw {
        run_id: String,
        /// Sent because a person stopped the turn the steer waited on.
        by_stop: bool,
    },
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
    /// The active run's usage: the messages it finished, and the one streaming now (claude reports each message's
    /// usage on `message_start`, then cumulative output on `message_delta`).
    usage_done: RunUsage,
    usage_now: RunUsage,
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
    spans: SpanBuilder,
    /// The latest `system/init` capabilities; none before the process's first turn.
    capabilities: Option<Vec<String>>,
    /// Steers (`boundary`, `now`) sent while a turn ran and not yet started: an aborted `result` then supersedes.
    steers_waiting: Vec<String>,
    /// A mode-`now` send waiting for its `queued` before fleetd asks claude to send it now.
    send_now: Option<String>,
    controls: HashMap<String, Control>,
    /// Steers that waited on a turn a person stopped: claude drops them, and they end withdrawn, not failed.
    dropped_by_stop: Vec<String>,
    /// Runs an older claude merged into the running turn; they end with its `result`.
    joined: Vec<String>,
    withdraws_sent: u64,
}

impl StreamMapper {
    pub fn new(session_id: impl Into<String>, classify: Classify) -> Self {
        let session_id: String = session_id.into();
        let session_id_for_spans = session_id.clone();
        Self {
            session_id,
            classify,
            open_runs: Vec::new(),
            active_run: None,
            tools: HashMap::new(),
            permissions: HashMap::new(),
            streaming: None,
            stream_text_blocks: HashMap::new(),
            stream_text_count: 0,
            usage_done: RunUsage::default(),
            usage_now: RunUsage::default(),
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
            spans: SpanBuilder::new(session_id_for_spans.clone()),
            capabilities: None,
            steers_waiting: Vec::new(),
            send_now: None,
            controls: HashMap::new(),
            dropped_by_stop: Vec::new(),
            joined: Vec::new(),
            withdraws_sent: 0,
        }
    }

    /// The stdin lines that start run `run_id`. claude echoes the uuid on `command_lifecycle` and the `result`.
    ///
    /// `Plain` is today's send. `Boundary` asks for `priority: "now"`: the running turn ends at its next tool boundary
    /// and the message gets its own turn. `Now` sends the message, then on its `queued` asks claude to send it now,
    /// which stops the running step; without `interrupt_send_now_v1` it first interrupts the running message
    /// (`interrupt_receipt_v1`), else interrupts plainly. Between turns every mode is a plain new turn.
    pub fn send(&mut self, run_id: &str, text: &str, mode: SendMode) -> Vec<Input> {
        let mut out = Vec::new();
        let running = self.active_run.clone();
        if mode != SendMode::Plain && running.is_some() {
            self.steers_waiting.push(run_id.to_owned());
        }
        if let (SendMode::Now, Some(running)) = (mode, running) {
            let caps = self.capabilities.as_deref().unwrap_or_default();
            let has = |c: &str| caps.iter().any(|x| x == c);
            if has(SEND_NOW_CAPABILITY) && has("msg_lifecycle_v1") {
                self.send_now = Some(run_id.to_owned());
            } else {
                let request = if has("interrupt_receipt_v1") {
                    json!({"subtype": "interrupt", "for_user_message_uuids": [running]})
                } else {
                    json!({"subtype": "interrupt"})
                };
                out.push(self.stop_request(run_id, request));
            }
        }
        self.open_runs.push(run_id.to_owned());
        out.push(Input::User {
            message: InputMessage {
                role: "user",
                content: text.to_owned(),
            },
            parent_tool_use_id: None,
            session_id: String::new(),
            uuid: run_id.to_owned(),
            priority: (mode == SendMode::Boundary).then_some("now"),
        });
        out
    }

    /// `cancel_async_message` for a send claude still holds queued; `None` once it has started (nothing to withdraw).
    pub fn withdraw(&mut self, run_id: &str) -> Option<Input> {
        let waiting = self.open_runs.iter().any(|r| r == run_id)
            && self.active_run.as_deref() != Some(run_id)
            && !self.joined.iter().any(|r| r == run_id);
        if !waiting {
            return None;
        }
        Some(self.withdraw_request(run_id.to_owned(), false))
    }

    fn withdraw_request(&mut self, run_id: String, by_stop: bool) -> Input {
        self.withdraws_sent += 1;
        let request_id = format!("fleetd-withdraw-{}", self.withdraws_sent);
        let request = json!({"subtype": "cancel_async_message", "message_uuid": run_id});
        self.controls
            .insert(request_id.clone(), Control::Withdraw { run_id, by_stop });
        Input::ControlRequest {
            request_id,
            request,
        }
    }

    pub fn interrupt(&mut self) -> Input {
        self.interrupt_request(json!({"subtype": "interrupt"}))
    }

    /// A person's (or the watchdog's) stop: the interrupt, then a withdraw of every steer that waited on the turn.
    /// The turn ends interrupted, not superseded, and the steers end withdrawn, never as a new turn after the stop.
    pub fn stop(&mut self) -> Vec<Input> {
        let waiting = std::mem::take(&mut self.steers_waiting);
        self.send_now = None;
        let mut out = vec![self.interrupt()];
        for run_id in waiting {
            self.dropped_by_stop.push(run_id.clone());
            out.push(self.withdraw_request(run_id, true));
        }
        out
    }

    fn interrupt_request(&mut self, request: Value) -> Input {
        self.interrupts_sent += 1;
        let request_id = format!("fleetd-int-{}", self.interrupts_sent);
        self.interrupt = Some(request_id.clone());
        Input::ControlRequest {
            request_id,
            request,
        }
    }

    /// An interrupt that stops the running step for steer `run_id`; its answer becomes [`RunnerEvent::SendNow`].
    fn stop_request(&mut self, run_id: &str, request: Value) -> Input {
        let input = self.interrupt_request(request);
        if let Input::ControlRequest { request_id, .. } = &input {
            let stopped_tool = self.running_tool();
            let run_id = run_id.to_owned();
            self.controls.insert(
                request_id.clone(),
                Control::Stop {
                    run_id,
                    stopped_tool,
                },
            );
        }
        input
    }

    /// A withdraw is pending for `run_id`, or it waited on a turn a person stopped.
    fn withdrawing(&self, run_id: &str) -> bool {
        self.dropped_by_stop.iter().any(|r| r == run_id)
            || self
                .controls
                .values()
                .any(|c| matches!(c, Control::Withdraw { run_id: r, .. } if r == run_id))
    }

    /// The title of the running turn's oldest unfinished tool call.
    fn running_tool(&self) -> Option<String> {
        let active = self.active_run.as_deref();
        self.tools
            .values()
            .filter(|t| t.run_id.as_deref() == active)
            .min_by(|a, b| a.started_at.cmp(&b.started_at))
            .map(|t| t.title.clone())
    }

    /// The answer to a pending `can_use_tool`; `None` when claude no longer waits for it. An allow without an edited
    /// input sends the original one: claude requires `updatedInput` on every allow.
    pub fn answer(
        &mut self,
        request_id: &str,
        decision: &PermissionDecision,
        by: Option<DecidedBy>,
        now: &Now,
    ) -> Option<Input> {
        let pending = self.permissions.remove(request_id)?;
        self.spans.answered(request_id, by, now.ms);
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
            Line::StreamEvent(event) => self.stream_event(event, now, &mut out.events),
            Line::Result(result) => self.result(result, now, &mut out.events),
            Line::ControlRequest(request) => self.control_request(request, now, &mut out),
            Line::ControlResponse(response) => {
                let body = response.response;
                if let Some(control) = self.controls.remove(&body.request_id) {
                    let answer = body.response.clone().unwrap_or_default();
                    let ok = body.subtype == "success";
                    out.events.push(match control {
                        Control::Stop {
                            run_id,
                            stopped_tool,
                        } => {
                            let outcome = send_now_outcome(ok, &answer);
                            if outcome != SendNow::Stopped
                                && self.interrupt.as_deref() == Some(body.request_id.as_str())
                            {
                                self.interrupt = None;
                            }
                            RunnerEvent::SendNow {
                                run_id,
                                stopped_tool: stopped_tool.filter(|_| outcome == SendNow::Stopped),
                                outcome,
                            }
                        }
                        Control::Withdraw { run_id, by_stop } => RunnerEvent::Withdrawn {
                            run_id,
                            cancelled: ok && answer["cancelled"].as_bool() == Some(true),
                            by_stop,
                        },
                    });
                }
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
                    self.spans.withdrawn(&cancel.request_id, now.ms);
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
            Line::CommandLifecycle(lifecycle) => self.lifecycle(lifecycle, now, &mut out),
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
            self.end_run(run_id, outcome, None, (None, None), now, &mut events);
        }
        events.push(RunnerEvent::Exited(exit));
        events
    }

    fn system(&mut self, system: System, now: &Now, events: &mut Vec<RunnerEvent>) {
        match system.subtype.as_str() {
            "init" => {
                let missing =
                    missing_init_capabilities(system.capabilities.as_deref().unwrap_or_default());
                self.capabilities = Some(system.capabilities.clone().unwrap_or_default());
                if !missing.is_empty() && !self.warned_capabilities {
                    self.warned_capabilities = true;
                    tracing::warn!(
                        "claude's stream-json lacks {missing:?}; interrupts and queued sends may misbehave"
                    );
                }
                events.push(RunnerEvent::Init {
                    auto_memory: auto_memory_on(system.memory_paths.as_ref()),
                    version: system.claude_code_version.unwrap_or_default(),
                    model: system.model.unwrap_or_default(),
                    cwd: system.cwd.unwrap_or_default(),
                });
            }
            "status" => {
                if system.status.as_deref() == Some("requesting")
                    && let Some(run_ids) =
                        system.user_message_uuids.clone().filter(|u| !u.is_empty())
                {
                    events.push(RunnerEvent::Seen { run_ids });
                }
                let compacting = system.status.as_deref() == Some("compacting");
                if compacting != self.compacting {
                    self.compacting = compacting;
                    self.spans.compacting(compacting, now.ms);
                    events.push(RunnerEvent::Compacting(compacting));
                }
            }
            "compact_boundary" => {
                self.spans.compacting(false, now.ms);
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
                self.spans
                    .api_retry(attempt, system.retry_delay_ms, system.error_status, now.ms);
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
                        retry_delay_ms: system.retry_delay_ms,
                    },
                );
                events.push(RunnerEvent::Item(item));
            }
            _ => {}
        }
    }

    fn lifecycle(&mut self, lifecycle: CommandLifecycle, now: &Now, out: &mut Mapped) {
        let run_id = lifecycle.command_uuid;
        match lifecycle.state.as_str() {
            "queued" if self.open_runs.contains(&run_id) => {
                if self.send_now.as_deref() == Some(run_id.as_str()) {
                    self.send_now = None;
                    let request =
                        json!({"subtype": "interrupt", "send_now": true, "message_uuid": run_id});
                    out.replies.push(self.stop_request(&run_id, request));
                }
                out.events.push(RunnerEvent::Queued { run_id });
            }
            // A `started` while another run's turn is still open: claude joined this message to that turn.
            "started"
                if self
                    .active_run
                    .as_ref()
                    .is_some_and(|a| *a != run_id && self.open_runs.contains(a)) =>
            {
                self.steers_waiting.retain(|r| *r != run_id);
                if !self.open_runs.contains(&run_id) {
                    self.open_runs.push(run_id.clone());
                }
                self.joined.push(run_id.clone());
                out.events.push(RunnerEvent::Joined { run_id });
            }
            // A joined run ends with its turn's `result`.
            "cancelled" | "completed" if self.joined.contains(&run_id) => {}
            "started" => {
                self.steers_waiting.retain(|r| *r != run_id);
                if !self.open_runs.contains(&run_id) {
                    self.open_runs.push(run_id.clone());
                }
                self.active_run = Some(run_id.clone());
                self.run_stderr.clear();
                self.assistant_error = None;
                self.usage_done = RunUsage::default();
                self.usage_now = RunUsage::default();
                self.spans.run_started(&run_id, now.ms);
                out.events.push(RunnerEvent::RunStarted { run_id });
            }
            // claude says `cancelled` before it answers the withdraw: that is the withdraw's success. A steer that
            // waited on a stopped turn is dropped the same way.
            "cancelled" if self.open_runs.contains(&run_id) && self.withdrawing(&run_id) => {
                let by_stop = self.dropped_by_stop.contains(&run_id);
                self.controls.retain(
                    |_, c| !matches!(c, Control::Withdraw { run_id: r, .. } if *r == run_id),
                );
                self.dropped_by_stop.retain(|r| *r != run_id);
                out.events.push(RunnerEvent::Withdrawn {
                    run_id: run_id.clone(),
                    cancelled: true,
                    by_stop,
                });
                self.end_run(
                    run_id,
                    RunOutcome::Interrupted,
                    None,
                    (None, None),
                    now,
                    &mut out.events,
                );
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
                self.end_run(run_id, outcome, None, (None, None), now, &mut out.events);
            }
            _ => {}
        }
    }

    fn stream_event(&mut self, event: StreamEvent, now: &Now, events: &mut Vec<RunnerEvent>) {
        if event.parent_tool_use_id.is_some() {
            return;
        }
        let ev = &event.event;
        self.spans.stream(ev, now.ms);
        match ev["type"].as_str().unwrap_or_default() {
            "message_start" => {
                self.streaming = ev["message"]["id"]
                    .as_str()
                    .map(str::to_owned)
                    .or(event.api_message_id);
                self.stream_text_blocks.clear();
                self.stream_text_count = 0;
                let done = std::mem::take(&mut self.usage_now);
                add_usage(&mut self.usage_done, &done);
                self.stream_usage(&ev["message"]["usage"], events);
            }
            "message_delta" => self.stream_usage(&ev["usage"], events),
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

    /// Folds a streamed usage object into the current message's and reports the run's total so far.
    fn stream_usage(&mut self, usage: &serde_json::Value, events: &mut Vec<RunnerEvent>) {
        let Some(usage) = usage.as_object() else {
            return;
        };
        let now = &mut self.usage_now;
        for (key, field) in [
            ("input_tokens", &mut now.input_tokens),
            ("output_tokens", &mut now.output_tokens),
            ("cache_read_input_tokens", &mut now.cache_read_input_tokens),
            (
                "cache_creation_input_tokens",
                &mut now.cache_creation_input_tokens,
            ),
        ] {
            if let Some(n) = usage.get(key).and_then(serde_json::Value::as_u64) {
                *field = n;
            }
        }
        let Some(run_id) = self.active_run.clone() else {
            return;
        };
        let mut total = self.usage_done.clone();
        add_usage(&mut total, &self.usage_now);
        events.push(RunnerEvent::Usage {
            run_id,
            usage: total,
        });
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
        let mut thinking_blocks = 0;
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
                    self.spans.tool_use(&id, &name, &input, now.ms);
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
                // `--thinking-display summarized`: claude's summary of its reasoning, kept as a finished item so the
                // app and actions_list show what the agent weighed, and the watchdog sees progress during long
                // thinking. Never AssistantText: it is not the reply. Empty or redacted blocks carry nothing to show.
                Block::Thinking { thinking } if !thinking.trim().is_empty() => {
                    thinking_blocks += 1;
                    let id = format!("{}:thinking:{thinking_blocks}", message.id);
                    let summary = thinking.trim();
                    let first = summary.lines().next().unwrap_or_default();
                    let title = format!("Thinking: {}", head_utf16(first, THINKING_TITLE_MAX));
                    let kind = ItemKind::Tool {
                        tool_name: "Thinking".into(),
                        input: Value::Null,
                        output: Some(summary.to_owned()),
                        output_omitted: false,
                    };
                    let item = self.item(
                        id,
                        ItemStatus::Completed,
                        title,
                        now.at.clone(),
                        Some(now),
                        kind,
                    );
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
        let tool_use_result = user.tool_use_result;
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
            let span_status = match status {
                ItemStatus::Completed => SpanStatus::Ok,
                ItemStatus::Cancelled => SpanStatus::Cancelled,
                _ => SpanStatus::Failed,
            };
            let span_exit = match (&tool.kind, status) {
                (ItemKind::Command { .. }, ItemStatus::Completed) => Some(0),
                (ItemKind::Command { .. }, _) => exit_code(&output),
                _ => None,
            };
            self.spans.tool_result(
                &tool_use_id,
                &output,
                span_status,
                span_exit,
                tool_use_result.as_ref(),
                now.ms,
            );
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

    fn control_request(&mut self, request: ControlRequest, now: &Now, out: &mut Mapped) {
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
        self.spans.permission(
            &request.request_id,
            body.tool_use_id.as_deref().unwrap_or_default(),
            &tool_name,
            now.ms,
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
        let cut =
            aborted || (self.interrupt.is_some() && result.subtype == "error_during_execution");
        let superseding = self.steers_waiting.iter().find(|r| **r != run_id).cloned();
        let outcome = if let (true, Some(by)) = (cut, superseding) {
            RunOutcome::Superseded { by }
        } else if cut {
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
        let durations = (result.duration_ms, result.duration_api_ms);
        let joined = std::mem::take(&mut self.joined);
        self.end_run(run_id, outcome.clone(), usage, durations, now, events);
        for run in joined {
            self.end_run(run, outcome.clone(), None, (None, None), now, events);
        }
    }

    fn end_run(
        &mut self,
        run_id: String,
        outcome: RunOutcome,
        usage: Option<RunUsage>,
        durations: (Option<u64>, Option<u64>),
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
        let span_status = match &outcome {
            RunOutcome::Completed { .. } => SpanStatus::Ok,
            RunOutcome::Interrupted | RunOutcome::Superseded { .. } => SpanStatus::Cancelled,
            RunOutcome::Failed(_) => SpanStatus::Failed,
        };
        let spans = self
            .spans
            .run_ended(&run_id, span_status, durations, now.ms);
        if !spans.is_empty() {
            events.push(RunnerEvent::Spans(spans));
        }
        self.open_runs.retain(|r| *r != run_id);
        self.steers_waiting.retain(|r| *r != run_id);
        self.dropped_by_stop.retain(|r| *r != run_id);
        self.joined.retain(|r| *r != run_id);
        if self.send_now.as_deref() == Some(run_id.as_str()) {
            self.send_now = None;
        }
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

    /// The classified failure. The classifier puts claude's stderr for the run under its text.
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

/// claude's answer to a stop: `send_now` (interrupt_send_now_v1) or `turn` (interrupt_receipt_v1); a plain
/// interrupt answers only success.
fn send_now_outcome(ok: bool, answer: &Value) -> SendNow {
    match (ok, answer["send_now"].as_str(), answer["turn"].as_str()) {
        (false, _, _) => SendNow::NothingWaiting,
        (_, Some("stopped"), _) | (_, None, Some("stopped") | None) => SendNow::Stopped,
        (_, Some("delivering"), _) => SendNow::Delivering,
        _ => SendNow::NothingWaiting,
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

fn add_usage(total: &mut RunUsage, more: &RunUsage) {
    total.input_tokens += more.input_tokens;
    total.output_tokens += more.output_tokens;
    total.cache_read_input_tokens += more.cache_read_input_tokens;
    total.cache_creation_input_tokens += more.cache_creation_input_tokens;
}
