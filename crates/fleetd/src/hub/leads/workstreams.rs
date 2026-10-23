//! Intake, briefs and status lines. A workstream's brief is a plain record the lead sets and edits.
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::{BriefCreateResult, CloseResult, StatusSetResult};
use fleetd_contracts::ledger::{
    Brief, IntakeChannel, PlaybookName, PlaybookRef, Workstream, WorkstreamId, WorkstreamState,
};
use fleetd_contracts::mcp::ErrorCode;

use super::digest::{clip, state_text};
use super::error::LeadError;
use super::records::{LeadRecords, NewWorkstream, WorkstreamFilter, is_closed};
use super::wakes::{LeadWakes, Trigger};
use super::{Ctx, now_iso};
use crate::hub::playbooks::Playbooks;
use crate::hub::playbooks::floor::floor_refusal;
use crate::hub::store::NewEvent;

pub struct IntakeInput {
    pub project_ref: ProjectRef,
    pub text: String,
    pub client_request_id: String,
    pub channel: IntakeChannel,
    /// An agent keyId, "human" or "lead:<machineId>/<projectId>".
    pub by: String,
    /// M9: the playbook to pin; None leaves the workstream unpinned, as before M9.
    pub template: Option<PlaybookName>,
}

#[derive(Debug, Clone)]
pub struct IntakeOutcome {
    pub workstream_id: WorkstreamId,
    pub playbook: Option<PlaybookRef>,
    pub next: String,
}

fn same_project(a: &ProjectRef, b: &ProjectRef) -> bool {
    a.machine_id == b.machine_id && a.project_id == b.project_id
}

fn title_of(text: &str) -> String {
    let line = text.trim().split('\n').next().unwrap_or("").trim();
    clip(line, 200)
}

pub struct Workstreams {
    ctx: Arc<Ctx>,
    records: Arc<LeadRecords>,
    wakes: Arc<LeadWakes>,
    playbooks: Arc<Playbooks>,
}

impl Workstreams {
    pub fn new(
        ctx: Arc<Ctx>,
        records: Arc<LeadRecords>,
        wakes: Arc<LeadWakes>,
        playbooks: Arc<Playbooks>,
    ) -> Arc<Self> {
        Arc::new(Self {
            ctx,
            records,
            wakes,
            playbooks,
        })
    }

    pub fn get(&self, id: &WorkstreamId) -> Result<Option<Workstream>, LeadError> {
        Ok(self.records.workstream_get(id)?)
    }

    /// Newest first. `open` keeps states other than done, stopped and failed.
    pub fn list(&self, filter: &WorkstreamFilter) -> Result<Vec<Workstream>, LeadError> {
        Ok(self.records.workstreams_list(filter)?)
    }

    fn event(
        &self,
        w: &Workstream,
        r#type: HubEventType,
        summary: String,
        data: Option<serde_json::Value>,
    ) -> Result<(), LeadError> {
        self.ctx.events.append(NewEvent {
            at: w.updated_at.clone(),
            r#type,
            machine_id: Some(w.project_ref.machine_id.clone()),
            project_id: Some(w.project_ref.project_id.clone()),
            thread_id: None,
            summary,
            data,
            attention: None,
        })?;
        Ok(())
    }

    /// The caller's own workstream, or a refusal that says why.
    fn own(&self, caller: &ProjectRef, id: &WorkstreamId) -> Result<Workstream, LeadError> {
        let Some(w) = self.records.workstream_get(id)? else {
            return Err(LeadError::not_found(
                format!("There is no workstream {id}."),
                "Use a workstream id from the digest at the top of your last wake.",
            ));
        };
        if !same_project(&w.project_ref, caller) {
            return Err(LeadError::new(
                ErrorCode::Forbidden,
                format!("{id} belongs to another project."),
                "Use a workstream id from your own digest.",
            ));
        }
        Ok(w)
    }

    /// Creates a draft workstream for the intent and wakes the lead. Idempotent per client_request_id.
    pub fn intake(&self, input: IntakeInput) -> Result<IntakeOutcome, LeadError> {
        self.create(input, true)
    }

    /// The lead's own `workstream_open`: the same draft, with no intent wake, since the lead that opens it knows.
    pub fn open(&self, input: IntakeInput) -> Result<IntakeOutcome, LeadError> {
        self.create(input, false)
    }

    fn create(&self, input: IntakeInput, wake: bool) -> Result<IntakeOutcome, LeadError> {
        if self.ctx.store.project_get(&input.project_ref)?.is_none() {
            return Err(LeadError::no_project(&input.project_ref));
        }
        let pinned = input.template.map(|t| self.playbooks.pin(t)).transpose()?;
        let (workstream, created) = self.records.workstream_create(NewWorkstream {
            project_ref: input.project_ref.clone(),
            title: title_of(&input.text),
            text: input.text.clone(),
            channel: input.channel,
            by: input.by,
            at: now_iso(&self.ctx).into(),
            client_request_id: Some(input.client_request_id),
            playbook: pinned.as_ref().map(|p| p.r#ref.clone()),
        })?;
        let id = workstream.workstream_id.clone();
        if created {
            self.event(
                &workstream,
                HubEventType::WorkstreamCreated,
                format!("New intent {id}: {}", workstream.title),
                Some(serde_json::json!({ "workstreamId": id })),
            )?;
        }
        if created && wake {
            self.wakes.trigger(
                &input.project_ref,
                Trigger::Intent {
                    workstream_id: id.clone(),
                    text: input.text,
                },
            );
        }
        let next = if self.records.lead_get(&input.project_ref)?.is_none() {
            format!(
                "{id} is a draft. The project has no lead yet; call lead_start and it will pick this up."
            )
        } else {
            format!("{id} is a draft; the lead registers its brief. Watch it with workstream_get.")
        };
        Ok(IntakeOutcome {
            workstream_id: id,
            playbook: workstream.playbook,
            next,
        })
    }

    /// `fleetd brief create` from the lead of `caller`: sets the brief of a draft and starts it, or edits it. Every
    /// write is an event, so the history shows each version.
    pub fn brief_create(
        &self,
        caller: &ProjectRef,
        workstream_id: &WorkstreamId,
        brief: Brief,
    ) -> Result<BriefCreateResult, LeadError> {
        let w = &self.own(caller, workstream_id)?;
        let id = &w.workstream_id;
        // M9: checked against the version pinned at intake, whatever the playbook file says now.
        let playbook = w
            .playbook
            .as_ref()
            .map(|r| self.playbooks.by_ref(r))
            .transpose()?
            .flatten()
            .map(|p| p.playbook);
        if let Some(short) = playbook.as_ref().and_then(|p| floor_refusal(p, &brief)) {
            return Err(LeadError::invalid(
                short,
                format!("Add what is missing to the brief and call `brief` for {id} again."),
            ));
        }
        if is_closed(w.state) {
            return Err(LeadError::bare(
                ErrorCode::Invalid,
                format!(
                    "{id} is {}; its brief can no longer change.",
                    state_text(w.state)
                ),
            ));
        }
        let running = format!("Plan the work and report progress with `status_set` for {id}.");
        let result = |state: WorkstreamState, next: String| BriefCreateResult {
            workstream_id: id.clone(),
            state,
            next: Some(next),
        };
        if w.brief.as_ref() == Some(&brief) {
            return Ok(result(w.state, format!("Unchanged. {running}")));
        }
        // A draft starts running.
        let starts = w.brief.is_none();
        let state = if starts {
            WorkstreamState::Running
        } else {
            w.state
        };
        let next = Workstream {
            brief: Some(brief),
            state,
            updated_at: now_iso(&self.ctx).into(),
            ..w.clone()
        };
        self.records.workstream_put(&next)?;
        if starts {
            self.event(
                &next,
                HubEventType::WorkstreamRunning,
                format!("{id} is running: {}", w.title),
                Some(serde_json::json!({ "workstreamId": id })),
            )?;
            return Ok(result(state, format!("Brief set. {running}")));
        }
        self.event(
            &next,
            HubEventType::WorkstreamState,
            format!("{id} brief edited"),
            Some(serde_json::json!({ "workstreamId": id, "state": state, "briefEdited": true })),
        )?;
        Ok(result(state, format!("Brief edited. {running}")))
    }

    /// `close` from the lead of `caller`: the workstream is done, with why. It stops nothing; what still runs keeps
    /// running, and the status shows it.
    pub fn close(
        &self,
        caller: &ProjectRef,
        workstream_id: &WorkstreamId,
        why: &str,
        by: &str,
    ) -> Result<CloseResult, LeadError> {
        let w = self.own(caller, workstream_id)?;
        let id = &w.workstream_id;
        if is_closed(w.state) {
            return Err(LeadError::invalid(
                format!("{id} is already {}.", state_text(w.state)),
                "Open a new workstream if there is more to do.",
            ));
        }
        let done = Workstream {
            state: WorkstreamState::Done,
            updated_at: now_iso(&self.ctx).into(),
            ..w.clone()
        };
        self.records.workstream_put(&done)?;
        self.event(
            &done,
            HubEventType::WorkstreamDone,
            format!("{id} is done: {why}"),
            Some(serde_json::json!({ "workstreamId": id, "reason": why, "by": by })),
        )?;
        Ok(CloseResult {
            workstream_id: id.clone(),
            state: WorkstreamState::Done,
            next: Some(
                "Closed. Nothing was stopped: stop any agent of it you no longer need with stop_agent, and tell the \
                 human in a line."
                    .into(),
            ),
        })
    }

    /// `fleetd status set`. Without a workstream it needs exactly one open workstream in the project.
    pub fn status_set(
        &self,
        caller: &ProjectRef,
        text: &str,
        workstream_id: Option<&WorkstreamId>,
    ) -> Result<StatusSetResult, LeadError> {
        let stored = match workstream_id {
            Some(id) => self.own(caller, id)?,
            None => {
                let open = self.records.workstreams_list(&WorkstreamFilter {
                    project_ref: Some(caller.clone()),
                    open: true,
                    limit: 2,
                    ..Default::default()
                })?;
                if open.len() != 1 {
                    return Err(LeadError::invalid(
                        if open.is_empty() {
                            "Your project has no open workstream."
                        } else {
                            "Your project has several open workstreams."
                        },
                        "Pass workstreamId W<n> with an id from your digest.",
                    ));
                }
                self.own(caller, &open[0].workstream_id)?
            }
        };
        let at = now_iso(&self.ctx);
        let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let headline: String = {
            // `.slice(0, 280)` in UTF-16 units, without the ellipsis.
            let mut used = 0;
            flat.chars()
                .take_while(|c| {
                    used += c.len_utf16();
                    used <= 280
                })
                .collect()
        };
        let workstream = Workstream {
            headline: Some(fleetd_contracts::ledger::Headline::unchecked(headline)),
            headline_at: Some(at.clone().into()),
            updated_at: at.into(),
            ..stored.clone()
        };
        let id = workstream.workstream_id.clone();
        self.records.workstream_put(&workstream)?;
        Ok(StatusSetResult {
            workstream_id: id,
            next: Some("Status recorded. Carry on.".into()),
        })
    }
}
