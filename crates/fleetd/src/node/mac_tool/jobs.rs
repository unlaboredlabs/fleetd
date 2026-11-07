//! `mac run`'s jobs on the agents' Mac: a command line run by the shell in the agent's folder, in a process group of
//! its own, its stdout and stderr together in `jobs/<n>.log` with the values of the variables the agent named masked.
//! A job in the foreground ends once nobody has followed it for [`FOREGROUND_IDLE`] (its `fleetd mac` was stopped);
//! one in the background runs until it ends or `mac kill` ends it.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::mac::{MacEnv, MacJob};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

use super::host::Agent;
use super::{Done, LOGS_MAX, now_ms};
use crate::node::agents_mac::checks::HOMEBREW_BINS;
use crate::node::mask::Masker;

/// A foreground job nobody asked for output of in this long ends.
pub const FOREGROUND_IDLE: Duration = Duration::from_secs(60);
/// How long a `logs` step waits for more output while its job runs.
pub const LOGS_WAIT: Duration = Duration::from_secs(10);
/// Jobs an agent may have running at once.
pub const RUNNING_MAX: usize = 16;
/// How long a killed job has between SIGTERM and SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(5);

/// The variables a job keeps from the node's own environment; every other is left out.
const KEPT: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "DEVELOPER_DIR",
];

struct Job {
    command: String,
    background: bool,
    started_ms: i64,
    pgid: i32,
    log: PathBuf,
    exit: watch::Receiver<Option<i32>>,
    followed: Instant,
}

#[derive(Default)]
struct AgentJobs {
    next: u32,
    jobs: HashMap<u32, Job>,
}

#[derive(Clone)]
pub struct Jobs {
    cache: PathBuf,
    all: Arc<Mutex<HashMap<String, AgentJobs>>>,
}

fn failed(what: &str, e: impl std::fmt::Display) -> McpToolError {
    McpToolError::new(ErrorCode::Failed, format!("{what}: {e}"))
}

/// The shell and its arguments for a command line, as ssh runs one: the words joined by spaces.
pub fn shell_line(args: &[String]) -> (String, Vec<String>) {
    let line = args.join(" ");
    if Path::new("/bin/zsh").exists() {
        ("/bin/zsh".into(), vec!["-lc".into(), line])
    } else {
        ("/bin/sh".into(), vec!["-c".into(), line])
    }
}

/// The simulator an agent holds, for its jobs: the node's home, its key in agent-device's wrapper, and its udid.
pub struct SimEnv {
    pub home: PathBuf,
    pub key: String,
    pub udid: String,
}

/// A job's environment: [`KEPT`] from the node's, the agent's folders, and the variables it named.
pub fn job_env(
    agent: &Agent,
    cache: &Path,
    named: &[MacEnv],
    node: impl Iterator<Item = (String, String)>,
    device: Option<&SimEnv>,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = node.filter(|(k, _)| KEPT.contains(&k.as_str())).collect();
    let path = env
        .iter()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    env.retain(|(k, _)| k != "PATH");
    // Homebrew's commands last, CocoaPods' among them (agents_mac/checks.rs): a launchd service's PATH has none.
    let brew: String = HOMEBREW_BINS
        .iter()
        .filter(|bin| !path.split(':').any(|p| p == **bin))
        .map(|bin| format!(":{bin}"))
        .collect();
    // CocoaPods refuses to run outside UTF-8, and a launchd service gets no LANG.
    if !env.iter().any(|(k, _)| k == "LANG") {
        env.push(("LANG".to_owned(), "en_US.UTF-8".to_owned()));
    }
    let dir = |sub: &str| agent.dir.join(sub).to_string_lossy().into_owned();
    env.extend([
        ("PATH".to_owned(), format!("{}:{path}{brew}", dir("bin"))),
        ("TMPDIR".to_owned(), dir("tmp")),
        (
            "FLEETD_MAC_DIR".to_owned(),
            agent.dir.to_string_lossy().into_owned(),
        ),
        ("FLEETD_MAC_REPO".to_owned(), dir("repo")),
        ("FLEETD_MAC_DERIVED_DATA".to_owned(), dir("DerivedData")),
        (
            "FLEETD_MAC_CACHE".to_owned(),
            cache.to_string_lossy().into_owned(),
        ),
        // Manners, not a fence: the Mac's node takes no calls from its jobs.
        ("FLEETD_NODE_SOCK".to_owned(), "/dev/null".to_owned()),
    ]);
    // The agent's simulator: agent-device's wrapper first on the PATH, pointed at it, and for plain simctl its udid
    // and the node's device set (`xcrun simctl --set "$FLEETD_MAC_SIM_SET" install "$FLEETD_MAC_SIM" <app>`).
    if let Some(SimEnv { home, key, udid }) = device {
        let path = env
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.clone());
        let wrapper = crate::node::device::ios::wrapper::env(home, key, path.as_deref());
        env.retain(|(k, _)| !wrapper.iter().any(|(w, _)| w == k));
        env.extend(wrapper);
        env.extend([
            ("FLEETD_MAC_SIM".to_owned(), udid.clone()),
            (
                "FLEETD_MAC_SIM_SET".to_owned(),
                crate::node::device::ios::set_dir(home)
                    .to_string_lossy()
                    .into_owned(),
            ),
        ]);
    }
    for MacEnv { name, value } in named {
        env.retain(|(k, _)| k != name);
        env.push((name.clone(), value.clone()));
    }
    env
}

impl Jobs {
    pub fn new(cache: PathBuf) -> Self {
        Self {
            cache,
            all: Arc::default(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, AgentJobs>> {
        self.all.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub async fn start(
        &self,
        agent: &Agent,
        args: &[String],
        named: &[MacEnv],
        background: bool,
        device: Option<SimEnv>,
    ) -> Result<Done, McpToolError> {
        if args.iter().all(|a| a.trim().is_empty()) {
            return Err(
                McpToolError::new(ErrorCode::Invalid, "mac run needs a command")
                    .with_fix("mac run -- <command line>"),
            );
        }
        let running = self.lock().get(&agent.name).map_or(0, |a| {
            a.jobs
                .values()
                .filter(|j| j.exit.borrow().is_none())
                .count()
        });
        if running >= RUNNING_MAX {
            return Err(McpToolError::new(
                ErrorCode::Invalid,
                format!("you have {running} jobs running on the Mac, the most at once"),
            )
            .with_fix("end some with mac kill (mac ps lists them)"));
        }
        std::fs::create_dir_all(&self.cache)
            .map_err(|e| failed("the shared cache was not made", e))?;
        let job = {
            let mut all = self.lock();
            let mine = all.entry(agent.name.clone()).or_default();
            mine.next += 1;
            mine.next
        };
        let log = agent.dir.join("jobs").join(format!("{job}.log"));
        let (shell, shell_args) = shell_line(args);
        let cwd = if agent.repo().is_dir() {
            agent.repo()
        } else {
            agent.dir.clone()
        };
        let mut command = tokio::process::Command::new(shell);
        command
            .args(shell_args)
            .current_dir(cwd)
            .env_clear()
            .envs(job_env(
                agent,
                &self.cache,
                named,
                std::env::vars(),
                device.as_ref(),
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = command
            .spawn()
            .map_err(|e| failed("the command didn't start on the Mac", e))?;
        let pgid = child.id().map_or(0, |p| p as i32);
        let masker = Arc::new(Masker::new(
            &named
                .iter()
                .map(|e| (e.name.clone(), e.value.clone()))
                .collect::<Vec<_>>(),
        ));
        let file = tokio::fs::File::create(&log)
            .await
            .map_err(|e| failed("the job's log was not made", e))?;
        let file = Arc::new(tokio::sync::Mutex::new(file));
        let out = child
            .stdout
            .take()
            .map(|o| copy(o, file.clone(), masker.clone()));
        let err = child
            .stderr
            .take()
            .map(|e| copy(e, file.clone(), masker.clone()));
        let (exit_tx, exit) = watch::channel(None);
        tokio::spawn(async move {
            if let Some(out) = out {
                let _ = out.await;
            }
            if let Some(err) = err {
                let _ = err.await;
            }
            let code = match child.wait().await {
                Ok(status) => {
                    use std::os::unix::process::ExitStatusExt;
                    status
                        .code()
                        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
                }
                Err(_) => 1,
            };
            let _ = exit_tx.send(Some(code));
        });
        self.lock()
            .entry(agent.name.clone())
            .or_default()
            .jobs
            .insert(
                job,
                Job {
                    command: masker.text(&args.join(" ")).into_owned(),
                    background,
                    started_ms: now_ms(),
                    pgid,
                    log,
                    exit,
                    followed: Instant::now(),
                },
            );
        if !background {
            let jobs = self.clone();
            let name = agent.name.clone();
            tokio::spawn(async move { jobs.end_unfollowed(&name, job).await });
        }
        Ok(Done::Run { job })
    }

    /// Ends the foreground job once nobody has followed it for [`FOREGROUND_IDLE`].
    async fn end_unfollowed(&self, agent: &str, job: u32) {
        loop {
            let state = {
                let all = self.lock();
                all.get(agent)
                    .and_then(|a| a.jobs.get(&job))
                    .map(|j| (j.exit.clone(), j.followed))
            };
            let Some((mut exit, followed)) = state else {
                return;
            };
            let left = FOREGROUND_IDLE.saturating_sub(followed.elapsed());
            if left.is_zero() {
                tracing::info!(
                    agent,
                    job,
                    "a foreground job on the Mac nobody followed ends"
                );
                self.kill(agent, job);
                return;
            }
            if tokio::time::timeout(left, exit.wait_for(|e| e.is_some()))
                .await
                .is_ok()
            {
                return;
            }
        }
    }

    /// Output from `offset`, waiting up to [`LOGS_WAIT`] for some while the job runs.
    pub async fn logs(&self, agent: &str, job: u32, offset: u64) -> Result<Done, McpToolError> {
        let (log, mut exit) = {
            let mut all = self.lock();
            let j = all
                .get_mut(agent)
                .and_then(|a| a.jobs.get_mut(&job))
                .ok_or_else(|| no_job(job))?;
            j.followed = Instant::now();
            (j.log.clone(), j.exit.clone())
        };
        let deadline = Instant::now() + LOGS_WAIT;
        loop {
            let ended = *exit.borrow();
            let size = tokio::fs::metadata(&log)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
            if size > offset || ended.is_some() || Instant::now() >= deadline {
                let data = read_from(&log, offset).await?;
                let next = offset + data.len() as u64;
                let done = ended.is_some() && next >= size;
                return Ok(Done::Logs {
                    data_b64: B64.encode(&data),
                    offset: next,
                    done,
                    exit_code: if done { ended } else { None },
                });
            }
            let _ = tokio::time::timeout(Duration::from_millis(200), exit.changed()).await;
        }
    }

    pub fn list(&self, agent: &str) -> Vec<MacJob> {
        let all = self.lock();
        let mut jobs: Vec<MacJob> = all
            .get(agent)
            .map(|a| {
                a.jobs
                    .iter()
                    .map(|(n, j)| {
                        let exit = *j.exit.borrow();
                        MacJob {
                            job: *n,
                            command: j.command.clone(),
                            background: j.background,
                            running: exit.is_none(),
                            exit_code: exit,
                            started_ms: j.started_ms,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        jobs.sort_by_key(|j| j.job);
        jobs
    }

    /// SIGTERM to the job's process group, SIGKILL after [`KILL_GRACE`]; false when it wasn't running.
    pub fn kill(&self, agent: &str, job: u32) -> bool {
        let state = {
            let all = self.lock();
            all.get(agent)
                .and_then(|a| a.jobs.get(&job))
                .filter(|j| j.exit.borrow().is_none() && j.pgid > 0)
                .map(|j| (j.pgid, j.exit.clone()))
        };
        let Some((pgid, mut exit)) = state else {
            return false;
        };
        let group = nix::unistd::Pid::from_raw(pgid);
        let _ = nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGTERM);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if tokio::time::timeout(KILL_GRACE, exit.wait_for(|e| e.is_some()))
                    .await
                    .is_err()
                {
                    let _ = nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGKILL);
                }
            });
        }
        true
    }
}

fn no_job(job: u32) -> McpToolError {
    McpToolError::new(
        ErrorCode::NotFound,
        format!("You have no job {job} on the Mac."),
    )
    .with_fix("mac ps lists your jobs; the Mac drops them when its node restarts")
}

async fn read_from(log: &Path, offset: u64) -> Result<Vec<u8>, McpToolError> {
    use tokio::io::AsyncSeekExt;
    let mut file = tokio::fs::File::open(log)
        .await
        .map_err(|e| failed("the job's log can't be read", e))?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|e| failed("the job's log can't be read", e))?;
    let mut data = Vec::new();
    file.take(LOGS_MAX as u64)
        .read_to_end(&mut data)
        .await
        .map_err(|e| failed("the job's log can't be read", e))?;
    Ok(data)
}

/// Copies a pipe into the log a line at a time (or [`LOGS_MAX`] at most), masked, so a value never lands split.
fn copy(
    mut from: impl AsyncRead + Unpin + Send + 'static,
    to: Arc<tokio::sync::Mutex<tokio::fs::File>>,
    masker: Arc<Masker>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut pending: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 16 << 10];
        loop {
            let n = from.read(&mut chunk).await.unwrap_or(0);
            if n > 0 {
                pending.extend_from_slice(&chunk[..n]);
            }
            let cut = if n == 0 {
                pending.len()
            } else {
                match pending.iter().rposition(|&b| b == b'\n') {
                    Some(i) => i + 1,
                    None if pending.len() >= LOGS_MAX => pending.len(),
                    None => 0,
                }
            };
            if cut > 0 {
                let line: Vec<u8> = pending.drain(..cut).collect();
                let text = String::from_utf8_lossy(&line);
                let masked = masker.text(&text);
                let _ = to.lock().await.write_all(masked.as_bytes()).await;
            }
            if n == 0 {
                return;
            }
        }
    })
}
