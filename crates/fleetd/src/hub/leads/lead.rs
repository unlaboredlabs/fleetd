//! One lead per project: a T3 thread on the project's machine, started with the lead prompt plus the digest.
use std::sync::Arc;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::ledger::{Lead, LeadState};
use fleetd_contracts::mcp::{ErrorCode, ThreadLaunchInput};
use fleetd_contracts::model::{ProjectSummary, ThreadStatus, ThreadSummary};
use tokio::sync::Mutex;

use super::error::LeadError;
use super::prompt::{LEAD_PROMPT, LEAD_PROMPT_VERSION, render_lead_prompt};
use super::records::{LeadRecords, LeadSettings, StoredLead};
use super::wakes::LeadWakes;
use super::{Ctx, now_iso};
use crate::hub::store::{NewEvent, now_ms};

pub const DEFAULT_LEAD_MODEL: &str = "claude-opus-5-5";
pub const DEFAULT_LEAD_EFFORT: Effort = Effort::High;

#[derive(Debug, Clone, Default)]
pub struct LeadsOptions {
    /// Hub-wide default model and effort; per-project settings override them.
    pub model: Option<String>,
    pub effort: Option<Effort>,
}

/// The lead's state, read off its thread as the shell stream last reported it; stopped once T3 deleted the project.
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
    options: LeadsOptions,
    /// Serializes start and restart, so two concurrent calls for one project launch one thread.
    lock: Mutex<()>,
}

impl Leads {
    pub fn new(
        ctx: Arc<Ctx>,
        records: Arc<LeadRecords>,
        wakes: Arc<LeadWakes>,
        options: LeadsOptions,
    ) -> Arc<Self> {
        Arc::new(Self {
            ctx,
            records,
            wakes,
            options,
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

    /// A fresh lead thread from the current digest; bumps `sessionGeneration`. The old thread stays in T3.
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

    /// Per-project model and effort for the next start or restart.
    pub fn configure(&self, r: &ProjectRef, settings: &LeadSettings) -> Result<(), LeadError> {
        Ok(self.records.settings_set(r, settings)?)
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
        let settings = self.records.settings_get(r)?;
        let model = settings
            .model
            .or_else(|| self.options.model.clone())
            .unwrap_or_else(|| DEFAULT_LEAD_MODEL.into());
        let effort = settings
            .effort
            .or(self.options.effort)
            .unwrap_or(DEFAULT_LEAD_EFFORT);
        let prompt = format!(
            "{}\n\n{}",
            render_lead_prompt(LEAD_PROMPT, r, &project.title),
            self.wakes.digest(r, &[]).await?
        );
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
            // T3 keeps a receipt per command id forever, so the id names this launch: a hub started on a fresh
            // database must get a new thread, not the one an earlier hub launched for the same project.
            "clientRequestId": format!("fleetd-lead:{}/{}:{session_generation}:{launched_ms}", r.machine_id, r.project_id),
        }))
        .map_err(|e| LeadError::bare(ErrorCode::Invalid, format!("The lead launch is invalid: {e}")))?;
        let thread_id = self.ctx.ports().launch(&r.machine_id, input).await?;
        let at = now_iso(&self.ctx);
        let lead = StoredLead {
            project_ref: r.clone(),
            thread_id: thread_id.clone(),
            started_at: Timestamp::from(at.clone()),
            last_wake_at: None,
            session_generation,
        };
        self.records.lead_put(&lead)?;
        self.ctx.events.append(NewEvent {
            at: at.into(),
            r#type: HubEventType::LeadStarted,
            machine_id: Some(r.machine_id.clone()),
            project_id: Some(r.project_id.clone()),
            thread_id: Some(thread_id),
            summary: format!("Lead of {} started (session {session_generation})", project.title),
            data: Some(serde_json::json!({ "sessionGeneration": session_generation, "model": model, "effort": effort, "prompt": LEAD_PROMPT_VERSION })),
            attention: None,
        })?;
        self.with_state(lead)
    }
}
