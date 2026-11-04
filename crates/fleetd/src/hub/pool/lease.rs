//! The lease: boat's own auto-stop deadline on every machine, which the hub keeps pushing ahead while it wants the
//! machine. If the hub stops renewing for any reason (a bug, a crash, a hub gone for good), boat stops the machine at
//! the deadline by itself.
//!
//! Every ttl the hub sends (create, resume, PATCH) is a [`Ttl`], and [`clamp`] is the only way to make one: at most
//! 30 minutes, and no longer than what is left under the budget at the pool's burn rate.
//! A [`Ttl`] is a plain number of seconds above 60, so boat's `null` ("never stop") can't be sent; at 60 s or less
//! there is no lease to send and the machine is stopped instead.
use serde::Serialize;

/// The lease an awake machine gets at each renewal.
pub const LEASE_S: u32 = 30 * 60;
/// A create's: its setup script and first hello take about a minute, so the same as a renewal's.
pub const SETUP_S: u32 = 30 * 60;
/// At or under this, the machine is stopped rather than leased (boat's least ttl is 1 s).
pub const STOP_AT_S: u32 = 60;

/// Seconds until boat stops the machine: always a number, 61 to 1,800.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Ttl(u32);

impl Ttl {
    pub fn seconds(self) -> u32 {
        self.0
    }

    pub fn ms(self) -> i64 {
        i64::from(self.0) * 1000
    }
}

/// What a renewal does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lease {
    Renew(Ttl),
    /// Too little left to lease: stop the machine now.
    Stop,
}

/// The one clamping function: a lease of at most `longest_s` (itself never above [`SETUP_S`]), cut to the time
/// `budget_left` dollars last at `burn_per_hour` (every awake machine's price an hour, this one's included). Anything
/// not a positive number of seconds above [`STOP_AT_S`] (no budget left, a NaN, a negative) is [`Lease::Stop`].
pub fn clamp(longest_s: u32, budget_left: f64, burn_per_hour: f64) -> Lease {
    let longest = f64::from(longest_s.min(SETUP_S));
    // An unknown burn (NaN) can't be leased against.
    let by_budget = if burn_per_hour.is_nan() {
        0.0
    } else if burn_per_hour > 0.0 {
        budget_left / burn_per_hour * 3600.0
    } else if budget_left > 0.0 {
        longest
    } else {
        0.0
    };
    // Not `f64::min`, which takes the other side of a NaN: a NaN budget leases nothing.
    let seconds = if by_budget < longest {
        by_budget
    } else if by_budget >= longest {
        longest
    } else {
        0.0
    };
    if seconds > f64::from(STOP_AT_S) {
        Lease::Renew(Ttl(seconds.floor() as u32))
    } else {
        Lease::Stop
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::pool::boat::{CreateBody, ResumeBody, TtlBody};

    fn inputs() -> Vec<(u32, f64, f64)> {
        let longest = [0, 1, 60, 61, LEASE_S, SETUP_S, u32::MAX];
        let left = [
            f64::NAN,
            f64::NEG_INFINITY,
            -3.0,
            0.0,
            0.0001,
            0.0012,
            0.05,
            3.0,
            1e9,
            f64::INFINITY,
        ];
        let burn = [
            f64::NAN,
            -1.0,
            0.0,
            0.018,
            0.072,
            0.216,
            1000.0,
            f64::INFINITY,
        ];
        let mut all = Vec::new();
        for l in longest {
            for b in left {
                for r in burn {
                    all.push((l, b, r));
                }
            }
        }
        all
    }

    /// Whatever goes in, a lease is a number of seconds in 61..=2700, and every body that carries one (PATCH, resume,
    /// create) holds it as that number: `ttlSeconds` is never null and never missing.
    #[test]
    fn the_lease_is_never_sent_as_null() {
        for (longest, left, burn) in inputs() {
            let Lease::Renew(ttl) = clamp(longest, left, burn) else {
                continue;
            };
            assert!(
                (61..=SETUP_S).contains(&ttl.seconds()),
                "{longest} {left} {burn}: {ttl:?}"
            );
            let bodies = [
                serde_json::to_value(TtlBody { ttl_seconds: ttl }).unwrap(),
                serde_json::to_value(ResumeBody {
                    ttl_seconds: ttl,
                    fail_fast: true,
                    no_env: true,
                })
                .unwrap(),
                serde_json::to_value(CreateBody::new(
                    "large",
                    "n".into(),
                    Default::default(),
                    ttl,
                ))
                .unwrap(),
            ];
            for body in bodies {
                assert_eq!(
                    body["ttlSeconds"].as_u64(),
                    Some(u64::from(ttl.seconds())),
                    "{body}"
                );
            }
        }
    }

    #[test]
    fn at_a_minute_or_less_it_stops_instead() {
        // $0.072/h for 60 s is $0.0012: exactly a minute left stops, a little more leases.
        assert_eq!(clamp(LEASE_S, 0.0012, 0.072), Lease::Stop);
        assert!(
            matches!(clamp(LEASE_S, 0.0013, 0.072), Lease::Renew(t) if (64..=65).contains(&t.seconds()))
        );
        assert_eq!(clamp(LEASE_S, 0.0, 0.072), Lease::Stop);
        assert_eq!(clamp(LEASE_S, -1.0, 0.072), Lease::Stop);
        assert_eq!(clamp(LEASE_S, f64::NAN, 0.072), Lease::Stop);
        assert_eq!(clamp(LEASE_S, 3.0, f64::NAN), Lease::Stop);
        assert_eq!(clamp(60, 3.0, 0.072), Lease::Stop);
        assert_eq!(clamp(LEASE_S, 0.0, 0.0), Lease::Stop);
    }

    #[test]
    fn it_is_the_shorter_of_thirty_minutes_and_the_budget_at_the_burn_rate() {
        // Plenty of budget: 30 minutes.
        assert_eq!(clamp(LEASE_S, 3.0, 0.216), Lease::Renew(Ttl(LEASE_S)));
        // Three large machines ($0.216/h) and 1.8 cents left: 300 s.
        assert!(
            matches!(clamp(LEASE_S, 0.018, 0.216), Lease::Renew(t) if (299..=300).contains(&t.seconds()))
        );
        // Nothing burning yet (the first wake's own price is in the burn): the longest.
        assert_eq!(clamp(LEASE_S, 1.0, 0.0), Lease::Renew(Ttl(LEASE_S)));
        // A create's setup lease, but never past it.
        assert_eq!(clamp(SETUP_S, 3.0, 0.072), Lease::Renew(Ttl(SETUP_S)));
        assert_eq!(clamp(u32::MAX, 1e9, 0.072), Lease::Renew(Ttl(SETUP_S)));
    }
}
