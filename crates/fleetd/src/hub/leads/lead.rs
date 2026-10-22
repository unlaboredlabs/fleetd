//! One lead per project: a thread on the project's machine, started with the lead prompt plus the digest.
use std::sync::Arc;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::ledger::{Lead, LeadState, WorkstreamState};
use fleetd_contracts::mcp::{ErrorCode, ThreadLaunchInput};
use fleetd_contracts::model::{ProjectSummary, ThreadStatus, ThreadSummary};
use tokio::sync::Mutex;

use super::error::LeadError;
use super::prompt::render_lead_start;
use super::records::{LeadRecords, StoredLead, WorkstreamFilter};
use super::wakes::LeadWakes;
use super::{Ctx, now_iso};
use crate::hub::prompts::Audience;
use crate::hub::store::{NewEvent, WaitInput, now_ms};
use crate::hub::tasks::resolve::{ModelEffort, resolve_model_effort};

/// What a project runs on after `Leads::configure`.
#[derive(Debug)]
pub struct Configured {
    pub model: String,
    pub effort: Effort,
    /// The running lead's node took the change (it applies from the lead's next turn), or why not; none without a
    /// lead.
    pub lead: Option<Result<(), LeadError>>,
}

/// What an order for a project without a lead did about the lead.
#[derive(Debug, Clone)]
pub enum AutoStart {
    /// The project already had its lead.
    Running(Lead),
    /// The lead was just started; its first message lists the order.
    Started(Lead),
    /// `lead.autoStart: false` in the project's policy file: the order waits for lead_start.
    Off,
    /// The lead could not start now (the runner is logged out or out of range, the machine is offline, the policy
    /// file is broken): why, and the fix. The order waits; the lead starts once the machine is online again.
    Held(LeadError),
}

/// The lead's state, read off its thread as the shell stream last reported it; stopped once the project was removed.
pub fn lead_state(thread: Option<&ThreadSummary>, project_gone: bool) -> LeadState {
    if project_gone {
        return LeadState::Stopped;
    }
    match thread.map(|t| t.status) {
        None => LeadState::Starting,
        Some(ThreadStatus::Running) => LeadState::Working,
        Some(ThreadStatus::Waiting | ThreadStatus::Failed) => LeadState::Stalled,
        Some(_) => LeadState::Idle,
    }
}

pub struct Leads {
    ctx: Arc<Ctx>,
    records: Arc<LeadRecords>,
    wakes: Arc<LeadWakes>,
    /// Serializes start and restart, so two concurrent calls for one project launch one thread.
    lock: Mutex<()>,
}

impl Leads {
    pub fn new(
        ctx: Arc<Ctx>,
        records: Arc<LeadRecords>,
        wakes: Arc<LeadWakes>,
    ) -> Arc<Self> {
        Arc::new(Self {
            ctx,
            records,
            wakes,
            lock: Mutex::new(()),
        })
    }

    /// Launches the project's lead, or returns the one it already has.
    pub async fn start(&self, r: &ProjectRef) -> Result<Lead, LeadError> {
        let _guard = self.lock.lock().await;
        if let Some(existing) = self.records.lead_get(r)? {
            return self.with_state(existing);
        }
        let project = self.project_of(r)?;
        self.launch(r, &project, 0).await
    }

    /// Starts the project's lead for its waiting orders, unless its policy turns that off. The lead's first message
    /// carries the digest, which lists every draft, so the orders reach it with the start.
    pub async fn auto_start(&self, r: &ProjectRef) -> AutoStart {
        match self.get(r) {
            Ok(Some(lead)) => return AutoStart::Running(lead),
            Ok(None) => {}
            Err(e) => return AutoStart::Held(e),
        }
        if let Some(policy) = self.ctx.hooks.policy.get() {
            match policy.auto_start(r).await {
                Ok(true) => {}
                Ok(false) => return AutoStart::Off,
                Err(e) => return AutoStart::Held(e),
            }
        }
        match self.start(r).await {
            Ok(lead) => AutoStart::Started(lead),
            Err(e) => AutoStart::Held(e),
        }
    }

    /// Starts the lead of each project on `machine_id` that has orders waiting as drafts and no lead.
    pub async fn start_waiting(&self, machine_id: &MachineId) -> Result<(), LeadError> {
        for project in self.ctx.store.projects_list(Some(machine_id), None)? {
            let r = ProjectRef {
                machine_id: project.machine_id.clone(),
                project_id: project.project_id.clone(),
            };
            if self.records.lead_get(&r)?.is_some() {
                continue;
            }
            let drafts = self.records.workstreams_list(&WorkstreamFilter {
                project_ref: Some(r.clone()),
                state: Some(WorkstreamState::Draft),
                limit: 1,
                ..Default::default()
            })?;
            if drafts.is_empty() {
                continue;
            }
            match self.auto_start(&r).await {
                AutoStart::Held(e) => {
                    tracing::info!(project = %project.title, reason = %e.message, "waiting orders: lead still not started")
                }
                AutoStart::Off | AutoStart::Running(_) | AutoStart::Started(_) => {}
            }
        }
        Ok(())
    }

    /// A machine comes online once its runner is usable (a login, an update, a reconnect): then the leads its waiting
    /// orders need start. Follows the event log from the hub's start; the nodes' reconnects after a hub restart
    /// cover the orders that waited across it.
    pub async fn run_waiting(self: Arc<Self>) {
        let events = Arc::clone(&self.ctx.events);
        let mut cursor = events.head();
        loop {
            let page = match events
                .wait(WaitInput {
                    cursor: Some(cursor),
                    types: Some(vec![HubEventType::MachineOnline]),
                    machine_id: None,
                    timeout_sec: 3600,
                })
                .await
            {
                Ok(page) => page,
                Err(error) => {
                    tracing::warn!(%error, "waiting orders: event log read failed");
                    self.ctx
                        .clock
                        .sleep(std::time::Duration::from_secs(1))
                        .await;
                    continue;
                }
            };
            cursor = page.cursor;
            for machine_id in page.events.into_iter().filter_map(|e| e.machine_id) {
                if let Err(error) = self.start_waiting(&machine_id).await {
                    tracing::warn!(%error, "waiting orders: leads not started");
                }
            }
        }
    }

    /// A fresh lead thread from the current digest; bumps `sessionGeneration`. The old thread stays on the node.
    pub async fn restart(&self, r: &ProjectRef) -> Result<Lead, LeadError> {
        let _guard = self.lock.lock().await;
        let Some(existing) = self.records.lead_get(r)? else {
            return Err(LeadError::not_found(
                format!(
                    "Project {} on {} has no lead to restart.",
                    r.project_id, r.machine_id
                ),
                "Call lead_start first.",
            ));
        };
        let project = self.project_of(r)?;
        self.launch(r, &project, existing.session_generation + 1)
            .await
    }

    pub fn get(&self, r: &ProjectRef) -> Result<Option<Lead>, LeadError> {
        self.records
            .lead_get(r)?
            .map(|lead| self.with_state(lead))
            .transpose()
    }

    /// The project's saved model and effort. A project with none saved yet takes its policy file's `defaults` once,
    /// so a file committed later never outranks what the person chose.
    pub async fn settings(&self, r: &ProjectRef) -> Result<ModelEffort, LeadError> {
        if let Some(saved) = self.records.settings_get(r)? {
            return Ok(saved);
        }
        let policy = match self.ctx.hooks.policy.get() {
            Some(policy) => policy.defaults(r).await,
            None => None,
        };
        // An unreadable policy file seeds nothing: the next read tries again.
        let Some(seed) = policy else {
            return Ok(ModelEffort::default());
        };
        self.records.settings_set(r, &seed)?;
        if seed != ModelEffort::default() {
            tracing::info!(project = %r.project_id, ?seed, "model and effort seeded from the policy file's defaults");
        }
        Ok(seed)
    }

    /// Saves the fields `change` has as the project's model and effort. New agents take them at once, a running lead
    /// from its next turn; an agent already running keeps its own.
    pub async fn configure(
        &self,
        r: &ProjectRef,
        change: &ModelEffort,
    ) -> Result<Configured, LeadError> {
        // After a launch in flight, so a lead that starts now is either launched on the change or told it.
        let _guard = self.lock.lock().await;
        // Seeded first, so a field `change` leaves out keeps the policy file's value rather than the default.
        self.settings(r).await?;
        self.records.settings_set(r, change)?;
        let (model, effort) =
            resolve_model_effort(&ModelEffort::default(), &self.settings(r).await?);
        let lead = match self.records.lead_get(r)? {
            Some(lead) => {
                let thread = ThreadRef {
                    machine_id: r.machine_id.clone(),
                    thread_id: lead.thread_id,
                };
                Some(
                    self.ctx
                        .ports()
                        .configure(thread, model.clone(), effort)
                        .await,
                )
            }
            None => None,
        };
        Ok(Configured {
            model,
            effort,
            lead,
        })
    }

    fn with_state(&self, lead: StoredLead) -> Result<Lead, LeadError> {
        let thread_ref = ThreadRef {
            machine_id: lead.project_ref.machine_id.clone(),
            thread_id: lead.thread_id.clone(),
        };
        let thread = self.ctx.store.thread_get(&thread_ref)?.map(|t| t.thread);
        // M4 usage: a lead whose thread hit a limit shows it is parked and until when.
        let parked = self
            .ctx
            .hooks
            .usage
            .get()
            .and_then(|u| u.parked_of(&thread_ref));
        let gone = self.ctx.store.project_get(&lead.project_ref)?.is_none();
        Ok(Lead {
            state: lead_state(thread.as_ref(), gone),
            project_ref: lead.project_ref,
            thread_id: lead.thread_id,
            started_at: lead.started_at,
            last_wake_at: lead.last_wake_at,
            session_generation: fleetd_contracts::prim::Count::unchecked(lead.session_generation),
            parked,
        })
    }

    fn project_of(&self, r: &ProjectRef) -> Result<ProjectSummary, LeadError> {
        self.ctx
            .store
            .project_get(r)?
            .ok_or_else(|| LeadError::no_project(r))
    }

    async fn launch(
        &self,
        r: &ProjectRef,
        project: &ProjectSummary,
        session_generation: i64,
    ) -> Result<Lead, LeadError> {
        // M4 usage: no lead turn goes into a login fleetd knows is exhausted.
        if let Some(paused) = self
            .ctx
            .hooks
            .usage
            .get()
            .and_then(|u| u.gate(&r.machine_id))
        {
            return Err(LeadError::new(
                ErrorCode::Invalid,
                format!("The lead was not started: {paused}."),
                "Wait for the reset, or run usage_resume once the login has capacity again.",
            ));
        }
        let (model, effort) = resolve_model_effort(&ModelEffort::default(), &self.settings(r).await?);
        // Taken before the digest is read: every intent made before it is in the first message (`LeadWakes::flush`).
        let at = now_iso(&self.ctx);
        let set = self.ctx.db.prompts().current(Some(r));
        let areas = match self.ctx.hooks.policy.get() {
            Some(policy) => policy.areas(r).await,
            None => None,
        };
        let prompt =
            render_lead_start(&set, r, &project.title, areas, &self.wakes.digest(r).await?);
        let launched_ms = now_ms(self.ctx.clock.as_ref());
        let title: String = format!("fleetd lead: {}", project.title)
            .chars()
            .take(80)
            .collect();
        let input: ThreadLaunchInput = serde_json::from_value(serde_json::json!({
            "machineId": r.machine_id,
            "projectId": r.project_id,
            "prompt": prompt,
            "model": model,
            "effort": effort,
            "runtimeMode": "full-access",
            "title": title,
            // The node's launch is idempotent on the id, so the id names this launch: a hub started on a fresh
            // database must get a new thread, not the one an earlier hub launched for the same project.
            "clientRequestId": format!("fleetd-lead:{}/{}:{session_generation}:{launched_ms}", r.machine_id, r.project_id),
        }))
        .map_err(|e| LeadError::bare(ErrorCode::Invalid, format!("The lead launch is invalid: {e}")))?;
        let thread_id = self.ctx.ports().launch(&r.machine_id, input).await?;
        let at: Timestamp = at.into();
        // Every later message to this thread renders from the texts it starts with.
        let text_sha = self
            .ctx
            .db
            .prompts()
            .pin(&set, Audience::Lead, r, &thread_id, &at, &prompt)
            .unwrap_or_else(|error| {
                // The lead runs either way; its wakes then follow the current texts.
                tracing::warn!(%error, "lead prompts not pinned");
                String::new()
            });
        let lead = StoredLead {
            project_ref: r.clone(),
            thread_id: thread_id.clone(),
            started_at: at.clone(),
            last_wake_at: None,
            session_generation,
        };
        self.records.lead_put(&lead)?;
        self.ctx.events.append(NewEvent {
            at,
            r#type: HubEventType::LeadStarted,
            machine_id: Some(r.machine_id.clone()),
            project_id: Some(r.project_id.clone()),
            thread_id: Some(thread_id),
            summary: format!("Lead of {} started (session {session_generation})", project.title),
            data: Some(serde_json::json!({ "sessionGeneration": session_generation, "model": model, "effort": effort, "promptRef": set.get("lead.start").r#ref, "textSha": text_sha })),
            attention: None,
        })?;
        self.with_state(lead)
    }
}
