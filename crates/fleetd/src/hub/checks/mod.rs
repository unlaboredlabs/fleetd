//! The review verdicts slice.
pub mod hub_ports;
pub mod ports;
pub mod tools;

pub use hub_ports::HubPorts;

use crate::clock::Clock;
use crate::hub::reviews::verdicts::Verdicts;
use crate::hub::store::{EventLog, HubDb};
use std::sync::Arc;

/// This slice's services, built before the `Hub` that holds them; `ports` is bound to the `Hub` right after.
pub struct Built {
    pub ports: Arc<HubPorts>,
    pub verdicts: Arc<Verdicts>,
}

pub fn build(db: &Arc<HubDb>, events: &Arc<EventLog>, clock: &Arc<dyn Clock>) -> Built {
    let ports = HubPorts::new();
    let dyn_ports: Arc<dyn ports::Ports> = ports.clone();
    Built {
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
