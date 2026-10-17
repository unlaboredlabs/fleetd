//! The retro: fleetd improving its playbooks from evidence without moving goalposts. One `claude -p` turn reads the
//! window's incidents and the current playbooks and proposes changes; the hub validates each and classifies it by
//! the fields it touches. Wording changes apply as a new override file and are measured over their window against
//! the window before: kept when their metric went down and no guarded metric went up, reverted otherwise. Gate
//! changes go to a person as one batch of asks each Monday. Nothing applies until the global Decision
//! `policy.retro.apply` is true; until then every proposal is only "suggested". TS: apps/hub/src/retro/Retro.ts.
use super::diff::apply_unified_diff;
use super::metrics::{DAY_MS, RetroWork, judge, snapshot};
use super::records::{HOLDING, RetroRecords, SqlRunner, StoredProposal};
use super::types::{
    DroppedChange, METRIC_CLASSES, OrchestratorRun, PLAYBOOK_ASK_PREFIX, PLAYBOOK_NAMES,
    RetroProposal, RetroRun,
};
use super::validate::{Context, PlaybookParser, Validated, validate_answer};
use crate::clock::Clock;
use crate::hub::attention::{POLICY_TZ_KEY, hub_zone, zone};
use crate::hub::usage::ports::{BoxFut, EventLog, HubEvent, NewEvent, WaitInput};
use crate::hub::usage::time::{clip, iso, parse_ms, system_ms};
use chrono::{Datelike, TimeZone, Weekday};
use chrono_tz::Tz;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

/// The global Decision that lets the retro apply changes; anything but "true" keeps it advise-only.
pub const APPLY_KEY: &str = "policy.retro.apply";
/// Runs that spend a claude turn, per rolling 24 h.
pub const RUNS_PER_DAY: usize = 2;
pub const DEFAULT_WINDOW_DAYS: u32 = 14;
/// A retro starts when this many incidents of one class land within THRESHOLD_DAYS.
pub const THRESHOLD: u64 = 3;
pub const THRESHOLD_DAYS: i64 = 7;
/// Under the HTTP server's 5-minute request timeout, so retro_run answers before its call is cut off.
pub const RUN_TIMEOUT_MS: u64 = 240_000;
const PROMPT_INCIDENTS: usize = 200;
pub const RETRO_PROMPT: &str = include_str!("retro-prompt.md");

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RetroRefused {
    pub message: String,
    pub fix: String,
}

/// The one `claude -p` turn of a run: the intake router's one-shot runner (the user's login, its environment
/// allowlist and model) with RUN_TIMEOUT_MS.
pub trait RetroRunner: Send + Sync {
    /// The answer text, absent when the run failed (`run.error` says why), and the run as orchestrator usage.
    fn ask(&self, prompt: String) -> BoxFut<'_, (Option<String>, OrchestratorRun)>;
}

/// The bundled playbooks with their overrides (playbooks/Playbooks.ts).
pub trait RetroPlaybooks: Send + Sync {
    /// The current text and ref (`name@sha`) of `name`.
    fn current(&self, name: &str) -> (String, String);
    fn override_text(&self, name: &str) -> Option<String>;
    /// Writes (or with `None` removes) the override; returns the new current ref, or why it was refused.
    fn set_override(&self, name: &str, text: Option<&str>) -> Result<String, String>;
    fn parser(&self) -> &dyn PlaybookParser;
}

/// Incidents and the ledger, as the retro reads and writes them.
pub trait RetroLedger: Send + Sync {
    /// A global decision's trimmed value.
    fn global_value(&self, key: &str) -> BoxFut<'_, Option<String>>;
    /// A decision's value by id.
    fn decision_value(&self, decision_id: &str) -> BoxFut<'_, Option<String>>;
    /// An ask's (state, decisionId).
    fn ask_state(&self, ask_id: &str) -> BoxFut<'_, Option<(String, Option<String>)>>;
    /// Asks.create for a hub-wide decide ask; returns its id or the ledger's message.
    fn create_ask(&self, input: Value, by: &str) -> BoxFut<'_, Result<String, String>>;
    fn incident(&self, incident_id: &str) -> BoxFut<'_, Option<Value>>;
    fn incident_count(&self, class: &str, since_ms: i64) -> BoxFut<'_, u64>;
    /// Incidents.record with `{ class, projectRef, evidence }`.
    fn record_incident(&self, input: Value) -> BoxFut<'_, ()>;
}

pub struct RetroDeps {
    pub db: Arc<dyn SqlRunner>,
    pub runner: Arc<dyn RetroRunner>,
    pub playbooks: Arc<dyn RetroPlaybooks>,
    pub ledger: Arc<dyn RetroLedger>,
    pub work: Arc<dyn RetroWork>,
    pub events: Arc<dyn EventLog>,
    pub clock: Arc<dyn Clock>,
}

#[derive(Clone, Debug, Default)]
pub struct RunInput {
    pub window_days: u32,
    /// Propose only, whatever policy.retro.apply says.
    pub advise: bool,
    /// weekly, threshold or manual.
    pub trigger: &'static str,
    pub threshold_class: Option<String>,
}

pub struct Retro {
    deps: RetroDeps,
    lock: tokio::sync::Mutex<()>,
    /// Threshold checks one at a time, so two incidents landing together start one run, not two.
    threshold_lock: tokio::sync::Mutex<()>,
}

pub fn render_retro_prompt(
    window_days: u32,
    incidents: &[Value],
    playbooks: &[(String, String)],
) -> String {
    let lines: Vec<String> = incidents
        .iter()
        .map(|i| {
            let mut o = serde_json::Map::new();
            o.insert("id".into(), i["incidentId"].clone());
            o.insert("class".into(), i["class"].clone());
            o.insert("at".into(), i["at"].clone());
            if let Some(w) = i.get("workstreamId") {
                o.insert("workstream".into(), w.clone());
            }
            let evidence: Vec<Value> = i["evidence"]
                .as_array()
                .map(|e| e.iter().take(3).cloned().collect())
                .unwrap_or_default();
            o.insert("evidence".into(), Value::Array(evidence));
            Value::Object(o).to_string()
        })
        .collect();
    let books: Vec<String> = playbooks
        .iter()
        .map(|(name, text)| {
            format!(
                "=== {name}.md ===\n{}\n=== end {name}.md ===",
                text.trim_end()
            )
        })
        .collect();
    RETRO_PROMPT
        .replacen("{{windowDays}}", &window_days.to_string(), 1)
        .replacen("{{metrics}}", &METRIC_CLASSES.join(", "), 1)
        .replacen(
            "{{incidents}}",
            &if lines.is_empty() {
                "(none)".to_string()
            } else {
                lines.join("\n")
            },
            1,
        )
        .replacen("{{playbooks}}", &books.join("\n\n"), 1)
}

/// `playbook.<name>.<sha256(diff)[..10]>`.
pub fn gate_ask_key(proposal: &RetroProposal) -> String {
    let hash = Sha256::digest(proposal.diff.as_bytes());
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    format!("{PLAYBOOK_ASK_PREFIX}{}.{}", proposal.playbook, &hex[..10])
}

/// The first Monday 09:00 in `tz` strictly after `after_ms` (cron `0 9 * * 1`).
pub fn next_monday_9(after_ms: i64, tz: Tz) -> i64 {
    let local = tz
        .timestamp_millis_opt(after_ms)
        .single()
        .unwrap_or_else(|| tz.timestamp_millis_opt(0).unwrap());
    let mut day = local.date_naive();
    for _ in 0..15 {
        if day.weekday() == Weekday::Mon
            && let Some(t) = day
                .and_hms_opt(9, 0, 0)
                .and_then(|n| tz.from_local_datetime(&n).earliest())
            && t.timestamp_millis() > after_ms
        {
            return t.timestamp_millis();
        }
        day = day.succ_opt().unwrap_or(day);
    }
    after_ms + 7 * DAY_MS
}

impl Retro {
    fn now_ms(&self) -> i64 {
        system_ms(self.deps.clock.now())
    }

    fn records(&self) -> RetroRecords<'_> {
        RetroRecords(self.deps.db.as_ref())
    }

    pub async fn apply_enabled(&self) -> bool {
        self.deps
            .ledger
            .global_value(APPLY_KEY)
            .await
            .is_some_and(|v| v.to_lowercase() == "true")
    }

    async fn zone(&self) -> Tz {
        self.deps
            .ledger
            .global_value(POLICY_TZ_KEY)
            .await
            .and_then(|t| zone(&t))
            .unwrap_or_else(hub_zone)
    }

    async fn emit(&self, kind: &str, summary: String, data: Value) {
        self.deps
            .events
            .append(NewEvent {
                at: iso(self.now_ms()),
                kind: kind.into(),
                summary,
                data: Some(data),
                ..Default::default()
            })
            .await;
    }

    /// Writes `text` as the playbook's override and records what it replaced.
    async fn apply_text(&self, proposal: RetroProposal, text: &str, now: i64) -> RetroProposal {
        let pb = &self.deps.playbooks;
        let previous_override = pb.override_text(&proposal.playbook);
        let (_, previous_ref) = pb.current(&proposal.playbook);
        let new_ref = match pb.set_override(&proposal.playbook, Some(text)) {
            Err(e) => {
                let stale = RetroProposal {
                    state: "stale".into(),
                    note: Some(clip(&e, 500)),
                    ..proposal
                };
                self.records().put(&stale, None);
                return stale;
            }
            Ok(r) => r,
        };
        let measuring = proposal.kind == "wording";
        let window_ms = i64::from(proposal.metric.window_days) * DAY_MS;
        let baseline = if measuring {
            Some(
                snapshot(
                    self.deps.work.as_ref(),
                    &proposal.playbook,
                    &proposal.metric.class,
                    now - window_ms,
                    now,
                )
                .await,
            )
        } else {
            None
        };
        let applied = RetroProposal {
            state: if measuring { "measuring" } else { "applied" }.into(),
            reference: Some(new_ref.clone()),
            previous_ref: Some(previous_ref.clone()),
            applied_at: Some(iso(now)),
            due_at: measuring.then(|| iso(now + window_ms)),
            baseline: baseline.clone(),
            ..proposal
        };
        self.records()
            .put(&applied, Some(previous_override.as_deref()));
        let mut data = json!({
            "proposalId": applied.proposal_id, "playbook": applied.playbook, "kind": applied.kind,
            "ref": new_ref, "previousRef": previous_ref, "metric": applied.metric,
        });
        if let Some(b) = &baseline {
            data["baseline"] = json!(b);
            data["dueAt"] = json!(applied.due_at);
        }
        self.emit(
            "playbook.changed",
            format!(
                "{}: {} {} change applied ({})",
                applied.proposal_id,
                applied.playbook,
                applied.kind,
                applied.fields.join(", ")
            ),
            data,
        )
        .await;
        applied
    }

    /// A gate change's diff, applied to the playbook as it is now.
    async fn apply_gate(&self, proposal: RetroProposal, now: i64) -> RetroProposal {
        let (text, _) = self.deps.playbooks.current(&proposal.playbook);
        match apply_unified_diff(&text, &proposal.diff) {
            Err(e) => {
                let stale = RetroProposal {
                    state: "stale".into(),
                    note: Some(clip(&format!("approved, but {e}"), 500)),
                    ..proposal
                };
                self.records().put(&stale, None);
                stale
            }
            Ok(patched) => self.apply_text(proposal, &patched, now).await,
        }
    }

    /// A person's answer to a gate ask: "apply" applies it; anything else, or a withdrawal, rejects it.
    async fn on_gate_answer(
        &self,
        stored: StoredProposal,
        decision: Option<String>,
        withdrawn: bool,
    ) -> RetroProposal {
        let proposal = stored.proposal;
        if proposal.state != "asked" {
            return proposal;
        }
        let now = self.now_ms();
        if !withdrawn
            && decision
                .as_deref()
                .is_some_and(|d| d.trim().to_lowercase() == "apply")
        {
            return self.apply_gate(proposal, now).await;
        }
        let note = if withdrawn {
            "the ask was withdrawn".to_string()
        } else {
            clip(
                &format!("answered \"{}\"", decision.unwrap_or_default()),
                500,
            )
        };
        let rejected = RetroProposal {
            state: "rejected".into(),
            note: Some(note),
            ..proposal
        };
        self.records().put(&rejected, None);
        rejected
    }

    /// Catches up on gate asks answered or withdrawn while nothing was listening.
    async fn settle_asks(&self) {
        for stored in self.records().list(Some(&["asked"]), None, 100) {
            let Some(ask_id) = stored.proposal.ask_id.clone() else {
                continue;
            };
            let Some((state, decision_id)) = self.deps.ledger.ask_state(&ask_id).await else {
                continue;
            };
            if state == "open" {
                continue;
            }
            let decision = match decision_id {
                Some(id) => self.deps.ledger.decision_value(&id).await,
                None => None,
            };
            self.on_gate_answer(stored, decision, state == "withdrawn")
                .await;
        }
    }

    pub async fn run(
        &self,
        input: RunInput,
    ) -> Result<(RetroRun, Vec<RetroProposal>), RetroRefused> {
        let _lock = self.lock.lock().await;
        let now = self.now_ms();
        let records = self.records();
        let turned = records.turned_since(now - DAY_MS);
        if turned.len() >= RUNS_PER_DAY {
            return Err(RetroRefused {
                message: format!(
                    "{} retro runs already spent a claude turn in the last 24 h; the budget is {RUNS_PER_DAY} a day.",
                    turned.len()
                ),
                fix: format!("Run it again from {}.", iso(turned[0] + DAY_MS)),
            });
        }
        let advise = input.advise || !self.apply_enabled().await;
        self.settle_asks().await;
        let n = records.begin_run(now, input.trigger, input.threshold_class.as_deref());
        let window_incidents = self
            .deps
            .work
            .incidents(
                now - i64::from(input.window_days) * DAY_MS,
                None,
                PROMPT_INCIDENTS,
            )
            .await;
        let mut done = RetroRun {
            run: n,
            at: iso(now),
            trigger: input.trigger.into(),
            advise,
            window_days: input.window_days,
            incidents: window_incidents.len(),
            proposals: Vec::new(),
            dropped: Vec::new(),
            usage: None,
        };
        if window_incidents.is_empty() {
            records.finish_run(&done, false);
            self.emit(
                "retro.ran",
                format!(
                    "retro run {n}: no incidents in {} d, nothing to propose",
                    input.window_days
                ),
                json!({ "run": n, "trigger": input.trigger, "advise": advise, "proposals": [] }),
            )
            .await;
            return Ok((done, Vec::new()));
        }

        let texts: Vec<(String, String)> = PLAYBOOK_NAMES
            .iter()
            .map(|n| (n.to_string(), self.deps.playbooks.current(n).0))
            .collect();
        let busy: HashMap<String, String> = records
            .list(Some(&HOLDING), None, 100)
            .into_iter()
            .map(|s| {
                (
                    s.proposal.playbook.clone(),
                    format!(
                        "{} on {} is still {}",
                        s.proposal.proposal_id, s.proposal.playbook, s.proposal.state
                    ),
                )
            })
            .collect();
        let prompt = render_retro_prompt(input.window_days, &window_incidents, &texts);
        let (text, run_usage) = self.deps.runner.ask(prompt).await;
        let ctx = Context {
            window_days: input.window_days,
            incidents: window_incidents
                .iter()
                .filter_map(|i| i["incidentId"].as_str().map(str::to_string))
                .collect::<HashSet<_>>(),
            playbooks: texts.iter().cloned().collect(),
            busy,
            parser: self.deps.playbooks.parser(),
        };
        let checked = match &text {
            None => Validated::Error(
                run_usage
                    .error
                    .clone()
                    .unwrap_or_else(|| "the run gave no answer".into()),
            ),
            Some(t) => validate_answer(t, &ctx),
        };
        let (accepted, dropped, usage) = match checked {
            Validated::Error(e) => {
                tracing::warn!(run = n, error = %e, "retro: no usable answer");
                (
                    Vec::new(),
                    Vec::new(),
                    OrchestratorRun {
                        ok: false,
                        error: Some(clip(&e, 300)),
                        ..run_usage
                    },
                )
            }
            Validated::Checked { accepted, dropped } => (accepted, dropped, run_usage),
        };
        for d in &dropped {
            tracing::warn!(run = n, index = d.index, playbook = ?d.playbook, reason = %d.reason, "retro: dropped a proposed change");
        }

        let by_id: HashMap<String, &Value> = window_incidents
            .iter()
            .filter_map(|i| Some((i["incidentId"].as_str()?.to_string(), i)))
            .collect();
        let mut proposals = Vec::new();
        for a in accepted {
            let mut machines: Vec<String> = Vec::new();
            for id in &a.change.fixes_incidents {
                if let Some(m) = by_id
                    .get(id)
                    .and_then(|i| i.pointer("/projectRef/machineId"))
                    .and_then(Value::as_str)
                    && !machines.iter().any(|x| x == m)
                {
                    machines.push(m.to_string());
                }
            }
            let note = (a.change.kind != a.kind).then(|| {
                format!(
                    "the model called it {}; it changes {}, so it is a {} change",
                    a.change.kind,
                    a.fields.join(", "),
                    a.kind
                )
            });
            let inserted = records.insert(
                RetroProposal {
                    proposal_id: String::new(),
                    run: n,
                    at: iso(now),
                    playbook: a.change.playbook.clone(),
                    kind: a.kind.into(),
                    claimed_kind: a.change.kind.clone(),
                    diff: a.change.diff.clone(),
                    fields: a.fields.clone(),
                    fixes_incidents: a.change.fixes_incidents.clone(),
                    metric: a.change.metric.clone(),
                    expected: a.change.expected.clone(),
                    state: if advise { "suggested" } else { "pending" }.into(),
                    ask_id: None,
                    reference: None,
                    previous_ref: None,
                    applied_at: None,
                    due_at: None,
                    baseline: None,
                    measured: None,
                    note,
                },
                &machines,
            );
            proposals.push(if !advise && a.kind == "wording" {
                self.apply_text(inserted, &a.after, now).await
            } else {
                inserted
            });
        }

        done.proposals = proposals.iter().map(|p| p.proposal_id.clone()).collect();
        done.dropped = dropped
            .iter()
            .map(|d| DroppedChange {
                index: d.index,
                playbook: d.playbook.as_deref().map(|p| clip(p, 40)),
                reason: clip(&d.reason, 500),
            })
            .collect();
        done.usage = Some(usage.clone());
        records.finish_run(&done, true);
        let count = proposals.len();
        self.emit(
            "retro.ran",
            format!(
                "retro run {n}: {count} change{} {}, {} dropped",
                if count == 1 { "" } else { "s" },
                if advise { "suggested" } else { "proposed" },
                dropped.len()
            ),
            json!({ "run": n, "trigger": input.trigger, "advise": advise, "proposals": done.proposals, "dropped": dropped.len(), "usage": [usage] }),
        )
        .await;
        Ok((done, proposals))
    }

    /// Newest first; with the machines of the incidents each cites.
    pub fn proposals(&self, state: Option<&str>, limit: usize) -> Vec<StoredProposal> {
        let states = state.map(|s| [s]);
        self.records()
            .list(states.as_ref().map(|s| s.as_slice()), None, limit)
    }

    pub fn last_run(&self) -> Option<RetroRun> {
        self.records().latest_run()
    }

    /// Measures every wording change whose window has ended; keeps or reverts each.
    pub async fn evaluate_due(&self) -> Vec<RetroProposal> {
        let _lock = self.lock.lock().await;
        let now = self.now_ms();
        let mut out = Vec::new();
        for stored in self.records().due(now) {
            let p = stored.proposal.clone();
            let from = p.applied_at.as_deref().and_then(parse_ms).unwrap_or(now);
            let to = p.due_at.as_deref().and_then(parse_ms).unwrap_or(now);
            let measured = snapshot(
                self.deps.work.as_ref(),
                &p.playbook,
                &p.metric.class,
                from,
                to,
            )
            .await;
            let baseline = p.baseline.clone().unwrap_or_else(|| measured.clone());
            match judge(&baseline, &measured) {
                Ok(()) => {
                    let kept = RetroProposal {
                        state: "kept".into(),
                        measured: Some(measured.clone()),
                        ..p.clone()
                    };
                    self.records().put(&kept, None);
                    self.emit(
                        "playbook.kept",
                        format!(
                            "{}: {} wording change kept; {} {} → {}",
                            p.proposal_id,
                            p.playbook,
                            p.metric.class,
                            shown(baseline.target),
                            shown(measured.target)
                        ),
                        json!({ "proposalId": p.proposal_id, "playbook": p.playbook, "ref": p.reference, "baseline": baseline, "measured": measured }),
                    )
                    .await;
                    out.push(kept);
                }
                Err(reason) => {
                    // Only the file this change wrote is rolled back; a playbook edited since is left to whoever edited it.
                    let untouched = self.deps.playbooks.current(&p.playbook).1
                        == p.reference.clone().unwrap_or_default();
                    let suffix = if untouched {
                        let previous = stored.previous_override.clone().flatten();
                        match self
                            .deps
                            .playbooks
                            .set_override(&p.playbook, previous.as_deref())
                        {
                            Err(e) => format!("; restoring the previous file failed: {e}"),
                            Ok(_) => String::new(),
                        }
                    } else {
                        "; the playbook changed since, so the file was left as it is".into()
                    };
                    let note = clip(&format!("{reason}{suffix}"), 500);
                    let reverted = RetroProposal {
                        state: "reverted".into(),
                        measured: Some(measured.clone()),
                        note: Some(note),
                        ..p.clone()
                    };
                    self.records().put(&reverted, None);
                    self.emit(
                        "playbook.reverted",
                        format!("{}: {} wording change reverted: {reason}", p.proposal_id, p.playbook),
                        json!({
                            "proposalId": p.proposal_id, "playbook": p.playbook, "ref": self.deps.playbooks.current(&p.playbook).1,
                            "reason": reason, "baseline": baseline, "measured": measured,
                        }),
                    )
                    .await;
                    if let Some(cited) = self.deps.ledger.incident(&p.fixes_incidents[0]).await {
                        let evidence = format!(
                            "{} changed {} ({}) to fix {}; reverted: {reason}",
                            p.proposal_id,
                            p.playbook,
                            p.fields.join(", "),
                            p.fixes_incidents.join(", ")
                        );
                        self.deps
                            .ledger
                            .record_incident(json!({ "class": "playbook_reverted", "projectRef": cited["projectRef"], "evidence": [evidence] }))
                            .await;
                    }
                    out.push(reverted);
                }
            }
        }
        out
    }

    /// Files one ask per pending gate change, all in the same batch; acts on answers already in the log.
    pub async fn file_gate_asks(&self) -> Vec<RetroProposal> {
        let _lock = self.lock.lock().await;
        let mut out = Vec::new();
        if !self.apply_enabled().await {
            return out;
        }
        let mut pending: Vec<StoredProposal> = self
            .records()
            .list(Some(&["pending"]), None, 50)
            .into_iter()
            .filter(|s| s.proposal.kind == "gate")
            .collect();
        pending.reverse();
        for StoredProposal { proposal: p, .. } in pending {
            let text = clip(
                &format!(
                    "Playbook gate change {}: {} {}. Fixes {}; {} (retro_proposals shows the diff)",
                    p.proposal_id,
                    p.playbook,
                    p.fields.join(", "),
                    p.fixes_incidents.join(", "),
                    p.expected
                ),
                500,
            );
            let input = json!({
                "kind": "decide", "key": gate_ask_key(&p), "class": "product", "text": text, "recommendation": "apply",
                "options": ["apply", "keep as is"], "blocks": "nothing", "proceededOnRec": false,
            });
            match self.deps.ledger.create_ask(input, "retro").await {
                Err(e) => {
                    tracing::warn!(proposal = %p.proposal_id, error = %e, "retro: gate ask not filed")
                }
                Ok(ask_id) => {
                    // Hub-wide asks are never answered from the log, so each one reaches the person.
                    let asked = RetroProposal {
                        state: "asked".into(),
                        ask_id: Some(ask_id),
                        ..p
                    };
                    self.records().put(&asked, None);
                    out.push(asked);
                }
            }
        }
        out
    }

    /// A decision answering one of the retro's gate asks.
    async fn on_decision(&self, event: &HubEvent) {
        let data = event.data.clone().unwrap_or(Value::Null);
        let (Some(ask_id), Some(decision_id)) =
            (data["askId"].as_str(), data["decisionId"].as_str())
        else {
            return;
        };
        if !data["key"]
            .as_str()
            .is_some_and(|k| k.starts_with(PLAYBOOK_ASK_PREFIX))
        {
            return;
        }
        let Some(stored) = self.records().by_ask(ask_id) else {
            return;
        };
        let decision = self.deps.ledger.decision_value(decision_id).await;
        let _lock = self.lock.lock().await;
        self.on_gate_answer(stored, decision, false).await;
    }

    /// Three incidents of one class within a week start a run, once per class per week.
    async fn on_incident(&self, event: &HubEvent) {
        let _lock = self.threshold_lock.lock().await;
        let Some(class) = event
            .data
            .as_ref()
            .and_then(|d| d["class"].as_str())
            .map(str::to_string)
        else {
            return;
        };
        if class == "playbook_reverted" {
            return;
        }
        let since = self.now_ms() - THRESHOLD_DAYS * DAY_MS;
        if self.deps.ledger.incident_count(&class, since).await < THRESHOLD
            || self.records().threshold_since(&class, since)
        {
            return;
        }
        let input = RunInput {
            window_days: DEFAULT_WINDOW_DAYS,
            advise: false,
            trigger: "threshold",
            threshold_class: Some(class.clone()),
        };
        if let Err(refused) = self.run(input).await {
            tracing::warn!(class = %class, reason = %refused.message, "retro: threshold run refused");
        }
    }

    async fn weekly(&self) {
        let input = RunInput {
            window_days: DEFAULT_WINDOW_DAYS,
            advise: false,
            trigger: "weekly",
            threshold_class: None,
        };
        if let Err(refused) = self.run(input).await {
            tracing::warn!(reason = %refused.message, "retro: weekly run refused");
        }
        self.file_gate_asks().await;
    }

    /// Monday 09:00 in policy.tz, and the end of each measuring window. Sleeps at most an hour at a time, so a changed
    /// zone takes effect within the hour; after a long pause it runs once, not once per missed Monday.
    async fn schedule(self: Arc<Self>) {
        let mut after = self.now_ms();
        loop {
            let monday = next_monday_9(after, self.zone().await);
            let due = self.records().next_due_ms().unwrap_or(i64::MAX);
            let now = self.now_ms();
            let next = monday.min(due);
            if now < next {
                self.deps
                    .clock
                    .sleep(Duration::from_millis((next - now).min(3_600_000) as u64))
                    .await;
                continue;
            }
            if now >= due {
                self.evaluate_due().await;
            }
            if now >= monday {
                self.weekly().await;
                after = monday.max(now);
            }
        }
    }

    pub fn new(deps: RetroDeps) -> Arc<Self> {
        Arc::new(Retro {
            deps,
            lock: tokio::sync::Mutex::new(()),
            threshold_lock: tokio::sync::Mutex::new(()),
        })
    }

    /// The weekly and end-of-window scheduler, the threshold trigger and the gate asks' answers. Runs until the hub
    /// stops.
    pub async fn serve(self: Arc<Self>) {
        tokio::spawn(self.clone().schedule());
        let mut cursor = self.deps.events.head().await;
        loop {
            let page = self
                .deps
                .events
                .wait(WaitInput {
                    cursor,
                    types: vec!["decision.recorded", "incident.recorded"],
                    timeout_sec: 3600,
                    ..Default::default()
                })
                .await;
            cursor = page.cursor;
            for event in page.events {
                if event.kind == "decision.recorded" {
                    self.on_decision(&event).await;
                } else {
                    // A run takes a claude turn; it must not hold up the answers behind it.
                    let r = self.clone();
                    tokio::spawn(async move { r.on_incident(&event).await });
                }
            }
        }
    }
}

fn shown(n: Option<f64>) -> String {
    match n {
        None => "null".into(),
        Some(v) if v.fract() == 0.0 => format!("{}", v as i64),
        Some(v) => format!("{v}"),
    }
}
