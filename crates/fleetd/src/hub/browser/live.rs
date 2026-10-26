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
    BrowserControl, BrowserInput, BrowserInputFrame, BrowserSessionState,
};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::node_link::CAP_BROWSER;

use crate::hub::api::{Caller, Hub, ToolError, is_human, require};
use crate::hub::link::NodeLinkServer;

/// Frames in flight to every watcher together; a watcher this far behind skips to the newest.
const FRAMES: usize = 8;

pub struct Live {
    frames: broadcast::Sender<BrowserFrame>,
    /// Watched sessions: their machine, and how many watch.
    watched: Mutex<HashMap<BrowserSessionId, (MachineId, usize)>>,
}

impl Default for Live {
    fn default() -> Self {
        Self {
            frames: broadcast::channel(FRAMES).0,
            watched: Mutex::default(),
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

    pub fn watchers(&self, session: &BrowserSessionId) -> usize {
        self.lock().get(session).map_or(0, |(_, n)| *n)
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
    ToolError::new(ErrorCode::NotFound, format!("No browser session {id}."))
        .with_fix("Call browser_sessions for the project's sessions.")
}

/// The app's `browser_watch` of a live session: any key that can read its machine.
pub fn start_watch(hub: &Hub, caller: &Caller, id: &BrowserSessionId) -> Result<Watch, ToolError> {
    let session = super::get(&hub.db, id)?.ok_or_else(|| no_session(id))?;
    let machine = &session.project_ref.machine_id;
    if require(caller, Role::Read, Some(machine)).is_err() {
        return Err(no_session(id));
    }
    if session.state != BrowserSessionState::Live {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("Browser session {id} is {}: replay its recording instead.", session.state.as_str()),
        )
        .with_fix("Read its files with browser_recording_get."));
    }
    if !hub.link.node_can(machine, CAP_BROWSER) {
        return Err(ToolError::new(
            ErrorCode::MachineOffline,
            format!("{machine}'s node isn't connected, or is too old for live view."),
        ));
    }
    Ok(hub.link.browser_live.watch(&hub.link, machine, id))
}

/// The app's `browser_input`: a person's device with operate on the machine, on a session they took over.
pub fn input(hub: &Hub, caller: &Caller, id: &BrowserSessionId, input: BrowserInput) -> Result<(), ToolError> {
    let session = super::get(&hub.db, id)?.ok_or_else(|| no_session(id))?;
    let machine = &session.project_ref.machine_id;
    if require(caller, Role::Read, Some(machine)).is_err() {
        return Err(no_session(id));
    }
    if !is_human(caller) {
        return Err(ToolError::new(ErrorCode::Forbidden, "Only a person's device drives a browser session.")
            .with_fix("Use the desktop app."));
    }
    require(caller, Role::Operate, Some(machine))?;
    if session.state != BrowserSessionState::Live || session.control != BrowserControl::Human {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("Browser session {id} isn't yours to drive: its agent has control."),
        )
        .with_fix("Take it over first with browser_control control human."));
    }
    let frame = HubToNode::BrowserInput(BrowserInputFrame { session_id: id.clone(), input });
    if !hub.link.send_to(machine, frame) {
        return Err(ToolError::new(ErrorCode::MachineOffline, format!("{machine}'s node isn't connected.")));
    }
    Ok(())
}
