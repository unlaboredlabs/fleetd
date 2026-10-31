//! Hosts against a real process: a fake claude that says `system/init` once per line it is asked for, so each event
//! is told apart by its model (`m1`, `m2`, …). The host runs in this process, as the node's restart is what's tested:
//! a node is a connection, and its restart a detach, a crash or a drop, then a connection again.
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use nix::sys::stat::Mode;
use nix::unistd::mkfifo;
use tokio::io::{AsyncBufReadExt, BufReader};

use super::*;

/// Says m1..m3, waits for a line on the FIFO `$1`, says m4..m6, then runs until its stdin closes.
const TALKING_CLAUDE: &str = r#"#!/bin/sh
init() { echo "{\"type\":\"system\",\"subtype\":\"init\",\"claude_code_version\":\"2.1.302\",\"model\":\"m$1\",\"cwd\":\"/fake\"}"; }
init 1; init 2; init 3
read go < "$1"
init 4; init 5; init 6
exec cat > /dev/null
"#;

/// Says m1 and exits.
const BRIEF_CLAUDE: &str = r#"#!/bin/sh
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"m1","cwd":"/fake"}'
"#;

struct Fake {
    dir: tempfile::TempDir,
}

impl Fake {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        mkfifo(&dir.path().join("go"), Mode::S_IRWXU).unwrap();
        Self { dir }
    }

    fn host_dir(&self, name: &str) -> PathBuf {
        let dir = self.dir.path().join("hosts").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A host for `script` in `hosts/<name>`, serving in a task: claude's pid and the task.
    fn host(
        &self,
        name: &str,
        script: &str,
        bounds: Bounds,
    ) -> (PathBuf, u32, tokio::task::JoinHandle<()>) {
        let program = self.dir.path().join(format!("claude-{name}"));
        std::fs::write(&program, script).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let dir = self.host_dir(name);
        let fifo = self.dir.path().join("go").display().to_string();
        // A marker of its own: this test may itself run inside a session, whose marker its sweeps must never match,
        // and the session tests sweep what their sessions (`s1`, …) left.
        let marker = process::marker(&format!("host-test-{name}"));
        // Another test's fork may briefly hold the script's write fd (ETXTBSY).
        let mut tries = 0;
        let handle = loop {
            match super::super::claude::hosted(&program, vec![fifo.clone()], name, marker.clone()) {
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) && tries < 100 => {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(10));
                }
                spawned => break spawned.unwrap(),
            }
        };
        let pid = handle.pid;
        let serving = serve_here(&dir, handle, marker, std::future::pending(), bounds).unwrap();
        (dir, pid, serving)
    }

    /// Lets the fake claude say its second half.
    async fn go(&self) {
        let fifo = self.dir.path().join("go");
        tokio::task::spawn_blocking(move || std::fs::write(fifo, "go\n").unwrap())
            .await
            .unwrap();
    }
}

/// Applies events as the session service does (each counted once applied) until `n` inits came, and returns their
/// models.
async fn apply_inits(handle: &mut SessionHandle, n: usize) -> Vec<String> {
    let mut models = Vec::new();
    while models.len() < n {
        let event = tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
            .await
            .expect("an event came")
            .expect("the events go on");
        if let RunnerEvent::Init { model, .. } = event {
            models.push(model);
        }
        applied(handle);
    }
    models
}

fn applied(handle: &SessionHandle) {
    handle
        .link
        .as_ref()
        .unwrap()
        .applied
        .fetch_add(1, Ordering::SeqCst);
}

/// Applies events until the exit.
async fn until_exit(handle: &mut SessionHandle) {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(15), handle.events.recv())
            .await
            .expect("an event came")
            .expect("the events go on until the exit");
        applied(handle);
        if matches!(event, RunnerEvent::Exited(_)) {
            return;
        }
    }
}

fn running(pid: u32) -> bool {
    start_of(pid).is_some()
}

async fn ended(serving: tokio::task::JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(15), serving)
        .await
        .expect("the host ended")
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_runs_on_through_a_node_restart_and_each_event_arrives_once() {
    let fake = Fake::new();
    let (dir, pid, serving) = fake.host("s1", TALKING_CLAUDE, BOUNDS);
    let (mut first, registration) = connect(&dir).unwrap();
    assert_eq!((first.pid, registration.pid), (pid, pid));
    let mut seen = apply_inits(&mut first, 3).await;

    // The node stops for its update: it lets go, and the session goes on without it.
    first.link.as_ref().unwrap().detach().await;
    assert!(
        first.events.recv().await.is_none(),
        "the old node's events end"
    );
    assert!(first.link.as_ref().unwrap().detached.load(Ordering::SeqCst));
    fake.go().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(running(pid));

    // The next node takes it from there: what the last one applied never again, what it said meanwhile once.
    let (mut second, again) = connect(&dir).unwrap();
    assert_eq!(again.pid, pid, "the same claude");
    seen.extend(apply_inits(&mut second, 3).await);
    assert_eq!(seen, ["m1", "m2", "m3", "m4", "m5", "m6"]);
    let more = tokio::time::timeout(Duration::from_millis(300), second.events.recv()).await;
    assert!(more.is_err(), "nothing twice: {more:?}");

    // It still ends as a session does, and its host with it once the node took the exit.
    second
        .commands
        .send(SessionCommand::Shutdown {
            grace: Duration::ZERO,
        })
        .await
        .unwrap();
    until_exit(&mut second).await;
    ended(serving).await;
    assert!(!running(pid));
}

/// A node that crashed acknowledged nothing it hadn't applied: the next one gets every event the host kept again,
/// rather than losing any.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_host_keeps_what_no_node_acknowledged() {
    let fake = Fake::new();
    let (dir, pid, serving) = fake.host("s1", TALKING_CLAUDE, BOUNDS);
    {
        // A node that reads three events and dies before saying it applied them.
        let stream = tokio::net::UnixStream::connect(dir.join(SOCKET))
            .await
            .unwrap();
        let mut lines = BufReader::new(stream).lines();
        for _ in 0..3 {
            lines.next_line().await.unwrap().unwrap();
        }
    }
    let (mut next, _) = connect(&dir).unwrap();
    assert_eq!(apply_inits(&mut next, 3).await, ["m1", "m2", "m3"]);
    // Once applied and acknowledged, they're the host's no more.
    tokio::time::sleep(ACK_EVERY * 3).await;
    next.link.as_ref().unwrap().detach().await;
    let (mut last, _) = connect(&dir).unwrap();
    fake.go().await;
    assert_eq!(apply_inits(&mut last, 3).await, ["m4", "m5", "m6"]);
    last.commands
        .send(SessionCommand::Shutdown {
            grace: Duration::ZERO,
        })
        .await
        .unwrap();
    until_exit(&mut last).await;
    ended(serving).await;
    assert!(!running(pid));
}

/// claude exits while no node is there: its host keeps the exit for the next node, and lingers no longer than that.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_host_waits_for_a_node_to_take_the_exit() {
    let fake = Fake::new();
    let (dir, _, serving) = fake.host("s1", BRIEF_CLAUDE, BOUNDS);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!serving.is_finished(), "the exit waits for a node");
    let (mut node, _) = connect(&dir).unwrap();
    assert_eq!(apply_inits(&mut node, 1).await, ["m1"]);
    until_exit(&mut node).await;
    ended(serving).await;

    // With no node at all, it waits only so long.
    let (_, _, serving) = fake.host(
        "s2",
        BRIEF_CLAUDE,
        Bounds {
            linger: Duration::from_millis(200),
            ..BOUNDS
        },
    );
    ended(serving).await;
}

/// A node stopped for good (not restarted), or a machine removed: once no node has been connected for so long, the
/// host ends its session, mid-turn included, and exits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_host_no_node_comes_back_to_ends_its_session() {
    let fake = Fake::new();
    let bounds = Bounds {
        alone: Duration::from_millis(500),
        ..BOUNDS
    };
    let (dir, pid, serving) = fake.host("s1", TALKING_CLAUDE, bounds);
    // A node that connects, then goes without letting go: the clock starts over from then.
    let (mut node, _) = connect(&dir).unwrap();
    apply_inits(&mut node, 3).await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(running(pid), "a connected node keeps it");
    node.link.as_ref().unwrap().detach().await;
    ended(serving).await;
    assert!(!running(pid));
}

/// A stop ends the session, the host, and its dir; a sweep stops every host but those the node re-adopted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hosts_no_node_adopts_are_stopped_with_their_sessions() {
    let fake = Fake::new();
    let (kept_dir, kept, kept_serving) = fake.host("kept", TALKING_CLAUDE, BOUNDS);
    let (orphan_dir, orphan, orphan_serving) = fake.host("orphan", TALKING_CLAUDE, BOUNDS);
    let keep = std::collections::HashSet::from(["kept".to_owned()]);
    let stopped = sweep(&fake.dir.path().join("hosts"), &keep).await;
    assert_eq!(stopped, 1);
    ended(orphan_serving).await;
    assert!(!running(orphan));
    assert!(!orphan_dir.exists());
    assert!(running(kept) && kept_dir.exists());

    stop(&kept_dir).await;
    ended(kept_serving).await;
    assert!(!running(kept));
    assert!(!kept_dir.exists());
}

/// A host an older or newer fleetd left, which speaks another protocol, is never adopted; nor is one whose claude
/// didn't start.
#[test]
fn a_host_of_another_protocol_is_not_adopted() {
    let dir = tempfile::tempdir().unwrap();
    let registration = |protocol, refused| Registration {
        protocol,
        host_pid: std::process::id(),
        host_start: start_of(std::process::id()),
        pid: 0,
        start: None,
        marker: String::new(),
        refused,
    };
    registration(PROTOCOL + 1, None).write(dir.path()).unwrap();
    assert!(Registration::read(dir.path()).unwrap().host_alive());
    let refused = connect(dir.path()).err().unwrap();
    assert!(refused.to_string().contains("protocol"), "{refused}");
    registration(
        PROTOCOL,
        Some(Refused {
            message: "no claude".into(),
            missing: true,
        }),
    )
    .write(dir.path())
    .unwrap();
    assert!(connect(dir.path()).is_err());
    assert!(!alive(0, None) && !alive(1, None));
}

/// A node home deep enough that the socket's own path won't fit a socket's address still gets hosts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_host_in_a_deep_home_still_answers() {
    let fake = Fake::new();
    let deep = format!("deep-{}", "d".repeat(120));
    let (dir, pid, serving) = fake.host(&deep, BRIEF_CLAUDE, BOUNDS);
    assert!(dir.join(SOCKET).as_os_str().len() > 108);
    let (mut node, registration) = connect(&dir).unwrap();
    assert_eq!(registration.pid, pid);
    assert_eq!(apply_inits(&mut node, 1).await, ["m1"]);
    until_exit(&mut node).await;
    ended(serving).await;
}
