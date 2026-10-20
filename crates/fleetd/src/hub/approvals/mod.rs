//! Requests (`R<n>`): what a lead needs a person for that a chat can't carry safely, shown inline in the project's chat.
//! - secret (`request_secret`): the desktop app seals the value to the sink machine's box key; the hub relays the
//!   ciphertext to that node without storing it and keeps only the fingerprint the node reports.
//! - approval of a command (`gated_run`): the exact command is stored; once a person approves it, the project's node
//!   runs those bytes and the exit code and output tail go to the lead.
//! - approval of a tool prompt: a session's permission prompt, answered on its node (permissions.rs).
//!
//! Every change is announced as `request.opened` / `request.updated`; the chat shows each request as its item
//! ([`chat_item`]).
pub mod permissions;
pub mod store;
pub mod tools;

#[cfg(test)]
mod tests;

use crate::clock::Clock;
use crate::hub::usage::ports::{BoxFut, EventLog, NewEvent, ProjectRef, WaitInput};
use crate::hub::usage::time::{clip, iso, system_ms};
use fleetd_contracts::sessions::{PendingPermission, PermissionDecision};
pub use permissions::{ThreadAnswer, ToolRules};
use regex::Regex;
use serde::Serialize;
use fleetd_contracts::chat::{
    ChatItem, ChatRequestId, CommandApprovalItem, CommandApprovalState, SecretRequestItem,
    SecretRequestState,
};
use fleetd_contracts::ledger::{
    GatedRunSpec, HumanRequest, RequestKind, RequestState, SecretRequest,
};
use fleetd_contracts::lead_calls::RequestSecretCall;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use store::{NewRequest, RequestFilter, RequestStoreError, Requests};
use std::sync::{Arc, LazyLock};

/// A refusal in the tools' `{ code, message, fix }` shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ApprovalRefused {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

fn refuse(code: &str, message: impl Into<String>, fix: Option<&str>) -> ApprovalRefused {
    ApprovalRefused {
        code: code.into(),
        message: message.into(),
        fix: fix.map(str::to_string),
    }
}

const EVIDENCE_MAX: usize = 2000;
/// Evidence while an approved command runs; replaced by its result.
const RUNNING: &str = "running on";
static SINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(env|file):([a-z0-9-]{1,32}):(/.*)$").unwrap());
static PLAIN_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w./:=@%+-]+$").unwrap());
pub const NOT_RUN_AFTER_RESTART: &str =
    "not run: the hub restarted before it ran; approve it again to run it";

pub const HUMAN_ONLY_SECRET_FIX: &str = "Enter it from the fleetd desktop app or another client with a --human key; agent keys never handle secret values.";

/// Who called: a human or agent key, by name, with its grants.
pub struct Caller<'a> {
    pub human: bool,
    pub name: &'a str,
    /// `Auth::allows(caller, "operate", machine)`.
    pub allows_operate: &'a (dyn Fn(&str) -> bool + Sync),
}

/// The sink's kind and machine.
pub struct ParsedSink {
    pub kind: String,
    pub machine_id: String,
}

pub fn parse_secret_sink(sink: &str) -> Option<ParsedSink> {
    let c = SINK.captures(sink)?;
    if sink.chars().count() > 1000 {
        return None;
    }
    let path = &c[3];
    if path.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}') {
        return None;
    }
    if path[1..]
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return None;
    }
    Some(ParsedSink {
        kind: c[1].to_string(),
        machine_id: c[2].to_string(),
    })
}

/// argv as one readable line: JSON quoting only for words that need it.
pub fn shown_argv(argv: &[String]) -> String {
    argv.iter()
        .map(|w| {
            if PLAIN_WORD.is_match(w) {
                w.clone()
            } else {
                json!(w).to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Why an approved command the hub never saw finish goes back to the person after a restart: it never started, or it
/// was running and its result is unknown.
pub fn restart_reopen_reason(evidence: Option<&str>, machine_id: &str) -> String {
    if evidence.is_some_and(|e| e.starts_with(RUNNING)) {
        format!(
            "result unknown: the hub restarted while it ran on {machine_id}; check on {machine_id} whether it ran before approving it again"
        )
    } else {
        NOT_RUN_AFTER_RESTART.to_string()
    }
}

/// A node command's failure.
#[derive(Clone, Debug)]
pub struct NodeCommandError {
    /// "offline", "lost", "no_reply", "invalid", "not_found" or "failed".
    pub reason: String,
    pub message: String,
    /// The node's own fix, when it gave one.
    pub fix: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct SecretOutcome {
    pub fingerprint: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct GatedOutcome {
    pub exit_code: Option<i64>,
    pub output_tail: String,
    pub timed_out: bool,
    pub error: Option<String>,
}

/// The node link's request/reply commands.
pub trait ApprovalNodes: Send + Sync {
    /// `secret_deliver`: `{ sink, sealed, secretKey, envName? }`.
    fn deliver_secret(
        &self,
        machine_id: &str,
        input: Value,
    ) -> BoxFut<'_, Result<SecretOutcome, NodeCommandError>>;
    /// `gated_run`: `{ argv, cwd, timeoutSec, secretEnv? }`.
    fn run_gated(
        &self,
        machine_id: &str,
        input: Value,
    ) -> BoxFut<'_, Result<GatedOutcome, NodeCommandError>>;
    /// `session_call answer`: the decision for the prompt `request_id` the thread's run waits on.
    fn answer_permission(
        &self,
        machine_id: &str,
        thread_id: &str,
        request_id: &str,
        decision: PermissionDecision,
        by: Option<fleetd_contracts::time::DecidedBy>,
    ) -> BoxFut<'_, Result<(), NodeCommandError>>;
    /// The machine's node is linked and its session stream subscribed.
    fn is_linked(&self, machine_id: &str) -> BoxFut<'_, bool>;
    /// The prompt the thread's run waits on now, from the machine stream.
    fn pending_permission(
        &self,
        machine_id: &str,
        thread_id: &str,
    ) -> BoxFut<'_, Option<PendingPermission>>;
}

/// The rest of the hub approvals reads or wakes.
pub trait ApprovalHub: Send + Sync {
    /// The machine's `boxPubKey`: `None` for no machine, `Some(None)` for one that takes no secrets.
    fn box_key(&self, machine_id: &str) -> BoxFut<'_, Option<Option<String>>>;
    /// The project's workspace root; `None` when the hub has no record of it.
    fn workspace_root(&self, project: &ProjectRef) -> BoxFut<'_, Option<String>>;
    /// Wakes the project's lead with a request's outcome (`wake.request_done`).
    fn wake_request(&self, request: &HumanRequest) -> BoxFut<'_, ()>;
    /// The project policy's `tools` rules (empty without a policy file); the error says why it could not be read.
    fn tool_rules(&self, project: &ProjectRef) -> BoxFut<'_, Result<ToolRules, String>>;
    /// The project's current lead thread.
    fn lead_thread(&self, project: &ProjectRef) -> BoxFut<'_, Option<String>>;
    fn thread_project(&self, machine_id: &str, thread_id: &str) -> BoxFut<'_, Option<ProjectRef>>;
}

pub struct ApprovalsDeps {
    pub requests: Arc<Requests>,
    pub nodes: Arc<dyn ApprovalNodes>,
    pub hub: Arc<dyn ApprovalHub>,
    pub events: Arc<dyn EventLog>,
    pub clock: Arc<dyn Clock>,
}

/// `gated_run`'s call (lead-calls `GatedRunCall` without `op`).
#[derive(Clone, Debug)]
pub struct GatedRunInput {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub class: String,
    pub reason: String,
    pub secret_env: Option<Value>,
    pub timeout_sec: u64,
    pub workstream_id: Option<String>,
}

fn contract_project(p: &ProjectRef) -> fleetd_contracts::ids::ProjectRef {
    serde_json::from_value(json!({ "machineId": p.machine_id, "projectId": p.project_id }))
        .expect("a project ref reads back")
}

fn project_of(r: &HumanRequest) -> ProjectRef {
    ProjectRef {
        machine_id: r.project_ref.machine_id.to_string(),
        project_id: r.project_ref.project_id.to_string(),
    }
}

fn store_refusal(e: RequestStoreError) -> ApprovalRefused {
    match e {
        RequestStoreError::NotFound(id) => refuse(
            "not_found",
            format!("No request {id}."),
            Some("Use a requestId from the chat or requests_list."),
        ),
        RequestStoreError::Invalid(why) => refuse("invalid", why, None),
        RequestStoreError::Store(error) => {
            tracing::error!(%error, "approvals: request store failed");
            refuse("failed", "The hub failed while saving the request.", Some("Try again shortly."))
        }
    }
}

fn not_found(id: &str) -> ApprovalRefused {
    refuse(
        "not_found",
        format!("No request {id}."),
        Some("Use a requestId from the chat or requests_list."),
    )
}

/// How the chat shows a request: the record's fields, in the item's terms.
pub fn chat_item(r: &HumanRequest) -> ChatItem {
    let line = |s: &str, max: usize| -> Option<fleetd_contracts::prim::Line<1, 300>> {
        let first = clip(s.lines().next().unwrap_or(s).trim(), max);
        fleetd_contracts::prim::Line::new(first).ok()
    };
    let by = r
        .answered_by
        .as_deref()
        .and_then(|b| fleetd_contracts::prim::Line::<1, 120>::new(clip(b, 120)).ok());
    // Why it is open again, or why it ended without running.
    let note = match r.state {
        RequestState::Open | RequestState::Failed => {
            r.evidence.as_ref().and_then(|e| line(e.as_str(), 300))
        }
        _ => None,
    };
    match &r.secret {
        Some(secret) => ChatItem::SecretRequest(SecretRequestItem {
            request_id: r.request_id.clone(),
            name: fleetd_contracts::prim::Line::<1, 120>::new(clip(secret.key.as_str(), 120))
                .expect("a decision key is a line"),
            text: line(r.text.as_str(), 300)
                .unwrap_or_else(|| fleetd_contracts::prim::Line::unchecked("a secret")),
            sink: secret.sink.clone(),
            env_name: secret.env_name.clone(),
            state: match r.state {
                RequestState::Stored => SecretRequestState::Stored,
                RequestState::Withdrawn => SecretRequestState::Withdrawn,
                _ => SecretRequestState::Open,
            },
            fingerprint: secret.fingerprint.clone(),
            note,
            answered_at: r.answered_at.clone(),
            by,
        }),
        None => ChatItem::CommandApproval(CommandApprovalItem {
            request_id: r.request_id.clone(),
            machine_id: r.project_ref.machine_id.clone(),
            gated: r.gated.clone(),
            permission: r.permission.clone(),
            state: match r.state {
                RequestState::Approved => CommandApprovalState::Approved,
                RequestState::Denied => CommandApprovalState::Denied,
                RequestState::Ran => CommandApprovalState::Ran,
                RequestState::Failed => CommandApprovalState::Failed,
                _ => CommandApprovalState::Open,
            },
            exit_code: r.exit_code,
            output_tail: r.output_tail.clone(),
            note,
            answered_at: r.answered_at.clone(),
            by,
        }),
    }
}

pub struct Approvals {
    deps: ApprovalsDeps,
    /// Tool prompts still waiting on an answer, whatever became of their requests.
    prompts: permissions::Prompts,
}

impl Approvals {
    pub fn new(deps: ApprovalsDeps) -> Arc<Self> {
        Arc::new(Approvals {
            deps,
            prompts: Default::default(),
        })
    }

    /// Runs until the hub stops: approvals the hub accepted but never finished before it stopped go back to the person
    /// (never run late, never silently lost); then the threads' follower and the prompt reminders.
    pub async fn serve(self: Arc<Self>) {
        let approvals = self;
        let approved = approvals.deps.requests.list(&RequestFilter {
            states: Some(vec![RequestState::Approved]),
            kind: Some(RequestKind::Approval),
            limit: i64::MAX,
            ..Default::default()
        });
        for r in approved.unwrap_or_default() {
            // A tool prompt's answer is delivered or put back by the prompt sweep itself, never re-run.
            if r.gated.is_none() {
                continue;
            }
            let machine = r.project_ref.machine_id.to_string();
            let why = restart_reopen_reason(r.evidence.as_ref().map(|e| e.as_str()), &machine);
            let _ = approvals.reopen(&r.request_id, &why).await;
        }
        tokio::join!(
            approvals.clone().follow_threads(),
            approvals.clone().follow_removals(),
            approvals.watch_prompts(),
        );
    }

    fn now(&self) -> String {
        iso(system_ms(self.deps.clock.now()))
    }

    pub fn get(&self, id: &str) -> Option<HumanRequest> {
        self.deps.requests.get(id).ok().flatten()
    }

    pub fn list(&self, filter: &RequestFilter) -> Result<Vec<HumanRequest>, ApprovalRefused> {
        self.deps
            .requests
            .list(filter)
            .map_err(|e| store_refusal(e.into()))
    }

    async fn announce(&self, kind: &str, r: &HumanRequest) {
        let project = project_of(r);
        let what = match (&r.secret, &r.gated, &r.permission) {
            (Some(s), _, _) => format!("secret {}", s.key),
            (_, Some(g), _) => shown_argv(&g.argv.iter().cloned().collect::<Vec<_>>()),
            (_, _, Some(p)) => format!("{} {}", p.tool_name, p.summary),
            _ => String::new(),
        };
        self.deps
            .events
            .append(NewEvent {
                at: self.now(),
                kind: kind.into(),
                machine_id: Some(project.machine_id),
                project_id: Some(project.project_id),
                summary: clip(&format!("{} {}: {what}", r.request_id, r.state.as_str()), 200),
                data: Some(json!({
                    "requestId": r.request_id,
                    "kind": r.kind,
                    "state": r.state,
                    "workstreamId": r.workstream_id,
                    "by": r.answered_by,
                })),
                attention: crate::hub::attention::request_attention(r).map(|a| {
                    serde_json::to_value(a)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default()
                }),
                ..Default::default()
            })
            .await;
    }

    async fn create(&self, new: NewRequest) -> Result<HumanRequest, ApprovalRefused> {
        let r = self.deps.requests.create(new).map_err(store_refusal)?;
        self.announce("request.opened", &r).await;
        Ok(r)
    }

    /// Saves a change to a request and announces it.
    async fn change(
        &self,
        id: &ChatRequestId,
        f: impl FnOnce(&mut HumanRequest),
    ) -> Result<HumanRequest, ApprovalRefused> {
        let r = self.deps.requests.update(id, f).map_err(store_refusal)?;
        self.announce("request.updated", &r).await;
        Ok(r)
    }

    /// Back to open, with why: nothing ran, or what happened must be checked before it is approved again.
    async fn reopen(&self, id: &ChatRequestId, why: &str) -> Result<HumanRequest, ApprovalRefused> {
        let why = clip(why, EVIDENCE_MAX);
        self.change(id, |r| {
            r.state = RequestState::Open;
            r.evidence = Some(fleetd_contracts::prim::Text::unchecked(why));
            r.answered_at = None;
            r.answered_by = None;
        })
        .await
    }

    /// Records `evidence` on a request.
    async fn note(&self, id: &ChatRequestId, evidence: &str) -> Result<HumanRequest, ApprovalRefused> {
        let evidence = clip(evidence, EVIDENCE_MAX);
        self.change(id, |r| {
            r.evidence = Some(fleetd_contracts::prim::Text::unchecked(evidence));
        })
        .await
    }

    /// `request_secret`: a secret the person enters in the project's chat. Returns the open request.
    pub async fn request_secret(
        &self,
        project: &ProjectRef,
        call: RequestSecretCall,
    ) -> Result<HumanRequest, ApprovalRefused> {
        let Some(sink) = parse_secret_sink(call.sink.as_str()) else {
            return Err(refuse(
                "invalid",
                format!("{} is not a sink fleetd can write.", call.sink.as_str()),
                Some("Use env:<machine>:<absolute path> or file:<machine>:<absolute path>."),
            ));
        };
        if self.deps.hub.box_key(&sink.machine_id).await.is_none() {
            return Err(refuse(
                "not_found",
                format!("No machine {}.", sink.machine_id),
                Some("Name a machine from fleetd_status in the sink."),
            ));
        }
        let now = system_ms(self.deps.clock.now());
        self.create(NewRequest {
            project_ref: contract_project(project),
            workstream_id: call.workstream_id.clone(),
            kind: RequestKind::Secret,
            text: call.text.to_string(),
            secret: Some(SecretRequest {
                key: call.key.clone(),
                sink: call.sink.clone(),
                env_name: call.env_name.clone(),
                fingerprint: None,
            }),
            gated: None,
            permission: None,
            at: fleetd_contracts::ids::Timestamp(iso(now)),
            at_ms: now,
        })
        .await
    }

    /// `secret_submit`: relays the sealed value to the sink's node and stores the request with the node's fingerprint.
    pub async fn submit_secret(
        &self,
        caller: &Caller<'_>,
        request_id: &str,
        sealed: &str,
    ) -> Result<Value, ApprovalRefused> {
        if !caller.human {
            return Err(refuse(
                "forbidden",
                "Only a person enters secrets.",
                Some(HUMAN_ONLY_SECRET_FIX),
            ));
        }
        let Some((r, secret)) = self
            .get(request_id)
            .and_then(|r| r.secret.clone().map(|s| (r, s)))
        else {
            return Err(not_found(request_id));
        };
        let sink = parse_secret_sink(secret.sink.as_str()).ok_or_else(|| not_found(request_id))?;
        let machines: BTreeSet<&str> = [sink.machine_id.as_str(), r.project_ref.machine_id.as_str()]
            .into_iter()
            .collect();
        for m in machines {
            if !(caller.allows_operate)(m) {
                return Err(refuse(
                    "forbidden",
                    format!("This key has no operate grant on machine {m}."),
                    Some("Use a human key with an operate grant there."),
                ));
            }
        }
        let id = r.request_id.clone();
        if r.state != RequestState::Open {
            return Err(refuse(
                "invalid",
                format!("{id} is already {}.", r.state.as_str()),
                Some("Nothing to enter: it is settled."),
            ));
        }
        let m = &sink.machine_id;
        match self.deps.hub.box_key(m).await {
            None => {
                return Err(refuse(
                    "not_found",
                    format!("No machine {m}."),
                    Some("Tell the lead in chat: it asks again with a sink on a known machine."),
                ));
            }
            Some(None) => {
                return Err(refuse(
                    "invalid",
                    format!("{m}'s node takes no secrets: it publishes no box key."),
                    Some(&format!("Update fleetd on {m} and restart its node.")),
                ));
            }
            Some(Some(_)) => {}
        }
        let key = secret.key.to_string();
        let mut input = json!({ "sink": secret.sink, "sealed": sealed, "secretKey": key });
        if let Some(env) = &secret.env_name {
            input["envName"] = json!(env);
        }
        // The ciphertext is never queued: the person enters it again once the node is back.
        let delivered = self
            .deps
            .nodes
            .deliver_secret(m, input)
            .await
            .map_err(|e| {
                refuse(
                    "machine_offline",
                    format!("{m}'s node did not take the secret: {}.", e.message),
                    Some(&format!("Try again when {m} is online.")),
                )
            })?;
        let Some(fingerprint) = delivered.fingerprint else {
            return Err(refuse(
                "invalid",
                format!(
                    "{m}'s node could not save it: {}.",
                    delivered.error.as_deref().unwrap_or("no reason given")
                ),
                Some(
                    "Seal it to the machine's current boxPubKey and try again, or tell the lead in chat to fix the sink.",
                ),
            ));
        };
        let by = format!("human:{}", caller.name);
        let at = self.now();
        let print = fingerprint.clone();
        let saved = self
            .change(&id, |r| {
                r.state = RequestState::Stored;
                if let Some(s) = r.secret.as_mut() {
                    s.fingerprint = serde_json::from_value(json!(print)).ok();
                }
                r.evidence = Some(fleetd_contracts::prim::Text::unchecked(format!(
                    "fingerprint {print}"
                )));
                r.answered_at = Some(fleetd_contracts::ids::Timestamp(at));
                r.answered_by = Some(by);
            })
            .await?;
        self.deps.hub.wake_request(&saved).await;
        Ok(json!({
            "requestId": id,
            "fingerprint": fingerprint,
            "next": format!("Saved on {m}; the lead hears it in its next wake."),
        }))
    }

    /// `gated_run`: opens the approval holding exactly this command, run in the project workspace by default.
    pub async fn gated_run(
        &self,
        project: &ProjectRef,
        call: GatedRunInput,
    ) -> Result<HumanRequest, ApprovalRefused> {
        let Some(root) = self.deps.hub.workspace_root(project).await else {
            return Err(refuse(
                "not_found",
                format!(
                    "The hub has no record of project {} on {}.",
                    project.project_id, project.machine_id
                ),
                Some("Check fleetd_status, then run it again."),
            ));
        };
        // Stored resolved, so the person approves the exact directory too.
        let cwd = call.cwd.clone().unwrap_or(root);
        let mut gated = json!({ "argv": call.argv, "cwd": cwd, "class": call.class, "reason": call.reason, "timeoutSec": call.timeout_sec });
        if let Some(env) = &call.secret_env {
            gated["secretEnv"] = env.clone();
        }
        let gated: GatedRunSpec = serde_json::from_value(gated)
            .map_err(|e| refuse("invalid", format!("The command is not one fleetd can store: {e}."), None))?;
        let now = system_ms(self.deps.clock.now());
        self.create(NewRequest {
            project_ref: contract_project(project),
            workstream_id: call
                .workstream_id
                .as_deref()
                .and_then(|w| serde_json::from_value(json!(w)).ok()),
            kind: RequestKind::Approval,
            text: clip(
                &format!(
                    "Run {} on {} in {cwd}: {}",
                    shown_argv(&call.argv),
                    project.machine_id,
                    call.reason
                ),
                500,
            ),
            secret: None,
            gated: Some(gated),
            permission: None,
            at: fleetd_contracts::ids::Timestamp(iso(now)),
            at_ms: now,
        })
        .await
    }

    /// `approval_answer`: a person approves or denies an open approval. A command runs on the project's node; a tool
    /// prompt's answer goes to the waiting run.
    pub async fn answer(
        self: &Arc<Self>,
        caller: &Caller<'_>,
        request_id: &str,
        approve: bool,
        message: Option<String>,
    ) -> Result<HumanRequest, ApprovalRefused> {
        if !caller.human {
            return Err(refuse(
                "forbidden",
                "Only a person approves or denies a request.",
                Some("Answer it in the fleetd app, or with a --human key."),
            ));
        }
        let Some(r) = self
            .get(request_id)
            .filter(|r| r.kind == RequestKind::Approval)
        else {
            return Err(not_found(request_id));
        };
        let machine = r.project_ref.machine_id.to_string();
        if !(caller.allows_operate)(&machine) {
            return Err(refuse(
                "forbidden",
                format!("This key has no operate grant on machine {machine}."),
                Some("Use a human key with an operate grant there."),
            ));
        }
        if r.state != RequestState::Open {
            return Err(refuse(
                "invalid",
                format!("{} is already {}.", r.request_id, r.state.as_str()),
                Some("Nothing to answer: it is settled."),
            ));
        }
        let by = format!("human:{}", caller.name);
        let at = self.now();
        let reason = message.filter(|m| !approve && !m.trim().is_empty());
        let answered = self
            .change(&r.request_id, |r| {
                r.state = if approve {
                    RequestState::Approved
                } else {
                    RequestState::Denied
                };
                // A command's denial reason goes to the lead with it. A tool prompt's goes to the run itself (below);
                // its evidence stays empty until the answer reached the node.
                r.evidence = reason
                    .clone()
                    .filter(|_| r.gated.is_some())
                    .map(|m| fleetd_contracts::prim::Text::unchecked(clip(&m, EVIDENCE_MAX)));
                r.answered_at = Some(fleetd_contracts::ids::Timestamp(at));
                r.answered_by = Some(by);
            })
            .await?;
        if answered.permission.is_some() {
            self.answer_prompt(&answered, reason.as_deref()).await;
        } else if approve {
            let me = self.clone();
            let running = answered.clone();
            tokio::spawn(async move { me.run_approved(&running).await });
        } else {
            self.deps.hub.wake_request(&answered).await;
        }
        Ok(self.get(request_id).unwrap_or(answered))
    }

    /// `request_withdraw`: the lead takes back an open request of its own project (the person said in chat it is not
    /// needed). A secret is withdrawn; an approval is denied, and a waiting tool prompt hears so.
    pub async fn withdraw(
        &self,
        project: &ProjectRef,
        by: &str,
        request_id: &str,
    ) -> Result<HumanRequest, ApprovalRefused> {
        let Some(r) = self.get(request_id).filter(|r| project_of(r) == *project) else {
            return Err(refuse(
                "not_found",
                format!("There is no request {request_id} in your project."),
                Some("Use a requestId your own request_secret or gated_run returned."),
            ));
        };
        if r.state != RequestState::Open {
            return Err(refuse(
                "invalid",
                format!("{} is already {}.", r.request_id, r.state.as_str()),
                Some("Nothing to withdraw."),
            ));
        }
        let at = self.now();
        let by = by.to_string();
        let done = self
            .change(&r.request_id, |r| {
                r.state = match r.kind {
                    RequestKind::Secret => RequestState::Withdrawn,
                    RequestKind::Approval => RequestState::Denied,
                };
                r.evidence = Some(fleetd_contracts::prim::Text::unchecked(
                    "withdrawn by the lead".to_string(),
                ));
                r.answered_at = Some(fleetd_contracts::ids::Timestamp(at));
                r.answered_by = Some(by);
            })
            .await?;
        if done.permission.is_some() {
            self.answer_prompt(&done, None).await;
        }
        Ok(done)
    }

    /// Closes every open request of a project (or of one of its orders) nobody needs any more: secrets withdrawn,
    /// approvals denied, and a waiting tool prompt hears so. `why` is the evidence.
    pub async fn close_open(&self, project: &ProjectRef, workstream: Option<&str>, why: &str) {
        let open = self.deps.requests.list(&RequestFilter {
            project_ref: Some(contract_project(project)),
            states: Some(vec![RequestState::Open]),
            kind: None,
            limit: i64::MAX,
        });
        for r in open.unwrap_or_default() {
            if workstream.is_some_and(|w| r.workstream_id.as_ref().map(|x| x.as_str()) != Some(w)) {
                continue;
            }
            let at = self.now();
            let why = why.to_string();
            let closed = self
                .change(&r.request_id, |r| {
                    r.state = match r.kind {
                        RequestKind::Secret => RequestState::Withdrawn,
                        RequestKind::Approval => RequestState::Denied,
                    };
                    r.evidence = Some(fleetd_contracts::prim::Text::unchecked(why));
                    r.answered_at = Some(fleetd_contracts::ids::Timestamp(at));
                    r.answered_by = Some("hub".into());
                })
                .await;
            if let Ok(closed) = closed
                && closed.permission.is_some()
            {
                self.answer_prompt(&closed, None).await;
            }
        }
    }

    /// Follows `project.removed`: a removed project's open requests are closed.
    async fn follow_removals(self: Arc<Self>) {
        let mut cursor = self.deps.events.head().await;
        loop {
            let page = self
                .deps
                .events
                .wait(WaitInput {
                    cursor,
                    types: vec!["project.removed"],
                    timeout_sec: 3600,
                    ..Default::default()
                })
                .await;
            cursor = page.cursor;
            for event in page.events {
                if let (Some(machine_id), Some(project_id)) = (event.machine_id, event.project_id) {
                    let project = ProjectRef {
                        machine_id,
                        project_id,
                    };
                    self.close_open(&project, None, "the project was removed").await;
                }
            }
        }
    }

    /// Runs an approval's stored command on its project's node after a person approved it.
    async fn run_approved(&self, r: &HumanRequest) {
        let Some(spec) = &r.gated else {
            return;
        };
        let project = project_of(r);
        let id = r.request_id.clone();
        let machine = project.machine_id.clone();
        let by = r.answered_by.clone().unwrap_or_default();
        let timeout_sec = spec.timeout_sec.get();
        let cwd = match &spec.cwd {
            Some(c) => Some(c.to_string()),
            None => self.deps.hub.workspace_root(&project).await,
        };
        // Marks it in flight, so a hub restart before the result arrives is reported as "result unknown", not "not run".
        let _ = self
            .note(&id, &format!("{RUNNING} {machine}, approved by {by}"))
            .await;
        let ran = match cwd {
            None => Ok(GatedOutcome {
                error: Some("the project has no workspace on record".into()),
                ..Default::default()
            }),
            Some(cwd) => {
                let mut input = json!({ "argv": spec.argv, "cwd": cwd, "timeoutSec": timeout_sec });
                if let Some(env) = &spec.secret_env {
                    input["secretEnv"] = json!(env);
                }
                self.deps.nodes.run_gated(&machine, input).await
            }
        };
        let done = match &ran {
            Err(e) if e.reason == "offline" => {
                // Nothing ran, so the person can approve it again once the machine is back.
                self.reopen(
                    &id,
                    &format!(
                        "not run: {machine}'s node was offline when {by} approved it; approve it again once it is online"
                    ),
                )
                .await
            }
            // A link that dropped mid-run leaves the result unknown: back to the person, to check before approving again.
            Err(e) => {
                self.reopen(
                    &id,
                    &format!(
                        "result unknown: {}; check on {machine} whether it ran before approving it again",
                        e.message
                    ),
                )
                .await
            }
            Ok(GatedOutcome {
                error: Some(err), ..
            }) => {
                let why = format!("not run on {machine}: {err}");
                self.change(&id, |r| {
                    r.state = RequestState::Failed;
                    r.evidence = Some(fleetd_contracts::prim::Text::unchecked(clip(
                        &why,
                        EVIDENCE_MAX,
                    )));
                })
                .await
            }
            Ok(o) => {
                let head = if o.timed_out {
                    format!("killed after {timeout_sec} s on {machine}, approved by {by}")
                } else {
                    let code = o
                        .exit_code
                        .map_or_else(|| "none (ended by a signal)".to_string(), |c| c.to_string());
                    format!("exit {code} on {machine}, approved by {by}")
                };
                let tail = clip(o.output_tail.trim_end(), EVIDENCE_MAX);
                self.change(&id, |r| {
                    r.state = RequestState::Ran;
                    r.evidence = Some(fleetd_contracts::prim::Text::unchecked(head));
                    r.exit_code = o.exit_code;
                    r.output_tail = Some(fleetd_contracts::prim::Text::unchecked(tail));
                })
                .await
            }
        };
        if let Ok(done) = done {
            self.deps.hub.wake_request(&done).await;
        }
    }
}
