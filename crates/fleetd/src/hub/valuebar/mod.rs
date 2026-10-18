//! The value bar at spawn time (rules.rs), plus review verdicts: `fleetd review verdict` records one per review task,
//! keyed by its PR and head SHA, which is what later review spawns on that PR are checked against. A judge of a
//! research workstream reports the metric too, and its numbers become the workstream's computed verdict.
//! The tasks area calls `check_spawn` before every spawn.
pub mod pr_heads;
pub mod rules;

use crate::clock::Clock;
use crate::hub::checks::JudgeVerdicts;
use crate::hub::checks::ports::{Ports, Refusal, invalid, not_found};
use crate::hub::incidents::{IncidentInput, Incidents};
use crate::hub::store::{EventLog, HubDb, NewEvent, StoreError, iso_ms, now_ms};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::Workstream;
use fleetd_contracts::tasks::TaskKind;
use fleetd_contracts::verification::{IncidentClass, ReviewVerdict};
use pr_heads::PrHeads;
use rules::{PrVerdict, SpawnRequest, pr_key, review_refusal, write_refusal};
use std::sync::Arc;

pub use pr_heads::GhPrHeads;

/// Who is spawning or recording: the lead's project and its `by` ("lead:<machine>/<project>", "hub:judge", ...).
#[derive(Debug, Clone, PartialEq)]
pub struct Caller {
    pub project_ref: ProjectRef,
    pub by: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordedVerdict {
    pub verdict: ReviewVerdict,
    /// The computed research verdict's text, for a research judge.
    pub research: Option<String>,
}

/// A refusal with an optional fix the rules computed.
fn with_fix_opt(error: Refusal, fix: Option<String>) -> Refusal {
    match fix {
        Some(fix) => error.with_fix(fix),
        None => error,
    }
}

fn same_project(a: &ProjectRef, b: &ProjectRef) -> bool {
    a.machine_id == b.machine_id && a.project_id == b.project_id
}

fn internal(e: StoreError) -> Refusal {
    crate::hub::checks::ports::internal(e)
}

fn kind_name(kind: TaskKind) -> &'static str {
    match kind {
        TaskKind::Write => "write",
        TaskKind::Read => "read",
        TaskKind::Review => "review",
    }
}

pub struct ValueBar {
    db: Arc<HubDb>,
    events: Arc<EventLog>,
    ports: Arc<dyn Ports>,
    incidents: Arc<Incidents>,
    pr_heads: Arc<dyn PrHeads>,
    judges: Arc<JudgeVerdicts>,
    clock: Arc<dyn Clock>,
}

impl ValueBar {
    pub fn new(
        db: Arc<HubDb>,
        events: Arc<EventLog>,
        ports: Arc<dyn Ports>,
        incidents: Arc<Incidents>,
        pr_heads: Arc<dyn PrHeads>,
        judges: Arc<JudgeVerdicts>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            db,
            events,
            ports,
            incidents,
            pr_heads,
            judges,
            clock,
        }
    }

    /// This PR's verdicts, newest first: enough for both rules (any clean verdict on the head, and the last two).
    pub fn verdicts_for(&self, pr: &str) -> Result<Vec<PrVerdict>, StoreError> {
        self.db.with(|conn| {
            let mut stmt = conn.prepare_cached("SELECT task_id, sha, blocking FROM review_verdicts WHERE pr_key = ? ORDER BY n DESC LIMIT 200")?;
            let rows = stmt.query_map([pr_key(pr)], |r| Ok(PrVerdict { task_id: r.get(0)?, sha: r.get(1)?, blocking: r.get(2)? }))?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
    }

    /// Refuses a spawn the value bar rules out. A polish loop is also recorded as an incident.
    pub async fn check_spawn(
        &self,
        caller: &Caller,
        request: &SpawnRequest,
        workstream: &Workstream,
    ) -> Result<(), Refusal> {
        if let Some(write) = write_refusal(request, workstream) {
            return Err(with_fix_opt(invalid(write.message, None), write.fix));
        }
        let pr = if request.kind == TaskKind::Review {
            request.pr.as_deref()
        } else {
            None
        };
        let verdicts = match pr {
            Some(pr) => self.verdicts_for(pr).map_err(internal)?,
            None => vec![],
        };
        // Without GitHub the SHA rule cannot apply; the polish-loop rule still does.
        let head = match pr {
            Some(pr) if !verdicts.is_empty() => match self.pr_heads.head_sha(pr).await {
                Ok(sha) => Some(sha),
                Err(error) => {
                    tracing::warn!(pr, error = %error.message, "value bar: PR head unknown");
                    None
                }
            },
            _ => None,
        };
        // The pinned playbook caps review rounds.
        let max_rounds = workstream
            .playbook
            .as_ref()
            .and_then(|p| self.ports.playbook_limits(p))
            .map(|l| l.max_review_rounds);
        let Some(review) =
            review_refusal(request, &caller.by, head.as_deref(), &verdicts, max_rounds)
        else {
            return Ok(());
        };
        if let Some(lines) = review.polish_loop {
            self.incidents
                .record(IncidentInput {
                    class: IncidentClass::PolishLoop,
                    project_ref: caller.project_ref.clone(),
                    workstream_id: Some(workstream.workstream_id.clone()),
                    task_id: None,
                    evidence: lines,
                })
                .map_err(internal)?;
        }
        Err(with_fix_opt(invalid(review.message, None), review.fix))
    }

    /// `fleetd review verdict`: stores it against the task's PR, emits `review.verdict` and completes a waiting judge
    /// check. The judge of a research workstream must report `metricValues`, and gets the computed verdict back as text.
    pub async fn record_verdict(
        &self,
        caller: &Caller,
        verdict: ReviewVerdict,
    ) -> Result<RecordedVerdict, Refusal> {
        let Some(task) = self
            .ports
            .task(&verdict.task_id)
            .filter(|t| same_project(&t.project_ref, &caller.project_ref))
        else {
            return Err(not_found(
                format!("No task {} in this project.", verdict.task_id),
                Some("Pass --task with your own task id."),
            ));
        };
        if task.kind != TaskKind::Review {
            return Err(invalid(
                format!(
                    "{} is a {} task; only review tasks record verdicts.",
                    task.task_id,
                    kind_name(task.kind)
                ),
                None,
            ));
        }
        // Hub-spawned judges review criteria, not a PR, so they are the review tasks without one.
        let judged = if task.pr.is_none() {
            self.ports.workstream(&task.workstream_id)
        } else {
            None
        };
        let is_research = judged
            .as_ref()
            .and_then(|w| w.playbook.as_ref())
            .is_some_and(|p| p.as_str().starts_with("research@"));
        if verdict.metric_values.is_some() && !is_research {
            return Err(invalid(
                format!(
                    "{} is not the judge of a research workstream; only those report --baseline and --candidate.",
                    task.task_id
                ),
                Some("Leave out --baseline and --candidate."),
            ));
        }
        if is_research && verdict.metric_values.is_none() {
            let metric = judged
                .as_ref()
                .and_then(|w| w.brief.as_ref())
                .and_then(|b| b.metric.as_ref())
                .map_or_else(|| "the brief's metric".to_owned(), |m| format!("\"{m}\""));
            return Err(invalid(
                format!(
                    "{} judges research workstream {}, so its verdict must carry the measured numbers.",
                    task.task_id, task.workstream_id
                ),
                Some(&format!(
                    "Rerun with --baseline <n> --candidate <n>: {metric} measured for the baseline and for the candidate."
                )),
            ));
        }
        let now = now_ms(self.clock.as_ref());
        let data = serde_json::to_string(&verdict).map_err(|e| internal(e.into()))?;
        self.db
            .with(|conn| {
                conn.prepare_cached("INSERT INTO review_verdicts (task_id, pr_key, sha, blocking, at_ms, data) VALUES (?, ?, ?, ?, ?, ?)")?
                    .execute(rusqlite::params![
                        task.task_id.as_str(),
                        task.pr.as_deref().map(pr_key),
                        verdict.pr_head_sha.as_str(),
                        verdict.blocking.get(),
                        now,
                        data
                    ])?;
                Ok(())
            })
            .map_err(internal)?;
        let mut event_data = serde_json::json!({
            "taskId": task.task_id,
            "workstreamId": task.workstream_id,
            "prHeadSha": verdict.pr_head_sha,
            "blocking": verdict.blocking,
            "nonBlocking": verdict.non_blocking,
        });
        if let Some(pr) = &task.pr {
            event_data["pr"] = serde_json::json!(pr);
        }
        self.events
            .append(NewEvent {
                at: fleetd_contracts::ids::Timestamp(iso_ms(now)),
                r#type: HubEventType::ReviewVerdict,
                machine_id: Some(task.project_ref.machine_id.clone()),
                project_id: Some(task.project_ref.project_id.clone()),
                thread_id: task.thread_ref.as_ref().map(|t| t.thread_id.clone()),
                summary: format!(
                    "{} review verdict at {}: {} blocking, {} non-blocking",
                    task.task_id,
                    verdict
                        .pr_head_sha
                        .get(..12)
                        .unwrap_or(&verdict.pr_head_sha),
                    verdict.blocking,
                    verdict.non_blocking
                ),
                data: Some(event_data),
                attention: None,
            })
            .map_err(internal)?;
        // Before the judge check resolves, so the claim that follows finds the workstream already done with its outcome.
        let research = match (is_research, verdict.metric_values.clone()) {
            (true, Some(values)) => Some(
                self.ports
                    .research_verdict(&task.workstream_id, values)
                    .await?,
            ),
            _ => None,
        };
        self.judges.complete(&verdict).await;
        Ok(RecordedVerdict { verdict, research })
    }
}
