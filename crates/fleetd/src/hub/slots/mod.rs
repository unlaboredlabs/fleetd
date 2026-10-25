//! The slot board: one queue under each machine's cap (what it fits, [`sizing`]), its disk room, each project's max
//! agents, and the fleet cap if a person set one; reviews go first, then the oldest. A slot is held while a task's
//! thread is running, read from the executor's thread events, and from a grant until that thread first runs. A lead
//! is not an agent and holds none.
mod board;
pub mod sizing;

use std::sync::{Arc, Mutex};

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::model::ThreadStatus;
use fleetd_contracts::node_link::NodeLoad;
use fleetd_contracts::prim::{Int, List, Text};
use fleetd_contracts::tasks::{
    MachineCapSource, SlotState, SlotStatePerMachine, SlotStatePerProject, TaskKind,
};
use rusqlite::{OptionalExtension, params};

use board::{Board, BoardState, Claim, ClaimState, Machine, Op};
pub use board::{Grant, MaxSource, SlotPriority};

use crate::clock::Clock;
use crate::hub::api::Shutdown;
use crate::hub::store::{EventLog, HubDb, HubStore, StoreError, WaitInput, now_ms};

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

/// Called after a slot frees (a release, or a task's thread stopping) or a cap changes,
/// once the queue has been re-evaluated. Called outside the board's lock, but it must not block: the tasks area
/// spawns its queue retry from it.
pub type ReleaseListener = Arc<dyn Fn() + Send + Sync>;

/// A `cap_set` change. Each field: None leaves that setting alone; Some(None) clears it back to auto (the fleet cap:
/// unset); Some(Some(n)) sets n.
#[derive(Clone, Debug, Default)]
pub struct CapInput {
    /// 1..1000.
    pub cap: Option<Option<i64>>,
    /// A project's max agents, 1 up to the cap.
    pub max_agents: Option<(ProjectRef, Option<i64>)>,
    /// A machine's cap, 1..1000.
    pub machine: Option<(MachineId, Option<i64>)>,
}

/// A project's agents as its lead is told them: "agents: 7 running of 12 (auto: memory 32 GB), 2 queued".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agents {
    pub running: i64,
    pub max_agents: i64,
    pub queued: i64,
    pub source: MaxSource,
}

pub struct SlotRequest<'a> {
    /// The TaskId.
    pub holder: &'a str,
    pub project_ref: &'a ProjectRef,
    pub priority: SlotPriority,
}

pub struct Slots {
    db: Arc<HubDb>,
    clock: Arc<dyn Clock>,
    board: Mutex<Board>,
    listeners: Mutex<Vec<ReleaseListener>>,
    /// The event log's head when the board was loaded; `run` follows from here.
    cursor: i64,
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
                Op::Cap(Some(cap)) => {
                    db.prepare_cached("INSERT INTO slot_settings (key, value) VALUES ('cap', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")?
                        .execute([cap])?;
                }
                Op::Cap(None) => {
                    db.prepare_cached("DELETE FROM slot_settings WHERE key = 'cap'")?.execute([])?;
                }
                // The table keeps its name from when this was a project's share, so an older hub's database opens.
                Op::MaxAgents(r, Some(share)) => {
                    db.prepare_cached(
                        "INSERT INTO slot_shares (machine_id, project_id, share) VALUES (?, ?, ?)
                         ON CONFLICT (machine_id, project_id) DO UPDATE SET share = excluded.share",
                    )?
                    .execute(params![r.machine_id.as_str(), r.project_id.as_str(), share])?;
                }
                Op::MaxAgents(r, None) => {
                    db.prepare_cached("DELETE FROM slot_shares WHERE machine_id = ? AND project_id = ?")?
                        .execute(params![r.machine_id.as_str(), r.project_id.as_str()])?;
                }
                Op::Machine(m) => {
                    db.prepare_cached(
                        "INSERT INTO slot_machine_caps (machine_id, name, auto, why, max_agents) VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT (machine_id) DO UPDATE SET name = excluded.name, auto = excluded.auto, why = excluded.why,
                           max_agents = excluded.max_agents",
                    )?
                    .execute(params![m.machine_id.as_str(), m.name, m.auto.cap, m.auto.why, m.max_agents])?;
                }
                Op::ForgetMachine(m) => {
                    db.prepare_cached("DELETE FROM slot_machine_caps WHERE machine_id = ?")?
                        .execute([m.as_str()])?;
                }
            }
        }
        Ok(())
    })
}

/// The persisted board: caps, max agents, machines and claims as the last hub left them. A fleet cap is saved only
/// once someone sets it; until then the machines' caps are the only limit across projects.
fn load(db: &HubDb) -> Result<Board, StoreError> {
    db.with(|db| {
        let cap: Option<i64> = db.query_row("SELECT value FROM slot_settings WHERE key = 'cap'", [], |r| r.get(0)).optional()?;
        let shares = db
            .prepare("SELECT machine_id, project_id, share FROM slot_shares")?
            .query_map([], |r| Ok((project_ref(r.get(0)?, r.get(1)?), r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let machines = db
            .prepare("SELECT machine_id, name, auto, why, max_agents FROM slot_machine_caps ORDER BY rowid")?
            .query_map([], |r| {
                Ok(Machine {
                    machine_id: MachineId::unchecked(r.get::<_, String>(0)?),
                    name: r.get(1)?,
                    auto: sizing::Auto {
                        cap: r.get(2)?,
                        why: r.get(3)?,
                    },
                    max_agents: r.get(4)?,
                    // Until its next heartbeat.
                    disk_room: None,
                })
            })?
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
        Ok(Board::new(cap, shares, machines, claims))
    })
}

fn slot_state(s: BoardState) -> SlotState {
    let count = |n: i64| Int::unchecked(n.max(0));
    SlotState {
        cap: count(s.cap),
        fleet_cap: s.fleet_cap.map(count),
        used: count(s.used),
        queued: count(s.queued),
        per_project: List::unchecked(
            s.per_project
                .into_iter()
                .map(|row| SlotStatePerProject {
                    project_ref: row.project_ref,
                    max_agents: count(row.max_agents),
                    set: row.set,
                    running: count(row.running),
                    queued: count(row.queued),
                })
                .collect(),
        ),
        per_machine: List::unchecked(
            s.per_machine
                .into_iter()
                .map(|row| SlotStatePerMachine {
                    machine_id: row.machine_id,
                    cap: count(row.cap),
                    auto: count(row.auto),
                    source: Some(if row.set {
                        MachineCapSource::Set
                    } else {
                        sizing::source(&row.why)
                    }),
                    why: Text::new(row.why).unwrap_or_else(|_| Text::unchecked("auto".to_owned())),
                    set: row.set,
                    running: count(row.running),
                    disk_room: row.disk_room.map(count),
                })
                .collect(),
        ),
    }
}

impl Slots {
    /// Loads the board and rebuilds held claims from each bound thread's stored status; `run` then follows thread
    /// events from the log's head as of now. The queue is re-evaluated when the first listener registers, so it
    /// hears about slots that came free while the hub was down.
    pub fn new(
        db: Arc<HubDb>,
        clock: Arc<dyn Clock>,
        store: &HubStore,
        events: &EventLog,
    ) -> Result<Arc<Self>, StoreError> {
        let mut board = load(&db)?;
        board.tick(now_ms(clock.as_ref()));
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
        Ok(Arc::new(Self {
            db,
            clock,
            board: Mutex::new(board),
            listeners: Mutex::new(Vec::new()),
            cursor: head,
        }))
    }

    /// Follows thread events until the hub stops: a task's thread running holds its slot, stopping frees it.
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

    /// Runs `body` on the board at the clock's time; when that or the time freed capacity, re-evaluates the queue,
    /// persists, then runs the listeners.
    fn locked<R>(&self, body: impl FnOnce(&mut Board) -> (R, bool)) -> Result<R, StoreError> {
        let (result, freed) = {
            let mut board = self.board();
            let settled = board.tick(now_ms(self.clock.as_ref()));
            let (result, freed) = body(&mut board);
            let freed = freed || settled;
            if freed {
                board.evaluate();
            }
            persist(&self.db, board.take_ops())?;
            (result, freed)
        };
        if freed {
            self.notify();
        }
        Ok(result)
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
        self.locked(|b| ((), b.observe(machine_id.as_str(), thread_id, running)))
    }

    /// A heartbeat's facts about the machine (`name` for the reasons people read): what it fits and its disk room.
    /// When it takes more than before, starts the queued agents that now fit and runs the listeners.
    pub fn observe_machine(
        &self,
        machine_id: &MachineId,
        name: &str,
        load: &NodeLoad,
    ) -> Result<(), StoreError> {
        let (auto, disk_room) = (sizing::auto_cap(load), sizing::disk_room(load));
        self.locked(|b| ((), b.observe_machine(machine_id, name, auto, disk_room)))
    }

    /// Takes a slot now, or queues the request (reviews first, then the oldest) and says why. Asking again for a holder that
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
        }
        listener();
        Ok(())
    }

    /// `cap_set`: the fleet cap, a project's max agents, a machine's cap, each a number or auto. Persisted; applies
    /// at once, starting queued agents that now fit before it returns.
    pub fn set_cap(&self, input: CapInput) -> Result<SlotState, StoreError> {
        self.locked(|b| {
            b.set_cap(input);
            ((), true)
        })?;
        Ok(self.state())
    }

    /// Drops the board's machines that are no longer the hub's: `fleetd machine remove` deletes a machine's row from
    /// the database directly, maybe while this hub runs, so their caps stop counting in the fleet's total.
    fn forget_removed(&self) -> Result<(), StoreError> {
        let kept: Vec<String> = self.db.with(|db| {
            db.prepare_cached("SELECT machine_id FROM slot_machine_caps")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()
                .map_err(StoreError::from)
        })?;
        let mut board = self.board();
        for m in board.machine_ids() {
            if !kept.iter().any(|k| k == m.as_str()) {
                board.forget_machine(&m);
            }
        }
        // Already gone from the database.
        board.take_ops();
        Ok(())
    }

    pub fn agents(&self, r: &ProjectRef) -> Agents {
        let board = self.board();
        let (running, queued) = board.agents(r);
        Agents {
            running,
            max_agents: board.max_agents_of(r),
            queued,
            source: board.max_source(r),
        }
    }

    /// The project's max agents as a person set it; None: auto.
    pub fn max_agents_set(&self, r: &ProjectRef) -> Option<i64> {
        self.board().setting(r)
    }

    /// The queued holder's place in line, from 1 ([`Board::position`]).
    pub fn position(&self, holder: &str) -> Option<i64> {
        self.board().position(holder)
    }

    /// The project's running writers and readers above its max agents, newest first ([`Board::extras`]).
    pub fn extras(&self, r: &ProjectRef) -> Vec<String> {
        self.board().extras(r)
    }

    /// The fleet cap a person set; None: the machines' caps alone.
    pub fn cap(&self) -> Option<i64> {
        self.board().cap()
    }

    /// The fleet cap when set, else what the machines fit together.
    pub fn total(&self) -> i64 {
        self.forget_removed_or_warn();
        self.board().total()
    }

    fn forget_removed_or_warn(&self) {
        if let Err(e) = self.forget_removed() {
            tracing::warn!(error = %e, "slots: removed machines not read");
        }
    }

    /// The machine's cap: a person's setting, else what it fits.
    pub fn machine_cap(&self, m: &MachineId) -> i64 {
        self.board().machine_cap(m)
    }

    /// Slots the project's tasks could take now ([`Board::room`]).
    pub fn room(&self, r: &ProjectRef) -> i64 {
        self.board().room(r)
    }

    pub fn state(&self) -> SlotState {
        self.forget_removed_or_warn();
        slot_state(self.board().state())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Barrier;

    use fleetd_contracts::ids::{MachineId, ProjectId};

    use super::*;
    use crate::hub::store::test_clock::ManualClock;

    /// A hub from when leads held slots: their claims go, a task's stays.
    #[test]
    fn stored_lead_claims_go_on_an_older_hub() {
        use crate::hub::store::migrations::MIGRATIONS;
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // Found by content, not as the last migration, so later migrations don't break this test.
        let at = MIGRATIONS
            .iter()
            .position(|m| m.contains("DELETE FROM slot_claims WHERE priority = 'lead'"))
            .unwrap();
        for m in &MIGRATIONS[..at] {
            conn.execute_batch(m).unwrap();
        }
        conn.execute_batch(
            "INSERT INTO slot_claims VALUES ('lead:lab-a/p1', 'lab-a', 'p1', 'lead', 'l1', 'held', 1),
               ('T1', 'lab-a', 'p1', 'work', 't1', 'held', 2);",
        )
        .unwrap();
        conn.execute_batch(MIGRATIONS[at]).unwrap();
        let holders: Vec<String> = conn
            .prepare("SELECT holder FROM slot_claims")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(holders, ["T1"]);
    }

    /// Spawns racing from many lead calls at once take the board's lock one at a time: never past max agents.
    #[test]
    fn concurrent_spawns_never_overshoot_max_agents() {
        let db = HubDb::open_memory().unwrap();
        let store = HubStore::new(db.clone());
        let clock = ManualClock::at(1_792_000_000_000);
        let events = EventLog::new(db.clone(), clock.clone()).unwrap();
        let slots = Slots::new(db, clock, &store, &events).unwrap();
        let r = ProjectRef {
            machine_id: MachineId::unchecked("lab-a"),
            project_id: ProjectId::unchecked("p1"),
        };
        slots
            .set_cap(CapInput {
                max_agents: Some((r.clone(), Some(2))),
                ..CapInput::default()
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
                queued: n as i64 - 2,
                source: MaxSource::Project,
            }
        );
    }
}
