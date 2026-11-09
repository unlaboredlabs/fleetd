//! The agents' Mac's half: each step an agent's node sealed to this machine is opened, checked (the session the hub
//! names, its clock, a nonce taken once) and run in the agent's own folder under `root` (`~/work/<task>`):
//!
//! - `repo/`, the agent's worktree as its last `mac push` left it: a checkout of the project's mirror
//!   (`~/work/.mirrors/<project>.git`), which holds every push's snapshot so the next one sends only what changed;
//! - `DerivedData/`, which `xcodebuild` there builds into (`bin/xcodebuild`), and `tmp/`;
//! - `jobs/`, each `mac run`'s output.
//!
//! Every agent shares `~/work/.cache` and the agents user's own caches. A folder nothing touched for
//! [`FOLDER_DAYS`] goes, with its snapshot in the mirror.
use std::collections::HashMap;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::mac::{MacCallFrame, MacCaller, MacResultFrame};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::prim::NonEmpty;

use super::jobs::Jobs;
use super::queue::{Queue, Turn};
use super::{
    Answer, Done, Envelope, MacToolConfig, PIECE, PULL_MAX, PUSH_MAX, SKEW_MS, Step, now_ms,
    safe_part, seal_answer, split_raw,
};
use crate::node::identity::NodeBoxKey;

/// An agent's folder nothing touched for this long goes.
pub const FOLDER_DAYS: u64 = 3;
/// How often the Mac looks for such folders.
const SWEEP_EVERY: Duration = Duration::from_secs(6 * 3600);
/// A simulator its agent sent no step for in this long ends.
pub const SIM_IDLE: Duration = Duration::from_secs(30 * 60);
/// How often the Mac looks for those.
const SIM_CHECK: Duration = Duration::from_secs(60);
/// The most snapshots `have` names: the newest.
const HAVE_MAX: usize = 50;

/// What `xcodebuild` is in each agent's `bin/`: the build actions get the agent's own DerivedData unless they name one.
const XCODEBUILD: &str = r#"#!/bin/sh
# fleetd: each agent's builds keep their own DerivedData on the agents' Mac ($FLEETD_MAC_DERIVED_DATA).
for a in "$@"; do
  case "$a" in -derivedDataPath) exec /usr/bin/xcodebuild "$@" ;; esac
done
for a in "$@"; do
  case "$a" in
    build|build-for-testing|test|test-without-building|analyze|archive|clean|docbuild|-resolvePackageDependencies|-showBuildSettings)
      exec /usr/bin/xcodebuild "$@" -derivedDataPath "$FLEETD_MAC_DERIVED_DATA" ;;
  esac
done
exec /usr/bin/xcodebuild "$@"
"#;

fn refuse(message: impl Into<String>) -> McpToolError {
    McpToolError::new(ErrorCode::Invalid, message)
}

fn failed(what: &str, e: impl std::fmt::Display) -> McpToolError {
    McpToolError::new(ErrorCode::Failed, format!("{what}: {e}"))
}

pub struct Host {
    pub config: MacToolConfig,
    key: NodeBoxKey,
    root: PathBuf,
    /// Nonces taken within [`SKEW_MS`], with when.
    seen: Mutex<HashMap<String, i64>>,
    pub jobs: Jobs,
    sims: Option<Sims>,
}

/// The Mac's iOS simulators, lent to agents (`mac sim`).
pub struct Sims {
    /// The node's home: agent-device's wrapper and each lent clone's config.
    pub home: PathBuf,
    pub simulators: Arc<crate::node::device::ios::Simulators>,
    held: Mutex<HashMap<String, Held>>,
    /// The agents waiting for one, in the order they asked (locked after `held`).
    queue: Mutex<Queue>,
}

impl Sims {
    pub fn new(home: PathBuf, simulators: Arc<crate::node::device::ios::Simulators>) -> Self {
        Self {
            home,
            simulators,
            held: Mutex::default(),
            queue: Mutex::default(),
        }
    }

    fn queue(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct Held {
    lent: crate::node::device::ios::pool::Lent,
    device: String,
    project: String,
    since_ms: i64,
    used: Instant,
}

/// What an agent's simulator goes by in agent-device's wrapper (its config, under the node's `sessions/`).
pub fn sim_key(agent: &str) -> String {
    format!("mac-{agent}")
}

/// One agent's folder.
pub struct Agent {
    pub dir: PathBuf,
    pub project: String,
    pub name: String,
}

impl Agent {
    pub fn repo(&self) -> PathBuf {
        self.dir.join("repo")
    }
}

impl Host {
    /// The host, sweeping old folders now and every [`SWEEP_EVERY`], and ending simulators nobody used for
    /// [`SIM_IDLE`], while the node runs. What agents do on the Mac goes to `home`'s activity file (activity.rs).
    pub fn start(
        config: MacToolConfig,
        key: NodeBoxKey,
        root: PathBuf,
        sims: Option<Sims>,
        home: PathBuf,
    ) -> Arc<Self> {
        let mut host = Self::new(config, key, root);
        host.sims = sims;
        let host = Arc::new(host);
        let weak = Arc::downgrade(&host);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let writer = weak.clone();
            runtime.spawn(async move {
                let mut last = None;
                loop {
                    let Some(host) = writer.upgrade() else { return };
                    let now = host.activity();
                    drop(host);
                    super::activity::write(&home, &now, &mut last);
                    tokio::time::sleep(super::activity::EVERY).await;
                }
            });
            runtime.spawn(async move {
                let mut swept: Option<Instant> = None;
                loop {
                    let Some(host) = weak.upgrade() else { return };
                    host.end_idle_sims(SIM_IDLE);
                    if swept.is_none_or(|s| s.elapsed() >= SWEEP_EVERY) {
                        swept = Some(Instant::now());
                        let root = host.root.clone();
                        let _ =
                            tokio::task::spawn_blocking(move || sweep(&root, FOLDER_DAYS)).await;
                    }
                    drop(host);
                    tokio::time::sleep(SIM_CHECK).await;
                }
            });
        }
        host
    }

    pub fn new(config: MacToolConfig, key: NodeBoxKey, root: PathBuf) -> Self {
        Self {
            config,
            key,
            jobs: Jobs::new(root.join(".cache")),
            root,
            seen: Mutex::default(),
            sims: None,
        }
    }

    /// How many simulators agents may hold at once: the setting, else from the Mac's memory.
    pub fn sim_budget(&self) -> u32 {
        self.config
            .simulators
            .unwrap_or_else(|| super::sim_budget(super::mem_bytes()))
            .max(1)
    }

    fn held(&self) -> Option<std::sync::MutexGuard<'_, HashMap<String, Held>>> {
        self.sims
            .as_ref()
            .map(|s| s.held.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// The agent's simulator: its own again while it holds one, else within the budget a clone from the warm pool, or
    /// with `device` a simulator of that device type (`mac sim start --device`). Simulators go to agents in the order
    /// they asked ([`super::queue`]): one that `wait`s and isn't first, or finds none free, hears its place in line;
    /// one that doesn't wait is told why there is none, as before the line.
    async fn sim_start(
        &self,
        agent: &Agent,
        device: Option<&str>,
        wait: bool,
    ) -> Result<Done, McpToolError> {
        let sims = self.sims.as_ref().ok_or_else(|| {
            McpToolError::new(
                ErrorCode::Failed,
                "The agents' Mac has no iOS simulators: its golden simulator isn't made.",
            )
            .with_fix("do without a simulator and say so; an admin finishes the Mac's setup in Settings › Hub › Machines")
        })?;
        // Developer Mode off: the clone's XCTest runner would wait on a password prompt at the Mac's screen, and the
        // agent's installs and launches hang behind it.
        if let Some(check) = crate::node::agents_mac::checks::blocks_simulators(&sims.home) {
            sims.queue().leave(&agent.name);
            let command = check.command.as_ref().map_or("", |c| c.as_str());
            return Err(McpToolError::new(
                ErrorCode::Failed,
                format!("The agents' Mac can't run iOS simulators yet: {}", check.message.as_str()),
            )
            .with_fix(format!(
                "do without a simulator and tell your lead: an admin runs `{command}` in Terminal at the Mac, \
                 then mac sim start works"
            )));
        }
        {
            let mut held = sims.held.lock().unwrap_or_else(|e| e.into_inner());
            let mut queue = sims.queue();
            if let Some(h) = held.get_mut(&agent.name) {
                queue.leave(&agent.name);
                return held_again(h, device);
            }
            let budget = self.sim_budget() as usize;
            let in_use = held.len();
            match queue.turn(&agent.name, wait, in_use, budget, Instant::now()) {
                Turn::Now => {}
                Turn::Wait { full: true, .. } if !wait => {
                    return Err(McpToolError::new(
                        ErrorCode::Failed,
                        format!(
                            "All {budget} of the Mac's iOS simulators are in use by other agents."
                        ),
                    )
                    .with_fix(
                        "mac sim start without --no-wait waits its turn, or carry on without one",
                    ));
                }
                Turn::Wait { place, .. } if !wait => {
                    return Err(McpToolError::new(
                        ErrorCode::Failed,
                        format!(
                            "{} agents are waiting for the Mac's iOS simulators, and get theirs first.",
                            place - 1
                        ),
                    )
                    .with_fix("mac sim start without --no-wait waits its turn, or carry on without one"));
                }
                Turn::Wait { place, full } => {
                    let free = budget.saturating_sub(in_use);
                    return Ok(Done::SimQueued {
                        place: place as u32,
                        secs: (!full && place <= free)
                            .then(|| sims.simulators.ready_in(place))
                            .flatten(),
                        why: if full {
                            format!(
                                "all {budget} of the Mac's iOS simulators are in use by other agents"
                            )
                        } else {
                            "the agents ahead of you get theirs first".to_owned()
                        },
                    });
                }
            }
        }
        let lent = match device {
            Some(wanted) => sims.simulators.lend_type(wanted).await,
            None => sims.simulators.lend_or_wait(),
        };
        let (lent, device) = match lent {
            Ok(Ok(lent)) => lent,
            // First in line, and the pool is booting the clone that is the agent's.
            Ok(Err(waiting)) if wait && waiting.retry_in.is_none() => {
                return Ok(Done::SimQueued {
                    place: 1,
                    secs: Some(waiting.secs),
                    why: match waiting.failing {
                        None => "yours is booting".to_owned(),
                        Some(why) => {
                            format!("the last boot failed ({why}); yours is booting again")
                        }
                    },
                });
            }
            Ok(Err(waiting)) => {
                if wait {
                    sims.queue().leave(&agent.name);
                }
                return Err(crate::node::device::ios::sim_waiting(&waiting));
            }
            Err(error) => {
                sims.queue().leave(&agent.name);
                return Err(error);
            }
        };
        let mut held = sims.held.lock().unwrap_or_else(|e| e.into_inner());
        sims.queue().leave(&agent.name);
        // Another `mac sim start` of the agent's got one meanwhile: that one stays, this goes (dropped: deleted).
        if let Some(h) = held.get_mut(&agent.name) {
            return held_again(h, None);
        }
        let key = sim_key(&agent.name);
        let own = lent.home.join("config.json").is_file();
        crate::node::device::ios::wrapper::write_config(
            &sims.home,
            &key,
            &lent.udid,
            own.then_some(lent.home.as_path()),
        )
        .map_err(|e| failed("agent-device wasn't pointed at the simulator", e))?;
        let udid = lent.udid.clone();
        tracing::info!(agent = %agent.name, %udid, %device, "a simulator lent to an agent");
        held.insert(
            agent.name.clone(),
            Held {
                lent,
                device: device.clone(),
                project: agent.project.clone(),
                since_ms: super::now_ms(),
                used: Instant::now(),
            },
        );
        Ok(Done::SimStart { udid, device })
    }

    /// The agent's simulator goes: deleted with its clone. Waiting for one, it leaves the line.
    fn sim_end(&self, agent: &str) -> bool {
        let gone = self.held().and_then(|mut h| h.remove(agent));
        if let Some(sims) = &self.sims {
            sims.queue().leave(agent);
        }
        if let (Some(_), Some(sims)) = (&gone, &self.sims) {
            crate::node::device::agent_device::release(&sims.home, &sim_key(agent));
            tracing::info!(agent, "an agent's simulator ended");
        }
        gone.is_some()
    }

    /// What agents do on the Mac now: the simulators they hold and the jobs they run.
    pub fn activity(&self) -> super::activity::Activity {
        let mut simulators: Vec<super::activity::SimActivity> = self
            .held()
            .map(|h| {
                h.iter()
                    .map(|(agent, held)| super::activity::SimActivity {
                        agent: agent.clone(),
                        project_id: held.project.clone(),
                        device: held.device.clone(),
                        since_ms: held.since_ms,
                    })
                    .collect()
            })
            .unwrap_or_default();
        simulators.sort_by(|a, b| (a.since_ms, &a.agent).cmp(&(b.since_ms, &b.agent)));
        super::activity::Activity {
            simulators,
            jobs: self.jobs.running(),
        }
    }

    /// Ends the simulators of agents that sent no step for `idle`.
    pub fn end_idle_sims(&self, idle: Duration) {
        let idle: Vec<String> = self
            .held()
            .map(|h| {
                h.iter()
                    .filter(|(_, held)| held.used.elapsed() >= idle)
                    .map(|(name, _)| name.clone())
                    .collect()
            })
            .unwrap_or_default();
        for agent in idle {
            self.sim_end(&agent);
        }
    }

    /// What points a job's agent-device (and plain simctl) at the agent's simulator, while it holds one.
    fn sim_env(&self, agent: &str) -> Option<super::jobs::SimEnv> {
        let udid = self.held()?.get(agent)?.lent.udid.clone();
        Some(super::jobs::SimEnv {
            home: self.sims.as_ref().expect("held").home.clone(),
            key: sim_key(agent),
            udid,
        })
    }

    /// One sealed step from the hub, answered sealed. An error in clear only when the step didn't open or was refused
    /// before running: it holds nothing of the agent's.
    pub async fn answer(&self, frame: MacCallFrame) -> MacResultFrame {
        let id = frame.id.clone();
        let refused = |error: McpToolError| MacResultFrame {
            id: id.clone(),
            sealed: None,
            error: Some(error),
        };
        let (envelope, raw) = match self.open(&frame.caller, frame.sealed.as_str()) {
            Ok(opened) => opened,
            Err(error) => return refused(error),
        };
        let Some(answer_key) = B64
            .decode(&envelope.answer_key)
            .ok()
            .and_then(|k| <[u8; 32]>::try_from(k).ok())
        else {
            return refused(refuse("the step's answer key is not 32 bytes"));
        };
        let answer_key = zeroize::Zeroizing::new(answer_key);
        let (answer, raw) = match self.agent(&frame.caller) {
            Ok(agent) => match self
                .touch(&agent)
                .step_with(&agent, envelope.step, raw)
                .await
            {
                Ok((done, raw)) => (
                    Answer {
                        done: Some(done),
                        error: None,
                    },
                    raw,
                ),
                Err(error) => (
                    Answer {
                        done: None,
                        error: Some(error),
                    },
                    Vec::new(),
                ),
            },
            Err(error) => (
                Answer {
                    done: None,
                    error: Some(error),
                },
                Vec::new(),
            ),
        };
        MacResultFrame {
            id,
            sealed: Some(NonEmpty::unchecked(seal_answer(&answer_key, &answer, &raw))),
            error: None,
        }
    }

    /// Any step of the agent's keeps its simulator.
    fn touch(&self, agent: &Agent) -> &Self {
        if let Some(h) = self.held().as_mut().and_then(|h| h.get_mut(&agent.name)) {
            h.used = Instant::now();
        }
        self
    }

    /// The step inside and the raw bytes after it, if it was sealed to this Mac for the session the hub names, lately,
    /// and never before.
    fn open(&self, caller: &MacCaller, sealed: &str) -> Result<(Envelope, Vec<u8>), McpToolError> {
        let plain = B64
            .decode(sealed)
            .ok()
            .and_then(|b| self.key.open(&b))
            .ok_or_else(|| refuse("the step was not sealed to this Mac's key"))?;
        let (envelope, raw) = split_raw::<Envelope>(&plain)
            .map_err(|e| refuse(format!("the step doesn't read: {e}")))?;
        let raw = raw.to_vec();
        if envelope.thread != caller.thread_id.as_str() {
            return Err(refuse("the step was sealed for another agent's session"));
        }
        let now = now_ms();
        if (now - envelope.at_ms).abs() > SKEW_MS {
            return Err(
                refuse("the step's clock is more than 5 minutes from the Mac's")
                    .with_fix("check both machines' clocks, then run the command again"),
            );
        }
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        seen.retain(|_, at| now - *at <= 2 * SKEW_MS);
        if seen.insert(envelope.nonce.clone(), now).is_some() {
            return Err(refuse("the step came a second time"));
        }
        Ok((envelope, raw))
    }

    /// The caller's folder, made with its `bin/` the first time: by task, else by session.
    pub fn agent(&self, caller: &MacCaller) -> Result<Agent, McpToolError> {
        let name = caller
            .task_id
            .as_ref()
            .map(|t| t.as_str())
            .unwrap_or(caller.thread_id.as_str());
        let name = safe_part(name).ok_or_else(|| refuse(format!("{name} can't name a folder")))?;
        let project = safe_part(caller.project_id.as_str())
            .ok_or_else(|| refuse("the project's id can't name a folder"))?;
        let dir = self.root.join(&name);
        for sub in ["jobs", "in", "out", "tmp", "bin", "DerivedData"] {
            std::fs::create_dir_all(dir.join(sub))
                .map_err(|e| failed("the agent's folder on the Mac was not made", e))?;
        }
        let shim = dir.join("bin").join("xcodebuild");
        if !shim.exists() {
            write_exec(&shim, XCODEBUILD)
                .map_err(|e| failed("bin/xcodebuild was not written", e))?;
        }
        // Touched by every step: what the sweep goes by.
        let _ = std::fs::write(dir.join(".used"), b"");
        Ok(Agent { dir, project, name })
    }

    fn mirror(&self, project: &str) -> PathBuf {
        self.root.join(".mirrors").join(format!("{project}.git"))
    }

    /// [`Self::step_with`] with nothing after the step, and none of the answer's raw bytes.
    pub async fn step(&self, agent: &Agent, step: Step) -> Result<Done, McpToolError> {
        self.step_with(agent, step, Vec::new())
            .await
            .map(|(done, _)| done)
    }

    /// The step, with the raw bytes that came after it (a `put`'s piece); the answer, with those that go after it (a
    /// raw `get`'s piece).
    pub async fn step_with(
        &self,
        agent: &Agent,
        step: Step,
        raw: Vec<u8>,
    ) -> Result<(Done, Vec<u8>), McpToolError> {
        let done = match step {
            Step::Have => {
                let (mirror, name) = (self.mirror(&agent.project), agent.name.clone());
                Done::Have {
                    snapshots: blocking(move || Ok(haves(&mirror, &name))).await?,
                    raw: true,
                }
            }
            Step::Put {
                name,
                offset,
                data_b64,
            } => {
                let path = agent.dir.join("in").join(
                    safe_part(&name).ok_or_else(|| refuse(format!("{name} can't name a file")))?,
                );
                let data = if data_b64.is_empty() {
                    raw
                } else {
                    B64.decode(data_b64)
                        .map_err(|_| refuse("the piece is not base64"))?
                };
                blocking(move || put(&path, offset, &data)).await?
            }
            Step::Checkout { snapshot, pack } => {
                let mirror = self.mirror(&agent.project);
                let pack = match pack {
                    Some(name) => Some(
                        agent.dir.join("in").join(
                            safe_part(&name)
                                .ok_or_else(|| refuse(format!("{name} can't name a file")))?,
                        ),
                    ),
                    None => None,
                };
                let (repo, name) = (agent.repo(), agent.name.clone());
                blocking(move || checkout(&mirror, &repo, &name, &snapshot, pack.as_deref()))
                    .await?
            }
            Step::Run {
                args,
                env,
                background,
            } => {
                let device = self.sim_env(&agent.name);
                self.jobs
                    .start(agent, &args, &env, background, device)
                    .await?
            }
            Step::Logs { job, offset } => self.jobs.logs(&agent.name, job, offset).await?,
            Step::Ps => Done::Ps {
                jobs: self.jobs.list(&agent.name),
            },
            Step::Kill { job } => Done::Kill {
                job,
                killed: self.jobs.kill(&agent.name, job),
            },
            Step::Get { path, offset, raw } => {
                let dir = agent.dir.clone();
                let repo = agent.repo();
                return blocking(move || get(&dir, &repo, &path, offset, raw)).await;
            }
            Step::SimStart { device, wait } => {
                self.sim_start(agent, device.as_deref(), wait).await?
            }
            Step::SimEnd => Done::SimEnd {
                ended: self.sim_end(&agent.name),
            },
        };
        Ok((done, Vec::new()))
    }
}

/// The simulator the agent holds, asked for again: the same one, unless it named another device type.
fn held_again(h: &mut Held, device: Option<&str>) -> Result<Done, McpToolError> {
    if let Some(wanted) = device
        && !h.device.starts_with(&format!("{wanted} on "))
    {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!("You hold a {} simulator already.", h.device),
        )
        .with_fix(format!(
            "mac sim end, then mac sim start --device \"{wanted}\""
        )));
    }
    h.used = Instant::now();
    Ok(Done::SimStart {
        udid: h.lent.udid.clone(),
        device: h.device.clone(),
    })
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, McpToolError> + Send + 'static,
) -> Result<T, McpToolError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| failed("the step stopped", e))?
}

fn write_exec(path: &Path, text: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, text)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

fn git(dir: &Path, args: &[&str]) -> Result<String, McpToolError> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| failed("git didn't run on the Mac", e))?;
    if !out.status.success() {
        return Err(failed(
            &format!("git {} failed on the Mac", args.first().unwrap_or(&"")),
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The snapshots the project's mirror holds: the agent's own last one, then the newest first.
pub fn haves(mirror: &Path, agent: &str) -> Vec<String> {
    if !mirror.is_dir() {
        return Vec::new();
    }
    let listed = git(
        mirror,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(objectname)",
            "refs/fleetd/",
        ],
    )
    .unwrap_or_default();
    let own = git(
        mirror,
        &[
            "rev-parse",
            "--verify",
            "-q",
            &format!("refs/fleetd/{agent}"),
        ],
    )
    .ok()
    .map(|o| o.trim().to_owned())
    .filter(|o| !o.is_empty());
    let mut out: Vec<String> = own.into_iter().collect();
    for id in listed.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if !out.iter().any(|o| o == id) {
            out.push(id.to_owned());
        }
        if out.len() == HAVE_MAX {
            break;
        }
    }
    out
}

/// One piece of a file the next step reads: the first starts it again, each other follows the last. One sent again
/// (its answer was lost on the way) writes over what it wrote before, and what came after goes.
fn put(path: &Path, offset: u64, data: &[u8]) -> Result<Done, McpToolError> {
    if data.len() > PIECE || offset + data.len() as u64 > PUSH_MAX {
        return Err(refuse("the push is larger than the Mac takes"));
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(path)
        .map_err(|e| failed("the piece was not written", e))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    if size < offset {
        return Err(refuse(format!(
            "the piece starts at {offset}, and the Mac has {size} bytes of it"
        )));
    }
    file.set_len(offset)
        .and_then(|_| file.seek(std::io::SeekFrom::Start(offset)))
        .and_then(|_| file.write_all(data))
        .map_err(|e| failed("the piece was not written", e))?;
    Ok(Done::Put {
        bytes: offset + data.len() as u64,
    })
}

fn snapshot_id(id: &str) -> bool {
    matches!(id.len(), 40 | 64) && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// The agent's `repo/` becomes `snapshot`: the pack goes into the project's mirror first, the snapshot is kept there
/// under the agent's name, and the worktree is checked out at it. Files git ignores (builds, `node_modules`) stay.
pub fn checkout(
    mirror: &Path,
    repo: &Path,
    name: &str,
    snapshot: &str,
    pack: Option<&Path>,
) -> Result<Done, McpToolError> {
    if !snapshot_id(snapshot) {
        return Err(refuse(format!("{snapshot} is not a commit id")));
    }
    if !mirror.is_dir() {
        std::fs::create_dir_all(mirror).map_err(|e| failed("the mirror was not made", e))?;
        git(mirror, &["init", "--quiet", "--bare"])?;
    }
    let commit = format!("{snapshot}^{{commit}}");
    // A checkout sent again after its answer was lost: its pack went into the mirror already.
    let indexed =
        |pack: &&Path| !pack.exists() && git(mirror, &["cat-file", "-e", &commit]).is_ok();
    if let Some(pack) = pack.filter(|p| !indexed(p)) {
        let file =
            std::fs::File::open(pack).map_err(|e| failed("the push's pack is missing", e))?;
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(mirror)
            .args(["index-pack", "--stdin", "--fix-thin"])
            .stdin(file)
            .output()
            .map_err(|e| failed("git didn't run on the Mac", e))?;
        let _ = std::fs::remove_file(pack);
        if !out.status.success() {
            return Err(failed(
                "the push's pack didn't index",
                String::from_utf8_lossy(&out.stderr).trim(),
            )
            .with_fix("run mac push again"));
        }
    }
    git(mirror, &["cat-file", "-e", &commit])
        .map_err(|_| refuse("the Mac doesn't have that snapshot").with_fix("run mac push again"))?;
    git(
        mirror,
        &["update-ref", &format!("refs/fleetd/{name}"), snapshot],
    )?;
    let fresh = !repo.join(".git").exists() || git(repo, &["rev-parse", "--git-dir"]).is_err();
    if fresh {
        let _ = std::fs::remove_dir_all(repo);
        let _ = git(mirror, &["worktree", "prune"]);
        git(
            mirror,
            &[
                "worktree",
                "add",
                "--force",
                "--detach",
                &repo.to_string_lossy(),
                snapshot,
            ],
        )?;
    } else {
        git(
            repo,
            &["checkout", "--quiet", "--force", "--detach", snapshot],
        )?;
        git(repo, &["clean", "-fdq"])?;
    }
    Ok(Done::Checkout {
        folder: repo.to_string_lossy().into_owned(),
    })
}

/// A path the agent named: inside its own folder only, relative ones from `repo/`.
pub fn inside(dir: &Path, repo: &Path, path: &str) -> Result<PathBuf, McpToolError> {
    let named = Path::new(path);
    let full = if named.is_absolute() {
        named.to_path_buf()
    } else {
        repo.join(named)
    };
    let real = full
        .canonicalize()
        .map_err(|_| refuse(format!("{path} isn't on the Mac")))?;
    let home = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    if !real.starts_with(&home) {
        return Err(refuse(format!(
            "{path} is outside your folder on the Mac ({})",
            dir.display()
        ))
        .with_fix("copy it into your folder with mac run first"));
    }
    Ok(real)
}

/// One piece of a file in the agent's folder, or of a folder packed as a tar.gz (the first piece packs it): `raw`, as
/// the bytes after the answer, else in its `data_b64`.
pub fn get(
    dir: &Path,
    repo: &Path,
    path: &str,
    offset: u64,
    raw: bool,
) -> Result<(Done, Vec<u8>), McpToolError> {
    let real = inside(dir, repo, path)?;
    let folder = real.is_dir();
    let source = if folder {
        use sha2::Digest;
        let tag: String = sha2::Sha256::digest(real.to_string_lossy().as_bytes())[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let packed = dir.join("out").join(format!("pull-{tag}.tgz"));
        if offset == 0 {
            let (Some(parent), Some(leaf)) = (real.parent(), real.file_name()) else {
                return Err(refuse(format!("{path} can't be packed")));
            };
            // Links followed: what comes back holds files and folders only.
            let out = std::process::Command::new("tar")
                .arg("-czhf")
                .arg(&packed)
                .arg("-C")
                .arg(parent)
                .arg(leaf)
                .stdin(Stdio::null())
                .output()
                .map_err(|e| failed("tar didn't run on the Mac", e))?;
            if !out.status.success() {
                return Err(failed(
                    &format!("{path} wasn't packed"),
                    String::from_utf8_lossy(&out.stderr).trim(),
                ));
            }
        }
        packed
    } else {
        real
    };
    let mut file =
        std::fs::File::open(&source).map_err(|e| failed(&format!("{path} can't be read"), e))?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    if total > PULL_MAX {
        return Err(refuse(format!(
            "{path} is {} MB, more than a pull brings back ({} MB)",
            total >> 20,
            PULL_MAX >> 20
        )));
    }
    let mut data = Vec::with_capacity(PIECE.min(total.saturating_sub(offset) as usize));
    file.seek(std::io::SeekFrom::Start(offset))
        .and_then(|_| file.take(PIECE as u64).read_to_end(&mut data))
        .map_err(|e| failed(&format!("{path} can't be read"), e))?;
    if folder && offset + data.len() as u64 >= total {
        let _ = std::fs::remove_file(&source);
    }
    if raw {
        let done = Done::Get {
            data_b64: String::new(),
            total,
            folder,
        };
        return Ok((done, data));
    }
    let done = Done::Get {
        data_b64: B64.encode(&data),
        total,
        folder,
    };
    Ok((done, Vec::new()))
}

/// Removes the agents' folders nothing touched for `days`, with their snapshots in the mirrors.
pub fn sweep(root: &Path, days: u64) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let old = std::time::SystemTime::now() - Duration::from_secs(days * 86_400);
    let mut gone = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let used = std::fs::metadata(entry.path().join(".used"))
            .and_then(|m| m.modified())
            .ok();
        if used.is_some_and(|u| u < old) {
            let _ = std::fs::remove_dir_all(entry.path());
            gone.push(name);
        }
    }
    if gone.is_empty() {
        return;
    }
    let Ok(mirrors) = std::fs::read_dir(root.join(".mirrors")) else {
        return;
    };
    for mirror in mirrors.flatten() {
        for name in &gone {
            let _ = git(
                &mirror.path(),
                &["update-ref", "-d", &format!("refs/fleetd/{name}")],
            );
        }
        let _ = git(&mirror.path(), &["worktree", "prune"]);
        let _ = git(&mirror.path(), &["gc", "--auto", "--quiet"]);
    }
}
