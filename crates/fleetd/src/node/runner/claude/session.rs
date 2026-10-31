//! One live claude process: a task that owns the child, pumps its stdout and stderr through the [`StreamMapper`],
//! writes its stdin, and ends it with the kill ladder.
//!
//! Kill ladder ([`SessionCommand::Shutdown`]`{grace}`):
//! 1. If a run is active, write an interrupt `control_request` (claude stops the tool and ends the run with
//!    `aborted_*`). Then close stdin: claude exits once it has no run left.
//! 2. After `grace`: sweep the session's processes, then SIGTERM claude's process group. claude kills its own tool
//!    children on SIGTERM and exits 143 (fixture `sigterm-mid-tool`).
//! 3. After [`TERM_GRACE`] more: sweep again, SIGKILL every swept process group and pid, then claude's group.
//! 4. Whenever claude exits, for any reason: sweep once more and SIGKILL whatever is left, read the rest of stdout,
//!    reap adopted orphans, and only then emit [`RunnerEvent::Exited`].
//! 5. After [`RESWEEP_AFTER`]: sweep by the marker again and SIGKILL what it finds, once more if it found anything.
//!    A tool mid-`exec` at the first sweep had an empty `/proc/<pid>/environ`, so its marker could not be read.
//!    Nothing a session started outlives it.
//!
//! The session service escalates a plain [`SessionCommand::Interrupt`] that did not end the run in time by sending
//! `Shutdown { grace: 0 }`, which makes the spec's interrupt → SIGTERM → SIGKILL ladder.
//!
//! Latency: stdout is read by its own task and handed over line by line; nothing waits on a timer. When several
//! text deltas of one message are already read and waiting, they go out as one [`RunnerEvent::Delta`]; a delta is
//! never held back waiting for more. The 100 ms per-session window of §3.5 is the session service's.
use std::collections::VecDeque;
use std::os::unix::process::ExitStatusExt;
use std::time::Duration;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::mpsc;

use super::mapper::{Now, StreamMapper};
use super::protocol::{Input, Line};
use crate::node::runner::process::{self, Proc};
use crate::node::runner::{ExitInfo, RunnerEvent, SessionCommand, SessionHandle};

/// From SIGTERM to SIGKILL.
pub const TERM_GRACE: Duration = Duration::from_secs(5);
/// After claude exited, how long the rest of stdout may take (a descendant that held the pipe is killed by then).
const DRAIN: Duration = Duration::from_secs(2);
/// How long to wait for killed orphans to be reaped.
const REAP: Duration = Duration::from_secs(5);
/// From the sweep at the exit to the next one, and between the later ones ([`resweep`]).
const RESWEEP_AFTER: Duration = Duration::from_secs(1);
/// Sweeps after the one at the exit, at most: each after the first only when the one before found something.
const RESWEEPS: usize = 2;
/// Events waiting for the session service. Past this, stdout is no longer read, so claude blocks on its own writes
/// instead of the node buffering without bound. Kill timers and commands keep running.
const QUEUE_MAX: usize = 1024;

enum Out {
    Stdout(String),
    Stderr(String),
    Eof,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Running,
    /// stdin closed; waiting `grace` for claude to exit by itself.
    Closing,
    /// SIGTERM sent.
    Terming,
    /// SIGKILL sent.
    Killed,
}

pub(super) fn start(mut child: Child, marker: String, mapper: StreamMapper) -> SessionHandle {
    let pid = child.id().unwrap_or_default();
    process::track(pid as i32);
    let (out_tx, out_rx) = mpsc::channel(64);
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(read_lines(stdout, out_tx.clone(), true));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(read_lines(stderr, out_tx, false));
    }
    let stdin = child.stdin.take().map(|stdin| {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(write_lines(stdin, rx));
        tx
    });
    let (cmd_tx, cmd_rx) = mpsc::channel(64);
    let (ev_tx, ev_rx) = mpsc::channel(256);
    let session = Session {
        pid: pid as i32,
        marker,
        mapper,
        stdin,
        queue: VecDeque::new(),
        pending_delta: None,
        swept: Vec::new(),
        phase: Phase::Running,
        deadline: None,
    };
    tokio::spawn(session.run(child, out_rx, cmd_rx, ev_tx));
    SessionHandle {
        pid,
        commands: cmd_tx,
        events: ev_rx,
        link: None,
    }
}

struct Session {
    pid: i32,
    /// This spawn's [`process::marker`], which every process it starts inherits.
    marker: String,
    mapper: StreamMapper,
    /// `None` once stdin is closed.
    stdin: Option<mpsc::UnboundedSender<String>>,
    queue: VecDeque<RunnerEvent>,
    pending_delta: Option<RunnerEvent>,
    /// Everything any sweep of this session found, killed again at the exit.
    swept: Vec<Proc>,
    phase: Phase,
    deadline: Option<tokio::time::Instant>,
}

impl Session {
    async fn run(
        mut self,
        mut child: Child,
        mut out_rx: mpsc::Receiver<Out>,
        mut cmd_rx: mpsc::Receiver<SessionCommand>,
        ev_tx: mpsc::Sender<RunnerEvent>,
    ) {
        let mut eofs = 0;
        let mut commands_open = true;
        let mut events_open = true;
        let status = loop {
            // Deltas already read but not yet merged wait one turn; nothing else is waiting, so they go now.
            if self.pending_delta.is_some() && out_rx.is_empty() {
                self.flush_delta();
            }
            if !events_open {
                // Nobody reads the events any more: drop them, so stdout keeps being read and claude never blocks
                // on it while the session ends.
                self.queue.clear();
                self.pending_delta = None;
            }
            let deadline = self.deadline;
            tokio::select! {
                biased;
                status = child.wait() => {
                    // tokio has collected the status; from here the pid is no longer claude's.
                    process::untrack(self.pid);
                    break status;
                }
                _ = tokio::time::sleep_until(deadline.unwrap_or_else(tokio::time::Instant::now)), if deadline.is_some() => {
                    self.escalate().await;
                }
                cmd = cmd_rx.recv(), if commands_open => match cmd {
                    Some(cmd) => self.command(cmd),
                    // The handle was dropped: end the process like kill_on_drop would, but with the sweep.
                    None => {
                        commands_open = false;
                        self.shutdown(Duration::ZERO);
                    }
                },
                permit = ev_tx.reserve(), if events_open && !self.queue.is_empty() => match permit {
                    Ok(permit) => permit.send(self.queue.pop_front().expect("checked non-empty")),
                    Err(_) => {
                        events_open = false;
                        self.shutdown(Duration::ZERO);
                    }
                },
                // The event receiver was dropped: nobody can see this session, so end it (with the sweep).
                () = ev_tx.closed(), if events_open => {
                    events_open = false;
                    self.shutdown(Duration::ZERO);
                }
                out = out_rx.recv(), if eofs < 2 && self.queue.len() < QUEUE_MAX => match out {
                    Some(Out::Eof) | None => eofs += 1,
                    Some(out) => self.output(out),
                },
            }
        };

        // Exited. Whatever the session started dies with it, which also releases any pipe a descendant held.
        let (pid, marker) = (self.pid, self.marker.clone());
        let found = tokio::task::spawn_blocking(move || process::sweep(pid, &marker))
            .await
            .unwrap_or_default();
        self.swept.extend(found);
        process::dedupe(&mut self.swept);
        process::signal(&self.swept, Signal::SIGKILL);
        let drain = tokio::time::Instant::now() + DRAIN;
        while eofs < 2 {
            match tokio::time::timeout_at(drain, out_rx.recv()).await {
                Ok(Some(Out::Eof) | None) => eofs += 1,
                Ok(Some(out)) => self.output(out),
                Err(_) => break,
            }
        }
        process::reap(&self.swept, REAP).await;

        let exit = match status {
            Ok(status) => ExitInfo {
                code: status.code(),
                signal: status.signal(),
                stderr_tail: self.mapper.stderr_tail(),
            },
            Err(error) => ExitInfo {
                code: None,
                signal: None,
                stderr_tail: format!(
                    "{}\nfleetd: waiting for claude failed: {error}",
                    self.mapper.stderr_tail()
                ),
            },
        };
        let events = self.mapper.exited(exit, &Now::system());
        self.push(events);
        self.flush_delta();
        // In its own task, so the exit is not held up by it. A later spawn of the session has another marker.
        tokio::spawn(resweep(self.marker.clone()));
        if events_open {
            for event in self.queue.drain(..) {
                if ev_tx.send(event).await.is_err() {
                    break;
                }
            }
        }
    }

    fn output(&mut self, out: Out) {
        match out {
            Out::Stdout(line) => match serde_json::from_str::<Line>(&line) {
                Ok(decoded) => {
                    let mapped = self.mapper.feed(decoded, &Now::system());
                    for reply in mapped.replies {
                        self.write(reply);
                    }
                    self.push(mapped.events);
                }
                // Not stream-json (a warning printed to stdout): keep it with stderr, where a failure shows it.
                Err(_) => {
                    if !line.trim().is_empty() {
                        self.mapper.stderr(&line);
                    }
                }
            },
            Out::Stderr(line) => {
                self.mapper.stderr(&line);
            }
            Out::Eof => {}
        }
    }

    fn command(&mut self, cmd: SessionCommand) {
        match cmd {
            SessionCommand::Send { run_id, text, mode } => {
                for input in self.mapper.send(&run_id, &text, mode) {
                    if !self.write(input) {
                        // stdin is closed: the run can never start, and ends with the exit like any other open run.
                        tracing::warn!("send {run_id} after stdin closed");
                    }
                }
            }
            SessionCommand::Withdraw { run_id } => match self.mapper.withdraw(&run_id) {
                Some(input) if self.write(input.clone()) => {}
                _ => self.push(vec![RunnerEvent::Withdrawn {
                    run_id,
                    cancelled: false,
                    by_stop: false,
                }]),
            },
            SessionCommand::Interrupt => {
                for input in self.mapper.stop() {
                    self.write(input);
                }
            }
            SessionCommand::Answer {
                request_id,
                decision,
                by,
            } => match self
                .mapper
                .answer(&request_id, &decision, by, &Now::system())
            {
                Some(input) => {
                    self.write(input);
                }
                None => tracing::warn!("answer to {request_id}, which claude no longer waits for"),
            },
            SessionCommand::Shutdown { grace } => self.shutdown(grace),
        }
    }

    fn shutdown(&mut self, grace: Duration) {
        if self.phase != Phase::Running {
            return;
        }
        if self.mapper.has_open_run() {
            let interrupt = self.mapper.interrupt();
            self.write(interrupt);
        }
        self.mapper.stopping();
        self.stdin = None;
        self.phase = Phase::Closing;
        self.deadline = Some(tokio::time::Instant::now() + grace);
    }

    async fn escalate(&mut self) {
        let (pid, marker) = (self.pid, self.marker.clone());
        // The sweep comes before the signal: once claude is gone its children can no longer be found by ppid.
        let found = tokio::task::spawn_blocking(move || process::sweep(pid, &marker))
            .await
            .unwrap_or_default();
        self.swept.extend(found);
        process::dedupe(&mut self.swept);
        // claude's own group (it was spawned with process_group(0)). Its pid can't be reused before the session
        // reaps it; 0 would mean the node's own group.
        let group = |sig| {
            if self.pid > 1 {
                let _ = killpg(Pid::from_raw(self.pid), sig);
            }
        };
        match self.phase {
            Phase::Closing => {
                group(Signal::SIGTERM);
                self.phase = Phase::Terming;
                self.deadline = Some(tokio::time::Instant::now() + TERM_GRACE);
            }
            Phase::Terming => {
                process::signal(&self.swept, Signal::SIGKILL);
                group(Signal::SIGKILL);
                self.phase = Phase::Killed;
                self.deadline = None;
            }
            Phase::Running | Phase::Killed => self.deadline = None,
        }
    }

    /// False when stdin is already closed.
    fn write(&mut self, input: Input) -> bool {
        let Some(stdin) = &self.stdin else {
            return false;
        };
        let line = serde_json::to_string(&input).expect("stdin lines serialize");
        stdin.send(line).is_ok()
    }

    fn push(&mut self, events: Vec<RunnerEvent>) {
        for event in events {
            match (event, &mut self.pending_delta) {
                (
                    RunnerEvent::Delta { message_id, append },
                    Some(RunnerEvent::Delta {
                        message_id: held,
                        append: so_far,
                    }),
                ) if *held == message_id => so_far.push_str(&append),
                (delta @ RunnerEvent::Delta { .. }, _) => {
                    self.flush_delta();
                    self.pending_delta = Some(delta);
                }
                (event, _) => {
                    self.flush_delta();
                    self.queue.push_back(event);
                }
            }
        }
    }

    fn flush_delta(&mut self) {
        if let Some(delta) = self.pending_delta.take() {
            self.queue.push_back(delta);
        }
    }
}

/// Sweeps the exited spawn marked `marker` again, after [`RESWEEP_AFTER`], for what the sweep at the exit missed: a
/// process that was mid-`exec` then had an empty environment, so no readable marker. By the marker alone: claude's
/// pid is reaped by now and may already be another process's.
async fn resweep(marker: String) {
    for _ in 0..RESWEEPS {
        tokio::time::sleep(RESWEEP_AFTER).await;
        let by = marker.clone();
        let found = tokio::task::spawn_blocking(move || process::sweep_marked(&by))
            .await
            .unwrap_or_default();
        if found.is_empty() {
            return;
        }
        tracing::warn!(
            marker,
            leftover = found.len(),
            "killing processes the sweep at claude's exit missed"
        );
        process::signal(&found, Signal::SIGKILL);
        process::reap(&found, REAP).await;
    }
}

async fn read_lines(from: impl AsyncRead + Unpin, to: mpsc::Sender<Out>, stdout: bool) {
    // stream-json lines carry whole tool outputs; a large buffer keeps them to few reads.
    let mut reader = BufReader::with_capacity(256 * 1024, from);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                let line = String::from_utf8_lossy(&buf).into_owned();
                let out = if stdout {
                    Out::Stdout(line)
                } else {
                    Out::Stderr(line)
                };
                if to.send(out).await.is_err() {
                    return;
                }
            }
        }
    }
    let _ = to.send(Out::Eof).await;
}

/// Writes in its own task so a full stdin pipe can never stall reading stdout. Ends (closing stdin) when the
/// session drops its sender.
async fn write_lines(mut stdin: ChildStdin, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(mut line) = lines.recv().await {
        line.push('\n');
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
