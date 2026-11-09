//! The line of agents waiting for one of the Mac's iOS simulators (`mac sim start`), first come first served. Only the
//! agent at its head may take one, so the next simulator that is ready is kept for it however often the others ask.
//! A waiting agent's `mac` asks again every [`ASK_EVERY`]; one not heard from for [`GONE`] (its task ended or was
//! cancelled, or its command was cut off and not run again) leaves the line, and what would have been its simulator
//! goes to the next. `mac sim end` leaves it at once.
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// How often a waiting `mac sim start` asks the Mac again.
pub const ASK_EVERY: Duration = Duration::from_secs(5);
/// A waiting agent not heard from for this long leaves the line: room for a command cut off by its tool's time limit to
/// be run again, keeping its place.
pub const GONE: Duration = Duration::from_secs(120);

/// What an agent's `mac sim start` gets now.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Turn {
    /// Its turn: it takes a simulator now, and leaves the line once it has one.
    Now,
    /// It waits at `place`: every simulator the Mac allows is in use (`full`), or agents ahead of it get theirs first.
    Wait { place: usize, full: bool },
}

/// The agents waiting, first first, each with when it last asked.
#[derive(Debug, Default)]
pub struct Queue {
    waiting: VecDeque<(String, Instant)>,
}

impl Queue {
    /// The agent's place (1 is next) as it asks at `now`: its own again while it waits, else at the back.
    pub fn ask(&mut self, agent: &str, now: Instant) -> usize {
        self.prune(now);
        if let Some(i) = self.waiting.iter().position(|(a, _)| a == agent) {
            self.waiting[i].1 = now;
            return i + 1;
        }
        self.waiting.push_back((agent.to_owned(), now));
        self.waiting.len()
    }

    /// The agent's turn as it asks at `now`, with `in_use` of the Mac's `budget` simulators held. Asking to `wait`, it
    /// joins the line (or keeps its place); otherwise it only takes its place, behind everyone waiting.
    pub fn turn(
        &mut self,
        agent: &str,
        wait: bool,
        in_use: usize,
        budget: usize,
        now: Instant,
    ) -> Turn {
        let place = if wait {
            self.ask(agent, now)
        } else {
            self.prune(now);
            self.waiting
                .iter()
                .position(|(a, _)| a == agent)
                .unwrap_or(self.waiting.len())
                + 1
        };
        if in_use >= budget {
            Turn::Wait { place, full: true }
        } else if place > 1 {
            Turn::Wait { place, full: false }
        } else {
            Turn::Now
        }
    }

    /// The agent leaves the line (it got its simulator, ran `mac sim end`, or failed); whether it was in it.
    pub fn leave(&mut self, agent: &str) -> bool {
        let before = self.waiting.len();
        self.waiting.retain(|(a, _)| a != agent);
        self.waiting.len() != before
    }

    fn prune(&mut self, now: Instant) {
        self.waiting
            .retain(|(_, asked)| now.saturating_duration_since(*asked) < GONE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Mac's side of `mac sim start` (host.rs) over a pool whose clones come ready at `ready` (seconds): each
    /// agent asks from its second, every `every` seconds, waiting, and takes a clone when its turn comes and one is
    /// warm. The agents in the order they got one.
    fn served(askers: &[(&str, u64, u64)], ready: &[u64], budget: usize) -> Vec<String> {
        let start = Instant::now();
        let (mut queue, mut warm, mut got) = (Queue::default(), 0, Vec::new());
        for t in 0..600 {
            warm += ready.iter().filter(|r| **r == t).count();
            for (agent, from, every) in askers {
                if t < *from || (t - from) % every != 0 || got.iter().any(|g| g == agent) {
                    continue;
                }
                let now = start + Duration::from_secs(t);
                if queue.turn(agent, true, got.len(), budget, now) == Turn::Now && warm > 0 {
                    warm -= 1;
                    queue.leave(agent);
                    got.push(agent.to_string());
                }
            }
        }
        got
    }

    #[test]
    fn simulators_go_to_agents_in_the_order_they_asked_however_often_each_asks() {
        // A asked first but asks only every 20 s; C, last, every second. Before the line, C took each clone.
        let askers = [("A", 0, 20), ("B", 1, 7), ("C", 2, 1)];
        assert_eq!(served(&askers, &[30, 60, 90], 3), ["A", "B", "C"]);
        // One clone warm at once and room for all: still in order.
        assert_eq!(served(&askers, &[5, 5, 5], 3), ["A", "B", "C"]);
    }

    #[test]
    fn with_every_simulator_in_use_everyone_waits_in_order() {
        let (mut queue, now) = (Queue::default(), Instant::now());
        assert_eq!(
            queue.turn("A", true, 2, 2, now),
            Turn::Wait {
                place: 1,
                full: true
            }
        );
        assert_eq!(
            queue.turn("B", true, 2, 2, now),
            Turn::Wait {
                place: 2,
                full: true
            }
        );
        // One ends: A's turn, and B is behind it.
        assert_eq!(
            queue.turn("B", true, 1, 2, now),
            Turn::Wait {
                place: 2,
                full: false
            }
        );
        assert_eq!(queue.turn("A", true, 1, 2, now), Turn::Now);
    }

    #[test]
    fn a_turn_not_taken_passes_to_the_next_agent() {
        let (mut queue, t0) = (Queue::default(), Instant::now());
        queue.ask("A", t0);
        queue.ask("B", t0);
        // A's clone is ready but A asks no more (its task ended, or its command was cut off and not run again).
        let mut t = t0;
        while t < t0 + GONE {
            assert_eq!(
                queue.turn("B", true, 0, 2, t),
                Turn::Wait {
                    place: 2,
                    full: false
                }
            );
            t += ASK_EVERY;
        }
        assert_eq!(queue.turn("B", true, 0, 2, t0 + GONE), Turn::Now);
        // Back after that, A waits behind B.
        assert_eq!(queue.ask("A", t0 + GONE), 2);
    }

    #[test]
    fn an_agent_run_again_in_time_keeps_its_place() {
        let (mut queue, t0) = (Queue::default(), Instant::now());
        queue.ask("A", t0);
        queue.ask("B", t0);
        assert_eq!(queue.ask("A", t0 + GONE - Duration::from_secs(1)), 1);
        // B wasn't: it lost its place, and joins again behind A.
        assert_eq!(queue.ask("B", t0 + GONE + Duration::from_secs(1)), 2);
    }

    #[test]
    fn an_agent_that_ends_or_is_cancelled_leaves_the_line() {
        let (mut queue, now) = (Queue::default(), Instant::now());
        for agent in ["A", "B", "C"] {
            queue.ask(agent, now);
        }
        // `mac sim end`, or a lend that failed.
        assert!(queue.leave("B"));
        assert!(!queue.leave("B"));
        assert_eq!(queue.ask("C", now), 2);
        assert!(queue.leave("A"));
        assert_eq!(queue.turn("C", true, 0, 2, now), Turn::Now);
        assert!(queue.leave("C"));
    }

    #[test]
    fn an_agent_that_doesnt_wait_never_joins_and_never_jumps_the_line() {
        let (mut queue, now) = (Queue::default(), Instant::now());
        // Nobody waiting and room: its turn, as before the line.
        assert_eq!(queue.turn("A", false, 0, 2, now), Turn::Now);
        assert_eq!(
            queue.turn("A", false, 2, 2, now),
            Turn::Wait {
                place: 1,
                full: true
            }
        );
        assert_eq!(queue.ask("B", now), 1, "A didn't join");
        assert_eq!(
            queue.turn("A", false, 0, 2, now),
            Turn::Wait {
                place: 2,
                full: false
            }
        );
        assert_eq!(queue.ask("B", now), 1);
    }
}
