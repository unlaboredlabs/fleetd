//! A [`Runner`] for tests that plays claude from a recorded transcript (`runner/fixtures`) through the real
//! [`StreamMapper`], so the session service sees the events production maps. Each user message plays the next
//! recorded user turn with its uuid swapped for the run id. The fake answers the mapper's stdin lines as claude
//! does: a permission prompt waits for its answer, an interrupt or a `now` message cuts the turn, a withdraw cancels
//! a queued message, and `Shutdown` ends the process.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::effort::{Effort, ProfileName};
use fleetd_contracts::sessions::{LoginStatus, RunnerInfo, RunnerKind};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::node::runner::claude::failure;
use crate::node::runner::claude::mapper::{Now, StreamMapper};
use crate::node::runner::claude::protocol::{Input, Line};
use crate::node::runner::host;
use crate::node::runner::{
    BoxFut, ExitInfo, ProfileModel, Runner, RunnerError, RunnerEvent, SessionCommand,
    SessionHandle, SessionSpec,
};

/// One recorded user turn: its message's uuid, and each stdout line with its offset from the turn's start.
#[derive(Clone)]
struct Turn {
    uuid: Option<String>,
    lines: Vec<(u64, Value)>,
}

pub struct FakeRunner {
    turns: Vec<Turn>,
    next_turn: Arc<AtomicUsize>,
    next_pid: AtomicU32,
    /// Replays lines at their recorded offsets (meant for paused tokio time).
    pub timed: bool,
    /// False: an interrupt is ignored, as by a claude stuck in a tool.
    pub honour_interrupt: bool,
    /// The next process refuses as claude does at startup: its first send fails, then it exits with these words.
    pub refuse_next: Mutex<Option<String>>,
    pub spawns: Mutex<Vec<SessionSpec>>,
    /// Every command any process received, with the spawn index.
    pub commands: Arc<Mutex<Vec<(usize, SessionCommand)>>>,
    /// A spec with a host dir starts under a host in this process (`runner::host`), which outlives the service as a
    /// real host outlives the node.
    pub hosted: bool,
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
                    turns.push(Turn {
                        uuid: rec["msg"]["uuid"].as_str().map(str::to_owned),
                        lines: Vec::new(),
                    });
                    start = ms;
                }
                Some("out") => {
                    if let Some(turn) = turns.last_mut() {
                        turn.lines
                            .push((ms.saturating_sub(start), rec["msg"].clone()));
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
            hosted: false,
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
                self_update: None,
                sandbox: None,
                account_overrides: None,
            }
        })
    }

    /// Works with a key or token in `env`, unless it starts with `bad`, which claude refuses and echoes back.
    fn try_account<'a>(&'a self, env: &'a [(String, String)]) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            let secret = env.iter().rev().find(|(k, _)| {
                k == fleetd_contracts::claude_accounts::OAUTH_TOKEN_ENV
                    || k == fleetd_contracts::claude_accounts::API_KEY_ENV
            });
            match secret {
                None => Err("Not logged in · Please run /login".to_owned()),
                Some((_, v)) if v.starts_with("bad") => Err(format!("Invalid API key: {v}")),
                Some(_) => Ok(()),
            }
        })
    }

    fn spawn(&self, spec: SessionSpec) -> Result<SessionHandle, RunnerError> {
        let refusal = self.refuse_next.lock().unwrap().take();
        let mapper = StreamMapper::new(spec.session_id.clone(), Arc::new(failure::classify));
        let denied = spec.disallowed_tools.clone();
        let host_dir = spec.host_dir.clone().filter(|_| self.hosted);
        let index = {
            let mut spawns = self.spawns.lock().unwrap();
            spawns.push(spec);
            spawns.len() - 1
        };
        let (cmd_tx, cmd_rx) = mpsc::channel(16);
        let (ev_tx, ev_rx) = mpsc::channel(256);
        let process = Process {
            refusal,
            index,
            turns: self.turns.clone(),
            next_turn: self.next_turn.clone(),
            timed: self.timed,
            honour_interrupt: self.honour_interrupt,
            commands: self.commands.clone(),
            rx: cmd_rx,
            tx: ev_tx,
            mapper,
            denied,
            queue: VecDeque::new(),
            playing: false,
            cut: false,
            asking: false,
            exit: None,
            out: Vec::new(),
        };
        tokio::spawn(process.run());
        let handle = SessionHandle {
            pid: self.next_pid.fetch_add(1, Ordering::Relaxed),
            commands: cmd_tx,
            events: ev_rx,
            link: None,
        };
        let Some(dir) = host_dir else {
            return Ok(handle);
        };
        let hosted = || -> std::io::Result<SessionHandle> {
            std::fs::create_dir_all(&dir)?;
            let marker = format!("fake.{}", handle.pid);
            host::serve_here(&dir, handle, marker, std::future::pending(), host::LINGER)?;
            Ok(host::connect(&dir)?.0)
        };
        hosted().map_err(|e| RunnerError::Spawn {
            binary: "fake".into(),
            message: e.to_string(),
        })
    }

    fn profile(&self, profile: &ProfileName) -> ProfileModel {
        crate::node::runner::claude::guide::profile(profile)
    }

    fn profile_of(&self, model: &str, effort: Effort) -> ProfileName {
        crate::node::runner::claude::guide::profile_of(model, effort)
    }
}

/// One fake claude process: the session task's side (commands through the mapper) and claude's (its stdin lines).
struct Process {
    /// claude's startup refusal, on stderr when its first send makes it exit.
    refusal: Option<String>,
    index: usize,
    turns: Vec<Turn>,
    next_turn: Arc<AtomicUsize>,
    timed: bool,
    honour_interrupt: bool,
    commands: Arc<Mutex<Vec<(usize, SessionCommand)>>>,
    rx: mpsc::Receiver<SessionCommand>,
    tx: mpsc::Sender<RunnerEvent>,
    mapper: StreamMapper,
    /// The spawn's `--disallowedTools`.
    denied: Vec<String>,
    /// User messages claude holds, by uuid, in the order it takes them.
    queue: VecDeque<String>,
    playing: bool,
    /// The playing turn ends now, aborted.
    cut: bool,
    /// A permission prompt waits for its answer.
    asking: bool,
    exit: Option<i32>,
    /// Mapped events not yet sent.
    out: Vec<RunnerEvent>,
}

impl Process {
    fn record(&self, command: &SessionCommand) {
        self.commands
            .lock()
            .unwrap()
            .push((self.index, command.clone()));
    }

    async fn take_command(&mut self) {
        let command = self.rx.recv().await;
        self.handle(command).await;
    }

    /// A closed channel is claude's stdin closing.
    async fn handle(&mut self, command: Option<SessionCommand>) {
        match command {
            Some(command) => {
                self.record(&command);
                self.command(command);
            }
            None => self.exit = self.exit.or(Some(0)),
        }
        self.flush().await;
    }

    async fn flush(&mut self) {
        for event in std::mem::take(&mut self.out) {
            let _ = self.tx.send(event).await;
        }
    }

    fn stopped(&self) -> bool {
        self.cut || self.exit.is_some()
    }

    async fn run(mut self) {
        while self.exit.is_none() {
            match self.queue.pop_front() {
                Some(_) if self.refusal.is_some() => self.exit = Some(1),
                Some(uuid) => self.play(&uuid).await,
                None => self.take_command().await,
            }
        }
        let exit = ExitInfo {
            code: self.exit,
            signal: None,
            stderr_tail: self.refusal.take().unwrap_or_default(),
        };
        self.out.extend(self.mapper.exited(exit, &Now::system()));
        self.flush().await;
    }

    /// As the session task does: the command through the mapper, and its stdin lines to claude.
    fn command(&mut self, command: SessionCommand) {
        let inputs = match command {
            SessionCommand::Send { run_id, text, mode } => self.mapper.send(&run_id, &text, mode),
            SessionCommand::Withdraw { run_id } => match self.mapper.withdraw(&run_id) {
                Some(input) => vec![input],
                None => {
                    self.out.push(RunnerEvent::Withdrawn {
                        run_id,
                        cancelled: false,
                        by_stop: false,
                    });
                    vec![]
                }
            },
            SessionCommand::Interrupt => self.mapper.stop(),
            SessionCommand::Answer {
                request_id,
                decision,
                by,
            } => self
                .mapper
                .answer(&request_id, &decision, by, &Now::system())
                .into_iter()
                .collect(),
            SessionCommand::Shutdown { .. } => {
                self.mapper.stopping();
                // Mid-turn the kill ladder ends it with SIGTERM's 143; idle, claude exits once stdin closes.
                self.exit = Some(if self.mapper.has_open_run() { 143 } else { 0 });
                vec![]
            }
        };
        for input in inputs {
            self.claude(input);
        }
    }

    /// claude reading one stdin line.
    fn claude(&mut self, input: Input) {
        match input {
            Input::User { uuid, priority, .. } => {
                if priority.is_some() && self.playing {
                    self.cut = true;
                    self.queue.push_front(uuid);
                } else {
                    self.queue.push_back(uuid);
                }
            }
            Input::ControlRequest {
                request_id,
                request,
            } => match request["subtype"].as_str() {
                Some("interrupt") if self.honour_interrupt => {
                    self.respond(&request_id, json!({}));
                    self.cut |= self.playing;
                }
                Some("cancel_async_message") => {
                    let uuid = request["message_uuid"].as_str().unwrap_or_default();
                    let held = self.queue.iter().position(|q| q == uuid);
                    if let Some(at) = held {
                        self.queue.remove(at);
                        self.feed(json!({"type": "command_lifecycle", "command_uuid": uuid, "state": "cancelled"}));
                    }
                    self.respond(&request_id, json!({"cancelled": held.is_some()}));
                }
                _ => {}
            },
            Input::ControlResponse { .. } => self.asking = false,
        }
    }

    fn respond(&mut self, request_id: &str, response: Value) {
        self.feed(json!({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": request_id, "response": response},
        }));
    }

    /// One stdout line through the mapper; the replies it writes go back to claude.
    fn feed(&mut self, mut msg: Value) {
        if msg["type"] == "system" && msg["subtype"] == "init" {
            // As claude applies the spawn's deny list (the fixtures were recorded without one).
            if let Some(tools) = msg["tools"].as_array_mut() {
                tools.retain(|t| !self.denied.iter().any(|d| t.as_str() == Some(d)));
            }
        }
        let line: Line = serde_json::from_value(msg).expect("a stream-json line");
        let mapped = self.mapper.feed(line, &Now::system());
        self.asking |= mapped
            .events
            .iter()
            .any(|e| matches!(e, RunnerEvent::PermissionRequest { .. }));
        self.out.extend(mapped.events);
        for reply in mapped.replies {
            self.claude(reply);
        }
    }

    async fn play(&mut self, uuid: &str) {
        let n = self.next_turn.fetch_add(1, Ordering::Relaxed);
        let turn = self.turns[n % self.turns.len()].clone();
        self.playing = true;
        let mut clock = 0;
        for (ms, mut msg) in turn.lines {
            if self.timed && ms > clock {
                let wait = tokio::time::sleep(Duration::from_millis(ms - clock));
                tokio::pin!(wait);
                while !self.stopped() {
                    let command = tokio::select! {
                        () = &mut wait => break,
                        command = self.rx.recv() => command,
                    };
                    self.handle(command).await;
                }
                clock = ms;
            }
            while let Ok(command) = self.rx.try_recv() {
                self.record(&command);
                self.command(command);
            }
            if self.stopped() {
                break;
            }
            if let Some(recorded) = &turn.uuid {
                swap(&mut msg, recorded, uuid);
            }
            self.feed(msg);
            self.flush().await;
            while self.asking && !self.stopped() {
                self.take_command().await;
            }
        }
        if self.cut && self.exit.is_none() {
            self.feed(json!({
                "type": "result",
                "subtype": "error_during_execution",
                "is_error": true,
                "terminal_reason": "aborted_tools",
            }));
        }
        (self.playing, self.cut, self.asking) = (false, false, false);
        self.flush().await;
    }
}

/// Every string `from` in `value` becomes `to`.
fn swap(value: &mut Value, from: &str, to: &str) {
    match value {
        Value::String(s) if s == from => *s = to.to_owned(),
        Value::Array(items) => items.iter_mut().for_each(|v| swap(v, from, to)),
        Value::Object(fields) => fields.values_mut().for_each(|v| swap(v, from, to)),
        _ => {}
    }
}
