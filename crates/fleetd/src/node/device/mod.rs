//! Android sessions (W46): an agent opens one with `session_start` kind android. The node lends it a booted
//! `-read-only` copy of its Android emulator from a warm pool (emulator.rs), points the agent's agent-device at the
//! copy's serial (agent_device.rs) and records the screen through scrcpy's stream (scrcpy.rs) as a browser session's
//! video; `session_end` throws the copy away. The session shares the browser sessions' tools, action log, recording
//! format, upload and hub storage (node/browser); [`Router`] sends each session tool call to the broker of its kind.
//!
//! Live view and takeover: [`Devices::frames`] gives the screen as JPEG frames, [`Devices::input`] takes a person's
//! touches and keys, and [`Devices::set_control`] hands the device to a person and back, for the app's live view
//! messages to call.
pub mod agent_device;
pub mod emulator;
pub mod scrcpy;
pub mod sdk;
pub mod session;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fleetd_contracts::browser::{
    BrowserCall, BrowserCallFrame, BrowserCallResult, BrowserControl, BrowserRecordingEntry,
    BrowserResultFrame, BrowserSessionId, BrowserSessionState, SessionEnded, SessionKind,
    SessionStarted,
};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::node_link::{AndroidHealth, AndroidState, CAP_SESSION_ANDROID};
use fleetd_contracts::prim::{Count, Text};
use fleetd_contracts::sessions::{ItemKind, ItemStatus, ThreadItem};
use serde::{Deserialize, Serialize};
use serde_json::json;

use self::emulator::Pool;
use self::scrcpy::{Frame, Input};
use self::session::{Opened, Session};
use super::browser::upload::{self, HubCalls};
use super::browser::{Broker, BrowserHandler, SecretsFor, SessionHooks};
use super::util::AbortOnDrop;

/// node.json's `device`: how this machine runs android sessions. Every field is optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConfig {
    /// True opts this machine in: the first android `session_start` installs the emulator (about 2 GB). False turns
    /// android sessions off. Absent: on only where they are installed already; nothing is installed. Either way they
    /// run only while /dev/kvm opens read-write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Emulators kept booted for the next sessions. Absent: 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<usize>,
    /// A session no tool call touched for this long is ended. Absent: 30.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_minutes: Option<u64>,
}

impl DeviceConfig {
    /// Whether the node runs its android side at all (they may still be unusable: see [`Devices::usable`]).
    pub fn enabled(&self) -> bool {
        self.enabled != Some(false) && sdk::supported()
    }

    /// Whether a person opted this machine in, so an agent's session may install the emulator.
    pub fn opted_in(&self) -> bool {
        self.enabled == Some(true)
    }
}

/// Where the node's install stands.
enum Install {
    Ready(Arc<Pool>),
    /// Not installed: on a machine opted in, the first `session_start` installs it.
    Wanted,
    Installing,
    Missing(String),
}

/// What the install left for the doctor between heartbeats: `<device dir>/state.json`.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
struct InstallState {
    installing: bool,
    failed: Option<String>,
}

fn state_path(home: &Path) -> PathBuf {
    sdk::device_dir(home).join("state.json")
}

fn write_state(home: &Path, state: &InstallState) {
    let path = state_path(home);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(state) {
        let _ = crate::node::secrets::write_atomic(&path, &bytes);
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn refuse(code: ErrorCode, message: impl Into<String>, fix: &str) -> McpToolError {
    McpToolError::new(code, message).with_fix(fix)
}

fn new_id() -> BrowserSessionId {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    BrowserSessionId::unchecked(format!("B{hex}"))
}

/// Whether a command the agent ran drove its device.
pub fn drives_device(command: &str) -> bool {
    command.contains("agent-device")
}

/// Whether android sessions can run here, for the doctor (each heartbeat): None where they are off, or neither
/// installed nor opted in.
pub fn health(home: &Path, config: &DeviceConfig) -> Option<AndroidHealth> {
    let installed = sdk::find(home).is_some() && agent_device::find(home).is_some();
    if !config.enabled() || !(installed || config.opted_in()) {
        return None;
    }
    let health = |state, message: String, fix: Option<String>| AndroidHealth {
        state,
        message: Text::unchecked(message.chars().take(500).collect::<String>()),
        fix: fix.map(|f| Text::unchecked(f.chars().take(500).collect::<String>())),
    };
    if let Err((why, fix)) = sdk::kvm() {
        return Some(health(AndroidState::Unavailable, why, fix));
    }
    if installed {
        return Some(health(
            AndroidState::Ready,
            format!(
                "Android sessions are ready: {}, agent-device {}.",
                sdk::PINS,
                agent_device::VERSION
            ),
            None,
        ));
    }
    let state: InstallState = std::fs::read(state_path(home))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    Some(match state {
        InstallState {
            installing: true, ..
        } => health(
            AndroidState::Installing,
            "Installing the Android emulator for sessions (about 2 GB), then booting it once to save its snapshot."
                .to_owned(),
            None,
        ),
        InstallState {
            failed: Some(why), ..
        } => health(
            AndroidState::Unavailable,
            format!("Installing the Android emulator failed: {why}. The next android session_start tries again."),
            None,
        ),
        _ => health(
            AndroidState::Wanted,
            "KVM works; the Android emulator installs when an agent first asks for an android session.".to_owned(),
            None,
        ),
    })
}

/// What the node lists at its link's hello for android sessions.
pub fn capabilities(home: &Path) -> Vec<String> {
    let config = super::config::read_config(home)
        .ok()
        .flatten()
        .and_then(|c| c.device)
        .unwrap_or_default();
    match health(home, &config) {
        Some(h) if h.state == AndroidState::Ready => {
            vec![CAP_SESSION_ANDROID.to_owned()]
        }
        _ => Vec::new(),
    }
}

/// The node's android sessions.
pub struct Devices {
    home: PathBuf,
    config: DeviceConfig,
    install: Mutex<Install>,
    /// Live sessions by the agent session they belong to: one each.
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Agent sessions whose `session_start` is under way: a second one waits its turn by being refused.
    starting: Arc<Mutex<HashSet<String>>>,
    hub: Arc<dyn HubCalls>,
    secrets_for: SecretsFor,
    uploading: Mutex<HashSet<PathBuf>>,
    _loop: Mutex<Option<AbortOnDrop>>,
}

impl Devices {
    /// The node's android sessions: ready when the pinned install is there and KVM opens. Nothing installs here: on a
    /// machine opted in, the first android `session_start` does. Emulators a node left running when it died, and an
    /// install it stopped during, are cleared first.
    pub async fn start(
        home: &Path,
        config: DeviceConfig,
        hub: Arc<dyn HubCalls>,
        secrets_for: SecretsFor,
    ) -> Arc<Self> {
        let devices = Arc::new(Self {
            home: home.to_owned(),
            install: Mutex::new(Install::Wanted),
            sessions: Mutex::default(),
            starting: Arc::default(),
            hub,
            secrets_for,
            uploading: Mutex::default(),
            _loop: Mutex::default(),
            config,
        });
        let killed = emulator::kill_leftovers(&sdk::Sdk::at(home));
        if killed > 0 {
            tracing::info!(killed, "emulators a stopped node left running were killed");
        }
        if std::fs::read(state_path(home))
            .ok()
            .and_then(|b| serde_json::from_slice::<InstallState>(&b).ok())
            .is_some_and(|s| s.installing)
        {
            // The node stopped during an install; the next session that asks starts it again.
            write_state(home, &InstallState::default());
        }
        devices.ready_if_installed();
        let weak = Arc::downgrade(&devices);
        *lock(&devices._loop) = Some(AbortOnDrop(tokio::spawn(housekeeping(weak))));
        devices
    }

    /// Starts installing what is missing, once.
    fn begin_install(self: &Arc<Self>) {
        {
            let mut install = lock(&self.install);
            if !matches!(*install, Install::Wanted | Install::Missing(_)) {
                return;
            }
            *install = Install::Installing;
        }
        write_state(
            &self.home,
            &InstallState {
                installing: true,
                failed: None,
            },
        );
        let devices = self.clone();
        tokio::spawn(async move {
            let installed = async {
                if agent_device::find(&devices.home).is_none() {
                    agent_device::install(&devices.home).await?;
                }
                sdk::install(&devices.home).await
            }
            .await;
            match installed {
                Ok(sdk) => {
                    write_state(&devices.home, &InstallState::default());
                    devices.ready(sdk);
                }
                Err(why) => {
                    tracing::warn!(error = %why, "android emulator not installed");
                    write_state(
                        &devices.home,
                        &InstallState {
                            installing: false,
                            failed: Some(why.clone()),
                        },
                    );
                    *lock(&devices.install) = Install::Missing(why);
                }
            }
        });
    }

    /// Makes the pool when the install is there and KVM opens, unless it is made.
    fn ready_if_installed(&self) {
        if matches!(*lock(&self.install), Install::Ready(_)) || sdk::kvm().is_err() {
            return;
        }
        if let Some(sdk) = sdk::find(&self.home)
            && agent_device::find(&self.home).is_some()
        {
            self.ready(sdk);
        }
    }

    /// Whether sessions start here now: installed, with KVM opening. Only then do agents get agent-device.
    pub fn usable(&self) -> bool {
        matches!(*lock(&self.install), Install::Ready(_)) && sdk::kvm().is_ok()
    }

    /// Whether agents get agent-device: where sessions start, or the machine is opted in (an install an agent set
    /// going finishes while it runs). The wrapper alone goes on their PATH; the SDK stays in it.
    pub fn offered(&self) -> bool {
        self.config.opted_in() || self.usable()
    }

    /// Makes the pool and starts filling it.
    pub fn ready(&self, sdk: sdk::Sdk) {
        let pool = Pool::new(sdk, self.config.pool.unwrap_or(1));
        pool.refill();
        *lock(&self.install) = Install::Ready(pool);
    }

    fn pool(self: &Arc<Self>) -> Result<Arc<Pool>, McpToolError> {
        if let Err((why, fix)) = sdk::kvm() {
            return Err(refuse(
                ErrorCode::Failed,
                format!("This machine can't run the Android emulator: {why}"),
                &match fix {
                    Some(fix) => {
                        format!("say so in your result: a person must run `{fix}` on this machine")
                    }
                    None => "say so in your result: a person must fix this machine".to_owned(),
                },
            ));
        }
        self.ready_if_installed();
        let ready = matches!(*lock(&self.install), Install::Ready(_));
        if !ready && !self.config.opted_in() {
            return Err(refuse(
                ErrorCode::Failed,
                "This machine isn't set up for Android sessions.",
                "say so in your result: a person opts a machine in with \"device\": {\"enabled\": true} in its \
                 node.json (fleetd docs: Android sessions)",
            ));
        }
        if matches!(*lock(&self.install), Install::Missing(_)) {
            // A failed install is tried again by the next session that asks.
            *lock(&self.install) = Install::Wanted;
        }
        self.begin_install();
        match &*lock(&self.install) {
            Install::Ready(pool) => Ok(pool.clone()),
            Install::Wanted | Install::Installing => Err(refuse(
                ErrorCode::Failed,
                "This machine is still installing its Android emulator (about 2 GB, then one cold boot).",
                "try session_start again in a few minutes, or carry on without it",
            )),
            Install::Missing(why) => Err(refuse(
                ErrorCode::Failed,
                format!("This machine has no Android emulator for sessions: {why}."),
                "say so in your result: a person must look at this machine's node log",
            )),
        }
    }

    /// Emulators booted for the next sessions.
    pub fn warm(&self) -> usize {
        match &*lock(&self.install) {
            Install::Ready(pool) => pool.warm(),
            _ => 0,
        }
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

    async fn session_start(
        self: &Arc<Self>,
        thread: String,
        cwd: String,
        purpose: String,
    ) -> Result<BrowserCallResult, McpToolError> {
        let started = Instant::now();
        // Held until the session is in the map (or the start fails, or its call goes away): the only way in.
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
                format!("Android session {} is open.", open.id),
                "use it, or end it with session_end before starting another",
            ));
        }
        let pool = self.pool()?;
        let secrets_for = self.secrets_for.clone();
        let secrets_thread = thread.clone();
        let secrets = tokio::task::spawn_blocking(move || secrets_for(&secrets_thread));
        let lent = pool.take().await.map_err(|why| {
            refuse(
                ErrorCode::Failed,
                format!("The Android emulator did not start: {why}."),
                "try session_start again",
            )
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
        // From here to the map nothing waits, so a start that goes away leaves no half-made session behind.
        let serial = lent.emulator.serial.clone();
        agent_device::write_config(&self.home, &thread, &serial).map_err(|e| {
            refuse(
                ErrorCode::Failed,
                format!("The node could not point agent-device at the emulator: {e}."),
                "try session_start again",
            )
        })?;
        let id = new_id();
        let session = Session::open(
            lent,
            pool.sdk().clone(),
            Opened {
                dir: session::recordings_dir(&self.home).join(id.as_str()),
                id,
                thread: thread.clone(),
                cwd,
                purpose: purpose.clone(),
                home: self.home.clone(),
                secrets,
            },
        )
        .map_err(|why| {
            agent_device::release(&self.home, &thread);
            refuse(
                ErrorCode::Failed,
                format!("The Android session did not start: {why}."),
                "try session_start again",
            )
        })?;
        lock(&self.sessions).insert(thread.clone(), session.clone());
        session.step(
            "session_start",
            json!({ "purpose": purpose, "kind": "android", "serial": serial }),
            true,
            None,
            0,
        );
        self.report(&session, BrowserSessionState::Live);
        Ok(BrowserCallResult::SessionStart(SessionStarted {
            session_id: session.id.clone(),
            cdp: None,
            serial: Some(Text::unchecked(serial)),
            start_ms: started.elapsed().as_millis() as u64,
        }))
    }

    async fn session_end(
        self: &Arc<Self>,
        thread: &str,
    ) -> Result<BrowserCallResult, McpToolError> {
        let session = lock(&self.sessions).remove(thread).ok_or_else(|| {
            refuse(
                ErrorCode::NotFound,
                "No Android session is open.",
                "nothing to end",
            )
        })?;
        Ok(BrowserCallResult::SessionEnd(self.close(session).await))
    }

    /// Ends a session already out of the map, and starts its upload.
    async fn close(self: &Arc<Self>, session: Arc<Session>) -> SessionEnded {
        session.step("session_end", json!({}), true, None, 0);
        let files = session.close().await;
        let ended = SessionEnded {
            session_id: session.id.clone(),
            kind: SessionKind::Android,
            files: files
                .iter()
                .map(|(file, bytes)| BrowserRecordingEntry {
                    file: *file,
                    bytes: Count::unchecked(*bytes as i64),
                })
                .collect(),
            note: session.note(),
        };
        let devices = self.clone();
        let dir = session.dir.clone();
        tokio::spawn(async move { devices.upload(&dir).await });
        ended
    }

    /// Uploads a recording as the browser broker does (node/browser/upload.rs).
    async fn upload(&self, dir: &Path) {
        if !lock(&self.uploading).insert(dir.to_owned()) {
            return;
        }
        if let Err(why) = upload::upload(self.hub.as_ref(), dir).await {
            tracing::warn!(dir = %dir.display(), error = %why, "device recording not uploaded yet");
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
        let call = upload::report(&session.meta(None), state, session.control(), &[]);
        let (hub, thread, cwd) = (
            self.hub.clone(),
            session.thread.clone(),
            session.cwd.clone(),
        );
        tokio::spawn(async move {
            if let Err(e) = hub.call(&thread, &cwd, call).await {
                tracing::warn!(error = %e.message, "device session not reported to the hub");
            }
        });
    }

    /// The screen of a live session, as JPEG frames: the newest each time a watcher looks.
    pub fn frames(&self, session: &str) -> Option<tokio::sync::watch::Receiver<Option<Frame>>> {
        self.by_id(session).map(|s| s.frames())
    }

    /// A person's input to a live session they have control of; false when it didn't go.
    pub fn input(&self, session: &str, input: &Input) -> bool {
        self.by_id(session).is_some_and(|s| s.input(input))
    }

    /// Hands a live session's device to a person (`Human`) or back to the agent (`HandingBack`, which becomes
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
        if let Install::Ready(pool) = &*lock(&self.install) {
            pool.drain();
        }
    }

    fn env(&self, thread: &str, path: Option<&str>) -> Vec<(String, String)> {
        agent_device::env(&self.home, thread, path)
    }

    fn plugin_dirs(&self) -> Vec<PathBuf> {
        let dir = agent_device::plugin_dir(&self.home);
        dir.join(".claude-plugin")
            .is_dir()
            .then_some(dir)
            .into_iter()
            .collect()
    }

    /// Ends the agent session's android session, if it has one (its agent session ended): the emulator goes now and
    /// the recording to the hub, not after the idle timeout.
    pub fn ended(self: &Arc<Self>, thread: &str) {
        let Some(session) = lock(&self.sessions).remove(thread) else {
            return;
        };
        let devices = self.clone();
        tokio::spawn(async move {
            session.step("agent_session_ended", json!({}), true, None, 0);
            devices.close(session).await;
        });
    }

    /// A finished `agent-device` command of a session with a live device: a line in its action log. The first after
    /// a person handed the device back gives it to the agent again.
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

/// An agent session's claim on starting a session, given up when dropped.
struct Starting {
    set: Arc<Mutex<HashSet<String>>>,
    thread: String,
}

impl Starting {
    fn claim(set: &Arc<Mutex<HashSet<String>>>, thread: &str) -> Option<Self> {
        lock(set).insert(thread.to_owned()).then(|| Self {
            set: set.clone(),
            thread: thread.to_owned(),
        })
    }
}

impl Drop for Starting {
    fn drop(&mut self) {
        lock(&self.set).remove(&self.thread);
    }
}

/// Every minute: ends sessions idle past the limit, and sends the recordings still waiting for the hub.
async fn housekeeping(devices: std::sync::Weak<Devices>) {
    let mut uploading: Option<tokio::task::JoinHandle<()>> = None;
    loop {
        let Some(this) = devices.upgrade() else {
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
            tracing::info!(session = %session.id, "android session idle; ending it");
            this.close(session).await;
        }
        if uploading.as_ref().is_none_or(|u| u.is_finished()) {
            let live: Vec<String> = lock(&this.sessions)
                .values()
                .map(|s| s.id.to_string())
                .collect();
            let waiting = upload::waiting_in(&session::recordings_dir(&this.home), &live);
            let devices = this.clone();
            uploading = Some(tokio::spawn(async move {
                for dir in waiting {
                    devices.upload(&dir).await;
                }
            }));
        }
        drop(this);
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

/// The node's session tools, for both kinds: each call goes to the browser broker or to the android sessions, and an
/// agent session holds one session of either kind at a time.
pub struct Router {
    pub browser: Option<Arc<Broker>>,
    pub devices: Option<Arc<Devices>>,
}

impl Router {
    /// The socket's handler for session tool calls.
    pub fn handler(self: &Arc<Self>) -> BrowserHandler {
        let router = self.clone();
        Arc::new(move |thread, frame| {
            let router = router.clone();
            Box::pin(async move { router.handle(thread, frame).await })
        })
    }

    /// Whether the agent session has a session of either kind live here.
    pub fn live(&self, thread: &str) -> bool {
        self.device_live(thread).is_some()
            || self
                .browser
                .as_ref()
                .is_some_and(|b| b.live(thread).is_some())
    }

    fn device_live(&self, thread: &str) -> Option<Arc<Session>> {
        self.devices.as_ref().and_then(|d| d.live(thread))
    }

    pub async fn handle(&self, thread: String, frame: BrowserCallFrame) -> BrowserResultFrame {
        let android = match &frame.call {
            BrowserCall::SessionStart(call) => call.kind == Some(SessionKind::Android),
            _ => self.device_live(&thread).is_some(),
        };
        if !android {
            if let BrowserCall::SessionStart(_) = &frame.call
                && let Some(open) = self.device_live(&thread)
            {
                let error = refuse(
                    ErrorCode::Invalid,
                    format!("Android session {} is open.", open.id),
                    "end it with session_end before starting a browser session",
                );
                return result_frame(&frame, Err(error));
            }
            return match &self.browser {
                Some(broker) => broker.handle(thread, frame).await,
                None => result_frame(
                    &frame,
                    Err(refuse(
                        ErrorCode::Invalid,
                        "this machine runs no browser sessions",
                        "do without a browser and say so in your result",
                    )),
                ),
            };
        }
        let Some(devices) = &self.devices else {
            return result_frame(
                &frame,
                Err(refuse(
                    ErrorCode::Failed,
                    "This machine hosts no Android sessions: they need a Linux x86_64 machine with KVM.",
                    "say so in your result",
                )),
            );
        };
        let outcome = match &frame.call {
            BrowserCall::SessionStart(call) => {
                if let Some(open) = self.browser.as_ref().and_then(|b| b.live(&thread)) {
                    Err(refuse(
                        ErrorCode::Invalid,
                        format!("Browser session {} is open.", open.id),
                        "end it with session_end before starting an Android session",
                    ))
                } else {
                    devices
                        .session_start(thread, frame.cwd.to_string(), call.purpose.to_string())
                        .await
                }
            }
            BrowserCall::SessionEnd(_) => devices.session_end(&thread).await,
            BrowserCall::FillCredential(_) | BrowserCall::RequestTakeover(_) => Err(refuse(
                ErrorCode::Invalid,
                format!(
                    "{} is not available in Android sessions yet.",
                    frame.call.op()
                ),
                "do without it and say so in your result",
            )),
        };
        result_frame(&frame, outcome)
    }

    pub async fn shutdown(&self) {
        if let Some(broker) = &self.browser {
            broker.shutdown().await;
        }
        if let Some(devices) = &self.devices {
            devices.shutdown().await;
        }
    }
}

fn result_frame(
    frame: &BrowserCallFrame,
    outcome: Result<BrowserCallResult, McpToolError>,
) -> BrowserResultFrame {
    let (result, error) = match outcome {
        Ok(result) => (Some(result), None),
        Err(error) => (None, Some(error)),
    };
    serde_json::from_value(json!({ "id": frame.id, "result": result, "error": error }))
        .expect("a session result frame with exactly one of result and error")
}

impl SessionHooks for Router {
    /// agent-browser's environment, then agent-device's, each first on the PATH it was given.
    fn env(&self, thread: &str, path: Option<&str>) -> Vec<(String, String)> {
        let mut env = self
            .browser
            .as_ref()
            .map(|b| b.env(thread, path))
            .unwrap_or_default();
        if let Some(devices) = self.devices.as_ref().filter(|d| d.offered()) {
            let path = env
                .iter()
                .find(|(k, _)| k == "PATH")
                .map(|(_, v)| v.clone())
                .or_else(|| path.map(str::to_owned));
            let device = devices.env(thread, path.as_deref());
            env.retain(|(k, _)| !device.iter().any(|(d, _)| d == k));
            env.extend(device);
        }
        env
    }

    fn plugin_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = self
            .browser
            .as_ref()
            .map(|b| b.plugin_dirs())
            .unwrap_or_default();
        if let Some(devices) = self.devices.as_ref().filter(|d| d.offered()) {
            dirs.extend(devices.plugin_dirs());
        }
        dirs
    }

    fn item(&self, thread: &str, item: &ThreadItem) {
        if let Some(browser) = &self.browser {
            browser.item(thread, item);
        }
        if let Some(devices) = &self.devices {
            devices.item(thread, item);
        }
    }

    /// Only browsers fill logins from 1Password; an Android session fills none.
    fn filled_since(&self, thread: &str, known: usize) -> Option<crate::node::mask::Secrets> {
        self.browser
            .as_ref()
            .and_then(|b| b.filled_since(thread, known))
    }

    fn ended(&self, thread: &str) {
        if let Some(browser) = &self.browser {
            browser.ended(thread);
        }
        if let Some(devices) = &self.devices {
            devices.ended(thread);
        }
    }
}
