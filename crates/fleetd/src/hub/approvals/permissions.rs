//! Tool prompts as approvals. A session's permission prompt reaches the hub as a `thread.waiting` event carrying
//! `data.permission`. A project tool rule that matches answers it at once. Otherwise it becomes an approval request
//! a person answers in the project's chat, and the answer goes to the node as `session_call answer`.
//! `thread_answer` answers it directly. A prompt that stays open is raised again as attention, so an
//! approval-required run never waits silently.
use super::store::{NewRequest, RequestFilter};
use super::{
    ApprovalRefused, Approvals, Caller, NodeCommandError, contract_project, project_of, refuse,
};
use crate::hub::prompts::fixed::{DenyReason, denied};
use crate::hub::usage::ports::{HubEvent, NewEvent, ProjectRef, WaitInput};
use crate::hub::usage::time::{clip, iso, parse_ms, system_ms};
use fleetd_contracts::chat::ChatRequestId;
use fleetd_contracts::ledger::{HumanRequest, RequestKind, RequestState, ToolPermission};
use fleetd_contracts::sessions::{PendingPermission, PermissionDecision};
use fleetd_contracts::tasks::POLICY_FILE_PATH;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A prompt still open this long after its request was filed is raised again as attention, then every REMIND_EVERY_MS.
pub const REMIND_AFTER_MS: i64 = 10 * 60_000;
pub const REMIND_EVERY_MS: i64 = 30 * 60_000;
const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// Events that change whether a thread's prompt is still open.
const THREAD_EVENTS: [&str; 6] = [
    "thread.waiting",
    "thread.started",
    "thread.completed",
    "thread.failed",
    "thread.interrupted",
    "thread.usage_limited",
];

/// `tools.allow` and `tools.deny` from the project's policy file, in claude's rule syntax.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ToolRules {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict<'a> {
    Allow(&'a str),
    Deny(&'a str),
    /// No rule decides it: a person does.
    Ask,
}

/// How the hub answers a prompt from the project's rules. A deny rule wins over an allow rule. claude applies the same
/// rules itself (`--allowedTools` / `--disallowedTools`), so the hub is only a backstop for rules changed after the
/// session started. It therefore reads conservatively: whole tools, MCP servers and Bash command patterns. An allow
/// rule never covers a compound shell command. A rule it cannot read never allows; a person answers instead.
pub fn verdict<'a>(rules: &'a ToolRules, tool: &str, summary: &str) -> Verdict<'a> {
    if let Some(rule) = rules.deny.iter().find(|r| denies(r, tool, summary)) {
        return Verdict::Deny(rule);
    }
    if let Some(rule) = rules.allow.iter().find(|r| allows(r, tool, summary)) {
        return Verdict::Allow(rule);
    }
    Verdict::Ask
}

/// `Bash(npm test:*)` -> ("Bash", Some("npm test:*")).
fn split_rule(rule: &str) -> (&str, Option<&str>) {
    let rule = rule.trim();
    match rule.find('(') {
        Some(i) if rule.ends_with(')') => (&rule[..i], Some(&rule[i + 1..rule.len() - 1])),
        _ => (rule, None),
    }
}

/// `mcp__github` names every tool of that server, as does `mcp__github__*`.
fn names_tool(name: &str, tool: &str) -> bool {
    if name == tool {
        return true;
    }
    if !name.starts_with("mcp__") {
        return false;
    }
    match name.strip_suffix('*') {
        Some(prefix) => tool.starts_with(prefix),
        None => tool
            .strip_prefix(name)
            .is_some_and(|rest| rest.starts_with("__")),
    }
}

/// Shell syntax that chains or redirects, so a pattern for its first word says nothing about the rest.
fn is_compound(command: &str) -> bool {
    command.contains(['&', '|', ';', '\n', '`', '>', '<']) || command.contains("$(")
}

/// `npm test:*` is a prefix ending at a word boundary; otherwise `*` matches any run of characters.
fn command_matches(spec: &str, command: &str) -> bool {
    let command = command.trim();
    match spec.strip_suffix(":*") {
        Some(prefix) => {
            command == prefix
                || command
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with(char::is_whitespace))
        }
        None => glob(spec, command),
    }
}

fn glob(pattern: &str, text: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    // matches[j]: pattern[..i] matches text[..j].
    let mut matches = vec![false; t.len() + 1];
    matches[0] = true;
    for &pc in &p {
        let mut next = vec![false; t.len() + 1];
        if pc == '*' {
            let mut any = false;
            for j in 0..=t.len() {
                any |= matches[j];
                next[j] = any;
            }
        } else {
            for j in 1..=t.len() {
                next[j] = matches[j - 1] && t[j - 1] == pc;
            }
        }
        matches = next;
    }
    matches[t.len()]
}

fn allows(rule: &str, tool: &str, summary: &str) -> bool {
    let (name, spec) = split_rule(rule);
    if !names_tool(name, tool) {
        return false;
    }
    match spec {
        None => true,
        Some(spec) if tool == "Bash" => !is_compound(summary) && command_matches(spec, summary),
        // Path and domain rules are relative to things the hub does not see (the settings file, the cwd).
        Some(_) => false,
    }
}

fn denies(rule: &str, tool: &str, summary: &str) -> bool {
    let (name, spec) = split_rule(rule);
    if !names_tool(name, tool) {
        return false;
    }
    match spec {
        None => true,
        // Any part of a chained command that the rule names refuses the whole command.
        Some(spec) if tool == "Bash" => {
            command_matches(spec, summary)
                || summary
                    .split(['&', '|', ';', '\n'])
                    .any(|part| command_matches(spec, part))
        }
        Some(spec) => spec == summary.trim(),
    }
}

/// Whether an open prompt filed at `filed_ms` is raised again now, given when it was last raised.
pub fn reminder_due(filed_ms: i64, now_ms: i64, last_reminded_ms: Option<i64>) -> bool {
    match last_reminded_ms {
        None => now_ms - filed_ms >= REMIND_AFTER_MS,
        Some(at) => now_ms - at >= REMIND_EVERY_MS,
    }
}

/// An open tool prompt approval.
#[derive(Clone, Debug)]
struct OpenPrompt {
    id: ChatRequestId,
    project: ProjectRef,
    thread_id: String,
    request_id: String,
    tool_name: String,
    summary: String,
    filed_ms: i64,
}

impl OpenPrompt {
    fn of(r: &HumanRequest) -> Option<Self> {
        let p = r.permission.as_ref()?;
        Some(Self {
            id: r.request_id.clone(),
            project: project_of(r),
            thread_id: p.thread_id.to_string(),
            request_id: p.request_id.to_string(),
            tool_name: p.tool_name.to_string(),
            summary: p.summary.to_string(),
            filed_ms: parse_ms(r.created_at.as_str()).unwrap_or(0),
        })
    }

    fn is_on(&self, machine_id: &str, thread_id: &str) -> bool {
        self.project.machine_id == machine_id && self.thread_id == thread_id
    }
}

/// A prompt the hub saw open and nobody has answered yet. It is kept apart from its request, which a lead may withdraw
/// or the hub may fail to file: as long as the prompt waits, the hub answers or reminds.
#[derive(Clone, Debug)]
struct Tracked {
    id: Option<ChatRequestId>,
    project: ProjectRef,
    thread_id: String,
    request_id: String,
    tool_name: String,
    summary: String,
    since_ms: i64,
    last_reminded_ms: Option<i64>,
    /// Sweeps in a row that found the machine in sync and this prompt no longer open on it.
    gone_sweeps: u8,
}

type PromptKey = (String, String, String);

#[derive(Default)]
pub(super) struct Prompts(Mutex<HashMap<PromptKey, Tracked>>);

impl Prompts {
    fn track(&self, t: Tracked) {
        let key = (
            t.project.machine_id.clone(),
            t.thread_id.clone(),
            t.request_id.clone(),
        );
        self.0.lock().unwrap().entry(key).or_insert(t);
    }
    fn forget(&self, machine_id: &str, thread_id: &str, request_id: &str) {
        let key = (
            machine_id.to_string(),
            thread_id.to_string(),
            request_id.to_string(),
        );
        self.0.lock().unwrap().remove(&key);
    }
    /// Forgets the thread's prompts other than `keep`.
    fn forget_thread(&self, machine_id: &str, thread_id: &str, keep: Option<&str>) {
        self.0.lock().unwrap().retain(|(m, t, r), _| {
            !(m == machine_id && t == thread_id && keep != Some(r.as_str()))
        });
    }
    /// Counts one more sweep that found the prompt gone (or resets the count); returns the count.
    fn gone(&self, t: &Tracked, gone: bool) -> u8 {
        let key = (
            t.project.machine_id.clone(),
            t.thread_id.clone(),
            t.request_id.clone(),
        );
        let mut map = self.0.lock().unwrap();
        let Some(entry) = map.get_mut(&key) else {
            return 0;
        };
        entry.gone_sweeps = if gone {
            entry.gone_sweeps.saturating_add(1)
        } else {
            0
        };
        entry.gone_sweeps
    }
    fn reminded(&self, t: &Tracked, at: i64) {
        let key = (
            t.project.machine_id.clone(),
            t.thread_id.clone(),
            t.request_id.clone(),
        );
        if let Some(entry) = self.0.lock().unwrap().get_mut(&key) {
            entry.last_reminded_ms = Some(at);
        }
    }
    fn all(&self) -> Vec<Tracked> {
        self.0.lock().unwrap().values().cloned().collect()
    }
    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

impl Tracked {
    fn of(o: OpenPrompt) -> Self {
        Self {
            id: Some(o.id),
            project: o.project,
            thread_id: o.thread_id,
            request_id: o.request_id,
            tool_name: o.tool_name,
            summary: o.summary,
            since_ms: o.filed_ms,
            last_reminded_ms: None,
            gone_sweeps: 0,
        }
    }
}

/// `thread_answer`'s call, decoded.
#[derive(Clone, Debug)]
pub struct ThreadAnswer {
    pub machine_id: String,
    pub thread_id: String,
    pub request_id: Option<String>,
    pub allow: bool,
    pub message: Option<String>,
}

fn refused_by_node(e: NodeCommandError, machine_id: &str) -> ApprovalRefused {
    let (code, fix) = match e.reason.as_str() {
        "offline" => (
            "machine_offline",
            format!("Try again when {machine_id} is online."),
        ),
        "not_found" => (
            "not_found",
            "Read the thread with thread_tail: the prompt may be answered or its run ended.".into(),
        ),
        _ => (
            "failed",
            "Retry; if it keeps failing, check the machine with fleetd_status.".into(),
        ),
    };
    ApprovalRefused {
        code: code.into(),
        message: e.message,
        fix: Some(e.fix.unwrap_or(fix)),
    }
}

/// Who decided, for the time inspector: `human:<name>` is a person, anyone else the lead agent.
fn decided_by(by: &str) -> Option<fleetd_contracts::time::DecidedBy> {
    use fleetd_contracts::time::DecidedBy;
    Some(if by.starts_with("human") {
        DecidedBy::Human
    } else {
        DecidedBy::Lead
    })
}

fn answered_by(caller: &Caller<'_>) -> String {
    let kind = if caller.human { "human" } else { "agent" };
    format!("{kind}:{}", caller.name)
}

impl Approvals {
    fn prompt_requests(&self, states: Vec<RequestState>) -> Vec<HumanRequest> {
        self.deps
            .requests
            .list(&RequestFilter {
                states: Some(states),
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

    async fn open_prompts(&self) -> Vec<OpenPrompt> {
        self.prompt_requests(vec![RequestState::Open])
            .iter()
            .filter_map(OpenPrompt::of)
            .collect()
    }

    /// Closes a prompt's open request nobody needs to answer any more (the prompt went away): denied, with why.
    async fn close_prompt(&self, id: &ChatRequestId, why: &str) {
        let at = self.now();
        let why = why.to_string();
        if let Err(e) = self
            .change_from(id, RequestState::Open, |r| {
                r.state = RequestState::Denied;
                r.evidence = Some(fleetd_contracts::prim::Text::unchecked(why));
                r.answered_at = Some(fleetd_contracts::ids::Timestamp(at));
                r.answered_by = Some("hub".into());
            })
            .await
        {
            tracing::warn!(request = %id, error = e.message, "approvals: stale prompt request not closed");
        }
    }

    /// Follows thread events from the head: files or auto-answers new prompts and closes requests whose prompt is gone.
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
        let (Some(machine_id), Some(thread_id)) = (&event.machine_id, &event.thread_id) else {
            return;
        };
        let data = event.data.clone().unwrap_or(Value::Null);
        if data.get("reminder").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let waiting = event.kind == "thread.waiting";
        let current: Option<PendingPermission> = data
            .get("permission")
            .and_then(|p| serde_json::from_value(p.clone()).ok());
        if waiting && current.is_none() {
            return;
        }
        let why = if waiting || event.kind == "thread.started" {
            "closed: the prompt was answered elsewhere"
        } else {
            "expired: the run ended"
        };
        self.prompts.forget_thread(
            machine_id,
            thread_id,
            current.as_ref().map(|c| c.request_id.as_str()),
        );
        let mut filed = false;
        for open in self.open_prompts().await {
            if !open.is_on(machine_id, thread_id) {
                continue;
            }
            if current
                .as_ref()
                .is_some_and(|c| c.request_id.as_str() == open.request_id)
            {
                filed = true;
                self.prompts.track(Tracked::of(open));
            } else {
                self.close_prompt(&open.id, why).await;
            }
        }
        let (Some(prompt), Some(project_id), false) = (current, &event.project_id, filed) else {
            return;
        };
        let project = ProjectRef {
            machine_id: machine_id.clone(),
            project_id: project_id.clone(),
        };
        self.raise(&project, thread_id, &prompt).await;
    }

    /// Answers a new prompt from the project's rules, or opens the approval a person answers.
    async fn raise(&self, project: &ProjectRef, thread_id: &str, prompt: &PendingPermission) {
        let (tool, summary) = (prompt.tool_name.as_str(), prompt.summary.as_str());
        let auto = match self.deps.hub.tool_rules(project).await {
            Ok(rules) => match verdict(&rules, tool, summary) {
                Verdict::Allow(_) => Some(PermissionDecision::Allow {
                    updated_input: None,
                }),
                Verdict::Deny(rule) => Some(PermissionDecision::Deny {
                    message: fleetd_contracts::prim::Text::unchecked(clip(
                        &denied(&DenyReason::Policy {
                            rule,
                            file: POLICY_FILE_PATH,
                        }),
                        2000,
                    )),
                }),
                Verdict::Ask => None,
            },
            // A broken or unreadable policy never answers for a person.
            Err(e) => {
                tracing::warn!(error = e, "approvals: tool rules not read; asking a person");
                None
            }
        };
        if let Some(decision) = auto {
            match self
                .deps
                .nodes
                .answer_permission(
                    &project.machine_id,
                    thread_id,
                    prompt.request_id.as_str(),
                    decision,
                    Some(fleetd_contracts::time::DecidedBy::HubRule),
                )
                .await
            {
                Ok(()) => return,
                Err(e) => {
                    tracing::warn!(
                        error = e.message,
                        "approvals: rule answer not delivered; asking a person"
                    )
                }
            }
        }
        let machine = &project.machine_id;
        let now = system_ms(self.deps.clock.now());
        let created = self
            .create(NewRequest {
                project_ref: contract_project(project),
                workstream_id: None,
                kind: RequestKind::Approval,
                text: clip(&format!("{machine}/{thread_id}: {tool} {summary}"), 500),
                secret: None,
                gated: None,
                permission: Some(ToolPermission {
                    thread_id: fleetd_contracts::ids::ThreadId::unchecked(thread_id),
                    request_id: prompt.request_id.clone(),
                    tool_name: prompt.tool_name.clone(),
                    summary: prompt.summary.clone(),
                }),
                at: fleetd_contracts::ids::Timestamp(iso(now)),
                at_ms: now,
            })
            .await;
        self.prompts.track(Tracked {
            id: created.as_ref().ok().map(|r| r.request_id.clone()),
            project: project.clone(),
            thread_id: thread_id.to_string(),
            request_id: prompt.request_id.to_string(),
            tool_name: tool.to_string(),
            summary: summary.to_string(),
            since_ms: now,
            last_reminded_ms: None,
            gone_sweeps: 0,
        });
        if let Err(e) = created {
            // The run still waits: say so loudly rather than leave it silent.
            tracing::error!(
                error = e.message,
                "approvals: tool prompt request not opened"
            );
            let summary = format!(
                "{machine}/{thread_id} waits for permission to run {tool} {summary}, and the hub could not open its request ({}): answer it with thread_answer",
                e.message
            );
            self.attention(project, thread_id, prompt, None, summary, 0)
                .await;
        }
    }

    async fn attention(
        &self,
        project: &ProjectRef,
        thread_id: &str,
        prompt: &PendingPermission,
        id: Option<&ChatRequestId>,
        summary: String,
        waiting_sec: i64,
    ) {
        let mut data = json!({
            "status": "waiting",
            "permission": { "requestId": prompt.request_id, "toolName": prompt.tool_name, "summary": prompt.summary },
            "reminder": true,
            "waitingSec": waiting_sec,
        });
        if let Some(id) = id {
            data["requestId"] = json!(id);
        }
        self.deps
            .events
            .append(NewEvent {
                at: self.now(),
                kind: "thread.waiting".into(),
                machine_id: Some(project.machine_id.clone()),
                project_id: Some(project.project_id.clone()),
                thread_id: Some(thread_id.to_string()),
                summary: clip(&summary, 200),
                data: Some(data),
                attention: Some("loud".into()),
            })
            .await;
    }

    /// Puts back what a hub restart dropped: every open tool prompt request, and every answered one with no record
    /// that its answer reached the node.
    pub(super) async fn seed_prompts(&self) {
        for o in self.open_prompts().await {
            self.prompts.track(Tracked::of(o));
        }
        for r in self.prompt_requests(vec![RequestState::Approved, RequestState::Denied]) {
            // Evidence is written once the answer reached the node, or by the hub closing it.
            if r.evidence.is_some() || r.answered_by.as_deref() == Some("hub") {
                continue;
            }
            if let Some(o) = OpenPrompt::of(&r) {
                self.prompts.track(Tracked::of(o));
            }
        }
    }

    /// Every minute: answers prompts whose request was answered without delivery, and raises the rest
    /// again once they have waited REMIND_AFTER_MS, then every REMIND_EVERY_MS.
    pub(super) async fn watch_prompts(self: Arc<Self>) {
        self.seed_prompts().await;
        loop {
            self.deps.clock.sleep(SWEEP_EVERY).await;
            self.sweep_prompts(system_ms(self.deps.clock.now())).await;
        }
    }

    pub(super) async fn sweep_prompts(&self, now: i64) {
        for t in self.prompts.all() {
            if self.ended_unseen(&t).await {
                continue;
            }
            let request = t.id.as_ref().and_then(|id| self.get(id.as_str()));
            let state = request.as_ref().map(|r| r.state);
            if let Some(r) = &request
                && state != Some(RequestState::Open)
            {
                // Answered (or withdrawn) and not yet delivered: deliver it now; until it reaches the node, the
                // prompt is still reminded about below.
                if r.evidence.is_none() && self.answer_prompt(r, None).await {
                    continue;
                }
                if r.evidence.is_some() {
                    continue;
                }
            }
            if !reminder_due(t.since_ms, now, t.last_reminded_ms) {
                continue;
            }
            self.prompts.reminded(&t, now);
            let minutes = (now - t.since_ms) / 60_000;
            let ask_part =
                t.id.as_ref()
                    .map_or_else(|| "no request".to_string(), ChatRequestId::to_string);
            let how = if state == Some(RequestState::Open) {
                "approve or deny it in the project's chat"
            } else {
                "answer it with thread_answer"
            };
            let summary = format!(
                "{ask_part}: {}/{} has waited {minutes} min for permission to run {} {}; {how}",
                t.project.machine_id, t.thread_id, t.tool_name, t.summary
            );
            let prompt = PendingPermission {
                request_id: fleetd_contracts::prim::NonEmpty::unchecked(t.request_id.clone()),
                tool_name: fleetd_contracts::prim::NonEmpty::unchecked(t.tool_name.clone()),
                summary: fleetd_contracts::prim::Text::unchecked(t.summary.clone()),
            };
            self.attention(
                &t.project,
                &t.thread_id,
                &prompt,
                t.id.as_ref(),
                summary,
                (now - t.since_ms) / 1000,
            )
            .await;
        }
    }

    /// A prompt whose run ended while the hub was down never gets its terminal event. The machine's own state is the
    /// check: two sweeps in a row with the machine linked and the prompt not open there close it and its request quietly.
    /// Two, because a node just linked may not have sent its snapshot yet.
    async fn ended_unseen(&self, t: &Tracked) -> bool {
        let machine = &t.project.machine_id;
        let gone = self.deps.nodes.is_linked(machine).await
            && self
                .deps
                .nodes
                .pending_permission(machine, &t.thread_id)
                .await
                .is_none_or(|p| p.request_id.as_str() != t.request_id);
        if self.prompts.gone(t, gone) < 2 {
            return false;
        }
        self.prompts.forget(machine, &t.thread_id, &t.request_id);
        const WHY: &str = "expired: the run ended while the hub was down";
        let Some(id) = &t.id else {
            return true;
        };
        match self.get(id.as_str()) {
            Some(r) if r.state == RequestState::Open => self.close_prompt(id, WHY).await,
            Some(_) => {
                let _ = self.note(id, WHY).await;
            }
            None => {}
        }
        true
    }

    /// A tool prompt's request was answered: approved allows the tool; denied (by a person, or withdrawn by the lead)
    /// denies it, saying who. True once the prompt is settled: answered on the node, or gone from it.
    pub(super) async fn answer_prompt(&self, r: &HumanRequest, said: Option<&str>) -> bool {
        let Some(open) = OpenPrompt::of(r) else {
            return true;
        };
        let by = r.answered_by.clone().unwrap_or_else(|| "a person".into());
        let machine = &open.project.machine_id;
        let allow = r.state == RequestState::Approved;
        let decision = if allow {
            PermissionDecision::Allow {
                updated_input: None,
            }
        } else {
            let request = open.id.as_str();
            let reason = if by.starts_with("lead") {
                DenyReason::Withdrawn { by: &by, request }
            } else {
                DenyReason::Human {
                    by: &by,
                    request,
                    said,
                }
            };
            PermissionDecision::Deny {
                message: fleetd_contracts::prim::Text::unchecked(clip(&denied(&reason), 2000)),
            }
        };
        let sent = self
            .deps
            .nodes
            .answer_permission(
                machine,
                &open.thread_id,
                &open.request_id,
                decision,
                decided_by(&by),
            )
            .await;
        let verb = if allow { "allowed" } else { "denied" };
        let evidence = match sent {
            Ok(()) => format!("{verb} on {machine}, answered by {by}"),
            Err(e) => {
                let still_open = self
                    .deps
                    .nodes
                    .pending_permission(machine, &open.thread_id)
                    .await
                    .is_some_and(|p| p.request_id.as_str() == open.request_id);
                if (still_open || e.reason == "offline") && allow {
                    // The run still waits on it: back to the person, who answers again once the node takes it.
                    let why = format!(
                        "not delivered: {}; approve it again once {machine} is online",
                        e.message
                    );
                    let _ = self.reopen(&open.id, &why).await;
                    self.prompts
                        .forget(machine, &open.thread_id, &open.request_id);
                    self.prompts.track(Tracked::of(open.clone()));
                    return false;
                }
                if still_open || e.reason == "offline" {
                    // A deny that did not land yet: the sweep tries again.
                    return false;
                }
                format!("expired: the prompt was no longer open on {machine}")
            }
        };
        self.prompts
            .forget(machine, &open.thread_id, &open.request_id);
        if let Ok(done) = self.note(&open.id, &evidence).await
            && allow
        {
            self.deps.hub.wake_request(&done).await;
        }
        true
    }

    /// `thread_answer`: answers the prompt a thread's run waits on, and closes its request if one is open.
    pub async fn answer_thread(
        &self,
        caller: &Caller<'_>,
        input: ThreadAnswer,
    ) -> Result<Value, ApprovalRefused> {
        let (m, t) = (input.machine_id.as_str(), input.thread_id.as_str());
        if !(caller.allows_operate)(m) {
            return Err(refuse(
                "forbidden",
                format!("This key has no operate grant on machine {m}."),
                Some("Use a key with an operate grant there."),
            ));
        }
        let Some(project) = self.deps.hub.thread_project(m, t).await else {
            return Err(refuse(
                "not_found",
                format!("No thread {t} on {m}."),
                Some("Use the machineId and threadId from the thread.waiting event."),
            ));
        };
        if !caller.human && self.deps.hub.lead_thread(&project).await.as_deref() == Some(t) {
            return Err(refuse(
                "forbidden",
                "A lead's own permission prompt goes to a person: a lead never approves itself.",
                Some("A person approves or denies it in the project's chat in the fleetd app."),
            ));
        }
        let Some(pending) = self.deps.nodes.pending_permission(m, t).await else {
            return Err(refuse(
                "not_found",
                format!("{t} on {m} waits on no permission prompt."),
                Some("Read it with thread_tail: the prompt may be answered or its run ended."),
            ));
        };
        if let Some(asked) = &input.request_id
            && asked != pending.request_id.as_str()
        {
            return Err(refuse(
                "not_found",
                format!(
                    "Prompt {asked} on {t} is no longer open; it waits on {} ({} {}) now.",
                    pending.request_id.as_str(),
                    pending.tool_name.as_str(),
                    clip(pending.summary.as_str(), 300)
                ),
                Some("Answer that one, or leave out requestId."),
            ));
        }
        let by = answered_by(caller);
        let decision = if input.allow {
            PermissionDecision::Allow {
                updated_input: None,
            }
        } else {
            let message = input
                .message
                .unwrap_or_else(|| denied(&DenyReason::Answer { by: &by }));
            PermissionDecision::Deny {
                message: fleetd_contracts::prim::Text::unchecked(clip(&message, 2000)),
            }
        };
        let request_id = pending.request_id.as_str().to_string();
        self.deps
            .nodes
            .answer_permission(m, t, &request_id, decision, decided_by(&by))
            .await
            .map_err(|e| refused_by_node(e, m))?;
        self.prompts.forget(m, t, &request_id);
        let verb = if input.allow { "allowed" } else { "denied" };
        let request = self
            .open_prompts()
            .await
            .into_iter()
            .find(|o| o.is_on(m, t) && o.request_id == request_id)
            .map(|o| o.id);
        if let Some(id) = &request {
            let at = self.now();
            let (by, evidence) = (
                by.clone(),
                format!("{verb} on {m} with thread_answer by {by}"),
            );
            let allow = input.allow;
            if let Err(e) = self
                .change_from(id, RequestState::Open, |r| {
                    r.state = if allow {
                        RequestState::Approved
                    } else {
                        RequestState::Denied
                    };
                    r.evidence = Some(fleetd_contracts::prim::Text::unchecked(evidence));
                    r.answered_at = Some(fleetd_contracts::ids::Timestamp(at));
                    r.answered_by = Some(by);
                })
                .await
            {
                tracing::warn!(request = %id, error = e.message, "approvals: answered prompt's request not closed");
            }
        }
        let mut out = json!({
            "requestId": request_id,
            "decision": if input.allow { "allow" } else { "deny" },
            "next": format!("The run goes on; follow it with thread_tail on {m}/{t}."),
        });
        if let Some(id) = request {
            out["humanRequestId"] = json!(id);
        }
        Ok(out)
    }
}
