//! Leads, workstreams, briefs, lead wakes and digest, lead calls; with intake and playbooks, one area.
//!
//! `Area` owns every service of leads, intake and playbooks. `hub/serve` builds it with `Area::new`, sets the hooks of
//! later areas as they come up (`ctx.hooks`), registers tools and lead calls, and spawns `Area::run`.
pub mod brief;
pub mod calls;
pub mod digest;
pub mod error;
pub mod events;
pub mod hooks;
pub mod lead;
pub mod ports;
pub mod prompt;
pub mod records;
pub mod removals;
pub mod tools;
pub mod wakes;
pub mod wiring;
pub mod workstreams;

use std::path::Path;
use std::sync::{Arc, OnceLock};

pub use self::error::LeadError;
pub use self::hooks::LeadHooks;
pub use self::lead::Leads;
pub use self::ports::LeadPorts;
pub use self::records::LeadRecords;
pub use self::wakes::LeadWakes;
pub use self::workstreams::Workstreams;
use crate::clock::Clock;
use crate::hub::intake::Intake;
use crate::hub::playbooks::{FinishAll, PlaybookError, Playbooks, Research};
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

pub struct AreaOptions<'a> {
    /// The hub home: `<home>/playbooks` holds overrides.
    pub home: &'a Path,
}

#[derive(Debug, thiserror::Error)]
pub enum AreaError {
    #[error(transparent)]
    Playbook(#[from] PlaybookError),
}

pub struct Area {
    pub ctx: Arc<Ctx>,
    pub records: Arc<LeadRecords>,
    pub playbooks: Arc<Playbooks>,
    pub wakes: Arc<LeadWakes>,
    pub leads: Arc<Leads>,
    pub workstreams: Arc<Workstreams>,
    pub research: Arc<Research>,
    pub finish_all: Arc<FinishAll>,
    pub intake: Arc<Intake>,
    pub removals: Arc<removals::ProjectRemovals>,
}

impl Area {
    /// Fails when a playbook file is invalid, naming the file and the problem.
    pub fn new(ctx: Ctx, options: AreaOptions<'_>) -> Result<Arc<Self>, AreaError> {
        let ctx = Arc::new(ctx);
        let records = LeadRecords::new(Arc::clone(&ctx.db));
        let playbooks = Playbooks::new(Arc::clone(&ctx.db), Some(options.home.join("playbooks")))?;
        let wakes = LeadWakes::new(Arc::clone(&ctx), Arc::clone(&records));
        let leads = Leads::new(Arc::clone(&ctx), Arc::clone(&records), Arc::clone(&wakes));
        let workstreams = Workstreams::new(
            Arc::clone(&ctx),
            Arc::clone(&records),
            Arc::clone(&wakes),
            Arc::clone(&playbooks),
        );
        let research = Research::new(Arc::clone(&ctx), Arc::clone(&records), Arc::clone(&wakes));
        let finish_all = FinishAll::new(
            Arc::clone(&ctx),
            Arc::clone(&records),
            Arc::clone(&workstreams),
        );
        let intake = Intake::new(
            Arc::clone(&ctx),
            Arc::clone(&workstreams),
            Arc::clone(&leads),
        );
        let removals = removals::ProjectRemovals::new(Arc::clone(&ctx), Arc::clone(&records));
        Ok(Arc::new(Self {
            ctx,
            records,
            playbooks,
            wakes,
            leads,
            workstreams,
            research,
            finish_all,
            intake,
            removals,
        }))
    }

    /// The area's loops: project removals (with their catch-up), and the leads of orders that wait
    /// for their machine. They run until aborted; `hub/serve` keeps the handles.
    pub fn run(self: &Arc<Self>) -> Vec<tokio::task::JoinHandle<()>> {
        vec![
            tokio::spawn(Arc::clone(&self.removals).run()),
            tokio::spawn(Arc::clone(&self.leads).run_waiting()),
        ]
    }
}
