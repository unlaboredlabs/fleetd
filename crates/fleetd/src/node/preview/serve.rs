//! A preview's app, running: the project's start command with `sh -c` in the preview's worktree, in a process group of
//! its own so ending it ends whatever it started, its output in a log beside the worktree for a failure's note, and
//! the ready check that asks it until it answers.
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::process::{Child, Command};

use super::super::util::tail_utf16;

/// How much of the log a failure's note keeps.
const LOG_TAIL: usize = 4000;
/// How long the app gets to end on SIGTERM before SIGKILL.
const TERM_WAIT: Duration = Duration::from_secs(5);

/// The app, while it runs. Dropping it kills its process group.
pub struct Server {
    child: Child,
    group: Option<Pid>,
    log: PathBuf,
    pid_file: PathBuf,
    pub port: u16,
}

/// A port on 127.0.0.1 nothing listens on now, for the app's `$PORT`.
pub fn free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

impl Server {
    /// Starts `command` in `cwd` with `env` (plus `PORT` and `HOST`), its output going to `log`, and records its
    /// group in `pid_file` so a node that restarts can end it.
    pub fn start(
        command: &str,
        cwd: &Path,
        env: &[(String, String)],
        port: u16,
        log: &Path,
        pid_file: &Path,
    ) -> std::io::Result<Self> {
        let out = File::create(log)?;
        let err = out.try_clone()?;
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(command)
            .current_dir(cwd)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .env("PORT", port.to_string())
            .env("HOST", "127.0.0.1")
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .process_group(0)
            .kill_on_drop(true);
        let child = cmd.spawn()?;
        let group = child.id().map(|pid| Pid::from_raw(pid as i32));
        if let Some(group) = group {
            std::fs::write(pid_file, group.as_raw().to_string())?;
        }
        Ok(Self {
            child,
            group,
            log: log.to_owned(),
            pid_file: pid_file.to_owned(),
            port,
        })
    }

    /// Whether it ended by itself.
    pub fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    /// The end of what it printed, masked by `scrub`.
    pub fn log_tail(&self, scrub: &[String]) -> String {
        let text = std::fs::read_to_string(&self.log).unwrap_or_default();
        let text = super::super::cmd::scrub_values(&text, scrub);
        tail_utf16(text.trim_end(), LOG_TAIL).to_owned()
    }

    /// Whether its log says its port was taken ("Address already in use", Node's EADDRINUSE).
    pub fn port_taken(&self) -> bool {
        let log = std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .to_lowercase();
        log.contains("address already in use") || log.contains("eaddrinuse")
    }

    /// Asks `127.0.0.1:port{path}` until it answers 2xx or 3xx (true), the app ends, or `within` passes (false).
    pub async fn wait_ready(&mut self, path: &str, within: Duration) -> bool {
        let url = format!("http://127.0.0.1:{}{path}", self.port);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .expect("a plain HTTP client");
        let until = Instant::now() + within;
        while Instant::now() < until {
            if self.exited() {
                return false;
            }
            if let Ok(answer) = client.get(&url).send().await {
                let status = answer.status();
                if status.is_success() || status.is_redirection() {
                    return true;
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        false
    }

    /// Ends it: SIGTERM to its group, then SIGKILL after a few seconds. Its pid file goes.
    pub async fn stop(mut self) {
        if let Some(group) = self.group.take() {
            let _ = killpg(group, Signal::SIGTERM);
            if tokio::time::timeout(TERM_WAIT, self.child.wait())
                .await
                .is_err()
            {
                let _ = killpg(group, Signal::SIGKILL);
                let _ = self.child.wait().await;
            }
            // Whatever it started that outlived it.
            let _ = killpg(group, Signal::SIGKILL);
        }
        let _ = std::fs::remove_file(&self.pid_file);
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(group) = self.group {
            let _ = killpg(group, Signal::SIGKILL);
            let _ = std::fs::remove_file(&self.pid_file);
        }
    }
}

/// Ends an app a node that stopped left running, from the process group its pid file names: every member of that
/// group, whether or not its leader (the `sh` the start command ran in) is still there. Only a group one of whose
/// members still runs in `cwd`, the slot, so a group number the system gave to something else since is never hit.
pub fn reap(pid_file: &Path, cwd: &Path) {
    let group = std::fs::read_to_string(pid_file)
        .ok()
        .and_then(|s| s.trim().parse::<i32>().ok());
    if let Some(group) = group.filter(|g| *g > 1) {
        let slot = cwd.canonicalize().unwrap_or_else(|_| cwd.to_owned());
        let ours = group_members(group)
            .into_iter()
            .any(|pid| cwd_of(pid).is_some_and(|dir| dir.starts_with(&slot)));
        if ours {
            let _ = killpg(Pid::from_raw(group), Signal::SIGKILL);
            tracing::info!(group, "ended a preview a stopped node left running");
        }
    }
    let _ = std::fs::remove_file(pid_file);
}

/// The processes in process group `group`, from `ps` (Linux and macOS alike).
fn group_members(group: i32) -> Vec<i32> {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,pgid="])
        .stdin(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace().map(|f| f.parse::<i32>().ok());
            match (fields.next().flatten(), fields.next().flatten()) {
                (Some(pid), Some(pgid)) if pgid == group => Some(pid),
                _ => None,
            }
        })
        .collect()
}

/// Where a process runs: /proc on Linux, lsof elsewhere (macOS has no /proc).
fn cwd_of(pid: i32) -> Option<PathBuf> {
    if cfg!(target_os = "linux") {
        return std::fs::read_link(format!("/proc/{pid}/cwd")).ok();
    }
    let out = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n'))
        .map(PathBuf::from)
}
