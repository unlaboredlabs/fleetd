//! The `tool_permission` ask source. A session's permission prompt reaches the hub as a `thread.waiting` event
//! carrying `data.permission`. A project tool rule that matches answers it at once. Otherwise it becomes an approve
//! ask that a person answers with "go" or "no", and the answer goes to the node as `session_call answer`.
//! `thread_answer` answers it directly. A prompt that stays open is raised again as attention, so an
//! approval-required run never waits silently.
use super::{ApprovalRefused, Approvals, Caller, NodeCommandError, project_of, refuse, s};
use crate::hub::usage::ports::{HubEvent, NewEvent, ProjectRef, WaitInput};
use crate::hub::usage::time::{clip, parse_ms, system_ms};
use fleetd_contracts::sessions::{PendingPermission, PermissionDecision};
use fleetd_contracts::tasks::POLICY_FILE_PATH;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// A prompt still open this long after its ask was filed is raised again as attention, then every REMIND_EVERY_MS.
pub const REMIND_AFTER_MS: i64 = 10 * 60_000;
pub const REMIND_EVERY_MS: i64 = 30 * 60_000;
const SWEEP_EVERY: Duration = Duration::from_secs(60);
const FILED_BY: &str = "hub:tool_permission";

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

/// An open tool_permission ask.
#[derive(Clone, Debug)]
struct OpenPrompt {
    ask_id: String,
    project: ProjectRef,
    thread_id: String,
    request_id: String,
    tool_name: String,
    summary: String,
    filed_ms: i64,
}

impl OpenPrompt {
    fn of(ask: &Value) -> Option<Self> {
        let p = ask.get("permission")?;
        Some(Self {
            ask_id: s(ask, "askId")?.to_string(),
            project: project_of(ask)?,
            thread_id: s(p, "threadId")?.to_string(),
            request_id: s(p, "requestId")?.to_string(),
            tool_name: s(p, "toolName").unwrap_or("").to_string(),
            summary: s(p, "summary").unwrap_or("").to_string(),
            filed_ms: s(ask, "createdAt").and_then(parse_ms).unwrap_or(0),
        })
    }

    fn is_on(&self, machine_id: &str, thread_id: &str) -> bool {
        self.project.machine_id == machine_id && self.thread_id == thread_id
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
            "t3_error",
            "Retry; if it keeps failing, check the machine with fleetd_status.".into(),
        ),
    };
    ApprovalRefused {
        code: code.into(),
        message: e.message,
        fix: Some(e.fix.unwrap_or(fix)),
    }
}

fn answered_by(caller: &Caller<'_>) -> String {
    let kind = if caller.human { "human" } else { "agent" };
    format!("{kind}:{}", caller.name)
}

impl Approvals {
    async fn open_prompts(&self) -> Vec<OpenPrompt> {
        self.deps
            .asks
            .list_open()
            .await
            .iter()
            .filter_map(OpenPrompt::of)
            .collect()
    }

    /// Follows thread events from the head: files or auto-answers new prompts and closes asks whose prompt is gone.
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
            } else if let Err(e) = self.deps.asks.withdraw(&open.ask_id, why).await {
                tracing::warn!(
                    ask = open.ask_id,
                    error = e.message,
                    "approvals: stale prompt ask not closed"
                );
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

    /// Answers a new prompt from the project's rules, or files the ask a person answers.
    async fn raise(&self, project: &ProjectRef, thread_id: &str, prompt: &PendingPermission) {
        let (tool, summary) = (prompt.tool_name.as_str(), prompt.summary.as_str());
        let auto = match self.deps.hub.tool_rules(project).await {
            Ok(rules) => match verdict(&rules, tool, summary) {
                Verdict::Allow(_) => Some(PermissionDecision::Allow {
                    updated_input: None,
                }),
                Verdict::Deny(rule) => Some(PermissionDecision::Deny {
                    message: fleetd_contracts::prim::Text::unchecked(clip(
                        &format!("Denied by the tools.deny rule `{rule}` in {POLICY_FILE_PATH}."),
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
        let input = json!({
            "projectRef": project,
            "kind": "approve",
            // Replaced by permission.<askId> once the ask has its id.
            "key": "permission.new",
            "class": "irreversible",
            "text": clip(&format!("{machine}/{thread_id}: {tool} {summary}"), 500),
            "permission": {
                "threadId": thread_id,
                "requestId": prompt.request_id,
                "toolName": tool,
                "summary": summary,
            },
            "blocks": clip(&format!("the run's {tool} call"), 200),
            "proceededOnRec": false,
        });
        if let Err(e) = self.deps.asks.create(input, FILED_BY).await {
            // The run still waits: say so loudly rather than leave it silent.
            tracing::error!(
                error = e.message,
                "approvals: tool_permission ask not filed"
            );
            let summary = format!(
                "{machine}/{thread_id} waits for permission to run {tool} {summary}, and the hub could not file its ask ({}): answer it with thread_answer",
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
        ask_id: Option<&str>,
        summary: String,
        waiting_sec: i64,
    ) {
        let mut data = json!({
            "status": "waiting",
            "permission": { "requestId": prompt.request_id, "toolName": prompt.tool_name, "summary": prompt.summary },
            "reminder": true,
            "waitingSec": waiting_sec,
        });
        if let Some(id) = ask_id {
            data["askId"] = json!(id);
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

    /// Raises every open prompt again once it has waited REMIND_AFTER_MS, then every REMIND_EVERY_MS.
    pub(super) async fn remind(self: Arc<Self>) {
        let mut last: HashMap<String, i64> = HashMap::new();
        loop {
            self.deps.clock.sleep(SWEEP_EVERY).await;
            let now = system_ms(self.deps.clock.now());
            let open = self.open_prompts().await;
            last.retain(|id, _| open.iter().any(|o| &o.ask_id == id));
            for o in &open {
                if !reminder_due(o.filed_ms, now, last.get(&o.ask_id).copied()) {
                    continue;
                }
                last.insert(o.ask_id.clone(), now);
                let minutes = (now - o.filed_ms) / 60_000;
                let summary = format!(
                    "{}: {}/{} has waited {minutes} min for permission to run {} {}; reply \"go\" or \"no\"",
                    o.ask_id, o.project.machine_id, o.thread_id, o.tool_name, o.summary
                );
                let prompt = PendingPermission {
                    request_id: fleetd_contracts::prim::NonEmpty::unchecked(o.request_id.clone()),
                    tool_name: fleetd_contracts::prim::NonEmpty::unchecked(o.tool_name.clone()),
                    summary: fleetd_contracts::prim::Text::unchecked(o.summary.clone()),
                };
                self.attention(
                    &o.project,
                    &o.thread_id,
                    &prompt,
                    Some(&o.ask_id),
                    summary,
                    (now - o.filed_ms) / 1000,
                )
                .await;
            }
        }
    }

    /// A person answered a tool_permission ask: "go" allows the tool, anything else denies it with their words.
    pub(super) async fn answer_from_ask(&self, ask: &Value) {
        let Some(open) = OpenPrompt::of(ask) else {
            return;
        };
        let value = ask
            .pointer("/answer/value")
            .and_then(Value::as_str)
            .unwrap_or("");
        let by = ask
            .pointer("/answer/by")
            .and_then(Value::as_str)
            .unwrap_or("a person");
        let machine = &open.project.machine_id;
        let allow = value == "go";
        let decision = if allow {
            PermissionDecision::Allow {
                updated_input: None,
            }
        } else {
            let said = if value == "no" {
                String::new()
            } else {
                format!(": {value}")
            };
            PermissionDecision::Deny {
                message: fleetd_contracts::prim::Text::unchecked(clip(
                    &format!("Denied by {by} ({}){said}", open.ask_id),
                    2000,
                )),
            }
        };
        let sent = self
            .deps
            .nodes
            .answer_permission(machine, &open.thread_id, &open.request_id, decision)
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
                if still_open || e.reason == "offline" {
                    // The run still waits on it: back to the person, who answers again once the node takes it.
                    let why = format!(
                        "not delivered: {}; answer again once {machine} is online",
                        e.message
                    );
                    let _ = self.deps.asks.reopen(&open.ask_id, &why).await;
                    return;
                }
                format!("expired: the prompt was no longer open on {machine}")
            }
        };
        let mut patch = Map::new();
        patch.insert("evidence".into(), json!(evidence));
        let done = self
            .deps
            .asks
            .update(&open.ask_id, patch)
            .await
            .unwrap_or_else(|_| ask.clone());
        // The ledger holds a "go" back for the hub to act on first; a "no" already reached the lead.
        if allow {
            self.wake_with(&done, "go".into()).await;
        }
    }

    /// `thread_answer`: answers the prompt a thread's run waits on, and closes its ask if one is open.
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
                Some("The human answers its ask (asks_list) in the fleetd app."),
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
                .unwrap_or_else(|| format!("Denied by {by} with thread_answer."));
            PermissionDecision::Deny {
                message: fleetd_contracts::prim::Text::unchecked(clip(&message, 2000)),
            }
        };
        let request_id = pending.request_id.as_str().to_string();
        self.deps
            .nodes
            .answer_permission(m, t, &request_id, decision)
            .await
            .map_err(|e| refused_by_node(e, m))?;
        let (value, verb) = if input.allow {
            ("go", "allowed")
        } else {
            ("no", "denied")
        };
        let ask_id = self
            .open_prompts()
            .await
            .into_iter()
            .find(|o| o.is_on(m, t) && o.request_id == request_id)
            .map(|o| o.ask_id);
        if let Some(id) = &ask_id {
            let mut patch = Map::new();
            patch.insert("state".into(), json!("answered"));
            patch.insert(
                "evidence".into(),
                json!(format!("{verb} on {m} with thread_answer by {by}")),
            );
            patch.insert(
                "answer".into(),
                json!({ "value": value, "by": by, "at": self.now(), "raw": "thread_answer" }),
            );
            if let Err(e) = self.deps.asks.update(id, patch).await {
                tracing::warn!(
                    ask = id,
                    error = e.message,
                    "approvals: answered prompt's ask not closed"
                );
            }
        }
        let mut out = json!({
            "requestId": request_id,
            "decision": if input.allow { "allow" } else { "deny" },
            "next": format!("The run goes on; follow it with thread_tail on {m}/{t}."),
        });
        if let Some(id) = ask_id {
            out["askId"] = json!(id);
        }
        Ok(out)
    }
}
