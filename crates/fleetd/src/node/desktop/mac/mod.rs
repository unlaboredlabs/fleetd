//! The agents' Mac's own screen (D298, mac.shared-mac): the GUI session of the Mac's standard `agents` user, whose
//! fleetd node runs there, as a screen kind (`session_start` kind mac). There is one such screen, so it is leased: the
//! first session to start holds it, and every other only observes (its screenshots, the pointer's place and
//! agent-desktop's reading commands work; its other actions are refused while another holds it, and its first one
//! after the holder ends takes it). A session no action touched for [`IDLE_MINUTES`] ends, and the lease with it. A
//! person who takes a Mac screen over takes the lease too: an agent holding it only observes from then on.
//!
//! The node reads the screen with ScreenCaptureKit and sends input as CGEvents (capture.rs, input.rs), under its own
//! Screen Recording and Accessibility grants, and runs a pinned agent-desktop for the agent (agent_desktop.rs), as its
//! child under those same grants. macOS gives a session frames and input only while it is the one on the screen,
//! unlocked (console.rs), so the kind is offered, and every start and every take of the lease checked, only then.
//!
//! The session's recording is a desktop's: the video while it holds the lease, and its action log. What the agent
//! launched with `--cdp` is closed when it ends; what it opened stays on the Mac's screen, as a person's apps would.
pub mod agent_desktop;
pub mod console;
pub mod keys;

#[cfg(target_os = "macos")]
mod capture;
#[cfg(target_os = "macos")]
mod ffi;
#[cfg(target_os = "macos")]
mod input;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// What a person runs in the node's account after granting a permission: macOS gives a running process its new grant only
// once it starts again.
use crate::node::agents_mac::RESTART_NODE;

use fleetd_contracts::browser::{
    BrowserCallResult, BrowserControl, BrowserSessionId, BrowserSessionState, DesktopAction,
    DesktopBackend, DesktopCall, SessionKind, SessionStarted,
};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::prim::Text;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::display::Launched;
use super::screen::Lent;
use super::session::{Opened, Session};
use super::{Desktops, lock, new_id, recordings_dir, refuse};

/// A Mac screen session no action touched for this long ends, and gives the lease back. Absent from node.json: 5.
pub const IDLE_MINUTES: u64 = 5;

/// node.json's `mac`: the agents' Mac's screen. Off unless `enabled` is true: a person turns it on for a Mac set aside
/// for agents (Settings › Hub › Machines › Screens).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// iOS simulators agents may have booted at once (`mac sim`, node/mac_tool). Absent: from the Mac's memory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub simulators: Option<u32>,
}

impl MacConfig {
    /// On where node.json turns it on, on a Mac.
    pub fn enabled(&self) -> bool {
        self.enabled == Some(true) && supported()
    }

    pub fn idle(&self) -> Duration {
        Duration::from_secs(60 * IDLE_MINUTES)
    }
}

pub fn supported() -> bool {
    cfg!(target_os = "macos")
}

pub fn mac_dir(home: &Path) -> PathBuf {
    super::desktop_dir(home).join("mac")
}

/// What stands in the way of a Mac screen now, in plain words, and the command that clears it where one does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blocked {
    pub message: String,
    pub fix: Option<String>,
}

/// Why the node's user can't lend its screen, from what macOS says about it: its session must be on the screen,
/// unlocked, and the node needs Screen Recording and Accessibility. Any account may lend it, an admin's included (D309).
pub fn blocked_by(
    user: &str,
    console: &console::Console,
    screen_recording: bool,
    accessibility: bool,
) -> Option<Blocked> {
    if let Some(message) = console.blocked(user) {
        return Some(Blocked { message, fix: None });
    }
    let grant = |what: &str, pane: &str| Blocked {
        message: format!(
            "fleetd needs {what} in {user}'s session: at the Mac, in System Settings › Privacy & Security › {what}, \
             turn fleetd on; the node restarts itself within a minute to take it up"
        ),
        fix: Some(format!(
            "open 'x-apple.systempreferences:com.apple.preference.security?{pane}' && {RESTART_NODE}"
        )),
    };
    if !screen_recording {
        return Some(grant("Screen Recording", "Privacy_ScreenCapture"));
    }
    if !accessibility {
        return Some(grant("Accessibility", "Privacy_Accessibility"));
    }
    None
}

/// What stands in the way of a Mac screen on this machine now (blocking: ioreg and id take milliseconds).
pub fn blocked() -> Option<Blocked> {
    #[cfg(target_os = "macos")]
    {
        let uid = nix::unistd::getuid();
        let user = nix::unistd::User::from_uid(uid)
            .ok()
            .flatten()
            .map_or_else(|| uid.to_string(), |u| u.name);
        let state = match console::read() {
            Ok(users) => console::state(uid.as_raw(), &users),
            Err(why) => {
                return Some(Blocked {
                    message: format!(
                        "the node can't tell whether {user}'s session is on the Mac's screen: {why}"
                    ),
                    fix: None,
                });
            }
        };
        let (screen_recording, accessibility) = match ffi::api() {
            // SAFETY: plain calls that only read the process's grants, without asking for them.
            Ok(api) => unsafe {
                (
                    (api.CGPreflightScreenCaptureAccess)(),
                    (api.AXIsProcessTrusted)(),
                )
            },
            Err(why) => {
                return Some(Blocked {
                    message: format!("this Mac lacks what its screen needs: {why}"),
                    fix: None,
                });
            }
        };
        blocked_by(&user, &state, screen_recording, accessibility)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(Blocked {
            message: "the Mac screen is a Mac's own".into(),
            fix: None,
        })
    }
}

/// Whether a `desktop` action only reads the screen, so a session that doesn't hold the lease may take it.
pub fn observes(call: &DesktopCall) -> bool {
    match call.action {
        DesktopAction::Screenshot | DesktopAction::CursorPosition | DesktopAction::Wait => true,
        // One the node won't run is refused as it runs, with why.
        DesktopAction::AgentDesktop => call
            .text
            .as_ref()
            .is_none_or(|t| agent_desktop::command(t.as_str()).is_ok_and(|c| c.observing)),
        _ => false,
    }
}

/// What a Mac screen session is lent: its own folder (apps it launches start there, and agent-desktop keeps its
/// snapshots there), the apps it started and those agent-desktop launched with a DevTools port. Dropped when the
/// session ends: those apps are closed and the folder goes.
pub struct MacLent {
    dir: PathBuf,
    agent_desktop: Result<PathBuf, String>,
    /// Apps launched with `--cdp`: each pid with its start time, so a pid reused since is never signalled.
    cdp: Mutex<Vec<(u32, String)>>,
    apps: Mutex<Vec<Child>>,
    launched: AtomicU32,
}

impl MacLent {
    pub fn new(dir: PathBuf, agent_desktop: Result<PathBuf, String>) -> Result<Self, String> {
        crate::node::config::mkdir_private(&dir)
            .map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
        Ok(Self {
            dir,
            agent_desktop,
            cdp: Mutex::default(),
            apps: Mutex::default(),
            launched: AtomicU32::new(0),
        })
    }

    /// The apps launched with `--cdp` that are still open.
    pub fn cdp_apps(&self) -> Vec<u32> {
        lock(&self.cdp).iter().map(|(pid, _)| *pid).collect()
    }
}

/// When process `pid` started, as `ps` says it; None where there's no such process.
fn started_at(pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let at = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !at.is_empty()).then_some(at)
}

impl Lent for MacLent {
    fn launch(&self, command: &str, _cwd: &Path) -> Result<Launched, String> {
        let n = self.launched.fetch_add(1, Ordering::Relaxed) + 1;
        let log = self.dir.join(format!("launch-{n}.log"));
        let out = std::fs::File::create(&log).map_err(|e| e.to_string())?;
        let child = {
            use std::os::unix::process::CommandExt;
            Command::new("/bin/sh")
                .arg("-c")
                .arg(command)
                .current_dir(&self.dir)
                .stdin(Stdio::null())
                .stdout(out.try_clone().map_err(|e| e.to_string())?)
                .stderr(out)
                .process_group(0)
                .spawn()
                .map_err(|e| format!("cannot start it: {e}"))?
        };
        let pid = child.id();
        lock(&self.apps).push(child);
        std::thread::sleep(Duration::from_millis(500));
        let exited = lock(&self.apps)
            .iter_mut()
            .find(|c| c.id() == pid)
            .and_then(|c| c.try_wait().ok().flatten())
            .map(|status| (status.code(), super::display::tail(&log, 1500)));
        Ok(Launched { pid, exited })
    }

    fn agent_desktop(&self, args: &str) -> Result<String, String> {
        let command = agent_desktop::command(args)?;
        let bin = self
            .agent_desktop
            .as_ref()
            .map_err(|why| format!("agent-desktop isn't installed on this Mac: {why}"))?;
        let (code, stdout, stderr) =
            agent_desktop::run(bin, &self.dir.join("agent-desktop"), &command.args)?;
        if command.cdp
            && let Some(pid) = agent_desktop::launched_pid(&stdout)
            && let Some(at) = started_at(pid)
        {
            lock(&self.cdp).push((pid, at));
        }
        Ok(agent_desktop::answer(&stdout, &stderr, code))
    }
}

impl Drop for MacLent {
    fn drop(&mut self) {
        for (pid, at) in lock(&self.cdp).drain(..) {
            if started_at(pid).as_ref() == Some(&at) {
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(pid as i32),
                    nix::sys::signal::Signal::SIGTERM,
                );
            }
        }
        for mut app in lock(&self.apps).drain(..) {
            if let Ok(None) = app.try_wait() {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(app.id() as i32),
                    nix::sys::signal::Signal::SIGTERM,
                );
            }
            let _ = app.try_wait();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The Mac's screen, for a session to read and drive; None off a Mac.
fn open_screen() -> Result<Arc<dyn super::screen::Screen>, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(Arc::new(input::MacScreen::open()?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("the Mac screen is a Mac's own".into())
    }
}

impl Desktops {
    /// Installs agent-desktop as the node starts, so the first Mac screen doesn't wait for it.
    pub(super) fn prepare_mac(self: &Arc<Self>) {
        let home = self.home.clone();
        tokio::spawn(async move {
            if let Err(why) = agent_desktop::install(&home).await {
                tracing::warn!(error = %why, "agent-desktop not installed yet");
            }
        });
    }

    /// Who holds the Mac's lease, in a line for the others; None while nobody does.
    pub fn held_by(&self) -> Option<String> {
        let holder = lock(&self.lease).clone()?;
        self.by_id(&holder).map(|s| self.describe(&s))
    }

    /// The lease's holder `session`, in a line for the others.
    fn describe(&self, session: &Session) -> String {
        match session.control() {
            BrowserControl::Human => {
                format!("a person has taken it over (\"{}\")", session.purpose)
            }
            _ => format!(
                "another agent's session \"{}\" holds it (idle {} min; it ends after {} min idle)",
                session.purpose,
                session.idle_for().as_secs() / 60,
                self.mac.idle().as_secs() / 60
            ),
        }
    }

    /// `session_start` kind mac: the Mac's screen, leased to this session if nobody holds it, else observed.
    pub async fn mac_start(
        self: &Arc<Self>,
        thread: String,
        cwd: String,
        purpose: String,
    ) -> Result<BrowserCallResult, McpToolError> {
        if !self.mac.enabled() {
            return Err(refuse(
                ErrorCode::Failed,
                "This machine lends no Mac screen: it is off in its node.json, or this isn't a Mac.",
                "say so in your result: an admin turns the Mac screen on, on the Mac's page in Settings › Hub › Machines",
            ));
        }
        if let Some(open) = self.live(&thread) {
            return Err(refuse(
                ErrorCode::Invalid,
                format!("Mac screen session {} is open.", open.id),
                "use it, or end it with session_end before starting another",
            ));
        }
        // Checked at every start: Fast User Switching, a lock or a revoked grant can change it at any time.
        let gate = *lock(&self.mac_gate);
        if let Some(blocked) = tokio::task::spawn_blocking(gate).await.unwrap_or_else(|e| {
            Some(Blocked {
                message: e.to_string(),
                fix: None,
            })
        }) {
            return Err(refuse(
                ErrorCode::Failed,
                format!("The Mac's screen can't be lent now: {}.", blocked.message),
                "say so in your result, with what a person must do at the Mac",
            ));
        }
        let agent_desktop = agent_desktop::install(&self.home).await;
        let screen = open_screen().map_err(|why| {
            refuse(
                ErrorCode::Failed,
                format!("The Mac's screen can't be read here: {why}."),
                "say so in your result",
            )
        })?;
        self.open_mac(thread, cwd, purpose, screen, agent_desktop)
            .await
    }

    /// Opens a Mac screen session on `screen`, holding the lease if nobody does, else observing.
    pub(super) async fn open_mac(
        self: &Arc<Self>,
        thread: String,
        cwd: String,
        purpose: String,
        screen: Arc<dyn super::screen::Screen>,
        agent_desktop: Result<PathBuf, String>,
    ) -> Result<BrowserCallResult, McpToolError> {
        let id = new_id();
        let dir = recordings_dir(&self.home).join(id.as_str());
        std::fs::create_dir_all(&dir).map_err(|e| {
            refuse(
                ErrorCode::Failed,
                format!("The node could not make the session's recording folder: {e}."),
                "say so in your result; the node's log says why",
            )
        })?;
        let lent = mac_dir(&self.home).join("sessions").join(id.as_str());
        let lent = match MacLent::new(lent, agent_desktop) {
            Ok(lent) => lent,
            Err(why) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(refuse(
                    ErrorCode::Failed,
                    format!("The node could not make the session's folder: {why}."),
                    "say so in your result; the node's log says why",
                ));
            }
        };
        let secrets_for = self.secrets_for.clone();
        let secrets_thread = thread.clone();
        let secrets = match tokio::task::spawn_blocking(move || secrets_for(&secrets_thread))
            .await
            .map_err(|e| e.to_string())
            .and_then(|s| s)
        {
            Ok(secrets) => secrets,
            Err(why) => {
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
        let (session, held_by) = {
            let mut lease = lock(&self.lease);
            // A holder whose session is gone holds nothing.
            let held_by = lease
                .clone()
                .and_then(|holder| self.by_id(&holder))
                .map(|holder| self.describe(&holder));
            let session = Session::open(
                Box::new(lent),
                screen,
                Opened {
                    dir,
                    id,
                    thread: thread.clone(),
                    cwd,
                    purpose: purpose.clone(),
                    ffmpeg: self.ffmpeg(),
                    secrets,
                    kind: SessionKind::Mac,
                    backend: DesktopBackend::Mac,
                    observing: held_by.is_some(),
                },
            );
            if held_by.is_none() {
                *lease = Some(session.id.clone());
            }
            lock(&self.sessions).insert(thread.clone(), session.clone());
            (session, held_by)
        };
        session.step(
            "session_start",
            json!({ "purpose": purpose, "kind": "mac", "observing": held_by.is_some() }),
            true,
            held_by.as_deref(),
            0,
        );
        self.report(&session, BrowserSessionState::Live);
        Ok(BrowserCallResult::SessionStart(SessionStarted {
            session_id: session.id.clone(),
            cdp: None,
            serial: None,
            udid: None,
            desktop: Some(DesktopBackend::Mac),
            worktree: None,
            held_by: held_by.map(|h| Text::unchecked(h.chars().take(300).collect::<String>())),
            start_ms: session.offset_ms(),
        }))
    }

    /// Before an action of an observing session that acts on the screen: takes the lease if nobody holds it, else
    /// refuses with who does.
    pub(super) async fn take_lease(&self, session: &Arc<Session>) -> Result<(), McpToolError> {
        let held = {
            let lease = lock(&self.lease);
            lease
                .as_ref()
                .filter(|holder| **holder != session.id && self.by_id(holder).is_some())
                .is_some()
        };
        if held {
            return Err(refuse(
                ErrorCode::Invalid,
                format!(
                    "The Mac's screen is someone else's now: {}. You can observe it meanwhile: screenshot, \
                     cursor_position, wait and agent-desktop's reading commands (snapshot, find, get, is, list-apps).",
                    self.held_by()
                        .unwrap_or_else(|| "another session holds it".into())
                ),
                "carry on with what you can without it and try again later; once it's free, your next action takes it",
            ));
        }
        let gate = *lock(&self.mac_gate);
        if let Some(blocked) = tokio::task::spawn_blocking(gate).await.ok().flatten() {
            return Err(refuse(
                ErrorCode::Failed,
                format!("The Mac's screen can't be lent now: {}.", blocked.message),
                "say so in your result, with what a person must do at the Mac",
            ));
        }
        let mut lease = lock(&self.lease);
        match lease.as_ref() {
            Some(holder) if *holder != session.id && self.by_id(holder).is_some() => {
                return Err(refuse(
                    ErrorCode::Invalid,
                    "Another session took the Mac's screen just now.",
                    "carry on with what you can without it and try again later",
                ));
            }
            _ => *lease = Some(session.id.clone()),
        }
        drop(lease);
        session.set_observing(false);
        Ok(())
    }

    /// A person takes a Mac screen session over: the lease is theirs through it, and whoever held it only observes.
    pub(super) fn person_takes_lease(&self, session: &Session) {
        let before = lock(&self.lease).replace(session.id.clone());
        if let Some(before) = before.filter(|b| *b != session.id)
            && let Some(holder) = self.by_id(&before)
        {
            holder.set_observing(true);
        }
        session.set_observing(false);
    }

    /// A session ended: the lease is free if it held it.
    pub(super) fn release_lease(&self, session: &BrowserSessionId) {
        let mut lease = lock(&self.lease);
        if lease.as_ref() == Some(session) {
            *lease = None;
        }
    }
}
