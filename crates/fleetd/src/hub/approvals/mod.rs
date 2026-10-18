//! Secrets, approvals and checklists (M8): the asks only a person answers, where the hub acts on the answer.
//! - secret: the desktop app seals the value to the sink machine's box key; the hub relays the ciphertext to that
//!   node without storing it and keeps only the fingerprint the node reports.
//! - approve: `fleetd gated run` stores the exact command; once a human answers "go", the project's node runs those
//!   bytes and the exit code and output tail go to the lead as evidence.
//! - do with verify: once ticked done, the hub runs the check; a failure reopens the ask with the evidence.
//!
//! TS spec: apps/hub/src/approvals/Approvals.ts. Asks travel as their wire JSON (`Ask` in contracts/ledger).
pub mod tools;

use crate::clock::Clock;
use crate::hub::usage::ports::{BoxFut, EventLog, NewEvent, ProjectRef, WaitInput};
use crate::hub::usage::time::{clip, iso, system_ms};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
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
/// How a recorded outcome starts: exit code, timeout, or the node's refusal.
static FINISHED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(exit |killed after |not run on )").unwrap());
static SINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(env|file):([a-z0-9-]{1,32}):(/.*)$").unwrap());
static PLAIN_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w./:=@%+-]+$").unwrap());
pub const NOT_RUN_AFTER_RESTART: &str =
    "not run: hub restarted before execution; answer again to run";

pub const HUMAN_ONLY_SECRET_FIX: &str = "Enter it from the fleetd desktop app or another client with a --human key; agent keys never handle secret values.";

/// Who called: a human or agent key, by name, with its grants.
pub struct Caller<'a> {
    pub human: bool,
    pub name: &'a str,
    /// `Auth::allows(caller, "operate", machine)`.
    pub allows_operate: &'a (dyn Fn(&str) -> bool + Sync),
}

/// The sink's kind and machine (contracts/secrets.ts `parseSecretSink`).
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

/// A header line, then as much of the output's end as fits.
fn with_tail(head: &str, tail: &str) -> String {
    let room = EVIDENCE_MAX as isize - head.chars().count() as isize - 1;
    let t = tail.trim_end();
    if t.is_empty() || room <= 0 {
        return head.chars().take(EVIDENCE_MAX).collect();
    }
    let room = room as usize;
    let n = t.chars().count();
    if n <= room {
        format!("{head}\n{t}")
    } else {
        let end: String = t.chars().skip(n - room + 1).collect();
        format!("{head}\n…{end}")
    }
}

/// Why an approval answered "go" before a hub restart goes back to the human, or `None` when it finished.
pub fn restart_reopen_reason(evidence: Option<&str>, machine_id: &str) -> Option<String> {
    let evidence = evidence.unwrap_or("");
    if FINISHED.is_match(evidence) {
        return None;
    }
    // Anything else is evidence from before this "go" (an earlier reopen) or none: it never started.
    Some(if evidence.starts_with(RUNNING) {
        format!(
            "result unknown: the hub restarted while it ran on {machine_id}; check on {machine_id} whether it ran before approving it again"
        )
    } else {
        NOT_RUN_AFTER_RESTART.to_string()
    })
}

/// A node command's failure (checks/NodeCommands.ts `NodeCommandError`).
#[derive(Clone, Debug)]
pub struct NodeCommandError {
    /// "offline", "lost", "no_reply" or "invalid".
    pub reason: String,
    pub message: String,
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

/// The ledger's asks (ledger/Asks.ts). `update` merges `patch`'s fields into the stored ask.
pub trait ApprovalAsks: Send + Sync {
    fn get(&self, ask_id: &str) -> BoxFut<'_, Option<Value>>;
    fn list_answered(&self) -> BoxFut<'_, Vec<Value>>;
    /// `input` is an `AskInput`; returns the created ask or the ledger's refusal.
    fn create(&self, input: Value, by: &str) -> BoxFut<'_, Result<Value, ApprovalRefused>>;
    fn update(
        &self,
        ask_id: &str,
        patch: Map<String, Value>,
    ) -> BoxFut<'_, Result<Value, ApprovalRefused>>;
    fn reopen(&self, ask_id: &str, evidence: &str) -> BoxFut<'_, Result<Value, ApprovalRefused>>;
}

/// The node link's request/reply commands (checks/NodeCommands.ts).
pub trait ApprovalNodes: Send + Sync {
    /// `secret_deliver`: `{ sink, sealed, secretKey, envName? }`.
    fn deliver_secret(
        &self,
        machine_id: &str,
        input: Value,
    ) -> BoxFut<'_, Result<SecretOutcome, NodeCommandError>>;
    /// `gated_run`: `{ askId, argv, cwd, timeoutSec, secretEnv? }`.
    fn run_gated(
        &self,
        machine_id: &str,
        input: Value,
    ) -> BoxFut<'_, Result<GatedOutcome, NodeCommandError>>;
}

/// The rest of the hub approvals reads or wakes.
pub trait ApprovalHub: Send + Sync {
    /// The machine's `boxPubKey`: `None` for no machine, `Some(None)` for one that takes no secrets.
    fn box_key(&self, machine_id: &str) -> BoxFut<'_, Option<Option<String>>>;
    /// The project's workspace root; `None` when the hub has no record of it.
    fn workspace_root(&self, project: &ProjectRef) -> BoxFut<'_, Option<String>>;
    /// LeadWakes.trigger with `{ kind: "answer", answer: { ask, outcome: "answered", value } }`.
    fn wake_answer(&self, project: &ProjectRef, ask: Value, value: String) -> BoxFut<'_, ()>;
    /// CheckRunner.verify for a do ask's verify spec: (result "pass"/"fail"/..., evidence).
    fn verify(
        &self,
        project: &ProjectRef,
        workstream_id: Option<String>,
        verify: Value,
    ) -> BoxFut<'_, (String, String)>;
}

pub struct ApprovalsDeps {
    pub asks: Arc<dyn ApprovalAsks>,
    pub nodes: Arc<dyn ApprovalNodes>,
    pub hub: Arc<dyn ApprovalHub>,
    pub events: Arc<dyn EventLog>,
    pub clock: Arc<dyn Clock>,
}

/// `fleetd gated run`'s call (lead-calls `GatedRunCall` without `op`).
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

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn project_of(ask: &Value) -> Option<ProjectRef> {
    serde_json::from_value(ask.get("projectRef")?.clone()).ok()
}

pub struct Approvals {
    deps: ApprovalsDeps,
}

impl Approvals {
    /// Reopens approvals the hub accepted but never finished before it stopped (never run late, never silently
    /// lost); `serve` then acts on answers recorded from now on.
    pub fn new(deps: ApprovalsDeps) -> Arc<Self> {
        Arc::new(Approvals { deps })
    }

    /// Runs until the hub stops: the restart sweep, then the answers' follower.
    pub async fn serve(self: Arc<Self>) {
        let approvals = self;
        for ask in approvals.deps.asks.list_answered().await {
            if s(&ask, "kind") != Some("approve")
                || ask.pointer("/answer/value").and_then(Value::as_str) != Some("go")
            {
                continue;
            }
            let machine =
                project_of(&ask).map_or_else(|| "its machine".to_string(), |p| p.machine_id);
            if let (Some(why), Some(id)) = (
                restart_reopen_reason(s(&ask, "evidence"), &machine),
                s(&ask, "askId"),
            ) {
                let _ = approvals.deps.asks.reopen(id, &why).await;
            }
        }
        approvals.follow_answers().await;
    }

    fn now(&self) -> String {
        iso(system_ms(self.deps.clock.now()))
    }

    async fn append(&self, kind: &str, project: Option<&ProjectRef>, summary: String, data: Value) {
        self.deps
            .events
            .append(NewEvent {
                at: self.now(),
                kind: kind.into(),
                machine_id: project.map(|p| p.machine_id.clone()),
                project_id: project.map(|p| p.project_id.clone()),
                summary,
                data: Some(data),
                ..Default::default()
            })
            .await;
    }

    async fn wake_with(&self, ask: &Value, value: String) {
        if let Some(p) = project_of(ask) {
            self.deps.hub.wake_answer(&p, ask.clone(), value).await;
        }
    }

    /// Hands each answer recorded from now on to its handler, with the ask it answered, while that answer stands.
    /// Starting at the head means an answer from before a hub restart is never acted on late, so a command never
    /// runs twice.
    async fn follow_answers(self: Arc<Self>) {
        let mut cursor = self.deps.events.head().await;
        {
            loop {
                let page = self
                    .deps
                    .events
                    .wait(WaitInput {
                        cursor,
                        types: vec!["decision.recorded"],
                        timeout_sec: 3600,
                        ..Default::default()
                    })
                    .await;
                cursor = page.cursor;
                for event in page.events {
                    let data = event.data.unwrap_or(Value::Null);
                    let (Some(ask_id), Some(decision_id)) =
                        (s(&data, "askId"), s(&data, "decisionId"))
                    else {
                        continue;
                    };
                    let Some(ask) = self.deps.asks.get(ask_id).await else {
                        continue;
                    };
                    if s(&ask, "state") != Some("answered")
                        || s(&ask, "decisionId") != Some(decision_id)
                    {
                        continue;
                    }
                    let me = self.clone();
                    tokio::spawn(async move {
                        match s(&ask, "kind") {
                            Some("approve") => me.run_approved(&ask).await,
                            Some("do") => me.recheck(&ask).await,
                            _ => {}
                        }
                    });
                }
            }
        }
    }

    /// `secret_submit`: relays the sealed value to the sink's node and closes the ask with the node's fingerprint.
    pub async fn submit_secret(
        &self,
        caller: &Caller<'_>,
        ask_id: &str,
        sealed: &str,
    ) -> Result<Value, ApprovalRefused> {
        if !caller.human {
            return Err(refuse(
                "forbidden",
                "Only a person enters secrets.",
                Some(HUMAN_ONLY_SECRET_FIX),
            ));
        }
        let ask = self.deps.asks.get(ask_id).await;
        let sink_text = ask.as_ref().and_then(|a| s(a, "sink")).map(str::to_string);
        let sink = sink_text.as_deref().and_then(parse_secret_sink);
        let (Some(ask), Some(sink), Some(sink_text)) = (
            ask.filter(|a| s(a, "kind") == Some("secret")),
            sink,
            sink_text,
        ) else {
            return Err(refuse(
                "not_found",
                format!("No secret ask {ask_id}."),
                Some("Use the askId of an open secret ask from asks_list."),
            ));
        };
        let project = project_of(&ask);
        let machines: BTreeSet<&str> = [
            Some(sink.machine_id.as_str()),
            project.as_ref().map(|p| p.machine_id.as_str()),
        ]
        .into_iter()
        .flatten()
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
        let id = s(&ask, "askId").unwrap_or(ask_id).to_string();
        let state = s(&ask, "state").unwrap_or("");
        if state != "open" {
            return Err(refuse(
                "invalid",
                format!("{id} is already {state}."),
                Some("Nothing to enter: it is settled."),
            ));
        }
        let m = &sink.machine_id;
        match self.deps.hub.box_key(m).await {
            None => {
                return Err(refuse(
                    "not_found",
                    format!("No machine {m}."),
                    Some("Ask the lead to file the secret ask with a sink on a known machine."),
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
        let key = s(&ask, "key").unwrap_or("");
        let mut input = json!({ "sink": sink_text, "sealed": sealed, "secretKey": key });
        if let Some(env) = s(&ask, "envName") {
            input["envName"] = json!(env);
        }
        // The ciphertext is never queued: the human enters it again once the node is back.
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
                    "Seal it to the machine's current boxPubKey and try again, or ask the lead to fix the sink.",
                ),
            ));
        };
        let by = format!("human:{}", caller.name);
        let mut patch = Map::new();
        patch.insert("state".into(), json!("answered"));
        patch.insert("fingerprint".into(), json!(fingerprint));
        patch.insert(
            "evidence".into(),
            json!(format!("fingerprint {fingerprint}")),
        );
        patch.insert(
            "answer".into(),
            json!({ "value": format!("saved, fingerprint {fingerprint}"), "by": by, "at": self.now(), "raw": "secret_submit" }),
        );
        let saved = self.deps.asks.update(&id, patch).await?;
        self.append(
            "ask.secret_saved",
            project.as_ref(),
            format!("{id} {key} saved on {m}, fingerprint {fingerprint}"),
            json!({ "askId": id, "fingerprint": fingerprint, "by": by }),
        )
        .await;
        self.wake_with(
            &saved,
            format!(
                "saved to its {} sink on {m}, fingerprint {fingerprint}",
                sink.kind
            ),
        )
        .await;
        Ok(
            json!({ "askId": id, "fingerprint": fingerprint, "next": format!("Saved on {m}; the lead hears it in its next wake.") }),
        )
    }

    /// `fleetd gated run`: files the approve ask holding exactly this command, run in the project workspace by
    /// default. Returns the `GatedRunResult`.
    pub async fn gated_run(
        &self,
        project: &ProjectRef,
        by: &str,
        call: GatedRunInput,
    ) -> Result<Value, ApprovalRefused> {
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
        // Stored resolved, so the human approves the exact directory too.
        let cwd = call.cwd.clone().unwrap_or(root);
        let mut gated = json!({ "argv": call.argv, "cwd": cwd, "class": call.class, "reason": call.reason, "timeoutSec": call.timeout_sec });
        if let Some(env) = &call.secret_env {
            gated["secretEnv"] = env.clone();
        }
        let mut input = json!({
            "projectRef": project,
            "kind": "approve",
            // Replaced by gated.<askId> once the ask has its id.
            "key": "gated.new",
            "class": call.class,
            "text": clip(&format!("Run {} on {} in {cwd}: {}", shown_argv(&call.argv), project.machine_id, call.reason), 500),
            "gated": gated,
            // Irreversible and money steps hold the lead back, so they are loud; a credential command is not.
            "blocks": if call.class == "credential" { "nothing".to_string() } else { clip(&format!("the lead's {} step: {}", call.class, call.reason), 200) },
            "proceededOnRec": false,
        });
        if let Some(w) = &call.workstream_id {
            input["workstreamId"] = json!(w);
        }
        let ask = self.deps.asks.create(input, by).await?;
        Ok(json!({
            "op": "gated_run",
            "askId": ask["askId"],
            "state": ask["state"],
            "next": "carry on with other work: the human approves or refuses it, and the exit code and output tail arrive in a wake.",
        }))
    }

    /// Runs an approve ask's stored command on its project's node after a human answered "go".
    async fn run_approved(&self, ask: &Value) {
        let (Some(spec), Some(project)) = (ask.get("gated"), project_of(ask)) else {
            return;
        };
        if ask.pointer("/answer/value").and_then(Value::as_str) != Some("go") {
            return;
        }
        let ask_id = s(ask, "askId").unwrap_or("").to_string();
        let machine = project.machine_id.clone();
        let by = ask
            .pointer("/answer/by")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let timeout_sec = spec.get("timeoutSec").and_then(Value::as_u64).unwrap_or(0);
        let cwd = match s(spec, "cwd") {
            Some(c) => Some(c.to_string()),
            None => self.deps.hub.workspace_root(&project).await,
        };
        // Marks it in flight, so a hub restart before the result arrives is reported as "result unknown", not "not run".
        let mut running = Map::new();
        running.insert(
            "evidence".into(),
            json!(format!("{RUNNING} {machine}, approved by {by}")),
        );
        let _ = self.deps.asks.update(&ask_id, running).await;
        let ran = match cwd {
            None => Ok(GatedOutcome {
                error: Some("the project has no workspace on record".into()),
                ..Default::default()
            }),
            Some(cwd) => {
                let mut input = json!({ "askId": ask_id, "argv": spec["argv"], "cwd": cwd, "timeoutSec": timeout_sec });
                if let Some(env) = spec.get("secretEnv") {
                    input["secretEnv"] = env.clone();
                }
                self.deps.nodes.run_gated(&machine, input).await
            }
        };
        if let Err(e) = &ran
            && e.reason == "offline"
        {
            // Nothing ran, so the human can approve it again once the machine is back.
            let why = format!(
                "not run: {machine}'s node was offline when {by} approved it; answer go again once it is online"
            );
            let _ = self.deps.asks.reopen(&ask_id, &why).await;
            return;
        }
        let evidence = match &ran {
            Err(e) => format!(
                "result unknown: {}; check on {machine} whether it ran before approving it again",
                e.message
            ),
            Ok(GatedOutcome {
                error: Some(err), ..
            }) => format!("not run on {machine}: {err}"),
            Ok(o) => {
                let head = if o.timed_out {
                    format!("killed after {timeout_sec} s on {machine}, approved by {by}")
                } else {
                    let code = o
                        .exit_code
                        .map_or_else(|| "none (ended by a signal)".to_string(), |c| c.to_string());
                    format!("exit {code} on {machine}, approved by {by}")
                };
                with_tail(&head, &o.output_tail)
            }
        };
        let with_evidence = || {
            let mut a = ask.clone();
            a["evidence"] = json!(evidence);
            a
        };
        // A link that dropped mid-run leaves the result unknown: back to the human, loud, to check before approving again.
        let done = match &ran {
            Err(_) => self
                .deps
                .asks
                .reopen(&ask_id, &evidence)
                .await
                .unwrap_or_else(|_| with_evidence()),
            Ok(_) => {
                let mut patch = Map::new();
                patch.insert("evidence".into(), json!(evidence));
                self.deps
                    .asks
                    .update(&ask_id, patch)
                    .await
                    .unwrap_or_else(|_| with_evidence())
            }
        };
        let outcome = ran.as_ref().ok();
        let mut data = json!({
            "askId": ask_id,
            "exitCode": outcome.and_then(|o| o.exit_code),
            "timedOut": outcome.is_some_and(|o| o.timed_out),
            "by": by,
        });
        if outcome.is_none_or(|o| o.error.is_some()) {
            data["ran"] = json!(false);
        }
        let first = evidence.lines().next().unwrap_or("");
        self.append(
            "gated.ran",
            Some(&project),
            clip(&format!("{ask_id} {first}"), 200),
            data,
        )
        .await;
        self.wake_with(&done, "go".into()).await;
    }

    /// Re-checks a do ask with a verify check once the human ticks it done: a pass goes to the lead with the evidence,
    /// a failure reopens the ask with it.
    async fn recheck(&self, ask: &Value) {
        let (Some(verify), Some(project)) = (ask.get("verify"), project_of(ask)) else {
            return;
        };
        if ask.pointer("/answer/value").and_then(Value::as_str) != Some("done") {
            return;
        }
        if matches!(s(verify, "type"), Some("judge" | "human")) {
            return;
        }
        let ask_id = s(ask, "askId").unwrap_or("").to_string();
        let workstream = s(ask, "workstreamId").map(str::to_string);
        let (result, evidence) = self
            .deps
            .hub
            .verify(&project, workstream, verify.clone())
            .await;
        if result != "pass" {
            let why = if result == "fail" {
                "failed"
            } else {
                "could not run"
            };
            let _ = self
                .deps
                .asks
                .reopen(
                    &ask_id,
                    &clip(
                        &format!("ticked done, but its check {why}: {evidence}"),
                        EVIDENCE_MAX,
                    ),
                )
                .await;
            return;
        }
        let mut patch = Map::new();
        patch.insert(
            "evidence".into(),
            json!(clip(&format!("verified: {evidence}"), EVIDENCE_MAX)),
        );
        let done = self
            .deps
            .asks
            .update(&ask_id, patch)
            .await
            .unwrap_or_else(|_| ask.clone());
        self.deps
            .hub
            .wake_answer(&project, done, "done".into())
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::usage::ports::{HubEvent, WaitPage};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        asks: Mutex<Vec<Value>>,
        delivered: Mutex<Vec<Value>>,
        events: Mutex<Vec<HubEvent>>,
    }

    impl ApprovalAsks for Fake {
        fn get(&self, ask_id: &str) -> BoxFut<'_, Option<Value>> {
            let found = self
                .asks
                .lock()
                .unwrap()
                .iter()
                .find(|a| a["askId"] == ask_id)
                .cloned();
            Box::pin(async move { found })
        }
        fn list_answered(&self) -> BoxFut<'_, Vec<Value>> {
            Box::pin(async { Vec::new() })
        }
        fn create(&self, _: Value, _: &str) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
            unreachable!()
        }
        fn update(
            &self,
            ask_id: &str,
            patch: Map<String, Value>,
        ) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
            let mut asks = self.asks.lock().unwrap();
            let ask = asks.iter_mut().find(|a| a["askId"] == ask_id).unwrap();
            for (k, v) in patch {
                ask[k] = v;
            }
            let out = ask.clone();
            Box::pin(async move { Ok(out) })
        }
        fn reopen(&self, _: &str, _: &str) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
            unreachable!()
        }
    }
    impl ApprovalNodes for Fake {
        fn deliver_secret(
            &self,
            _: &str,
            input: Value,
        ) -> BoxFut<'_, Result<SecretOutcome, NodeCommandError>> {
            self.delivered.lock().unwrap().push(input);
            Box::pin(async {
                Ok(SecretOutcome {
                    fingerprint: Some("ab12cd34".into()),
                    error: None,
                })
            })
        }
        fn run_gated(
            &self,
            _: &str,
            _: Value,
        ) -> BoxFut<'_, Result<GatedOutcome, NodeCommandError>> {
            unreachable!()
        }
    }
    impl ApprovalHub for Fake {
        fn box_key(&self, _: &str) -> BoxFut<'_, Option<Option<String>>> {
            Box::pin(async { Some(Some("key".into())) })
        }
        fn workspace_root(&self, _: &ProjectRef) -> BoxFut<'_, Option<String>> {
            Box::pin(async { Some("/w/p1".into()) })
        }
        fn wake_answer(&self, _: &ProjectRef, _: Value, _: String) -> BoxFut<'_, ()> {
            Box::pin(async {})
        }
        fn verify(
            &self,
            _: &ProjectRef,
            _: Option<String>,
            _: Value,
        ) -> BoxFut<'_, (String, String)> {
            unreachable!()
        }
    }
    impl EventLog for Fake {
        fn append(&self, e: NewEvent) -> BoxFut<'_, HubEvent> {
            let mut events = self.events.lock().unwrap();
            let event = HubEvent {
                seq: events.len() as u64 + 1,
                at: e.at,
                kind: e.kind,
                machine_id: e.machine_id,
                project_id: e.project_id,
                thread_id: e.thread_id,
                summary: e.summary,
                data: e.data,
                attention: e.attention,
            };
            events.push(event.clone());
            Box::pin(async move { event })
        }
        fn head(&self) -> BoxFut<'_, u64> {
            Box::pin(async { 0 })
        }
        fn wait(&self, _: WaitInput) -> BoxFut<'_, WaitPage> {
            Box::pin(async { WaitPage::default() })
        }
    }

    #[tokio::test]
    async fn only_a_person_enters_a_secret_and_the_hub_keeps_only_its_fingerprint() {
        let fake = Arc::new(Fake::default());
        fake.asks.lock().unwrap().push(json!({
            "askId": "A1", "kind": "secret", "state": "open", "key": "stripe.test_key", "class": "credential",
            "sink": "env:lab-a:/w/p1/.env", "projectRef": { "machineId": "lab-a", "projectId": "p1" },
        }));
        let approvals = Approvals {
            deps: ApprovalsDeps {
                asks: fake.clone(),
                nodes: fake.clone(),
                hub: fake.clone(),
                events: fake.clone(),
                clock: Arc::new(crate::clock::SystemClock),
            },
        };
        let everywhere = |_: &str| true;
        const SEALED: &str = "c2VhbGVkLWJ5LXRoZS1hcHA=";

        let agent = Caller {
            human: false,
            name: "adri",
            allows_operate: &everywhere,
        };
        let refused = approvals
            .submit_secret(&agent, "A1", SEALED)
            .await
            .unwrap_err();
        assert_eq!(
            (refused.code.as_str(), refused.fix.as_deref()),
            ("forbidden", Some(HUMAN_ONLY_SECRET_FIX))
        );
        assert!(
            fake.delivered.lock().unwrap().is_empty(),
            "an agent's value never reaches a node"
        );

        let nowhere = |_: &str| false;
        let ungranted = Caller {
            human: true,
            name: "desk",
            allows_operate: &nowhere,
        };
        assert_eq!(
            approvals
                .submit_secret(&ungranted, "A1", SEALED)
                .await
                .unwrap_err()
                .code,
            "forbidden"
        );

        let human = Caller {
            human: true,
            name: "desk",
            allows_operate: &everywhere,
        };
        let out = approvals.submit_secret(&human, "A1", SEALED).await.unwrap();
        assert_eq!(out["fingerprint"], "ab12cd34");
        assert_eq!(
            fake.delivered.lock().unwrap().as_slice(),
            [
                json!({ "sink": "env:lab-a:/w/p1/.env", "sealed": SEALED, "secretKey": "stripe.test_key" })
            ]
        );
        let ask = fake.asks.lock().unwrap()[0].clone();
        assert_eq!(
            (&ask["state"], &ask["fingerprint"], &ask["evidence"]),
            (
                &json!("answered"),
                &json!("ab12cd34"),
                &json!("fingerprint ab12cd34")
            )
        );
        assert_eq!(ask["answer"]["by"], "human:desk");
        assert!(
            !ask.to_string().contains(SEALED),
            "the ciphertext is never stored"
        );
        let events = fake.events.lock().unwrap().clone();
        assert_eq!(events[0].kind, "ask.secret_saved");
        assert!(!serde_json::to_string(&events).unwrap().contains(SEALED));
        assert_eq!(
            approvals
                .submit_secret(&human, "A1", SEALED)
                .await
                .unwrap_err()
                .code,
            "invalid",
            "settled"
        );
    }
}
