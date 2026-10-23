//! The slot board's rules, without I/O: the service in `mod.rs` persists what `take_ops` hands it and feeds it
//! thread events.
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadId};

/// Queue order: reviews, then write and read tasks, oldest first within each. A review gates a merge, so writers
/// filling the cap never stall the train.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum SlotPriority {
    Review,
    Work,
}

impl SlotPriority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Review => "review",
            Self::Work => "work",
        }
    }
    pub fn parse(s: &str) -> Self {
        if s == "review" {
            Self::Review
        } else {
            Self::Work
        }
    }
}

/// What the slot board answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Grant {
    Granted,
    /// Queued; `reason` fits `Task.queuedReason`, e.g. "fleet cap: 40 of 40 running".
    Queued(String),
}

impl Grant {
    pub fn granted(&self) -> bool {
        matches!(self, Self::Granted)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimState {
    Queued,
    Held,
    Idle,
}

impl ClaimState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Held => "held",
            Self::Idle => "idle",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "held" => Self::Held,
            "idle" => Self::Idle,
            _ => Self::Queued,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Claim {
    pub holder: String,
    pub project_ref: ProjectRef,
    pub priority: SlotPriority,
    pub thread_id: Option<ThreadId>,
    pub state: ClaimState,
    pub order: i64,
}

/// A write the service persists, in order.
#[derive(Clone, Debug)]
pub enum Op {
    Save(Claim),
    Remove(String),
    Cap(i64),
    MaxAgents(ProjectRef, i64),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRow {
    pub project_ref: ProjectRef,
    pub max_agents: i64,
    pub running: i64,
    pub queued: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardState {
    pub cap: i64,
    pub used: i64,
    pub queued: i64,
    pub per_project: Vec<ProjectRow>,
}

fn same(a: &ProjectRef, b: &ProjectRef) -> bool {
    a.machine_id == b.machine_id && a.project_id == b.project_id
}

/// Every claim is a task's: a lead is not an agent and holds no slot. Claims and max agents keep insertion order,
/// since `state` lists projects in that order.
pub struct Board {
    cap: i64,
    max_agents: Vec<(ProjectRef, i64)>,
    claims: Vec<Claim>,
    next_order: i64,
    ops: Vec<Op>,
}

impl Board {
    pub fn new(cap: i64, max_agents: Vec<(ProjectRef, i64)>, claims: Vec<Claim>) -> Self {
        let next_order = claims.iter().map(|c| c.order).max().unwrap_or(0).max(0) + 1;
        Self {
            cap,
            max_agents,
            claims,
            next_order,
            ops: Vec::new(),
        }
    }

    /// The writes made since the last call.
    pub fn take_ops(&mut self) -> Vec<Op> {
        std::mem::take(&mut self.ops)
    }

    pub fn cap(&self) -> i64 {
        self.cap
    }

    pub fn claims(&self) -> &[Claim] {
        &self.claims
    }

    fn idx(&self, holder: &str) -> Option<usize> {
        self.claims.iter().position(|c| c.holder == holder)
    }

    fn save(&mut self, i: usize) {
        self.ops.push(Op::Save(self.claims[i].clone()));
    }

    /// The project's max agents: the fleet cap until set.
    pub fn max_agents_of(&self, r: &ProjectRef) -> i64 {
        self.max_agents
            .iter()
            .find(|(s, _)| same(s, r))
            .map_or(self.cap, |(_, n)| *n)
    }

    /// Slots held fleet-wide, and by the project's agents.
    fn held(&self, r: &ProjectRef) -> (i64, i64) {
        let held = self.claims.iter().filter(|c| c.state == ClaimState::Held);
        held.fold((0, 0), |(used, mine), c| {
            (used + 1, mine + i64::from(same(&c.project_ref, r)))
        })
    }

    /// Why a task of the project cannot take a slot now, or `None` if it can.
    fn blocker(&self, r: &ProjectRef) -> Option<String> {
        let (used, running) = self.held(r);
        let (cap, max) = (self.cap, self.max_agents_of(r));
        if used >= cap {
            Some(format!("fleet cap: {used} of {cap} running"))
        } else if running >= max {
            Some(format!("Max agents: {running} of {max} running"))
        } else {
            None
        }
    }

    /// How many more of the project's tasks could take a slot now: under the fleet cap and its max agents.
    pub fn room(&self, r: &ProjectRef) -> i64 {
        let (used, running) = self.held(r);
        (self.cap - used)
            .min(self.max_agents_of(r) - running)
            .max(0)
    }

    /// The queued holder's place in line, from 1: among its project's queued agents when its max agents holds it
    /// back, else among every queued claim.
    pub fn position(&self, holder: &str) -> Option<i64> {
        let c = &self.claims[self.idx(holder)?];
        if c.state != ClaimState::Queued {
            return None;
        }
        let by_project = self.held(&c.project_ref).1 >= self.max_agents_of(&c.project_ref);
        let key = |x: &Claim| (x.priority, x.order);
        let ahead = self
            .claims
            .iter()
            .filter(|x| x.state == ClaimState::Queued && key(x) < key(c))
            .filter(|x| !by_project || same(&x.project_ref, &c.project_ref))
            .count() as i64;
        Some(ahead + 1)
    }

    /// The project's agents holding a slot and waiting for one.
    pub fn agents(&self, r: &ProjectRef) -> (i64, i64) {
        let (mut running, mut queued) = (0, 0);
        for c in self.claims.iter().filter(|c| same(&c.project_ref, r)) {
            match c.state {
                ClaimState::Held => running += 1,
                ClaimState::Queued => queued += 1,
                ClaimState::Idle => {}
            }
        }
        (running, queued)
    }

    /// Grants every queued claim that fits, reviews first, then oldest first.
    pub fn evaluate(&mut self) {
        let mut queue: Vec<usize> = (0..self.claims.len())
            .filter(|&i| self.claims[i].state == ClaimState::Queued)
            .collect();
        queue.sort_by_key(|&i| (self.claims[i].priority, self.claims[i].order));
        for i in queue {
            if self.blocker(&self.claims[i].project_ref).is_none() {
                self.claims[i].state = ClaimState::Held;
                self.save(i);
            }
        }
    }

    /// Asking again for a holder that already has a slot returns granted; for one already queued, its current
    /// reason. An idle holder (its thread stopped) joins the back of the queue.
    pub fn acquire(
        &mut self,
        holder: &str,
        project_ref: &ProjectRef,
        priority: SlotPriority,
    ) -> Grant {
        let i = match self.idx(holder) {
            Some(i) if self.claims[i].state == ClaimState::Held => return Grant::Granted,
            Some(i) => {
                let c = &mut self.claims[i];
                c.project_ref = project_ref.clone();
                c.priority = priority;
                if c.state == ClaimState::Idle {
                    c.state = ClaimState::Queued;
                    c.order = self.next_order;
                    self.next_order += 1;
                }
                i
            }
            None => {
                self.claims.push(Claim {
                    holder: holder.to_owned(),
                    project_ref: project_ref.clone(),
                    priority,
                    thread_id: None,
                    state: ClaimState::Queued,
                    order: self.next_order,
                });
                self.next_order += 1;
                self.claims.len() - 1
            }
        };
        self.save(i);
        self.evaluate();
        if self.claims[i].state == ClaimState::Held {
            return Grant::Granted;
        }
        self.blocker(project_ref)
            .map_or(Grant::Granted, Grant::Queued)
    }

    /// The holder's slot follows the thread from now on.
    pub fn bind(&mut self, holder: &str, machine_id: &MachineId, thread_id: &ThreadId) {
        if let Some(i) = self.idx(holder)
            && self.claims[i].project_ref.machine_id == *machine_id
        {
            self.claims[i].thread_id = Some(thread_id.clone());
            self.save(i);
        }
    }

    /// Drops the holder's claim; true when that freed a held slot (the caller then evaluates and notifies).
    pub fn release(&mut self, holder: &str) -> bool {
        let Some(i) = self.idx(holder) else {
            return false;
        };
        let c = self.claims.remove(i);
        self.ops.push(Op::Remove(c.holder));
        c.state == ClaimState::Held
    }

    /// Applies a bound thread's running/stopped status; a thread no claim follows is not counted. True when a slot
    /// was freed.
    pub fn observe(&mut self, machine_id: &str, thread_id: &ThreadId, running: bool) -> bool {
        let Some(i) = self.claims.iter().position(|c| {
            c.thread_id.as_ref() == Some(thread_id)
                && c.project_ref.machine_id.as_str() == machine_id
        }) else {
            return false;
        };
        if running {
            self.claims[i].state = ClaimState::Held;
            self.save(i);
            return false;
        }
        if self.claims[i].state != ClaimState::Held {
            return false;
        }
        self.claims[i].state = ClaimState::Idle;
        self.save(i);
        true
    }

    /// Startup: a claim bound to a thread follows that thread's last known status.
    pub fn restore(&mut self, holder: &str, running: bool) {
        if let Some(i) = self.idx(holder) {
            self.claims[i].state = if running {
                ClaimState::Held
            } else {
                ClaimState::Idle
            };
            self.save(i);
        }
    }

    /// `cap_set`. Always counts as freeing capacity, so the caller evaluates and notifies. Lowering revokes nothing.
    pub fn set_cap(&mut self, cap: Option<i64>, max_agents: Option<(ProjectRef, i64)>) {
        if let Some(cap) = cap {
            self.cap = cap;
            self.ops.push(Op::Cap(cap));
        }
        if let Some((r, n)) = max_agents {
            match self.max_agents.iter_mut().find(|(s, _)| same(s, &r)) {
                Some(entry) => entry.1 = n,
                None => self.max_agents.push((r.clone(), n)),
            }
            self.ops.push(Op::MaxAgents(r, n));
        }
    }

    /// The project's agents running beyond its max agents, newest first, writers and readers only: a review gates a
    /// merge, so it is never paused.
    pub fn extras(&self, r: &ProjectRef) -> Vec<String> {
        let (running, _) = self.agents(r);
        let over = (running - self.max_agents_of(r)).max(0) as usize;
        let mut work: Vec<&Claim> = self
            .claims
            .iter()
            .filter(|c| {
                c.state == ClaimState::Held
                    && c.priority == SlotPriority::Work
                    && same(&c.project_ref, r)
            })
            .collect();
        work.sort_by_key(|c| std::cmp::Reverse(c.order));
        work.into_iter()
            .take(over)
            .map(|c| c.holder.clone())
            .collect()
    }

    pub fn state(&self) -> BoardState {
        let mut rows: Vec<ProjectRow> = self
            .max_agents
            .iter()
            .map(|(r, n)| ProjectRow {
                project_ref: r.clone(),
                max_agents: *n,
                running: 0,
                queued: 0,
            })
            .collect();
        for c in self.claims.iter().filter(|c| c.state != ClaimState::Idle) {
            let k = match rows
                .iter()
                .position(|row| same(&row.project_ref, &c.project_ref))
            {
                Some(k) => k,
                None => {
                    rows.push(ProjectRow {
                        project_ref: c.project_ref.clone(),
                        max_agents: self.max_agents_of(&c.project_ref),
                        running: 0,
                        queued: 0,
                    });
                    rows.len() - 1
                }
            };
            if c.state == ClaimState::Held {
                rows[k].running += 1;
            } else {
                rows[k].queued += 1;
            }
        }
        // Stable, like Array.prototype.sort.
        rows.sort_by_key(|row| std::cmp::Reverse(row.running));
        rows.truncate(50);
        let count = |s: ClaimState| self.claims.iter().filter(|c| c.state == s).count() as i64;
        BoardState {
            cap: self.cap,
            used: count(ClaimState::Held),
            queued: count(ClaimState::Queued),
            per_project: rows,
        }
    }
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::ids::{MachineId, ProjectId};

    use super::*;

    fn project(p: &str) -> ProjectRef {
        ProjectRef {
            machine_id: MachineId::unchecked("lab-a"),
            project_id: ProjectId::unchecked(p),
        }
    }

    fn tid(t: &str) -> ThreadId {
        ThreadId::unchecked(t)
    }

    /// The board plus what the tasks area's release listener would see: holders in the order they got a slot
    /// other than from their own `acquire`.
    struct Kit {
        board: Board,
        seen: Vec<String>,
        grants: Vec<String>,
    }

    impl Kit {
        fn new(cap: i64) -> Self {
            Self {
                board: Board::new(cap, vec![], vec![]),
                seen: vec![],
                grants: vec![],
            }
        }
        fn held(&self) -> Vec<String> {
            let mut held: Vec<&Claim> = self
                .board
                .claims()
                .iter()
                .filter(|c| c.state == ClaimState::Held)
                .collect();
            held.sort_by_key(|c| c.order);
            held.into_iter().map(|c| c.holder.clone()).collect()
        }
        /// What the service does after a change that freed capacity.
        fn freed(&mut self) {
            self.board.evaluate();
            for h in self.held() {
                if !self.seen.contains(&h) {
                    self.grants.push(h.clone());
                    self.seen.push(h);
                }
            }
        }
        fn acquire(&mut self, holder: &str, r: &ProjectRef, p: SlotPriority) -> Grant {
            let g = self.board.acquire(holder, r, p);
            if g.granted() && !self.seen.iter().any(|s| s == holder) {
                self.seen.push(holder.to_owned());
            }
            g
        }
        fn work(&mut self, holder: &str) -> Grant {
            self.acquire(holder, &project("pa"), SlotPriority::Work)
        }
        fn release(&mut self, holder: &str) {
            if self.board.release(holder) {
                self.freed();
            }
        }
        fn thread(&mut self, t: &str, running: bool) {
            if self.board.observe("lab-a", &tid(t), running) {
                self.freed();
            }
        }
        fn set_cap(
            &mut self,
            cap: Option<i64>,
            max_agents: Option<(ProjectRef, i64)>,
        ) -> BoardState {
            self.board.set_cap(cap, max_agents);
            self.freed();
            self.board.state()
        }
    }

    fn queued(reason: &str) -> Grant {
        Grant::Queued(reason.to_owned())
    }

    #[test]
    fn room_is_what_a_task_of_the_project_could_take_now() {
        let (a, b) = (project("pa"), project("pb"));
        let mut k = Kit::new(10);
        assert_eq!(k.board.room(&a), 10);
        k.work("T1");
        k.acquire("T2", &b, SlotPriority::Work);
        assert_eq!((k.board.room(&a), k.board.room(&b)), (8, 8));
        k.set_cap(None, Some((a.clone(), 1)));
        assert_eq!((k.board.room(&a), k.board.room(&b)), (0, 8));
        k.release("T1");
        assert_eq!(k.board.room(&a), 1);
    }

    #[test]
    fn queues_past_the_cap_and_grants_the_next_on_release() {
        let mut k = Kit::new(2);
        assert_eq!(k.work("T1"), Grant::Granted);
        assert_eq!(k.work("T2"), Grant::Granted);
        assert_eq!(k.work("T3"), queued("fleet cap: 2 of 2 running"));
        assert_eq!(k.work("T1"), Grant::Granted);
        let s = k.board.state();
        assert_eq!((s.cap, s.used, s.queued), (2, 2, 1));
        k.release("T1");
        assert_eq!(k.grants, ["T3"]);
        // Releasing a queued request just drops it.
        k.work("T4");
        assert!(!k.board.release("T4"));
        k.release("T2");
        assert_eq!(k.grants, ["T3"]);
        let s = k.board.state();
        assert_eq!((s.used, s.queued), (1, 0));
    }

    /// Both caps hold: a project under its own max still waits at the fleet cap, and one at its max waits while
    /// another project starts.
    #[test]
    fn the_fleet_cap_and_each_projects_max_agents_both_hold() {
        let (a, b) = (project("pa"), project("pb"));
        let mut k = Kit::new(3);
        k.set_cap(None, Some((a.clone(), 1)));
        assert_eq!(k.acquire("T1", &a, SlotPriority::Work), Grant::Granted);
        assert_eq!(
            k.acquire("T2", &a, SlotPriority::Work),
            queued("Max agents: 1 of 1 running")
        );
        assert_eq!(k.acquire("T3", &b, SlotPriority::Work), Grant::Granted);
        assert_eq!(k.acquire("T4", &b, SlotPriority::Work), Grant::Granted);
        assert_eq!(
            k.acquire("T5", &b, SlotPriority::Work),
            queued("fleet cap: 3 of 3 running")
        );
        assert_eq!(
            k.board.state().per_project,
            [
                ProjectRow {
                    project_ref: b.clone(),
                    max_agents: 3,
                    running: 2,
                    queued: 1
                },
                ProjectRow {
                    project_ref: a.clone(),
                    max_agents: 1,
                    running: 1,
                    queued: 1
                },
            ]
        );
        // T1's slot frees: a's T2 takes it, oldest first. T5 waits for the fleet cap until b's T3 ends.
        k.release("T1");
        assert_eq!(k.grants, ["T2"]);
        k.release("T3");
        assert_eq!(k.grants, ["T2", "T5"]);
        assert_eq!((k.board.agents(&a), k.board.agents(&b)), ((1, 0), (2, 0)));
    }

    #[test]
    fn serves_reviews_then_work_fifo_within_each() {
        let a = project("pa");
        let mut k = Kit::new(1);
        k.work("T1");
        k.work("T2");
        k.work("T3");
        k.acquire("R1", &a, SlotPriority::Review);
        k.acquire("R2", &a, SlotPriority::Review);
        assert_eq!(k.board.position("R1"), Some(1));
        assert_eq!(k.board.position("T2"), Some(3));
        for h in ["T1", "R1", "R2", "T2"] {
            k.release(h);
        }
        assert_eq!(k.grants, ["R1", "R2", "T2", "T3"]);
    }

    /// The deadlock to avoid: at max agents 1 a writer's PR waits on its review, and more writers are queued. The
    /// review jumps them, so the train moves.
    #[test]
    fn at_max_agents_one_a_gating_review_runs_before_queued_writers() {
        let a = project("pa");
        let mut k = Kit::new(40);
        k.set_cap(None, Some((a.clone(), 1)));
        k.work("T1");
        k.board.bind("T1", &a.machine_id, &tid("t1"));
        k.thread("t1", true);
        k.work("T2");
        k.work("T3");
        assert_eq!(
            k.acquire("R1", &a, SlotPriority::Review),
            queued("Max agents: 1 of 1 running")
        );
        assert_eq!(
            k.board.position("R1"),
            Some(1),
            "first in line though it came last"
        );
        // The writer ends its turn (or reports its slice and stops): the review takes the slot.
        k.thread("t1", false);
        assert_eq!(k.grants, ["R1"]);
        k.release("R1");
        k.release("T1");
        assert_eq!(k.grants, ["R1", "T2"]);
        k.release("T2");
        assert_eq!(k.grants, ["R1", "T2", "T3"]);
    }

    /// Pausing the extras picks the newest writers and readers above the max; a review is never one.
    #[test]
    fn the_extras_are_the_newest_writers_never_a_review() {
        let a = project("pa");
        let mut k = Kit::new(40);
        for n in 1..=4 {
            k.work(&format!("T{n}"));
        }
        k.acquire("R1", &a, SlotPriority::Review);
        k.set_cap(None, Some((a.clone(), 3)));
        assert_eq!(k.board.agents(&a), (5, 0), "lowering stops nothing");
        assert_eq!(k.board.extras(&a), ["T4", "T3"]);
    }

    #[test]
    fn applies_cap_changes_and_keeps_them_across_a_restart() {
        let mut k = Kit::new(1);
        k.work("T1");
        k.work("T2");
        k.work("T3");
        let raised = k.set_cap(Some(2), None);
        assert_eq!(k.grants, ["T2"], "raising starts a queued agent at once");
        assert_eq!((raised.cap, raised.used, raised.queued), (2, 2, 1));
        // Lowering the cap revokes nothing; it only stops new grants.
        let lowered = k.set_cap(Some(1), None);
        assert_eq!((lowered.cap, lowered.used, lowered.queued), (1, 2, 1));
        k.release("T1");
        assert_eq!(k.grants, ["T2"]);
        assert!(k.board.take_ops().iter().any(|op| matches!(op, Op::Cap(1))));

        // A restarted board from the persisted rows, then the first listener's evaluate.
        let mut second = Kit {
            board: Board::new(1, vec![], k.board.claims().to_vec()),
            seen: vec![],
            grants: vec![],
        };
        second.seen = second.held();
        let s = second.board.state();
        assert_eq!((s.cap, s.used, s.queued), (1, 1, 1));
        second.release("T2");
        assert_eq!(second.grants, ["T3"]);
    }

    #[test]
    fn holds_a_slot_only_while_the_bound_thread_runs() {
        let a = project("pa");
        let mut k = Kit::new(1);
        k.work("T1");
        k.board.bind("T1", &a.machine_id, &tid("t1"));
        k.work("T2");
        k.thread("t1", true);
        let s = k.board.state();
        assert_eq!((s.used, s.queued), (1, 1));
        k.thread("t1", false);
        assert_eq!(k.grants, ["T2"]);
        // A follow-up message ran T1 again outside the board: it counts, even past the cap.
        k.thread("t1", true);
        let s = k.board.state();
        assert_eq!((s.cap, s.used), (1, 2));
        assert_eq!(k.work("T1"), Grant::Granted);
        k.thread("t1", false);
        assert_eq!(k.board.state().used, 1);
        // An idle holder asking again queues behind the others.
        k.work("T3");
        assert_eq!(k.work("T1"), queued("fleet cap: 1 of 1 running"));
        k.release("T2");
        assert_eq!(k.grants, ["T2", "T3"]);
    }

    /// A lead is not an agent: its thread, or any other no task is bound to, takes no slot.
    #[test]
    fn a_thread_no_task_holds_takes_no_slot() {
        let mut k = Kit::new(1);
        k.thread("lead1", true);
        assert_eq!(k.board.state().used, 0);
        assert_eq!(k.work("T1"), Grant::Granted);
    }
}
