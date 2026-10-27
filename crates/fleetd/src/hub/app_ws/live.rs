//! The live subscription on /app: per connection, a pump that turns what the hub already knows (thread activity,
//! task and lead state, machine load, the slot board) into `live` frames, sending only what changed.
//!
//! Bounded for a remote app: board lanes at most once a second, focus lanes and streamed text at most 4 times a
//! second, machines at most every 5 s, slots at most once a second; at most 64 lanes and 16 KB per frame and 32 KB/s
//! per connection. Frames go through a one-frame slot, not the connection's queue: while the socket has not taken
//! the last frame, the pump builds no new one, so a slow link skips intermediate states (latest wins) instead of
//! queueing them behind durable events, and nothing is lost because each frame is a diff against what was taken.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::live::{
    LIVE_MAX_FRAME_BYTES, LIVE_MAX_LANES, LIVE_MAX_TEXTS, LaneId, LiveFrame, LiveLane, LiveText,
    MachineLive, lead_lane_id,
};
use fleetd_contracts::model::MachineStatus;
use fleetd_contracts::prim::{Count, List, NonEmpty, Text};
use fleetd_contracts::tasks::{SlotState, Task, TaskState};
use tokio::sync::Notify;

use crate::hub::agents;
use crate::hub::api::{Caller, Hub, allows};
use crate::hub::executor::activity::StreamText;
use crate::hub::orders::{self, phase};
use crate::hub::store::{iso_ms, now_ms};

pub const TICK: Duration = Duration::from_millis(250);
/// Board lanes and slots every 4th tick (1 s), machines every 20th (5 s).
const BOARD_EVERY: u64 = 4;
const SLOTS_EVERY: u64 = 4;
const MACHINES_EVERY: u64 = 20;
/// Bytes per connection per second, worst case.
pub const MAX_BYTES_PER_SEC: usize = 32 * 1024;

/// One connection's bytes per second, shared by the live pump and status answers, so the two together stay within
/// [`MAX_BYTES_PER_SEC`].
#[derive(Default)]
pub struct ConnBudget(std::sync::Mutex<(i64, usize)>);

impl ConnBudget {
    /// Whether this second still has room.
    pub fn room(&self, now_ms: i64) -> bool {
        let mut w = self.0.lock().unwrap();
        if now_ms - w.0 >= 1000 {
            *w = (now_ms, 0);
        }
        w.1 < MAX_BYTES_PER_SEC
    }

    pub fn spend(&self, now_ms: i64, bytes: usize) {
        let mut w = self.0.lock().unwrap();
        if now_ms - w.0 >= 1000 {
            *w = (now_ms, 0);
        }
        w.1 += bytes;
    }

    /// Reserves `bytes` in this second when they fit (or the second is still empty, so one large frame can pass),
    /// returning 0; otherwise reserves nothing and returns the milliseconds until the next second. Check and spend
    /// happen under one lock, so answers waiting together can't all pass at once.
    pub fn reserve(&self, now_ms: i64, bytes: usize) -> u64 {
        let mut w = self.0.lock().unwrap();
        if now_ms - w.0 >= 1000 {
            *w = (now_ms, 0);
        }
        if w.1 == 0 || w.1 + bytes <= MAX_BYTES_PER_SEC {
            w.1 += bytes;
            0
        } else {
            (w.0 + 1000 - now_ms).max(1) as u64
        }
    }
}
/// A focused order's lanes stay in scope this long after they end, so the app sees them settle.
const ENDED_GRACE_MS: i64 = 60_000;
/// A board's lanes stay in scope this long after they end: a few board ticks, so the app sees how each one settled
/// (done, failed or cancelled) and can say so before the lane leaves the card.
const BOARD_ENDED_GRACE_MS: i64 = 15_000;
/// The newest finished tasks per state the board looks through for ones that ended within the grace.
const BOARD_ENDED_SCAN: usize = 50;

/// One frame waiting for the socket. Latest wins: the pump offers a frame only when the slot is empty.
#[derive(Default)]
pub struct LiveSlot {
    frame: Mutex<Option<String>>,
    pub notify: Notify,
}

impl LiveSlot {
    pub fn pending(&self) -> bool {
        self.frame.lock().unwrap().is_some()
    }

    /// Puts a frame in an empty slot; false (and nothing changes) while the last one is still there.
    pub fn offer(&self, frame: String) -> bool {
        let mut slot = self.frame.lock().unwrap();
        if slot.is_some() {
            return false;
        }
        *slot = Some(frame);
        drop(slot);
        self.notify.notify_one();
        true
    }

    pub fn take(&self) -> Option<String> {
        self.frame.lock().unwrap().take()
    }

    /// Puts a frame in the slot in place of one not yet sent: only the newest goes out.
    pub fn replace(&self, frame: String) {
        *self.frame.lock().unwrap() = Some(frame);
        self.notify.notify_one();
    }

    /// Drops a frame of a subscription that was replaced.
    pub fn clear(&self) {
        self.frame.lock().unwrap().take();
    }
}

/// One lane in scope at this tick, with its streamed text when it is focused.
#[derive(Clone, Debug)]
pub struct LaneNow {
    pub lane: LiveLane,
    pub text: Option<StreamText>,
}

/// What a tick read. `None` parts were not read this tick and stay as last sent.
#[derive(Default)]
pub struct TickInput {
    pub now_ms: i64,
    /// Every lane in scope (`board_complete`), or only the focused ones.
    pub lanes: Vec<LaneNow>,
    pub board_complete: bool,
    pub machines: Option<Vec<MachineLive>>,
    pub slots: Option<SlotState>,
}

/// The diff state of one subscription: what the app was last sent. Pure, so the coalescing is testable.
#[derive(Default)]
pub struct Pump {
    started: bool,
    lanes: HashMap<LaneId, LiveLane>,
    text: HashMap<LaneId, (String, u64)>,
    machines: Option<Vec<MachineLive>>,
    slots: Option<SlotState>,
}

/// The last `max` UTF-16 units of `s`.
fn tail_units(s: &str, max: usize) -> &str {
    let mut units = 0;
    let mut start = s.len();
    for (i, c) in s.char_indices().rev() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        start = i;
    }
    &s[start..]
}

fn size_of<T: serde::Serialize>(v: &T) -> usize {
    serde_json::to_vec(v).map_or(usize::MAX, |b| b.len())
}

impl Pump {
    /// The next frame, or None when nothing changed. The first frame after a subscribe is `full`.
    pub fn frame(&mut self, input: TickInput) -> Option<LiveFrame> {
        let full = !self.started;
        self.started = true;
        let in_scope: HashSet<LaneId> =
            input.lanes.iter().map(|l| l.lane.lane_id.clone()).collect();
        if full || input.board_complete {
            self.lanes.retain(|id, _| in_scope.contains(id));
            self.text.retain(|id, _| in_scope.contains(id));
        }
        // Most recently changed first, so a frame cut at its limits carries the freshest lanes.
        let mut changed: Vec<LiveLane> = input
            .lanes
            .iter()
            .filter_map(|now| {
                let mut lane = now.lane.clone();
                if full {
                    return Some(lane);
                }
                let before = self.lanes.get(&lane.lane_id);
                // The sparkline only when its samples moved: an idle lane's flat line is sent once.
                let spark_moved = before.and_then(|b| b.spark.as_ref()).map(|s| &s.samples)
                    != lane.spark.as_ref().map(|s| &s.samples);
                if !spark_moved {
                    lane.spark = None;
                }
                let moved = before.is_none_or(|b| {
                    b.status != lane.status
                        || b.activity != lane.activity
                        || b.tokens != lane.tokens
                });
                (moved || lane.spark.is_some()).then_some(lane)
            })
            .collect();
        changed.sort_by(|a, b| {
            let since = |l: &LiveLane| l.activity.as_ref().map(|a| a.since.0.clone());
            since(b).cmp(&since(a))
        });
        let mut frame = LiveFrame {
            at: iso_ms(input.now_ms).into(),
            full,
            lanes: List::default(),
            text: List::default(),
            machines: None,
            slots: None,
        };
        if let Some(machines) = input.machines
            && (full || self.machines.as_ref() != Some(&machines))
        {
            let machines: Vec<_> = machines
                .into_iter()
                .take(fleetd_contracts::live::LIVE_MAX_MACHINES)
                .collect();
            self.machines = Some(machines.clone());
            frame.machines = Some(List::unchecked(machines));
        }
        if let Some(slots) = input.slots
            && (full || self.slots.as_ref() != Some(&slots))
        {
            self.slots = Some(slots.clone());
            frame.slots = Some(slots);
        }
        let mut budget = LIVE_MAX_FRAME_BYTES.saturating_sub(size_of(&frame) + 64);
        let mut lanes = Vec::new();
        for lane in changed {
            if lanes.len() == LIVE_MAX_LANES {
                break;
            }
            let cost = size_of(&lane) + 1;
            if cost > budget {
                continue;
            }
            budget -= cost;
            // What is in the frame is what the app has; a lane cut from the frame stays changed for the next tick.
            let mut stored = lane.clone();
            if stored.spark.is_none()
                && let Some(prev) = self.lanes.get(&lane.lane_id)
            {
                stored.spark = prev.spark.clone();
            }
            self.lanes.insert(lane.lane_id.clone(), stored);
            lanes.push(lane);
        }
        let mut texts = Vec::new();
        for now in &input.lanes {
            let Some(text) = &now.text else { continue };
            if texts.len() == LIVE_MAX_TEXTS {
                break;
            }
            let id = &now.lane.lane_id;
            let sent = match self.text.get(id) {
                Some((message, sent)) if *message == text.message_id => *sent,
                _ => 0,
            };
            if text.total <= sent {
                continue;
            }
            let append = tail_units(text.since(sent), 2000);
            let Ok(message_id) = NonEmpty::new(text.message_id.as_str()) else {
                continue;
            };
            let item = LiveText {
                lane_id: id.clone(),
                message_id,
                append: Text::unchecked(append),
            };
            let cost = size_of(&item) + 1;
            if cost > budget {
                break;
            }
            budget -= cost;
            self.text
                .insert(id.clone(), (text.message_id.clone(), text.total));
            texts.push(item);
        }
        frame.lanes = List::unchecked(lanes);
        frame.text = List::unchecked(texts);
        let empty = frame.lanes.is_empty()
            && frame.text.is_empty()
            && frame.machines.is_none()
            && frame.slots.is_none();
        (full || !empty).then_some(frame)
    }
}

/// The subscription's scope: every agent the key may read when `board`, the focused order, and one focused agent.
pub struct Scope {
    pub caller: Caller,
    pub board: bool,
    pub focus: Option<WorkstreamId>,
    /// An agents-view row's lane id: that agent at the focus rate, with its streamed text.
    pub agent: Option<LaneId>,
}

fn task_lane(hub: &Hub, task: &Task, focus: bool) -> LaneNow {
    let thread = task
        .thread_ref
        .as_ref()
        .and_then(|r| hub.executors.thread_summary(r));
    let status = phase::task_lane_status(task, thread.as_ref().map(|t| t.status.as_str()));
    let parts = task.thread_ref.as_ref().and_then(|r| hub.executors.live(r));
    LaneNow {
        lane: orders::live_lane(task.task_id.as_str(), status, parts.as_ref()),
        text: parts.filter(|_| focus).and_then(|p| p.text),
    }
}

fn lead_lanes(
    hub: &Hub,
    projects: &HashSet<fleetd_contracts::ids::ProjectRef>,
    focus: bool,
) -> Vec<LaneNow> {
    projects
        .iter()
        .filter_map(|r| hub.leads.leads.get(r).ok().flatten())
        .map(|lead| {
            let thread = fleetd_contracts::ids::ThreadRef {
                machine_id: lead.project_ref.machine_id.clone(),
                thread_id: lead.thread_id.clone(),
            };
            let seen = hub.executors.thread_summary(&thread);
            let status = phase::lead_lane_status(
                lead.state,
                lead.parked.is_some(),
                seen.as_ref().map(|s| s.status.as_str()),
            );
            let parts = hub.executors.live(&thread);
            LaneNow {
                lane: orders::live_lane(&lead_lane_id(&lead.project_ref), status, parts.as_ref()),
                text: parts.filter(|_| focus).and_then(|p| p.text),
            }
        })
        .collect()
}

/// The focused order's lanes: its live tasks, those that ended in the last minute, and its project's lead.
pub fn focus_lanes(hub: &Hub, caller: &Caller, id: &WorkstreamId) -> Vec<LaneNow> {
    let Some(w) = hub.leads.records.workstream_get(id).ok().flatten() else {
        return Vec::new();
    };
    let project = w.project_ref;
    if !allows(caller, Role::Read, Some(&project.machine_id)) {
        return Vec::new();
    }
    let cutoff = iso_ms(now_ms(hub.clock.as_ref()) - ENDED_GRACE_MS);
    let mut lanes: Vec<LaneNow> = orders::order_tasks(hub, id)
        .iter()
        .filter(|t| {
            matches!(
                t.state,
                TaskState::Queued | TaskState::Running | TaskState::Idle
            ) || t.ended_at.as_ref().is_some_and(|e| e.0 >= cutoff)
        })
        .map(|t| task_lane(hub, t, true))
        .collect();
    lanes.extend(lead_lanes(hub, &HashSet::from([project]), true));
    lanes
}

/// Every agent the agents view lists: each queued, running or idle task the key may read, those that ended in the
/// last few seconds (so the app sees how they settled), and each readable lead that is working. An idle lead has no
/// lane here; the agents view still lists it.
pub fn board_lanes(hub: &Hub, caller: &Caller) -> Vec<LaneNow> {
    let mut lanes: Vec<LaneNow> = agents::live_tasks(hub, caller, None)
        .iter()
        .map(|t| task_lane(hub, t, false))
        .collect();
    let cutoff = iso_ms(now_ms(hub.clock.as_ref()) - BOARD_ENDED_GRACE_MS);
    lanes.extend(
        agents::ended_tasks(hub, caller, None, &cutoff, BOARD_ENDED_SCAN)
            .iter()
            .map(|t| task_lane(hub, t, false)),
    );
    let readable = agents::readable_projects(hub, caller, None);
    let working: HashSet<_> = agents::lead_projects(hub, &readable)
        .into_iter()
        .filter(|r| crate::hub::chat::flow::lead_working(hub, r))
        .collect();
    lanes.extend(lead_lanes(hub, &working, false));
    lanes
}

/// One agent by its lane id ("T7", or a project's "lead:<machine>/<project>"), with its streamed text, when the key
/// may read it.
pub fn agent_lanes(hub: &Hub, caller: &Caller, lane_id: &str) -> Vec<LaneNow> {
    if let Some(rest) = lane_id.strip_prefix("lead:") {
        let Some((machine, project)) = rest.split_once('/') else {
            return Vec::new();
        };
        let (Ok(machine_id), Ok(project_id)) = (
            fleetd_contracts::ids::MachineId::new(machine),
            fleetd_contracts::ids::ProjectId::new(project),
        ) else {
            return Vec::new();
        };
        if !allows(caller, Role::Read, Some(&machine_id)) {
            return Vec::new();
        }
        let project = fleetd_contracts::ids::ProjectRef {
            machine_id,
            project_id,
        };
        return lead_lanes(hub, &HashSet::from([project]), true);
    }
    let Ok(task_id) = fleetd_contracts::tasks::TaskId::new(lane_id) else {
        return Vec::new();
    };
    hub.tasks
        .get(&task_id)
        .ok()
        .flatten()
        .filter(|t| allows(caller, Role::Read, Some(&t.project_ref.machine_id)))
        .map(|t| vec![task_lane(hub, &t, true)])
        .unwrap_or_default()
}

pub fn machines(hub: &Hub, caller: &Caller) -> Vec<MachineLive> {
    let mut running: HashMap<String, usize> = HashMap::new();
    for t in hub.executors.running() {
        *running
            .entry(t.thread_ref.machine_id.to_string())
            .or_insert(0) += 1;
    }
    let mut out: Vec<MachineLive> = hub
        .store
        .machines_list()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| allows(caller, Role::Read, Some(&m.machine_id)))
        .map(|m| MachineLive {
            load: (m.status != MachineStatus::Offline)
                .then(|| hub.link.load(&m.machine_id))
                .flatten(),
            running: Count::unchecked(*running.get(m.machine_id.as_str()).unwrap_or(&0) as i64),
            name: Text::unchecked(crate::hub::executor::shell_mapper::js_take(&m.name, 200)),
            status: m.status,
            as_of: m.last_seen_at,
            slept: m.last_slept,
            linked_since: hub
                .executors
                .live_since(&m.machine_id)
                .map(|ms| iso_ms(ms).into()),
            machine_id: m.machine_id,
        })
        .collect();
    out.sort_by(|a, b| a.machine_id.as_str().cmp(b.machine_id.as_str()));
    out
}

/// The slot board, its per-project and per-machine rows cut to the machines the key may read.
pub fn slots(hub: &Hub, caller: &Caller) -> SlotState {
    let mut state = hub.slots.state();
    let rows: Vec<_> = std::mem::take(&mut state.per_project)
        .into_iter()
        .filter(|p| allows(caller, Role::Read, Some(&p.project_ref.machine_id)))
        .collect();
    state.per_project = List::unchecked(rows);
    let machines: Vec<_> = std::mem::take(&mut state.per_machine)
        .into_iter()
        .filter(|m| allows(caller, Role::Read, Some(&m.machine_id)))
        .collect();
    state.per_machine = List::unchecked(machines);
    state
}

/// Runs one subscription until it is replaced or the connection ends.
pub async fn run(hub: Arc<Hub>, scope: Scope, slot: Arc<LiveSlot>, budget: Arc<ConnBudget>) {
    if !scope.board && scope.focus.is_none() && scope.agent.is_none() {
        return;
    }
    let mut pump = Pump::default();
    let mut tick: u64 = 0;
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if hub.shutdown.is_triggered() {
            return;
        }
        let now = now_ms(hub.clock.as_ref());
        // Latest wins: the socket has not taken the last frame, so skip this tick rather than queue behind it.
        if slot.pending() || !budget.room(now) {
            continue;
        }
        let first = tick == 0;
        let board_tick = first || tick.is_multiple_of(BOARD_EVERY);
        let mut lanes = Vec::new();
        if let Some(focus) = &scope.focus {
            lanes.extend(focus_lanes(&hub, &scope.caller, focus));
        }
        if let Some(agent) = &scope.agent {
            let seen: HashSet<LaneId> = lanes.iter().map(|l| l.lane.lane_id.clone()).collect();
            lanes.extend(
                agent_lanes(&hub, &scope.caller, agent)
                    .into_iter()
                    .filter(|l| !seen.contains(&l.lane.lane_id)),
            );
        }
        if scope.board && board_tick {
            let seen: HashSet<LaneId> = lanes.iter().map(|l| l.lane.lane_id.clone()).collect();
            lanes.extend(
                board_lanes(&hub, &scope.caller)
                    .into_iter()
                    .filter(|l| !seen.contains(&l.lane.lane_id)),
            );
        }
        let input = TickInput {
            now_ms: now,
            lanes,
            board_complete: !scope.board || board_tick,
            machines: (first || tick.is_multiple_of(MACHINES_EVERY))
                .then(|| machines(&hub, &scope.caller)),
            slots: (first || tick.is_multiple_of(SLOTS_EVERY)).then(|| slots(&hub, &scope.caller)),
        };
        tick += 1;
        let Some(frame) = pump.frame(input) else {
            continue;
        };
        let mut json = serde_json::json!({ "t": "live" });
        if let (serde_json::Value::Object(out), Ok(serde_json::Value::Object(body))) =
            (&mut json, serde_json::to_value(&frame))
        {
            out.extend(body);
        }
        let text = json.to_string();
        budget.spend(now, text.len());
        slot.offer(text);
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod budget_tests {
    use super::*;

    #[test]
    fn answers_waiting_together_pass_one_window_at_a_time() {
        let b = ConnBudget::default();
        let frame = 16 * 1024;
        assert_eq!(b.reserve(1_000, frame), 0);
        assert_eq!(b.reserve(1_000, frame), 0, "32 KB fit in one second");
        let waits: Vec<u64> = (0..3).map(|_| b.reserve(1_200, frame)).collect();
        assert_eq!(waits, vec![800, 800, 800], "none of the rest is reserved");
        assert_eq!(b.reserve(2_000, frame), 0);
        assert_eq!(b.reserve(2_000, frame), 0);
        assert_eq!(
            b.reserve(2_000, frame),
            1000,
            "the third waits another second"
        );
        assert_eq!(
            b.reserve(3_000, 40 * 1024),
            0,
            "an empty second takes one oversize frame"
        );
    }
}
