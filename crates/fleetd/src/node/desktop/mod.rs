//! Linux desktop sessions (W46): an agent opens one with `session_start` kind linux_desktop. The node lends it an X
//! display of its own from a warm pool (display.rs): a fresh container of the pinned image where the node has docker
//! or podman (container.rs), else an Xvfb with a fresh home directory. The agent drives it with its `desktop` tool
//! (Anthropic's computer-use actions, plus `launch`), which the node does itself over its own X11 connection
//! (x11.rs): it reads the screen and types and clicks through XTEST, so nothing but the session's apps and the node
//! reach the display. `session_end` throws the display away with everything on it.
//!
//! The session shares the browser sessions' recording (video from its frames, action log), upload, hub storage, live
//! view and takeover (node/browser); [`super::device::Router`] sends each session call to the kind it is for.
pub mod container;
pub mod display;
pub mod session;
pub mod x11;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fleetd_contracts::browser::{
    BrowserCallResult, BrowserControl, BrowserControlTo, BrowserRecordingEntry, BrowserSessionId,
    BrowserSessionState, BrowserTakeoverCall, DesktopBackend, DesktopCall, SessionEnded,
    SessionKind, SessionStarted, TakeoverRequested,
};
use fleetd_contracts::lead_calls::LeadCall;
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::node_link::{CAP_SESSION_DESKTOP, DesktopHealth, DesktopState, HubToNode};
use fleetd_contracts::prim::{Count, Text};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;

use self::container::Runtime;
use self::display::{Pool, Settings};
use self::session::{Opened, Session};
use super::browser::upload::{self, HubCalls};
use super::browser::{FrameSlot, SecretsFor};
use super::util::AbortOnDrop;

/// node.json's `desktop`: how this machine runs Linux desktop sessions. Every field is optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    /// False turns desktop sessions off on this machine; true also prepares them (builds the image, fills the pool)
    /// as the node starts. Absent: on, prepared when an agent first asks for a session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// `container` or `xvfb` only. Absent: a container where docker or podman works, else Xvfb.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<DesktopBackend>,
    /// The docker or podman to use instead of the one on the PATH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// An image to run instead of building the pinned one: it must start Xvfb on :0 with `-auth /fleetd/xauth`, as
    /// the pinned one's entry does (container.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// The Xvfb to use instead of the one on the PATH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xvfb: Option<String>,
    /// An ffmpeg to encode the video with (mjpeg in, libvpx-vp9 out). Absent: the browser's or the Android one's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ffmpeg: Option<String>,
    /// Displays kept started for the next sessions. Absent: 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<usize>,
    /// A session no action touched for this long is ended. Absent: 30.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_minutes: Option<u64>,
}

impl DesktopConfig {
    /// On unless node.json turns them off; Linux only (a container's X socket can't cross into macOS).
    pub fn enabled(&self) -> bool {
        self.enabled != Some(false) && cfg!(target_os = "linux")
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn refuse(code: ErrorCode, message: impl Into<String>, fix: &str) -> McpToolError {
    McpToolError::new(code, message).with_fix(fix)
}

fn new_id() -> BrowserSessionId {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    BrowserSessionId::unchecked(format!("B{hex}"))
}

pub fn desktop_dir(home: &Path) -> PathBuf {
    home.join("desktop")
}

/// Where the node keeps desktop recordings until the hub has them.
pub fn recordings_dir(home: &Path) -> PathBuf {
    desktop_dir(home).join("recordings")
}

fn state_path(home: &Path) -> PathBuf {
    desktop_dir(home).join("state.json")
}

/// The fix a person runs on a machine with neither.
const INSTALL_FIX: &str = "sudo apt install xvfb (or install docker or podman)";

/// What the node found, before it prepares anything: a usable runtime is checked only when it prepares.
fn choose(config: &DesktopConfig, home: &Path) -> (Option<Runtime>, Option<PathBuf>) {
    let runtime = match config.backend {
        Some(DesktopBackend::Xvfb) => None,
        _ => Runtime::find(config.runtime.as_deref(), home),
    };
    let xvfb = match config.backend {
        Some(DesktopBackend::Container) => None,
        _ => config
            .xvfb
            .clone()
            .map(PathBuf::from)
            .or_else(|| display::on_path("Xvfb")),
    };
    (runtime, xvfb)
}

fn health_of(
    state: DesktopState,
    backend: Option<DesktopBackend>,
    message: String,
    fix: Option<&str>,
) -> DesktopHealth {
    DesktopHealth {
        state,
        backend,
        message: Text::unchecked(message.chars().take(500).collect::<String>()),
        fix: fix.map(|f| Text::unchecked(f.chars().take(500).collect::<String>())),
    }
}

/// How long the node trusts its last `docker info` (or podman's).
const RUNTIME_CHECK_FRESH: Duration = Duration::from_secs(300);

/// Whether the container runtime answers: the last check while it's fresh, else a new one when `block` allows it
/// (`docker info`, up to 15 s), else None.
fn runtime_answers(runtime: &Runtime, block: bool) -> Option<Result<(), String>> {
    type Checked = Option<(Instant, PathBuf, Result<(), String>)>;
    static LAST: Mutex<Checked> = Mutex::new(None);
    if let Some((at, bin, answer)) = &*lock(&LAST)
        && *bin == runtime.bin
        && at.elapsed() < RUNTIME_CHECK_FRESH
    {
        return Some(answer.clone());
    }
    if !block {
        return None;
    }
    let answer = runtime.usable();
    *lock(&LAST) = Some((Instant::now(), runtime.bin.clone(), answer.clone()));
    Some(answer)
}

/// Whether desktop sessions can run here, and in what, for the doctor (each heartbeat; blocking): what the node last
/// found when it prepared them, else what it finds now, a container runtime counting only if it answers. None where
/// node.json turns them off, and where nothing works and node.json doesn't ask for them.
pub fn health(home: &Path, config: &DesktopConfig) -> Option<DesktopHealth> {
    health_with(home, config, true)
}

fn health_with(home: &Path, config: &DesktopConfig, block: bool) -> Option<DesktopHealth> {
    if !config.enabled() {
        return None;
    }
    if let Some(found) = std::fs::read(state_path(home))
        .ok()
        .and_then(|b| serde_json::from_slice::<DesktopHealth>(&b).ok())
    {
        return Some(found);
    }
    let (runtime, xvfb) = choose(config, home);
    let answers = runtime.as_ref().and_then(|r| runtime_answers(r, block));
    Some(match (runtime, answers, xvfb) {
        (Some(runtime), Some(Ok(())), _) => health_of(
            DesktopState::Ready,
            Some(DesktopBackend::Container),
            format!(
                "Desktop screens run in {} containers; the first one builds the image.",
                runtime.name()
            ),
            None,
        ),
        (runtime, answers, Some(xvfb)) => health_of(
            DesktopState::Ready,
            Some(DesktopBackend::Xvfb),
            format!(
                "Desktop screens run on Xvfb ({}) with a fresh home each{}.",
                xvfb.display(),
                match (runtime, answers) {
                    (Some(_), Some(Err(why))) => format!("; not in containers: {why}"),
                    (Some(_), _) => String::new(),
                    (None, _) => "; no docker or podman for containers".to_owned(),
                }
            ),
            None,
        ),
        _ if config.enabled != Some(true) => return None,
        (Some(runtime), Some(Err(why)), None) => health_of(
            DesktopState::Unavailable,
            Some(DesktopBackend::Container),
            format!("Desktop screens can't run here: {why}, and there's no Xvfb.",),
            Some(&format!(
                "sudo usermod -aG docker $USER (then log in again), or sudo apt install xvfb; {} must answer `{} info`",
                runtime.bin.display(),
                runtime.name()
            )),
        ),
        _ => health_of(
            DesktopState::Unavailable,
            None,
            "Desktop screens need docker or podman, or Xvfb; this machine has none that works."
                .into(),
            Some(INSTALL_FIX),
        ),
    })
}

/// What the node lists at its link's hello for desktop sessions. Never blocks: a container runtime not checked yet
/// counts only once a heartbeat has asked it.
pub fn capabilities(home: &Path) -> Vec<String> {
    let config = super::config::read_config(home)
        .ok()
        .flatten()
        .and_then(|c| c.desktop)
        .unwrap_or_default();
    match health_with(home, &config, false) {
        Some(h) if h.state == DesktopState::Ready => vec![CAP_SESSION_DESKTOP.to_owned()],
        _ => Vec::new(),
    }
}

/// An agent session's own working directory (its worktree), as this node started it; None for a session it doesn't
/// know.
pub type WorktreeFor = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

/// The folder a container session's apps see, read-only: the calling agent's own worktree, `known` as the node
/// started its session, never a folder the call names. A session hosted for an agent elsewhere sees none (its worktree
/// is on the agent's machine), nor does an Xvfb session, whose apps run on this machine already.
pub(super) fn worktree_mount(
    backend: DesktopBackend,
    thread: &str,
    known: Option<PathBuf>,
) -> Option<PathBuf> {
    if backend != DesktopBackend::Container || crate::node::session_route::hosted(thread) {
        return None;
    }
    let cwd = known?;
    let cwd = cwd.as_path();
    let home = crate::node::util::home_dir();
    let broad = cwd.parent().is_none() || cwd == home || home.starts_with(cwd);
    (cwd.is_absolute() && !broad && cwd.is_dir()).then(|| cwd.to_owned())
}

/// How long a `session_start` waits for the node to prepare desktop sessions (Xvfb, or an image already built takes
/// about a second) before it says to come back.
const PREPARE_WAIT: Duration = Duration::from_secs(30);

enum Prep {
    /// Nobody asked for a session yet: the first `session_start` prepares them.
    Wanted,
    Preparing,
    Ready(Arc<Pool>),
    Unavailable(String),
}

/// The node's Linux desktop sessions.
pub struct Desktops {
    home: PathBuf,
    config: DesktopConfig,
    prep: Mutex<Prep>,
    /// Live sessions by the agent session they belong to: one each.
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Agent sessions whose `session_start` is under way.
    starting: Arc<Mutex<HashSet<String>>>,
    hub: Arc<dyn HubCalls>,
    secrets_for: SecretsFor,
    worktree_for: WorktreeFor,
    uploading: Mutex<HashSet<PathBuf>>,
    /// Woken when preparing ends, either way.
    prepared: tokio::sync::Notify,
    _loop: Mutex<Option<AbortOnDrop>>,
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

impl Desktops {
    /// The node's desktop sessions. Nothing starts here unless node.json turns them on explicitly; the first
    /// linux_desktop `session_start` prepares them otherwise.
    pub async fn start(
        home: &Path,
        config: DesktopConfig,
        hub: Arc<dyn HubCalls>,
        secrets_for: SecretsFor,
        worktree_for: WorktreeFor,
    ) -> Arc<Self> {
        let _ = std::fs::remove_file(state_path(home));
        let desktops = Arc::new(Self {
            home: home.to_owned(),
            prep: Mutex::new(Prep::Wanted),
            sessions: Mutex::default(),
            starting: Arc::default(),
            hub,
            secrets_for,
            worktree_for,
            uploading: Mutex::default(),
            prepared: tokio::sync::Notify::new(),
            _loop: Mutex::default(),
            config,
        });
        if desktops.config.enabled == Some(true) {
            desktops.begin_prepare();
        } else if let (Some(runtime), _) = choose(&desktops.config, home) {
            // Ask the runtime now, so the next link's hello knows whether containers work.
            tokio::task::spawn_blocking(move || runtime_answers(&runtime, true));
        }
        let weak = Arc::downgrade(&desktops);
        *lock(&desktops._loop) = Some(AbortOnDrop(tokio::spawn(housekeeping(weak))));
        desktops
    }

    fn write_state(&self, health: &DesktopHealth) {
        let path = state_path(&self.home);
        if let Some(dir) = path.parent() {
            let _ = crate::node::config::mkdir_private(dir);
        }
        if let Ok(bytes) = serde_json::to_vec(health) {
            let _ = crate::node::secrets::write_atomic(&path, &bytes);
        }
    }

    /// Starts preparing, once: picks the backend, clears what a dead node left, builds the image if it must, then
    /// fills the pool.
    fn begin_prepare(self: &Arc<Self>) {
        {
            let mut prep = lock(&self.prep);
            if !matches!(*prep, Prep::Wanted | Prep::Unavailable(_)) {
                return;
            }
            *prep = Prep::Preparing;
        }
        let desktops = self.clone();
        tokio::spawn(async move {
            let home = desktops.home.clone();
            let config = desktops.config.clone();
            let preparing = desktops.clone();
            let prepared = tokio::task::spawn_blocking(move || {
                prepare(&home, &config, &|h| preparing.write_state(h))
            })
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
            match prepared {
                Ok(settings) => desktops.ready(settings),
                Err(why) => {
                    tracing::warn!(error = %why, "desktop sessions not prepared");
                    desktops.write_state(&health_of(
                        DesktopState::Unavailable,
                        None,
                        format!("Desktop screens can't run here: {why}."),
                        Some(INSTALL_FIX),
                    ));
                    *lock(&desktops.prep) = Prep::Unavailable(why);
                    desktops.prepared.notify_waiters();
                }
            }
        });
    }

    /// Makes the pool and starts filling it.
    pub fn ready(&self, settings: Settings) {
        let backend = settings.backend;
        let pool = Pool::new(settings, self.config.pool.unwrap_or(1));
        pool.refill();
        self.write_state(&health_of(
            DesktopState::Ready,
            Some(backend),
            match backend {
                DesktopBackend::Container => {
                    "Desktop screens run in containers of the pinned image.".into()
                }
                DesktopBackend::Xvfb => {
                    "Desktop screens run on Xvfb with a fresh home each.".into()
                }
            },
            None,
        ));
        *lock(&self.prep) = Prep::Ready(pool);
        self.prepared.notify_waiters();
    }

    /// The pool, once prepared: a start that finds preparing under way waits for it (up to [`PREPARE_WAIT`]), so the
    /// first session after a node starts isn't turned away while Xvfb or a built image takes its second.
    async fn pool(self: &Arc<Self>) -> Result<Arc<Pool>, McpToolError> {
        if matches!(*lock(&self.prep), Prep::Unavailable(_)) {
            // What failed is tried again by the next session that asks: a person may have fixed it.
            *lock(&self.prep) = Prep::Wanted;
        }
        // Once: a preparing that fails ends the wait with why, and the next start tries again.
        self.begin_prepare();
        let deadline = tokio::time::Instant::now() + PREPARE_WAIT;
        loop {
            let woken = self.prepared.notified();
            tokio::pin!(woken);
            // Registered before the state is read: an end of preparing in between still wakes it.
            woken.as_mut().enable();
            if !matches!(*lock(&self.prep), Prep::Preparing) {
                break;
            }
            if tokio::time::timeout_at(deadline, woken).await.is_err() {
                break;
            }
        }
        match &*lock(&self.prep) {
            Prep::Ready(pool) => Ok(pool.clone()),
            Prep::Wanted | Prep::Preparing => Err(refuse(
                ErrorCode::Failed,
                "This machine is still preparing desktop sessions (the first time, it builds their container \
                 image).",
                "try session_start again in a few minutes, or carry on without it",
            )),
            Prep::Unavailable(why) => Err(refuse(
                ErrorCode::Failed,
                format!("This machine can't host desktop sessions: {why}."),
                &format!(
                    "say so in your result: a person must run `{INSTALL_FIX}` on this machine"
                ),
            )),
        }
    }

    /// Whether sessions start at once now.
    pub fn ready_now(&self) -> bool {
        matches!(*lock(&self.prep), Prep::Ready(_))
    }

    /// Displays started for the next sessions.
    pub fn warm(&self) -> usize {
        match &*lock(&self.prep) {
            Prep::Ready(pool) => pool.warm(),
            _ => 0,
        }
    }

    pub fn live(&self, thread: &str) -> Option<Arc<Session>> {
        lock(&self.sessions).get(thread).cloned()
    }

    pub fn by_id(&self, id: &BrowserSessionId) -> Option<Arc<Session>> {
        lock(&self.sessions).values().find(|s| s.id == *id).cloned()
    }

    pub async fn session_start(
        self: &Arc<Self>,
        thread: String,
        cwd: String,
        purpose: String,
    ) -> Result<BrowserCallResult, McpToolError> {
        let mut stages = crate::stages::Stages::new("node desktop");
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
                format!("Desktop session {} is open.", open.id),
                "use it, or end it with session_end before starting another",
            ));
        }
        let pool = self.pool().await?;
        stages.done("prepare");
        let mount = worktree_mount(pool.backend(), &thread, (self.worktree_for)(&thread));
        let id = new_id();
        stages.id(id.as_str());
        let dir = recordings_dir(&self.home).join(id.as_str());
        // Made before a display is taken, so nothing after it fails with a display to throw away here.
        std::fs::create_dir_all(&dir).map_err(|e| {
            refuse(
                ErrorCode::Failed,
                format!("The node could not make the session's recording folder: {e}."),
                "say so in your result; the node's log says why",
            )
        })?;
        let secrets_for = self.secrets_for.clone();
        let secrets_thread = thread.clone();
        let secrets = tokio::task::spawn_blocking(move || secrets_for(&secrets_thread));
        let didnt_start = |why: String| {
            refuse(
                ErrorCode::Failed,
                format!("The desktop did not start: {why}."),
                "try session_start again",
            )
        };
        let warm = pool.warm();
        let display = pool.take(mount.as_deref()).await.map_err(|why| {
            let _ = std::fs::remove_dir_all(&dir);
            didnt_start(why)
        })?;
        stages.done(if warm > 0 {
            "warm display"
        } else {
            "cold display"
        });
        // Connecting, and throwing away a display that can't be used, wait on its X server and runtime.
        let (display, x) = tokio::task::spawn_blocking(move || {
            let x = display.connect();
            x.map(|x| (display, x))
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|c| c)
        .map_err(|why| {
            let _ = std::fs::remove_dir_all(&dir);
            didnt_start(why)
        })?;
        stages.done("connect");
        let secrets = match secrets.await.map_err(|e| e.to_string()).and_then(|m| m) {
            Ok(secrets) => secrets,
            Err(why) => {
                let _ = tokio::task::spawn_blocking(move || drop(display)).await;
                let _ = std::fs::remove_dir_all(&dir);
                return Err(refuse(
                    ErrorCode::Failed,
                    format!(
                        "The node could not read this session's secrets to scrub its recording ({why})."
                    ),
                    "try again; if it keeps failing, check the node's log",
                ));
            }
        };
        stages.done("secrets");
        let backend = display.backend;
        let session = Session::open(
            display,
            x,
            Opened {
                dir: dir.clone(),
                id,
                thread: thread.clone(),
                cwd,
                purpose: purpose.clone(),
                ffmpeg: self.ffmpeg(),
                secrets,
            },
        );
        lock(&self.sessions).insert(thread.clone(), session.clone());
        session.step(
            "session_start",
            json!({
                "purpose": purpose, "kind": "linux_desktop", "backend": backend.as_str(),
                "worktree": mount.as_ref().map(|m| m.to_string_lossy()),
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
            udid: None,
            desktop: Some(backend),
            worktree: mount.map(|m| Text::unchecked(m.to_string_lossy().into_owned())),
            start_ms: {
                stages.done("session open");
                stages.total_ms()
            },
        }))
    }

    /// node.json's ffmpeg, else one the browser or Android sessions installed.
    fn ffmpeg(&self) -> Option<PathBuf> {
        self.config
            .ffmpeg
            .clone()
            .map(PathBuf::from)
            .or_else(|| {
                let android = super::device::sdk::Sdk::at(&self.home).ffmpeg;
                android.is_file().then_some(android)
            })
            .or_else(|| {
                super::browser::chrome::find_ffmpeg(&super::browser::chrome::install_dir(
                    &self.home,
                ))
            })
    }

    pub async fn session_end(
        self: &Arc<Self>,
        thread: &str,
    ) -> Result<BrowserCallResult, McpToolError> {
        let session = lock(&self.sessions).remove(thread).ok_or_else(|| {
            refuse(
                ErrorCode::NotFound,
                "No desktop session is open.",
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
            kind: SessionKind::LinuxDesktop,
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
        let desktops = self.clone();
        let dir = session.dir.clone();
        tokio::spawn(async move { desktops.upload(&dir).await });
        ended
    }

    /// Uploads a recording as the browser broker does (node/browser/upload.rs).
    async fn upload(&self, dir: &Path) {
        if !lock(&self.uploading).insert(dir.to_owned()) {
            return;
        }
        if let Err(why) = upload::upload(self.hub.as_ref(), dir).await {
            tracing::warn!(dir = %dir.display(), error = %why, "desktop recording not uploaded yet");
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
                tracing::warn!(error = %e.message, "desktop session not reported to the hub");
            }
        });
    }

    /// The agent's `desktop` action, on its live session. Refused while a person has control; the first after a
    /// handback gives the desktop back to the agent.
    pub async fn act(
        &self,
        thread: &str,
        call: DesktopCall,
    ) -> Result<BrowserCallResult, McpToolError> {
        let session = self.live(thread).ok_or_else(|| {
            refuse(
                ErrorCode::NotFound,
                "No desktop session is open.",
                "start one with session_start kind linux_desktop",
            )
        })?;
        match session.control() {
            BrowserControl::Human => {
                return Err(refuse(
                    ErrorCode::Invalid,
                    "A person has control of this desktop.",
                    "carry on with what you can without it; once they hand it back, take a screenshot first: they \
                     may have changed things",
                ));
            }
            BrowserControl::HandingBack => {
                session.set_control(BrowserControl::Agent, "agent");
                session.step("agent_resumed", json!({}), true, None, 0);
                self.report(&session, BrowserSessionState::Live);
            }
            BrowserControl::Agent => {}
        }
        session
            .act(call)
            .await
            .map(BrowserCallResult::Desktop)
            .map_err(|why| {
                refuse(
                    ErrorCode::Failed,
                    why,
                    "check the action's arguments, take a screenshot, and try again",
                )
            })
    }

    /// An agent's `request_takeover`: the hub lists it under "waiting on you".
    pub async fn request_takeover(
        &self,
        thread: &str,
        reason: fleetd_contracts::prim::Line<1, 500>,
    ) -> Result<BrowserCallResult, McpToolError> {
        let session = self.live(thread).ok_or_else(|| {
            refuse(
                ErrorCode::NotFound,
                "No desktop session is open.",
                "start one with session_start",
            )
        })?;
        let call = LeadCall::BrowserTakeover(BrowserTakeoverCall {
            session_id: session.id.clone(),
            reason: reason.clone(),
        });
        self.hub.call(thread, &session.cwd, call).await?;
        session.step(
            "request_takeover",
            json!({ "reason": reason.as_str() }),
            true,
            None,
            0,
        );
        Ok(BrowserCallResult::RequestTakeover(TakeoverRequested {
            message: "Asked: it shows under waiting on you. Carry on with what you can; while a person has control \
                      your desktop actions answer so, and after they hand it back take a screenshot first."
                .into(),
        }))
    }

    /// A live-view frame from the hub for one of these sessions: a watch, a person's input, a change of control.
    /// False when the session isn't one of these.
    pub fn from_hub(&self, frame: &HubToNode, frames: &Arc<FrameSlot>) -> bool {
        match frame {
            HubToNode::BrowserWatch(watch) => {
                let Some(session) = self.by_id(&watch.session_id) else {
                    return false;
                };
                session.set_watcher(watch.on.then(|| frames.clone()));
            }
            HubToNode::BrowserInput(input) => {
                let Some(session) = self.by_id(&input.session_id) else {
                    return false;
                };
                session.queue_input(input.input.clone());
            }
            HubToNode::BrowserControl(control) => {
                let Some(session) = self.by_id(&control.session_id) else {
                    return false;
                };
                self.control(&session, control.control, control.by.as_str());
            }
            _ => return false,
        }
        true
    }

    /// A person takes a session over, or hands it back.
    pub fn control(&self, session: &Session, to: BrowserControlTo, by: &str) {
        let next = match (to, session.control()) {
            (BrowserControlTo::Human, BrowserControl::Human) => return,
            (BrowserControlTo::Human, _) => BrowserControl::Human,
            (BrowserControlTo::Agent, BrowserControl::Human) => BrowserControl::HandingBack,
            (BrowserControlTo::Agent, _) => return,
        };
        session.set_control(next, by);
        self.report(session, BrowserSessionState::Live);
    }

    /// The agent session ended: its desktop session ends too, and its recording goes to the hub now.
    pub fn ended(self: &Arc<Self>, thread: &str) {
        let Some(session) = lock(&self.sessions).remove(thread) else {
            return;
        };
        let desktops = self.clone();
        tokio::spawn(async move {
            session.step("agent_session_ended", json!({}), true, None, 0);
            desktops.close(session).await;
        });
    }

    /// Ends every live session (the node stops); their recordings go at the node's next start.
    pub async fn shutdown(self: &Arc<Self>) {
        let all: Vec<Arc<Session>> = lock(&self.sessions).drain().map(|(_, s)| s).collect();
        for session in all {
            session.close().await;
        }
        let drained = match &*lock(&self.prep) {
            Prep::Ready(pool) => pool.drain(),
            _ => Vec::new(),
        };
        let _ = tokio::task::spawn_blocking(move || drop(drained)).await;
    }
}

/// Picks the backend and gets it ready (blocking): a usable container runtime and its image, else Xvfb.
fn prepare(
    home: &Path,
    config: &DesktopConfig,
    state: &dyn Fn(&DesktopHealth),
) -> Result<Settings, String> {
    let (runtime, xvfb) = choose(config, home);
    let runtime = match runtime.map(|r| r.usable().map(|()| r)) {
        Some(Ok(runtime)) => Some(runtime),
        Some(Err(why)) if config.backend == Some(DesktopBackend::Container) || xvfb.is_none() => {
            return Err(why);
        }
        Some(Err(why)) => {
            tracing::info!(error = %why, "desktop sessions use Xvfb: the container runtime doesn't answer");
            None
        }
        None => None,
    };
    let root = desktop_dir(home).join("displays");
    let cleared = display::clear_leftovers(&root, runtime.as_ref());
    if cleared > 0 {
        tracing::info!(
            cleared,
            "desktop displays a stopped node left running were cleared"
        );
    }
    crate::node::config::mkdir_private(&root)
        .map_err(|e| format!("cannot make {}: {e}", root.display()))?;
    match (runtime, xvfb) {
        (Some(runtime), xvfb) => {
            let image = config.image.clone().unwrap_or_else(container::image);
            if config.image.is_none() && !runtime.has_image(&image) {
                state(&health_of(
                    DesktopState::Preparing,
                    Some(DesktopBackend::Container),
                    format!(
                        "Building the desktop sessions' container image with {}.",
                        runtime.name()
                    ),
                    None,
                ));
                let log = desktop_dir(home).join("build.log");
                if let Err(why) = runtime.build(&image, &desktop_dir(home), &log) {
                    // No image (no network, a slow snapshot server): Xvfb still serves, and the next start of the
                    // node tries the build again.
                    let Some(xvfb) = xvfb.filter(|_| config.backend.is_none()) else {
                        return Err(why);
                    };
                    tracing::warn!(error = %why, "desktop sessions use Xvfb: the container image didn't build");
                    return Ok(Settings {
                        backend: DesktopBackend::Xvfb,
                        runtime: None,
                        image: String::new(),
                        xvfb: Some(xvfb),
                        root,
                    });
                }
            }
            Ok(Settings {
                backend: DesktopBackend::Container,
                runtime: Some(runtime),
                image,
                xvfb,
                root,
            })
        }
        (None, Some(xvfb)) => Ok(Settings {
            backend: DesktopBackend::Xvfb,
            runtime: None,
            image: String::new(),
            xvfb: Some(xvfb),
            root,
        }),
        (None, None) => Err("this machine has neither docker or podman nor Xvfb".into()),
    }
}

/// Every minute: ends sessions idle past the limit, and sends the recordings still waiting for the hub.
async fn housekeeping(desktops: std::sync::Weak<Desktops>) {
    let mut uploading: Option<tokio::task::JoinHandle<()>> = None;
    loop {
        let Some(this) = desktops.upgrade() else {
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
            tracing::info!(session = %session.id, "desktop session idle; ending it");
            this.close(session).await;
        }
        if uploading.as_ref().is_none_or(|u| u.is_finished()) {
            let live: Vec<String> = lock(&this.sessions)
                .values()
                .map(|s| s.id.to_string())
                .collect();
            let waiting = upload::waiting_in(&recordings_dir(&this.home), &live);
            let desktops = this.clone();
            uploading = Some(tokio::spawn(async move {
                for dir in waiting {
                    desktops.upload(&dir).await;
                }
            }));
        }
        drop(this);
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}
