//! A [`Runner`] for tests that replays a recorded claude transcript (`runner/fixtures`): each `Send` plays the next
//! user turn of the file with the run id swapped in, a permission prompt waits for its `Answer`, and `Shutdown`
//! ends the process. Its stream-json → event mapping covers only what the session service reacts to; the real
//! mapper is the Claude adapter's.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::prim::{NonEmpty, Text};
use fleetd_contracts::sessions::{
    FailureClass, ItemKind, ItemStatus, LoginStatus, RunFailure, RunnerInfo, RunnerKind, SendMode,
    SendNow, ThreadItem,
};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::node::runner::{
    BoxFut, ExitInfo, RunOutcome, Runner, RunnerError, RunnerEvent, SessionCommand, SessionHandle,
    SessionSpec,
};

/// One stdout line and its offset from the turn's start.
type Turn = Vec<(u64, Value)>;

pub struct FakeRunner {
    turns: Vec<Turn>,
    next_turn: Arc<AtomicUsize>,
    next_pid: AtomicU32,
    /// Replays lines at their recorded offsets (meant for paused tokio time).
    pub timed: bool,
    /// False: an interrupt is ignored, as by a claude stuck in a tool.
    pub honour_interrupt: bool,
    /// The next spawn fails with this refusal.
    pub refuse_next: Mutex<Option<String>>,
    pub spawns: Mutex<Vec<SessionSpec>>,
    /// Every command any process received, with the spawn index.
    pub commands: Arc<Mutex<Vec<(usize, SessionCommand)>>>,
}

impl FakeRunner {
    pub fn fixture(name: &str) -> Self {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/node/runner/fixtures")
            .join(format!("claude-2.1.302-{name}.jsonl"));
        Self::from_lines(&std::fs::read_to_string(path).unwrap())
    }

    pub fn from_lines(text: &str) -> Self {
        let mut turns: Vec<Turn> = Vec::new();
        let mut start = 0;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let rec: Value = serde_json::from_str(line).unwrap();
            let ms = rec["ms"].as_u64().unwrap_or(0);
            match rec["dir"].as_str() {
                Some("in") if rec["msg"]["type"] == "user" => {
                    turns.push(Vec::new());
                    start = ms;
                }
                Some("out") => {
                    if let Some(turn) = turns.last_mut() {
                        turn.push((ms.saturating_sub(start), rec["msg"].clone()));
                    }
                }
                _ => {}
            }
        }
        assert!(!turns.is_empty(), "fixture has no user turn");
        Self {
            turns,
            next_turn: Arc::new(AtomicUsize::new(0)),
            // Above any kernel's pid_max, so no test ever records (or signals) a real process.
            next_pid: AtomicU32::new(2_000_000_000),
            timed: false,
            honour_interrupt: true,
            refuse_next: Mutex::new(None),
            spawns: Mutex::new(Vec::new()),
            commands: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn spawned(&self) -> Vec<SessionSpec> {
        self.spawns.lock().unwrap().clone()
    }

    pub fn received(&self) -> Vec<SessionCommand> {
        self.commands
            .lock()
            .unwrap()
            .iter()
            .map(|(_, c)| c.clone())
            .collect()
    }
}

impl Runner for FakeRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Claude
    }

    fn probe<'a>(&'a self, _env: &'a [(String, String)]) -> BoxFut<'a, RunnerInfo> {
        Box::pin(async {
            RunnerInfo {
                runner: RunnerKind::Claude,
                version: Some("2.1.302 (Claude Code)".into()),
                supported: ">=2.1.300, <2.2.0".into(),
                version_ok: true,
                login: LoginStatus::LoggedIn,
                login_kind: Some("token".into()),
                conformance_ok: Some(true),
                problem: None,
                login_label: None,
                proxy: None,
                proxy_source: None,
                config_dir: None,
                auto_memory: None,
                agent_tools: Some(Vec::new()),
                subagent_leaks: Some(Vec::new()),
            }
        })
    }

    fn spawn(&self, spec: SessionSpec) -> Result<SessionHandle, RunnerError> {
        if let Some(refusal) = self.refuse_next.lock().unwrap().take() {
            return Err(RunnerError::Refused(refusal));
        }
        let index = {
            let mut spawns = self.spawns.lock().unwrap();
            spawns.push(spec);
            spawns.len() - 1
        };
        let (cmd_tx, cmd_rx) = mpsc::channel(16);
        let (ev_tx, ev_rx) = mpsc::channel(256);
        let process = Process {
            index,
            turns: self.turns.clone(),
            next_turn: self.next_turn.clone(),
            timed: self.timed,
            honour_interrupt: self.honour_interrupt,
            commands: self.commands.clone(),
            rx: cmd_rx,
            tx: ev_tx,
            backlog: VecDeque::new(),
        };
        tokio::spawn(process.run());
        Ok(SessionHandle {
            pid: self.next_pid.fetch_add(1, Ordering::Relaxed),
            commands: cmd_tx,
            events: ev_rx,
        })
    }
}

struct Process {
    index: usize,
    turns: Vec<Turn>,
    next_turn: Arc<AtomicUsize>,
    timed: bool,
    honour_interrupt: bool,
    commands: Arc<Mutex<Vec<(usize, SessionCommand)>>>,
    rx: mpsc::Receiver<SessionCommand>,
    tx: mpsc::Sender<RunnerEvent>,
    /// Sends that arrived mid-turn and wait in claude's queue. A plain send waits for the turn's end here (claude
    /// takes it in at the next tool boundary); a steer (`boundary`, `now`) ends the turn as superseded and plays next.
    backlog: VecDeque<(String, String)>,
}

enum Stop {
    /// The turn ended (normally or by interrupt).
    TurnOver,
    Exit(ExitInfo),
}

impl Process {
    async fn next_command(&mut self) -> Option<SessionCommand> {
        let command = self.rx.recv().await?;
        self.commands
            .lock()
            .unwrap()
            .push((self.index, command.clone()));
        Some(command)
    }

    async fn run(mut self) {
        let exit = loop {
            let (run_id, _text) = match self.backlog.pop_front() {
                Some(send) => send,
                None => match self.next_command().await {
                    None => break clean_exit(),
                    Some(SessionCommand::Send { run_id, text, .. }) => (run_id, text),
                    Some(SessionCommand::Withdraw { run_id }) => {
                        let withdrawn = RunnerEvent::Withdrawn {
                            run_id,
                            cancelled: false,
                            by_stop: false,
                        };
                        let _ = self.tx.send(withdrawn).await;
                        continue;
                    }
                    Some(SessionCommand::Shutdown { .. }) => break clean_exit(),
                    Some(_) => continue,
                },
            };
            match self.play(&run_id).await {
                Stop::TurnOver => {}
                Stop::Exit(exit) => break exit,
            }
        };
        let _ = self.tx.send(RunnerEvent::Exited(exit)).await;
    }

    /// Handles a command that arrives while a turn plays.
    fn during_turn(&mut self, command: SessionCommand, run_id: &str) -> Option<Stop> {
        match command {
            SessionCommand::Send {
                run_id: next,
                text,
                mode: SendMode::Plain,
            } => {
                self.backlog.push_back((next, text));
                None
            }
            SessionCommand::Send {
                run_id: steer,
                text,
                mode,
            } => {
                if mode == SendMode::Now {
                    let _ = self.tx.try_send(RunnerEvent::SendNow {
                        run_id: steer.clone(),
                        outcome: SendNow::Stopped,
                        stopped_tool: None,
                    });
                }
                let _ = self.tx.try_send(RunnerEvent::RunEnded {
                    run_id: run_id.to_owned(),
                    outcome: RunOutcome::Superseded { by: steer.clone() },
                    usage: None,
                });
                self.backlog.push_front((steer, text));
                Some(Stop::TurnOver)
            }
            SessionCommand::Withdraw { run_id: queued } => {
                let found = self.backlog.iter().position(|(r, _)| *r == queued);
                if let Some(at) = found {
                    self.backlog.remove(at);
                }
                let _ = self.tx.try_send(RunnerEvent::Withdrawn {
                    run_id: queued.clone(),
                    cancelled: found.is_some(),
                    by_stop: false,
                });
                if found.is_some() {
                    let _ = self.tx.try_send(RunnerEvent::RunEnded {
                        run_id: queued,
                        outcome: RunOutcome::Interrupted,
                        usage: None,
                    });
                }
                None
            }
            SessionCommand::Interrupt if self.honour_interrupt => {
                let _ = self.tx.try_send(RunnerEvent::RunEnded {
                    run_id: run_id.to_owned(),
                    outcome: RunOutcome::Interrupted,
                    usage: None,
                });
                Some(Stop::TurnOver)
            }
            SessionCommand::Shutdown { .. } => Some(Stop::Exit(ExitInfo {
                code: Some(143),
                signal: None,
                stderr_tail: String::new(),
            })),
            _ => None,
        }
    }

    async fn play(&mut self, run_id: &str) -> Stop {
        let n = self.next_turn.fetch_add(1, Ordering::Relaxed);
        let turn = self.turns[n % self.turns.len()].clone();
        let mut message_id = String::new();
        let mut api_error: Option<(String, Option<u16>)> = None;
        let mut clock = 0;
        for (ms, msg) in turn {
            if self.timed && ms > clock {
                let wait = tokio::time::sleep(Duration::from_millis(ms - clock));
                tokio::pin!(wait);
                loop {
                    tokio::select! {
                        () = &mut wait => break,
                        command = self.next_command() => match command {
                            None => return Stop::Exit(clean_exit()),
                            Some(command) => if let Some(stop) = self.during_turn(command, run_id) { return stop },
                        },
                    }
                }
                clock = ms;
            }
            while let Ok(command) = self.rx.try_recv() {
                self.commands
                    .lock()
                    .unwrap()
                    .push((self.index, command.clone()));
                if let Some(stop) = self.during_turn(command, run_id) {
                    return stop;
                }
            }
            for event in map_line(&msg, run_id, &mut message_id, &mut api_error) {
                let asks = matches!(event, RunnerEvent::PermissionRequest { .. });
                let _ = self.tx.send(event).await;
                if asks {
                    loop {
                        match self.next_command().await {
                            None => return Stop::Exit(clean_exit()),
                            Some(SessionCommand::Answer { .. }) => break,
                            Some(command) => {
                                if let Some(stop) = self.during_turn(command, run_id) {
                                    return stop;
                                }
                            }
                        }
                    }
                }
            }
        }
        Stop::TurnOver
    }
}

fn clean_exit() -> ExitInfo {
    ExitInfo {
        code: Some(0),
        signal: None,
        stderr_tail: String::new(),
    }
}

fn at() -> Timestamp {
    Timestamp::from("2026-10-18T00:00:00.000Z")
}

fn map_line(
    msg: &Value,
    run_id: &str,
    message_id: &mut String,
    api_error: &mut Option<(String, Option<u16>)>,
) -> Vec<RunnerEvent> {
    let s = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    match msg["type"].as_str().unwrap_or_default() {
        "system" if msg["subtype"] == "init" => vec![RunnerEvent::Init {
            version: s(&msg["claude_code_version"]),
            model: s(&msg["model"]),
            cwd: s(&msg["cwd"]),
            auto_memory: crate::node::runner::conformance::auto_memory_on(msg.get("memory_paths")),
            // The fixtures were recorded without fleetd's deny list, which a real claude would have applied.
            subagent_leaks: Vec::new(),
        }],
        "command_lifecycle" if msg["state"] == "started" => vec![RunnerEvent::RunStarted {
            run_id: run_id.to_owned(),
        }],
        "stream_event" => {
            let event = &msg["event"];
            match event["type"].as_str() {
                Some("message_start") => {
                    *message_id = s(&event["message"]["id"]);
                    vec![]
                }
                Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                    vec![RunnerEvent::Delta {
                        message_id: message_id.clone(),
                        append: s(&event["delta"]["text"]),
                    }]
                }
                _ => vec![],
            }
        }
        "assistant" => {
            if let Some(error) = msg["error"].as_str() {
                *api_error = Some((
                    error.to_owned(),
                    msg["api_error_status"].as_u64().map(|n| n as u16),
                ));
            }
            let id = s(&msg["message"]["id"]);
            let blocks = msg["message"]["content"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            blocks
                .iter()
                .filter_map(|block| match block["type"].as_str() {
                    Some("text") => Some(RunnerEvent::AssistantText {
                        message_id: id.clone(),
                        text: s(&block["text"]),
                    }),
                    Some("tool_use") => Some(RunnerEvent::Item(tool_item(
                        &s(&block["id"]),
                        run_id,
                        &s(&block["name"]),
                        &block["input"],
                        ItemStatus::Running,
                        None,
                    ))),
                    _ => None,
                })
                .collect()
        }
        "user" => {
            let blocks = msg["message"]["content"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            blocks
                .iter()
                .filter(|b| b["type"] == "tool_result")
                .map(|b| {
                    let status = if b["is_error"] == true {
                        ItemStatus::Failed
                    } else {
                        ItemStatus::Completed
                    };
                    RunnerEvent::Item(tool_item(
                        &s(&b["tool_use_id"]),
                        run_id,
                        "Bash",
                        &Value::Null,
                        status,
                        Some(s(&b["content"])),
                    ))
                })
                .collect()
        }
        "control_request" if msg["request"]["subtype"] == "can_use_tool" => {
            let request = &msg["request"];
            vec![RunnerEvent::PermissionRequest {
                request_id: s(&msg["request_id"]),
                tool_use_id: s(&request["tool_use_id"]),
                tool_name: s(&request["tool_name"]),
                input: request["input"].clone(),
                summary: s(&request["input"]["command"]),
            }]
        }
        "result" => {
            let text = s(&msg["result"]);
            let outcome = match (msg["is_error"] == true, api_error.take()) {
                (false, _) => RunOutcome::Completed { text },
                (true, error) => {
                    let class = match error.as_ref().map(|(e, _)| e.as_str()) {
                        Some("overloaded" | "server_error") => FailureClass::Overloaded,
                        Some("authentication_failed") => FailureClass::Auth,
                        _ => FailureClass::Other,
                    };
                    RunOutcome::Failed(RunFailure {
                        class,
                        message: Text::new(text.clone())
                            .unwrap_or_else(|_| Text::unchecked("failed")),
                        api_status: error.and_then(|(_, status)| status),
                        reset_at: None,
                        retries: 0,
                    })
                }
            };
            vec![RunnerEvent::RunEnded {
                run_id: run_id.to_owned(),
                outcome,
                usage: None,
            }]
        }
        _ => vec![],
    }
}

fn tool_item(
    id: &str,
    run_id: &str,
    name: &str,
    input: &Value,
    status: ItemStatus,
    output: Option<String>,
) -> ThreadItem {
    ThreadItem {
        id: NonEmpty::unchecked(id),
        run_id: Some(NonEmpty::unchecked(run_id)),
        status,
        title: name.to_owned(),
        started_at: at(),
        completed_at: None,
        updated_at: at(),
        kind: ItemKind::Command {
            command: input["command"].as_str().unwrap_or_default().to_owned(),
            timeout_ms: None,
            output,
            output_omitted: false,
            exit_code: None,
        },
    }
}
