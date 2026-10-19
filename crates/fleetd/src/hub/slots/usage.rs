//! Slot time held per minute over the last hour, for the status view's utilization. The board feeds it every
//! change of `used` or the cap, so it measures what the board held, not what ran; it lives in memory and starts
//! over with the hub, which the window's length says.
use std::collections::VecDeque;

const MINUTE: i64 = 60_000;
pub const WINDOW_MS: i64 = 60 * MINUTE;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Bucket {
    minute: i64,
    /// Slot-ms held.
    held: i64,
    /// Slot-ms the cap offered.
    offered: i64,
    peak: i64,
}

/// What [`Usage::read`] measured.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Utilization {
    pub window_ms: i64,
    pub pct: i64,
    pub peak: i64,
}

#[derive(Clone, Debug)]
pub struct Usage {
    started_ms: i64,
    last_ms: i64,
    used: i64,
    cap: i64,
    buckets: VecDeque<Bucket>,
}

impl Usage {
    pub fn new(now: i64, used: i64, cap: i64) -> Self {
        let mut u = Self {
            started_ms: now,
            last_ms: now,
            used,
            cap,
            buckets: VecDeque::new(),
        };
        u.bucket(now).peak = used;
        u
    }

    fn bucket(&mut self, at: i64) -> &mut Bucket {
        let minute = at.div_euclid(MINUTE);
        if self.buckets.back().is_none_or(|b| b.minute < minute) {
            let carried = self.used;
            self.buckets.push_back(Bucket {
                minute,
                peak: carried,
                ..Bucket::default()
            });
        }
        self.buckets.back_mut().expect("just pushed")
    }

    /// Adds the time since the last change at the old `used` and cap, split at minute boundaries.
    fn advance(&mut self, now: i64) {
        let mut t = self.last_ms;
        while t < now {
            let next = ((t.div_euclid(MINUTE) + 1) * MINUTE).min(now);
            let (used, cap) = (self.used, self.cap);
            let b = self.bucket(t);
            b.held += used * (next - t);
            b.offered += cap * (next - t);
            t = next;
        }
        self.last_ms = self.last_ms.max(now);
        let oldest = (now - WINDOW_MS).div_euclid(MINUTE);
        while self.buckets.front().is_some_and(|b| b.minute < oldest) {
            self.buckets.pop_front();
        }
    }

    /// The board's state changed at `now`.
    pub fn set(&mut self, now: i64, used: i64, cap: i64) {
        self.advance(now);
        self.used = used.max(0);
        self.cap = cap.max(0);
        let b = self.bucket(now);
        b.peak = b.peak.max(used);
    }

    /// The last hour (whole minutes, the current one so far), or since the hub started when that is later.
    pub fn read(&mut self, now: i64) -> Utilization {
        self.advance(now);
        let used = self.used;
        let b = self.bucket(now);
        b.peak = b.peak.max(used);
        let (held, offered, peak) = self.buckets.iter().fold((0, 0, 0), |(h, o, p), b| {
            (h + b.held, o + b.offered, p.max(b.peak))
        });
        let from = self
            .buckets
            .front()
            .map_or(now, |b| b.minute * MINUTE)
            .max(self.started_ms);
        Utilization {
            window_ms: (now - from).max(0),
            pct: if offered > 0 {
                (held * 100 / offered).clamp(0, 100)
            } else {
                0
            },
            peak,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_held_slot_time_over_the_cap_and_the_peak() {
        let mut u = Usage::new(0, 0, 10);
        u.set(10 * MINUTE, 5, 10);
        u.set(20 * MINUTE, 1, 10);
        // 10 min at 0, 10 at 5, 10 at 1 of a cap of 10: 60 slot-min of 300.
        assert_eq!(
            u.read(30 * MINUTE),
            Utilization {
                window_ms: 30 * MINUTE,
                pct: 20,
                peak: 5
            }
        );
    }

    #[test]
    fn keeps_only_the_last_hour() {
        let mut u = Usage::new(0, 0, 4);
        u.set(MINUTE, 4, 4);
        u.set(2 * MINUTE, 0, 4);
        let later = u.read(2 * MINUTE + WINDOW_MS + MINUTE);
        assert_eq!(later.window_ms, WINDOW_MS);
        assert_eq!((later.pct, later.peak), (0, 0));
    }

    #[test]
    fn a_cap_change_counts_from_when_it_happened() {
        let mut u = Usage::new(0, 2, 2);
        u.set(30 * MINUTE, 2, 6);
        // 30 min fully used at cap 2, then 30 min 2 of 6: 120 slot-min of 240.
        assert_eq!(u.read(60 * MINUTE).pct, 50);
    }
}
