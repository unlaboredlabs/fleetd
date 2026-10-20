//! Intake, brief freeze and status lines. A workstream's brief is frozen by hash when the lead registers it, and
//! changes only with an ask the human answered.
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::{BriefCreateResult, StatusSetResult};
use fleetd_contracts::ledger::{
    AskId, AskState, BriefDraft, BriefHash, DecisionSource, IntakeChannel, PlaybookName,
    PlaybookRef, Workstream, WorkstreamId, WorkstreamParent, WorkstreamState,
};
use fleetd_contracts::mcp::ErrorCode;

use super::brief::brief_hash;
use super::digest::{clip_utf16, state_text};
use super::error::LeadError;
use super::records::{LeadRecords, NewWorkstream, StoredWorkstream, WorkstreamFilter, is_closed};
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
    /// M9 finish-all: the workstream that spawns this one, and what it serves there.
    pub parent: Option<WorkstreamParent>,
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
    clip_utf16(line, 200)
}

fn amend_fix(id: &WorkstreamId) -> String {
    format!(
        "File `ask` with class product, key {}.brief, the change and why as text, your proposal as recommendation and workstreamId {id}; call `brief` again with amend once the human answers it.",
        id.as_str().to_lowercase()
    )
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
        Ok(self.records.workstream_get(id)?.map(|s| s.workstream))
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
    fn own(&self, caller: &ProjectRef, id: &WorkstreamId) -> Result<StoredWorkstream, LeadError> {
        let Some(stored) = self.records.workstream_get(id)? else {
            return Err(LeadError::not_found(
                format!("There is no workstream {id}."),
                "Use a workstream id from the digest at the top of your last wake.",
            ));
        };
        if !same_project(&stored.workstream.project_ref, caller) {
            return Err(LeadError::new(
                ErrorCode::Forbidden,
                format!("{id} belongs to another project."),
                "Use a workstream id from your own digest.",
            ));
        }
        Ok(stored)
    }

    /// Creates a draft workstream for the intent and wakes the lead. Idempotent per client_request_id.
    pub fn intake(&self, input: IntakeInput) -> Result<IntakeOutcome, LeadError> {
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
            parent: input.parent,
        })?;
        let id = workstream.workstream_id.clone();
        if created {
            self.event(
                &workstream,
                HubEventType::WorkstreamCreated,
                format!("New intent {id}: {}", workstream.title),
                Some(serde_json::json!({ "workstreamId": id })),
            )?;
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

    /// The amend ask must be one the human answered, for this project (and this workstream, if it names one), used once.
    fn check_amend(&self, stored: &StoredWorkstream, ask_id: &AskId) -> Result<(), LeadError> {
        let w = &stored.workstream;
        let refuse = |message: String| LeadError::invalid(message, amend_fix(&w.workstream_id));
        let ask = self.ctx.ports().ask(ask_id)?;
        let Some(ask) = ask.filter(|a| {
            a.project_ref
                .as_ref()
                .is_some_and(|r| same_project(r, &w.project_ref))
        }) else {
            return Err(refuse(format!("There is no ask {ask_id} in this project.")));
        };
        if let Some(other) = ask
            .workstream_id
            .as_ref()
            .filter(|id| **id != w.workstream_id)
        {
            return Err(refuse(format!(
                "{ask_id} is about {other}, not {}.",
                w.workstream_id
            )));
        }
        let decision = ask
            .decision_id
            .as_ref()
            .map(|id| self.ctx.ports().decision(id.as_str()))
            .transpose()?
            .flatten();
        if ask.state != AskState::Answered
            || decision.map(|d| d.source) != Some(DecisionSource::Human)
        {
            return Err(refuse(format!(
                "{ask_id} has no answer from the human yet."
            )));
        }
        if stored.amends.contains(ask_id) {
            return Err(refuse(format!(
                "{ask_id} was already used to amend {}.",
                w.workstream_id
            )));
        }
        Ok(())
    }

    /// `fleetd brief create` from the lead of `caller`.
    pub fn brief_create(
        &self,
        caller: &ProjectRef,
        workstream_id: &WorkstreamId,
        draft: BriefDraft,
        amend: Option<&AskId>,
    ) -> Result<BriefCreateResult, LeadError> {
        let stored = self.own(caller, workstream_id)?;
        let w = &stored.workstream;
        let id = &w.workstream_id;
        // M9: checked against the version pinned at intake, whatever the playbook file says now.
        let playbook = w
            .playbook
            .as_ref()
            .map(|r| self.playbooks.by_ref(r))
            .transpose()?
            .flatten()
            .map(|p| p.playbook);
        let tier = draft.tier.or(playbook.as_ref().map(|p| p.tier_default));
        let Some(tier) = tier else {
            return Err(LeadError::invalid(
                "Invalid brief: tier is missing",
                "A brief needs goal, why, pointers, constraints, at least one doneWhen check and a tier (S, M or L).",
            ));
        };
        let brief = draft.into_brief(tier);
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
        let hash = BriefHash::unchecked(brief_hash(&brief));
        let running = format!("Plan the work and report progress with `status_set` for {id}.");
        let result = |state: WorkstreamState, next: String| BriefCreateResult {
            workstream_id: id.clone(),
            brief_hash: hash.clone(),
            state,
            next: Some(next),
        };
        if w.brief_hash.as_ref() == Some(&hash) {
            return Ok(result(
                w.state,
                format!("Unchanged: this brief is already frozen. {running}"),
            ));
        }
        let at = now_iso(&self.ctx);
        let data = |state: WorkstreamState| serde_json::json!({ "workstreamId": id, "state": state, "briefHash": hash });
        if w.brief.is_none() && w.state == WorkstreamState::Idle {
            // An idle finish-all stays idle: only new work with a value source reopens it (FinishAll).
            let next = Workstream {
                brief: Some(brief),
                brief_hash: Some(hash.clone()),
                updated_at: at.into(),
                ..w.clone()
            };
            self.records.workstream_put(&StoredWorkstream {
                workstream: next.clone(),
                amends: stored.amends.clone(),
            })?;
            self.event(
                &next,
                HubEventType::WorkstreamState,
                format!("{id} brief frozen while idle"),
                Some(data(WorkstreamState::Idle)),
            )?;
            return Ok(result(
                WorkstreamState::Idle,
                format!("Brief frozen; {id} stays idle. Nothing to do until new work comes in."),
            ));
        }
        if w.brief.is_none() {
            let next = Workstream {
                brief: Some(brief),
                brief_hash: Some(hash.clone()),
                state: WorkstreamState::Running,
                updated_at: at.into(),
                ..w.clone()
            };
            self.records.workstream_put(&StoredWorkstream {
                workstream: next.clone(),
                amends: stored.amends.clone(),
            })?;
            self.event(
                &next,
                HubEventType::WorkstreamRunning,
                format!("{id} is running: {}", w.title),
                Some(serde_json::json!({ "workstreamId": id, "briefHash": hash })),
            )?;
            return Ok(result(next.state, format!("Brief frozen. {running}")));
        }
        let Some(amend) = amend else {
            return Err(LeadError::invalid(
                format!(
                    "The brief of {id} is frozen; changing it needs an ask the human answered."
                ),
                format!(
                    "File `ask` with class product, key {}.brief, the change and why as text, your proposal as recommendation and workstreamId {id}; carry on meanwhile, and call `brief` again with amend <askId> once it is answered.",
                    id.as_str().to_lowercase()
                ),
            ));
        };
        self.check_amend(&stored, amend)?;
        // A claim made against the old brief must not close the workstream on the new one (W4): the amend reopens a
        // verifying workstream and voids the claim still waiting on its checks.
        let verifying = w.state == WorkstreamState::Verifying;
        let next = Workstream {
            brief: Some(brief),
            brief_hash: Some(hash.clone()),
            state: if verifying {
                WorkstreamState::Running
            } else {
                w.state
            },
            updated_at: at.into(),
            ..w.clone()
        };
        let mut amends = stored.amends.clone();
        amends.push(amend.clone());
        // Only over the workstream as read, so a claim concluding meanwhile and this amend never overwrite each other.
        let written = self.records.workstream_put_if(
            &StoredWorkstream {
                workstream: next.clone(),
                amends,
            },
            w,
        )?;
        if !written {
            let now = self.get(id)?.map_or(w.state, |w| w.state);
            return Err(LeadError::invalid(
                format!(
                    "{id} changed while you amended it; it is {} now.",
                    state_text(now)
                ),
                if is_closed(now) {
                    "Start the change as new work instead.".to_owned()
                } else {
                    format!("Call `brief` for {id} again.")
                },
            ));
        }
        self.event(
            &next,
            HubEventType::WorkstreamState,
            format!("{id} brief amended under {amend}"),
            Some(serde_json::json!({ "workstreamId": id, "state": next.state, "briefHash": hash, "amend": amend })),
        )?;
        let voided = if verifying {
            if let Some(claims) = self.ctx.hooks.claims.get() {
                claims.void(id);
            }
            " The claim you made before no longer counts; claim again once the new done-when checks hold."
        } else {
            ""
        };
        Ok(result(
            next.state,
            format!("Brief amended under {amend}.{voided} {running}"),
        ))
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
            ..stored.workstream.clone()
        };
        let id = workstream.workstream_id.clone();
        self.records.workstream_put(&StoredWorkstream {
            workstream,
            amends: stored.amends,
        })?;
        Ok(StatusSetResult {
            workstream_id: id,
            next: Some("Status recorded. Carry on.".into()),
        })
    }
}
