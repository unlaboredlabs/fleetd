//! Intake, briefs and status lines. A workstream's brief is a plain record the lead sets and edits.
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::{BriefCreateResult, CloseResult};
use fleetd_contracts::ledger::{Brief, IntakeChannel, Workstream, WorkstreamId, WorkstreamState};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::navi::AskHandle;

use super::digest::{clip, state_text};
use super::error::LeadError;
use super::records::{LeadRecords, NewWorkstream, WorkstreamFilter, is_closed};
use super::requested::{self, Requested, RequestedBasis};
use super::wakes::{LeadWakes, Trigger};
use super::{Ctx, now_iso};
use crate::hub::store::{NewEvent, now_ms, parse_ms};

pub struct IntakeInput {
    pub project_ref: ProjectRef,
    pub text: String,
    pub client_request_id: String,
    pub channel: IntakeChannel,
    /// An agent keyId, "human" or "lead:<machineId>/<projectId>".
    pub by: String,
}

#[derive(Debug, Clone)]
pub struct IntakeOutcome {
    pub workstream_id: WorkstreamId,
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
}

impl Workstreams {
    pub fn new(ctx: Arc<Ctx>, records: Arc<LeadRecords>, wakes: Arc<LeadWakes>) -> Arc<Self> {
        Arc::new(Self {
            ctx,
            records,
            wakes,
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
        self.create(input, true, None)
    }

    /// A `brief` without a workstream opens one: the same draft, with no intent wake, since the lead that opens it knows.
    /// `asked` is the Navi message it is opened for, said in its `workstream.created` for Navi's bridge (hub/navi).
    pub fn open(
        &self,
        input: IntakeInput,
        asked: Option<&AskHandle>,
    ) -> Result<IntakeOutcome, LeadError> {
        self.create(input, false, asked)
    }

    fn create(
        &self,
        input: IntakeInput,
        wake: bool,
        asked: Option<&AskHandle>,
    ) -> Result<IntakeOutcome, LeadError> {
        if self.ctx.store.project_get(&input.project_ref)?.is_none() {
            return Err(LeadError::no_project(&input.project_ref));
        }
        let (workstream, created) = self.records.workstream_create(NewWorkstream {
            project_ref: input.project_ref.clone(),
            title: title_of(&input.text),
            text: input.text.clone(),
            channel: input.channel,
            by: input.by,
            at: now_iso(&self.ctx).into(),
            client_request_id: Some(input.client_request_id),
        })?;
        let id = workstream.workstream_id.clone();
        if created && input.channel == IntakeChannel::Lead {
            self.stamp_requested(&workstream)?;
        }
        if created {
            self.event(
                &workstream,
                HubEventType::WorkstreamCreated,
                format!("New intent {id}: {}", workstream.title),
                Some(match asked {
                    Some(asked) => serde_json::json!({ "workstreamId": id, "asked": asked }),
                    None => serde_json::json!({ "workstreamId": id }),
                }),
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
            format!("{id} is a draft; the lead registers its brief. Watch it with order_get.")
        };
        Ok(IntakeOutcome {
            workstream_id: id,
            next,
        })
    }

    /// An order the lead opens was asked for at the earliest human message of the run that opens it, else when it
    /// opened.
    fn stamp_requested(&self, w: &Workstream) -> Result<(), LeadError> {
        let r = &w.project_ref;
        let now = now_ms(self.ctx.clock.as_ref());
        let human = match self.records.lead_get(r)? {
            Some(lead) => requested::run_human(&self.ctx.db, r, &lead.thread_id, now)?,
            None => None,
        };
        // Who started it: the writer of the message the lead was answering. Their GitHub account opens its PRs once
        // people connect their own.
        if let Some((_, Some(person))) = &human {
            let started = Workstream {
                started_by: Some(person.clone()),
                ..w.clone()
            };
            self.records.workstream_put(&started)?;
        }
        let stamp = match human.map(|(at, _)| at) {
            Some(at_ms) => Requested {
                at_ms,
                basis: RequestedBasis::Chat,
            },
            None => Requested {
                at_ms: parse_ms(w.created_at.as_str()).unwrap_or(now),
                basis: RequestedBasis::Opened,
            },
        };
        Ok(requested::set(&self.ctx.db, w, stamp)?)
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
        if is_closed(w.state) {
            return Err(LeadError::bare(
                ErrorCode::Invalid,
                format!(
                    "{id} is {}; its brief can no longer change.",
                    state_text(w.state)
                ),
            ));
        }
        let running = format!("Spawn its agents with `spawn_agent` for {id}.");
        let result = |state: WorkstreamState, next: String| BriefCreateResult {
            workstream_id: id.clone(),
            state,
            next: Some(next),
        };
        if w.brief.as_ref() == Some(&brief) {
            return Ok(result(w.state, format!("Unchanged. {running}")));
        }
        // A draft starts running: it stays open, now with a brief.
        let starts = w.brief.is_none();
        let next = Workstream {
            brief: Some(brief),
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
            return Ok(result(w.state, format!("Brief set. {running}")));
        }
        self.event(
            &next,
            HubEventType::WorkstreamState,
            format!("{id} brief edited"),
            Some(serde_json::json!({ "workstreamId": id, "state": w.state, "briefEdited": true })),
        )?;
        Ok(result(w.state, format!("Brief edited. {running}")))
    }

    /// `close` from the lead of `caller`: the workstream is done, with why, and its agents still queued, running or
    /// idle are stopped, so none goes on, or starts later, for an order that is over. The merge train's reviewers are
    /// the train's to end. Refused while any of its PRs is still in the train: done would lie, and a closed
    /// workstream's PRs can't get a reviewer.
    pub async fn close(
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
        let unlanded = self.ctx.hooks.unlanded(caller, id);
        if !unlanded.is_empty() {
            return Err(LeadError::invalid(
                format!("{id} still has PRs in the train: {}.", unlanded.join(", ")),
                "Close it once they merge. To drop one, close the PR on GitHub and the train lets it go.",
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
        let (stopped, running) = self.stop_leftovers(caller, id, why).await;
        let mut next = "Closed.".to_owned();
        if !stopped.is_empty() {
            next.push_str(&format!(
                " Stopped its agents still at it: {}.",
                stopped.join(", ")
            ));
        }
        if !running.is_empty() {
            next.push_str(&format!(
                " {} could not be stopped yet: call stop_agent on each shortly.",
                running.join(", ")
            ));
        }
        Ok(CloseResult {
            workstream_id: id.clone(),
            state: WorkstreamState::Done,
            next: Some(next),
        })
    }

    /// Cancels the closed workstream's leftover agents (`TasksHook::leftovers`): those it stopped, and those still
    /// live after (their machine didn't answer).
    async fn stop_leftovers(
        &self,
        r: &ProjectRef,
        id: &WorkstreamId,
        why: &str,
    ) -> (Vec<String>, Vec<String>) {
        let Some(tasks) = self.ctx.hooks.tasks.get() else {
            return Default::default();
        };
        let leftovers = tasks.leftovers(r, id);
        let reason = format!("Cancelled: {id} was closed ({why}).");
        for task_id in &leftovers {
            tasks.cancel(r, task_id, &reason).await;
        }
        let running = tasks.leftovers(r, id);
        let (running, stopped): (Vec<_>, Vec<_>) = leftovers
            .into_iter()
            .map(|t| t.as_str().to_owned())
            .partition(|t| running.iter().any(|r| r.as_str() == t));
        (stopped, running)
    }
}
