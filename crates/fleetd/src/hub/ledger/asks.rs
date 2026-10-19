//! The ask path, batches and their quiet window.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::{
    ASK_QUESTION_MAX, Ask, AskAnswer, AskBlocks, AskClass, AskContext, AskId, AskKind, AskOptions,
    AskRecommendationWhy, AskState, AskSteps, AskText, Batch, BatchId, BatchState, CheckSpec,
    Decision, DecisionId, DecisionKey, DecisionState, DecisionValue, EnvName, GatedRunSpec,
    ToolPermission, WorkstreamId, humanize_key,
};
use fleetd_contracts::secrets::SecretSink;
use rusqlite::Connection;
use serde_json::json;
use tokio::task::JoinHandle;

use super::repo::{self, AskFilter, DecisionFilter, StoredBatch, ask_project_key, batch_n};
use super::{Chain, Ctx, Fail, LedgerError, iso_at, js_prefix, project_fields, project_key};
use crate::clock::Clock;
use crate::hub::attention::ask_attention;
use crate::hub::store::{EventLog, HubDb, NewEvent};

/// A batch is published once this long passes with no new ask.
pub const QUIET_WINDOW_MS: i64 = 30_000;

/// The fix text for a question the lead must decide itself.
pub const DECIDE_YOURSELF: &str = "decide this yourself and log it with `fleetd decide`";

const UNROUTED_ASK_PREFIX: &str = "intake.route.";
const PLAYBOOK_ASK_PREFIX: &str = "playbook.";

/// Asks that may leave out their project: the router's fallback and the retro's gate changes.
pub fn is_hub_ask_key(key: &str) -> bool {
    key.starts_with(UNROUTED_ASK_PREFIX) || key.starts_with(PLAYBOOK_ASK_PREFIX)
}

/// What the lead files with `fleetd ask`; `class` is unchecked so the refusal can name the fix.
#[derive(Clone, Debug)]
pub struct AskInput {
    /// Absent only for an `intake.route.*` ask (the router's fallback) or a `playbook.*` one (the retro's gate changes).
    pub project_ref: Option<ProjectRef>,
    pub workstream_id: Option<WorkstreamId>,
    pub kind: AskKind,
    pub key: DecisionKey,
    pub class: String,
    pub text: AskText,
    pub context: Option<AskContext>,
    pub recommendation: Option<DecisionValue>,
    pub recommendation_why: Option<AskRecommendationWhy>,
    pub options: Option<AskOptions>,
    pub steps: Option<AskSteps>,
    /// do: re-checked once the human ticks it done.
    pub verify: Option<CheckSpec>,
    /// secret: where the node writes it.
    pub sink: Option<SecretSink>,
    pub env_name: Option<EnvName>,
    /// approve: the stored command; its key is always `gated.<askId>`.
    pub gated: Option<GatedRunSpec>,
    /// approve: a session's tool permission prompt instead of a command; its key is always `permission.<askId>`.
    pub permission: Option<ToolPermission>,
    pub blocks: AskBlocks,
    pub proceeded_on_rec: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutcomeState {
    /// Answered from the log by `decision`, never batched.
    Auto,
    /// New, or `attached` to an open one.
    Open,
}

#[derive(Clone, Debug)]
pub struct AskOutcome {
    pub state: OutcomeState,
    pub ask: Ask,
    pub decision: Option<Decision>,
    pub attached: Option<bool>,
    /// Decisions that may already answer it, best first (new asks only).
    pub candidates: Option<Vec<Decision>>,
}

fn wire<T: serde::Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}

fn ask_class(class: &str) -> Option<AskClass> {
    serde_json::from_value(json!(class)).ok()
}

/// `secretEnvName`: the key uppercased with `.` and `-` as `_`, when that is a valid variable name.
fn secret_env_name(key: &str) -> Option<String> {
    let name = key.to_uppercase().replace(['.', '-'], "_");
    let mut chars = name.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    (first_ok && rest_ok && name.len() <= 128).then_some(name)
}

/// `<name>`-style placeholders: "<" and ">" with no space just inside, so `sort < a > b` passes.
fn has_placeholder(command: &str) -> bool {
    command
        .char_indices()
        .filter(|(_, c)| *c == '<')
        .any(|(i, _)| {
            let rest = &command[i + 1..];
            let Some(end) = rest.find(['<', '>']) else {
                return false;
            };
            let inner = &rest[..end];
            rest[end..].starts_with('>')
                && inner.chars().next().is_some_and(|c| !c.is_whitespace())
                && inner.chars().last().is_some_and(|c| !c.is_whitespace())
        })
}

/// A lead's decide ask must be readable as a card: a short question, two to six options each with a label and a
/// consequence, the recommendation one of their keys, and a one-line reason for it. Hub-made asks are exempt. The
/// fix is the whole command to send, filled with what the lead already gave.
pub fn lead_decide_rule(input: &AskInput) -> Option<LedgerError> {
    if input.kind != AskKind::Decide {
        return None;
    }
    let options: Vec<_> = input.options.iter().flatten().collect();
    let rec = input.recommendation.as_deref();
    let mut problems = Vec::new();
    let question_len = input.text.encode_utf16().count();
    if question_len > ASK_QUESTION_MAX {
        problems.push(format!(
            "the question is {question_len} characters (at most {ASK_QUESTION_MAX}): ask it in one short line and put the background in --context"
        ));
    }
    if options.len() < 2 {
        problems.push("it needs 2 to 6 options, one --option per choice".to_string());
    }
    let unlabelled: Vec<&str> = options
        .iter()
        .filter(|o| o.label.is_none() || o.consequence.is_none())
        .map(|o| o.key.as_str())
        .collect();
    if !unlabelled.is_empty() {
        problems.push(format!(
            "option{} {} {} no label or no consequence",
            if unlabelled.len() == 1 { "" } else { "s" },
            unlabelled
                .iter()
                .map(|k| format!("\"{k}\""))
                .collect::<Vec<_>>()
                .join(", "),
            if unlabelled.len() == 1 { "has" } else { "have" }
        ));
    }
    if options
        .iter()
        .enumerate()
        .any(|(i, o)| options[..i].iter().any(|e| e.key == o.key))
    {
        problems.push("two options share a key".to_string());
    }
    if let Some(rec) = rec
        && options.len() >= 2
        && !options.iter().any(|o| o.key.as_str() == rec)
    {
        problems.push(format!(
            "the recommendation \"{rec}\" is not one of the option keys"
        ));
    }
    if input.recommendation_why.is_none() {
        problems.push("it has no --why (one line: why you recommend that option)".to_string());
    }
    if problems.is_empty() {
        return None;
    }
    Some(LedgerError::invalid_fix(
        format!(
            "The human could not tell what they are choosing: {}.",
            problems.join("; ")
        ),
        decide_fix(input),
    ))
}

/// `fleetd ask …` with every value the lead gave and `<…>` where something is missing.
fn decide_fix(input: &AskInput) -> String {
    let quote = |text: &str| format!("'{}'", text.replace('\'', "'\\''"));
    let mut keys: Vec<String> = input
        .options
        .iter()
        .flatten()
        .map(|o| o.key.to_string())
        .collect();
    if let Some(rec) = &input.recommendation
        && !keys.iter().any(|k| k == rec.as_str())
    {
        keys.insert(0, rec.to_string());
    }
    while keys.len() < 2 {
        keys.push(format!("<key {}>", keys.len() + 1));
    }
    let text = if input.text.encode_utf16().count() > ASK_QUESTION_MAX {
        "<the question in one short line>".to_string()
    } else {
        input.text.to_string()
    };
    let mut parts = vec![
        "fleetd ask".to_string(),
        format!("--key {}", input.key),
        format!("--class {}", input.class),
        format!("--text {}", quote(&text)),
        format!(
            "--context {}",
            quote(
                input
                    .context
                    .as_deref()
                    .unwrap_or("<1-2 lines of background>")
            )
        ),
    ];
    for key in &keys {
        let given = input
            .options
            .iter()
            .flatten()
            .find(|o| o.key.as_str() == key);
        let label = given
            .and_then(|o| o.label.as_ref().map(|l| l.to_string()))
            .unwrap_or_else(|| format!("<short label, e.g. {}>", humanize_key(key)));
        let consequence = given
            .and_then(|o| o.consequence.as_ref().map(|c| c.to_string()))
            .unwrap_or_else(|| "<what happens if the human picks this>".into());
        parts.push(format!(
            "--option {}",
            quote(&format!("{key}|{label}|{consequence}"))
        ));
    }
    parts.push(format!(
        "--rec {}",
        input
            .recommendation
            .as_deref()
            .map_or_else(|| keys[0].clone(), str::to_string)
    ));
    parts.push(format!(
        "--why {}",
        quote(
            input
                .recommendation_why
                .as_deref()
                .unwrap_or("<one line: why you recommend it>")
        )
    ));
    if input.blocks.as_str() != "nothing" {
        parts.push(format!("--blocks {}", quote(&input.blocks)));
    }
    if input.proceeded_on_rec {
        parts.push("--proceeded".into());
    }
    if let Some(w) = &input.workstream_id {
        parts.push(format!("--workstream {w}"));
    }
    format!("Send it again as: {}", parts.join(" "))
}

/// Step 1 of the ask path.
pub fn validate_ask(input: &AskInput) -> Option<LedgerError> {
    let key = input.key.as_str();
    if input.project_ref.is_none() && !is_hub_ask_key(key) {
        return Some(LedgerError::invalid_fix(
            format!(
                "Only an {UNROUTED_ASK_PREFIX}* or {PLAYBOOK_ASK_PREFIX}* ask may leave out its project."
            ),
            "Name the project the ask is about.",
        ));
    }
    let Some(class) = ask_class(&input.class) else {
        return Some(LedgerError::invalid_fix(
            format!(
                "\"{}\" is not something fleetd asks the human about (only product, money, credential, irreversible): {DECIDE_YOURSELF}.",
                input.class
            ),
            format!(
                "Run `fleetd decide --key {key} --value <your choice> --why <reason>` and carry on."
            ),
        ));
    };
    if input.kind == AskKind::Decide
        && input
            .recommendation
            .as_deref()
            .is_none_or(|r| r.trim().is_empty())
    {
        return Some(LedgerError::invalid_fix(
            "A decide ask needs a recommendation.",
            "Add --rec with what you would choose.",
        ));
    }
    if input.kind == AskKind::Secret {
        let Some(sink) = input.sink.as_deref() else {
            return Some(LedgerError::invalid_fix(
                "A secret ask needs a sink.",
                "Add --sink env:<machine>:<path> or file:<machine>:<path>.",
            ));
        };
        if class == AskClass::Product {
            return Some(LedgerError::invalid_fix(
                "A secret is not a product call.",
                "File it with --class credential.",
            ));
        }
        if sink.starts_with("env:") && input.env_name.is_none() && secret_env_name(key).is_none() {
            return Some(LedgerError::invalid_fix(
                format!("The key {key} names no valid environment variable."),
                "Add --env-name with the variable the env file should hold.",
            ));
        }
    }
    if input.kind == AskKind::Approve
        && input.permission.is_none()
        && input
            .gated
            .as_ref()
            .is_none_or(|g| wire(&g.class) != input.class)
    {
        return Some(LedgerError::invalid_fix(
            "An approve ask needs its stored command, with the same class.",
            "Use `fleetd gated run`.",
        ));
    }
    if let Some(verify) = &input.verify {
        let check_type = serde_json::to_value(verify)
            .ok()
            .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(String::from));
        if input.kind != AskKind::Do || matches!(check_type.as_deref(), Some("judge" | "human")) {
            return Some(LedgerError::invalid_fix(
                "Only a do ask has --verify, and it must be a check fleetd runs itself (cmd, http, pr_merged, ci_green or test).",
                "Drop --verify, or give a cmd or http check that shows the step is done.",
            ));
        }
    }
    if input.kind == AskKind::Do {
        let steps: &[_] = input.steps.as_deref().map_or(&[], |s| s.as_slice());
        if steps.is_empty() {
            return Some(LedgerError::invalid_fix(
                "A do ask needs at least one step.",
                "List the exact steps the human runs.",
            ));
        }
        if let Some(bad) = steps
            .iter()
            .position(|step| step.command.as_deref().is_some_and(has_placeholder))
        {
            return Some(LedgerError::invalid_fix(
                format!("Step {}'s command has a <placeholder>.", bad + 1),
                "Write the real value, or make getting it a separate step.",
            ));
        }
    }
    None
}

/// Money, credential and irreversible asks that hold a step back skip the quiet window.
fn is_urgent(ask: &Ask) -> bool {
    ask.class != AskClass::Product && ask.blocks.as_str() != "nothing"
}

pub fn batch_ready_event(stored: &StoredBatch, now_ms: i64) -> NewEvent {
    let count = stored.batch.items.len();
    NewEvent {
        at: Timestamp(iso_at(now_ms)),
        r#type: HubEventType::BatchReady,
        machine_id: None,
        project_id: None,
        thread_id: None,
        summary: format!(
            "{} ready: {count} question{}",
            stored.batch.batch_id,
            if count == 1 { "" } else { "s" }
        ),
        data: Some(json!({ "batchId": stored.batch.batch_id, "items": stored.batch.items })),
        attention: None,
    }
}

enum Created {
    Auto {
        ask: Ask,
        decision: Decision,
    },
    Attached {
        ask: Ask,
    },
    New {
        ask: Ask,
        candidates: Vec<Decision>,
        batch: StoredBatch,
        published_now: bool,
    },
}

pub struct Asks {
    ctx: Ctx,
    /// The one pending quiet-window timer: a new schedule replaces it.
    timer: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl Drop for Asks {
    fn drop(&mut self) {
        if let Some(handle) = self.timer.lock().unwrap_or_else(|p| p.into_inner()).take() {
            handle.abort();
        }
    }
}

/// Publishes batch `n` when its quiet window has passed with no new ask.
fn publish_due(ctx: &Ctx, n: i64) {
    let now = ctx.now_ms();
    let published = ctx.write(|db| {
        let Some(stored) = repo::get_batch(db, n)? else {
            return Ok(None);
        };
        let Some(last_add) = stored.last_add_ms else {
            return Ok(None);
        };
        if stored.batch.state != BatchState::Open || now - last_add < QUIET_WINDOW_MS {
            return Ok(None);
        }
        Ok(repo::publish_batch(db, n, now)?.then_some(stored))
    });
    match published {
        Ok(Some(stored)) => ctx.emit(batch_ready_event(&stored, now)),
        Ok(None) => {}
        Err(error) => tracing::error!(%error, batch = n, "publishing a batch failed"),
    }
}

/// A new or reopened ask joins the collecting batch; an urgent one publishes it at once. Inside a write.
fn placed(
    db: &Connection,
    fresh: &Ask,
    candidates: Vec<Decision>,
    now: i64,
) -> Result<Created, Fail> {
    let (ask, batch) = repo::add_to_collecting(db, fresh, now)?;
    let published_now = is_urgent(&ask) && repo::publish_batch(db, batch.n, now)?;
    let batch = repo::get_batch(db, batch.n)?.expect("placed into it");
    Ok(Created::New {
        ask,
        candidates,
        batch,
        published_now,
    })
}

impl Asks {
    pub fn new(db: Arc<HubDb>, events: Arc<EventLog>, clock: Arc<dyn Clock>) -> Self {
        Self {
            ctx: Ctx { db, events, clock },
            timer: Arc::new(Mutex::new(None)),
        }
    }

    /// A batch still collecting when the hub stopped publishes on its original schedule. Call once at start, inside
    /// the tokio runtime.
    pub fn start(&self) -> Result<(), LedgerError> {
        if let Some(pending) = self.ctx.read(repo::collecting_batch)?
            && let Some(last_add) = pending.last_add_ms
        {
            self.schedule(pending.n, last_add + QUIET_WINDOW_MS - self.ctx.now_ms());
        }
        Ok(())
    }

    fn schedule(&self, n: i64, delay_ms: i64) {
        let ctx = self.ctx.clone();
        let sleep = ctx
            .clock
            .sleep(Duration::from_millis(delay_ms.max(0) as u64));
        let task = tokio::spawn(async move {
            sleep.await;
            publish_due(&ctx, n);
        });
        if let Some(previous) = self
            .timer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .replace(task)
        {
            previous.abort();
        }
    }

    fn clear_timer(&self) {
        if let Some(previous) = self.timer.lock().unwrap_or_else(|p| p.into_inner()).take() {
            previous.abort();
        }
    }

    /// After the commit: the ask's event, then the batch published now or on its quiet window.
    fn announce(
        &self,
        ask: &Ask,
        batch: &StoredBatch,
        published_now: bool,
        now: i64,
        summary: &str,
        reopened: bool,
    ) {
        let (machine_id, project_id) = project_fields(ask.project_ref.as_ref());
        let mut data = json!({
            "askId": ask.ask_id, "key": ask.key, "class": ask.class, "kind": ask.kind,
            "batchId": ask.batch_id, "number": ask.number,
        });
        if reopened {
            data["reopened"] = json!(true);
        }
        let summary = js_prefix(summary, 200);
        self.ctx.emit(NewEvent {
            at: Timestamp(iso_at(now)),
            r#type: HubEventType::AskCreated,
            machine_id,
            project_id,
            thread_id: None,
            summary,
            data: Some(data),
            attention: ask_attention(ask, reopened),
        });
        if published_now {
            self.clear_timer();
            self.ctx.emit(batch_ready_event(batch, now));
        } else {
            self.schedule(batch.n, QUIET_WINDOW_MS);
        }
    }

    /// The ask path: filter, key auto-resolve, dedupe, create with candidates, then batch. `by` is the filer.
    pub fn create(&self, input: &AskInput, by: &str) -> Result<AskOutcome, LedgerError> {
        if let Some(refused) = validate_ask(input) {
            return Err(refused);
        }
        let now = self.ctx.now_ms();
        let class = ask_class(&input.class).expect("validated");
        let chain = input.project_ref.as_ref().map(|project_ref| Chain {
            project_ref: project_ref.clone(),
            workstream_id: input.workstream_id.clone(),
        });
        let created = self.ctx.write(|db| {
            let base = |ask_id: AskId, state: AskState| Ask {
                ask_id,
                project_ref: input.project_ref.clone(),
                workstream_id: input.workstream_id.clone(),
                kind: input.kind,
                key: input.key.clone(),
                class,
                text: input.text.clone(),
                context: input.context.clone(),
                options: input.options.clone(),
                recommendation: input.recommendation.clone(),
                recommendation_why: input.recommendation_why.clone(),
                steps: input.steps.clone(),
                verify: input.verify.clone(),
                sink: input.sink.clone(),
                env_name: input.env_name.clone(),
                fingerprint: None,
                gated: input.gated.clone(),
                permission: input.permission.clone(),
                evidence: None,
                blocks: input.blocks.clone(),
                proceeded_on_rec: input.proceeded_on_rec,
                state,
                batch_id: None,
                number: None,
                answer: None,
                decision_id: None,
                created_at: Timestamp(iso_at(now)),
            };
            let project_ref = input.project_ref.as_ref();
            let workstream_id = input.workstream_id.as_ref();
            let key = input.key.as_str();
            // Each approve ask is its own question: a stored command or a tool prompt is never answered from the log or
            // merged with another.
            if input.kind == AskKind::Approve {
                let prefix = if input.permission.is_some() {
                    "permission"
                } else {
                    "gated"
                };
                let fresh =
                    repo::insert_ask(db, project_ref, key, workstream_id, by, now, |ask_id| {
                        let gated_key =
                            DecisionKey::unchecked(format!("{prefix}.{}", ask_id.to_lowercase()));
                        Ask {
                            key: gated_key,
                            ..base(ask_id, AskState::Open)
                        }
                    })?;
                return placed(db, &fresh, Vec::new(), now);
            }
            // An unrouted ask has no project to look decisions up in, so it is always asked.
            let decision = match &chain {
                Some(chain) => repo::resolve(db, key, chain)?,
                None => None,
            };
            if let Some(decision) = decision {
                let ask =
                    repo::insert_ask(db, project_ref, key, workstream_id, by, now, |ask_id| Ask {
                        decision_id: Some(decision.decision_id.clone()),
                        ..base(ask_id, AskState::Auto)
                    })?;
                return Ok(Created::Auto { ask, decision });
            }
            if let Some(existing) = repo::open_ask_with_key(db, project_ref, key)? {
                return Ok(Created::Attached { ask: existing });
            }
            let fresh = repo::insert_ask(db, project_ref, key, workstream_id, by, now, |ask_id| {
                base(ask_id, AskState::Open)
            })?;
            let candidates = match &chain {
                Some(chain) => repo::search_decisions(
                    db,
                    &format!("{key} {}", &*input.text),
                    &DecisionFilter {
                        chain: Some(chain.clone()),
                        limit: Some(5),
                        ..Default::default()
                    },
                )?,
                None => Vec::new(),
            };
            placed(db, &fresh, candidates, now)
        })?;

        Ok(match created {
            Created::Auto { ask, decision } => {
                let (machine_id, project_id) = project_fields(input.project_ref.as_ref());
                self.ctx.emit(NewEvent {
                    at: Timestamp(iso_at(now)),
                    r#type: HubEventType::AskAuto,
                    machine_id,
                    project_id,
                    thread_id: None,
                    summary: format!("{} {} answered from {}: {}", ask.ask_id, input.key, decision.decision_id, &*decision.value),
                    data: Some(json!({ "askId": ask.ask_id, "key": input.key, "decisionId": decision.decision_id })),
                    attention: None,
                });
                AskOutcome {
                    state: OutcomeState::Auto,
                    ask,
                    decision: Some(decision),
                    attached: None,
                    candidates: None,
                }
            }
            Created::Attached { ask } => AskOutcome {
                state: OutcomeState::Open,
                ask,
                decision: None,
                attached: Some(true),
                candidates: None,
            },
            Created::New {
                ask,
                candidates,
                batch,
                published_now,
            } => {
                let summary = format!(
                    "{} [{}] {}: {}",
                    ask.ask_id,
                    wire(&ask.class),
                    ask.key,
                    &*ask.text
                );
                self.announce(&ask, &batch, published_now, now, &summary, false);
                AskOutcome {
                    state: OutcomeState::Open,
                    ask,
                    decision: None,
                    attached: None,
                    candidates: Some(candidates),
                }
            }
        })
    }

    /// Rewrites one ask in place (evidence, a saved secret's fingerprint) and closes its batch once nothing in it is open.
    pub fn update(
        &self,
        ask_id: &str,
        change: impl FnOnce(Ask) -> Ask,
    ) -> Result<Ask, LedgerError> {
        self.ctx.write(|db| {
            let Some(row) = repo::get_ask_row(db, ask_id)? else {
                return Err(LedgerError::not_found(format!("No ask {ask_id}.")).into());
            };
            let next = change(row.ask);
            repo::put_ask(db, &next)?;
            if let Some(n) = next.batch_id.as_deref().and_then(batch_n) {
                repo::close_if_done(db, n)?;
            }
            Ok(next)
        })
    }

    /// Puts an answered ask back in front of the human with `evidence` saying why (a failed verify, a command that
    /// never ran): its answer's decision is retired and it joins the collecting batch like a new ask.
    pub fn reopen(&self, ask_id: &str, evidence: &str) -> Result<Ask, LedgerError> {
        let now = self.ctx.now_ms();
        let created = self.ctx.write(|db| {
            let Some(row) = repo::get_ask_row(db, ask_id)? else {
                return Err(LedgerError::not_found(format!("No ask {ask_id}.")).into());
            };
            if row.ask.state != AskState::Answered {
                return Err(LedgerError::invalid(format!(
                    "{ask_id} is {}, not answered.",
                    repo::ask_state_text(&row.ask.state)
                ))
                .into());
            }
            let mut rest = row.ask;
            let decision_id = rest.decision_id.take();
            rest.answer = None;
            // Its answer no longer holds: a later ask with the same key must reach the human again.
            if let Some(decision_id) = decision_id
                && repo::get_decision(db, &decision_id)?
                    .is_some_and(|d| d.state == DecisionState::Active)
            {
                repo::retire_decision(db, &decision_id)?;
            }
            rest.state = AskState::Open;
            rest.evidence = Some(super::text(&js_prefix(evidence, 2000)));
            placed(db, &rest, Vec::new(), now)
        })?;
        match created {
            Created::New {
                ask,
                batch,
                published_now,
                ..
            } => {
                let summary = format!(
                    "{ask_id} reopened: {}",
                    evidence.split('\n').next().unwrap_or("")
                );
                self.announce(&ask, &batch, published_now, now, &summary, true);
                Ok(ask)
            }
            Created::Auto { ask, .. } | Created::Attached { ask } => Ok(ask),
        }
    }

    /// `fleetd ask withdraw A7 [--use D3]`. With `project_ref`, refuses asks of other projects. A `reason` is recorded
    /// as the hub's answer, for withdrawals no one asked for (the project was deleted).
    pub fn withdraw(
        &self,
        ask_id: &str,
        use_decision: Option<&DecisionId>,
        project_ref: Option<&ProjectRef>,
        reason: Option<&str>,
    ) -> Result<Ask, LedgerError> {
        let now = self.ctx.now_ms();
        self.ctx.write(|db| {
            let row = repo::get_ask_row(db, ask_id)?;
            let row = match row {
                Some(row)
                    if project_ref.is_none_or(|r| {
                        project_key(r) == ask_project_key(row.ask.project_ref.as_ref())
                    }) =>
                {
                    row
                }
                _ => {
                    return Err(LedgerError::not_found(format!(
                        "No ask {ask_id} in this project."
                    ))
                    .into());
                }
            };
            if row.ask.state != AskState::Open {
                return Err(LedgerError::invalid(format!(
                    "{ask_id} is already {}.",
                    repo::ask_state_text(&row.ask.state)
                ))
                .into());
            }
            if let Some(use_id) = use_decision {
                let active = repo::get_decision(db, use_id)?
                    .is_some_and(|d| d.state == DecisionState::Active);
                if !active {
                    return Err(
                        LedgerError::not_found(format!("No active decision {use_id}.")).into(),
                    );
                }
            }
            let mut withdrawn = row.ask;
            withdrawn.state = AskState::Withdrawn;
            if let Some(use_id) = use_decision {
                withdrawn.decision_id = Some(use_id.clone());
            }
            if let Some(reason) = reason {
                withdrawn.answer = Some(AskAnswer {
                    value: reason.to_string(),
                    by: "hub".into(),
                    at: Timestamp(iso_at(now)),
                    raw: String::new(),
                    kind: None,
                    note: None,
                    source: None,
                    undo_until: None,
                    delivered_at: None,
                });
            }
            repo::put_ask(db, &withdrawn)?;
            if let Some(n) = withdrawn.batch_id.as_deref().and_then(batch_n) {
                repo::close_if_done(db, n)?;
            }
            Ok(withdrawn)
        })
    }

    pub fn get(&self, ask_id: &str) -> Result<Option<Ask>, LedgerError> {
        self.ctx.read(|db| repo::get_ask(db, ask_id))
    }

    /// By batch, then number; asks outside any batch last.
    pub fn list(&self, filter: &AskFilter) -> Result<Vec<Ask>, LedgerError> {
        self.ctx.read(|db| repo::list_asks(db, filter))
    }

    /// Newest first; with `batch_id`, that batch alone (when it matches `state`).
    pub fn batches(
        &self,
        state: Option<BatchState>,
        batch_id: Option<&BatchId>,
        limit: Option<i64>,
    ) -> Result<Vec<Batch>, LedgerError> {
        self.ctx.read(|db| {
            if let Some(batch_id) = batch_id {
                let stored = match batch_n(batch_id) {
                    Some(n) => repo::get_batch(db, n)?,
                    None => None,
                };
                return Ok(stored
                    .filter(|s| state.is_none_or(|state| s.batch.state == state))
                    .map(|s| vec![s.batch])
                    .unwrap_or_default());
            }
            Ok(repo::list_batches(db, state, limit)?
                .into_iter()
                .map(|s| s.batch)
                .collect())
        })
    }
}
