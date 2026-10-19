//! Where a new intent goes. The caller's project, or a leading `@<project>`, decides the project; otherwise the router
//! picks it, and when the router cannot, the intent is refused with the fix: name the project. A template prefix (`fix:`) or the
//! caller's template beats the router's; with the project known and no template given, it is `feature`. The
//! workstream pins the chosen template's playbook.
pub mod attachments;
pub mod prefix;
pub mod preview;
pub mod router;

#[cfg(test)]
pub(crate) mod auto_start_tests;

use std::sync::{Arc, OnceLock};

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::ledger::{IntakeChannel, PlaybookName, PlaybookRef, WorkstreamId};
use fleetd_contracts::model::ProjectSummary;
use fleetd_contracts::playbooks::IntakeEcho;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use self::prefix::{ProjectMatch, match_project, parse_intent, ref_of, slug_of};
use self::router::{IntakeRouter, RouterProject, RouterRun};
use crate::hub::leads::digest::clip_utf16;
use crate::hub::leads::error::LeadError;
use crate::hub::leads::lead::{AutoStart, Leads};
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::leads::workstreams::{IntakeInput, Workstreams};
use crate::hub::leads::{Ctx, now_iso};
use crate::hub::store::{NewEvent, StoreError};

/// Projects offered to the router, most recently active first.
pub const ROUTER_PROJECTS: usize = 20;
const RECENT_INTENTS: usize = 3;
const DEFAULT_TEMPLATE: PlaybookName = PlaybookName::Feature;

pub struct SubmitInput {
    pub text: String,
    pub template: Option<PlaybookName>,
    /// The caller named the project; then neither `@<project>` nor the router decides it.
    pub project_ref: Option<ProjectRef>,
    pub client_request_id: String,
    pub channel: IntakeChannel,
    /// An agent keyId, "human" or "lead:<machineId>/<projectId>".
    pub by: String,
    /// Whether the submitter may start work on this machine.
    pub allows: Box<dyn Fn(&MachineId) -> bool + Send + Sync>,
}

#[derive(Debug, Clone)]
pub enum SubmitResult {
    Placed {
        workstream_id: WorkstreamId,
        echo: IntakeEcho,
        next: Option<String>,
        /// Why no lead has the order yet, with the fix.
        lead_waiting: Option<String>,
    },
}

/// One routed intent, kept so a retry of the same request returns where it went.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Route {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    template: Option<PlaybookName>,
    channel: IntakeChannel,
    by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    workstream_id: Option<WorkstreamId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    echo: Option<IntakeEcho>,
}

fn clip(text: &str, max: usize) -> String {
    clip_utf16(&text.split_whitespace().collect::<Vec<_>>().join(" "), max)
}



pub struct Intake {
    ctx: Arc<Ctx>,
    workstreams: Arc<Workstreams>,
    leads: Arc<Leads>,
    router: Arc<IntakeRouter>,
    /// intake_preview answers by text and the caller's projects, for 10 minutes.
    previews: preview::PreviewCache,
    time: OnceLock<crate::hub::time::TimeSink>,
}

/// The intent being placed and who submitted it.
struct Intent<'a> {
    text: &'a str,
    client_request_id: &'a str,
    channel: IntakeChannel,
    by: &'a str,
}

#[derive(Default)]
struct Routed {
    echo: Option<IntakeEcho>,
    workstream_id: Option<WorkstreamId>,
    playbook: Option<PlaybookRef>,
    summary: String,
    runs: Vec<RouterRun>,
    error: Option<String>,
    lead_waiting: Option<String>,
}

impl Intake {
    pub fn new(
        ctx: Arc<Ctx>,
        workstreams: Arc<Workstreams>,
        leads: Arc<Leads>,
        router: Arc<IntakeRouter>,
    ) -> Arc<Self> {
        Arc::new(Self {
            previews: preview::PreviewCache::default(),
            time: OnceLock::new(),
            ctx,
            workstreams,
            leads,
            router,
        })
    }

    fn get_route(&self, client_request_id: &str) -> Result<Option<Route>, StoreError> {
        let row: Option<String> = self.ctx.db.with(|c| {
            Ok(c.query_row(
                "SELECT data FROM intake_routes WHERE client_request_id = ?",
                params![client_request_id],
                |r| r.get(0),
            )
            .optional()?)
        })?;
        // A route stored for an intent that waited on a routing question (before they went) has no workstream: none.
        Ok(row.and_then(|data| serde_json::from_str(&data).ok()))
    }

    fn put_route(&self, client_request_id: &str, route: &Route) -> Result<(), StoreError> {
        let data = serde_json::to_string(route)?;
        self.ctx.db.with(|c| {
            c.execute(
                "INSERT INTO intake_routes (client_request_id, data) VALUES (?, ?)
                 ON CONFLICT (client_request_id) DO UPDATE SET data = excluded.data",
                params![client_request_id, data],
            )?;
            Ok(())
        })
    }

    fn routed(&self, input: Routed) -> Result<(), LeadError> {
        let mut data = serde_json::Map::new();
        if let Some(w) = &input.workstream_id {
            data.insert("workstreamId".into(), serde_json::to_value(w)?);
        }
        if let Some(echo) = &input.echo {
            data.insert("template".into(), serde_json::to_value(echo.template)?);
            data.insert("reason".into(), serde_json::to_value(&echo.reason)?);
        }
        if let Some(p) = &input.playbook {
            data.insert("playbook".into(), serde_json::to_value(p)?);
        }
        if let Some(e) = &input.error {
            data.insert("error".into(), e.clone().into());
        }
        if let Some(w) = &input.lead_waiting {
            data.insert("leadWaiting".into(), w.clone().into());
        }
        // Each router run is orchestrator usage: what routing costs, apart from any project's work.
        if !input.runs.is_empty() {
            data.insert("usage".into(), serde_json::to_value(&input.runs)?);
        }
        self.ctx.events.append(NewEvent {
            at: now_iso(&self.ctx).into(),
            r#type: HubEventType::IntakeRouted,
            machine_id: input
                .echo
                .as_ref()
                .map(|e| e.project_ref.machine_id.clone()),
            project_id: input
                .echo
                .as_ref()
                .map(|e| e.project_ref.project_id.clone()),
            thread_id: None,
            summary: input.summary,
            data: Some(serde_json::Value::Object(data)),
            attention: None,
        })?;
        Ok(())
    }

    /// Creates the workstream in the chosen project, starts the project's lead if it has none, and reports where the
    /// order went.
    async fn place(
        &self,
        intent: &Intent<'_>,
        echo: IntakeEcho,
        runs: Vec<RouterRun>,
    ) -> Result<SubmitResult, LeadError> {
        let created = self.workstreams.intake(IntakeInput {
            project_ref: echo.project_ref.clone(),
            text: intent.text.into(),
            client_request_id: intent.client_request_id.into(),
            channel: intent.channel,
            by: intent.by.into(),
            template: Some(echo.template),
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
            AutoStart::Off => {
                let why = "the project's .fleetd/policy.yaml sets lead.autoStart: false, so its lead starts only with lead_start";
                (
                    format!("{id} is a draft, waiting for its lead: {why}."),
                    Some(why.to_string()),
                )
            }
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
        self.routed(Routed {
            summary: clip(
                &format!(
                    "{id} → {project} ({}): {}{waiting}",
                    echo.template.as_str(),
                    echo.reason
                ),
                200,
            ),
            echo: Some(echo.clone()),
            workstream_id: Some(id.clone()),
            playbook: created.playbook,
            runs,
            error: None,
            lead_waiting: lead_waiting.clone(),
        })?;
        Ok(SubmitResult::Placed {
            workstream_id: created.workstream_id,
            echo,
            next: Some(next),
            lead_waiting,
        })
    }

    fn echo(
        project_ref: ProjectRef,
        template: PlaybookName,
        reason: String,
    ) -> Result<IntakeEcho, LeadError> {
        serde_json::from_value(serde_json::json!({ "projectRef": project_ref, "template": template, "reason": clip(&reason, 200) }))
            .map_err(|e| LeadError::bare(fleetd_contracts::mcp::ErrorCode::Invalid, format!("The intake echo is invalid: {e}")))
    }

    pub fn set_time(&self, sink: crate::hub::time::TimeSink) {
        let _ = self.time.set(sink);
    }

    /// Places an intent; the time from here to placed (the router's `claude -p` included) is the order's
    /// `intake.route` span, so its wall time starts at submit.
    pub async fn submit(&self, input: SubmitInput) -> Result<SubmitResult, LeadError> {
        let started = crate::hub::store::now_ms(self.ctx.clock.as_ref());
        let crid = input.client_request_id.clone();
        let result = self.submit_inner(input).await;
        if let (Some(time), Ok(placed)) = (self.time.get(), &result) {
            let SubmitResult::Placed { workstream_id, .. } = placed;
            let workstream = Some(workstream_id.to_string());
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

    async fn submit_inner(&self, input: SubmitInput) -> Result<SubmitResult, LeadError> {
        let parsed = parse_intent(&input.text);
        let fixed = input.template.or(parsed.template);
        let template_why = match (&input.template, &parsed.prefix) {
            (Some(t), _) => format!("template {} given by the caller", t.as_str()),
            (None, Some(prefix)) => format!(
                "template {} from the {prefix} prefix",
                parsed.template.map_or("", |t| t.as_str())
            ),
            (None, None) => format!("template {} by default", DEFAULT_TEMPLATE.as_str()),
        };
        let intent = Intent {
            text: &input.text,
            client_request_id: &input.client_request_id,
            channel: input.channel,
            by: &input.by,
        };
        let place = |echo: IntakeEcho, runs: Vec<RouterRun>| self.place(&intent, echo, runs);

        if let Some(r) = &input.project_ref {
            let echo = Self::echo(
                r.clone(),
                fixed.unwrap_or(DEFAULT_TEMPLATE),
                format!("project given by the caller; {template_why}"),
            )?;
            return place(echo, Vec::new()).await;
        }
        let allowed: Vec<ProjectSummary> = self
            .ctx
            .store
            .projects_list(None, None)?
            .into_iter()
            .filter(|p| (input.allows)(&p.machine_id))
            .collect();

        if let Some(name) = &parsed.project {
            return match match_project(name, &allowed) {
                ProjectMatch::None => Err(LeadError::not_found(
                    format!("No project you may start work in matches @{name}."),
                    format!(
                        "Use a project's title or folder name (projects_list shows them){}.",
                        allowed
                            .first()
                            .map(|p| format!(", e.g. @{}", slug_of(&p.title)))
                            .unwrap_or_default()
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
                ProjectMatch::One(project) => {
                    let echo = Self::echo(
                        ref_of(project),
                        fixed.unwrap_or(DEFAULT_TEMPLATE),
                        format!("@{name} names {}; {template_why}", project.title),
                    )?;
                    place(echo, Vec::new()).await
                }
            };
        }

        // A retry of the same request returns what the first one got, without another router run.
        if let Some(route) = self.get_route(&input.client_request_id)?
            && let (Some(workstream_id), Some(echo)) = (route.workstream_id, route.echo)
        {
            return Ok(SubmitResult::Placed {
                workstream_id,
                echo,
                next: None,
                lead_waiting: None,
            });
        }

        if allowed.is_empty() {
            return Err(LeadError::not_found(
                "There is no project you may start work in.",
                "Add the project on a connected machine (project_add), or ask the hub admin for an operate grant.",
            ));
        }
        let candidates: Vec<ProjectSummary> = allowed.into_iter().take(ROUTER_PROJECTS).collect();
        let mut projects = Vec::new();
        for p in &candidates {
            let recent = self.workstreams.list(&WorkstreamFilter {
                project_ref: Some(ref_of(p)),
                limit: RECENT_INTENTS,
                ..Default::default()
            })?;
            projects.push(RouterProject {
                project_ref: ref_of(p),
                title: p.title.clone(),
                root: p.workspace_root.clone(),
                recent_intents: recent.into_iter().map(|w| w.title.to_string()).collect(),
            });
        }
        let outcome = self
            .router
            .route(&self.ctx.db.prompts().current(None), &input.text, &projects)
            .await;
        let base = Route {
            text: input.text.clone(),
            template: fixed,
            channel: input.channel,
            by: input.by.clone(),
            workstream_id: None,
            echo: None,
        };

        if let Some(result) = outcome.result {
            let reason = if fixed.is_none() || fixed == Some(result.template) {
                result.reason.to_string()
            } else {
                format!("{} ({template_why})", result.reason)
            };
            let echo = Self::echo(
                result.project_ref.clone(),
                fixed.unwrap_or(result.template),
                reason,
            )?;
            let placed = place(echo.clone(), outcome.runs).await?;
            let SubmitResult::Placed { workstream_id, .. } = &placed;
            self.put_route(
                &input.client_request_id,
                &Route {
                    workstream_id: Some(workstream_id.clone()),
                    echo: Some(echo),
                    ..base
                },
            )?;
            return Ok(placed);
        }

        let why = outcome
            .why
            .unwrap_or_else(|| "the router gave no answer".into());
        self.routed(Routed {
            runs: outcome.runs,
            error: Some(why.clone()),
            summary: clip(&format!("no project for \"{}\": {why}", input.text), 200),
            ..Default::default()
        })?;
        Err(LeadError::invalid(
            format!("The router could not place this intent ({why})."),
            "Name its project with @<project>, or send it in that project's chat.",
        ))
    }
}
