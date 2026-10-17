//! The slot board: a global cap on running turns, per-project shares, and a FIFO queue within priority.
//! A slot is held while a lead's or task's T3 thread is running, read from the executor's thread events, and
//! from a grant until that thread first runs. Threads that belong to no lead or task are not counted.
//! TS spec: apps/hub/src/slots/Slots.ts.
pub mod board;

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
    /// A project's share, 0..1000.
    pub share: Option<(ProjectRef, i64)>,
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
                Op::Share(r, share) => {
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

/// The persisted board: cap, shares and claims as the last hub left them.
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
                    share: count(row.share),
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
        let slots = Arc::new(Self {
            db,
            board: Mutex::new(board),
            listeners: Mutex::new(Vec::new()),
            lead_of,
            cursor: head,
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
    /// it runs (a follow-up message), even past the cap, since T3 already started it.
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

    /// `cap_set`: the global cap, a project's share, or both. Persisted; applies at once.
    pub fn set_cap(&self, input: CapInput) -> Result<SlotState, StoreError> {
        self.locked(|b| {
            b.set_cap(input.cap, input.share);
            ((), true)
        })?;
        Ok(self.state())
    }

    pub fn state(&self) -> SlotState {
        slot_state(self.board().state())
    }
}
