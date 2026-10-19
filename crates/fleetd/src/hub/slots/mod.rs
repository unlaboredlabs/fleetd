//! The slot board: a fleet cap on running turns, each project's max agents, and a FIFO queue within priority.
//! A slot is held while a lead's or task's thread is running, read from the executor's thread events, and
//! from a grant until that thread first runs. Threads that belong to no lead or task are not counted.
pub mod board;
pub mod usage;

use std::sync::{Arc, Mutex};

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::model::ThreadStatus;
use fleetd_contracts::prim::{Int, List};
use fleetd_contracts::tasks::{SlotState, SlotStatePerProject, TaskKind};
use rusqlite::{OptionalExtension, params};

pub use board::{
    Board, BoardState, Claim, ClaimState, Grant, Op, SlotPriority, blocker, reserved_band,
};

use crate::hub::api::Shutdown;
use crate::hub::store::{EventLog, HubDb, HubStore, StoreError, WaitInput};

pub const DEFAULT_CAP: i64 = 40;

const RUNNING: [HubEventType; 1] = [HubEventType::ThreadStarted];
const STOPPED: [HubEventType; 5] = [
    HubEventType::ThreadCompleted,
    HubEventType::ThreadFailed,
    HubEventType::ThreadInterrupted,
    HubEventType::ThreadWaiting,
    HubEventType::ThreadUsageLimited,
];

pub fn priority_of(kind: TaskKind) -> SlotPriority {
    if kind == TaskKind::Review {
        SlotPriority::Review
    } else {
        SlotPriority::Work
    }
}

/// The slot holder for a project's lead turns. Tasks hold under their TaskId.
pub fn lead_holder(r: &ProjectRef) -> String {
    format!("lead:{}/{}", r.machine_id.as_str(), r.project_id.as_str())
}

/// The project whose lead currently runs in thread (`machine_id`, `thread_id`), from the leads area's records.
pub type LeadOf = Arc<dyn Fn(&MachineId, &ThreadId) -> Option<ProjectRef> + Send + Sync>;

/// Called after a slot frees (a release, or a lead's or task's thread stopping) or the cap or a share changes,
/// once the queue has been re-evaluated. Called outside the board's lock, but it must not block: the tasks area
/// spawns its queue retry from it.
pub type ReleaseListener = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Debug, Default)]
pub struct SlotsOptions {
    /// The cap until `cap_set` stores one.
    pub default_cap: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct CapInput {
    /// 1..1000.
    pub cap: Option<i64>,
    /// A project's max agents, 1 up to the cap.
    pub max_agents: Option<(ProjectRef, i64)>,
}

/// A project's agents as its lead is told them: "agents: 7 running of 12, 2 queued".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Agents {
    pub running: i64,
    pub max_agents: i64,
    pub queued: i64,
}

pub struct SlotRequest<'a> {
    /// A TaskId, or `lead_holder(project_ref)`.
    pub holder: &'a str,
    pub project_ref: &'a ProjectRef,
    pub priority: SlotPriority,
}

pub struct Slots {
    db: Arc<HubDb>,
    board: Mutex<Board>,
    listeners: Mutex<Vec<ReleaseListener>>,
    lead_of: LeadOf,
    /// The event log's head when the board was loaded; `run` follows from here.
    cursor: i64,
    time: std::sync::OnceLock<crate::hub::time::TimeSink>,
    /// While every slot is held: since when, and the most tasks queued meanwhile.
    full: Mutex<Option<(i64, i64)>>,
    usage: Mutex<usage::Usage>,
}

fn project_ref(m: String, p: String) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked(m),
        project_id: ProjectId::unchecked(p),
    }
}

fn persist(db: &HubDb, ops: Vec<Op>) -> Result<(), StoreError> {
    if ops.is_empty() {
        return Ok(());
    }
    db.transaction(|db| {
        for op in ops {
            match op {
                Op::Save(c) => {
                    db.prepare_cached(
                        "INSERT INTO slot_claims (holder, machine_id, project_id, priority, thread_id, state, order_n) VALUES (?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT (holder) DO UPDATE SET machine_id = excluded.machine_id, project_id = excluded.project_id,
                           priority = excluded.priority, thread_id = excluded.thread_id, state = excluded.state, order_n = excluded.order_n",
                    )?
                    .execute(params![
                        c.holder,
                        c.project_ref.machine_id.as_str(),
                        c.project_ref.project_id.as_str(),
                        c.priority.as_str(),
                        c.thread_id.as_ref().map(|t| t.as_str()),
                        c.state.as_str(),
                        c.order
                    ])?;
                }
                Op::Remove(holder) => {
                    db.prepare_cached("DELETE FROM slot_claims WHERE holder = ?")?.execute([holder])?;
                }
                Op::Cap(cap) => {
                    db.prepare_cached("INSERT INTO slot_settings (key, value) VALUES ('cap', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")?
                        .execute([cap])?;
                }
                // The table keeps its name from when this was a project's share, so an older hub's database opens.
                Op::MaxAgents(r, share) => {
                    db.prepare_cached(
                        "INSERT INTO slot_shares (machine_id, project_id, share) VALUES (?, ?, ?)
                         ON CONFLICT (machine_id, project_id) DO UPDATE SET share = excluded.share",
                    )?
                    .execute(params![r.machine_id.as_str(), r.project_id.as_str(), share])?;
                }
            }
        }
        Ok(())
    })
}

/// The persisted board: cap, max agents and claims as the last hub left them.
fn load(db: &HubDb, default_cap: i64) -> Result<Board, StoreError> {
    db.with(|db| {
        let cap: Option<i64> = db.query_row("SELECT value FROM slot_settings WHERE key = 'cap'", [], |r| r.get(0)).optional()?;
        let shares = db
            .prepare("SELECT machine_id, project_id, share FROM slot_shares")?
            .query_map([], |r| Ok((project_ref(r.get(0)?, r.get(1)?), r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let claims = db
            .prepare("SELECT holder, machine_id, project_id, priority, thread_id, state, order_n FROM slot_claims")?
            .query_map([], |r| {
                Ok(Claim {
                    holder: r.get(0)?,
                    project_ref: project_ref(r.get(1)?, r.get(2)?),
                    priority: SlotPriority::parse(&r.get::<_, String>(3)?),
                    thread_id: r.get::<_, Option<String>>(4)?.map(ThreadId::unchecked),
                    state: ClaimState::parse(&r.get::<_, String>(5)?),
                    order: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Board::new(cap.unwrap_or(default_cap), shares, claims))
    })
}

fn slot_state(s: BoardState) -> SlotState {
    let count = |n: i64| Int::unchecked(n.max(0));
    SlotState {
        cap: count(s.cap),
        used: count(s.used),
        queued: count(s.queued),
        reserved_band: count(s.reserved_band),
        per_project: List::unchecked(
            s.per_project
                .into_iter()
                .map(|row| SlotStatePerProject {
                    project_ref: row.project_ref,
                    max_agents: count(row.max_agents),
                    running: count(row.running),
                    queued: count(row.queued),
                    used: count(row.used),
                })
                .collect(),
        ),
    }
}

impl Slots {
    /// Loads the board, rebuilds held claims from each bound thread's stored status and counts running lead
    /// threads; `run` then follows thread events from the log's head as of now. The queue is re-evaluated when the
    /// first listener registers, so it hears about slots that came free while the hub was down.
    pub fn new(
        db: Arc<HubDb>,
        store: &HubStore,
        events: &EventLog,
        lead_of: LeadOf,
        options: SlotsOptions,
    ) -> Result<Arc<Self>, StoreError> {
        let mut board = load(&db, options.default_cap.unwrap_or(DEFAULT_CAP))?;
        let head = events.head();
        let bound: Vec<(String, ThreadRef)> = board
            .claims()
            .iter()
            .filter(|c| c.state != ClaimState::Queued)
            .filter_map(|c| {
                c.thread_id.clone().map(|t| {
                    (
                        c.holder.clone(),
                        ThreadRef {
                            machine_id: c.project_ref.machine_id.clone(),
                            thread_id: t,
                        },
                    )
                })
            })
            .collect();
        for (holder, thread) in bound {
            let running = store
                .thread_get(&thread)?
                .is_some_and(|t| t.thread.status == ThreadStatus::Running);
            board.restore(&holder, running);
        }
        persist(&db, board.take_ops())?;
        let at = board.state();
        let usage = usage::Usage::new(crate::hub::time::wall_ms(), at.used, at.cap);
        let slots = Arc::new(Self {
            db,
            board: Mutex::new(board),
            listeners: Mutex::new(Vec::new()),
            lead_of,
            cursor: head,
            time: std::sync::OnceLock::new(),
            full: Mutex::new(None),
            usage: Mutex::new(usage),
        });
        for t in store.threads_running()? {
            if slots
                .board()
                .find_by_thread(t.machine_id.as_str(), t.thread_id.as_str())
                .is_none()
            {
                slots.observe(&t.machine_id, &t.thread_id, true)?;
            }
        }
        Ok(slots)
    }

    /// Follows thread events until the hub stops: a lead's or task's thread running holds its slot, stopping frees it.
    pub async fn run(self: Arc<Self>, events: Arc<EventLog>, shutdown: Shutdown) {
        let types: Vec<HubEventType> = RUNNING.iter().chain(STOPPED.iter()).copied().collect();
        let mut cursor = self.cursor;
        loop {
            let input = WaitInput {
                cursor: Some(cursor),
                types: Some(types.clone()),
                machine_id: None,
                timeout_sec: 3600,
            };
            let page = tokio::select! {
                () = shutdown.wait() => return,
                page = events.wait(input) => page,
            };
            let page = match page {
                Ok(page) => page,
                Err(e) => {
                    tracing::warn!(error = %e, "slots: event wait failed");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            };
            cursor = page.cursor;
            for event in page.events {
                let (Some(m), Some(t)) = (&event.machine_id, &event.thread_id) else {
                    continue;
                };
                if let Err(e) = self.observe(m, t, RUNNING.contains(&event.r#type)) {
                    tracing::warn!(error = %e, "slots: thread event not applied");
                }
            }
        }
    }

    fn board(&self) -> std::sync::MutexGuard<'_, Board> {
        self.board.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Runs `body` on the board; when it freed capacity, re-evaluates the queue, persists, then runs the listeners.
    fn locked<R>(&self, body: impl FnOnce(&mut Board) -> (R, bool)) -> Result<R, StoreError> {
        let (result, freed) = {
            let mut board = self.board();
            let (result, freed) = body(&mut board);
            if freed {
                board.evaluate();
            }
            persist(&self.db, board.take_ops())?;
            self.track(&board.state());
            (result, freed)
        };
        if freed {
            self.notify();
        }
        Ok(result)
    }

    pub fn set_time(&self, sink: crate::hub::time::TimeSink) {
        let _ = self.time.set(sink);
    }

    fn track(&self, s: &BoardState) {
        self.saturation(s);
        self.usage
            .lock()
            .unwrap()
            .set(crate::hub::time::wall_ms(), s.used, s.cap);
    }

    /// How much of the cap the board held over the last hour.
    pub fn utilization(&self) -> usage::Utilization {
        self.usage.lock().unwrap().read(crate::hub::time::wall_ms())
    }

    /// A `slots.full` span on the fleet lane for each spell with every slot held, with the peak queue.
    fn saturation(&self, s: &BoardState) {
        let Some(time) = self.time.get() else { return };
        let mut full = self.full.lock().unwrap();
        let now = crate::hub::time::wall_ms();
        let span = |start: i64, end: Option<i64>, peak: i64| crate::hub::time::NewSpan {
            src_key: format!("slots/{start}"),
            kind: fleetd_contracts::time::SpanKind::SlotsFull,
            start_ms: start,
            end_ms: end,
            lane: "fleet".into(),
            extra: Some(fleetd_contracts::time::SpanExtra {
                peak_queued: fleetd_contracts::prim::Count::try_from(peak).ok(),
                cap: fleetd_contracts::prim::Count::try_from(s.cap).ok(),
                ..Default::default()
            }),
            ..Default::default()
        };
        match (*full, s.used >= s.cap) {
            (None, true) => {
                *full = Some((now, s.queued));
                time.span(span(now, None, s.queued));
            }
            (Some((start, peak)), true) => *full = Some((start, peak.max(s.queued))),
            (Some((start, peak)), false) => {
                *full = None;
                time.span(span(start, Some(now), peak));
            }
            (None, false) => {}
        }
    }

    fn notify(&self) {
        let listeners = self.listeners.lock().unwrap().clone();
        for listener in listeners {
            listener();
        }
    }

    /// Applies a thread's running/stopped status.
    fn observe(
        &self,
        machine_id: &MachineId,
        thread_id: &ThreadId,
        running: bool,
    ) -> Result<(), StoreError> {
        let unclaimed = self
            .board()
            .find_by_thread(machine_id.as_str(), thread_id.as_str())
            .is_none();
        let lead = if unclaimed && running {
            (self.lead_of)(machine_id, thread_id)
        } else {
            None
        };
        self.locked(|b| {
            (
                (),
                b.observe(machine_id.as_str(), thread_id, running, lead.as_ref()),
            )
        })
    }

    /// Takes a slot now, or queues the request (FIFO within priority) and says why. Asking again for a holder that
    /// already has a slot returns granted; for one already queued, its current reason.
    pub fn acquire(&self, request: SlotRequest<'_>) -> Result<Grant, StoreError> {
        self.locked(|b| {
            (
                b.acquire(request.holder, request.project_ref, request.priority),
                false,
            )
        })
    }

    /// The holder's slot follows `thread` from now on: freed whenever the thread stops running, taken again whenever
    /// it runs (a follow-up message), even past the cap, since the node already started it.
    pub fn bind(&self, holder: &str, thread: &ThreadRef) -> Result<(), StoreError> {
        self.locked(|b| (b.bind(holder, &thread.machine_id, &thread.thread_id), false))
    }

    /// The holder is done: drops its slot or its queued request, then re-evaluates the queue.
    pub fn release(&self, holder: &str) -> Result<(), StoreError> {
        self.locked(|b| ((), b.release(holder)))
    }

    /// Registers `listener` and runs it once now, after re-evaluating the queue.
    pub fn on_release(&self, listener: ReleaseListener) -> Result<(), StoreError> {
        self.listeners.lock().unwrap().push(listener.clone());
        {
            let mut board = self.board();
            board.evaluate();
            persist(&self.db, board.take_ops())?;
            self.track(&board.state());
        }
        listener();
        Ok(())
    }

    /// `cap_set`: the fleet cap, a project's max agents, or both. Persisted; applies at once, starting queued
    /// agents that now fit before it returns.
    pub fn set_cap(&self, input: CapInput) -> Result<SlotState, StoreError> {
        self.locked(|b| {
            b.set_cap(input.cap, input.max_agents);
            ((), true)
        })?;
        Ok(self.state())
    }

    pub fn agents(&self, r: &ProjectRef) -> Agents {
        let board = self.board();
        let (running, queued) = board.agents(r);
        Agents {
            running,
            max_agents: board.max_agents_of(r),
            queued,
        }
    }

    /// The queued holder's place in line, from 1 ([`Board::position`]).
    pub fn position(&self, holder: &str) -> Option<i64> {
        self.board().position(holder)
    }

    /// The project's running writers and readers above its max agents, newest first ([`Board::extras`]).
    pub fn extras(&self, r: &ProjectRef) -> Vec<String> {
        self.board().extras(r)
    }

    pub fn cap(&self) -> i64 {
        self.board().cap()
    }

    /// Slots the project's tasks could take now ([`Board::room`]).
    pub fn room(&self, r: &ProjectRef) -> i64 {
        self.board().room(r)
    }

    pub fn state(&self) -> SlotState {
        slot_state(self.board().state())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Barrier;

    use fleetd_contracts::ids::{MachineId, ProjectId};

    use super::*;
    use crate::hub::store::test_clock::ManualClock;

    /// Spawns racing from many lead calls at once take the board's lock one at a time: never past max agents.
    #[test]
    fn concurrent_spawns_never_overshoot_max_agents() {
        let db = HubDb::open_memory().unwrap();
        let store = HubStore::new(db.clone());
        let events = EventLog::new(db.clone(), ManualClock::at(1_792_000_000_000)).unwrap();
        let slots = Slots::new(
            db,
            &store,
            &events,
            Arc::new(|_, _| None),
            SlotsOptions::default(),
        )
        .unwrap();
        let r = ProjectRef {
            machine_id: MachineId::unchecked("lab-a"),
            project_id: ProjectId::unchecked("p1"),
        };
        slots
            .set_cap(CapInput {
                cap: None,
                max_agents: Some((r.clone(), 2)),
            })
            .unwrap();
        let n = 24;
        let start = Arc::new(Barrier::new(n));
        let granted: usize = std::thread::scope(|s| {
            let handles: Vec<_> = (1..=n)
                .map(|i| {
                    let (slots, r, start) = (&slots, &r, start.clone());
                    s.spawn(move || {
                        start.wait();
                        let holder = format!("T{i}");
                        let grant = slots.acquire(SlotRequest {
                            holder: &holder,
                            project_ref: r,
                            priority: SlotPriority::Work,
                        });
                        usize::from(grant.unwrap().granted())
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).sum()
        });
        assert_eq!(granted, 2);
        assert_eq!(
            slots.agents(&r),
            Agents {
                running: 2,
                max_agents: 2,
                queued: n as i64 - 2
            }
        );
    }
}
