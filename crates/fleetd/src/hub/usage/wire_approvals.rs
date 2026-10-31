//! The approvals area's ports over the real hub: the node link's secret and gated-run commands, and the lead's wake
//! with a request's outcome.
use super::ports::{self, BoxFut};
use super::wire::{OpsPorts, convert};
use crate::hub::approvals::{
    ApprovalHub, ApprovalNodes, GatedOutcome, NodeCommandError, OrderEnvSaved, SecretOutcome,
    parse_secret_sink, shown_argv,
};
use crate::hub::executor::ExecutorError;
use crate::hub::link::commands::NodeCommandErrorReason;
use crate::hub::usage::time::clip;
use fleetd_contracts::ids::ThreadRef;
use fleetd_contracts::ledger::{HumanRequest, RequestState};
use fleetd_contracts::sessions::{PendingPermission, PermissionDecision};
use serde::de::DeserializeOwned;
use serde_json::Value;

fn node_error(e: crate::hub::link::commands::NodeCommandError) -> NodeCommandError {
    NodeCommandError {
        reason: match e.reason {
            NodeCommandErrorReason::Offline => "offline",
            NodeCommandErrorReason::Lost => "lost",
            NodeCommandErrorReason::NoReply => "no_reply",
            NodeCommandErrorReason::Invalid => "invalid",
        }
        .into(),
        message: e.message,
        fix: None,
    }
}

/// A node frame from the approvals area's JSON; `id` is replaced by NodeCommands, so any placeholder does.
fn frame<T: DeserializeOwned>(mut input: Value) -> Result<T, NodeCommandError> {
    input["id"] = Value::String("pending".into());
    serde_json::from_value(input).map_err(|e| NodeCommandError {
        reason: "invalid".into(),
        message: e.to_string(),
        fix: None,
    })
}

fn machine_id(m: &str) -> Result<fleetd_contracts::ids::MachineId, NodeCommandError> {
    convert(&m).ok_or_else(|| NodeCommandError {
        reason: "invalid".into(),
        message: format!("{m} is not a machine id"),
        fix: None,
    })
}

impl ApprovalNodes for OpsPorts {
    fn deliver_secret(
        &self,
        m: &str,
        input: Value,
    ) -> BoxFut<'_, Result<SecretOutcome, NodeCommandError>> {
        let m = m.to_owned();
        Box::pin(async move {
            let (m, input) = (machine_id(&m)?, frame(input)?);
            let result = self
                .hub()
                .node_commands
                .deliver_secret(&m, input)
                .await
                .map_err(node_error)?;
            Ok(SecretOutcome {
                fingerprint: result.fingerprint.map(|f| f.to_string()),
                error: result.error.map(|e| e.to_string()),
            })
        })
    }

    fn run_gated(
        &self,
        m: &str,
        input: Value,
    ) -> BoxFut<'_, Result<GatedOutcome, NodeCommandError>> {
        let m = m.to_owned();
        Box::pin(async move {
            let (m, input) = (machine_id(&m)?, frame(input)?);
            let result = self
                .hub()
                .node_commands
                .run_gated(&m, input)
                .await
                .map_err(node_error)?;
            Ok(GatedOutcome {
                exit_code: result
                    .exit_code
                    .and_then(|c| serde_json::to_value(c).ok())
                    .and_then(|v| v.as_i64()),
                output_tail: result.output_tail.to_string(),
                timed_out: result.timed_out,
                error: result.error.map(|e| e.to_string()),
            })
        })
    }

    fn is_linked(&self, m: &str) -> BoxFut<'_, bool> {
        let m: Option<fleetd_contracts::ids::MachineId> = convert(&m);
        Box::pin(async move { m.is_some_and(|m| self.hub().executors.is_connected(&m)) })
    }

    fn answer_permission(
        &self,
        m: &str,
        t: &str,
        request_id: &str,
        decision: PermissionDecision,
        by: Option<fleetd_contracts::time::DecidedBy>,
    ) -> BoxFut<'_, Result<(), NodeCommandError>> {
        let (r, request_id) = (thread_ref(m, t), request_id.to_owned());
        Box::pin(async move {
            let r = r.ok_or_else(|| NodeCommandError {
                reason: "invalid".into(),
                message: "not a machine and thread id".into(),
                fix: None,
            })?;
            self.hub()
                .executors
                .answer(&r, &request_id, decision, by)
                .await
                .map_err(executor_error)
        })
    }

    fn pending_permission(&self, m: &str, t: &str) -> BoxFut<'_, Option<PendingPermission>> {
        let r = thread_ref(m, t);
        Box::pin(async move { self.hub().executors.pending_permission(&r?) })
    }
}

fn thread_ref(m: &str, t: &str) -> Option<ThreadRef> {
    convert(&serde_json::json!({ "machineId": m, "threadId": t }))
}

fn executor_error(e: ExecutorError) -> NodeCommandError {
    let (reason, fix) = match &e {
        ExecutorError::MachineNotConnected { .. } => ("offline", None),
        ExecutorError::ThreadNotFound { .. } => ("not_found", None),
        ExecutorError::NodeRequestFailed { fix, .. } => ("failed", fix.clone()),
    };
    NodeCommandError {
        reason: reason.into(),
        message: e.to_string(),
        fix,
    }
}

impl ApprovalHub for OpsPorts {
    fn box_key(&self, machine_id: &str) -> BoxFut<'_, Option<Option<String>>> {
        let m: Option<fleetd_contracts::ids::MachineId> = convert(&machine_id);
        Box::pin(async move {
            let machine = self.hub().store.machine_get(&m?).ok()??;
            Some(machine.box_pub_key.as_ref().and_then(convert))
        })
    }

    fn workspace_root(&self, project: &ports::ProjectRef) -> BoxFut<'_, Option<String>> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        Box::pin(async move { Some(self.hub().store.project_get(&r?).ok()??.workspace_root) })
    }

    fn wake_request(&self, request: &HumanRequest) -> BoxFut<'_, ()> {
        let (what, outcome) = request_outcome(request);
        let text = crate::hub::leads::events::Event::Request {
            request: request.request_id.as_str(),
            what: &what,
            outcome: &outcome,
            tail: (request.state == RequestState::Ran)
                .then(|| request.output_tail.as_ref().map(|t| t.as_str()))
                .flatten(),
        }
        .render();
        let project = request.project_ref.clone();
        Box::pin(async move {
            self.hub().leads.wakes.trigger(
                &project,
                crate::hub::leads::wakes::Trigger::Line {
                    kind: crate::hub::leads::wakes::LineKind::Request,
                    text,
                },
            );
        })
    }

    fn mcp_servers(
        &self,
        project: &ports::ProjectRef,
    ) -> BoxFut<'_, Vec<fleetd_contracts::mcp_servers::McpServer>> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        Box::pin(async move {
            let Some(r) = r else {
                return Vec::new();
            };
            self.hub()
                .db
                .mcp_servers()
                .servers_for(&r)
                .unwrap_or_else(|error| {
                    tracing::warn!(%error, "approvals: the project's MCP servers were not read");
                    Vec::new()
                })
        })
    }

    fn navi_lead(&self, project: &ports::ProjectRef, thread_id: &str) -> BoxFut<'_, bool> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        let thread_id = thread_id.to_owned();
        Box::pin(async move {
            let Some(r) = r else {
                return false;
            };
            let hub = self.hub();
            matches!(crate::hub::navi::of(&hub.db, &r), Ok(Some(_)))
                && matches!(hub.leads.records.lead_get(&r), Ok(Some(lead)) if lead.thread_id.as_str() == thread_id)
        })
    }

    fn navi_site(
        &self,
        project: &ports::ProjectRef,
        site: Option<&str>,
    ) -> BoxFut<'_, Option<bool>> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        let site = site.map(str::to_owned);
        Box::pin(async move {
            let r = r?;
            let db = &self.hub().db;
            crate::hub::navi::of(db, &r).ok().flatten()?;
            let Some(site) = site else {
                return Some(false);
            };
            db.with(|c| Ok(crate::hub::navi::store::site_allowed(c, &r, &site)?))
                .ok()
                .or(Some(false))
        })
    }

    fn navi_site_allow(&self, project: &ports::ProjectRef, site: &str, by: &str) -> BoxFut<'_, ()> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        let (site, by) = (site.to_owned(), by.to_owned());
        Box::pin(async move {
            let Some(r) = r else {
                return;
            };
            let hub = self.hub();
            let at = crate::hub::store::now_ms(hub.clock.as_ref());
            if let Err(error) = hub
                .db
                .with(|c| Ok(crate::hub::navi::store::allow_site(c, &r, &site, &by, at)?))
            {
                tracing::warn!(%error, "approvals: a Navi's allowed site was not saved");
            }
        })
    }

    fn navi_image<'a>(
        &'a self,
        project: &'a ports::ProjectRef,
        id: &'a fleetd_contracts::mcp::AttachmentId,
    ) -> BoxFut<'a, bool> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        Box::pin(async move {
            let Some(r) = r else {
                return false;
            };
            self.hub()
                .db
                .with(|c| Ok(crate::hub::intake::attachments::claim_own(c, &r, id)?))
                .unwrap_or(false)
        })
    }

    fn navi_approvals(
        &self,
        project: &ports::ProjectRef,
    ) -> BoxFut<'_, Option<fleetd_contracts::navi::NaviApprovals>> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        Box::pin(async move {
            let r = r?;
            let db = &self.hub().db;
            crate::hub::navi::of(db, &r).ok().flatten()?;
            match db.with(|c| Ok(crate::hub::navi::checker::approvals(c, &r)?)) {
                Ok(settings) => Some(settings),
                Err(error) => {
                    // Unread, a Navi asks the person about every risky action.
                    tracing::warn!(%error, "approvals: a Navi's approval settings were not read");
                    Some(fleetd_contracts::navi::NaviApprovals {
                        mode: fleetd_contracts::navi::NaviApprovalMode::Ask,
                        model: fleetd_contracts::effort::ModelName::unchecked(
                            fleetd_contracts::navi::CHECKER_MODEL,
                        ),
                        effort: fleetd_contracts::navi::CHECKER_EFFORT,
                        defaults: true,
                    })
                }
            }
        })
    }

    fn navi_check<'a>(
        &'a self,
        project: &'a ports::ProjectRef,
        thread_id: &'a str,
        action: &'a crate::hub::navi::checker::Action,
        settings: &'a fleetd_contracts::navi::NaviApprovals,
    ) -> BoxFut<'a, fleetd_contracts::ledger::CheckerNote> {
        use crate::hub::navi::checker;
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        Box::pin(async move {
            let hub = self.hub();
            let failed = |why: &str| fleetd_contracts::ledger::CheckerNote {
                verdict: fleetd_contracts::ledger::CheckerVerdict::Ask,
                reason: fleetd_contracts::prim::Line::unchecked(clip(why, 300)),
            };
            let Some(r) = r else {
                return failed("the checker couldn't find the Navi");
            };
            let owner = crate::hub::navi::of(&hub.db, &r)
                .ok()
                .flatten()
                .and_then(|n| n.owner);
            let thread = ThreadRef {
                machine_id: r.machine_id.clone(),
                thread_id: fleetd_contracts::ids::ThreadId::unchecked(thread_id),
            };
            let (person_messages, navi_last_question) =
                checker::person_messages(&hub, &r).unwrap_or_default();
            let name = owner
                .as_ref()
                .and_then(|p| {
                    crate::hub::people::People::new(hub.db.clone(), hub.clock.clone())
                        .get(p)
                        .ok()
                        .flatten()
                })
                .map(|p| p.name.to_string());
            let allowed_sites = hub
                .db
                .with(|c| Ok(crate::hub::navi::store::sites(c, &r)?))
                .unwrap_or_default()
                .into_iter()
                .map(|s| s.site)
                .collect();
            let now = crate::hub::store::iso_ms(crate::hub::store::now_ms(hub.clock.as_ref()));
            let context = checker::Context {
                person: serde_json::json!({ "name": name }),
                person_messages,
                navi_last_question,
                reads: checker::reads(&hub, &thread).await,
                allowed_sites,
                today: now.get(..10).unwrap_or_default().to_owned(),
            };
            let turn = crate::hub::executor::turn::executors(
                &hub,
                crate::hub::executor::turn::Owner::ApprovalCheck,
            );
            checker::check(&hub, &turn, &r, owner.as_ref(), settings, action, &context).await
        })
    }

    fn navi_auto_approved<'a>(
        &'a self,
        project: &'a ports::ProjectRef,
        action: &'a crate::hub::navi::checker::Action,
        by: fleetd_contracts::navi::AutoApprovedBy,
        reason: Option<&'a str>,
    ) -> BoxFut<'a, ()> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        Box::pin(async move {
            let Some(r) = r else {
                return;
            };
            if let Err(error) =
                crate::hub::navi::checker::auto_approved(&self.hub(), &r, action, by, reason)
            {
                tracing::warn!(%error, "approvals: an auto-approved action was not logged");
            }
        })
    }

    fn order_refusal(
        &self,
        project: &ports::ProjectRef,
        order_id: &str,
    ) -> BoxFut<'_, Option<String>> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        let order = order_id.to_owned();
        Box::pin(async move {
            let Some(r) = r else {
                return Some("The hub has no record of the project.".to_owned());
            };
            crate::hub::projects::order_env::refusal(&self.hub(), &r, &order)
        })
    }

    fn order_env_saved(&self, saved: OrderEnvSaved) -> BoxFut<'_, Result<(), String>> {
        Box::pin(async move {
            let hub = self.hub();
            let at = fleetd_contracts::ids::Timestamp(crate::hub::store::iso_ms(
                crate::hub::store::now_ms(hub.clock.as_ref()),
            ));
            crate::hub::projects::order_env::saved(&hub, &saved, &at).await
        })
    }

    fn preview_config_save(
        &self,
        project: &ports::ProjectRef,
        config: &fleetd_contracts::preview::PreviewConfig,
    ) -> BoxFut<'_, Result<(), String>> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        let config = config.clone();
        Box::pin(async move {
            let r = r.ok_or("the hub has no record of the project")?;
            crate::hub::preview::save_config(&self.hub(), &r, &config).map_err(|e| e.to_string())
        })
    }
}

/// What a request was and what became of it, in the lead's words for its wake.
/// What a settled request was and what became of it, for its line in the lead's wake. A command's output tail goes
/// on the line's body, not here.
pub fn request_outcome(r: &HumanRequest) -> (String, String) {
    let machine = r.project_ref.machine_id.as_str();
    let what = match (&r.secret, &r.gated, &r.permission) {
        (Some(s), _, _) => format!("secret {}", s.key),
        (_, Some(g), _) => format!(
            "your command `{}`",
            clip(
                &shown_argv(&g.argv.iter().cloned().collect::<Vec<_>>()),
                200
            )
        ),
        (_, _, Some(p)) => format!("tool prompt {} {}", p.tool_name, clip(&p.summary, 120)),
        _ if r.preview_config.is_some() => "your proposed preview setting".into(),
        _ => match (&r.purchase, &r.secure_input) {
            (Some(p), _) => format!(
                "your purchase at {} ({} {})",
                p.shop.domain, p.total.amount, p.total.currency
            ),
            (_, Some(i)) => format!("your secure input {} on {}", i.label, i.site.domain),
            _ => "request".into(),
        },
    };
    // A secure input's secret is its own: it fills a field, never a sink to read.
    let what = match &r.secure_input {
        Some(i) => format!("your secure input {} on {}", i.label, i.site.domain),
        None => what,
    };
    let evidence = r.evidence.as_ref().map_or("", |e| e.as_str());
    let order = r
        .secret
        .as_ref()
        .and_then(|s| parse_secret_sink(s.sink.as_str()))
        .and_then(|s| s.order);
    let outcome = match r.state {
        RequestState::Stored if r.secure_input.is_some() => {
            "the person entered it and fleetd filled it into that field; you never see it. Carry on with the page"
                .to_owned()
        }
        RequestState::Approved if r.secure_input.is_some() => format!(
            "approved: call secure_input_fill with requestId {} within {} minutes, on that page",
            r.request_id,
            fleetd_contracts::secure_input::FILL_WINDOW_MINUTES
        ),
        RequestState::Denied | RequestState::Withdrawn if r.secure_input.is_some() => {
            "not given; don't get it another way: say in the chat that you didn't".to_owned()
        }
        RequestState::Approved if r.purchase.is_some() => format!(
            "approved{}: call purchase_fill with requestId {} within {} minutes, on that checkout with its card \
             fields showing, then click Pay yourself",
            r.answered_by
                .as_deref()
                .map_or(String::new(), |b| format!(" by {b}")),
            r.request_id,
            fleetd_contracts::purchase::FILL_WINDOW_MINUTES
        ),
        RequestState::Denied if r.purchase.is_some() => format!(
            "denied{}{}; don't buy it, nor another way: say in the chat that you didn't, and end the browser session \
             (session_end) once you're done with it",
            r.answered_by
                .as_deref()
                .map_or(String::new(), |b| format!(" by {b}")),
            if evidence.is_empty() {
                String::new()
            } else {
                format!(": {evidence}")
            }
        ),
        RequestState::Stored if order.is_some() => format!(
            "set for {}'s agents on {machine} ({evidence}): each gets it at its next turn, until the order closes; \
             you never see the value",
            order.unwrap_or_default()
        ),
        RequestState::Stored => format!(
            "stored on {machine} ({evidence}); use it from its sink, you never see the value"
        ),
        RequestState::Withdrawn => "withdrawn".into(),
        RequestState::Denied => format!(
            "denied{}{}; don't run it, say in the chat what you do instead",
            r.answered_by
                .as_deref()
                .map_or(String::new(), |b| format!(" by {b}")),
            if evidence.is_empty() {
                String::new()
            } else {
                format!(": {evidence}")
            }
        ),
        RequestState::Approved => format!("approved ({evidence})"),
        RequestState::Ran => format!("ran: {evidence}"),
        RequestState::Failed => format!("did not run: {evidence}"),
        RequestState::Open => format!("open again: {evidence}"),
    };
    (what, outcome)
}
