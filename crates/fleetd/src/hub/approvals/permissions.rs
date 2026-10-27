//! A session's permission prompt as an approval (W97). A session in `manual` mode (a Navi's lead) asks before any tool
//! off its allow-list. The ask reaches the hub as `thread.waiting` carrying `data.permission`, and the tool's input is
//! read off the thread (`PendingPermission.input`). The integrations policy (`hub/integrations/policy.rs`) decides first
//! for an MCP server's tool: a read answers the prompt at once, a blocked tool is denied with why and nothing is filed,
//! and an asking one opens an approval with its preview (who it reaches, what it says). Any other tool (a command, an
//! edit) opens an approval showing the tool, its summary and its input. A Navi's fetch or browser visit goes through
//! its site gate first: a site the person allowed goes through, and approving a first visit allows its site. Approved, the tool runs with exactly the input the approval showed; denied, the session hears who said
//! no. A prompt that goes away (answered elsewhere, or its run ended) closes its request.
use std::sync::Arc;

use fleetd_contracts::chat::ChatRequestId;
use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ledger::{HumanRequest, RequestKind, RequestState, ToolPermission};
use fleetd_contracts::sessions::{PendingPermission, PermissionDecision};
use fleetd_contracts::time::DecidedBy;
use serde_json::Value;

use crate::hub::integrations::policy::{self, Verdict};
use crate::hub::navi::sites::{self, Visit};

use super::store::{NewRequest, RequestFilter};
use super::{Approvals, contract_project, project_of};
use crate::hub::store::{iso_ms, system_ms};
use crate::hub::usage::ports::{ProjectRef, WaitInput};
use crate::hub::usage::time::clip;

/// A prompt whose input the node didn't send (over 64 KiB): an approval couldn't show what approving it runs.
const UNSHOWN: &str =
    "Blocked by fleetd: what this call would do is too large to show on an approval card.";

/// Events that change whether a thread's prompt is still open.
const THREAD_EVENTS: [&str; 6] = [
    "thread.waiting",
    "thread.started",
    "thread.completed",
    "thread.failed",
    "thread.interrupted",
    "thread.usage_limited",
];

/// The thread and prompt a request answers.
fn prompt_of(r: &HumanRequest) -> Option<(&str, &ToolPermission)> {
    let p = r.permission.as_ref()?;
    Some((p.thread_id.as_str(), p))
}

impl Approvals {
    /// Follows thread events from the head: answers or files new prompts, and closes requests whose prompt is gone.
    pub(super) async fn follow_threads(self: Arc<Self>) {
        let mut cursor = self.deps.events.head().await;
        loop {
            let page = self
                .deps
                .events
                .wait(WaitInput {
                    cursor,
                    types: THREAD_EVENTS.to_vec(),
                    timeout_sec: 3600,
                    ..Default::default()
                })
                .await;
            cursor = page.cursor;
            for event in page.events {
                self.on_thread_event(&event).await;
            }
        }
    }

    pub(super) async fn on_thread_event(&self, event: &HubEvent) {
        let (Some(machine_id), Some(thread_id), Some(project_id)) = (
            event.machine_id.as_ref(),
            event.thread_id.as_ref(),
            event.project_id.as_ref(),
        ) else {
            return;
        };
        let (machine_id, thread_id) = (machine_id.as_str(), thread_id.as_str());
        let current: Option<PendingPermission> = event
            .data
            .as_ref()
            .and_then(|d| d.get("permission"))
            .and_then(|p| serde_json::from_value(p.clone()).ok());
        if event.r#type == HubEventType::ThreadWaiting && current.is_none() {
            return;
        }
        let why = if current.is_some() || event.r#type == HubEventType::ThreadStarted {
            "closed: the prompt was answered elsewhere"
        } else {
            "expired: the run ended"
        };
        let mut filed = false;
        for open in self.open_prompts() {
            let Some((thread, p)) = prompt_of(&open) else {
                continue;
            };
            if open.project_ref.machine_id.as_str() != machine_id || thread != thread_id {
                continue;
            }
            if current
                .as_ref()
                .is_some_and(|c| c.request_id == p.request_id)
            {
                filed = true;
            } else {
                self.close_prompt(&open.request_id, why).await;
            }
        }
        let (Some(prompt), false) = (current, filed) else {
            return;
        };
        let project = ProjectRef {
            machine_id: machine_id.to_owned(),
            project_id: project_id.to_string(),
        };
        // Only a Navi's lead runs with prompts; any other session's are not this relay's to answer.
        if !self.deps.hub.navi_lead(&project, thread_id).await {
            return;
        }
        // The event carries no input (an event's data is at most 2 KB): the thread does.
        let prompt = self
            .deps
            .nodes
            .pending_permission(machine_id, thread_id)
            .await
            .filter(|p| p.request_id == prompt.request_id)
            .unwrap_or(prompt);
        self.raise(&project, thread_id, &prompt).await;
    }

    /// Answers a new prompt by the hub's policy, or opens the approval a person answers.
    async fn raise(&self, project: &ProjectRef, thread_id: &str, prompt: &PendingPermission) {
        let (tool, summary) = (prompt.tool_name.as_str(), prompt.summary.as_str());
        let machine = &project.machine_id;
        let servers = self.deps.hub.mcp_servers(project).await;
        let input = prompt.input.clone().unwrap_or(Value::Null);
        let deny = |why: &str| {
            Some(PermissionDecision::Deny {
                message: fleetd_contracts::prim::Text::unchecked(clip(why, 2000)),
            })
        };
        let (decided, preview) = match policy::verdict(tool, &input, &servers) {
            Some(Verdict::Allow) => (
                Some(PermissionDecision::Allow {
                    updated_input: None,
                }),
                None,
            ),
            _ if prompt.input.is_none() => (deny(UNSHOWN), None),
            Some(Verdict::Block(why)) => (deny(why), None),
            Some(Verdict::Ask(preview)) => (None, Some(preview)),
            None => (None, None),
        };
        // A Navi's fetch or browser visit: a site the person allowed before goes through; any other asks, and its
        // approval allows the site (hub/navi/sites.rs).
        let mut site = None;
        let mut decided = decided;
        if let Some(visit) = sites::visit(tool, &input) {
            let host = match &visit {
                Visit::Site(host) => Some(host.as_str()),
                Visit::Unknown => None,
            };
            match self.deps.hub.navi_site(project, host).await {
                Some(true) => {
                    decided = Some(PermissionDecision::Allow {
                        updated_input: None,
                    })
                }
                Some(false) => site = host.map(str::to_owned),
                None => {}
            }
        }
        if let Some(decision) = decided {
            if let Err(e) = self
                .deps
                .nodes
                .answer_permission(
                    machine,
                    thread_id,
                    prompt.request_id.as_str(),
                    decision,
                    Some(DecidedBy::HubRule),
                )
                .await
            {
                tracing::warn!(
                    error = e.message,
                    "approvals: the policy's answer to a prompt was not delivered"
                );
            }
            return;
        }
        let now = system_ms(self.deps.clock.now());
        if let Err(e) = self
            .create(NewRequest {
                project_ref: contract_project(project),
                workstream_id: None,
                kind: RequestKind::Approval,
                text: clip(&format!("{tool}: {summary}"), 500),
                secret: None,
                gated: None,
                permission: Some(ToolPermission {
                    thread_id: fleetd_contracts::ids::ThreadId::unchecked(thread_id),
                    request_id: prompt.request_id.clone(),
                    tool_name: prompt.tool_name.clone(),
                    summary: prompt.summary.clone(),
                    preview,
                    input: prompt.input.clone(),
                    site,
                }),
                preview_config: None,
                at: fleetd_contracts::ids::Timestamp(iso_ms(now)),
                at_ms: now,
            })
            .await
        {
            tracing::error!(
                error = e.message,
                "approvals: a tool prompt's request was not opened"
            );
        }
    }

    fn open_prompts(&self) -> Vec<HumanRequest> {
        self.deps
            .requests
            .list(&RequestFilter {
                states: Some(vec![RequestState::Open]),
                kind: Some(RequestKind::Approval),
                limit: i64::MAX,
                ..Default::default()
            })
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "approvals: prompt requests not listed");
                Vec::new()
            })
            .into_iter()
            .filter(|r| r.permission.is_some())
            .collect()
    }

    /// Closes a prompt's open request nobody needs to answer any more: denied, with why.
    async fn close_prompt(&self, id: &ChatRequestId, why: &str) {
        let at = self.now();
        let why = why.to_owned();
        if let Err(e) = self
            .change_from(id, RequestState::Open, |r| {
                r.state = RequestState::Denied;
                r.evidence = Some(fleetd_contracts::prim::Text::unchecked(why));
                r.answered_at = Some(fleetd_contracts::ids::Timestamp(at));
                r.answered_by = Some("hub".into());
            })
            .await
        {
            tracing::warn!(request = %id, error = e.message, "approvals: a stale prompt request was not closed");
        }
    }

    /// A tool prompt's request was answered: approved runs the tool with exactly the input shown; denied (by a person,
    /// or withdrawn by the lead) refuses it, saying who. An approval the node didn't take goes back to the person.
    pub(super) async fn answer_prompt(&self, r: &HumanRequest, said: Option<&str>) {
        let Some((thread_id, p)) = prompt_of(r) else {
            return;
        };
        let project = project_of(r);
        let machine = &project.machine_id;
        let by = r.answered_by.clone().unwrap_or_else(|| "a person".into());
        let allow = r.state == RequestState::Approved;
        if allow && let Some(site) = &p.site {
            self.deps.hub.navi_site_allow(&project, site, &by).await;
        }
        let decision = if allow {
            PermissionDecision::Allow {
                updated_input: p.input.clone(),
            }
        } else {
            let said = said.map(|s| format!(": {s}")).unwrap_or_default();
            PermissionDecision::Deny {
                message: fleetd_contracts::prim::Text::unchecked(clip(
                    &format!("{by} said no ({}){said}", r.request_id),
                    2000,
                )),
            }
        };
        let decided_by = if by.starts_with("human") {
            DecidedBy::Human
        } else {
            DecidedBy::Lead
        };
        let sent = self
            .deps
            .nodes
            .answer_permission(
                machine,
                thread_id,
                p.request_id.as_str(),
                decision,
                Some(decided_by),
            )
            .await;
        let verb = if allow { "allowed" } else { "denied" };
        let evidence = match sent {
            Ok(()) => format!("{verb} on {machine}, answered by {by}"),
            Err(e) if allow && e.reason == "offline" => {
                let _ = self
                    .reopen(
                        &r.request_id,
                        &format!(
                            "not delivered: {}; approve it again once {machine} is online",
                            e.message
                        ),
                    )
                    .await;
                return;
            }
            Err(e) => format!("not delivered to {machine}: {}", e.message),
        };
        let _ = self.note(&r.request_id, &evidence).await;
    }
}
