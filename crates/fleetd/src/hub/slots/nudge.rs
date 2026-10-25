//! The nudge: one attention item ("raise it?") when a cap a person set holds queued agents back for [`HOLD_MS`]
//! while the machines behind it have room on their own measure. This is how a project's max agents left at 1 gets
//! noticed. Raised once per value of the cap, so it never repeats while nothing changes; cleared once the cap changes
//! or nothing waits behind it any more. Without I/O.
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::tasks::CapScope;

use super::board::{Board, Hold, Scope};

/// How long a set cap must hold agents back before the item is raised: a lead spawning a few at once past its max
/// is no reason to interrupt anyone.
pub const HOLD_MS: i64 = 10 * 60 * 1000;

/// What the item tells a person to run: `auto` unsets the cap, so each machine runs what it fits. The one place
/// the commands are spelled.
pub fn fix(scope: &Scope) -> String {
    match scope {
        Scope::Project(r) => format!(
            "fleetd project set {}/{} --max-agents auto",
            r.machine_id, r.project_id
        ),
        Scope::Machine(m) => format!("fleetd machine set {m} --max-agents auto"),
        Scope::Fleet => "fleetd project set --fleet-cap auto".to_owned(),
    }
}

fn agents(n: i64) -> String {
    format!("{n} {}", if n == 1 { "agent" } else { "agents" })
}

/// The cap as a person reads it: "Max agents 1 on lab-a/p1", "Machine cap 2 on builder-1", "Fleet cap 40".
fn cap_text(scope: &Scope, cap: i64, name: &str) -> String {
    match scope {
        Scope::Project(r) => format!("Max agents {cap} on {}/{}", r.machine_id, r.project_id),
        Scope::Machine(_) => format!("Machine cap {cap} on {name}"),
        Scope::Fleet => format!("Fleet cap {cap}"),
    }
}

/// "Max agents 1 on lab-a/p1 is holding 3 agents back; builder-1 has room for 9 more. Raise it: …".
pub fn held_line(h: &Hold) -> String {
    let room = match h.scope {
        Scope::Fleet => format!("the machines have room for {} more", h.room),
        _ => format!("{} has room for {} more", h.name, h.room),
    };
    format!(
        "{} is holding {} back; {room}. Raise it: {}",
        cap_text(&h.scope, h.cap, &h.name),
        agents(h.queued),
        fix(&h.scope)
    )
}

/// The line that clears it.
pub fn cleared_line(scope: &Scope, cap: i64, name: &str, why: &Cleared) -> String {
    let was = cap_text(scope, cap, name);
    match why {
        Cleared::Changed(Some(to)) => format!("{was} is now {to}; it no longer holds agents back"),
        Cleared::Changed(None) => format!("{was} is unset; it no longer holds agents back"),
        Cleared::Empty => format!("{was} no longer holds agents back: none are queued"),
    }
}

pub fn cap_scope(scope: &Scope) -> CapScope {
    match scope {
        Scope::Fleet => CapScope::Fleet,
        Scope::Machine(_) => CapScope::Machine,
        Scope::Project(_) => CapScope::Project,
    }
}

/// The machine a scope is on, if any.
pub fn machine_of(scope: &Scope) -> Option<&MachineId> {
    match scope {
        Scope::Fleet => None,
        Scope::Machine(m) => Some(m),
        Scope::Project(r) => Some(&r.machine_id),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cleared {
    /// A person changed the cap: to this, or unset it.
    Changed(Option<i64>),
    /// Nothing waits behind it any more.
    Empty,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Raise(Hold),
    Clear {
        scope: Scope,
        cap: i64,
        name: String,
        why: Cleared,
    },
}

struct Watch {
    scope: Scope,
    cap: i64,
    /// When the hold began.
    since: i64,
    raised: bool,
}

#[derive(Default)]
pub struct Nudge {
    watches: Vec<Watch>,
}

impl Nudge {
    /// With the items a previous hub raised and never cleared, so a restart doesn't raise them again.
    pub fn new(raised: Vec<(Scope, i64)>) -> Self {
        let watches = raised
            .into_iter()
            .map(|(scope, cap)| Watch {
                scope,
                cap,
                since: 0,
                raised: true,
            })
            .collect();
        Self { watches }
    }

    /// After every change to the board and at each sweep: the items to raise and to clear now.
    pub fn update(&mut self, board: &Board, now_ms: i64) -> Vec<Change> {
        let holds = board.holds();
        let mut changes = Vec::new();
        self.watches.retain(|w| {
            if !w.raised {
                // Not raised yet: the same cap must hold them back the whole time.
                return holds.iter().any(|h| h.scope == w.scope && h.cap == w.cap);
            }
            let cap = board.set_cap_at(&w.scope);
            let why = if cap != Some(w.cap) {
                Cleared::Changed(cap)
            } else if board.queued_at(&w.scope) == 0 {
                Cleared::Empty
            } else {
                // Kept while the cap stands and agents wait, even if the room comes and goes: no repeats.
                return true;
            };
            changes.push(Change::Clear {
                scope: w.scope.clone(),
                cap: w.cap,
                name: machine_of(&w.scope).map_or_else(String::new, |m| board.name_of(m)),
                why,
            });
            false
        });
        for h in holds {
            match self.watches.iter_mut().find(|w| w.scope == h.scope) {
                // Its cap is the one it was raised for, or it was cleared above.
                Some(w) if w.raised => {}
                Some(w) => {
                    if now_ms - w.since >= HOLD_MS {
                        w.raised = true;
                        changes.push(Change::Raise(h));
                    }
                }
                None => self.watches.push(Watch {
                    scope: h.scope,
                    cap: h.cap,
                    since: now_ms,
                    raised: false,
                }),
            }
        }
        changes
    }
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::ids::{ProjectId, ProjectRef};

    use super::super::CapInput;
    use super::super::board::{Machine, SlotPriority};
    use super::super::sizing::Auto;
    use super::*;

    fn project(p: &str) -> ProjectRef {
        ProjectRef {
            machine_id: MachineId::unchecked("lab-a"),
            project_id: ProjectId::unchecked(p),
        }
    }

    fn board(fits: i64) -> Board {
        let machine = Machine {
            machine_id: MachineId::unchecked("lab-a"),
            name: "builder-1".to_owned(),
            auto: Auto {
                cap: fits,
                why: "memory 32 GB".to_owned(),
            },
            max_agents: None,
            disk_room: None,
        };
        Board::new(None, vec![], vec![machine], vec![])
    }

    fn max_agents(b: &mut Board, p: &str, n: i64) {
        b.set_cap(CapInput {
            max_agents: Some((project(p), Some(n))),
            ..CapInput::default()
        });
        b.evaluate();
    }

    fn fleet_cap(b: &mut Board, n: i64) {
        b.set_cap(CapInput {
            cap: Some(Some(n)),
            ..CapInput::default()
        });
        b.evaluate();
    }

    fn spawn(b: &mut Board, holder: &str, p: &str) {
        b.acquire(holder, &project(p), SlotPriority::Work);
    }

    fn raised(changes: &[Change]) -> Vec<String> {
        changes
            .iter()
            .filter_map(|c| match c {
                Change::Raise(h) => Some(held_line(h)),
                Change::Clear { .. } => None,
            })
            .collect()
    }

    #[test]
    fn a_set_max_agents_holding_agents_behind_room_is_raised_once_after_the_hold() {
        let mut b = board(10);
        max_agents(&mut b, "p1", 1);
        for t in ["T1", "T2", "T3", "T4"] {
            spawn(&mut b, t, "p1");
        }
        let mut n = Nudge::default();
        assert_eq!(n.update(&b, 0), []);
        assert_eq!(n.update(&b, HOLD_MS - 1), []);
        assert_eq!(
            raised(&n.update(&b, HOLD_MS)),
            [
                "Max agents 1 on lab-a/p1 is holding 3 agents back; builder-1 has room for 9 more. \
              Raise it: fleetd project set lab-a/p1 --max-agents auto"
            ]
        );
        // Nothing changed: no repeat, however long it holds.
        assert_eq!(n.update(&b, 10 * HOLD_MS), []);
        // Another agent queues behind the same cap: still the same item.
        spawn(&mut b, "T5", "p1");
        assert_eq!(n.update(&b, 11 * HOLD_MS), []);
    }

    #[test]
    fn raising_the_cap_clears_it() {
        let mut b = board(10);
        max_agents(&mut b, "p1", 1);
        spawn(&mut b, "T1", "p1");
        spawn(&mut b, "T2", "p1");
        let mut n = Nudge::default();
        n.update(&b, 0);
        assert_eq!(raised(&n.update(&b, HOLD_MS)).len(), 1);
        max_agents(&mut b, "p1", 4);
        let changes = n.update(&b, HOLD_MS + 1);
        let [
            Change::Clear {
                scope,
                cap,
                name,
                why,
            },
        ] = &changes[..]
        else {
            panic!("{changes:?}");
        };
        assert_eq!((cap, why), (&1, &Cleared::Changed(Some(4))));
        assert_eq!(
            cleared_line(scope, *cap, name, why),
            "Max agents 1 on lab-a/p1 is now 4; it no longer holds agents back"
        );
        assert_eq!(n.update(&b, 3 * HOLD_MS), []);
    }

    #[test]
    fn the_queue_emptying_clears_it() {
        let mut b = board(10);
        max_agents(&mut b, "p1", 1);
        spawn(&mut b, "T1", "p1");
        spawn(&mut b, "T2", "p1");
        let mut n = Nudge::default();
        n.update(&b, 0);
        assert_eq!(raised(&n.update(&b, HOLD_MS)).len(), 1);
        b.release("T2");
        let changes = n.update(&b, HOLD_MS + 1);
        assert!(
            matches!(
                &changes[..],
                [Change::Clear {
                    why: Cleared::Empty,
                    ..
                }]
            ),
            "{changes:?}"
        );
    }

    #[test]
    fn no_room_on_the_machine_means_no_item() {
        // The machine fits 2 and runs 2: max agents isn't what holds the third back.
        let mut b = board(2);
        max_agents(&mut b, "p1", 1);
        spawn(&mut b, "T1", "p1");
        spawn(&mut b, "T2", "p2");
        spawn(&mut b, "T3", "p1");
        assert_eq!(b.holds(), []);
        let mut n = Nudge::default();
        n.update(&b, 0);
        assert_eq!(n.update(&b, 2 * HOLD_MS), []);
    }

    #[test]
    fn a_hold_that_lets_go_starts_its_wait_again() {
        let mut b = board(10);
        max_agents(&mut b, "p1", 1);
        spawn(&mut b, "T1", "p1");
        spawn(&mut b, "T2", "p1");
        let mut n = Nudge::default();
        n.update(&b, 0);
        b.release("T2");
        b.evaluate();
        assert_eq!(n.update(&b, HOLD_MS / 2), []);
        spawn(&mut b, "T3", "p1");
        assert_eq!(n.update(&b, HOLD_MS), []);
        assert_eq!(n.update(&b, 2 * HOLD_MS - 1), []);
        assert_eq!(raised(&n.update(&b, 2 * HOLD_MS)).len(), 1);
    }

    #[test]
    fn a_fleet_cap_holding_agents_back_names_the_machines_room() {
        let mut b = board(10);
        fleet_cap(&mut b, 2);
        for (t, p) in [("T1", "p1"), ("T2", "p2"), ("T3", "p1"), ("T4", "p2")] {
            spawn(&mut b, t, p);
        }
        let mut n = Nudge::default();
        n.update(&b, 0);
        assert_eq!(
            raised(&n.update(&b, HOLD_MS)),
            [
                "Fleet cap 2 is holding 2 agents back; the machines have room for 8 more. \
              Raise it: fleetd project set --fleet-cap auto"
            ]
        );
    }

    /// The board stops them at the fleet cap before their max agents: raising the max would start none.
    #[test]
    fn when_the_fleet_cap_and_a_projects_max_both_hold_it_names_the_fleet_cap() {
        let mut b = board(10);
        fleet_cap(&mut b, 2);
        max_agents(&mut b, "p1", 1);
        spawn(&mut b, "T1", "p1");
        spawn(&mut b, "T2", "p2");
        spawn(&mut b, "T3", "p1");
        let holds = b.holds();
        assert_eq!(
            holds
                .iter()
                .map(|h| (&h.scope, h.cap, h.queued))
                .collect::<Vec<_>>(),
            [(&Scope::Fleet, 2, 1)]
        );
    }

    #[test]
    fn a_restarted_hub_keeps_what_it_raised() {
        let mut b = board(10);
        max_agents(&mut b, "p1", 1);
        spawn(&mut b, "T1", "p1");
        spawn(&mut b, "T2", "p1");
        let mut n = Nudge::new(vec![(Scope::Project(project("p1")), 1)]);
        assert_eq!(n.update(&b, 0), []);
        assert_eq!(n.update(&b, 5 * HOLD_MS), []);
    }
}
