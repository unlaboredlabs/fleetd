//! Checks runner and claims: `fleetd claim done` runs a workstream's frozen done-when checks, and only all of them
//! passing makes it done.
//!
//! The hub holds `GitHub` (the `gh` CLI), `JudgeVerdicts` (completed by review verdicts), `CheckRunner` (also approvals'
//! `verify`) and `Claims`. `cmd` checks run through the link area's `NodeCommands`.
pub mod claims;
pub mod github;
pub mod hub_ports;
pub mod judges;
pub mod ports;
pub mod records;
pub mod render;
pub mod runner;
pub mod tools;

#[cfg(test)]
mod tests;

pub use claims::{ClaimDoneOutcome, Claims, INLINE_WAIT};
pub use github::{GH_AUTH_FIX, GhCli, GhError, GhErrorKind, GhRunner, GitHub};
pub use hub_ports::HubPorts;
pub use judges::{JUDGE_BY, JudgeVerdicts, Judges};
pub use records::{ClaimFilter, ClaimRecords};
pub use runner::{CLAIMS_BY, CheckRunner, CheckScope};

use crate::clock::Clock;
use crate::hub::receipts::Receipts;
use crate::hub::reviews::verdicts::Verdicts;
use crate::hub::store::{EventLog, HubDb};
use std::sync::Arc;

/// This slice's services, built before the `Hub` that holds them; `ports` is bound to the `Hub` right after.
pub struct Built {
    pub ports: Arc<HubPorts>,
    pub receipts: Arc<Receipts>,
    pub verdicts: Arc<Verdicts>,
    pub checks: Arc<CheckRunner>,
    pub claims: Arc<Claims>,
}

pub fn build(db: &Arc<HubDb>, events: &Arc<EventLog>, clock: &Arc<dyn Clock>) -> Built {
    let ports = HubPorts::new();
    let dyn_ports: Arc<dyn ports::Ports> = ports.clone();
    let receipts = Arc::new(Receipts::new(dyn_ports.clone()));
    let gh: Arc<dyn GhRunner> = Arc::new(GhCli);
    let judge_verdicts = Arc::new(JudgeVerdicts::default());
    let verdicts = Arc::new(Verdicts::new(
        db.clone(),
        events.clone(),
        dyn_ports.clone(),
        judge_verdicts.clone(),
        clock.clone(),
    ));
    let judges = Arc::new(Judges::new(
        dyn_ports.clone(),
        events.clone(),
        judge_verdicts,
    ));
    let checks = Arc::new(CheckRunner::new(
        Arc::new(GitHub::new(gh)),
        judges,
        dyn_ports.clone(),
        clock.clone(),
    ));
    let claims = Arc::new(Claims::new(
        Arc::new(ClaimRecords::new(db.clone())),
        checks.clone(),
        dyn_ports,
        events.clone(),
        clock.clone(),
        INLINE_WAIT,
    ));
    Built {
        ports,
        receipts,
        verdicts,
        checks,
        claims,
    }
}

/// Now on `clock`, as the contracts' ISO timestamp.
pub(crate) fn now_ts(clock: &dyn crate::clock::Clock) -> fleetd_contracts::ids::Timestamp {
    fleetd_contracts::ids::Timestamp(crate::hub::store::iso_ms(crate::hub::store::now_ms(clock)))
}

/// Length in UTF-16 code units, as JS counts `length`.
pub(crate) fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The longest prefix of at most `max` UTF-16 units that ends on a char boundary (JS `slice(0, max)`, minus a split
/// surrogate pair).
pub(crate) fn utf16_prefix(s: &str, max: usize) -> &str {
    let mut count = 0;
    for (i, c) in s.char_indices() {
        count += c.len_utf16();
        if count > max {
            return &s[..i];
        }
    }
    s
}

/// The longest suffix of at most `max` UTF-16 units (JS `slice(length - max)`).
pub(crate) fn utf16_suffix(s: &str, max: usize) -> &str {
    let mut count = 0;
    for (i, c) in s.char_indices().rev() {
        count += c.len_utf16();
        if count > max {
            return &s[i + c.len_utf8()..];
        }
    }
    s
}
