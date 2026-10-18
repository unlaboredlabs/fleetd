//! Where a new intent goes. The caller's project, or a leading `@<project>`, decides the project; otherwise the router
//! picks it, and when the router cannot, an unrouted ask lets the human pick. A template prefix (`fix:`) or the
//! caller's template beats the router's; with the project known and no template given, it is `feature`. The
//! workstream pins the chosen template's playbook.
pub mod prefix;
pub mod router;

use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::ledger::{
    AskId, Decision, DecisionKey, IntakeChannel, PlaybookName, PlaybookRef, UNROUTED_ASK_PREFIX,
    WorkstreamId,
};
use fleetd_contracts::model::ProjectSummary;
use fleetd_contracts::playbooks::IntakeEcho;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use self::prefix::{ProjectMatch, match_project, parse_intent, ref_of, slug_of};
use self::router::{IntakeRouter, RouterProject, RouterRun};
use crate::hub::leads::brief::sha256_hex;
use crate::hub::leads::digest::clip_utf16;
use crate::hub::leads::error::LeadError;
use crate::hub::leads::ports::RouteAsk;
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::leads::workstreams::{IntakeInput, Workstreams};
use crate::hub::leads::{Ctx, now_iso};
use crate::hub::store::{NewEvent, StoreError, WaitInput};

/// Projects offered to the router, most recently active first.
pub const ROUTER_PROJECTS: usize = 20;
const RECENT_INTENTS: usize = 3;
/// AskOptions holds at most 6.
const ASK_OPTIONS: usize = 6;
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
    },
    Asked {
        ask_id: AskId,
        next: String,
    },
}

/// One routed or asked-about intent; `options` maps the ask's options back to projects.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Route {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    template: Option<PlaybookName>,
    channel: IntakeChannel,
    by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<Vec<RouteOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workstream_id: Option<WorkstreamId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    echo: Option<IntakeEcho>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RouteOption {
    label: String,
    #[serde(rename = "ref")]
    project_ref: ProjectRef,
}

fn clip(text: &str, max: usize) -> String {
    clip_utf16(&text.split_whitespace().collect::<Vec<_>>().join(" "), max)
}

/// `intake.route.<words>-<hash>`: readable, and unique per request so two intents never share an ask.
pub fn route_key(text: &str, client_request_id: &str) -> String {
    let hash = &sha256_hex(client_request_id.as_bytes())[..6];
    let slug = slug_of(text);
    let words: String = slug
        .chars()
        .take(40)
        .collect::<String>()
        .trim_end_matches('-')
        .to_string();
    format!(
        "{UNROUTED_ASK_PREFIX}{}{hash}",
        if words.is_empty() {
            String::new()
        } else {
            format!("{words}-")
        }
    )
}

/// Ask options: "<title> on <machine>", made unique with the project id when two read the same.
fn options_of(projects: &[ProjectSummary]) -> Vec<RouteOption> {
    let mut seen: Vec<String> = Vec::new();
    projects
        .iter()
        .take(ASK_OPTIONS)
        .map(|p| {
            let mut label = clip(&format!("{} on {}", p.title, p.machine_id), 200);
            if seen.contains(&label.to_lowercase()) {
                label = clip(
                    &format!("{} on {} ({})", p.title, p.machine_id, p.project_id),
                    200,
                );
            }
            seen.push(label.to_lowercase());
            RouteOption {
                label,
                project_ref: ref_of(p),
            }
        })
        .collect()
}

pub struct Intake {
    ctx: Arc<Ctx>,
    workstreams: Arc<Workstreams>,
    router: Arc<IntakeRouter>,
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
    ask_id: Option<AskId>,
    summary: String,
    runs: Vec<RouterRun>,
    error: Option<String>,
}

impl Intake {
    pub fn new(
        ctx: Arc<Ctx>,
        workstreams: Arc<Workstreams>,
        router: Arc<IntakeRouter>,
    ) -> Arc<Self> {
        Arc::new(Self {
            ctx,
            workstreams,
            router,
        })
    }

    fn get_route(
        &self,
        client_request_id: &str,
    ) -> Result<Option<(Option<AskId>, Route)>, StoreError> {
        let row: Option<(Option<String>, String)> = self.ctx.db.with(|c| {
            Ok(c.query_row(
                "SELECT ask_id, data FROM intake_routes WHERE client_request_id = ?",
                params![client_request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
        })?;
        row.map(|(ask, data)| {
            Ok((
                ask.map(|a| serde_json::from_value(serde_json::Value::String(a)))
                    .transpose()?,
                serde_json::from_str(&data)?,
            ))
        })
        .transpose()
    }

    fn put_route(
        &self,
        client_request_id: &str,
        ask_id: Option<&AskId>,
        route: &Route,
    ) -> Result<(), StoreError> {
        let data = serde_json::to_string(route)?;
        self.ctx.db.with(|c| {
            c.execute(
                "INSERT INTO intake_routes (client_request_id, ask_id, data) VALUES (?, ?, ?)
                 ON CONFLICT (client_request_id) DO UPDATE SET data = excluded.data",
                params![client_request_id, ask_id.map(|a| a.as_str()), data],
            )?;
            Ok(())
        })
    }

    fn routed(&self, input: Routed) -> Result<(), LeadError> {
        let mut data = serde_json::Map::new();
        if let Some(w) = &input.workstream_id {
            data.insert("workstreamId".into(), serde_json::to_value(w)?);
        }
        if let Some(a) = &input.ask_id {
            data.insert("askId".into(), serde_json::to_value(a)?);
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

    /// Creates the workstream in the chosen project and reports where it went.
    fn place(
        &self,
        intent: &Intent<'_>,
        echo: IntakeEcho,
        runs: Vec<RouterRun>,
        ask_id: Option<AskId>,
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
        let project = self
            .ctx
            .store
            .project_get(&echo.project_ref)?
            .map_or_else(|| echo.project_ref.project_id.to_string(), |p| p.title);
        self.routed(Routed {
            summary: clip(
                &format!(
                    "{} → {project} ({}): {}",
                    created.workstream_id,
                    echo.template.as_str(),
                    echo.reason
                ),
                200,
            ),
            echo: Some(echo.clone()),
            workstream_id: Some(created.workstream_id.clone()),
            playbook: created.playbook,
            ask_id,
            runs,
            error: None,
        })?;
        Ok(SubmitResult::Placed {
            workstream_id: created.workstream_id,
            echo,
            next: Some(created.next),
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

    pub async fn submit(&self, input: SubmitInput) -> Result<SubmitResult, LeadError> {
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
        let place = |echo: IntakeEcho, runs: Vec<RouterRun>| self.place(&intent, echo, runs, None);
        if let Some(r) = &input.project_ref {
            let echo = Self::echo(
                r.clone(),
                fixed.unwrap_or(DEFAULT_TEMPLATE),
                format!("project given by the caller; {template_why}"),
            )?;
            return place(echo, Vec::new());
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
                    place(echo, Vec::new())
                }
            };
        }

        // A retry of the same request returns what the first one got, without another router run.
        if let Some((ask_id, route)) = self.get_route(&input.client_request_id)? {
            if let (Some(workstream_id), Some(echo)) = (route.workstream_id, route.echo) {
                return Ok(SubmitResult::Placed {
                    workstream_id,
                    echo,
                    next: None,
                });
            }
            if let Some(ask_id) = ask_id {
                return Ok(SubmitResult::Asked {
                    next: format!("Answer {ask_id} with inbox_reply to pick the project."),
                    ask_id,
                });
            }
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
        let outcome = self.router.route(&input.text, &projects).await;
        let base = Route {
            text: input.text.clone(),
            template: fixed,
            channel: input.channel,
            by: input.by.clone(),
            options: None,
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
            let placed = place(echo.clone(), outcome.runs)?;
            if let SubmitResult::Placed { workstream_id, .. } = &placed {
                self.put_route(
                    &input.client_request_id,
                    None,
                    &Route {
                        workstream_id: Some(workstream_id.clone()),
                        echo: Some(echo),
                        ..base
                    },
                )?;
            }
            return Ok(placed);
        }

        let options = options_of(&candidates);
        let why = outcome
            .why
            .unwrap_or_else(|| "the router gave no answer".into());
        let key: DecisionKey = serde_json::from_value(serde_json::Value::String(route_key(
            &input.text,
            &input.client_request_id,
        )))
        .map_err(|e| {
            LeadError::bare(
                fleetd_contracts::mcp::ErrorCode::Invalid,
                format!("The routing ask key is invalid: {e}"),
            )
        })?;
        let ask_id = self.ctx.ports().create_route_ask(
            RouteAsk {
                key,
                text: clip(
                    &format!(
                        "Which project is this intent for? \"{}\" ({why})",
                        clip(&input.text, 300)
                    ),
                    500,
                ),
                options: options.iter().map(|o| o.label.clone()).collect(),
                recommendation: options[0].label.clone(),
                blocks: "this intent until it has a project".into(),
            },
            &input.by,
        )?;
        self.put_route(
            &input.client_request_id,
            Some(&ask_id),
            &Route {
                options: Some(options),
                ..base
            },
        )?;
        self.routed(Routed {
            ask_id: Some(ask_id.clone()),
            runs: outcome.runs,
            summary: clip(
                &format!("{ask_id}: which project for \"{}\"? {why}", input.text),
                200,
            ),
            ..Default::default()
        })?;
        Ok(SubmitResult::Asked {
            next: format!(
                "The router could not place this intent ({why}). Answer {ask_id} with inbox_reply to pick the project."
            ),
            ask_id,
        })
    }

    /// The human's answer to a routing ask: the option it names, or a project title or folder name.
    fn project_of_answer(
        &self,
        value: &str,
        route: &Route,
    ) -> Result<Option<ProjectRef>, LeadError> {
        let wanted = value.trim().to_lowercase();
        if let Some(option) = route
            .options
            .iter()
            .flatten()
            .find(|o| o.label.to_lowercase() == wanted)
        {
            return Ok(Some(option.project_ref.clone()));
        }
        let projects = self.ctx.store.projects_list(None, None)?;
        Ok(
            match match_project(value.trim().trim_start_matches('@'), &projects) {
                ProjectMatch::One(p) => Some(ref_of(p)),
                _ => None,
            },
        )
    }

    fn on_answer(&self, decision: &Decision) -> Result<(), LeadError> {
        let Some(ask_id) = &decision.ask_id else {
            return Ok(());
        };
        let row: Option<(String, String)> = self.ctx.db.with(|c| {
            Ok(c.query_row(
                "SELECT client_request_id, data FROM intake_routes WHERE ask_id = ?",
                params![ask_id.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
        })?;
        let Some((client_request_id, data)) = row else {
            return Ok(());
        };
        let route: Route = serde_json::from_str(&data).map_err(StoreError::from)?;
        if route.workstream_id.is_some() {
            return Ok(());
        }
        let value = decision.value.as_str();
        let Some(r) = self.project_of_answer(value, &route)? else {
            return self.routed(Routed {
                ask_id: Some(ask_id.clone()),
                error: Some(format!("the answer \"{}\" names no project", clip(value, 80))),
                summary: clip(&format!("{ask_id}: the answer \"{value}\" names no project; submit the intent again with @<project>"), 200),
                ..Default::default()
            });
        };
        let echo = Self::echo(
            r,
            route.template.unwrap_or(DEFAULT_TEMPLATE),
            format!("the human picked it in {ask_id}"),
        )?;
        let intent = Intent {
            text: &route.text,
            client_request_id: &client_request_id,
            channel: route.channel,
            by: &route.by,
        };
        match self.place(&intent, echo.clone(), Vec::new(), Some(ask_id.clone())) {
            Err(e) => self.routed(Routed {
                ask_id: Some(ask_id.clone()),
                summary: clip(
                    &format!("{ask_id}: could not start the intent: {}", e.message),
                    200,
                ),
                error: Some(e.message),
                ..Default::default()
            }),
            Ok(SubmitResult::Placed { workstream_id, .. }) => Ok(self.put_route(
                &client_request_id,
                Some(ask_id),
                &Route {
                    workstream_id: Some(workstream_id),
                    echo: Some(echo),
                    ..route
                },
            )?),
            Ok(SubmitResult::Asked { .. }) => Ok(()),
        }
    }

    /// Answers arrive through the inbox as decision.recorded events; follows them from the hub's start.
    pub async fn run_answers(self: Arc<Self>) {
        let events = Arc::clone(&self.ctx.events);
        let mut cursor = events.head();
        loop {
            let page = match events
                .wait(WaitInput {
                    cursor: Some(cursor),
                    types: Some(vec![HubEventType::DecisionRecorded]),
                    machine_id: None,
                    timeout_sec: 3600,
                })
                .await
            {
                Ok(page) => page,
                Err(error) => {
                    tracing::warn!(%error, "intake answers: event log read failed");
                    self.ctx
                        .clock
                        .sleep(std::time::Duration::from_secs(1))
                        .await;
                    continue;
                }
            };
            cursor = page.cursor;
            for event in page.events {
                let Some(data) = &event.data else { continue };
                if !data
                    .get("key")
                    .and_then(|k| k.as_str())
                    .is_some_and(|k| k.starts_with(UNROUTED_ASK_PREFIX))
                {
                    continue;
                }
                let Some(id) = data.get("decisionId").and_then(|v| v.as_str()) else {
                    continue;
                };
                match self.ctx.ports().decision(id) {
                    Ok(Some(decision)) => {
                        if let Err(error) = self.on_answer(&decision) {
                            tracing::warn!(%error, "intake: routing answer not applied");
                        }
                    }
                    Ok(None) => {}
                    Err(error) => tracing::warn!(%error, "intake: decision read failed"),
                }
            }
        }
    }
}
