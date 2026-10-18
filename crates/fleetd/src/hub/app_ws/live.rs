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

use crate::hub::api::{Caller, Hub, allows};
use crate::hub::executor::activity::StreamText;
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::orders::{self, phase};
use crate::hub::store::{iso_ms, now_ms};
use crate::hub::tasks::TaskFilter;

pub const TICK: Duration = Duration::from_millis(250);
/// Board lanes and slots every 4th tick (1 s), machines every 20th (5 s).
const BOARD_EVERY: u64 = 4;
const SLOTS_EVERY: u64 = 4;
const MACHINES_EVERY: u64 = 20;
/// Bytes per connection per second, worst case.
pub const MAX_BYTES_PER_SEC: usize = 32 * 1024;
/// A focused order's lanes stay in scope this long after they end, so the app sees them settle.
const ENDED_GRACE_MS: i64 = 60_000;

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

/// The subscription's scope: the focused order, and every open order the key may read when `board`.
pub struct Scope {
    pub caller: Caller,
    pub board: bool,
    pub focus: Option<WorkstreamId>,
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
    let project = w.workstream.project_ref;
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

/// Every live task of the open orders the key may read, and those projects' leads.
pub fn board_lanes(hub: &Hub, caller: &Caller) -> Vec<LaneNow> {
    let mut projects = HashSet::new();
    let open = hub
        .leads
        .records
        .workstreams_list(&WorkstreamFilter {
            open: true,
            limit: 500,
            ..Default::default()
        })
        .unwrap_or_default();
    let open: HashSet<WorkstreamId> = open
        .into_iter()
        .filter(|w| allows(caller, Role::Read, Some(&w.project_ref.machine_id)))
        .map(|w| {
            projects.insert(w.project_ref.clone());
            w.workstream_id
        })
        .collect();
    let mut lanes = Vec::new();
    for state in [TaskState::Running, TaskState::Queued, TaskState::Idle] {
        let tasks = hub
            .tasks
            .list(&TaskFilter {
                project_ref: None,
                state: Some(state),
                workstream_id: None,
                limit: 500,
            })
            .unwrap_or_default();
        lanes.extend(
            tasks
                .iter()
                .filter(|t| open.contains(&t.workstream_id))
                .map(|t| task_lane(hub, t, false)),
        );
    }
    lanes.extend(lead_lanes(hub, &projects, false));
    lanes
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
            machine_id: m.machine_id,
        })
        .collect();
    out.sort_by(|a, b| a.machine_id.as_str().cmp(b.machine_id.as_str()));
    out
}

/// The slot board, its per-project rows cut to the projects the key may read.
pub fn slots(hub: &Hub, caller: &Caller) -> SlotState {
    let mut state = hub.slots.state();
    let rows: Vec<_> = std::mem::take(&mut state.per_project)
        .into_iter()
        .filter(|p| allows(caller, Role::Read, Some(&p.project_ref.machine_id)))
        .collect();
    state.per_project = List::unchecked(rows);
    state
}

/// Runs one subscription until it is replaced or the connection ends.
pub async fn run(hub: Arc<Hub>, scope: Scope, slot: Arc<LiveSlot>) {
    if !scope.board && scope.focus.is_none() {
        return;
    }
    let mut pump = Pump::default();
    let mut tick: u64 = 0;
    let mut window = (0i64, 0usize);
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if hub.shutdown.is_triggered() {
            return;
        }
        let now = now_ms(hub.clock.as_ref());
        if now - window.0 >= 1000 {
            window = (now, 0);
        }
        // Latest wins: the socket has not taken the last frame, so skip this tick rather than queue behind it.
        if slot.pending() || window.1 >= MAX_BYTES_PER_SEC {
            continue;
        }
        let first = tick == 0;
        let board_tick = first || tick.is_multiple_of(BOARD_EVERY);
        let mut lanes = Vec::new();
        if let Some(focus) = &scope.focus {
            lanes.extend(focus_lanes(&hub, &scope.caller, focus));
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
        window.1 += text.len();
        slot.offer(text);
    }
}

#[cfg(test)]
mod tests;
