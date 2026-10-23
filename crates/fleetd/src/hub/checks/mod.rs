//! The receipts and review verdicts slice, with the hub's `gh` client (`GitHub`), which the train, reviews and doctor
//! use.
pub mod github;
pub mod hub_ports;
pub mod ports;
pub mod tools;

pub use github::{GH_AUTH_FIX, GhCli, GhError, GhErrorKind, GhRunner, GitHub};
pub use hub_ports::HubPorts;

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
}

pub fn build(db: &Arc<HubDb>, events: &Arc<EventLog>, clock: &Arc<dyn Clock>) -> Built {
    let ports = HubPorts::new();
    let dyn_ports: Arc<dyn ports::Ports> = ports.clone();
    Built {
        receipts: Arc::new(Receipts::new(dyn_ports.clone())),
        verdicts: Arc::new(Verdicts::new(
            db.clone(),
            events.clone(),
            dyn_ports,
            clock.clone(),
        )),
        ports,
    }
}

/// Now on `clock`, as the contracts' ISO timestamp.
pub(crate) fn now_ts(clock: &dyn crate::clock::Clock) -> fleetd_contracts::ids::Timestamp {
    fleetd_contracts::ids::Timestamp(crate::hub::store::iso_ms(crate::hub::store::now_ms(clock)))
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
