//! Supervises the local T3: probes it every 5 s, marks it down after three failures in a row, then runs the restart
//! command with a delay of 5 s doubling to 5 min between attempts, probing every 5 s in between, until it answers.
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use super::util::{AbortOnDrop, head_utf16, scrubbed_env, tail_utf16};

#[derive(Clone, Debug, PartialEq)]
pub struct T3Info {
    pub version: String,
    pub protocol: i64,
}

/// The node's view of its local T3.
#[derive(Clone, Debug, PartialEq)]
pub enum T3State {
    Up(T3Info),
    Down(String),
    Restarting(String),
}

impl T3State {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Up(_) => "up",
            Self::Down(_) => "down",
            Self::Restarting(_) => "restarting",
        }
    }

    pub fn is_up(&self) -> bool {
        matches!(self, Self::Up(_))
    }
}

/// Why T3 did not answer a probe: its URL and a short reason.
#[derive(Clone, Debug)]
pub struct T3Unreachable {
    pub url: String,
    pub why: String,
}

pub type Probe = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<T3Info, T3Unreachable>> + Send>> + Send + Sync,
>;
pub type Restart =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;

const PROBE_EVERY: Duration = Duration::from_secs(5);
const FAILURES_BEFORE_DOWN: u32 = 3;
const FIRST_RESTART_DELAY: Duration = Duration::from_secs(5);
const MAX_RESTART_DELAY: Duration = Duration::from_secs(300);

/// Runs `argv` (no shell) with a scrubbed environment and a 3 min cap; the error is the plain-language failure.
pub fn restart_command(argv: Vec<String>) -> Restart {
    Arc::new(move || {
        let argv = argv.clone();
        Box::pin(async move {
            let outcome = exec(&argv, Duration::from_secs(180)).await;
            match outcome {
                Exec { error: None, .. } => Ok(()),
                Exec {
                    exit_code,
                    stderr,
                    error: Some(message),
                    ..
                } => {
                    let stderr = stderr.trim();
                    let tail = if stderr.is_empty() {
                        head_utf16(&message, 200)
                    } else {
                        tail_utf16(stderr, 200)
                    };
                    let code = exit_code.map_or_else(|| "none".to_owned(), |c| c.to_string());
                    Err(format!("restart command failed (exit {code}): {tail}"))
                }
            }
        })
    })
}

/// What Node's `execFile` callback sees: stdout, stderr, the exit code when there is one, and an error message for
/// anything but a clean exit 0.
pub struct Exec {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

/// `execFile(argv[0], argv[1..], { env: scrubbedEnv(), timeout })`: no shell, killed with SIGTERM at the timeout.
pub async fn exec(argv: &[String], timeout: Duration) -> Exec {
    let (command, args) = argv
        .split_first()
        .map_or(("t3", &[][..]), |(c, a)| (c.as_str(), a));
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args)
        .env_clear()
        .envs(scrubbed_env())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let code = super::util::errno_name(&error).unwrap_or_else(|| error.to_string());
            return Exec {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                error: Some(format!("spawn {command} {code}")),
            };
        }
    };
    let output = tokio::time::timeout(timeout, child.wait_with_output()).await;
    // At the timeout the dropped child is killed (kill_on_drop).
    let Ok(Ok(output)) = output else {
        return Exec {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            error: Some(format!("Command failed: {}", argv.join(" "))),
        };
    };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let exit_code = output.status.code();
    let error =
        (!output.status.success()).then(|| format!("Command failed: {}\n{stderr}", argv.join(" ")));
    Exec {
        stdout,
        stderr,
        exit_code,
        error,
    }
}

#[derive(Clone)]
pub struct T3Supervisor {
    state: watch::Receiver<T3State>,
}

impl T3Supervisor {
    /// Probes once, then supervises on a task that stops when the returned guard drops. A T3 that is down at start
    /// is reported down after the first failed probe and restarted after the third.
    pub async fn start(probe: Probe, restart: Option<Restart>) -> (Self, AbortOnDrop) {
        let initial = probe().await;
        let first = match &initial {
            Ok(info) => T3State::Up(info.clone()),
            Err(e) => T3State::Down(format!("T3 at {} is not reachable ({})", e.url, e.why)),
        };
        let (tx, rx) = watch::channel(first);
        let task = AbortOnDrop(tokio::spawn(supervise(
            tx,
            probe,
            restart,
            initial.err().map(|e| e.why),
        )));
        (Self { state: rx }, task)
    }

    pub fn current(&self) -> T3State {
        self.state.borrow().clone()
    }

    /// The current state first, then each change.
    pub fn subscribe(&self) -> watch::Receiver<T3State> {
        let mut rx = self.state.clone();
        rx.mark_changed();
        rx
    }

    async fn when(&self, up: bool) {
        let mut rx = self.state.clone();
        let _ = rx.wait_for(|state| state.is_up() == up).await;
    }

    /// Returns once T3 is up (at once if it is).
    pub async fn await_up(&self) {
        self.when(true).await;
    }

    /// Returns once T3 is down or restarting (at once if it is).
    pub async fn await_down(&self) {
        self.when(false).await;
    }
}

fn set(tx: &watch::Sender<T3State>, next: T3State) {
    let changed = tx.send_if_modified(|current| {
        if *current == next {
            return false;
        }
        *current = next.clone();
        true
    });
    if changed {
        match &next {
            T3State::Up(info) => {
                tracing::info!(version = %info.version, protocol = info.protocol, "t3 is up")
            }
            other @ (T3State::Down(reason) | T3State::Restarting(reason)) => {
                tracing::info!(%reason, "t3 is {}", other.name())
            }
        }
    }
}

async fn supervise(
    tx: watch::Sender<T3State>,
    probe: Probe,
    restart: Option<Restart>,
    first_failure: Option<String>,
) {
    let mut failures = u32::from(first_failure.is_some());
    let mut why = first_failure.unwrap_or_default();
    loop {
        // Probes every PROBE_EVERY until FAILURES_BEFORE_DOWN failures in a row.
        while failures < FAILURES_BEFORE_DOWN {
            tokio::time::sleep(PROBE_EVERY).await;
            match probe().await {
                Ok(info) => {
                    failures = 0;
                    set(&tx, T3State::Up(info));
                }
                Err(error) => {
                    failures += 1;
                    why = error.why;
                }
            }
        }
        recover(
            &tx,
            &probe,
            restart.as_ref(),
            format!("T3 failed {FAILURES_BEFORE_DOWN} health checks in a row ({why})"),
        )
        .await;
        failures = 0;
    }
}

/// Probes now, then every PROBE_EVERY within `window`; true once T3 answers.
async fn recovered(tx: &watch::Sender<T3State>, probe: &Probe, window: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        if let Ok(info) = probe().await {
            set(tx, T3State::Up(info));
            return true;
        }
        if tokio::time::Instant::now() + PROBE_EVERY > deadline {
            return false;
        }
        tokio::time::sleep(PROBE_EVERY).await;
    }
}

async fn recover(
    tx: &watch::Sender<T3State>,
    probe: &Probe,
    restart: Option<&Restart>,
    reason: String,
) {
    set(tx, T3State::Down(reason.clone()));
    let Some(restart) = restart else {
        tracing::warn!(
            "t3 is down and no --t3-restart-cmd is configured; waiting for it to come back"
        );
        while !recovered(tx, probe, MAX_RESTART_DELAY).await {}
        return;
    };
    let mut delay = FIRST_RESTART_DELAY;
    let mut why = reason;
    for attempt in 1.. {
        set(tx, T3State::Restarting(why.clone()));
        let failed = restart().await.err();
        if let Some(error) = &failed {
            tracing::warn!(attempt, %error, "t3 restart command failed");
        }
        if recovered(tx, probe, delay).await {
            return;
        }
        why = match failed {
            None => format!("T3 did not come back after restart {attempt}"),
            Some(error) => format!("restart {attempt}: {error}"),
        };
        delay = (delay * 2).min(MAX_RESTART_DELAY);
    }
}
