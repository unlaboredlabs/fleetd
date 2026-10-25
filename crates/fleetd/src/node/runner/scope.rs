//! Each session's process tree in a transient systemd scope of its own, on Linux when the user's systemd manager
//! answers. Memory then runs out inside one agent: the kernel's or systemd-oomd's kill lands in that agent's scope, and
//! systemd stops that scope, not the node's service. Before, every agent shared the node's cgroup, so one agent's
//! build that the kernel killed made systemd fail the whole unit (`Failed with result 'oom-kill'`) and every agent on
//! the machine with it. Now the node sees that one claude exit like any other crash, and the hub resumes it.
//!
//! `systemd-run --scope` moves itself into the new scope and then execs the command, so claude keeps the pid, the
//! process group and the pipes the node gave it, and sweeps find its tree as before. Without a user manager (macOS, a
//! container, a node started by hand outside a login session) sessions start as before, in the node's own cgroup.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// systemd-run reaches the user manager through these, and a session's environment starts empty.
const BUS_VARS: [&str; 2] = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
/// How long the one probe may take before the node gives up on scopes.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// How to start a session in a scope of its own on this machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    /// `systemd-run`, as found on the node's PATH.
    pub program: PathBuf,
    /// The node's own unit when it runs as one (`fleetd-node.service`). Each scope is `PartOf=` it, so stopping or
    /// restarting the node still stops its agents, as when they shared its cgroup.
    pub part_of: Option<String>,
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
        if let Some(unit) = &self.part_of {
            args.push(format!("--property=PartOf={unit}"));
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

/// This machine's way to scope sessions, probed once per node: `systemd-run --user --scope` must actually start a
/// command, so a machine without a reachable user manager falls back without a word. Blocking on the first call.
pub fn current() -> Option<&'static Scope> {
    static SCOPE: OnceLock<Option<Scope>> = OnceLock::new();
    SCOPE.get_or_init(probe).as_ref()
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
    let part_of = std::fs::read_to_string("/proc/self/cgroup")
        .ok()
        .and_then(|c| own_unit(&c));
    // An older systemd may refuse a dependency in a transient unit; a scope without it still keeps the node alive.
    let tries = match part_of {
        Some(unit) => vec![Some(unit), None],
        None => vec![None],
    };
    let found = tries
        .into_iter()
        .map(|part_of| Scope {
            program: program.clone(),
            part_of,
            env: env.clone(),
        })
        .find(starts);
    match &found {
        Some(scope) => {
            tracing::info!(part_of = ?scope.part_of, "each session runs in a systemd scope of its own")
        }
        None => tracing::info!(
            "no systemd user manager answered; sessions run in the node's own cgroup"
        ),
    }
    found
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
    use super::*;

    fn scope(part_of: Option<&str>) -> Scope {
        Scope {
            program: "/usr/bin/systemd-run".into(),
            part_of: part_of.map(str::to_owned),
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
                "--property=PartOf=fleetd-node.service",
                "--",
                "/opt/claude",
                "-p",
                "--verbose",
            ]
        );
        // A node started by hand has no unit to tie the scope to.
        let (_, args) = command(
            Path::new("/opt/claude"),
            Vec::new(),
            Some(&scope(None)),
            "s1",
        );
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
}
