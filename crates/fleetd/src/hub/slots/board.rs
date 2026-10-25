//! The slot board's rules, without I/O: the service in `mod.rs` persists what `take_ops` hands it and feeds it
//! thread events, machine facts and the time.
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId};

use super::sizing::{self, Auto};

/// An agent started this recently still counts against its machine's disk room: its worktree hasn't grown yet.
pub const SETTLE_MS: i64 = 10 * 60 * 1000;

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

/// One machine as the board sizes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Machine {
    pub machine_id: MachineId,
    /// Its name, for the reasons people read.
    pub name: String,
    /// What it fits, as last measured; kept while it is offline.
    pub auto: Auto,
    /// A person's setting; None: auto.
    pub max_agents: Option<i64>,
    /// New agents its free disk took at the last heartbeat; None while its node reports no disk.
    pub disk_room: Option<i64>,
    /// The projects that fit fewer here at their own measured memory per agent ([`sizing::project_caps`]), as of the
    /// last heartbeat.
    pub projects: Vec<(ProjectId, Auto)>,
}

impl Machine {
    pub fn cap(&self) -> i64 {
        self.max_agents.unwrap_or(self.auto.cap)
    }

    /// Why it fits that many: "memory 18 GB", or "set" for a person's setting.
    pub fn why(&self) -> &str {
        if self.max_agents.is_some() {
            "set"
        } else {
            &self.auto.why
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
    /// A machine's measure, not a person's setting.
    Machine(MachineId, String, Auto),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRow {
    pub project_ref: ProjectRef,
    pub max_agents: i64,
    pub running: i64,
    pub queued: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MachineRow {
    pub machine_id: MachineId,
    pub cap: i64,
    pub auto: i64,
    pub why: String,
    pub running: i64,
    pub disk_room: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardState {
    /// The fleet cap when set, else the machines' caps added up.
    pub cap: i64,
    pub fleet_cap: Option<i64>,
    pub used: i64,
    pub queued: i64,
    pub per_project: Vec<ProjectRow>,
    pub per_machine: Vec<MachineRow>,
}

/// What a project's max agents comes from, for its lead's line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MaxSource {
    /// A person set the project's max agents.
    Project,
    /// A person set its machine's cap.
    Machine,
    /// Its machine's own measure, and the term that sets it.
    Auto(String),
}

/// The narrowest limit a queued claim waits behind; its place in line is counted among the claims it shares it with.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Limit {
    Fleet,
    Machine,
    Project,
}

fn same(a: &ProjectRef, b: &ProjectRef) -> bool {
    a.machine_id == b.machine_id && a.project_id == b.project_id
}

/// Every claim is a task's: a lead is not an agent and holds no slot. Claims and max agents keep insertion order,
/// since `state` lists projects in that order.
pub struct Board {
    /// The fleet cap a person (or an older hub) saved; None: the machines' caps alone.
    cap: Option<i64>,
    max_agents: Vec<(ProjectRef, i64)>,
    machines: Vec<Machine>,
    claims: Vec<Claim>,
    /// New agents granted in the last [`SETTLE_MS`]: holder, machine, when. In memory only: after a restart the
    /// next heartbeats' free space already counts them.
    starts: Vec<(String, MachineId, i64)>,
    now_ms: i64,
    next_order: i64,
    ops: Vec<Op>,
}

impl Board {
    pub fn new(
        cap: Option<i64>,
        max_agents: Vec<(ProjectRef, i64)>,
        machines: Vec<Machine>,
        claims: Vec<Claim>,
    ) -> Self {
        let next_order = claims.iter().map(|c| c.order).max().unwrap_or(0).max(0) + 1;
        Self {
            cap,
            max_agents,
            machines,
            claims,
            starts: Vec::new(),
            now_ms: 0,
            next_order,
            ops: Vec::new(),
        }
    }

    /// The time, before each change; starts older than [`SETTLE_MS`] stop counting against disk room. True when
    /// one did, so a machine short of room may take more.
    pub fn tick(&mut self, now_ms: i64) -> bool {
        self.now_ms = now_ms;
        let before = self.starts.len();
        self.starts.retain(|(_, _, at)| now_ms - at < SETTLE_MS);
        self.starts.len() < before
    }

    /// The writes made since the last call.
    pub fn take_ops(&mut self) -> Vec<Op> {
        std::mem::take(&mut self.ops)
    }

    pub fn cap(&self) -> Option<i64> {
        self.cap
    }

    /// The fleet cap when set, else what the machines fit together.
    pub fn total(&self) -> i64 {
        self.cap
            .unwrap_or_else(|| self.machines.iter().map(Machine::cap).sum())
    }

    fn machine(&self, m: &MachineId) -> Option<&Machine> {
        self.machines.iter().find(|x| x.machine_id == *m)
    }

    /// The machine's cap: a person's setting, else what it fits; [`sizing::UNMEASURED`] until its node reports.
    pub fn machine_cap(&self, m: &MachineId) -> i64 {
        self.machine(m).map_or(sizing::UNMEASURED, Machine::cap)
    }

    /// New agents the machine's disk takes now: its last room less the agents started there since they settle.
    /// None: no limit known.
    fn disk_room(&self, m: &MachineId) -> Option<i64> {
        let room = self.machine(m)?.disk_room?;
        let recent = self.starts.iter().filter(|(_, x, _)| x == m).count() as i64;
        Some((room - recent).max(0))
    }

    /// A heartbeat's facts. True when the machine now takes more than before, so the caller evaluates and notifies.
    pub fn observe_machine(
        &mut self,
        machine_id: &MachineId,
        name: &str,
        auto: Auto,
        disk_room: Option<i64>,
    ) -> bool {
        let room_before = self.disk_room(machine_id).unwrap_or(i64::MAX);
        let cap_before = self.machine_cap(machine_id);
        let i = match self
            .machines
            .iter()
            .position(|x| x.machine_id == *machine_id)
        {
            Some(i) => i,
            None => {
                self.machines.push(Machine {
                    machine_id: machine_id.clone(),
                    name: name.to_owned(),
                    auto: auto.clone(),
                    max_agents: None,
                    disk_room,
                    projects: Vec::new(),
                });
                self.ops
                    .push(Op::Machine(machine_id.clone(), name.to_owned(), auto));
                return self.machine_cap(machine_id) > cap_before
                    || self.disk_room(machine_id).unwrap_or(i64::MAX) > room_before;
            }
        };
        let m = &mut self.machines[i];
        m.disk_room = disk_room;
        if m.auto != auto || m.name != name {
            m.auto = auto.clone();
            m.name = name.to_owned();
            self.ops
                .push(Op::Machine(machine_id.clone(), name.to_owned(), auto));
        }
        self.machine_cap(machine_id) > cap_before
            || self.disk_room(machine_id).unwrap_or(i64::MAX) > room_before
    }

    /// The projects measured on a machine at its heartbeat, after [`Self::observe_machine`]. True when one of them
    /// now takes more than before, so the caller evaluates and notifies.
    pub fn observe_projects(
        &mut self,
        machine_id: &MachineId,
        projects: Vec<(ProjectId, Auto)>,
    ) -> bool {
        let Some(m) = self
            .machines
            .iter_mut()
            .find(|x| x.machine_id == *machine_id)
        else {
            return false;
        };
        let grew = m.projects.iter().any(|(p, before)| {
            projects
                .iter()
                .find(|(q, _)| q == p)
                .is_none_or(|(_, now)| now.cap > before.cap)
        });
        m.projects = projects;
        grew
    }

    /// The project's own measure on its machine, while no person set the machine's cap.
    fn project_auto(&self, r: &ProjectRef) -> Option<&Auto> {
        let m = self
            .machine(&r.machine_id)
            .filter(|m| m.max_agents.is_none())?;
        m.projects
            .iter()
            .find(|(p, _)| *p == r.project_id)
            .map(|(_, auto)| auto)
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

    /// The project's max agents: until set, its machine's cap, or fewer at the project's own measured memory.
    pub fn max_agents_of(&self, r: &ProjectRef) -> i64 {
        let machine_cap = self.machine_cap(&r.machine_id);
        self.max_agents
            .iter()
            .find(|(s, _)| same(s, r))
            .map_or_else(
                || {
                    self.project_auto(r)
                        .map_or(machine_cap, |a| a.cap.min(machine_cap))
                },
                |(_, n)| *n,
            )
    }

    pub fn max_source(&self, r: &ProjectRef) -> MaxSource {
        if self.max_agents.iter().any(|(s, _)| same(s, r)) {
            return MaxSource::Project;
        }
        if let Some(auto) = self.project_auto(r) {
            return MaxSource::Auto(auto.why.clone());
        }
        match self.machine(&r.machine_id) {
            Some(m) if m.max_agents.is_some() => MaxSource::Machine,
            Some(m) => MaxSource::Auto(m.auto.why.clone()),
            None => MaxSource::Auto(sizing::UNMEASURED_WHY.to_owned()),
        }
    }

    /// Slots held fleet-wide, on the project's machine, and by the project's agents.
    fn held(&self, r: &ProjectRef) -> (i64, i64, i64) {
        let held = self.claims.iter().filter(|c| c.state == ClaimState::Held);
        held.fold((0, 0, 0), |(used, machine, mine), c| {
            (
                used + 1,
                machine + i64::from(c.project_ref.machine_id == r.machine_id),
                mine + i64::from(same(&c.project_ref, r)),
            )
        })
    }

    /// Why a task of the project cannot take a slot now, or `None` if it can. `fresh`: it would start a new agent
    /// (no thread yet), which disk room limits; a paused agent continues in the worktree it has.
    fn blocker(&self, r: &ProjectRef, fresh: bool) -> Option<String> {
        let (used, on_machine, running) = self.held(r);
        let m = &r.machine_id;
        let (machine_cap, max) = (self.machine_cap(m), self.max_agents_of(r));
        let name = self.machine(m).map_or(m.as_str(), |x| x.name.as_str());
        if let Some(cap) = self.cap
            && used >= cap
        {
            Some(format!("fleet cap: {used} of {cap} running"))
        } else if on_machine >= machine_cap {
            let why = self.machine(m).map_or(sizing::UNMEASURED_WHY, Machine::why);
            Some(format!(
                "machine cap: {on_machine} of {machine_cap} running on {name} ({why})"
            ))
        } else if fresh && self.disk_room(m) == Some(0) {
            Some(format!(
                "disk: no room for another agent on {name} until the new worktrees settle or space frees"
            ))
        } else if running >= max {
            Some(
                match self
                    .project_auto(r)
                    .filter(|_| !self.max_agents.iter().any(|(s, _)| same(s, r)))
                {
                    Some(auto) => format!("Max agents: {running} of {max} running ({})", auto.why),
                    None => format!("Max agents: {running} of {max} running"),
                },
            )
        } else {
            None
        }
    }

    /// The narrowest limit the project's tasks wait behind now, if any.
    fn limit(&self, r: &ProjectRef) -> Option<Limit> {
        let (used, on_machine, running) = self.held(r);
        if running >= self.max_agents_of(r) {
            Some(Limit::Project)
        } else if on_machine >= self.machine_cap(&r.machine_id)
            || self.disk_room(&r.machine_id) == Some(0)
        {
            Some(Limit::Machine)
        } else if self.cap.is_some_and(|cap| used >= cap) {
            Some(Limit::Fleet)
        } else {
            None
        }
    }

    /// How many more of the project's tasks could start now: under the fleet cap if set, its machine's cap and disk
    /// room, and its max agents.
    pub fn room(&self, r: &ProjectRef) -> i64 {
        let (used, on_machine, running) = self.held(r);
        let fleet = self.cap.map_or(i64::MAX, |cap| cap - used);
        let disk = self.disk_room(&r.machine_id).unwrap_or(i64::MAX);
        fleet
            .min(self.machine_cap(&r.machine_id) - on_machine)
            .min(disk)
            .min(self.max_agents_of(r) - running)
            .max(0)
    }

    /// The queued holder's place in line, from 1: among its project's queued agents when its max agents holds it
    /// back, among its machine's when the machine does, else among every queued claim.
    pub fn position(&self, holder: &str) -> Option<i64> {
        let c = &self.claims[self.idx(holder)?];
        if c.state != ClaimState::Queued {
            return None;
        }
        let limit = self.limit(&c.project_ref);
        let key = |x: &Claim| (x.priority, x.order);
        let ahead = self
            .claims
            .iter()
            .filter(|x| x.state == ClaimState::Queued && key(x) < key(c))
            .filter(|x| match limit {
                Some(Limit::Project) => same(&x.project_ref, &c.project_ref),
                Some(Limit::Machine) => x.project_ref.machine_id == c.project_ref.machine_id,
                Some(Limit::Fleet) | None => true,
            })
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
            let fresh = self.claims[i].thread_id.is_none();
            if self.blocker(&self.claims[i].project_ref, fresh).is_none() {
                self.claims[i].state = ClaimState::Held;
                if fresh {
                    let c = &self.claims[i];
                    let start = (
                        c.holder.clone(),
                        c.project_ref.machine_id.clone(),
                        self.now_ms,
                    );
                    self.starts.push(start);
                }
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
        self.blocker(project_ref, self.claims[i].thread_id.is_none())
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
        // Granted but never launched (the node went offline, or the launch failed): it made no worktree.
        let unlaunched =
            c.thread_id.is_none() && self.starts.iter().any(|(h, _, _)| *h == c.holder);
        self.starts.retain(|(h, _, _)| *h != c.holder);
        self.ops.push(Op::Remove(c.holder));
        c.state == ClaimState::Held || unlaunched
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
            self.cap = Some(cap);
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
        let per_machine = self
            .machines
            .iter()
            .take(50)
            .map(|m| MachineRow {
                machine_id: m.machine_id.clone(),
                cap: m.cap(),
                auto: m.auto.cap,
                why: m.auto.why.clone(),
                running: self
                    .claims
                    .iter()
                    .filter(|c| {
                        c.state == ClaimState::Held && c.project_ref.machine_id == m.machine_id
                    })
                    .count() as i64,
                disk_room: self.disk_room(&m.machine_id),
            })
            .collect();
        BoardState {
            cap: self.total(),
            fleet_cap: self.cap,
            used: count(ClaimState::Held),
            queued: count(ClaimState::Queued),
            per_project: rows,
            per_machine,
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

    fn mid(m: &str) -> MachineId {
        MachineId::unchecked(m)
    }

    /// A machine that fits `cap`, with room on its disk for `disk_room` new agents if known.
    fn machine(m: &str, cap: i64, disk_room: Option<i64>) -> Machine {
        Machine {
            machine_id: mid(m),
            name: format!("{m}-box"),
            auto: Auto {
                cap,
                why: "memory 18 GB".to_owned(),
            },
            max_agents: None,
            disk_room,
            projects: Vec::new(),
        }
    }

    /// The board plus what the tasks area's release listener would see: holders in the order they got a slot
    /// other than from their own `acquire`.
    struct Kit {
        board: Board,
        seen: Vec<String>,
        grants: Vec<String>,
    }

    impl Kit {
        /// A fleet cap of `cap`, on a machine big enough not to bind.
        fn new(cap: i64) -> Self {
            Self::on(Some(cap), vec![machine("lab-a", sizing::HARD_TOP, None)])
        }
        fn on(cap: Option<i64>, machines: Vec<Machine>) -> Self {
            Self {
                board: Board::new(cap, vec![], machines, vec![]),
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
        assert_eq!((s.cap, s.fleet_cap, s.used, s.queued), (2, Some(2), 2, 1));
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
                    max_agents: sizing::HARD_TOP,
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
            board: Board::new(
                Some(1),
                vec![],
                vec![machine("lab-a", sizing::HARD_TOP, None)],
                k.board.claims().to_vec(),
            ),
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

    fn on_machine(m: &str, p: &str) -> ProjectRef {
        ProjectRef {
            machine_id: mid(m),
            project_id: ProjectId::unchecked(p),
        }
    }

    /// With no fleet cap, each machine runs what it fits, and a project's max agents is its machine's cap until set.
    #[test]
    fn each_machine_runs_what_it_fits_with_no_fleet_cap() {
        let (air, big) = (on_machine("air", "pa"), on_machine("big", "pb"));
        let mut k = Kit::on(
            None,
            vec![machine("air", 2, None), machine("big", 56, None)],
        );
        assert_eq!(k.board.max_agents_of(&air), 2);
        assert_eq!(
            k.board.max_source(&air),
            MaxSource::Auto("memory 18 GB".to_owned())
        );
        k.acquire("T1", &air, SlotPriority::Work);
        k.acquire("T2", &air, SlotPriority::Work);
        assert_eq!(
            k.acquire("T3", &air, SlotPriority::Work),
            queued("machine cap: 2 of 2 running on air-box (memory 18 GB)")
        );
        // Another project on the same machine waits for the machine too, behind the first.
        let other = on_machine("air", "pc");
        assert_eq!(
            k.acquire("T4", &other, SlotPriority::Work),
            queued("machine cap: 2 of 2 running on air-box (memory 18 GB)")
        );
        assert_eq!(
            k.board.position("T4"),
            Some(2),
            "behind T3 on the same machine"
        );
        for n in 5..=60 {
            k.acquire(&format!("T{n}"), &big, SlotPriority::Work);
        }
        let s = k.board.state();
        assert_eq!((s.cap, s.fleet_cap, s.used), (58, None, 58));
        assert_eq!(
            s.per_machine
                .iter()
                .map(|m| (m.cap, m.running))
                .collect::<Vec<_>>(),
            [(2, 2), (56, 56)]
        );
        assert_eq!(k.board.room(&air), 0);
        k.release("T1");
        assert_eq!(k.grants, ["T3"]);
    }

    /// A fleet cap someone saved still holds across the machines.
    #[test]
    fn a_saved_fleet_cap_holds_under_the_machines_total() {
        let (a, b) = (on_machine("m1", "pa"), on_machine("m2", "pb"));
        let mut k = Kit::on(
            Some(3),
            vec![machine("m1", 6, None), machine("m2", 6, None)],
        );
        for (h, r) in [("T1", &a), ("T2", &a), ("T3", &b)] {
            assert_eq!(k.acquire(h, r, SlotPriority::Work), Grant::Granted);
        }
        assert_eq!(
            k.acquire("T4", &b, SlotPriority::Work),
            queued("fleet cap: 3 of 3 running")
        );
        let s = k.board.state();
        assert_eq!((s.cap, s.fleet_cap), (3, Some(3)));
        assert_eq!(k.board.total(), 3);
    }

    /// An agent started in the last 10 minutes still counts against its machine's disk room; a paused one
    /// continuing in its worktree doesn't.
    #[test]
    fn disk_room_counts_agents_started_until_they_settle() {
        let a = on_machine("air", "pa");
        let mut k = Kit::on(None, vec![machine("air", 8, Some(2))]);
        k.board.tick(1_000);
        k.acquire("T1", &a, SlotPriority::Work);
        k.acquire("T2", &a, SlotPriority::Work);
        assert_eq!(
            k.acquire("T3", &a, SlotPriority::Work),
            queued(
                "disk: no room for another agent on air-box until the new worktrees settle or space frees"
            )
        );
        assert_eq!(k.board.room(&a), 0);
        assert_eq!(k.board.state().per_machine[0].disk_room, Some(0));
        // A heartbeat with the same free space changes nothing; ten minutes on, the two have settled.
        assert!(!k.board.observe_machine(
            &mid("air"),
            "air-box",
            machine("air", 8, None).auto,
            Some(2)
        ));
        assert!(!k.board.tick(1_000 + SETTLE_MS - 1));
        assert!(k.board.tick(1_000 + SETTLE_MS));
        k.freed();
        assert_eq!(k.grants, ["T3"]);
        // A paused agent (bound to its thread) continues past no room.
        k.board.bind("T1", &a.machine_id, &tid("t1"));
        k.board.observe("air", &tid("t1"), false);
        assert!(!k.board.observe_machine(
            &mid("air"),
            "air-box",
            machine("air", 8, None).auto,
            Some(0)
        ));
        assert_eq!(k.acquire("T1", &a, SlotPriority::Work), Grant::Granted);
    }

    /// A granted agent that never launched made no worktree: releasing it gives its disk room back.
    #[test]
    fn an_unlaunched_grant_gives_its_disk_room_back() {
        let a = on_machine("air", "pa");
        let mut k = Kit::on(None, vec![machine("air", 8, Some(1))]);
        k.acquire("T1", &a, SlotPriority::Work);
        k.acquire("T2", &a, SlotPriority::Work);
        k.release("T1");
        assert_eq!(k.grants, ["T2"]);
    }

    /// A heartbeat that measures more room, or a bigger machine, starts queued agents; an unmeasured machine
    /// takes four.
    #[test]
    fn a_machine_measured_bigger_frees_capacity() {
        let a = on_machine("new", "pa");
        let mut k = Kit::on(None, vec![]);
        assert_eq!(k.board.machine_cap(&mid("new")), sizing::UNMEASURED);
        for n in 1..=5 {
            k.acquire(&format!("T{n}"), &a, SlotPriority::Work);
        }
        assert_eq!(k.board.agents(&a), (4, 1));
        assert_eq!(
            k.board.max_source(&a),
            MaxSource::Auto(sizing::UNMEASURED_WHY.to_owned())
        );
        let auto = Auto {
            cap: 12,
            why: "memory 32 GB".to_owned(),
        };
        assert!(
            k.board
                .observe_machine(&mid("new"), "new-box", auto.clone(), None)
        );
        assert!(
            matches!(k.board.take_ops().last(), Some(Op::Machine(m, _, x)) if *m == mid("new") && *x == auto)
        );
        k.freed();
        assert_eq!(k.board.agents(&a), (5, 0));
        k.board.take_ops();
        assert!(!k.board.observe_machine(&mid("new"), "new-box", auto, None));
        assert!(
            k.board.take_ops().is_empty(),
            "an unchanged measure isn't saved again"
        );
    }

    /// A project measured at 4.1 GB an agent runs fewer than the machine fits at 2 GB, and its lead's line and its
    /// queued agents say which figure it is; the others on the machine keep the machine's cap.
    #[test]
    fn a_project_measured_bigger_runs_fewer_and_says_why() {
        let (rust, docs) = (on_machine("big", "rust"), on_machine("big", "docs"));
        let mut k = Kit::on(None, vec![machine("big", 6, None)]);
        let why = "memory 4.1 GB per agent, seen on this project";
        let own = |cap: i64| {
            vec![(
                ProjectId::unchecked("rust"),
                Auto {
                    cap,
                    why: why.to_owned(),
                },
            )]
        };
        assert!(!k.board.observe_projects(&mid("big"), own(2)));
        assert_eq!(k.board.max_agents_of(&rust), 2);
        assert_eq!(k.board.max_source(&rust), MaxSource::Auto(why.to_owned()));
        assert_eq!(k.board.max_agents_of(&docs), 6);
        k.acquire("T1", &rust, SlotPriority::Work);
        k.acquire("T2", &rust, SlotPriority::Work);
        assert_eq!(
            k.acquire("T3", &rust, SlotPriority::Work),
            queued(&format!("Max agents: 2 of 2 running ({why})"))
        );
        assert_eq!(k.acquire("T4", &docs, SlotPriority::Work), Grant::Granted);
        // Measured lighter later: it takes more, so the queue moves.
        assert!(k.board.observe_projects(&mid("big"), own(3)));
        k.freed();
        assert_eq!(k.grants, ["T3"]);
        assert!(!k.board.observe_projects(&mid("big"), own(3)));
        // No longer below the machine's cap: the machine's figure again.
        assert!(k.board.observe_projects(&mid("big"), Vec::new()));
        assert_eq!(
            k.board.max_source(&rust),
            MaxSource::Auto("memory 18 GB".to_owned())
        );
        // A person's setting for the project, or the machine, wins over the measure.
        k.board.observe_projects(&mid("big"), own(2));
        k.board.set_cap(None, Some((rust.clone(), 5)));
        assert_eq!(
            (k.board.max_agents_of(&rust), k.board.max_source(&rust)),
            (5, MaxSource::Project)
        );
    }
}
