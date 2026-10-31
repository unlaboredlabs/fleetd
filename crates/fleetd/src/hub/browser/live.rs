//! Live view: who watches which browser session, and their frames. A node sends a session's frames only while the hub
//! watches it (`browser_watch` on, sent with the first watcher, off after the last), and again after a reconnect. The
//! hub keeps no frame: each goes out to the app connections watching its session as it comes, and a slow one skips
//! frames rather than queueing them.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use fleetd_contracts::browser::{BrowserFrame, BrowserSessionId, BrowserWatchFrame};
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::node_link::HubToNode;
use tokio::sync::broadcast;

use fleetd_contracts::auth::Role;
use fleetd_contracts::browser::{
    BrowserControl, BrowserInput, BrowserInputFrame, BrowserSession, BrowserSessionState,
};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::node_link::CAP_BROWSER;

use crate::hub::api::{Caller, Hub, ToolError, is_human, require};
use crate::hub::link::NodeLinkServer;

/// Frames in flight to every watcher together; a watcher this far behind skips to the newest.
const FRAMES: usize = 8;

pub struct Live {
    frames: broadcast::Sender<BrowserFrame>,
    /// `browser_control` calls waiting for the node to report who drives a session now.
    controls:
        Mutex<HashMap<BrowserSessionId, Vec<tokio::sync::mpsc::UnboundedSender<BrowserControl>>>>,
    /// Watched sessions: their machine, and how many watch.
    watched: Mutex<HashMap<BrowserSessionId, (MachineId, usize)>>,
    /// When a person last sent input to each session, in the hub clock's ms: a person's own screen idles out on it
    /// (machine_roles/screens.rs).
    inputs: Mutex<HashMap<BrowserSessionId, i64>>,
}

impl Default for Live {
    fn default() -> Self {
        Self {
            frames: broadcast::channel(FRAMES).0,
            controls: Mutex::default(),
            watched: Mutex::default(),
            inputs: Mutex::default(),
        }
    }
}

/// One app connection's watch of a session; dropping it ends the watch.
pub struct Watch {
    live: Weak<Live>,
    link: Weak<NodeLinkServer>,
    session: BrowserSessionId,
    pub frames: broadcast::Receiver<BrowserFrame>,
}

fn watch_frame(session: &BrowserSessionId, on: bool) -> HubToNode {
    HubToNode::BrowserWatch(BrowserWatchFrame {
        session_id: session.clone(),
        on,
    })
}

impl Live {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<BrowserSessionId, (MachineId, usize)>> {
        self.watched
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A node's frame, for whoever watches its session.
    pub fn frame(&self, machine: &MachineId, frame: BrowserFrame) {
        let watched = self
            .lock()
            .get(&frame.session_id)
            .is_some_and(|(m, _)| m == machine);
        if watched {
            let _ = self.frames.send(frame);
        }
    }

    /// Starts watching `session` on `machine`; its node starts sending frames with the first watcher.
    pub fn watch(
        self: &Arc<Self>,
        link: &Arc<NodeLinkServer>,
        machine: &MachineId,
        session: &BrowserSessionId,
    ) -> Watch {
        let frames = self.frames.subscribe();
        let first = {
            let mut watched = self.lock();
            let entry = watched
                .entry(session.clone())
                .or_insert_with(|| (machine.clone(), 0));
            entry.1 += 1;
            entry.1 == 1
        };
        if first {
            link.send_to(machine, watch_frame(session, true));
        }
        Watch {
            live: Arc::downgrade(self),
            link: Arc::downgrade(link),
            session: session.clone(),
            frames,
        }
    }

    /// A node linked (again): the sessions watched there, so it sends their frames.
    pub fn rewatch(&self, machine: &MachineId) -> Vec<HubToNode> {
        self.lock()
            .iter()
            .filter(|(_, (m, _))| m == machine)
            .map(|(session, _)| watch_frame(session, true))
            .collect()
    }

    /// The control the node reports for `session` from now on, report by report, until the wait is dropped.
    pub fn await_control(self: &Arc<Self>, session: &BrowserSessionId) -> ControlWait {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        self.controls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(session.clone())
            .or_default()
            .push(tx);
        ControlWait {
            reports: rx,
            live: Arc::downgrade(self),
            session: session.clone(),
        }
    }

    /// Drops the waits on `session` whose call has stopped waiting (it gave up, or was answered), and the session's
    /// entry with the last of them.
    pub fn drop_closed(&self, session: &BrowserSessionId) {
        let mut controls = self
            .controls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(waiting) = controls.get_mut(session) {
            waiting.retain(|tx| !tx.is_closed());
            if waiting.is_empty() {
                controls.remove(session);
            }
        }
    }

    /// The calls waiting on `session`'s control now.
    pub fn awaiting(&self, session: &BrowserSessionId) -> usize {
        self.controls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session)
            .map_or(0, Vec::len)
    }

    /// The node reported who drives `session`: for the calls waiting on it.
    pub fn control_reported(&self, session: &BrowserSessionId, control: BrowserControl) {
        let mut controls = self
            .controls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(waiting) = controls.get_mut(session) {
            waiting.retain(|tx| tx.send(control).is_ok());
            if waiting.is_empty() {
                controls.remove(session);
            }
        }
    }

    /// A person sent input to `session` at `at`.
    pub fn note_input(&self, session: &BrowserSessionId, at: i64) {
        self.inputs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session.clone(), at);
    }

    /// When a person last sent input to `session`, since the hub started.
    pub fn last_input(&self, session: &BrowserSessionId) -> Option<i64> {
        self.inputs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session)
            .copied()
    }

    /// Forgets `session`'s input time: it ended.
    pub fn forget_input(&self, session: &BrowserSessionId) {
        self.inputs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session);
    }

    pub fn watchers(&self, session: &BrowserSessionId) -> usize {
        self.lock().get(session).map_or(0, |(_, n)| *n)
    }
}

/// A `browser_control` call's wait for its node's report. However the call ends (answered, timed out, its send
/// failed, or the call itself was dropped), dropping this leaves no wait behind for the session.
pub struct ControlWait {
    reports: tokio::sync::mpsc::UnboundedReceiver<BrowserControl>,
    live: Weak<Live>,
    session: BrowserSessionId,
}

impl ControlWait {
    /// The next control the node reports for the session.
    pub async fn recv(&mut self) -> Option<BrowserControl> {
        self.reports.recv().await
    }
}

impl Drop for ControlWait {
    fn drop(&mut self) {
        self.reports.close();
        if let Some(live) = self.live.upgrade() {
            live.drop_closed(&self.session);
        }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        let Some(live) = self.live.upgrade() else {
            return;
        };
        let last = {
            let mut watched = live.lock();
            match watched.get_mut(&self.session) {
                Some((machine, n)) if *n <= 1 => {
                    let machine = machine.clone();
                    watched.remove(&self.session);
                    Some(machine)
                }
                Some((_, n)) => {
                    *n -= 1;
                    None
                }
                None => None,
            }
        };
        if let (Some(machine), Some(link)) = (last, self.link.upgrade()) {
            link.send_to(&machine, watch_frame(&self.session, false));
        }
    }
}

fn no_session(id: &BrowserSessionId) -> ToolError {
    ToolError::new(ErrorCode::NotFound, format!("No screen {id}."))
        .with_fix("Call browser_sessions for the project's screens.")
}

/// The machine a session runs on: the one hosting it for an agent elsewhere, else its agent's (its project's). Its
/// live view, a person's input and takeover go there, and only its frames reach the session's watchers.
pub fn runs_on(hub: &Hub, session: &BrowserSession) -> Result<MachineId, ToolError> {
    let id = session.session_id.as_str();
    Ok(hub
        .db
        .with(|c| crate::hub::machine_roles::runner_of(c, id))?
        .unwrap_or_else(|| session.project_ref.machine_id.clone()))
}

/// The app's `browser_watch` of a live session: any key that can read its project's machine, and a Navi's only its
/// owner's.
pub fn start_watch(hub: &Hub, caller: &Caller, id: &BrowserSessionId) -> Result<Watch, ToolError> {
    let session = super::get(&hub.db, id)?.ok_or_else(|| no_session(id))?;
    if require(caller, Role::Read, Some(&session.project_ref.machine_id)).is_err() {
        return Err(no_session(id));
    }
    theirs(hub, caller, &session)?;
    if session.state != BrowserSessionState::Live {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "Screen {id} is {}: replay its recording instead.",
                session.state.as_str()
            ),
        )
        .with_fix("Read its files with browser_recording_get."));
    }
    let machine = &runs_on(hub, &session)?;
    if !hub.link.node_can(machine, CAP_BROWSER) {
        return Err(ToolError::new(
            ErrorCode::MachineOffline,
            format!("{machine}'s node isn't connected, or is too old for live view."),
        ));
    }
    Ok(hub.link.browser_live.watch(&hub.link, machine, id))
}

/// Refuses another person's Navi's screen (D215): only its owner watches it, drives it or takes it over.
fn theirs(hub: &Hub, caller: &Caller, session: &BrowserSession) -> Result<(), ToolError> {
    if crate::hub::navi::owner::may_use(&hub.db, caller, &session.project_ref)? {
        Ok(())
    } else {
        Err(crate::hub::navi::owner::refused(&session.project_ref))
    }
}

/// The app's `browser_input`: a person's device with operate on the machine, on a session they took over.
pub fn input(
    hub: &Hub,
    caller: &Caller,
    id: &BrowserSessionId,
    input: BrowserInput,
) -> Result<(), ToolError> {
    let session = super::get(&hub.db, id)?.ok_or_else(|| no_session(id))?;
    let machine = &session.project_ref.machine_id;
    if require(caller, Role::Read, Some(machine)).is_err() {
        return Err(no_session(id));
    }
    theirs(hub, caller, &session)?;
    if !is_human(caller) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person's device drives a screen.",
        )
        .with_fix("Use the fleetd app, on a computer or a phone."));
    }
    require(caller, Role::Operate, Some(machine))?;
    if session.state != BrowserSessionState::Live || session.control != BrowserControl::Human {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("Screen {id} isn't yours to drive: its agent has control."),
        )
        .with_fix("Take it over first with browser_control control human."));
    }
    let machine = &runs_on(hub, &session)?;
    hub.link
        .browser_live
        .note_input(id, crate::hub::store::now_ms(hub.clock.as_ref()));
    let frame = HubToNode::BrowserInput(BrowserInputFrame {
        session_id: id.clone(),
        input,
    });
    if !hub.link.send_to(machine, frame) {
        return Err(ToolError::new(
            ErrorCode::MachineOffline,
            format!("{machine}'s node isn't connected."),
        ));
    }
    Ok(())
}
