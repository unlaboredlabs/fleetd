//! Each session's process tree in a transient systemd scope of its own, on Linux when the user's systemd manager
//! answers. Before, every agent shared the node's cgroup, so one agent's build that the kernel killed for memory made
//! systemd fail the whole unit (`Failed with result 'oom-kill'`) and every agent on the machine with it. Now the kill
//! lands in one agent's scope, which has `OOMPolicy=continue`: the killed build fails, claude sees the error and goes
//! on, and the node and the other agents never notice.
//!
//! `systemd-run --scope` moves itself into the new scope and then execs the command, so claude keeps the pid, the
//! process group and the pipes the node gave it, and sweeps find its tree as before. A scope never fails a session:
//! when systemd-run doesn't start claude, the session starts again without one ([`spawn`]), scopes stay off until the
//! next check ([`RECHECK`]), and the node says so once. Without a user manager (macOS, a container, a node started by
//! hand outside a login session) sessions start in the node's own cgroup.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// systemd-run reaches the user manager through these, and a session's environment starts empty.
const BUS_VARS: [&str; 2] = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
/// How long a probe may take before the node counts scopes as unavailable.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long systemd-run may take to set up a session's scope and exec claude before the session starts without one.
const START_TIMEOUT: Duration = Duration::from_secs(5);
/// While scopes are off, how often the node checks again whether they work.
pub const RECHECK: Duration = Duration::from_secs(10 * 60);

/// How to start a session in a scope of its own on this machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    /// `systemd-run`, as found on the node's PATH.
    pub program: PathBuf,
    /// The node's own unit when it runs as one (`fleetd-node.service`). Each scope is `PartOf=` it, so stopping or
    /// restarting the node still stops its agents, as when they shared its cgroup, and `Before=` it, so systemd stops
    /// the scopes only after the node's own shutdown has interrupted its agents and given them their grace.
    pub node_unit: Option<String>,
    /// `OOMPolicy=continue` on the scope: a process killed for memory fails alone, not the whole agent. An older
    /// systemd that can't set it on a scope still gets a scope, which keeps the node alive.
    pub oom_continue: bool,
    /// The node's [`BUS_VARS`], added to the session's environment.
    pub env: Vec<(String, String)>,
}

impl Scope {
    /// `systemd-run`'s own arguments, up to and including the `--` before the command.
    fn args(&self, session_id: &str) -> Vec<String> {
        let mut args: Vec<String> = ["--user", "--scope", "--collect", "--quiet"]
            .map(str::to_owned)
            .into();
        args.push(format!("--description=fleetd agent {session_id}"));
        if self.oom_continue {
            args.push("--property=OOMPolicy=continue".into());
        }
        if let Some(unit) = &self.node_unit {
            args.push(format!("--property=PartOf={unit}"));
            args.push(format!("--property=Before={unit}"));
        }
        args.push("--".into());
        args
    }
}

/// The program and argv that start `binary args…` for a session: as is, or through `systemd-run` in a scope of its
/// own.
pub fn command(
    binary: &Path,
    args: Vec<String>,
    scope: Option<&Scope>,
    session_id: &str,
) -> (PathBuf, Vec<String>) {
    match scope {
        None => (binary.to_path_buf(), args),
        Some(scope) => {
            let mut argv = scope.args(session_id);
            argv.push(binary.display().to_string());
            argv.extend(args);
            (scope.program.clone(), argv)
        }
    }
}

/// Starts a session's process with the command `build` makes for a program, its argv and the scope used: through
/// `scope` when there is one, and again without it when systemd-run didn't start `binary` (it couldn't be run,
/// exited, or hadn't exec'd within [`START_TIMEOUT`]). Returns the child and, after such a fallback, why the scope
/// failed. Blocks until systemd-run has exec'd, a few milliseconds.
pub fn spawn(
    scope: Option<&Scope>,
    binary: &Path,
    args: Vec<String>,
    session_id: &str,
    build: impl Fn(PathBuf, Vec<String>, Option<&Scope>) -> tokio::process::Command,
) -> std::io::Result<(tokio::process::Child, Option<String>)> {
    spawn_within(scope, binary, args, session_id, build, START_TIMEOUT)
}

fn spawn_within(
    scope: Option<&Scope>,
    binary: &Path,
    args: Vec<String>,
    session_id: &str,
    build: impl Fn(PathBuf, Vec<String>, Option<&Scope>) -> tokio::process::Command,
    timeout: Duration,
) -> std::io::Result<(tokio::process::Child, Option<String>)> {
    let failed = match scope {
        None => None,
        Some(scope) => {
            let (program, argv) = command(binary, args.clone(), Some(scope), session_id);
            // A new child carries this thread's name until its own exec renames it.
            let spawner = std::fs::read_to_string("/proc/thread-self/comm").unwrap_or_default();
            match build(program, argv, Some(scope)).spawn() {
                Ok(mut child) => match exec_of(&mut child, &scope.program, &spawner, timeout) {
                    Ok(()) => return Ok((child, None)),
                    Err(why) => {
                        let _ = child.start_kill();
                        let _ = child.try_wait();
                        Some(why)
                    }
                },
                // A cause the session shares, such as a missing working directory, fails it without a scope too.
                Err(e) if scope.program.is_file() => return Err(e),
                Err(e) => Some(format!("systemd-run could not be run: {e}")),
            }
        }
    };
    let (program, argv) = command(binary, args, None, session_id);
    Ok((build(program, argv, None).spawn()?, failed))
}

/// Waits until `child`, started as `program` from a thread named `spawner`, has exec'd something else. A process's
/// `comm` names the program it runs now, and a zombie keeps its last one, so a command that ran and exited at once
/// still counts as started.
fn exec_of(
    child: &mut tokio::process::Child,
    program: &Path,
    spawner: &str,
    timeout: Duration,
) -> Result<(), String> {
    let Some(pid) = child.id() else {
        return Err("systemd-run exited at once".into());
    };
    // The kernel keeps 15 bytes of a program's name.
    let name: String = program
        .file_name()
        .map(|n| n.to_string_lossy().chars().take(15).collect())
        .unwrap_or_default();
    let deadline = Instant::now() + timeout;
    loop {
        // Whether it exited, then its name: a zombie's name is final, but a name read first may predate an exec right
        // before the exit, and try_wait would reap it, name and all. A claude that exits at once still counts.
        let exited = exited(pid);
        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
        if handed_over(&comm, &name, spawner) {
            return Ok(());
        }
        if exited {
            return Err(match child.try_wait() {
                Ok(Some(status)) => format!("systemd-run {status}"),
                _ => "systemd-run exited".into(),
            });
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "systemd-run had not started the session after {} s",
                timeout.as_secs_f32()
            ));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Whether process `pid` has exited, from `/proc/{pid}/stat`, without reaping it. One that's gone counts.
fn exited(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return true;
    };
    // `pid (comm) state …`, and comm may hold a `)`.
    let state = stat
        .rfind(')')
        .and_then(|i| stat[i + 1..].split_whitespace().next());
    matches!(state, Some("Z" | "X"))
}

/// Whether a child's `comm` shows that `systemd-run` (named `name`) has exec'd the session's command. Neither its own
/// name nor `spawner`'s counts: the kernel lets the parent of a spawn run on before the child's exec renames it, so
/// right after a spawn the child may still read as the thread that started it.
fn handed_over(comm: &str, name: &str, spawner: &str) -> bool {
    let comm = comm.trim_end();
    !comm.is_empty() && comm != name && comm != spawner.trim_end()
}

/// The unit the node runs as in its user manager, from `/proc/self/cgroup`'s cgroup v2 line, e.g.
/// `0::/user.slice/user-1000.slice/user@1000.service/app.slice/fleetd-node.service`. None outside a user manager's
/// service: a system unit can't be named from a `--user` scope.
pub fn own_unit(cgroup: &str) -> Option<String> {
    let path = cgroup.lines().find_map(|l| l.strip_prefix("0::"))?;
    let mut parts = path.split('/');
    parts.find(|p| p.starts_with("user@") && p.ends_with(".service"))?;
    parts
        .next_back()
        .filter(|p| p.ends_with(".service"))
        .map(str::to_owned)
}

/// Whether scopes work here, as of when the node last checked.
struct Probed {
    scope: Option<Scope>,
    at: Instant,
    checking: bool,
}

impl Probed {
    /// Scopes are off and were last checked [`RECHECK`] ago or more: check again.
    fn due(&self, now: Instant) -> bool {
        self.scope.is_none() && !self.checking && now.duration_since(self.at) >= RECHECK
    }
}

static PROBED: Mutex<Option<Probed>> = Mutex::new(None);

fn probed() -> std::sync::MutexGuard<'static, Option<Probed>> {
    PROBED.lock().unwrap_or_else(|p| p.into_inner())
}

/// This machine's way to scope sessions: `systemd-run --user --scope` must actually start a command. Blocking on the
/// first call. While scopes are off, a call [`RECHECK`] after the last check starts a new one in the background.
pub fn current() -> Option<Scope> {
    let mut state = probed();
    match &mut *state {
        None => {
            let scope = probe();
            log(None, scope.as_ref(), "");
            *state = Some(Probed {
                scope: scope.clone(),
                at: Instant::now(),
                checking: false,
            });
            scope
        }
        Some(p) if p.due(Instant::now()) => {
            p.checking = true;
            std::thread::spawn(|| settle(probe(), ""));
            None
        }
        Some(p) => p.scope.clone(),
    }
}

/// systemd-run didn't start a session (`why`): sessions start without a scope until the next check.
pub fn failed(why: &str) {
    settle(None, why);
}

fn settle(scope: Option<Scope>, why: &str) {
    let mut state = probed();
    let before = state.as_ref().and_then(|p| p.scope.clone());
    log(before.as_ref(), scope.as_ref(), why);
    *state = Some(Probed {
        scope,
        at: Instant::now(),
        checking: false,
    });
}

/// Says so when scopes come or go, once each time.
fn log(before: Option<&Scope>, now: Option<&Scope>, why: &str) {
    match (before, now) {
        (None, Some(scope)) => tracing::info!(
            node_unit = ?scope.node_unit,
            oom_continue = scope.oom_continue,
            "each session runs in a systemd scope of its own"
        ),
        (Some(_), None) => tracing::warn!(
            "sessions start without a systemd scope until the next check in {} min: {why}",
            RECHECK.as_secs() / 60
        ),
        _ => {}
    }
}

fn probe() -> Option<Scope> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let path = std::env::var_os("PATH")?;
    let program = std::env::split_paths(&path)
        .map(|dir| dir.join("systemd-run"))
        .find(|bin| bin.is_file())?;
    let env: Vec<(String, String)> = BUS_VARS
        .iter()
        .filter_map(|k| Some(((*k).to_owned(), std::env::var(k).ok()?)))
        .collect();
    let node_unit = std::fs::read_to_string("/proc/self/cgroup")
        .ok()
        .and_then(|c| own_unit(&c));
    // An older systemd may refuse a property on a scope: the most it takes wins, and a bare scope still keeps the node
    // alive.
    let mut tries = Vec::new();
    for oom_continue in [true, false] {
        if node_unit.is_some() {
            tries.push((node_unit.clone(), oom_continue));
        }
        tries.push((None, oom_continue));
    }
    tries
        .into_iter()
        .map(|(node_unit, oom_continue)| Scope {
            program: program.clone(),
            node_unit,
            oom_continue,
            env: env.clone(),
        })
        .find(starts)
}

/// Whether `systemd-run` starts `true` in a scope as `scope` would start claude, within [`PROBE_TIMEOUT`].
fn starts(scope: &Scope) -> bool {
    let (program, args) = command(Path::new("true"), Vec::new(), Some(scope), "probe");
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_clear()
        .envs(std::env::var("PATH").map(|p| ("PATH".to_owned(), p)))
        .envs(scope.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn scope(node_unit: Option<&str>) -> Scope {
        Scope {
            program: "/usr/bin/systemd-run".into(),
            node_unit: node_unit.map(str::to_owned),
            oom_continue: true,
            env: Vec::new(),
        }
    }

    #[test]
    fn without_a_user_manager_claude_starts_as_is() {
        let (program, args) = command(
            Path::new("/opt/claude"),
            vec!["-p".into(), "--verbose".into()],
            None,
            "s1",
        );
        assert_eq!(program, PathBuf::from("/opt/claude"));
        assert_eq!(args, ["-p", "--verbose"]);
    }

    #[test]
    fn with_one_claude_starts_in_a_scope_of_its_own_tied_to_the_node() {
        let (program, args) = command(
            Path::new("/opt/claude"),
            vec!["-p".into(), "--verbose".into()],
            Some(&scope(Some("fleetd-node.service"))),
            "s1",
        );
        assert_eq!(program, PathBuf::from("/usr/bin/systemd-run"));
        assert_eq!(
            args,
            [
                "--user",
                "--scope",
                "--collect",
                "--quiet",
                "--description=fleetd agent s1",
                "--property=OOMPolicy=continue",
                "--property=PartOf=fleetd-node.service",
                "--property=Before=fleetd-node.service",
                "--",
                "/opt/claude",
                "-p",
                "--verbose",
            ]
        );
        // A node started by hand has no unit to tie the scope to; an older systemd takes no OOMPolicy on a scope.
        let old = Scope {
            oom_continue: false,
            ..scope(None)
        };
        let (_, args) = command(Path::new("/opt/claude"), Vec::new(), Some(&old), "s1");
        assert_eq!(
            args.join(" "),
            "--user --scope --collect --quiet --description=fleetd agent s1 -- /opt/claude"
        );
    }

    #[test]
    fn the_nodes_unit_is_read_from_its_cgroup() {
        let user =
            "0::/user.slice/user-1000.slice/user@1000.service/app.slice/fleetd-node-lab.service\n";
        assert_eq!(own_unit(user).as_deref(), Some("fleetd-node-lab.service"));
        // Started from a terminal: a session scope, no unit of its own.
        let shell = "0::/user.slice/user-1000.slice/session-3.scope\n";
        assert_eq!(own_unit(shell), None);
        // A system service can't be a --user scope's dependency.
        assert_eq!(own_unit("0::/system.slice/fleetd-node.service\n"), None);
        // In a user manager but not in a service (an app's scope).
        let app = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-term-1.scope\n";
        assert_eq!(own_unit(app), None);
        // cgroup v1 only.
        assert_eq!(own_unit("12:pids:/user.slice\n"), None);
    }

    #[test]
    fn scopes_that_are_off_are_checked_again_after_a_while() {
        let at = Instant::now();
        let off = Probed {
            scope: None,
            at,
            checking: false,
        };
        assert!(!off.due(at + RECHECK - Duration::from_secs(1)));
        assert!(off.due(at + RECHECK));
        let checking = Probed {
            checking: true,
            ..off
        };
        assert!(!checking.due(at + RECHECK));
        let on = Probed {
            scope: Some(scope(None)),
            at,
            checking: false,
        };
        assert!(
            !on.due(at + RECHECK * 2),
            "a working scope isn't probed again"
        );
    }

    /// A stand-in `systemd-run` running `body`, and a claude that prints whether it ran in the stand-in's scope.
    #[cfg(target_os = "linux")]
    fn fakes(body: &str) -> (tempfile::TempDir, Scope, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let script = |name: &str, text: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{text}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let program = script("systemd-run", body);
        let claude = script("claude", "echo \"scoped=${IN_SCOPE:-no} $*\"");
        // The stand-in execs claude itself, so it can't retry through ETXTBSY as `run` does: claude runs once first.
        // Only a fork made while claude's write fd was open can hold it, so once an exec gets through none is left.
        let ran = (0..1000).find_map(|_| match Command::new(&claude).output() {
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                std::thread::yield_now();
                None
            }
            other => Some(other.unwrap()),
        });
        assert!(
            ran.expect("the stand-in claude stayed busy")
                .status
                .success()
        );
        let scope = Scope {
            program,
            node_unit: None,
            oom_continue: true,
            env: Vec::new(),
        };
        (dir, scope, claude)
    }

    #[cfg(target_os = "linux")]
    async fn run(scope: &Scope, claude: &Path, timeout: Duration) -> (String, Option<String>) {
        let build = |program: PathBuf, args: Vec<String>, _: Option<&Scope>| {
            let mut cmd = tokio::process::Command::new(program);
            cmd.args(args).stdout(Stdio::piped()).kill_on_drop(true);
            cmd
        };
        // Retried through ETXTBSY: a test that forks while these scripts' write fds are still open holds them until
        // its child execs, and a file open for writing can't be exec'd. A test-harness race, not the node's.
        let mut spawned = None;
        for _ in 0..1000 {
            match spawn_within(Some(scope), claude, vec!["-p".into()], "s1", build, timeout) {
                Err(e) if e.to_string().contains("Text file busy") => std::thread::yield_now(),
                other => {
                    spawned = Some(other.unwrap());
                    break;
                }
            }
        }
        let (child, failed) = spawned.expect("the stand-in scripts stayed busy");
        let out = child.wait_with_output().await.unwrap();
        (
            String::from_utf8_lossy(&out.stdout).trim().to_owned(),
            failed,
        )
    }

    #[test]
    fn a_child_still_named_after_its_spawner_has_not_been_handed_over() {
        // Right after the spawn, before systemd-run's exec renamed it.
        assert!(!handed_over(
            "tokio-runtime-w\n",
            "systemd-run",
            "tokio-runtime-w\n"
        ));
        assert!(!handed_over(
            "systemd-run\n",
            "systemd-run",
            "tokio-runtime-w\n"
        ));
        assert!(!handed_over("", "systemd-run", "tokio-runtime-w\n"));
        // claude, or what claude's launcher execs next.
        assert!(handed_over("claude\n", "systemd-run", "tokio-runtime-w\n"));
        assert!(handed_over("node\n", "systemd-run", "tokio-runtime-w\n"));
    }

    // They watch the child through /proc, as only Linux, where scopes exist, needs to.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_session_starts_in_its_scope_when_systemd_run_execs_it() {
        let exec = "while [ \"$1\" != -- ]; do shift; done; shift; IN_SCOPE=yes exec \"$@\"";
        let (_dir, scope, claude) = fakes(exec);
        assert_eq!(
            run(&scope, &claude, START_TIMEOUT).await,
            ("scoped=yes -p".to_owned(), None)
        );
    }

    // They watch the child through /proc, as only Linux, where scopes exist, needs to.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_scope_that_fails_never_fails_the_session() {
        // The user manager went away.
        let (_dir, scope, claude) = fakes("echo 'Failed to connect to bus' >&2; exit 1");
        let (out, failed) = run(&scope, &claude, START_TIMEOUT).await;
        assert_eq!(out, "scoped=no -p");
        assert_eq!(failed.as_deref(), Some("systemd-run exit status: 1"));
        // Hung on the bus: killed at the timeout.
        let (_dir, scope, claude) = fakes("while :; do sleep 0.05; done");
        let (out, failed) = run(&scope, &claude, Duration::from_millis(200)).await;
        assert_eq!(out, "scoped=no -p");
        assert!(failed.unwrap().contains("had not started the session"));
        // Gone from disk.
        let (_dir, mut scope, claude) = fakes("exit 0");
        scope.program = PathBuf::from("/nonexistent/systemd-run");
        let (out, failed) = run(&scope, &claude, START_TIMEOUT).await;
        assert_eq!(out, "scoped=no -p");
        assert!(failed.unwrap().starts_with("systemd-run could not be run"));
    }
}
