//! The slot board's rules, without I/O: the service in `mod.rs` persists what `take_ops` hands it and feeds it
//! thread events.
use fleetd_contracts::ids::{ProjectRef, ThreadId};

/// Queue order: lead turns, then reviews, then write and read tasks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotPriority {
    Lead,
    Review,
    Work,
}

impl SlotPriority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lead => "lead",
            Self::Review => "review",
            Self::Work => "work",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "lead" => Self::Lead,
            "review" => Self::Review,
            _ => Self::Work,
        }
    }
    fn rank(self) -> u8 {
        self as u8
    }
}

/// What slots and leases answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Grant {
    Granted,
    /// Queued; `reason` fits `Task.queuedReason`, e.g. "slots: 40/40 in use".
    Queued(String),
}

impl Grant {
    pub fn granted(&self) -> bool {
        matches!(self, Self::Granted)
    }
}

/// Slots of the cap only lead turns may take: min(4, floor(10 % of cap)). Caps below 10 have no band, so a tiny
/// cap is never wholly reserved and tasks can always run.
pub fn reserved_band(cap: i64) -> i64 {
    (cap / 10).min(4)
}

#[derive(Clone, Copy, Debug)]
pub struct BoardView {
    pub cap: i64,
    pub used: i64,
    /// The project's agents holding a slot; its lead's turns don't count.
    pub project_running: i64,
    pub max_agents: i64,
}

/// Why a request of `priority` cannot take a slot now, or `None` if it can. Leads may use the reserved band and
/// are not agents, so a project's max agents never holds them back.
pub fn blocker(board: BoardView, priority: SlotPriority) -> Option<String> {
    let BoardView {
        cap,
        used,
        project_running,
        max_agents,
    } = board;
    let band = reserved_band(cap);
    if priority == SlotPriority::Lead {
        return (used >= cap).then(|| format!("slots: {used}/{cap} in use"));
    }
    if used >= cap - band {
        return Some(if band == 0 {
            format!("slots: {used}/{cap} in use")
        } else {
            format!("slots: {used}/{cap} in use ({band} reserved for lead turns)")
        });
    }
    if project_running >= max_agents {
        return Some(format!("agents: {project_running}/{max_agents} running"));
    }
    None
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
    pub used: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardState {
    pub cap: i64,
    pub used: i64,
    pub queued: i64,
    pub reserved_band: i64,
    pub per_project: Vec<ProjectRow>,
}

fn same(a: &ProjectRef, b: &ProjectRef) -> bool {
    a.machine_id == b.machine_id && a.project_id == b.project_id
}

/// Claims and max agents keep insertion order, since `state` lists projects in that order.
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

    fn view(&self, r: &ProjectRef) -> BoardView {
        let held = self.claims.iter().filter(|c| c.state == ClaimState::Held);
        let (mut used, mut project_running) = (0, 0);
        for c in held {
            used += 1;
            if c.priority != SlotPriority::Lead && same(&c.project_ref, r) {
                project_running += 1;
            }
        }
        BoardView {
            cap: self.cap,
            used,
            project_running,
            max_agents: self.max_agents_of(r),
        }
    }

    /// How many more write, read or review tasks of the project could take a slot now: under the cap less the lead
    /// band, and under its max agents.
    pub fn room(&self, r: &ProjectRef) -> i64 {
        let v = self.view(r);
        (v.cap - reserved_band(v.cap) - v.used)
            .min(v.max_agents - v.project_running)
            .max(0)
    }

    /// The queued holder's place in line, from 1: among its project's queued agents when its max agents holds it
    /// back, else among every queued claim. Grant order: best priority, then oldest.
    pub fn position(&self, holder: &str) -> Option<i64> {
        let i = self.idx(holder)?;
        let c = &self.claims[i];
        if c.state != ClaimState::Queued {
            return None;
        }
        let v = self.view(&c.project_ref);
        let by_project = c.priority != SlotPriority::Lead && v.project_running >= v.max_agents;
        let key = |x: &Claim| (x.priority.rank(), x.order);
        let ahead = self
            .claims
            .iter()
            .filter(|x| x.state == ClaimState::Queued && key(x) < key(c))
            .filter(|x| {
                !by_project
                    || (x.priority != SlotPriority::Lead && same(&x.project_ref, &c.project_ref))
            })
            .count() as i64;
        Some(ahead + 1)
    }

    /// The project's agents holding a slot and waiting for one.
    pub fn agents(&self, r: &ProjectRef) -> (i64, i64) {
        let mine = self
            .claims
            .iter()
            .filter(|c| c.priority != SlotPriority::Lead && same(&c.project_ref, r));
        let (mut running, mut queued) = (0, 0);
        for c in mine {
            match c.state {
                ClaimState::Held => running += 1,
                ClaimState::Queued => queued += 1,
                ClaimState::Idle => {}
            }
        }
        (running, queued)
    }

    fn reason_for(&self, i: usize) -> Option<String> {
        let c = &self.claims[i];
        blocker(self.view(&c.project_ref), c.priority)
    }

    /// Grants every queued claim that fits, best priority and oldest first.
    pub fn evaluate(&mut self) {
        let mut queue: Vec<usize> = (0..self.claims.len())
            .filter(|&i| self.claims[i].state == ClaimState::Queued)
            .collect();
        queue.sort_by_key(|&i| (self.claims[i].priority.rank(), self.claims[i].order));
        for i in queue {
            if self.reason_for(i).is_some() {
                continue;
            }
            self.claims[i].state = ClaimState::Held;
            self.save(i);
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
        self.reason_for(i).map_or(Grant::Granted, Grant::Queued)
    }

    /// The holder's slot follows the thread from now on.
    pub fn bind(
        &mut self,
        holder: &str,
        machine_id: &fleetd_contracts::ids::MachineId,
        thread_id: &ThreadId,
    ) {
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

    pub fn find_by_thread(&self, machine_id: &str, thread_id: &str) -> Option<&Claim> {
        self.claims.iter().find(|c| {
            c.thread_id
                .as_ref()
                .is_some_and(|t| t.as_str() == thread_id)
                && c.project_ref.machine_id.as_str() == machine_id
        })
    }

    /// Applies a thread's running/stopped status. `lead` is the project whose lead runs in this thread, looked up
    /// by the caller only when no claim follows the thread and it runs. True when a slot was freed.
    pub fn observe(
        &mut self,
        machine_id: &str,
        thread_id: &ThreadId,
        running: bool,
        lead: Option<&ProjectRef>,
    ) -> bool {
        let mut i = self.claims.iter().position(|c| {
            c.thread_id.as_ref() == Some(thread_id)
                && c.project_ref.machine_id.as_str() == machine_id
        });
        if i.is_none()
            && let Some(project_ref) = lead
        {
            // A lead's first run, or its first under a new thread after a lead restart.
            let holder = super::lead_holder(project_ref);
            let j = match self.idx(&holder) {
                Some(j) => j,
                None => {
                    self.claims.push(Claim {
                        holder,
                        project_ref: project_ref.clone(),
                        priority: SlotPriority::Lead,
                        thread_id: None,
                        state: ClaimState::Idle,
                        order: self.next_order,
                    });
                    self.next_order += 1;
                    self.claims.len() - 1
                }
            };
            self.claims[j].thread_id = Some(thread_id.clone());
            i = Some(j);
        }
        let Some(i) = i else { return false };
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
                used: 0,
            })
            .collect();
        for c in &self.claims {
            if c.state == ClaimState::Idle {
                continue;
            }
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
                        used: 0,
                    });
                    rows.len() - 1
                }
            };
            let agent = c.priority != SlotPriority::Lead;
            match c.state {
                ClaimState::Held => {
                    rows[k].used += 1;
                    rows[k].running += i64::from(agent);
                }
                ClaimState::Queued => rows[k].queued += i64::from(agent),
                ClaimState::Idle => {}
            }
        }
        // Stable, like Array.prototype.sort.
        rows.sort_by_key(|row| std::cmp::Reverse(row.used));
        rows.truncate(50);
        let count = |s: ClaimState| self.claims.iter().filter(|c| c.state == s).count() as i64;
        BoardState {
            cap: self.cap,
            used: count(ClaimState::Held),
            queued: count(ClaimState::Queued),
            reserved_band: reserved_band(self.cap),
            per_project: rows,
        }
    }
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::ids::{MachineId, ProjectId};

    use super::super::lead_holder;
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
        fn thread(&mut self, t: &str, running: bool, lead: Option<&ProjectRef>) {
            let lead = if running && self.board.find_by_thread("lab-a", t).is_none() {
                lead
            } else {
                None
            };
            if self.board.observe("lab-a", &tid(t), running, lead) {
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
    fn reserved_band_is_min_4_and_a_tenth_and_never_the_whole_cap() {
        let caps = [1, 2, 9, 10, 19, 20, 40, 41, 1000];
        assert_eq!(caps.map(reserved_band), [0, 0, 0, 1, 1, 2, 4, 4, 4]);
        for cap in 1..=1000 {
            assert!(reserved_band(cap) < cap);
        }
    }

    #[test]
    fn blocker_keeps_the_band_for_leads_and_lets_only_leads_pass_a_full_project() {
        let board = BoardView {
            cap: 10,
            used: 9,
            project_running: 0,
            max_agents: 10,
        };
        assert_eq!(
            blocker(board, SlotPriority::Work).as_deref(),
            Some("slots: 9/10 in use (1 reserved for lead turns)")
        );
        assert_eq!(blocker(board, SlotPriority::Lead), None);
        assert_eq!(
            blocker(BoardView { used: 10, ..board }, SlotPriority::Lead).as_deref(),
            Some("slots: 10/10 in use")
        );
        let tiny = BoardView {
            cap: 2,
            used: 2,
            project_running: 0,
            max_agents: 2,
        };
        assert_eq!(
            blocker(tiny, SlotPriority::Review).as_deref(),
            Some("slots: 2/2 in use")
        );
        let shared = BoardView {
            cap: 40,
            used: 3,
            project_running: 3,
            max_agents: 3,
        };
        assert_eq!(
            blocker(shared, SlotPriority::Work).as_deref(),
            Some("agents: 3/3 running")
        );
        assert_eq!(blocker(shared, SlotPriority::Lead), None);
    }

    #[test]
    fn room_is_what_a_task_of_the_project_could_take_now() {
        let (a, b) = (project("pa"), project("pb"));
        let mut k = Kit::new(10);
        assert_eq!(k.board.room(&a), 9, "one slot is the lead band");
        k.work("T1");
        k.acquire(&lead_holder(&b), &b, SlotPriority::Lead);
        assert_eq!((k.board.room(&a), k.board.room(&b)), (7, 7));
        k.set_cap(None, Some((a.clone(), 1)));
        assert_eq!((k.board.room(&a), k.board.room(&b)), (0, 7));
        k.release("T1");
        assert_eq!(k.board.room(&a), 1);
    }

    #[test]
    fn queues_past_the_cap_and_grants_the_next_on_release() {
        let mut k = Kit::new(2);
        assert_eq!(k.work("T1"), Grant::Granted);
        assert_eq!(k.work("T2"), Grant::Granted);
        assert_eq!(k.work("T3"), queued("slots: 2/2 in use"));
        assert_eq!(k.work("T1"), Grant::Granted);
        let s = k.board.state();
        assert_eq!((s.cap, s.used, s.queued, s.reserved_band), (2, 2, 1, 0));
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

    #[test]
    fn serves_leads_then_reviews_then_work_fifo_within_each() {
        let a = project("pa");
        let mut k = Kit::new(1);
        k.work("T1");
        k.work("T2");
        k.work("T3");
        k.acquire("R1", &a, SlotPriority::Review);
        k.acquire("R2", &a, SlotPriority::Review);
        k.acquire(&lead_holder(&a), &a, SlotPriority::Lead);
        for h in [
            "T1".to_owned(),
            lead_holder(&a),
            "R1".into(),
            "R2".into(),
            "T2".into(),
        ] {
            k.release(&h);
        }
        assert_eq!(
            k.grants,
            [
                lead_holder(&a),
                "R1".into(),
                "R2".into(),
                "T2".into(),
                "T3".into()
            ]
        );
    }

    #[test]
    fn keeps_the_reserved_band_free_for_lead_turns() {
        let (a, b) = (project("pa"), project("pb"));
        let mut k = Kit::new(10);
        for n in 1..=9 {
            assert_eq!(k.work(&format!("T{n}")), Grant::Granted);
        }
        assert_eq!(
            k.work("T10"),
            queued("slots: 9/10 in use (1 reserved for lead turns)")
        );
        assert_eq!(
            k.acquire(&lead_holder(&b), &b, SlotPriority::Lead),
            Grant::Granted
        );
        assert_eq!(
            k.acquire(&lead_holder(&a), &a, SlotPriority::Lead),
            queued("slots: 10/10 in use")
        );
    }

    #[test]
    fn holds_a_project_to_its_max_agents_without_blocking_others() {
        let (a, b) = (project("pa"), project("pb"));
        let mut k = Kit::new(5);
        k.set_cap(None, Some((a.clone(), 1)));
        assert_eq!(k.acquire("T1", &a, SlotPriority::Work), Grant::Granted);
        assert_eq!(
            k.acquire("T2", &a, SlotPriority::Work),
            queued("agents: 1/1 running")
        );
        assert_eq!(k.acquire("T3", &b, SlotPriority::Work), Grant::Granted);
        assert_eq!(
            k.board.state().per_project,
            [
                ProjectRow {
                    project_ref: a.clone(),
                    max_agents: 1,
                    running: 1,
                    queued: 1,
                    used: 1
                },
                ProjectRow {
                    project_ref: b,
                    max_agents: 5,
                    running: 1,
                    queued: 0,
                    used: 1
                }
            ]
        );
        k.release("T1");
        assert_eq!(k.grants, ["T2"]);
    }

    fn running(k: &Kit, r: &ProjectRef) -> i64 {
        k.board.agents(r).0
    }

    #[test]
    fn max_agents_two_runs_six_spawns_two_at_a_time_and_all_of_them() {
        let a = project("pa");
        let mut k = Kit::new(40);
        k.set_cap(None, Some((a.clone(), 2)));
        let all: Vec<String> = (1..=6).map(|n| format!("T{n}")).collect();
        for t in &all {
            k.work(t);
            assert!(running(&k, &a) <= 2);
        }
        assert_eq!(k.board.agents(&a), (2, 4));
        assert_eq!(k.board.position("T3"), Some(1));
        assert_eq!(k.board.position("T6"), Some(4));
        let mut done = Vec::new();
        while let Some(t) = k.held().into_iter().next() {
            k.release(&t);
            done.push(t);
            assert!(running(&k, &a) <= 2, "never more than 2 running");
        }
        assert_eq!(done, all, "all six ran, in spawn order");
    }

    #[test]
    fn a_projects_lead_is_not_one_of_its_agents() {
        let a = project("pa");
        let mut k = Kit::new(40);
        k.set_cap(None, Some((a.clone(), 1)));
        k.acquire(&lead_holder(&a), &a, SlotPriority::Lead);
        assert_eq!(
            k.work("T1"),
            Grant::Granted,
            "a running lead turn takes none of its agents' room"
        );
        assert_eq!(k.work("T2"), queued("agents: 1/1 running"));
        let row = &k.board.state().per_project[0];
        assert_eq!(
            (row.max_agents, row.running, row.queued, row.used),
            (1, 1, 1, 2)
        );
    }

    #[test]
    fn lowering_max_agents_stops_nothing_and_new_agents_wait() {
        let a = project("pa");
        let mut k = Kit::new(40);
        k.set_cap(None, Some((a.clone(), 12)));
        for n in 1..=4 {
            k.work(&format!("T{n}"));
        }
        k.acquire("R1", &a, SlotPriority::Review);
        k.set_cap(None, Some((a.clone(), 3)));
        assert_eq!(
            k.board.agents(&a),
            (5, 0),
            "every running agent keeps its slot"
        );
        assert_eq!(k.work("T6"), queued("agents: 5/3 running"));
        // Pausing the extras picks the newest writers and readers; the review is never one.
        assert_eq!(k.board.extras(&a), ["T4", "T3"]);
        k.release("T1");
        k.release("T2");
        assert!(k.grants.is_empty(), "still 3 running: T6 waits");
        k.release("T3");
        assert_eq!(k.grants, ["T6"]);
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
        k.thread("t1", true, None);
        k.work("T2");
        k.work("T3");
        assert_eq!(
            k.acquire("R1", &a, SlotPriority::Review),
            queued("agents: 1/1 running")
        );
        assert_eq!(
            k.board.position("R1"),
            Some(1),
            "first in line though it came last"
        );
        // The writer ends its turn (or reports its slice and stops): the review takes the slot.
        k.thread("t1", false, None);
        assert_eq!(k.grants, ["R1"]);
        k.release("R1");
        k.release("T1");
        assert_eq!(k.grants, ["R1", "T2"]);
        k.release("T2");
        assert_eq!(k.grants, ["R1", "T2", "T3"]);
    }

    #[test]
    fn applies_cap_changes_and_keeps_them_across_a_restart() {
        let mut k = Kit::new(1);
        k.work("T1");
        k.work("T2");
        k.work("T3");
        let raised = k.set_cap(Some(2), None);
        assert_eq!(k.grants, ["T2"]);
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
        k.thread("t1", true, None);
        let s = k.board.state();
        assert_eq!((s.used, s.queued), (1, 1));
        k.thread("t1", false, None);
        assert_eq!(k.grants, ["T2"]);
        // A follow-up message ran T1 again outside the board: it counts, even past the cap.
        k.thread("t1", true, None);
        let s = k.board.state();
        assert_eq!((s.cap, s.used), (1, 2));
        assert_eq!(k.work("T1"), Grant::Granted);
        k.thread("t1", false, None);
        assert_eq!(k.board.state().used, 1);
        // An idle holder asking again queues behind the others.
        k.work("T3");
        assert_eq!(k.work("T1"), queued("slots: 1/1 in use"));
        k.release("T2");
        assert_eq!(k.grants, ["T2", "T3"]);
    }

    #[test]
    fn counts_running_lead_threads_across_a_lead_restart() {
        let a = project("pa");
        let mut k = Kit::new(2);
        k.thread("lead1", true, Some(&a));
        k.thread("someone-elses", true, None);
        let s = k.board.state();
        assert_eq!(s.used, 1);
        assert_eq!(s.per_project[0].used, 1);
        k.work("T1");
        assert_eq!(k.work("T2"), queued("slots: 2/2 in use"));
        k.thread("lead1", false, None);
        assert_eq!(k.grants, ["T2"]);
        // The lead restarted onto lead2: the claim moves there.
        k.thread("lead2", true, Some(&a));
        assert_eq!(k.board.state().used, 3);
        k.thread("lead1", false, None);
        assert_eq!(k.board.state().used, 3);
    }
}
