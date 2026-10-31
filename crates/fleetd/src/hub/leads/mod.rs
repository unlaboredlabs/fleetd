//! Leads, workstreams, briefs, lead wakes and digest, lead calls: one area.
//!
//! `Area` owns every service of leads. `hub/serve` builds it with `Area::new`, sets the hooks of
//! later areas as they come up (`ctx.hooks`), registers tools and lead calls, and spawns `Area::run`.
pub mod calls;
pub mod cut_off;
pub mod digest;
pub mod error;
pub mod events;
pub mod hooks;
pub mod lead;
pub mod ports;
pub mod prompt;
pub mod records;
pub mod removals;
pub mod requested;
pub mod tools;
pub mod wakes;
pub mod wiring;
pub mod workstreams;

#[cfg(test)]
pub(crate) mod auto_start_tests;
#[cfg(test)]
mod mcp_fresh_tests;
#[cfg(test)]
mod requested_tests;

use std::sync::{Arc, OnceLock};

pub use self::error::LeadError;
pub use self::hooks::LeadHooks;
pub use self::lead::Leads;
pub use self::ports::LeadPorts;
pub use self::records::LeadRecords;
pub use self::wakes::LeadWakes;
pub use self::workstreams::Workstreams;
use crate::clock::Clock;
use crate::hub::store::{EventLog, HubDb, HubStore, iso_ms, now_ms};

/// What every service of this area reads from the rest of the hub.
pub struct Ctx {
    pub db: Arc<HubDb>,
    pub store: Arc<HubStore>,
    pub events: Arc<EventLog>,
    pub clock: Arc<dyn Clock>,
    /// The executor, queue, node link and ledger; `Unwired` until `wiring::wire_area` sets them.
    ports: OnceLock<Arc<dyn LeadPorts>>,
    /// Set by later areas in `hub/serve`.
    pub hooks: LeadHooks,
}

impl Ctx {
    pub fn new(
        db: Arc<HubDb>,
        store: Arc<HubStore>,
        events: Arc<EventLog>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            db,
            store,
            events,
            clock,
            ports: OnceLock::new(),
            hooks: LeadHooks::default(),
        }
    }

    /// Called once by `wiring::wire_area`.
    pub fn set_ports(&self, ports: Arc<dyn LeadPorts>) {
        let _ = self.ports.set(ports);
    }

    pub fn ports(&self) -> &dyn LeadPorts {
        match self.ports.get() {
            Some(ports) => ports.as_ref(),
            None => &ports::Unwired,
        }
    }
}

/// `new Date(now).toISOString()` on the hub clock.
pub fn now_iso(ctx: &Ctx) -> String {
    iso_ms(now_ms(ctx.clock.as_ref()))
}

pub struct Area {
    pub ctx: Arc<Ctx>,
    pub records: Arc<LeadRecords>,
    pub wakes: Arc<LeadWakes>,
    pub leads: Arc<Leads>,
    pub workstreams: Arc<Workstreams>,
    pub removals: Arc<removals::ProjectRemovals>,
}

impl Area {
    pub fn new(ctx: Ctx) -> Arc<Self> {
        let ctx = Arc::new(ctx);
        let records = LeadRecords::new(Arc::clone(&ctx.db));
        let wakes = LeadWakes::new(Arc::clone(&ctx), Arc::clone(&records));
        let leads = Leads::new(Arc::clone(&ctx), Arc::clone(&records), Arc::clone(&wakes));
        let _ = wakes.leads.set(Arc::downgrade(&leads));
        let workstreams =
            Workstreams::new(Arc::clone(&ctx), Arc::clone(&records), Arc::clone(&wakes));
        let removals = removals::ProjectRemovals::new(Arc::clone(&ctx), Arc::clone(&records));
        Arc::new(Self {
            ctx,
            records,
            wakes,
            leads,
            workstreams,
            removals,
        })
    }

    /// The area's loops: project removals (with their catch-up), the leads of orders that wait for their machine,
    /// and leads whose node cut their turn off (`cut_off`). They run until aborted; `hub/serve` keeps the handles.
    pub fn run(self: &Arc<Self>) -> Vec<tokio::task::JoinHandle<()>> {
        vec![
            tokio::spawn(Arc::clone(&self.removals).run()),
            tokio::spawn(Arc::clone(&self.leads).run_waiting()),
            tokio::spawn(Arc::clone(self).run_cut_off()),
        ]
    }
}
