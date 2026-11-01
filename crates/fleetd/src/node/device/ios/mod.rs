//! iOS sessions (W46): an agent opens one with `session_start` kind ios, on a Mac with Xcode. The node lends it a
//! booted clone of its settled golden simulator from a warm pool (pool.rs), points the agent's agent-device at the
//! clone's udid (wrapper.rs) and records the screen with `simctl io recordVideo` (session.rs); `session_end` deletes
//! the clone. The simulators live in a device set of the node's own (simctl.rs), apart from a person's in Xcode.
//! Sessions share the browser sessions' tools, action log, upload and hub storage, as android sessions do; the
//! [`Router`](super::Router) sends each call to the broker of its kind.
//!
//! Live view and takeover: [`Simulators::frames`] gives the screen as JPEG frames from a screenshot loop that runs
//! while someone watches, [`Simulators::input`] takes a person's touches and keys (through agent-device), and
//! [`Simulators::set_control`] hands the simulator to a person and back: the same hooks as android sessions.
pub mod pool;
pub mod screen;
pub mod session;
pub mod simctl;
pub mod wrapper;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fleetd_contracts::browser::{
    BrowserCallResult, BrowserControl, BrowserRecordingEntry, BrowserSessionState, DeviceCall,
    SessionEnded, SessionKind, SessionStarted,
};
use fleetd_contracts::machine_roles::HostKey;
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::node_link::{CAP_SESSION_IOS, IosHealth, IosState};
use fleetd_contracts::prim::{Count, Text};
use fleetd_contracts::sessions::{ItemKind, ItemStatus, ThreadItem};
use serde::{Deserialize, Serialize};
use serde_json::json;

use self::pool::{Golden, Pool};
use self::session::{Opened, Session};
use self::simctl::Simctl;
use super::agent_device;
use super::remote;
use super::scrcpy::{Frame, Input};
use super::{Starting, drives_device, new_id, refuse};
use crate::node::browser::SecretsFor;
use crate::node::browser::upload::{self, HubCalls};
use crate::node::util::AbortOnDrop;

/// node.json's `ios`: how this Mac runs iOS sessions. Every field is optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IosConfig {
    /// True opts this Mac in: the node makes its golden simulator (a boot to settle, and agent-device's runner built
    /// with xcodebuild: minutes) and keeps clones of it booted. False turns iOS sessions off. Absent: on only where
    /// the golden is made already.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Clones kept booted for the next sessions. Absent: 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<usize>,
    /// A session no tool call touched for this long is ended. Absent: 30.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_minutes: Option<u64>,
    /// The simulator's device type by name ("iPhone 17 Pro"); absent, the newest plain iPhone of the newest iOS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_type: Option<String>,
    /// False refuses `agent-device install` and `reinstall` from agents on other machines (remote.rs): an app installed
    /// in a simulator runs as this Mac's user. Absent: allowed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_install: Option<bool>,
}

impl IosConfig {
    /// Whether the node runs its iOS side at all (sessions may still not start: see [`Simulators::usable`]).
    pub fn enabled(&self) -> bool {
        self.enabled != Some(false) && supported()
    }

    /// Whether a person opted this Mac in, so the node makes its golden simulator.
    pub fn opted_in(&self) -> bool {
        self.enabled == Some(true)
    }
}

/// iOS simulators run on macOS only.
pub fn supported() -> bool {
    cfg!(target_os = "macos")
}

pub fn ios_dir(home: &Path) -> PathBuf {
    super::sdk::device_dir(home).join("ios")
}

/// The node's own simulator set.
pub fn set_dir(home: &Path) -> PathBuf {
    ios_dir(home).join("set")
}

fn short_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Where the golden stands.
enum Prep {
    Ready(Arc<Pool>),
    /// Not made: on a Mac opted in, the node makes it.
    Wanted,
    Preparing,
    /// The golden is made; the clones a stopped node left are being deleted before the pool fills.
    Starting,
    Missing(String),
}

/// What making the golden left for the doctor between heartbeats: `<ios dir>/state.json`.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
struct PrepState {
    preparing: bool,
    failed: Option<String>,
}

fn state_path(home: &Path) -> PathBuf {
    ios_dir(home).join("state.json")
}

fn write_state(home: &Path, state: &PrepState) {
    let path = state_path(home);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(state) {
        let _ = crate::node::secrets::write_atomic(&path, &bytes);
    }
}

fn read_state(home: &Path) -> PrepState {
    std::fs::read(state_path(home))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// What Xcode offers, as the doctor reads it: the newest iOS runtime's name, or why there is none and what fixes it.
pub type Xcode = Result<String, (String, Option<String>)>;

/// The doctor's facts about Xcode, from `xcrun simctl list runtimes -j` (and `xcode-select -p` when that fails).
/// Read at most every few minutes: simctl takes a second. Blocking.
fn xcode() -> Xcode {
    static LAST: Mutex<Option<(Instant, Xcode)>> = Mutex::new(None);
    let mut last = lock(&LAST);
    if let Some((at, xcode)) = last.as_ref()
        && at.elapsed() < Duration::from_secs(300)
    {
        return xcode.clone();
    }
    let out = std::process::Command::new("xcrun")
        .args(["simctl", "list", "runtimes", "-j"])
        .stdin(std::process::Stdio::null())
        .output();
    let selected = || {
        std::process::Command::new("xcode-select")
            .arg("-p")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
    };
    let xcode = xcode_from(
        out.as_ref()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .ok_or_else(|| match &out {
                Ok(o) => String::from_utf8_lossy(&o.stderr).trim().to_owned(),
                Err(e) => e.to_string(),
            }),
        selected().as_deref(),
        Path::new("/Applications/Xcode.app").is_dir(),
    );
    *last = Some((Instant::now(), xcode.clone()));
    xcode
}

/// [`xcode`] from its facts: simctl's runtimes (or what it said), the developer directory selected, and whether
/// Xcode is in /Applications.
pub fn xcode_from(
    runtimes: Result<String, String>,
    selected: Option<&str>,
    in_applications: bool,
) -> Xcode {
    let json = match runtimes {
        Ok(json) => json,
        Err(said) => {
            let tools_only = selected.is_some_and(|s| s.contains("CommandLineTools"));
            return Err(match (tools_only, in_applications) {
                (true, true) => (
                    "the command line tools are selected, not Xcode, so simctl doesn't run"
                        .to_owned(),
                    Some("sudo xcode-select --switch /Applications/Xcode.app".to_owned()),
                ),
                (_, false) => ("no Xcode: install it from the App Store".to_owned(), None),
                (false, true) => (
                    format!(
                        "Xcode's simctl doesn't run: {}",
                        said.chars().take(200).collect::<String>()
                    ),
                    Some("sudo xcodebuild -runFirstLaunch".to_owned()),
                ),
            });
        }
    };
    let runtimes = simctl::ios_runtimes(&json).map_err(|why| (why, None))?;
    simctl::pick(&runtimes, None)
        .map(|(runtime, _)| runtime.name)
        .map_err(|_| {
            (
                "Xcode has no iOS simulator runtime".to_owned(),
                Some("xcodebuild -downloadPlatform iOS".to_owned()),
            )
        })
}

/// Whether Node.js runs (agent-device needs it), blocking.
fn node_runs() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Whether iOS sessions can run here, for the doctor (each heartbeat; blocking): None off macOS, where they are off,
/// and on a Mac without Xcode that didn't opt in.
pub fn health(home: &Path, config: &IosConfig) -> Option<IosHealth> {
    host(home, config).map(|(health, _)| health)
}

/// [`health`], and whether the hub may send this Mac an ios `session_start` (machine roles' host check,
/// node/hosts.rs): where the golden is made, and on a Mac opted in while it is being made or after it failed, as
/// Android's check does for its install. There the node answers itself ("still making it"), and the next
/// session_start tries a failed golden again. Not where Xcode, a runtime or Node.js is missing, nor on a Mac that
/// didn't opt in.
pub fn host(home: &Path, config: &IosConfig) -> Option<(IosHealth, bool)> {
    if !config.enabled() {
        return None;
    }
    health_from(
        config,
        pool::find(home).as_ref(),
        &read_state(home),
        xcode,
        node_runs,
    )
}

fn health_from(
    config: &IosConfig,
    golden: Option<&Golden>,
    state: &PrepState,
    xcode: impl FnOnce() -> Xcode,
    node: impl FnOnce() -> bool,
) -> Option<(IosHealth, bool)> {
    let health = |state, message: String, fix: Option<String>, placeable: bool| {
        Some((
            IosHealth {
                state,
                message: Text::unchecked(message.chars().take(500).collect::<String>()),
                fix: fix.map(|f| Text::unchecked(f.chars().take(500).collect::<String>())),
            },
            placeable,
        ))
    };
    if let Some(golden) = golden {
        return health(
            IosState::Ready,
            format!(
                "iOS screens are ready: {} on {}, agent-device {}.",
                golden.runtime_name,
                golden.device_type_name,
                agent_device::VERSION
            ),
            None,
            true,
        );
    }
    if state.preparing {
        return health(
            IosState::Preparing,
            "Making the golden iOS simulator: one boot left to settle, then agent-device's runner built with \
             xcodebuild."
                .to_owned(),
            None,
            config.opted_in(),
        );
    }
    let runtime = match xcode() {
        Ok(runtime) => runtime,
        Err((why, fix)) if config.opted_in() => {
            return health(
                IosState::Unavailable,
                format!("No iOS screens: {why}."),
                fix,
                false,
            );
        }
        Err(_) => return None,
    };
    if !config.opted_in() {
        return health(
            IosState::Wanted,
            format!(
                "Xcode with {runtime}; iOS screens are off until this Mac opts in with \"ios\": {{\"enabled\": \
                 true}} in its node.json."
            ),
            None,
            false,
        );
    }
    if !node() {
        return health(
            IosState::Unavailable,
            "No iOS screens: agent-device needs Node.js 22.12 or later on the node's PATH."
                .to_owned(),
            Some("brew install node".to_owned()),
            false,
        );
    }
    if let Some(why) = &state.failed {
        // Only the golden failed: the next session_start makes it again, so the hub must send one.
        return health(
            IosState::Unavailable,
            format!(
                "Making the golden iOS simulator failed: {why}. The next ios session_start tries again."
            ),
            None,
            true,
        );
    }
    health(
        IosState::Preparing,
        format!("Xcode with {runtime}; the node makes its golden iOS simulator next."),
        None,
        true,
    )
}

/// What session_start says with no warm clone, and what the agent does next.
pub fn waiting_words(waiting: &pool::Waiting) -> (String, String) {
    let secs = waiting.secs;
    match (&waiting.failing, waiting.retry_in) {
        (None, _) => (
            format!("Starting a simulator for you; it is ready in about {secs} s."),
            format!("try session_start again in about {secs} s"),
        ),
        (Some(why), None) => (
            format!(
                "This Mac's last iOS simulator boot failed ({why}); another is booting now, ready in about {secs} s \
                 if it works."
            ),
            format!("try session_start again in about {secs} s, or carry on without it"),
        ),
        (Some(why), Some(retry)) => (
            format!(
                "This Mac's iOS simulators keep failing to boot ({why}); it tries again in about {retry} s."
            ),
            "carry on without it and say so in your result, or try session_start again later"
                .to_owned(),
        ),
    }
}

/// What the node lists at its link's hello for iOS sessions: `session_ios` once the golden is made (the doctor's
/// check passes), on a Mac where they aren't off.
pub fn capabilities(home: &Path) -> Vec<String> {
    let config = crate::node::config::read_config(home)
        .ok()
        .flatten()
        .and_then(|c| c.ios)
        .unwrap_or_default();
    match config.enabled() && pool::find(home).is_some() {
        true => vec![CAP_SESSION_IOS.to_owned()],
        false => Vec::new(),
    }
}

/// The node's iOS sessions.
pub struct Simulators {
    home: PathBuf,
    config: IosConfig,
    prep: Mutex<Prep>,
    /// Live sessions by the agent session they belong to: one each.
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    starting: Arc<Mutex<HashSet<String>>>,
    /// The agent sessions that are Navis': each runs in its sandbox, which reads and writes only its own agent-device
    /// home, so it never takes over a clone's.
    navis: Mutex<HashSet<String>>,
    hub: Arc<dyn HubCalls>,
    secrets_for: SecretsFor,
    uploading: Mutex<HashSet<PathBuf>>,
    _loop: Mutex<Option<AbortOnDrop>>,
}

impl Simulators {
    /// The node's iOS sessions: ready once the golden is made and the clones a stopped node left are deleted. On a
    /// Mac opted in without a golden, the node starts making it.
    pub async fn start(
        home: &Path,
        config: IosConfig,
        hub: Arc<dyn HubCalls>,
        secrets_for: SecretsFor,
    ) -> Arc<Self> {
        let simulators = Arc::new(Self {
            home: home.to_owned(),
            prep: Mutex::new(Prep::Wanted),
            sessions: Mutex::default(),
            starting: Arc::default(),
            navis: Mutex::default(),
            hub,
            secrets_for,
            uploading: Mutex::default(),
            _loop: Mutex::default(),
            config,
        });
        if read_state(home).preparing {
            // The node stopped while making it; it starts again below.
            write_state(home, &PrepState::default());
        }
        match pool::find(home) {
            Some(golden) => {
                *lock(&simulators.prep) = Prep::Starting;
                let this = simulators.clone();
                tokio::spawn(async move {
                    let simctl = Simctl::new(set_dir(&this.home));
                    let home = this.home.clone();
                    let homes = tokio::task::spawn_blocking(move || pool::clear_homes(&home))
                        .await
                        .unwrap_or_default();
                    let cleared = pool::clear(&simctl, Some(&golden.udid)).await + homes;
                    if cleared > 0 {
                        tracing::info!(cleared, "iOS simulators a stopped node left were deleted");
                    }
                    this.ready(golden);
                });
            }
            None if simulators.config.opted_in() => simulators.begin_prepare(),
            None => {}
        }
        let weak = Arc::downgrade(&simulators);
        *lock(&simulators._loop) = Some(AbortOnDrop(tokio::spawn(housekeeping(weak))));
        simulators
    }

    /// Starts making the golden, once.
    fn begin_prepare(self: &Arc<Self>) {
        {
            let mut prep = lock(&self.prep);
            if !matches!(*prep, Prep::Wanted | Prep::Missing(_)) {
                return;
            }
            *prep = Prep::Preparing;
        }
        write_state(
            &self.home,
            &PrepState {
                preparing: true,
                failed: None,
            },
        );
        let this = self.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            match pool::prepare(&this.home, this.config.device_type.as_deref()).await {
                Ok(golden) => {
                    tracing::info!(
                        secs = started.elapsed().as_secs(),
                        runtime = %golden.runtime_name,
                        device = %golden.device_type_name,
                        "golden iOS simulator made"
                    );
                    write_state(&this.home, &PrepState::default());
                    this.ready(golden);
                }
                Err(why) => {
                    tracing::warn!(error = %why, "golden iOS simulator not made");
                    write_state(
                        &this.home,
                        &PrepState {
                            preparing: false,
                            failed: Some(why.clone()),
                        },
                    );
                    *lock(&this.prep) = Prep::Missing(why);
                }
            }
        });
    }

    /// Makes the pool and starts filling it.
    fn ready(&self, golden: Golden) {
        let pool = Pool::new(
            Simctl::new(set_dir(&self.home)),
            self.home.clone(),
            golden,
            self.config.pool.unwrap_or(1),
        );
        pool.refill();
        *lock(&self.prep) = Prep::Ready(pool);
    }

    /// Whether sessions start here now. Only then, or on a Mac opted in, do agents get agent-device.
    pub fn usable(&self) -> bool {
        matches!(*lock(&self.prep), Prep::Ready(_))
    }

    /// Whether agents get agent-device: where sessions start, or the Mac is opted in.
    pub fn offered(&self) -> bool {
        self.config.opted_in() || self.usable()
    }

    fn pool(self: &Arc<Self>) -> Result<Arc<Pool>, McpToolError> {
        if matches!(*lock(&self.prep), Prep::Starting) {
            return Err(refuse(
                ErrorCode::Failed,
                "This Mac's iOS sessions are starting up.",
                "try session_start again in a moment",
            ));
        }
        if !matches!(*lock(&self.prep), Prep::Ready(_)) && !self.config.opted_in() {
            return Err(refuse(
                ErrorCode::Failed,
                "This Mac isn't set up for iOS sessions.",
                "say so in your result: a person opts a Mac in with \"ios\": {\"enabled\": true} in its node.json \
                 (fleetd docs: iOS sessions)",
            ));
        }
        if matches!(*lock(&self.prep), Prep::Missing(_)) {
            // A golden that failed is tried again by the next session that asks.
            *lock(&self.prep) = Prep::Wanted;
        }
        self.begin_prepare();
        match &*lock(&self.prep) {
            Prep::Ready(pool) => Ok(pool.clone()),
            Prep::Wanted | Prep::Preparing | Prep::Starting => Err(refuse(
                ErrorCode::Failed,
                "This Mac is still making its golden iOS simulator (a boot to settle, then agent-device's runner \
                 built with xcodebuild).",
                "try session_start again in a few minutes, or carry on without it",
            )),
            Prep::Missing(why) => Err(refuse(
                ErrorCode::Failed,
                format!("This Mac has no golden iOS simulator: {why}."),
                "say so in your result: a person must look at this machine's node log",
            )),
        }
    }

    /// Clones booted for the next sessions.
    pub fn warm(&self) -> usize {
        match &*lock(&self.prep) {
            Prep::Ready(pool) => pool.warm(),
            _ => 0,
        }
    }

    /// Why the pool isn't refilled, while its boots keep failing.
    pub fn refill_failing(&self) -> Option<String> {
        match &*lock(&self.prep) {
            Prep::Ready(pool) => pool.failing(),
            _ => None,
        }
    }

    /// Holds the pool's refills back, or lets them go ([`Pool::hold`]).
    #[cfg(test)]
    pub fn hold_refill(&self, held: bool) {
        if let Prep::Ready(pool) = &*lock(&self.prep) {
            pool.hold(held);
        }
    }

    /// How many of its sessions are live.
    pub fn count(&self) -> usize {
        lock(&self.sessions).len()
    }

    /// The live session of an agent session.
    pub fn live(&self, thread: &str) -> Option<Arc<Session>> {
        lock(&self.sessions).get(thread).cloned()
    }

    fn by_id(&self, session: &str) -> Option<Arc<Session>> {
        lock(&self.sessions)
            .values()
            .find(|s| s.id.as_str() == session)
            .cloned()
    }

    pub async fn session_start(
        self: &Arc<Self>,
        thread: String,
        cwd: String,
        purpose: String,
    ) -> Result<BrowserCallResult, McpToolError> {
        let started = Instant::now();
        let _starting = Starting::claim(&self.starting, &thread).ok_or_else(|| {
            refuse(
                ErrorCode::Invalid,
                "Another session_start of yours is under way.",
                "wait for its answer and use that session",
            )
        })?;
        if let Some(open) = self.live(&thread) {
            return Err(refuse(
                ErrorCode::Invalid,
                format!("iOS session {} is open.", open.id),
                "use it, or end it with session_end before starting another",
            ));
        }
        let pool = self.pool()?;
        let secrets_for = self.secrets_for.clone();
        let secrets_thread = thread.clone();
        let secrets = tokio::task::spawn_blocking(move || secrets_for(&secrets_thread));
        let lent = pool.take().map_err(|waiting| {
            let (message, fix) = waiting_words(&waiting);
            refuse(ErrorCode::Failed, message, &fix)
        })?;
        let secrets = secrets
            .await
            .map_err(|e| e.to_string())
            .and_then(|m| m)
            .map_err(|why| {
                refuse(
                    ErrorCode::Failed,
                    format!("The node could not read this session's secrets to scrub its recording ({why})."),
                    "try again; if it keeps failing, check the node's log",
                )
            })?;
        // A Navi's session can't reach the clone's home from its sandbox: the runner the pool started there stops, and
        // the session starts its own in its own home.
        let navi = lock(&self.navis).contains(&thread);
        let lend = !navi && lent.home.join("config.json").is_file();
        if !lend {
            pool::stop_daemon(&lent.home.join("state")).await;
        }
        // From here to the map nothing waits, so a start that goes away leaves no half-made session behind.
        let udid = lent.udid.clone();
        let runner_up = lend && lent.runner_up();
        let home = lend.then(|| lent.home.clone());
        wrapper::write_config(&self.home, &thread, &udid, home.as_deref()).map_err(|e| {
            refuse(
                ErrorCode::Failed,
                format!("The node could not point agent-device at the simulator: {e}."),
                "try session_start again",
            )
        })?;
        let id = new_id();
        let session = Session::open(
            lent,
            pool.simctl().clone(),
            Opened {
                dir: session::recordings_dir(&self.home).join(id.as_str()),
                id,
                thread: thread.clone(),
                cwd,
                purpose: purpose.clone(),
                home: self.home.clone(),
                scale: pool.golden.scale,
                secrets,
            },
        )
        .map_err(|why| {
            agent_device::release(&self.home, &thread);
            refuse(
                ErrorCode::Failed,
                format!("The iOS session did not start: {why}."),
                "try session_start again",
            )
        })?;
        lock(&self.sessions).insert(thread.clone(), session.clone());
        if !runner_up {
            session.start_runner();
        }
        tracing::debug!(
            kind = "ios",
            session = %session.id,
            start_ms = started.elapsed().as_millis() as u64,
            runner_up,
            "screen timing: started from the warm pool"
        );
        session.step(
            "session_start",
            json!({
                "purpose": purpose, "kind": "ios", "udid": udid,
                "device": format!("{} on {}", pool.golden.device_type_name, pool.golden.runtime_name),
            }),
            true,
            None,
            0,
        );
        self.report(&session, BrowserSessionState::Live);
        Ok(BrowserCallResult::SessionStart(SessionStarted {
            session_id: session.id.clone(),
            cdp: None,
            serial: None,
            udid: Some(Text::unchecked(udid)),
            desktop: None,
            worktree: None,
            start_ms: started.elapsed().as_millis() as u64,
        }))
    }

    pub async fn session_end(
        self: &Arc<Self>,
        thread: &str,
    ) -> Result<BrowserCallResult, McpToolError> {
        let session = lock(&self.sessions).remove(thread).ok_or_else(|| {
            refuse(
                ErrorCode::NotFound,
                "No iOS session is open.",
                "nothing to end",
            )
        })?;
        Ok(BrowserCallResult::SessionEnd(self.close(session).await))
    }

    /// An agent-device command, or a file it reads or wrote, for a screen this Mac hosts for an agent on another
    /// machine (remote.rs): run by the node's own wrapper, on that screen's clone alone, in the screen's folder, and
    /// logged as the agent's own command is. A person's control holds it back as the wrapper holds a local one.
    pub async fn device(
        self: &Arc<Self>,
        thread: &str,
        call: DeviceCall,
    ) -> Result<BrowserCallResult, McpToolError> {
        if HostKey::new(thread).is_err() {
            return Err(refuse(
                ErrorCode::Invalid,
                "device steps are for an iOS screen hosted for an agent on another machine",
                "run agent-device yourself",
            ));
        }
        let session = self.live(thread).ok_or_else(|| {
            refuse(
                ErrorCode::NotFound,
                "No iOS session is open.",
                "start one with session_start kind ios",
            )
        })?;
        let work = remote::Work::at(&self.home, thread);
        let DeviceCall::Run { args } = call else {
            session.touch();
            return work.step(call).map(BrowserCallResult::Device);
        };
        work.check(&args, self.config.remote_install != Some(false))?;
        if session.runner_starting() {
            session.touch();
            return Ok(BrowserCallResult::Device(
                work.held_back(remote::RUNNER_STARTING).done(),
            ));
        }
        let program = wrapper::bin_dir(&self.home).join("agent-device");
        let path = std::env::var("PATH").ok();
        let env = wrapper::env(&self.home, thread, path.as_deref());
        let started = Instant::now();
        let ran = work.run(&program, &env, &args, remote::RUN_WAIT).await;
        session.step(
            "agent-device",
            json!({ "command": remote::command_line(&args) }),
            ran.exit_code == 0,
            Some(&ran.output()),
            started.elapsed().as_millis() as u64,
        );
        if session.control() == BrowserControl::HandingBack {
            session.set_control(BrowserControl::Agent, "agent");
            self.report(&session, BrowserSessionState::Live);
        }
        Ok(BrowserCallResult::Device(ran.done()))
    }

    /// Ends a session already out of the map, and starts its upload.
    async fn close(self: &Arc<Self>, session: Arc<Session>) -> SessionEnded {
        session.step("session_end", json!({}), true, None, 0);
        let files = session.close().await;
        remote::Work::at(&self.home, &session.thread).remove();
        let ended = SessionEnded {
            session_id: session.id.clone(),
            kind: SessionKind::Ios,
            files: files
                .iter()
                .map(|(file, bytes)| BrowserRecordingEntry {
                    file: *file,
                    bytes: Count::unchecked(*bytes as i64),
                })
                .collect(),
            note: session.note(),
        };
        // The end reaches the hub now, not only with the upload, which a missing or unreadable recording stops.
        self.report(&session, BrowserSessionState::Uploading);
        let this = self.clone();
        let dir = session.dir.clone();
        tokio::spawn(async move { this.upload(&dir).await });
        ended
    }

    /// Uploads a recording as the browser broker does (node/browser/upload.rs).
    async fn upload(&self, dir: &Path) {
        if !lock(&self.uploading).insert(dir.to_owned()) {
            return;
        }
        if let Err(why) = upload::upload(self.hub.as_ref(), dir).await {
            tracing::warn!(dir = %dir.display(), error = %why, "iOS recording not uploaded yet");
            if upload::age(dir) > upload::GIVE_UP {
                upload::give_up(
                    self.hub.as_ref(),
                    dir,
                    &format!("its upload kept failing: {why}"),
                )
                .await;
            }
        }
        lock(&self.uploading).remove(dir);
    }

    /// Tells the hub where a session is now, in the background.
    fn report(&self, session: &Session, state: BrowserSessionState) {
        // Past live, it ended now: the hub has its end from this report, whatever becomes of its upload.
        let ended_at = (state != BrowserSessionState::Live).then(crate::node::util::now_iso);
        let call = upload::report(&session.meta(ended_at), state, session.control(), &[]);
        let (hub, thread, cwd) = (
            self.hub.clone(),
            session.thread.clone(),
            session.cwd.clone(),
        );
        tokio::spawn(async move {
            if let Err(e) = hub.call(&thread, &cwd, call).await {
                tracing::warn!(error = %e.message, "iOS session not reported to the hub");
            }
        });
    }

    /// The screen of a live session, as JPEG frames: the newest each time a watcher looks.
    pub fn frames(&self, session: &str) -> Option<tokio::sync::watch::Receiver<Option<Frame>>> {
        self.by_id(session).map(|s| s.frames())
    }

    /// Whether a session of this id is live here.
    pub fn holds(&self, session: &str) -> bool {
        self.by_id(session).is_some()
    }

    /// Who drives a live session; None when no such session is live.
    pub fn control(&self, session: &str) -> Option<BrowserControl> {
        self.by_id(session).map(|s| s.control())
    }

    /// A person's input to a live session they have control of; false when it didn't go.
    pub fn input(&self, session: &str, input: &Input) -> bool {
        self.by_id(session).is_some_and(|s| s.input(input))
    }

    /// Hands a live session's simulator to a person (`Human`) or back to the agent (`HandingBack`, which becomes
    /// `Agent` at its next command), and tells the hub. None when no such session is live.
    pub fn set_control(
        &self,
        session: &str,
        control: BrowserControl,
        by: &str,
    ) -> Option<BrowserControl> {
        let session = self.by_id(session)?;
        session.set_control(control, by);
        self.report(&session, BrowserSessionState::Live);
        Some(session.control())
    }

    /// Ends every live session (the node stops); their recordings go at the node's next start.
    pub async fn shutdown(self: &Arc<Self>) {
        let all: Vec<Arc<Session>> = lock(&self.sessions).drain().map(|(_, s)| s).collect();
        for session in all {
            session.close().await;
        }
        if let Prep::Ready(pool) = &*lock(&self.prep) {
            pool.drain();
        }
    }

    pub fn env(&self, thread: &str, path: Option<&str>) -> Vec<(String, String)> {
        wrapper::env(&self.home, thread, path)
    }

    pub fn plugin_dirs(&self) -> Vec<PathBuf> {
        let dir = agent_device::plugin_dir(&self.home);
        dir.join(".claude-plugin")
            .is_dir()
            .then_some(dir)
            .into_iter()
            .collect()
    }

    /// Ends the agent session's iOS session, if it has one (its agent session ended).
    /// The agent session is a Navi's: its sessions keep their own agent-device home.
    pub fn navi(&self, thread: &str) {
        lock(&self.navis).insert(thread.to_owned());
    }

    pub fn ended(self: &Arc<Self>, thread: &str) {
        lock(&self.navis).remove(thread);
        let Some(session) = lock(&self.sessions).remove(thread) else {
            return;
        };
        let this = self.clone();
        tokio::spawn(async move {
            session.step("agent_session_ended", json!({}), true, None, 0);
            this.close(session).await;
        });
    }

    /// A finished `agent-device` command of a session with a live simulator: a line in its action log. The first
    /// after a person handed the simulator back gives it to the agent again.
    pub fn item(&self, thread: &str, item: &ThreadItem) {
        let ItemKind::Command {
            command,
            output,
            exit_code,
            ..
        } = &item.kind
        else {
            return;
        };
        if !matches!(item.status, ItemStatus::Completed | ItemStatus::Failed)
            || !drives_device(command)
        {
            return;
        }
        let Some(session) = self.live(thread) else {
            return;
        };
        let duration_ms = item
            .completed_at
            .as_ref()
            .and_then(|end| {
                let end = chrono::DateTime::parse_from_rfc3339(end.as_str()).ok()?;
                let start = chrono::DateTime::parse_from_rfc3339(item.started_at.as_str()).ok()?;
                u64::try_from((end - start).num_milliseconds()).ok()
            })
            .unwrap_or_default();
        let ok = item.status == ItemStatus::Completed && exit_code.is_none_or(|c| c == 0);
        session.step(
            "agent-device",
            json!({ "command": command }),
            ok,
            output.as_deref(),
            duration_ms,
        );
        if session.control() == BrowserControl::HandingBack {
            session.set_control(BrowserControl::Agent, "agent");
            self.report(&session, BrowserSessionState::Live);
        }
    }
}

/// Every minute: ends sessions idle past the limit, tops the pool up, and sends the recordings still waiting for the
/// hub.
async fn housekeeping(simulators: std::sync::Weak<Simulators>) {
    let mut uploading: Option<tokio::task::JoinHandle<()>> = None;
    loop {
        let Some(this) = simulators.upgrade() else {
            return;
        };
        let idle = Duration::from_secs(60 * this.config.idle_minutes.unwrap_or(30));
        let stale: Vec<Arc<Session>> = {
            let mut sessions = lock(&this.sessions);
            let threads: Vec<String> = sessions
                .iter()
                .filter(|(_, s)| s.idle_for() >= idle && s.control() == BrowserControl::Agent)
                .map(|(t, _)| t.clone())
                .collect();
            threads.iter().filter_map(|t| sessions.remove(t)).collect()
        };
        for session in stale {
            tracing::info!(session = %session.id, "iOS session idle; ending it");
            this.close(session).await;
        }
        // A refill that failed (a boot that timed out on a loaded machine) tries again; a full pool does nothing.
        if let Prep::Ready(pool) = &*lock(&this.prep) {
            pool.refill();
        }
        if uploading.as_ref().is_none_or(|u| u.is_finished()) {
            let live: Vec<String> = lock(&this.sessions)
                .values()
                .map(|s| s.id.to_string())
                .collect();
            let waiting = upload::waiting_in(&session::recordings_dir(&this.home), &live);
            let this = this.clone();
            uploading = Some(tokio::spawn(async move {
                for dir in waiting {
                    this.upload(&dir).await;
                }
            }));
        }
        drop(this);
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}
