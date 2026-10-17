//! Leads, workstreams, briefs, lead wakes and digest, lead calls; with intake and playbooks, one area.
//! TS spec: apps/hub/src/leads/**.
//!
//! `Area` owns every service of leads, intake and playbooks. `hub/serve` builds it with `Area::new`, sets the hooks of
//! later areas as they come up (`ctx.hooks`), registers tools and lead calls, and spawns `Area::run`.
pub mod brief;
pub mod calls;
pub mod digest;
pub mod error;
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

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use fleetd_contracts::ids::ProjectRef;

pub use self::error::LeadError;
pub use self::hooks::LeadHooks;
pub use self::lead::{Leads, LeadsOptions};
pub use self::ports::{Answer, LeadPorts};
pub use self::records::LeadRecords;
pub use self::wakes::{LeadWakes, Trigger};
pub use self::workstreams::Workstreams;
use crate::clock::Clock;
use crate::hub::intake::Intake;
use crate::hub::intake::router::{IntakeRouter, OneShot};
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
    /// The hub home: `<home>/playbooks` holds overrides, `<home>/claude-router` is the router's empty cwd.
    pub home: &'a Path,
    pub leads: LeadsOptions,
    /// `--router-model`; also the retro's model.
    pub router_model: Option<String>,
    /// Where the router's login variables and PATH come from: the hub's own environment.
    pub env: HashMap<String, String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AreaError {
    #[error(transparent)]
    Playbook(#[from] PlaybookError),
    #[error("cannot create the router's directory: {0}")]
    Io(#[from] std::io::Error),
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
    /// The `claude -p` runner the router uses; the retro shares it.
    pub one_shot: Arc<OneShot>,
    pub intake: Arc<Intake>,
    pub removals: Arc<removals::ProjectRemovals>,
}

impl Area {
    /// Fails when a playbook file is invalid, naming the file and the problem.
    pub fn new(ctx: Ctx, options: AreaOptions<'_>) -> Result<Arc<Self>, AreaError> {
        let ctx = Arc::new(ctx);
        let records = LeadRecords::new(Arc::clone(&ctx.db));
        let playbooks = Playbooks::new(Arc::clone(&ctx.db), Some(options.home.join("playbooks")))?;
        let wakes = LeadWakes::new(
            Arc::clone(&ctx),
            Arc::clone(&records),
            Arc::clone(&playbooks),
        );
        let leads = Leads::new(
            Arc::clone(&ctx),
            Arc::clone(&records),
            Arc::clone(&wakes),
            options.leads,
        );
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
        let one_shot = Arc::new(OneShot::new(
            options.home,
            options.router_model,
            &options.env,
            None,
        )?);
        let intake = Intake::new(
            Arc::clone(&ctx),
            Arc::clone(&workstreams),
            IntakeRouter::new(Arc::clone(&one_shot)),
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
            one_shot,
            intake,
            removals,
        }))
    }

    /// The ledger's AnswerSink: each applied answer wakes its project's lead.
    pub fn on_answered(&self, project_ref: &ProjectRef, answers: &[Answer]) {
        self.wakes.on_answered(project_ref, answers);
    }

    /// The area's loops: decision wakes, project removals (with their catch-up), and routing answers. They run until
    /// aborted; `hub/serve` keeps the handles.
    pub fn run(self: &Arc<Self>) -> Vec<tokio::task::JoinHandle<()>> {
        vec![
            tokio::spawn(Arc::clone(&self.wakes).run_decision_wakes()),
            tokio::spawn(Arc::clone(&self.removals).run()),
            tokio::spawn(Arc::clone(&self.intake).run_answers()),
        ]
    }
}
