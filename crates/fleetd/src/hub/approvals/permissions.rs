//! A session's permission prompt as an approval (W97). A session in `manual` mode (a Navi's lead) asks before any tool
//! off its allow-list. The ask reaches the hub as `thread.waiting` carrying `data.permission`, and the tool's input is
//! read off the thread (`PendingPermission.input`). The integrations policy (`hub/integrations/policy.rs`) decides first
//! for an MCP server's tool: a read answers the prompt at once, a blocked tool is denied with why and nothing is filed,
//! and an asking one opens an approval with its preview (who it reaches, what it says). Any other tool (a command, an
//! edit) opens an approval showing the tool, its summary and its input. A Navi's fetch or browser visit goes through
//! its site gate first: a site the person allowed (or linked in their own message) goes through, and approving a first
//! visit allows its site. Any other command runs unasked (D208), but only because the OS sandbox fences it: the node
//! answers it itself, and a command that still reaches this relay comes from a node with no sandbox, so it asks.
//! Approved, the tool runs with exactly the input the approval showed; denied, the session hears who
//! said no. A prompt that goes away (answered elsewhere, or its run ended) closes its request.
use std::sync::Arc;

use fleetd_contracts::chat::ChatRequestId;
use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ledger::{
    CheckerNote, CheckerVerdict, HumanRequest, RequestKind, RequestState, ToolPermission,
};
use fleetd_contracts::navi::{AutoApprovedBy, NaviApprovalMode};
use fleetd_contracts::sessions::{PendingPermission, PermissionDecision};
use fleetd_contracts::time::DecidedBy;
use serde_json::Value;

use crate::hub::integrations::policy::{self, Verdict};
use crate::hub::navi::checker::{self, Action};
use crate::hub::navi::confirm;
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

/// Whether the checker blocked the prompt this card shows.
fn blocked(p: &ToolPermission) -> bool {
    p.checker
        .as_ref()
        .is_some_and(|c| c.verdict == CheckerVerdict::Block)
}

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

    pub(super) async fn on_thread_event(self: &Arc<Self>, event: &HubEvent) {
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

    /// Answers a new prompt by the hub's policy, or decides it by the Navi's approval mode: a card the person answers,
    /// the checker's verdict, or (YOLO) at once.
    async fn raise(
        self: &Arc<Self>,
        project: &ProjectRef,
        thread_id: &str,
        prompt: &PendingPermission,
    ) {
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
            // A Navi's final Confirm on a site: a payment is refused, anything else is a risky action like a send.
            None if tool == confirm::TOOL => match confirm::refused(&input) {
                _ if prompt.input.is_none() => (deny(UNSHOWN), None),
                Some(why) => (deny(why), None),
                None => (None, confirm::preview(&input).map(Box::new)),
            },
            None => (None, None),
        };
        // A Navi's fetch or browser visit: a site the person allowed before goes through; any other asks, and its
        // approval allows the site (hub/navi/sites.rs).
        let mut site = None;
        let mut decided = decided;
        if let Some(visit) = sites::visit(tool, &input) {
            // The floors first, on any site, allowed or not, in every mode: a credential in the link, or a link that
            // moves money or trades. Any other link follows the mode.
            let mut shown = match &input {
                Value::Object(o) => o.clone(),
                _ => serde_json::Map::new(),
            };
            shown.insert("tool".to_owned(), Value::String(tool.to_owned()));
            if decided.is_none()
                && let Some(why) = crate::hub::navi::review::floor(&Value::Object(shown))
            {
                decided = deny(why);
            }
            let host = match &visit {
                Visit::Site(host) => Some(host.as_str()),
                Visit::Unknown => None,
            };
            // A link that carries data (an address, a long code) goes through the Navi's mode even on an allowed site.
            let data = crate::hub::navi::review::visit_url(&input)
                .is_some_and(|u| crate::hub::navi::review::carries_data(&u, &[]));
            match self.deps.hub.navi_site(project, host).await {
                _ if decided.is_some() => {}
                Some(true) if data => site = host.map(str::to_owned),
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
            self.answer_by_rule(machine, thread_id, prompt, decision)
                .await;
            return;
        }
        let action = Action {
            tool: tool.to_owned(),
            summary: summary.to_owned(),
            input: input.clone(),
            preview: preview.as_deref().cloned(),
            site: site.clone(),
        };
        // What the person approved anyway after the checker blocked it runs once, when the Navi asks again.
        if prompt.input.is_some() && self.approved_anyway(project, &action).await {
            let allow = PermissionDecision::Allow {
                updated_input: None,
            };
            self.answer_by_rule(machine, thread_id, prompt, allow).await;
            return;
        }
        let settings = match prompt.input {
            Some(_) => self.deps.hub.navi_approvals(project).await,
            None => None,
        };
        let risky = action.preview.is_some() || action.site.is_some();
        // A purchase, a spend and a payment command are the person's alone (`purchases::person_only`): no checker and
        // no YOLO answers them.
        let person_only = checker::always_asks(&action)
            || super::purchases::person_only(&self.prospect(project, thread_id, prompt, &action));
        match settings.as_ref().map(|s| s.mode) {
            _ if person_only => {}
            Some(NaviApprovalMode::Yolo) => {
                // YOLO skips the checker and every ask, never the floors: money, trading, a credential in what goes
                // out or a link it opens, a link that moves money or trades, a command that wipes the machine.
                let mut shown = match &input {
                    Value::Object(o) => o.clone(),
                    _ => serde_json::Map::new(),
                };
                shown.insert("tool".to_owned(), Value::String(tool.to_owned()));
                let shown = Value::Object(shown);
                let refused = crate::hub::navi::review::floor(&shown).or_else(|| {
                    (tool == "Bash")
                        .then(|| input.get("command").and_then(Value::as_str))
                        .flatten()
                        .and_then(|c| crate::hub::navi::shell_guard::refused(c, None))
                });
                if let Some(why) = refused {
                    self.answer_by_rule(machine, thread_id, prompt, deny(why).unwrap())
                        .await;
                    return;
                }
                self.go(
                    project,
                    thread_id,
                    prompt,
                    &action,
                    AutoApprovedBy::Yolo,
                    None,
                )
                .await;
                return;
            }
            Some(NaviApprovalMode::Checker) if risky => {
                let key = (
                    machine.clone(),
                    thread_id.to_owned(),
                    prompt.request_id.to_string(),
                );
                if !self.checking.lock().unwrap().insert(key.clone()) {
                    return;
                }
                let (me, project, thread_id, prompt) = (
                    Arc::clone(self),
                    project.clone(),
                    thread_id.to_owned(),
                    prompt.clone(),
                );
                let settings = settings.unwrap();
                // A checker turn takes seconds to minutes: the follower goes on with other prompts meanwhile.
                tokio::spawn(async move {
                    let note = me
                        .deps
                        .hub
                        .navi_check(&project, &thread_id, &action, &settings)
                        .await;
                    me.checked(&project, &thread_id, &prompt, action, note)
                        .await;
                    me.checking.lock().unwrap().remove(&key);
                    me.idle.notify_waiters();
                });
                return;
            }
            _ => {}
        }
        self.file(project, thread_id, prompt, action, None).await;
    }

    /// The request a prompt's card would be, before there is one: what `purchases::person_only` judges.
    fn prospect(
        &self,
        project: &ProjectRef,
        thread_id: &str,
        prompt: &PendingPermission,
        action: &Action,
    ) -> HumanRequest {
        HumanRequest {
            request_id: ChatRequestId::unchecked("Q0"),
            project_ref: contract_project(project),
            workstream_id: None,
            kind: RequestKind::Approval,
            text: fleetd_contracts::prim::Text::unchecked(clip(
                &format!("{}: {}", prompt.tool_name, prompt.summary),
                500,
            )),
            state: RequestState::Open,
            secret: None,
            gated: None,
            permission: Some(ToolPermission {
                thread_id: fleetd_contracts::ids::ThreadId::unchecked(thread_id),
                request_id: prompt.request_id.clone(),
                tool_name: prompt.tool_name.clone(),
                summary: prompt.summary.clone(),
                preview: action.preview.clone().map(Box::new),
                input: prompt.input.clone(),
                site: action.site.clone(),
                checker: None,
                screenshot: None,
            }),
            preview_config: None,
            purchase: None,
            evidence: None,
            exit_code: None,
            output_tail: None,
            created_at: fleetd_contracts::ids::Timestamp(self.now()),
            answered_at: None,
            answered_by: None,
            answered_by_person: None,
            finished_at: None,
        }
    }

    /// Answers a prompt by a hub rule, without asking anyone.
    async fn answer_by_rule(
        &self,
        machine: &str,
        thread_id: &str,
        prompt: &PendingPermission,
        decision: PermissionDecision,
    ) -> bool {
        match self
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
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(
                    error = e.message,
                    "approvals: the policy's answer to a prompt was not delivered"
                );
                false
            }
        }
    }

    /// Runs an action nobody was asked about: answered on its node, then one quiet line in the Navi's chat and an
    /// entry in its auto-approved log. A first visit's site is allowed from then on, as a person's approval allows it.
    async fn go(
        &self,
        project: &ProjectRef,
        thread_id: &str,
        prompt: &PendingPermission,
        action: &Action,
        by: AutoApprovedBy,
        reason: Option<&str>,
    ) {
        let allow = PermissionDecision::Allow {
            updated_input: None,
        };
        if !self
            .answer_by_rule(&project.machine_id, thread_id, prompt, allow)
            .await
        {
            return;
        }
        if let Some(site) = &action.site {
            let who = match by {
                AutoApprovedBy::Checker => "checker",
                AutoApprovedBy::Yolo => "yolo",
            };
            self.deps.hub.navi_site_allow(project, site, who).await;
        }
        self.deps
            .hub
            .navi_auto_approved(project, action, by, reason)
            .await;
    }

    /// The checker's verdict on a prompt, once it came: go runs it; ask files the card with its reason; block refuses
    /// it on its node and files a card the person may approve anyway. A prompt gone meanwhile (answered elsewhere, its
    /// run ended) is left alone.
    async fn checked(
        &self,
        project: &ProjectRef,
        thread_id: &str,
        prompt: &PendingPermission,
        action: Action,
        note: CheckerNote,
    ) {
        let still = self
            .deps
            .nodes
            .pending_permission(&project.machine_id, thread_id)
            .await
            .is_some_and(|p| p.request_id == prompt.request_id);
        if !still {
            return;
        }
        match note.verdict {
            CheckerVerdict::Go => {
                self.go(
                    project,
                    thread_id,
                    prompt,
                    &action,
                    AutoApprovedBy::Checker,
                    Some(note.reason.as_str()),
                )
                .await
            }
            CheckerVerdict::Ask => {
                self.file(project, thread_id, prompt, action, Some(note))
                    .await
            }
            CheckerVerdict::Block => {
                let why = format!(
                    "Blocked by fleetd's approval checker: {} The person was told, and can approve it anyway; don't \
                     try it another way. If they approve it, call it again with exactly the same input.",
                    note.reason.as_str().trim_end_matches('.').to_owned() + "."
                );
                let deny = PermissionDecision::Deny {
                    message: fleetd_contracts::prim::Text::unchecked(clip(&why, 2000)),
                };
                if self
                    .answer_by_rule(&project.machine_id, thread_id, prompt, deny)
                    .await
                {
                    self.file(project, thread_id, prompt, action, Some(note))
                        .await;
                }
            }
        }
    }

    /// Whether the person approved exactly this call anyway after the checker blocked it, and it hasn't run since: it
    /// runs now, once.
    async fn approved_anyway(&self, project: &ProjectRef, action: &Action) -> bool {
        let approved = self
            .deps
            .requests
            .list(&RequestFilter {
                states: Some(vec![RequestState::Approved]),
                kind: Some(RequestKind::Approval),
                limit: i64::MAX,
                ..Default::default()
            })
            .unwrap_or_default();
        let Some(r) = approved.into_iter().find(|r| {
            project_of(r) == *project
                && r.permission.as_ref().is_some_and(|p| {
                    blocked(p)
                        && p.tool_name.as_str() == action.tool
                        && p.input.as_ref() == Some(&action.input)
                })
        }) else {
            return false;
        };
        let at = self.now();
        self.change_from(&r.request_id, RequestState::Approved, |r| {
            r.state = RequestState::Ran;
            r.evidence = Some(fleetd_contracts::prim::Text::unchecked(
                "ran: the Navi asked again with exactly the input approved",
            ));
            r.finished_at = Some(fleetd_contracts::ids::Timestamp(at));
        })
        .await
        .is_ok()
    }

    /// Opens the approval a person answers: the tool, exactly what it runs with, and the checker's word when it had one.
    async fn file(
        &self,
        project: &ProjectRef,
        thread_id: &str,
        prompt: &PendingPermission,
        action: Action,
        checker: Option<CheckerNote>,
    ) {
        let (tool, summary) = (prompt.tool_name.as_str(), prompt.summary.as_str());
        let Action {
            input,
            preview,
            site,
            ..
        } = action;
        // A confirm step's screenshot shows on its card once it is the Navi's own image (`chat_image`).
        let screenshot = match input.get("screenshot").and_then(Value::as_str) {
            Some(id) if tool == confirm::TOOL => {
                match fleetd_contracts::mcp::AttachmentId::new(id) {
                    Ok(id) if self.deps.hub.navi_image(project, &id).await => Some(id),
                    _ => None,
                }
            }
            _ => None,
        };
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
                    preview: preview.map(Box::new),
                    // What approving runs: the prompt's input.
                    input: prompt.input.as_ref().map(|_| input.clone()),
                    site,
                    checker,
                    screenshot,
                }),
                preview_config: None,
                purchase: None,
                secure_input: None,
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
            // A blocked prompt's card was refused on its node already: no prompt of a run waits on it.
            .filter(|r| r.permission.as_ref().is_some_and(|p| !blocked(p)))
            .collect()
    }

    /// Waits until no checker runs: the tests' way to see a verdict land.
    #[cfg(test)]
    pub(super) async fn checks_done(&self) {
        loop {
            let idle = self.idle.notified();
            if self.checking.lock().unwrap().is_empty() {
                return;
            }
            idle.await;
        }
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
        // Its prompt was refused already: approved anyway, the Navi hears so and runs exactly this input once when it
        // asks again; kept blocked, nothing changes.
        if blocked(p) {
            if allow
                && let Ok(approved) = self
                    .note(
                        &r.request_id,
                        "approved anyway: call it again with exactly the same input, and it runs once",
                    )
                    .await
            {
                self.deps.hub.wake_request(&approved).await;
            }
            return;
        }
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
