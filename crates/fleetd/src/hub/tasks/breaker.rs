//! The machine breaker: when agents on one machine keep dying (claude exited or was killed, or stalled), fleetd
//! stops resuming them there, so a machine that kills every agent (out of memory, a broken toolchain) can't turn the
//! automatic resume into a loop. Its dead agents wait, queued; its leads are told once. It closes on its own after a
//! quiet spell with no death there, or as soon as an agent there completes, and the waiting agents resume.
//!
//! A node going away never counts: that is not the agents' doing. Pure: `mod.rs` feeds it deaths and carries out
//! what it says. Rebuilt at start from the last `machine.recovery_paused` of each machine.
use std::collections::{BTreeSet, HashMap};

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::tasks::TaskId;

/// This many different agents dying on one machine within `WINDOW_MS` opens its breaker.
pub const DEATHS: usize = 3;
pub const WINDOW_MS: i64 = 10 * 60_000;
/// It closes once no agent died there for this long.
pub const QUIET_MS: i64 = 30 * 60_000;

#[derive(Debug, Default)]
struct Machine {
    /// Deaths that count within the window, oldest first: which task, when.
    deaths: Vec<(TaskId, i64)>,
    /// The latest of them, which the quiet spell runs from.
    last_death: Option<i64>,
    /// When it opened; `None` while closed.
    open_since: Option<i64>,
    /// The agents whose deaths opened it.
    opened_by: Vec<TaskId>,
    /// The dead agents it holds back from resuming.
    held: BTreeSet<TaskId>,
}

/// The breaker opened: the agents whose deaths opened it, and when it closes if nothing else dies.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Opened {
    pub task_ids: Vec<TaskId>,
    pub until_ms: i64,
}

/// An open breaker, for the doctor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paused {
    pub opened_by: Vec<TaskId>,
    pub until_ms: i64,
    pub held: Vec<TaskId>,
}

#[derive(Debug, Default)]
pub struct Breakers {
    machines: HashMap<MachineId, Machine>,
}

impl Breakers {
    /// A task on `machine` died in a way that counts. Opens the breaker when it is the `DEATHS`th different task to
    /// die there within `WINDOW_MS`; while it is open, each death keeps it open longer.
    pub fn death(&mut self, machine: &MachineId, task: &TaskId, now_ms: i64) -> Option<Opened> {
        let m = self.machines.entry(machine.clone()).or_default();
        m.last_death = Some(now_ms);
        if m.open_since.is_some() {
            return None;
        }
        m.deaths.push((task.clone(), now_ms));
        m.deaths.retain(|(_, at)| now_ms - at < WINDOW_MS);
        let mut tasks: Vec<TaskId> = Vec::new();
        for (t, _) in &m.deaths {
            if !tasks.contains(t) {
                tasks.push(t.clone());
            }
        }
        if tasks.len() < DEATHS {
            return None;
        }
        m.open_since = Some(now_ms);
        m.opened_by = tasks.clone();
        Some(Opened {
            task_ids: tasks,
            until_ms: now_ms + QUIET_MS,
        })
    }

    /// An open breaker as the hub last recorded it (`machine.recovery_paused`), at hub start.
    pub fn restore(&mut self, machine: &MachineId, opened: Opened, opened_ms: i64) {
        let m = self.machines.entry(machine.clone()).or_default();
        m.open_since = Some(opened_ms);
        m.opened_by = opened.task_ids;
        let until_ms = opened.until_ms;
        // The quiet spell runs from the last death, which `until` was counted from.
        m.last_death = Some(until_ms - QUIET_MS);
    }

    /// The machine's breaker while it is open.
    pub fn paused(&self, machine: &MachineId) -> Option<Paused> {
        let m = self.machines.get(machine)?;
        m.open_since?;
        Some(Paused {
            opened_by: m.opened_by.clone(),
            until_ms: m.last_death? + QUIET_MS,
            held: m.held.iter().cloned().collect(),
        })
    }

    /// Holds a dead task back from resuming while the breaker of its machine is open; false when it is closed.
    pub fn hold(&mut self, machine: &MachineId, task: &TaskId) -> bool {
        match self.machines.get_mut(machine) {
            Some(m) if m.open_since.is_some() => {
                m.held.insert(task.clone());
                true
            }
            _ => false,
        }
    }

    /// Whether the task waits on its machine's breaker.
    pub fn holds(&self, machine: &MachineId, task: &TaskId) -> bool {
        self.machines
            .get(machine)
            .is_some_and(|m| m.open_since.is_some() && m.held.contains(task))
    }

    /// The task goes on anyway: its lead continued it, or it ended.
    pub fn release(&mut self, task: &TaskId) {
        for m in self.machines.values_mut() {
            m.held.remove(task);
        }
    }

    /// Closes the machine's breaker, if open: the tasks it held, which resume now.
    pub fn close(&mut self, machine: &MachineId) -> Option<Vec<TaskId>> {
        let m = self.machines.get_mut(machine)?;
        m.open_since.take()?;
        m.deaths.clear();
        m.last_death = None;
        m.opened_by.clear();
        Some(std::mem::take(&mut m.held).into_iter().collect())
    }

    /// The open breakers whose quiet spell is over at `now_ms`.
    pub fn quiet(&self, now_ms: i64) -> Vec<MachineId> {
        let mut out: Vec<MachineId> = self
            .machines
            .iter()
            .filter(|(_, m)| {
                m.open_since.is_some() && m.last_death.is_none_or(|at| now_ms - at >= QUIET_MS)
            })
            .map(|(id, _)| id.clone())
            .collect();
        out.sort();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_792_000_000_000;
    const MIN: i64 = 60_000;

    fn m(id: &str) -> MachineId {
        MachineId::unchecked(id)
    }

    fn t(id: &str) -> TaskId {
        TaskId::unchecked(id)
    }

    /// Three different agents dying within 10 min open it; the same one dying three times doesn't, and neither do
    /// deaths spread wider than the window, or on other machines.
    #[test]
    fn three_agents_dying_on_one_machine_within_10_min_open_it() {
        let mut b = Breakers::default();
        for at in [0, MIN, 2 * MIN] {
            assert_eq!(b.death(&m("lab-a"), &t("T1"), NOW + at), None);
        }
        assert_eq!(b.death(&m("lab-b"), &t("T2"), NOW), None);
        // T1's first deaths are out of the window by now.
        assert_eq!(b.death(&m("lab-a"), &t("T3"), NOW + 10 * MIN), None);
        assert!(!b.paused(&m("lab-a")).is_some());
        let opened = b.death(&m("lab-a"), &t("T4"), NOW + 11 * MIN).unwrap();
        assert_eq!(
            opened,
            Opened {
                task_ids: vec![t("T1"), t("T3"), t("T4")],
                until_ms: NOW + 41 * MIN,
            }
        );
        assert!(b.paused(&m("lab-a")).is_some() && !b.paused(&m("lab-b")).is_some());
        // Once: a later death keeps it open longer, and opens nothing.
        assert_eq!(b.death(&m("lab-a"), &t("T5"), NOW + 20 * MIN), None);
        assert_eq!(
            b.paused(&m("lab-a")).map(|p| (p.opened_by, p.until_ms)),
            Some((vec![t("T1"), t("T3"), t("T4")], NOW + 50 * MIN))
        );
    }

    /// It holds dead agents only while open, closes after 30 quiet minutes or at once when asked, and hands back the
    /// agents it held; one its lead continued is not among them.
    #[test]
    fn it_holds_dead_agents_until_a_quiet_spell_or_a_completion_closes_it() {
        let mut b = Breakers::default();
        assert!(!b.hold(&m("lab-a"), &t("T1")));
        for (n, task) in ["T1", "T2", "T3"].iter().enumerate() {
            b.death(&m("lab-a"), &t(task), NOW + n as i64 * MIN);
        }
        for task in ["T1", "T2", "T3"] {
            assert!(b.hold(&m("lab-a"), &t(task)));
        }
        b.release(&t("T2"));
        assert!(b.holds(&m("lab-a"), &t("T1")) && !b.holds(&m("lab-a"), &t("T2")));
        assert!(b.quiet(NOW + 31 * MIN).is_empty());
        assert_eq!(b.quiet(NOW + 32 * MIN), vec![m("lab-a")]);
        assert_eq!(b.close(&m("lab-a")), Some(vec![t("T1"), t("T3")]));
        assert_eq!(b.close(&m("lab-a")), None);
        assert!(!b.holds(&m("lab-a"), &t("T1")));
        // Closed, it counts afresh.
        assert_eq!(b.death(&m("lab-a"), &t("T1"), NOW + 33 * MIN), None);
    }

    /// Restored at hub start, it closes at the time it was going to.
    #[test]
    fn a_restored_breaker_closes_when_it_would_have() {
        let mut b = Breakers::default();
        let opened = Opened {
            task_ids: vec![t("T1"), t("T2"), t("T3")],
            until_ms: NOW + 30 * MIN,
        };
        b.restore(&m("lab-a"), opened, NOW);
        assert!(b.paused(&m("lab-a")).is_some());
        assert_eq!(
            b.paused(&m("lab-a"))
                .map(|p| (p.opened_by.len(), p.until_ms)),
            Some((3, NOW + 30 * MIN))
        );
        assert!(b.quiet(NOW + 29 * MIN).is_empty());
        assert_eq!(b.quiet(NOW + 30 * MIN), vec![m("lab-a")]);
    }
}
