//! Where a new intent goes: the caller's project, a leading `@<project>`, or the only project the caller may start
//! work in. Each project has one lead, so an intent that names none of those is refused rather than guessed. The
//! workstream pins a playbook only when the caller gives a template; otherwise its lead picks how to run it.
pub mod attachments;
pub mod oneshot;
pub mod prefix;
pub mod preview;

#[cfg(test)]
pub(crate) mod auto_start_tests;

use std::sync::{Arc, OnceLock};

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::ledger::{IntakeChannel, PlaybookName, PlaybookRef, WorkstreamId};
use fleetd_contracts::model::ProjectSummary;
use fleetd_contracts::playbooks::IntakeEcho;

use self::prefix::{ProjectMatch, match_project, mentioned_project, ref_of, slug_of};
use crate::hub::leads::digest::clip_utf16;
use crate::hub::leads::error::LeadError;
use crate::hub::leads::lead::{AutoStart, Leads};
use crate::hub::leads::workstreams::{IntakeInput, Workstreams};
use crate::hub::leads::{Ctx, now_iso};
use crate::hub::store::NewEvent;

pub struct SubmitInput {
    pub text: String,
    pub template: Option<PlaybookName>,
    /// The caller named the project; then `@<project>` does not decide it.
    pub project_ref: Option<ProjectRef>,
    pub client_request_id: String,
    pub channel: IntakeChannel,
    /// An agent keyId, "human" or "lead:<machineId>/<projectId>".
    pub by: String,
    /// Whether the submitter may start work on this machine.
    pub allows: Box<dyn Fn(&MachineId) -> bool + Send + Sync>,
}

#[derive(Debug, Clone)]
pub struct Placed {
    pub workstream_id: WorkstreamId,
    pub echo: IntakeEcho,
    pub next: Option<String>,
    /// Why no lead has the order yet, with the fix.
    pub lead_waiting: Option<String>,
}

fn clip(text: &str, max: usize) -> String {
    clip_utf16(&text.split_whitespace().collect::<Vec<_>>().join(" "), max)
}

/// The project an intent without a caller-given project goes to, and why: its `@<project>`, else the only project
/// the caller may start work in.
pub fn pick_project<'a>(
    text: &str,
    allowed: &'a [ProjectSummary],
) -> Result<(&'a ProjectSummary, String), LeadError> {
    let example = || {
        allowed
            .first()
            .map(|p| format!(", e.g. @{}", slug_of(&p.title)))
            .unwrap_or_default()
    };
    if let Some(name) = mentioned_project(text) {
        return match match_project(&name, allowed) {
            ProjectMatch::One(project) => Ok((project, format!("@{name} names {}", project.title))),
            ProjectMatch::None => Err(LeadError::not_found(
                format!("No project you may start work in matches @{name}."),
                format!(
                    "Use a project's title or folder name (projects_list shows them){}.",
                    example()
                ),
            )),
            ProjectMatch::Many(hits) => Err(LeadError::invalid(
                format!(
                    "@{name} matches {} projects: {}.",
                    hits.len(),
                    hits.iter()
                        .take(5)
                        .map(|p| format!("{} on {}", p.title, p.machine_id))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                "Pass machineId and projectId instead (projects_list shows them).",
            )),
        };
    }
    match allowed {
        [] => Err(LeadError::not_found(
            "There is no project you may start work in.",
            "Add the project on a connected machine (project_add), or ask the hub admin for an operate grant.",
        )),
        [only] => Ok((only, format!("{} is the only project", only.title))),
        _ => Err(LeadError::invalid(
            format!(
                "This intent names no project, and you may start work in {} projects.",
                allowed.len()
            ),
            format!(
                "Name the project: start the text with @<project>{}, or pass machineId and projectId.",
                example()
            ),
        )),
    }
}

pub struct Intake {
    ctx: Arc<Ctx>,
    workstreams: Arc<Workstreams>,
    leads: Arc<Leads>,
    time: OnceLock<crate::hub::time::TimeSink>,
}

/// The intent being placed and who submitted it.
struct Intent<'a> {
    text: &'a str,
    client_request_id: &'a str,
    channel: IntakeChannel,
    by: &'a str,
}

struct Routed {
    echo: IntakeEcho,
    workstream_id: WorkstreamId,
    playbook: Option<PlaybookRef>,
    summary: String,
    lead_waiting: Option<String>,
}

impl Intake {
    pub fn new(ctx: Arc<Ctx>, workstreams: Arc<Workstreams>, leads: Arc<Leads>) -> Arc<Self> {
        Arc::new(Self {
            time: OnceLock::new(),
            ctx,
            workstreams,
            leads,
        })
    }

    fn routed(&self, input: Routed) -> Result<(), LeadError> {
        let mut data = serde_json::Map::new();
        data.insert(
            "workstreamId".into(),
            serde_json::to_value(&input.workstream_id)?,
        );
        if let Some(t) = input.echo.template {
            data.insert("template".into(), serde_json::to_value(t)?);
        }
        data.insert("reason".into(), serde_json::to_value(&input.echo.reason)?);
        if let Some(p) = &input.playbook {
            data.insert("playbook".into(), serde_json::to_value(p)?);
        }
        if let Some(w) = &input.lead_waiting {
            data.insert("leadWaiting".into(), w.clone().into());
        }
        self.ctx.events.append(NewEvent {
            at: now_iso(&self.ctx).into(),
            r#type: HubEventType::IntakeRouted,
            machine_id: Some(input.echo.project_ref.machine_id.clone()),
            project_id: Some(input.echo.project_ref.project_id.clone()),
            thread_id: None,
            summary: input.summary,
            data: Some(serde_json::Value::Object(data)),
            attention: None,
        })?;
        Ok(())
    }

    /// Creates the workstream in the chosen project, starts the project's lead if it has none, and reports where the
    /// order went.
    async fn place(&self, intent: &Intent<'_>, echo: IntakeEcho) -> Result<Placed, LeadError> {
        let created = self.workstreams.intake(IntakeInput {
            project_ref: echo.project_ref.clone(),
            text: intent.text.into(),
            client_request_id: intent.client_request_id.into(),
            channel: intent.channel,
            by: intent.by.into(),
            template: echo.template,
            parent: None,
        })?;
        let id = &created.workstream_id;
        let (next, lead_waiting) = match self.leads.auto_start(&echo.project_ref).await {
            AutoStart::Running(_) => (created.next, None),
            AutoStart::Started(lead) => (
                format!(
                    "{id} is a draft. The project's lead (thread {}) is starting and picks it up; watch it with workstream_get.",
                    lead.thread_id
                ),
                None,
            ),
            AutoStart::Held(e) => {
                let why = match &e.fix {
                    Some(fix) => format!("{} {fix}", e.message),
                    None => e.message.clone(),
                };
                (
                    format!(
                        "{id} is a draft, waiting for its lead, which could not start: {why} fleetd starts it each time the machine comes online; lead_start starts it now."
                    ),
                    Some(why),
                )
            }
        };
        let project = self
            .ctx
            .store
            .project_get(&echo.project_ref)?
            .map_or_else(|| echo.project_ref.project_id.to_string(), |p| p.title);
        let waiting = lead_waiting
            .as_ref()
            .map(|w| format!("; waiting for its lead: {w}"))
            .unwrap_or_default();
        let template = echo
            .template
            .map(|t| format!(" ({})", t.as_str()))
            .unwrap_or_default();
        self.routed(Routed {
            summary: clip(
                &format!("{id} → {project}{template}: {}{waiting}", echo.reason),
                200,
            ),
            echo: echo.clone(),
            workstream_id: id.clone(),
            playbook: created.playbook,
            lead_waiting: lead_waiting.clone(),
        })?;
        Ok(Placed {
            workstream_id: created.workstream_id,
            echo,
            next: Some(next),
            lead_waiting,
        })
    }

    fn echo(
        project_ref: ProjectRef,
        template: Option<PlaybookName>,
        reason: String,
    ) -> Result<IntakeEcho, LeadError> {
        serde_json::from_value(serde_json::json!({ "projectRef": project_ref, "template": template, "reason": clip(&reason, 200) }))
            .map_err(|e| LeadError::bare(fleetd_contracts::mcp::ErrorCode::Invalid, format!("The intake echo is invalid: {e}")))
    }

    pub fn set_time(&self, sink: crate::hub::time::TimeSink) {
        let _ = self.time.set(sink);
    }

    /// Places an intent; the time from here to placed is the order's `intake.route` span, so its wall time starts at
    /// submit.
    pub async fn submit(&self, input: SubmitInput) -> Result<Placed, LeadError> {
        let started = crate::hub::store::now_ms(self.ctx.clock.as_ref());
        let crid = input.client_request_id.clone();
        let result = self.submit_inner(input).await;
        if let (Some(time), Ok(placed)) = (self.time.get(), &result) {
            let workstream = Some(placed.workstream_id.to_string());
            let end = crate::hub::store::now_ms(self.ctx.clock.as_ref());
            time.span(crate::hub::time::NewSpan {
                src_key: format!("intake/{crid}"),
                kind: fleetd_contracts::time::SpanKind::IntakeRoute,
                start_ms: started,
                end_ms: Some(end.max(started)),
                ids: crate::hub::time::Ids {
                    workstream_id: workstream.clone(),
                    ..Default::default()
                },
                lane: workstream.map_or_else(|| "intake".into(), |w| format!("intake:{w}")),
                ..Default::default()
            });
        }
        result
    }

    async fn submit_inner(&self, input: SubmitInput) -> Result<Placed, LeadError> {
        let template_why = input
            .template
            .map(|t| format!("; template {} given by the caller", t.as_str()))
            .unwrap_or_default();
        let intent = Intent {
            text: &input.text,
            client_request_id: &input.client_request_id,
            channel: input.channel,
            by: &input.by,
        };
        let (project_ref, why) = match &input.project_ref {
            Some(r) => (r.clone(), "project given by the caller".to_owned()),
            None => {
                let allowed: Vec<ProjectSummary> = self
                    .ctx
                    .store
                    .projects_list(None, None)?
                    .into_iter()
                    .filter(|p| (input.allows)(&p.machine_id))
                    .collect();
                let (project, why) = pick_project(&input.text, &allowed)?;
                (ref_of(project), why)
            }
        };
        let echo = Self::echo(project_ref, input.template, format!("{why}{template_why}"))?;
        self.place(&intent, echo).await
    }
}
