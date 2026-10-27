//! The node's browser session broker (W46). An agent opens a session with its fleetd tool `session_start`, which the
//! node answers itself (lead.rs hands it here): the broker takes a warm Chrome from its pool (a fresh process with an
//! empty profile, thrown away at the end), started with `--remote-debugging-pipe`, so the node holds the browser's
//! only connection. The agent drives it with agent-browser (agent_browser.rs), which reaches it only through the
//! broker's proxy (proxy.rs) at the URL its session's environment names. The broker's own use of the connection
//! records the screencast as video; each tool call of the agent's that drove the browser goes into the action log
//! with the page's DOM after it. At the end the recording is scrubbed once more and uploaded to the hub (upload.rs).
pub mod agent_browser;
pub mod cdp;
pub mod chrome;
pub mod credentials;
pub mod onepassword;
pub mod proxy;
pub mod record;
pub mod session;
pub mod shapes;
pub mod upload;

#[cfg(test)]
pub(crate) mod tests;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fleetd_contracts::browser::{
    BrowserCall, BrowserCallFrame, BrowserCallResult, BrowserControl, BrowserControlTo,
    BrowserInput, BrowserRecordingEntry, BrowserResultFrame, BrowserSessionId, BrowserSessionState,
    BrowserTakeoverCall, SessionEnded, SessionStarted, TakeoverRequested,
};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::node_link::HubToNode;
use fleetd_contracts::prim::{Count, Text};
use fleetd_contracts::sessions::{ItemKind, ItemStatus, ThreadItem};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;

use self::chrome::{Launch, Pool};
use self::proxy::Proxy;
use self::session::{Opened, Session};
use self::upload::HubCalls;
use super::util::AbortOnDrop;
use crate::node::mask::Secrets;

/// node.json's `browser`: how this machine runs browser sessions. Every field is optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConfig {
    /// False turns browser sessions off on this machine; true also installs the browser as the node starts. Absent:
    /// on, installed when an agent first asks for a session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// A Chrome or headless shell to use instead of the node's pinned install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chrome: Option<String>,
    /// An ffmpeg to encode the video with instead of the pinned one (it needs mjpeg in and libvpx-vp9 out).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ffmpeg: Option<String>,
    /// Browsers kept launched for the next sessions. Absent: 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<usize>,
    /// Chrome's own sandbox: true requires it, false turns it off. Absent: on wherever this host allows it, else off
    /// (a host without unprivileged user namespaces, such as Ubuntu 24.04 with its AppArmor default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<bool>,
    /// A session no tool call touched for this long is ended. Absent: 30.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_minutes: Option<u64>,
}

impl BrowserConfig {
    pub fn enabled(&self) -> bool {
        self.enabled != Some(false)
    }
}

/// Where the broker's browser comes from.
enum Install {
    Ready(Arc<Pool>),
    /// Not installed, and nobody asked for a session yet: the first `session_start` installs it.
    Wanted,
    Installing,
    Missing(String),
}

/// How long a session's start waits for the browser's install in progress: with the browser's launch after it
/// (chrome.rs), inside the agent's wait for the node's answer (cli/agent_mcp.rs, 60 s).
pub(crate) const INSTALL_WAIT: Duration = Duration::from_secs(30);

/// The secrets of an agent session, by its id (blocking: it reads them); `Err` is why they can't be read.
pub type SecretsFor = Arc<dyn Fn(&str) -> Result<Secrets, String> + Send + Sync>;

pub type BrowserHandler = Arc<
    dyn Fn(String, BrowserCallFrame) -> Pin<Box<dyn Future<Output = BrowserResultFrame> + Send>>
        + Send
        + Sync,
>;

/// What the node's sessions ask of the broker: the environment a session's claude starts with, and each of its
/// tool calls as it ends.
pub trait SessionHooks: Send + Sync + 'static {
    fn env(&self, thread: &str, path: Option<&str>) -> Vec<(String, String)>;
    /// Plugins of skills for the session: agent-browser's (and agent-device's, node/device).
    fn plugin_dirs(&self) -> Vec<PathBuf>;
    fn item(&self, thread: &str, item: &ThreadItem);
    /// The session's claude exited (it finished, was stopped or idled out, or crashed).
    fn ended(&self, thread: &str);
    /// The values filled into the session's browsers from 1Password, when there are more than `known`: masked in what
    /// the session reports, as its own secrets are.
    fn filled_since(&self, thread: &str, known: usize) -> Option<Secrets>;
}

pub struct Broker {
    /// Itself, for the hooks the node's sessions call through a plain reference.
    me: std::sync::Weak<Broker>,
    home: PathBuf,
    config: BrowserConfig,
    install: Mutex<Install>,
    /// Told when the install is done, ready or failed: for the starts waiting on it.
    install_done: tokio::sync::watch::Sender<()>,
    ffmpeg: Mutex<Option<PathBuf>>,
    proxy: Mutex<Option<Arc<Proxy>>>,
    /// Live sessions by the agent session they belong to: one each.
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Agent sessions whose browser is starting: a second start meanwhile is refused before it launches anything.
    starting: Mutex<HashSet<String>>,
    hub: Arc<dyn HubCalls>,
    secrets_for: SecretsFor,
    /// 1Password: each session's vault and what it resolved (credentials.rs).
    credentials: credentials::Credentials,
    /// Recordings being uploaded now: one upload each.
    uploading: Mutex<HashSet<PathBuf>>,
    /// Reports for the hub, sent in order by one task.
    reports: tokio::sync::mpsc::UnboundedSender<Report>,
    /// Agent sessions whose browser the hub placed on another machine: the proxy pipes their driver to the hub's
    /// relay at this URL instead (node/relay.rs).
    remotes: Mutex<HashMap<String, crate::node::relay::Remote>>,
    /// One install of agent-browser at a time: the first session's, or a session on another machine's.
    driver_install: tokio::sync::Mutex<()>,
    _loop: Mutex<Option<AbortOnDrop>>,
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

/// The screen frames waiting for the hub's link: the newest of each watched session, which replaces any not sent
/// yet. The link's writer sends every other frame first and these only when it is free, so a slow link skips screens
/// rather than queueing them, and never holds up a call's answer or a recording's piece.
#[derive(Default)]
pub struct FrameSlot {
    frames: Mutex<std::collections::BTreeMap<String, String>>,
    pub notify: tokio::sync::Notify,
}

impl FrameSlot {
    /// A session's newest frame, in place of one not sent yet.
    pub fn replace(&self, session: &str, frame: String) {
        lock(&self.frames).insert(session.to_owned(), frame);
        self.notify.notify_one();
    }

    /// Everything waiting, to send now.
    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *lock(&self.frames))
            .into_values()
            .collect()
    }
}

/// A call for the hub about a session, sent after those before it; `answer` when the caller waits for it.
struct Report {
    thread: String,
    cwd: String,
    call: LeadCall,
    answer: Option<tokio::sync::oneshot::Sender<Result<LeadCallResult, McpToolError>>>,
}

/// An agent session's start in progress, until it returns.
struct Starting<'a>(&'a Broker, String);

impl Drop for Starting<'_> {
    fn drop(&mut self) {
        lock(&self.0.starting).remove(&self.1);
    }
}

/// Whether a command the agent ran drove its browser.
pub fn drives_browser(command: &str) -> bool {
    command.contains("agent-browser")
}

impl Broker {
    /// The broker for a node: its browser from node.json, else the pinned installs. Missing ones are installed when
    /// an agent first asks for a session, or at once when node.json turns browser sessions on explicitly.
    pub async fn start(
        home: &Path,
        config: BrowserConfig,
        hub: Arc<dyn HubCalls>,
        secrets_for: SecretsFor,
    ) -> Arc<Self> {
        let root = chrome::install_dir(home);
        let chrome = config
            .chrome
            .clone()
            .map(PathBuf::from)
            .or_else(|| chrome::find_chrome(&root));
        let broker = Self::open(home, config, hub, secrets_for).await;
        match chrome {
            Some(chrome) if agent_browser::find(home).is_some() => broker.ready(chrome),
            _ => {
                *lock(&broker.install) = Install::Wanted;
                if broker.config.enabled == Some(true) {
                    broker.begin_install();
                }
            }
        }
        broker
    }

    /// Starts installing what is missing, once.
    fn begin_install(self: &Arc<Self>) {
        {
            let mut install = lock(&self.install);
            if !matches!(*install, Install::Wanted) {
                return;
            }
            *install = Install::Installing;
        }
        let root = chrome::install_dir(&self.home);
        let chrome = self.config.chrome.is_none() && chrome::find_chrome(&root).is_none();
        let agent_browser = agent_browser::find(&self.home).is_none();
        let installing = self.clone();
        tokio::spawn(async move { installing.install(chrome, agent_browser).await });
    }

    /// The broker with its proxy and housekeeping running, but no browser yet ([`Broker::ready`] gives it one).
    pub async fn open(
        home: &Path,
        config: BrowserConfig,
        hub: Arc<dyn HubCalls>,
        secrets_for: SecretsFor,
    ) -> Arc<Self> {
        let ffmpeg = config
            .ffmpeg
            .clone()
            .map(PathBuf::from)
            .or_else(|| chrome::find_ffmpeg(&chrome::install_dir(home)));
        let broker = Arc::new_cyclic(|me| Self {
            me: me.clone(),
            home: home.to_owned(),
            install: Mutex::new(Install::Installing),
            install_done: tokio::sync::watch::Sender::new(()),
            ffmpeg: Mutex::new(ffmpeg),
            proxy: Mutex::default(),
            sessions: Mutex::default(),
            starting: Mutex::default(),
            hub: hub.clone(),
            secrets_for,
            credentials: credentials::Credentials::new(home),
            uploading: Mutex::default(),
            reports: {
                let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Report>();
                let hub = hub.clone();
                tokio::spawn(async move {
                    while let Some(report) = rx.recv().await {
                        let answer = hub.call(&report.thread, &report.cwd, report.call).await;
                        match report.answer {
                            Some(waiting) => {
                                let _ = waiting.send(answer);
                            }
                            None => {
                                if let Err(e) = answer {
                                    tracing::warn!(error = %e.message, "browser session not reported to the hub");
                                }
                            }
                        }
                    }
                });
                tx
            },
            remotes: Mutex::default(),
            driver_install: tokio::sync::Mutex::const_new(()),
            _loop: Mutex::default(),
            config,
        });
        match Proxy::start(Arc::downgrade(&broker)).await {
            Ok(proxy) => *lock(&broker.proxy) = Some(proxy),
            Err(e) => tracing::warn!(error = %e, "browser proxy not started"),
        }
        let weak = Arc::downgrade(&broker);
        *lock(&broker._loop) = Some(AbortOnDrop(tokio::spawn(housekeeping(weak))));
        broker
    }

    /// Installs what is missing (blocking work, off the async threads), then makes the pool.
    async fn install(&self, chrome: bool, agent_browser: bool) {
        let home = self.home.clone();
        let _one = self.driver_install.lock().await;
        let installed = tokio::task::spawn_blocking(move || {
            if agent_browser && agent_browser::find(&home).is_none() {
                agent_browser::install(&home)?;
            }
            if chrome {
                chrome::install(&home)?;
            }
            Ok::<(), String>(())
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
        let root = chrome::install_dir(&self.home);
        let found = self
            .config
            .chrome
            .clone()
            .map(PathBuf::from)
            .or_else(|| chrome::find_chrome(&root));
        match installed.and_then(|()| found.ok_or_else(|| "the install left no browser".to_owned()))
        {
            Ok(found) => {
                let mut ffmpeg = lock(&self.ffmpeg);
                if ffmpeg.is_none() {
                    *ffmpeg = chrome::find_ffmpeg(&root);
                }
                drop(ffmpeg);
                self.ready(found);
            }
            Err(why) => {
                tracing::warn!(error = %why, "browser not installed");
                self.set_install(Install::Missing(why));
            }
        }
    }

    /// Makes the pool of `chrome` and starts filling it.
    pub fn ready(&self, chrome: PathBuf) {
        let pool = Pool::new(
            Launch {
                chrome,
                profiles: self.home.join("browser").join("profiles"),
                sandbox: self.config.sandbox,
            },
            self.config.pool.unwrap_or(1),
        );
        // Profiles a node left behind when it stopped.
        let _ = std::fs::remove_dir_all(&pool.launch_settings().profiles);
        pool.refill();
        self.set_install(Install::Ready(pool));
    }

    fn set_install(&self, install: Install) {
        *lock(&self.install) = install;
        self.install_done.send_replace(());
    }

    /// The pool, once the browser is installed: a start during the install waits for it, up to [`INSTALL_WAIT`].
    async fn pool(self: &Arc<Self>) -> Result<Arc<Pool>, McpToolError> {
        self.begin_install();
        let mut done = self.install_done.subscribe();
        let deadline = tokio::time::Instant::now() + INSTALL_WAIT;
        loop {
            match &*lock(&self.install) {
                Install::Ready(pool) => return Ok(pool.clone()),
                Install::Wanted | Install::Installing => {}
                Install::Missing(why) => {
                    return Err(refuse(
                        ErrorCode::Failed,
                        format!("This machine has no browser for sessions: {why}."),
                        "say so in your result: a person must set up the browser on this machine (fleetd docs: \
                         Browser sessions)",
                    ));
                }
            }
            if !matches!(
                tokio::time::timeout_at(deadline, done.changed()).await,
                Ok(Ok(()))
            ) {
                return Err(refuse(
                    ErrorCode::Failed,
                    "This machine is still installing its browser.",
                    "try session_start again in a few minutes",
                ));
            }
        }
    }

    /// Browsers ready for the next sessions.
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

    /// An agent session's browser runs on another machine (Some: the hub's relay for it), or no longer does (None).
    /// Its driver's connections to the proxy then go there, under the same agent-browser policy as a session here.
    pub fn set_remote(&self, thread: &str, relay: Option<crate::node::relay::Remote>) {
        let mut remotes = lock(&self.remotes);
        match relay {
            Some(remote) => {
                if let Err(e) = agent_browser::write_policy(&self.home, thread, false) {
                    tracing::warn!(error = %e, "agent-browser policy not written");
                }
                remotes.insert(thread.to_owned(), remote);
            }
            None => {
                remotes.remove(thread);
            }
        }
    }

    /// agent-browser, for a session whose browser runs on another machine: this machine's agent drives it from here.
    /// Installs it (and not Chrome) when it is missing, as the first session here would.
    pub async fn ensure_driver(&self) -> Result<(), String> {
        let _one = self.driver_install.lock().await;
        if agent_browser::find(&self.home).is_some() {
            return Ok(());
        }
        let home = self.home.clone();
        tokio::task::spawn_blocking(move || agent_browser::install(&home).map(|_| ()))
            .await
            .unwrap_or_else(|e| Err(e.to_string()))
    }

    /// The hub's relay for an agent session whose browser runs on another machine.
    pub fn remote(&self, thread: &str) -> Option<crate::node::relay::Remote> {
        lock(&self.remotes).get(thread).cloned()
    }

    /// The proxy URL of an agent session, its `AGENT_BROWSER_CDP`.
    pub fn cdp_url(&self, thread: &str) -> Option<String> {
        lock(&self.proxy).as_ref().map(|p| p.url(thread))
    }

    /// Answers one browser tool call of an agent's. The session is the one its process runs in.
    pub async fn handle(
        self: &Arc<Self>,
        thread: String,
        frame: BrowserCallFrame,
    ) -> BrowserResultFrame {
        let id = frame.id.clone();
        let outcome = self.answer(thread, frame).await;
        let (result, error) = match outcome {
            Ok(result) => (Some(result), None),
            Err(error) => (None, Some(error)),
        };
        serde_json::from_value(json!({ "id": id, "result": result, "error": error }))
            .expect("a browser result frame with exactly one of result and error")
    }

    async fn answer(
        self: &Arc<Self>,
        thread: String,
        frame: BrowserCallFrame,
    ) -> Result<BrowserCallResult, McpToolError> {
        match frame.call {
            BrowserCall::SessionStart(call) => {
                self.session_start(thread, frame.cwd.to_string(), call.purpose.to_string())
                    .await
            }
            BrowserCall::SessionEnd(_) => self.session_end(&thread).await,
            BrowserCall::RequestTakeover(call) => self.request_takeover(&thread, call.reason).await,
            BrowserCall::FillCredential(call) => {
                credentials::fill_credential(self, &thread, call).await
            }
            BrowserCall::Desktop(_) => Err(refuse(
                ErrorCode::Invalid,
                "The desktop tool drives desktop sessions, not browsers.",
                "drive the browser with agent-browser",
            )),
        }
    }

    async fn session_start(
        self: &Arc<Self>,
        thread: String,
        cwd: String,
        purpose: String,
    ) -> Result<BrowserCallResult, McpToolError> {
        let started = Instant::now();
        if let Some(open) = self.live(&thread) {
            return Err(refuse(
                ErrorCode::Invalid,
                format!("Browser session {} is open.", open.id),
                "use it, or end it with session_end before starting another",
            ));
        }
        if !lock(&self.starting).insert(thread.clone()) {
            return Err(refuse(
                ErrorCode::Invalid,
                "Your browser session is starting.",
                "wait for that session_start's answer",
            ));
        }
        let _starting = Starting(self, thread.clone());
        let Some(cdp) = self.cdp_url(&thread) else {
            return Err(refuse(
                ErrorCode::Failed,
                "This machine's browser proxy is not running.",
                "say so in your result; the node's log says why",
            ));
        };
        let pool = self.pool().await?;
        let secrets_for = self.secrets_for.clone();
        let secrets_thread = thread.clone();
        let secrets = tokio::task::spawn_blocking(move || secrets_for(&secrets_thread));
        let browser = pool.take().await.map_err(|why| {
            refuse(
                ErrorCode::Failed,
                format!("The browser did not start: {why}."),
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
                    format!(
                        "The node could not read this session's secrets to scrub its recording ({why})."
                    ),
                    "try again; if it keeps failing, check the node's log",
                )
            })?;
        let id = new_id();
        let ffmpeg = lock(&self.ffmpeg).clone();
        let dir = upload::recordings_dir(&self.home).join(id.as_str());
        let session = Session::open(
            browser,
            Opened {
                dir: dir.clone(),
                id,
                thread: thread.clone(),
                cwd,
                purpose: purpose.clone(),
                ffmpeg,
                secrets,
            },
        )
        .await
        .map_err(|why| {
            // Nothing was recorded: no folder is left for the uploader to find.
            let _ = std::fs::remove_dir_all(&dir);
            refuse(
                ErrorCode::Failed,
                format!("The browser did not start: {why}."),
                "try session_start again",
            )
        })?;
        lock(&self.sessions).insert(thread.clone(), session.clone());
        {
            let broker = Arc::downgrade(self);
            let thread = thread.clone();
            session.on_control(Arc::new(move |_| {
                if let Some(broker) = broker.upgrade()
                    && let Some(session) = broker.live(&thread)
                {
                    session.step("agent_resumed", json!({}), true, None, 0);
                    broker.report(&session, BrowserSessionState::Live);
                }
            }));
        }
        if let Err(e) = agent_browser::write_policy(&self.home, &thread, false) {
            tracing::warn!(session = %session.id, error = %e, "agent-browser policy not written");
        }
        session.step(
            "session_start",
            json!({ "purpose": purpose }),
            true,
            None,
            0,
        );
        self.report(&session, BrowserSessionState::Live);
        Ok(BrowserCallResult::SessionStart(SessionStarted {
            session_id: session.id.clone(),
            cdp: Some(Text::unchecked(cdp)),
            serial: None,
            udid: None,
            desktop: None,
            worktree: None,
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
                "No browser session is open.",
                "nothing to end",
            )
        })?;
        Ok(BrowserCallResult::SessionEnd(self.close(session).await))
    }

    /// Ends a session the broker already took out of its map, and starts its upload.
    async fn close(self: &Arc<Self>, session: Arc<Session>) -> SessionEnded {
        session.step("session_end", json!({}), true, None, 0);
        self.credentials.forget(session.id.as_str());
        let files = session.close().await;
        let ended = SessionEnded {
            session_id: session.id.clone(),
            kind: fleetd_contracts::browser::SessionKind::Browser,
            files: files
                .iter()
                .map(|(file, bytes)| BrowserRecordingEntry {
                    file: *file,
                    bytes: Count::unchecked(*bytes as i64),
                })
                .collect(),
            note: session.note(),
        };
        let broker = self.clone();
        let dir = session.dir.clone();
        tokio::spawn(async move { broker.upload(&dir).await });
        ended
    }

    /// Uploads a recording unless an upload of it runs already; one that fails waits for the next try, and one
    /// failing past [`upload::GIVE_UP`] is given up.
    async fn upload(&self, dir: &Path) {
        if !lock(&self.uploading).insert(dir.to_owned()) {
            return;
        }
        if let Err(why) = upload::upload(self.hub.as_ref(), dir).await {
            tracing::warn!(dir = %dir.display(), error = %why, "browser recording not uploaded yet");
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

    /// Tells the hub where a session is now, in the background, after what was reported before.
    fn report(&self, session: &Session, state: BrowserSessionState) {
        let call = upload::report(&session.meta(None), state, session.control(), &[]);
        let _ = self.reports.send(Report {
            thread: session.thread.clone(),
            cwd: session.cwd.clone(),
            call,
            answer: None,
        });
    }

    /// A call about a session, after every report before it (a takeover request never reaches the hub before the
    /// session it is about), and its answer.
    async fn in_turn(
        &self,
        session: &Session,
        call: LeadCall,
    ) -> Result<LeadCallResult, McpToolError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let report = Report {
            thread: session.thread.clone(),
            cwd: session.cwd.clone(),
            call,
            answer: Some(tx),
        };
        if self.reports.send(report).is_err() {
            return Err(refuse(
                ErrorCode::Failed,
                "The node is stopping.",
                "try again shortly",
            ));
        }
        rx.await.unwrap_or_else(|_| {
            Err(refuse(
                ErrorCode::Failed,
                "The node is stopping.",
                "try again shortly",
            ))
        })
    }

    /// A live session by its id.
    /// Whether a session of this id is live here.
    pub fn holds(&self, id: &BrowserSessionId) -> bool {
        self.by_id(id).is_some()
    }

    fn by_id(&self, id: &BrowserSessionId) -> Option<Arc<Session>> {
        lock(&self.sessions).values().find(|s| s.id == *id).cloned()
    }

    /// A frame from the hub for a session: a watch (frames go to the link's `frames` slot from then on), a person's
    /// input, a change of control. Never blocks the link's loop.
    pub fn from_hub(&self, frame: HubToNode, frames: &Arc<FrameSlot>) {
        match frame {
            HubToNode::BrowserWatch(watch) => {
                self.watch(&watch.session_id, watch.on.then(|| frames.clone()))
            }
            HubToNode::BrowserInput(input) => self.input(&input.session_id, input.input),
            HubToNode::BrowserControl(control) => {
                self.control(&control.session_id, control.control, control.by.as_str())
            }
            _ => {}
        }
    }

    /// The hub watches a session (its link, to send frames on) or no more.
    pub fn watch(&self, id: &BrowserSessionId, frames: Option<Arc<FrameSlot>>) {
        if let Some(session) = self.by_id(id) {
            session.set_watcher(frames);
        }
    }

    /// A person's input from the app, for a session they took over.
    pub fn input(&self, id: &BrowserSessionId, input: BrowserInput) {
        if let Some(session) = self.by_id(id) {
            session.queue_input(input);
        }
    }

    /// A person takes a session over, or hands it back: the agent's commands wait meanwhile (the proxy answers them
    /// that a person has control), and its next command after a handback takes control again.
    pub fn control(&self, id: &BrowserSessionId, to: BrowserControlTo, by: &str) {
        let Some(session) = self.by_id(id) else {
            return;
        };
        let change = match (to, session.control()) {
            (BrowserControlTo::Human, BrowserControl::Human) => None,
            (BrowserControlTo::Human, _) => Some((BrowserControl::Human, "takeover")),
            (BrowserControlTo::Agent, BrowserControl::Human) => {
                Some((BrowserControl::HandingBack, "handback"))
            }
            (BrowserControlTo::Agent, _) => None,
        };
        if let Some((next, step)) = change {
            session.set_control(next);
            session.step(step, json!({ "by": by }), true, None, 0);
        }
        // Even when nothing changed: the hub waits for the node to say who drives.
        self.report(&session, BrowserSessionState::Live);
    }

    /// An agent's `request_takeover`: the hub lists it under "waiting on you".
    async fn request_takeover(
        &self,
        thread: &str,
        reason: fleetd_contracts::prim::Line<1, 500>,
    ) -> Result<BrowserCallResult, McpToolError> {
        let session = self.live(thread).ok_or_else(|| {
            refuse(
                ErrorCode::NotFound,
                "No browser session is open.",
                "start one with session_start",
            )
        })?;
        let call = LeadCall::BrowserTakeover(BrowserTakeoverCall {
            session_id: session.id.clone(),
            reason: reason.clone(),
        });
        self.in_turn(&session, call).await?;
        session.step(
            "request_takeover",
            json!({ "reason": reason.as_str() }),
            true,
            None,
            0,
        );
        Ok(BrowserCallResult::RequestTakeover(TakeoverRequested {
            message: "Asked: it shows under waiting on you. Carry on with what you can; while a person has control \
                      your browser commands answer so, and after they hand it back your next one sees the page as \
                      they left it."
                .into(),
        }))
    }

    /// A session no agent drives, held by a person from the start, open on `url`: a preview the person tries from
    /// the app (node/preview). It is recorded and reported like any other session, in the name of `holder` (the
    /// preview's id, which the hub files under the preview's project), and the person's input from the app reaches it
    /// by its id. `secrets` are masked in its recording. It ends with [`Broker::end_held`].
    pub async fn open_held(
        self: &Arc<Self>,
        holder: &str,
        cwd: &str,
        purpose: &str,
        url: &str,
        secrets: crate::node::mask::Secrets,
    ) -> Result<BrowserSessionId, String> {
        if self.live(holder).is_some() || !lock(&self.starting).insert(holder.to_owned()) {
            return Err(format!("{holder} has a browser session already"));
        }
        let _starting = Starting(self, holder.to_owned());
        let browser = self.pool().await.map_err(|e| e.message)?.take().await?;
        let id = new_id();
        let ffmpeg = lock(&self.ffmpeg).clone();
        let dir = upload::recordings_dir(&self.home).join(id.as_str());
        let session = Session::open(
            browser,
            Opened {
                dir: dir.clone(),
                id,
                thread: holder.to_owned(),
                cwd: cwd.to_owned(),
                purpose: purpose.to_owned(),
                ffmpeg,
                secrets,
            },
        )
        .await
        .inspect_err(|_| {
            let _ = std::fs::remove_dir_all(&dir);
        })?;
        session.step(
            "session_start",
            json!({ "purpose": purpose }),
            true,
            None,
            0,
        );
        session.set_control(BrowserControl::Human);
        session.step("takeover", json!({ "by": "person" }), true, None, 0);
        lock(&self.sessions).insert(holder.to_owned(), session.clone());
        if let Some((_, page)) = session.page() {
            session.touch();
            session
                .cdp
                .call(Some(&page), "Page.navigate", json!({ "url": url }))
                .await
                .map_err(|why| format!("the browser didn't open {url}: {why}"))?;
        }
        self.report(&session, BrowserSessionState::Live);
        Ok(session.id.clone())
    }

    /// Ends a session [`Broker::open_held`] opened; its recording goes to the hub. Nothing when it ended already.
    pub async fn end_held(self: &Arc<Self>, holder: &str) {
        let Some(session) = lock(&self.sessions).remove(holder) else {
            return;
        };
        self.close(session).await;
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

    /// The socket's handler for browser tool calls.
    pub fn handler(self: &Arc<Self>) -> BrowserHandler {
        let broker = self.clone();
        Arc::new(move |thread, frame| {
            let broker = broker.clone();
            Box::pin(async move { broker.handle(thread, frame).await })
        })
    }
}

impl SessionHooks for Broker {
    fn filled_since(&self, thread: &str, known: usize) -> Option<Secrets> {
        self.credentials.filled_since(thread, known)
    }

    fn env(&self, thread: &str, path: Option<&str>) -> Vec<(String, String)> {
        match self.cdp_url(thread) {
            Some(cdp) => agent_browser::env(&self.home, thread, &cdp, path),
            None => Vec::new(),
        }
    }

    /// Ends the agent session's browser session, if it has one: its recording goes to the hub now, not after the
    /// idle timeout.
    fn ended(&self, thread: &str) {
        self.credentials.ended(thread);
        let Some(session) = lock(&self.sessions).remove(thread) else {
            return;
        };
        let Some(broker) = self.me.upgrade() else {
            return;
        };
        tokio::spawn(async move {
            session.step("agent_session_ended", json!({}), true, None, 0);
            broker.close(session).await;
        });
    }

    fn plugin_dirs(&self) -> Vec<PathBuf> {
        let dir = agent_browser::plugin_dir(&self.home);
        dir.join(".claude-plugin")
            .is_dir()
            .then_some(dir)
            .into_iter()
            .collect()
    }

    /// A finished `agent-browser` command of a session with a live browser: a line in its action log, and the page
    /// after it in the DOM trace.
    fn item(&self, thread: &str, item: &ThreadItem) {
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
            || !drives_browser(command)
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
        let (seq, target) = session.agent_step(command, ok, output.as_deref(), duration_ms);
        session.queue_capture(seq, target);
    }
}

/// Every minute: ends sessions idle past the limit, and sends the recordings still waiting for the hub.
async fn housekeeping(broker: std::sync::Weak<Broker>) {
    let mut uploading: Option<tokio::task::JoinHandle<()>> = None;
    loop {
        let Some(this) = broker.upgrade() else {
            return;
        };
        let idle = Duration::from_secs(60 * this.config.idle_minutes.unwrap_or(30));
        let stale: Vec<Arc<Session>> = {
            let mut sessions = lock(&this.sessions);
            let threads: Vec<String> = sessions
                .iter()
                .filter(|(_, s)| s.idle_for() >= idle)
                .map(|(t, _)| t.clone())
                .collect();
            threads.iter().filter_map(|t| sessions.remove(t)).collect()
        };
        for session in stale {
            tracing::info!(session = %session.id, "browser session idle; ending it");
            this.close(session).await;
        }
        if uploading.as_ref().is_none_or(|u| u.is_finished()) {
            let live: Vec<String> = lock(&this.sessions)
                .values()
                .map(|s| s.id.to_string())
                .collect();
            let waiting = upload::waiting(&this.home, &live);
            let broker = this.clone();
            uploading = Some(tokio::spawn(async move {
                for dir in waiting {
                    broker.upload(&dir).await;
                }
            }));
        }
        drop(this);
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}
