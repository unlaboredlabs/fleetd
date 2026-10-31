//! A session's host: the small process that owns a session's claude, so the claude outlives the node. A node restart
//! (an update, a crash) used to kill every agent mid-step; now each lead's and task's claude runs under a host of its
//! own (`fleetd session-host`, this binary), in a systemd scope of its own that isn't part of the node's unit, and a
//! restarted node re-adopts it and streams on from where the last one stopped.
//!
//! The host runs the runner's session task itself (the stream mapper, the kill ladder, the transcript), so nothing of a
//! session's state lives only in the node. It keeps a registration (`host.json`: its pid, claude's, the spawn's marker)
//! and a socket in the session's host dir (`<node home>/hosts/<session id>`), which is the node's registry of live
//! sessions. Over the socket, one JSON object per line:
//! - host → node: every [`RunnerEvent`] with its sequence number, `{"seq":n,"event":…}`. A host keeps each event until
//!   a node acknowledges it and sends every one it keeps to a node that connects, so a node restart loses none.
//! - node → host: `{"ack":n}` once the session service applied events up to `n` (so a restarted node gets none twice),
//!   `{"command":…}` for each [`SessionCommand`], and `"stop"`: end the session and exit.
//!
//! A host whose claude exited waits for a node to take the exit, at most [`LINGER`], and then exits. A starting node
//! that finds a host gone settles the session as before hosts: its runs close as interrupted and the hub resumes them.
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::UnixStream;
use tokio::net::unix::OwnedReadHalf;
use tokio::sync::{mpsc, watch};

use super::process;
use super::scope::{self, Scope};
use super::{RunnerEvent, SessionCommand, SessionHandle};

/// Bumped whenever the lines between a host and a node change incompatibly: a node never adopts a host that speaks
/// another version (one an update left running), it stops it and resumes the session as before hosts.
pub const PROTOCOL: u32 = 1;
/// The node's subcommand that runs a host. Not for people, so not in help.
pub const COMMAND: &str = "session-host";
const REGISTRATION: &str = "host.json";
const SOCKET: &str = "sock";
const LOG: &str = "host.log";
/// After claude exited, how long a host waits for a node to take its last events.
pub const LINGER: Duration = Duration::from_secs(10 * 60);
/// How long a launch waits for the host to register.
const START_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the node acknowledges what it applied.
const ACK_EVERY: Duration = Duration::from_millis(200);
/// A node letting go: how long the session service gets to apply the events already handed to it.
const DRAIN: Duration = Duration::from_secs(5);
/// A stop: how long the host gets to end its session (interrupt, SIGTERM, then SIGKILL after 5 s) before it is killed.
const STOP_WAIT: Duration = Duration::from_secs(8);

/// What a host says about itself in its dir, once its claude started (or failed to).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub protocol: u32,
    pub host_pid: u32,
    /// The host's start time (`/proc/<pid>/stat`), so a reused pid is never taken for it. None off Linux.
    pub host_start: Option<u64>,
    /// claude's pid; 0 when it didn't start.
    pub pid: u32,
    pub start: Option<u64>,
    /// The spawn's [`process::marker`], which everything the session starts carries.
    pub marker: String,
    /// Why claude didn't start.
    pub refused: Option<Refused>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Refused {
    pub message: String,
    /// The program wasn't there.
    pub missing: bool,
}

impl Registration {
    pub fn read(dir: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(dir.join(REGISTRATION)).ok()?).ok()
    }

    fn write(&self, dir: &Path) -> std::io::Result<()> {
        let tmp = dir.join(format!(".{REGISTRATION}.tmp"));
        std::fs::write(
            &tmp,
            serde_json::to_vec(self).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(tmp, dir.join(REGISTRATION))
    }

    /// The host still runs: its pid has the start time it registered.
    pub fn host_alive(&self) -> bool {
        alive(self.host_pid, self.host_start)
    }

    /// The host's processes now: itself, claude and everything they started.
    pub fn tree(&self) -> Vec<i32> {
        if !self.host_alive() {
            return Vec::new();
        }
        let table = process::table();
        let mut pids = vec![self.host_pid as i32];
        pids.extend(
            process::descendants(&table, self.host_pid as i32)
                .iter()
                .map(|p| p.pid),
        );
        pids
    }
}

/// A process's start time, `/proc/<pid>/stat` field 22. None when it's gone, a zombie, or off Linux.
fn start_of(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    process::parse_stat(pid as i32, &stat)
        .filter(|p| !p.zombie)
        .and_then(|p| p.start)
}

fn alive(pid: u32, start: Option<u64>) -> bool {
    if pid <= 1 || pid > i32::MAX as u32 {
        return false;
    }
    match start {
        Some(start) => start_of(pid) == Some(start),
        None if cfg!(target_os = "linux") => false,
        None => kill(Pid::from_raw(pid as i32), None).is_ok(),
    }
}

/// A line from the node.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ToHost {
    Ack(u64),
    Command(SessionCommand),
    Stop,
}

/// A line from the host.
#[derive(Debug, Serialize, Deserialize)]
struct FromHost {
    seq: u64,
    event: RunnerEvent,
}

/// One connection to a node: lines out through a task of its own, so a slow node never holds up the session.
struct Conn {
    tx: mpsc::UnboundedSender<String>,
    lines: Lines<BufReader<OwnedReadHalf>>,
}

impl Conn {
    fn new(stream: UnixStream) -> Self {
        let (read, mut write) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(mut line) = rx.recv().await {
                line.push('\n');
                if write.write_all(line.as_bytes()).await.is_err() {
                    return;
                }
            }
        });
        Self {
            tx,
            lines: BufReader::new(read).lines(),
        }
    }
}

/// The next line from the node, if one is connected; never resolves otherwise. None: it went away.
async fn next_line(conn: &mut Option<Conn>) -> Option<String> {
    match conn {
        Some(conn) => conn.lines.next_line().await.ok().flatten(),
        None => std::future::pending().await,
    }
}

/// Serves `handle` to whichever node connects on `listener` until the session has exited and a node took the exit,
/// or [`LINGER`] after the exit with none. `stop` (the host's SIGTERM) ends the session.
pub async fn serve(
    mut handle: SessionHandle,
    listener: tokio::net::UnixListener,
    stop: impl std::future::Future<Output = ()>,
    linger: Duration,
) {
    let commands = handle.commands.clone();
    let mut kept: VecDeque<(u64, String)> = VecDeque::new();
    let mut seq = 0;
    let mut conn: Option<Conn> = None;
    let mut exited = false;
    let mut stopping = false;
    let mut until: Option<tokio::time::Instant> = None;
    tokio::pin!(stop);
    loop {
        // Done once a node took everything, the exit included, or once a stop ended the session.
        if exited && (kept.is_empty() || stopping) {
            break;
        }
        tokio::select! {
            event = handle.events.recv(), if !exited => {
                let Some(event) = event else {
                    exited = true;
                    until = Some(tokio::time::Instant::now());
                    continue;
                };
                if matches!(event, RunnerEvent::Exited(_)) {
                    exited = true;
                    until = Some(tokio::time::Instant::now() + linger);
                }
                seq += 1;
                let line = serde_json::to_string(&FromHost { seq, event }).expect("events serialize");
                if let Some(conn) = &conn {
                    let _ = conn.tx.send(line.clone());
                }
                kept.push_back((seq, line));
            }
            accepted = listener.accept() => if let Ok((stream, _)) = accepted {
                // One node at a time: a new one is the node after a restart.
                let new = Conn::new(stream);
                for (_, line) in &kept {
                    let _ = new.tx.send(line.clone());
                }
                conn = Some(new);
            },
            line = next_line(&mut conn) => match line.map(|l| serde_json::from_str::<ToHost>(&l)) {
                Some(Ok(ToHost::Ack(upto))) => {
                    while kept.front().is_some_and(|(n, _)| *n <= upto) {
                        kept.pop_front();
                    }
                }
                Some(Ok(ToHost::Command(command))) => {
                    let _ = commands.send(command).await;
                }
                Some(Ok(ToHost::Stop)) => {
                    stopping = true;
                    let _ = commands.send(SessionCommand::Shutdown { grace: Duration::ZERO }).await;
                }
                Some(Err(e)) => tracing::warn!("a line from the node that isn't one: {e}"),
                None => conn = None,
            },
            () = &mut stop, if !stopping => {
                stopping = true;
                let _ = commands.send(SessionCommand::Shutdown { grace: Duration::ZERO }).await;
            }
            () = tokio::time::sleep_until(until.unwrap_or_else(tokio::time::Instant::now)), if until.is_some() => {
                tracing::warn!(left = kept.len(), "no node took the session's last events");
                break;
            }
        }
    }
}

/// Registers `handle` in `dir` as a host in this process and serves it in a task: the host's half of [`main`], and a
/// whole host for tests.
pub fn serve_here(
    dir: &Path,
    handle: SessionHandle,
    marker: String,
    stop: impl std::future::Future<Output = ()> + Send + 'static,
    linger: Duration,
) -> std::io::Result<tokio::task::JoinHandle<()>> {
    let listener = bind(dir)?;
    let own = std::process::id();
    Registration {
        protocol: PROTOCOL,
        host_pid: own,
        host_start: start_of(own),
        pid: handle.pid,
        start: start_of(handle.pid),
        marker,
        refused: None,
    }
    .write(dir)?;
    Ok(tokio::spawn(serve(handle, listener, stop, linger)))
}

fn bind(dir: &Path) -> std::io::Result<tokio::net::UnixListener> {
    let _ = std::fs::remove_file(dir.join(SOCKET));
    at_socket(dir, |path| tokio::net::UnixListener::bind(path))
}

fn dial(dir: &Path) -> std::io::Result<UnixStream> {
    let stream = at_socket(dir, |path| std::os::unix::net::UnixStream::connect(path))?;
    stream.set_nonblocking(true)?;
    UnixStream::from_std(stream)
}

/// Runs `f` on a path to the socket in `dir` that fits a socket's address (at most 104 bytes on macOS, 108 on Linux),
/// however deep the node's home: on Linux, through an open fd of the dir when its own path is too long.
fn at_socket<T>(dir: &Path, f: impl FnOnce(&Path) -> std::io::Result<T>) -> std::io::Result<T> {
    let path = dir.join(SOCKET);
    if path.as_os_str().len() < 100 || !cfg!(target_os = "linux") {
        return f(&path);
    }
    let held = std::fs::File::open(dir)?;
    let short = PathBuf::from(format!(
        "/proc/self/fd/{}/{SOCKET}",
        std::os::fd::AsRawFd::as_raw_fd(&held)
    ));
    f(&short)
}

/// `fleetd session-host <dir> <session id> [--transcript <file>] -- <program> <args…>`: starts the session's claude
/// with this process's environment and working directory, registers in `<dir>`, and serves it until it's done.
pub fn main(argv: &[String]) -> ExitCode {
    let Some(split) = argv.iter().position(|a| a == "--") else {
        eprintln!(
            "usage: fleetd {COMMAND} <dir> <session id> [--transcript <file>] -- <program> <args…>"
        );
        return ExitCode::from(2);
    };
    let (own, command) = (&argv[..split], &argv[split + 1..]);
    let (Some(dir), Some(session), Some(program)) = (own.first(), own.get(1), command.first())
    else {
        eprintln!("fleetd {COMMAND}: a dir, a session id and a program are needed");
        return ExitCode::from(2);
    };
    let transcript = own
        .iter()
        .position(|a| a == "--transcript")
        .and_then(|i| own.get(i + 1))
        .map(PathBuf::from);
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("fleetd {COMMAND}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let dir = PathBuf::from(dir);
    // The node sets the spawn's marker in the host's environment.
    let marker = std::env::var(process::SESSION_MARKER)
        .ok()
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| process::marker(session));
    runtime.block_on(async move {
        let refuse = |error: std::io::Error| {
            let own = std::process::id();
            let _ = Registration {
                protocol: PROTOCOL,
                host_pid: own,
                host_start: start_of(own),
                pid: 0,
                start: None,
                marker: marker.clone(),
                refused: Some(Refused {
                    message: error.to_string(),
                    missing: error.kind() == std::io::ErrorKind::NotFound,
                }),
            }
            .write(&dir);
            ExitCode::FAILURE
        };
        let Ok(mut term) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            return refuse(std::io::Error::other("can't watch for SIGTERM"));
        };
        let handle = match super::claude::hosted(
            Path::new(program),
            command[1..].to_vec(),
            session,
            marker.clone(),
            transcript,
        ) {
            Ok(handle) => handle,
            Err(e) => return refuse(e),
        };
        let stop = async move {
            term.recv().await;
        };
        match serve_here(&dir, handle, marker.clone(), stop, LINGER) {
            Ok(serving) => {
                let _ = serving.await;
                ExitCode::SUCCESS
            }
            Err(e) => refuse(e),
        }
    })
}

/// What [`launch`] needs: claude's command and everything it runs with.
pub struct Launch<'a> {
    /// This binary, which runs the host.
    pub exe: &'a Path,
    pub dir: &'a Path,
    pub session_id: &'a str,
    pub transcript: Option<&'a Path>,
    pub program: &'a Path,
    pub args: Vec<String>,
    pub cwd: &'a Path,
    /// claude's whole environment, which the host passes on.
    pub env: &'a [(String, String)],
    pub scope: Option<&'a Scope>,
}

#[derive(Debug)]
pub enum LaunchError {
    /// The host started, and claude didn't.
    Refused(Refused),
    /// No host came up: the session can still start without one.
    NoHost(String),
}

/// Starts a session's host, detached from the node (a session and, where systemd answers, a scope of its own that the
/// node's unit doesn't stop), and connects to it once it registered. Blocks until then, a few milliseconds.
pub fn launch(launch: Launch<'_>) -> Result<SessionHandle, LaunchError> {
    // Off Linux, a socket's path holds at most 104 bytes.
    if !cfg!(target_os = "linux") && launch.dir.join(SOCKET).as_os_str().len() >= 104 {
        return Err(LaunchError::NoHost("its socket's path is too long".into()));
    }
    prepare(launch.dir).map_err(|e| LaunchError::NoHost(format!("its dir: {e}")))?;
    let log = std::fs::File::create(launch.dir.join(LOG))
        .map_err(|e| LaunchError::NoHost(format!("its log: {e}")))?;
    let mut args = vec![
        COMMAND.to_owned(),
        launch.dir.display().to_string(),
        launch.session_id.to_owned(),
    ];
    if let Some(transcript) = launch.transcript {
        args.extend(["--transcript".into(), transcript.display().to_string()]);
    }
    args.push("--".into());
    args.push(launch.program.display().to_string());
    args.extend(launch.args);
    // Not `PartOf=` the node's unit: stopping or restarting the node leaves the session running.
    let scope = launch.scope.map(|s| Scope {
        node_unit: None,
        ..s.clone()
    });
    let build = |program: PathBuf, args: Vec<String>, scope: Option<&Scope>| {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args)
            .current_dir(launch.cwd)
            .env_clear()
            .envs(launch.env.iter().map(|(k, v)| (k, v)))
            .envs(scope.iter().flat_map(|s| s.env.iter().map(|(k, v)| (k, v))))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(
                log.try_clone()
                    .map_or_else(|_| std::process::Stdio::null(), Into::into),
            )
            .kill_on_drop(false);
        // SAFETY: setsid is a system call only. A session of its own: no signal for the node's group or terminal
        // reaches it.
        unsafe {
            cmd.pre_exec(|| {
                nix::unistd::setsid().map_err(std::io::Error::from)?;
                Ok(())
            });
        }
        cmd
    };
    let (mut child, scope_failed) =
        scope::spawn(scope.as_ref(), launch.exe, args, launch.session_id, build)
            .map_err(|e| LaunchError::NoHost(format!("it didn't start: {e}")))?;
    if let Some(why) = scope_failed {
        scope::failed(&why);
    }
    // The node reaps its host when it exits while the node runs; the subreaper leaves it to this wait.
    let host_pid = child.id().unwrap_or_default() as i32;
    process::track(host_pid);
    let deadline = std::time::Instant::now() + START_TIMEOUT;
    let registered = loop {
        if let Some(registration) = Registration::read(launch.dir) {
            break Ok(registration);
        }
        if let Ok(Some(status)) = child.try_wait() {
            break Err(format!("it exited at once ({status})"));
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.start_kill();
            break Err(format!(
                "it hadn't started claude after {} s",
                START_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    tokio::spawn(async move {
        let _ = child.wait().await;
        process::untrack(host_pid);
    });
    let registration = registered.map_err(LaunchError::NoHost)?;
    if let Some(refused) = registration.refused {
        return Err(LaunchError::Refused(refused));
    }
    connect(launch.dir)
        .map(|(handle, _)| handle)
        .map_err(|e| LaunchError::NoHost(format!("it doesn't answer: {e}")))
}

/// Makes `dir` empty and private, stopping a host a previous spawn of the session left there.
fn prepare(dir: &Path) -> std::io::Result<()> {
    if let Some(left) = Registration::read(dir)
        && left.host_alive()
    {
        kill_tree(&left);
    }
    match std::fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))
}

/// The node's link to a session's host, as the session service holds it.
#[derive(Clone)]
pub struct Link {
    /// How many events the session service applied, counted by it after each one: what the node acknowledges.
    pub applied: Arc<AtomicU64>,
    /// The node let go of the host (its shutdown): the events end without an exit, and the session goes on.
    pub detached: Arc<AtomicBool>,
    detach: Arc<watch::Sender<bool>>,
    done: watch::Receiver<bool>,
}

impl Link {
    /// Lets go of the host without ending its session, once the service applied what it was handed and the host knows.
    pub async fn detach(&self) {
        let _ = self.detach.send(true);
        let mut done = self.done.clone();
        let _ = tokio::time::timeout(DRAIN + Duration::from_secs(1), done.wait_for(|d| *d)).await;
    }
}

/// Connects to the host in `dir`: its session as a [`SessionHandle`], whose events start with every one the host kept
/// (those no node acknowledged), and its registration. Refused for a host of another [`PROTOCOL`].
pub fn connect(dir: &Path) -> std::io::Result<(SessionHandle, Registration)> {
    let registration =
        Registration::read(dir).ok_or_else(|| std::io::Error::other("no registration"))?;
    if registration.protocol != PROTOCOL {
        return Err(std::io::Error::other(format!(
            "it speaks protocol {}, this node {PROTOCOL}",
            registration.protocol
        )));
    }
    if let Some(refused) = &registration.refused {
        return Err(std::io::Error::other(refused.message.clone()));
    }
    let stream = dial(dir)?;
    let (ev_tx, ev_rx) = mpsc::channel(256);
    let (cmd_tx, cmd_rx) = mpsc::channel(64);
    let (detach_tx, detach_rx) = watch::channel(false);
    let (done_tx, done_rx) = watch::channel(false);
    let link = Link {
        applied: Arc::default(),
        detached: Arc::default(),
        detach: Arc::new(detach_tx),
        done: done_rx,
    };
    tokio::spawn(relay(
        stream,
        registration.clone(),
        link.clone(),
        ev_tx,
        cmd_rx,
        detach_rx,
        done_tx,
    ));
    Ok((
        SessionHandle {
            pid: registration.pid,
            commands: cmd_tx,
            events: ev_rx,
            link: Some(link),
        },
        registration,
    ))
}

/// The node's side of one connection: events in, commands and acknowledgements out.
async fn relay(
    stream: UnixStream,
    registration: Registration,
    link: Link,
    events: mpsc::Sender<RunnerEvent>,
    mut commands: mpsc::Receiver<SessionCommand>,
    mut detach: watch::Receiver<bool>,
    done: watch::Sender<bool>,
) {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    // The seq of each event handed to the service and not yet acknowledged, oldest first.
    let mut handed: VecDeque<u64> = VecDeque::new();
    let mut last = 0;
    let mut acked = 0;
    let mut commands_open = true;
    let mut tick = tokio::time::interval(ACK_EVERY);
    let mut events = Some(events);
    // The session's exit came through: the host goes next, which is no loss.
    let mut ended = false;
    let mut detach_open = true;
    let gone = loop {
        tokio::select! {
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { break true };
                let Ok(FromHost { seq, event }) = serde_json::from_str::<FromHost>(&line) else {
                    tracing::warn!(pid = registration.pid, "a host line this node can't read");
                    break true;
                };
                if seq <= last {
                    continue;
                }
                last = seq;
                ended |= matches!(event, RunnerEvent::Exited(_));
                let Some(tx) = &events else { continue };
                if tx.send(event).await.is_err() {
                    events = None;
                    continue;
                }
                handed.push_back(seq);
            }
            command = commands.recv(), if commands_open => {
                let line = match command {
                    Some(command) => ToHost::Command(command),
                    // The session's handle went: end the process, as dropping one the node owns does.
                    None => {
                        commands_open = false;
                        ToHost::Command(SessionCommand::Shutdown { grace: Duration::ZERO })
                    }
                };
                if send(&mut write, &line).await.is_err() {
                    break true;
                }
            }
            _ = tick.tick() => {
                if ack(&mut write, &link, &mut handed, &mut acked).await.is_err() {
                    break true;
                }
            }
            changed = detach.changed(), if detach_open => match changed {
                Ok(()) if *detach.borrow() => break false,
                Ok(()) => {}
                Err(_) => detach_open = false,
            },
        }
    };
    if gone && !ended {
        // The host ended without its session's exit reaching the node: whatever it left goes, and the service sees the
        // events end without one, as a lost process.
        tracing::warn!(pid = registration.pid, "a session's host went away");
        let left = registration.clone();
        let _ = tokio::task::spawn_blocking(move || kill_tree(&left)).await;
    } else if !gone {
        link.detached.store(true, Ordering::SeqCst);
        drop(events);
        let deadline = tokio::time::Instant::now() + DRAIN;
        let total = acked + handed.len() as u64;
        while link.applied.load(Ordering::SeqCst) < total && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let _ = ack(&mut write, &link, &mut handed, &mut acked).await;
        let _ = write.shutdown().await;
    }
    let _ = done.send(true);
}

async fn send(write: &mut tokio::net::unix::OwnedWriteHalf, line: &ToHost) -> std::io::Result<()> {
    let mut text = serde_json::to_string(line).map_err(std::io::Error::other)?;
    text.push('\n');
    write.write_all(text.as_bytes()).await
}

/// Acknowledges the events the service applied since the last acknowledgement.
async fn ack(
    write: &mut tokio::net::unix::OwnedWriteHalf,
    link: &Link,
    handed: &mut VecDeque<u64>,
    acked: &mut u64,
) -> std::io::Result<()> {
    let applied = link.applied.load(Ordering::SeqCst);
    let mut upto = None;
    while *acked < applied {
        let Some(seq) = handed.pop_front() else { break };
        upto = Some(seq);
        *acked += 1;
    }
    match upto {
        Some(seq) => send(write, &ToHost::Ack(seq)).await,
        None => Ok(()),
    }
}

/// Ends the host in `dir` and its session (for a session no node will adopt), then removes the dir.
pub async fn stop(dir: &Path) {
    let registration = Registration::read(dir);
    if let Ok(stream) = dial(dir) {
        let (read, mut write) = stream.into_split();
        if send(&mut write, &ToHost::Stop).await.is_ok() {
            // The host closes the connection when it exits.
            let mut lines = BufReader::new(read).lines();
            let _ = tokio::time::timeout(STOP_WAIT, async {
                while let Ok(Some(_)) = lines.next_line().await {}
            })
            .await;
        }
    }
    if let Some(registration) = registration {
        let _ = tokio::task::spawn_blocking(move || kill_tree(&registration)).await;
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// SIGKILLs what's left of a host: claude's tree while claude is the registered process, every process carrying the
/// spawn's marker, and the host itself while it is. Never this process.
fn kill_tree(registration: &Registration) {
    let own = std::process::id();
    let mut found = if registration.pid != own && alive(registration.pid, registration.start) {
        let root = registration.pid as i32;
        let _ = killpg(Pid::from_raw(root), Signal::SIGKILL);
        let mut found = process::sweep(root, &registration.marker);
        found.retain(|p| p.pid != root);
        found
    } else if registration.marker.is_empty() {
        Vec::new()
    } else {
        process::sweep_marked(&registration.marker)
    };
    if registration.pid != own && alive(registration.pid, registration.start) {
        let _ = kill(Pid::from_raw(registration.pid as i32), Signal::SIGKILL);
    }
    found.retain(|p| p.pid as u32 != registration.host_pid);
    process::signal(&found, Signal::SIGKILL);
    if registration.host_pid != own && registration.host_alive() {
        let _ = kill(Pid::from_raw(registration.host_pid as i32), Signal::SIGKILL);
    }
}

/// Stops every host in `hosts` but those of `keep` (sessions a node adopted), and removes their dirs: hosts no session
/// row names any more, or whose session the node settled.
pub async fn sweep(hosts: &Path, keep: &std::collections::HashSet<String>) -> usize {
    let Ok(entries) = std::fs::read_dir(hosts) else {
        return 0;
    };
    let mut stopped = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if keep.contains(&name) || !entry.path().is_dir() {
            continue;
        }
        if Registration::read(&entry.path()).is_some_and(|r| r.host_alive()) {
            stopped += 1;
        }
        stop(&entry.path()).await;
    }
    stopped
}

#[cfg(test)]
mod tests;
