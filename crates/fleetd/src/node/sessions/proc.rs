//! A recorded claude process from before a node restart: identified by pid plus start time, so a pid the kernel
//! has since reused is never signalled, and stopped together with every process its session started.
use std::path::{Path, PathBuf};
use std::time::Duration;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;

use crate::node::runner::process::{self, Proc};

/// After SIGKILL: how long to wait for the swept processes to be gone.
const KILL_WAIT: Duration = Duration::from_secs(2);

/// The process's start time as the kernel reports it, `None` when it is gone. Opaque: only compared for equality.
pub fn start_time(pid: u32) -> Option<String> {
    if cfg!(target_os = "linux") {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // Field 22, counted after the parenthesised command name (which may itself contain spaces).
        let fields: Vec<&str> = stat[stat.rfind(')')? + 2..].split(' ').collect();
        // A zombie has exited; it only waits for its parent to reap it.
        (fields.first() != Some(&"Z"))
            .then(|| fields.get(19).map(|s| (*s).to_owned()))
            .flatten()
    } else {
        let out = std::process::Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (out.status.success() && !text.is_empty()).then_some(text)
    }
}

fn gone(proc: &Proc) -> bool {
    let now = start_time(proc.pid as u32);
    match proc.start {
        Some(start) => now.and_then(|s| s.parse().ok()) != Some(start),
        None => now.is_none(),
    }
}

/// What session `session` left: claude's descendants while claude (`root`) is still the recorded process, and on
/// Linux every process carrying a marker of any of the session's spawns, which also finds tool children orphaned
/// when claude died. The node runs this before it spawns anything for the session, so every such marker is the dead
/// node's.
async fn sweep(root: Option<i32>, session: &str) -> Vec<Proc> {
    let session = session.to_owned();
    tokio::task::spawn_blocking(move || {
        let table = process::table();
        let mut found = root.map_or_else(Vec::new, |root| process::descendants(&table, root));
        found.extend(
            spawned_for(&table, &session)
                .into_iter()
                .filter(|p| Some(p.pid) != root),
        );
        process::dedupe(&mut found);
        found
    })
    .await
    .unwrap_or_default()
}

/// The live processes whose [`process::SESSION_MARKER`] names `session`.
#[cfg(target_os = "linux")]
fn spawned_for(table: &[Proc], session: &str) -> Vec<Proc> {
    let own = nix::unistd::getpid().as_raw();
    let prefix = format!("{}=", process::SESSION_MARKER);
    table
        .iter()
        .filter(|p| p.pid != own && !p.zombie)
        .filter(|p| {
            let Ok(env) = std::fs::read(format!("/proc/{}/environ", p.pid)) else {
                return false;
            };
            env.split(|b| *b == 0)
                .find_map(|var| var.strip_prefix(prefix.as_bytes()))
                .is_some_and(|marker| {
                    marker_session(&String::from_utf8_lossy(marker)) == Some(session)
                })
        })
        .copied()
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn spawned_for(_table: &[Proc], _session: &str) -> Vec<Proc> {
    Vec::new()
}

/// The session id in a spawn's marker, `<session>.<node pid>.<nanos>.<n>` ([`process::marker`]). Session ids may
/// hold dots themselves, so it is everything before the last three fields.
fn marker_session(marker: &str) -> Option<&str> {
    let mut fields = marker.rsplitn(4, '.');
    fields.nth(3)
}

/// Where a process of a screen or a session lives under the node's home: the sessions' scratch dirs (an agent's own
/// headless Chrome keeps its profile there) and the browser pool's profiles.
fn orphan_roots(home: &Path) -> [PathBuf; 2] {
    [home.join("tmp"), home.join("browser").join("profiles")]
}

/// Whether a process (its NUL-separated command line and environment) belongs to a session or screen under `roots`:
/// its TMPDIR is a session's scratch dir, or an argument names a path there (`--user-data-dir=<root>/...`).
fn orphaned(cmdline: &[u8], environ: &[u8], roots: &[PathBuf]) -> bool {
    let under = |text: &str| {
        roots.iter().any(|root| {
            let root = root.to_string_lossy();
            text.find(root.as_ref())
                .is_some_and(|at| text[at + root.len()..].starts_with('/'))
        })
    };
    let tmpdir = environ
        .split(|b| *b == 0)
        .find_map(|var| var.strip_prefix(b"TMPDIR="))
        .map(String::from_utf8_lossy);
    tmpdir.is_some_and(|dir| under(&format!("{dir}/")))
        || cmdline
            .split(|b| *b == 0)
            .any(|arg| under(&String::from_utf8_lossy(arg)))
}

/// Kills what sessions and screens of a node that went away left running, with everything they started: as the node
/// starts, before any session of its own runs, no live session owns them (the Oct 26 headless Chrome, its profile
/// under a session's scratch dir, ran on for days). Linux only. Returns how many it found.
#[cfg(target_os = "linux")]
pub fn kill_orphans(home: &Path) -> usize {
    let own = nix::unistd::getpid().as_raw();
    let roots = orphan_roots(home);
    let table = process::table();
    let mut found: Vec<Proc> = table
        .iter()
        .filter(|p| p.pid != own && !p.zombie)
        .filter(|p| {
            let read =
                |what: &str| std::fs::read(format!("/proc/{}/{what}", p.pid)).unwrap_or_default();
            orphaned(&read("cmdline"), &read("environ"), &roots)
        })
        .copied()
        .collect();
    let count = found.len();
    for p in found.clone() {
        found.extend(process::descendants(&table, p.pid));
    }
    process::dedupe(&mut found);
    found.retain(|p| p.pid != own);
    process::signal(&found, Signal::SIGKILL);
    count
}

#[cfg(not(target_os = "linux"))]
pub fn kill_orphans(_home: &Path) -> usize {
    0
}

/// Stops what session `session` left running when the node went away: SIGTERM to claude's process group (claude
/// kills its tool children on SIGTERM), SIGKILL after `grace`, then SIGKILL to every swept process and group. The
/// sweep comes before each signal, because once claude is gone its children can no longer be found by ppid. Claude
/// itself is signalled only while `pid` still has the recorded start time.
pub async fn kill_recorded(pid: u32, started: &str, session: &str, grace: Duration) {
    let alive = || start_time(pid).as_deref() == Some(started);
    let root = (pid > 1 && pid <= i32::MAX as u32 && alive()).then_some(pid as i32);
    let mut swept = sweep(root, session).await;
    if root.is_none() && swept.is_empty() {
        return;
    }
    tracing::warn!(
        pid,
        session_id = session,
        leftover = swept.len(),
        "stopping claude processes left from before the node restarted"
    );
    if let Some(root) = root {
        let group = Pid::from_raw(root);
        let _ = killpg(group, Signal::SIGTERM);
        let deadline = tokio::time::Instant::now() + grace;
        while alive() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        swept.extend(sweep(alive().then_some(root), session).await);
        process::dedupe(&mut swept);
        if alive() {
            let _ = killpg(group, Signal::SIGKILL);
        }
    }
    process::signal(&swept, Signal::SIGKILL);
    let deadline = tokio::time::Instant::now() + KILL_WAIT;
    while !swept.iter().all(gone) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    /// A stand-in for claude that starts a "tool" in its own process group (as claude's Bash tool does), prints the
    /// tool's pid and waits. Returns once the tool runs `sleep` with its marker readable: `$!` is printed right after
    /// the fork, and while the tool is still exec'ing `setsid` and `sleep`, `/proc/<pid>/environ` reads empty, so a
    /// sweep then could not find it by its marker.
    async fn claude_with_tool(session: &str) -> (tokio::process::Child, u32) {
        let marker = process::marker(session);
        let mut child = tokio::process::Command::new("sh")
            .args(["-c", "setsid sleep 30 & echo $!; wait"])
            .env(process::SESSION_MARKER, &marker)
            .stdout(std::process::Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        // It carries a marker, so the node's orphan reaper would otherwise take tokio's exit status.
        process::track(child.id().unwrap() as i32);
        let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
        let tool: u32 = lines.next_line().await.unwrap().unwrap().parse().unwrap();
        let var = format!("{}={marker}", process::SESSION_MARKER).into_bytes();
        let settled = || {
            let comm = std::fs::read_to_string(format!("/proc/{tool}/comm")).unwrap_or_default();
            let env = std::fs::read(format!("/proc/{tool}/environ")).unwrap_or_default();
            comm.trim() == "sleep" && env.split(|b| *b == 0).any(|v| v == var.as_slice())
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while !settled() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the tool never started"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        (child, tool)
    }

    /// A session id no other test run on the machine uses: a sweep takes every process whose marker names the
    /// session, so two runs of this suite at once (two worktrees) would otherwise kill each other's processes.
    fn own_session(name: &str) -> String {
        format!("{name}-{}", std::process::id())
    }

    #[tokio::test]
    async fn a_restart_kills_the_recorded_claude_and_its_tool_children_only() {
        let session = own_session("restart-a");
        let (mut child, tool) = claude_with_tool(&session).await;
        let pid = child.id().unwrap();
        let started = start_time(pid).unwrap();
        // A pid reused by another process (another start time) is left alone, and so are its descendants.
        kill_recorded(
            pid,
            "not-its-start-time",
            &own_session("restart-other"),
            Duration::ZERO,
        )
        .await;
        assert_eq!(start_time(pid).as_deref(), Some(started.as_str()));
        assert!(start_time(tool).is_some());

        kill_recorded(pid, &started, &session, Duration::from_secs(5)).await;
        let status = child.wait().await.unwrap();
        assert_eq!(
            std::os::unix::process::ExitStatusExt::signal(&status),
            Some(15)
        );
        // The tool ran in its own group, so the SIGTERM to claude's group missed it; the sweep did not.
        assert_eq!(start_time(tool), None);
    }

    #[tokio::test]
    async fn a_restart_finds_tool_children_orphaned_by_a_claude_that_already_died() {
        let session = own_session("restart-b");
        let (mut child, tool) = claude_with_tool(&session).await;
        let pid = child.id().unwrap();
        let started = start_time(pid).unwrap();
        child.kill().await.unwrap();
        assert!(start_time(tool).is_some());

        kill_recorded(pid, &started, &session, Duration::from_secs(5)).await;
        assert_eq!(start_time(tool), None);
    }

    #[test]
    fn an_orphan_is_a_process_of_a_scratch_dir_or_a_browser_profile() {
        let roots = orphan_roots(Path::new("/n"));
        let nul = |parts: &[&str]| parts.join("\0").into_bytes();
        let path = nul(&["PATH=/usr/bin"]);
        let chrome = |profile: &str| {
            nul(&[
                "chrome",
                "--headless",
                &format!("--user-data-dir={profile}"),
            ])
        };
        assert!(orphaned(&chrome("/n/tmp/0a1b/ab/prof"), &path, &roots));
        assert!(orphaned(
            &chrome("/n/browser/profiles/profile-x"),
            &path,
            &roots
        ));
        assert!(orphaned(
            &nul(&["node", "server.js"]),
            &nul(&["TMPDIR=/n/tmp/0a1b"]),
            &roots
        ));
        assert!(!orphaned(
            &chrome("/home/me/prof"),
            &nul(&["TMPDIR=/tmp"]),
            &roots
        ));
        assert!(!orphaned(
            &chrome("/n/tmpx/prof"),
            &nul(&["TMPDIR=/n/tmpx"]),
            &roots
        ));
        assert!(!orphaned(
            &chrome("/n/browser/ms-playwright/x"),
            &path,
            &roots
        ));
    }

    /// A process standing in for a leftover: `sh` with `args` and TMPDIR at `tmpdir`, waiting on a `sleep` it started.
    /// Returns once the `sleep` runs.
    async fn leftover(tmpdir: &Path, args: &[&str]) -> (tokio::process::Child, u32) {
        let mut child = tokio::process::Command::new("sh")
            .args(["-c", "sleep 30 & echo $!; wait", "leftover"])
            .args(args)
            .env("TMPDIR", tmpdir)
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
        let sleep: u32 = lines.next_line().await.unwrap().unwrap().parse().unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while std::fs::read_to_string(format!("/proc/{sleep}/comm"))
            .unwrap_or_default()
            .trim()
            != "sleep"
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the sleep never started"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        (child, sleep)
    }

    /// The devbox's headless Chrome, its profile under a session's scratch dir, ran on for a day after its session:
    /// a starting node kills such processes and what they started, and nothing outside its home.
    #[tokio::test]
    async fn a_starting_node_kills_what_sessions_left_running_under_its_home() {
        let home = tempfile::tempdir().unwrap();
        let other = home.path().join("tmpx");
        let profile = format!(
            "--user-data-dir={}",
            home.path().join("tmp/0a1b/ab/prof").display()
        );
        let (mut by_env, by_env_sleep) = leftover(&home.path().join("tmp/0a1b"), &[]).await;
        let (mut by_arg, by_arg_sleep) = leftover(&other, &[&profile]).await;
        let (mut kept, kept_sleep) = leftover(&other, &[]).await;

        let found = {
            let home = home.path().to_owned();
            tokio::task::spawn_blocking(move || kill_orphans(&home))
                .await
                .unwrap()
        };
        assert_eq!(
            found, 3,
            "both, and the sleep that inherited the scratch TMPDIR"
        );
        for child in [&mut by_env, &mut by_arg] {
            let status = child.wait().await.unwrap();
            assert_eq!(
                std::os::unix::process::ExitStatusExt::signal(&status),
                Some(9)
            );
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while [by_env_sleep, by_arg_sleep]
            .iter()
            .any(|p| start_time(*p).is_some())
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "a leftover's child lived on"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(start_time(kept.id().unwrap()).is_some() && start_time(kept_sleep).is_some());
        kept.kill().await.unwrap();
        let _ = nix::sys::signal::kill(Pid::from_raw(kept_sleep as i32), Signal::SIGKILL);
    }

    #[test]
    fn a_marker_names_its_session_even_when_the_id_has_dots() {
        assert_eq!(marker_session(&process::marker("a.b")), Some("a.b"));
        assert_eq!(marker_session("a.1.2"), None);
    }
}
