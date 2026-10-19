//! `judge` checks: the hub spawns a review task that sees only the frozen criteria and the artifacts' refs, never the
//! lead's narrative. The task's `fleetd review verdict` is the result; the value bar hands it over here.
use super::ports::{JudgeSpawn, Ports, Refusal};
use super::utf16_prefix;
use crate::hub::prompts::PromptSet;
use crate::hub::store::{EventLog, WaitInput};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ledger::Workstream;
use fleetd_contracts::tasks::{Task, TaskId, TaskState};
use fleetd_contracts::verification::{CheckOutcome, ClaimId, ReviewVerdict};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, oneshot};

/// Recorded as the spawner of judge tasks.
pub const JUDGE_BY: &str = "hub:judge";

pub struct JudgeInput<'a> {
    pub workstream: &'a Workstream,
    pub claim_id: &'a ClaimId,
    pub check_index: u32,
    pub criteria: &'a str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JudgeOutcome {
    pub result: CheckOutcome,
    pub evidence: String,
}

/// The judge checks waiting on their tasks' verdicts.
#[derive(Default)]
pub struct JudgeVerdicts {
    // Spawning and registering hold this, so a verdict that arrives as soon as the task exists still finds its waiter.
    waiting: Mutex<HashMap<TaskId, oneshot::Sender<ReviewVerdict>>>,
}

impl JudgeVerdicts {
    /// Runs `spawn` and registers a waiter for the task it returns before any verdict for that task is taken.
    pub async fn register<E>(
        &self,
        spawn: impl Future<Output = Result<Task, E>>,
    ) -> Result<(Task, oneshot::Receiver<ReviewVerdict>), E> {
        let mut waiting = self.waiting.lock().await;
        let task = spawn.await?;
        let (tx, rx) = oneshot::channel();
        waiting.insert(task.task_id.clone(), tx);
        Ok((task, rx))
    }

    pub async fn forget(&self, task_id: &TaskId) {
        self.waiting.lock().await.remove(task_id);
    }

    /// Completes the judge check waiting on `verdict.taskId`. False when none is. Every recorded review verdict comes
    /// here; those of ordinary review tasks find no waiter.
    pub async fn complete(&self, verdict: &ReviewVerdict) -> bool {
        match self.waiting.lock().await.remove(&verdict.task_id) {
            Some(tx) => {
                let _ = tx.send(verdict.clone());
                true
            }
            None => false,
        }
    }
}

/// Where the work is, as refs the judge reads for itself: PRs, branches, and the checked-out default branch.
pub fn artifact_lines(tasks: &[Task]) -> Vec<String> {
    let mut lines: Vec<String> = tasks
        .iter()
        .filter_map(|t| {
            let mut refs = Vec::new();
            if let Some(pr) = t.result.as_ref().and_then(|r| r.pr_url.as_ref()) {
                refs.push(format!("PR {pr}"));
            }
            if let Some(branch) = t
                .result
                .as_ref()
                .and_then(|r| r.branch.as_ref())
                .or(t.branch.as_ref())
            {
                refs.push(format!("branch {branch}"));
            }
            (!refs.is_empty()).then(|| format!("- {}: {}", t.task_id, refs.join(", ")))
        })
        .collect();
    lines.push("- the project's default branch, checked out in your workspace".into());
    lines
}

pub fn judge_prompt(set: &PromptSet, input: &JudgeInput<'_>, artifacts: &[String]) -> String {
    let w = input.workstream;
    let brief = w.brief.as_ref();
    // A research judge measures; the hub applies the frozen decision rule to its two numbers, so the rule is not shown.
    let research = w
        .playbook
        .as_ref()
        .is_some_and(|p| p.as_str().starts_with("research@"));
    let named = |v: Option<&str>| v.unwrap_or("named in the criterion").to_owned();
    set.render(
        if research { "judge.research" } else { "judge" },
        &[
            ("workstreamId", &w.workstream_id),
            ("claimId", input.claim_id),
            ("checkIndex", &input.check_index),
            ("criteria", &input.criteria),
            ("artifacts", &artifacts.join("\n")),
            ("metric", &named(brief.and_then(|b| b.metric.as_deref()))),
            (
                "baseline",
                &named(brief.and_then(|b| b.baseline.as_deref())),
            ),
        ],
    )
}

pub fn verdict_outcome(task_id: &TaskId, verdict: &ReviewVerdict) -> JudgeOutcome {
    JudgeOutcome {
        result: if verdict.blocking.get() == 0 {
            CheckOutcome::Pass
        } else {
            CheckOutcome::Fail
        },
        evidence: utf16_prefix(
            &format!(
                "judge {task_id} at {}: {} blocking, {} non-blocking. {}",
                utf16_prefix(&verdict.pr_head_sha, 12),
                verdict.blocking,
                verdict.non_blocking,
                verdict.summary
            ),
            2000,
        )
        .to_owned(),
    }
}

const ENDED: [HubEventType; 3] = [
    HubEventType::TaskCompleted,
    HubEventType::TaskFailed,
    HubEventType::TaskCancelled,
];

pub struct Judges {
    ports: Arc<dyn Ports>,
    events: Arc<EventLog>,
    verdicts: Arc<JudgeVerdicts>,
}

impl Judges {
    pub fn new(ports: Arc<dyn Ports>, events: Arc<EventLog>, verdicts: Arc<JudgeVerdicts>) -> Self {
        Self {
            ports,
            events,
            verdicts,
        }
    }

    /// Resolves with the task's end state ("completed", "failed", "cancelled") from the event log.
    async fn ended(&self, cursor: i64, task_id: &TaskId) -> String {
        let mut after = cursor;
        loop {
            let input = WaitInput {
                cursor: Some(after),
                types: Some(ENDED.to_vec()),
                machine_id: None,
                timeout_sec: 3600,
            };
            let Ok(page) = self.events.wait(input).await else {
                continue;
            };
            after = page.cursor;
            if let Some(end) = page.events.iter().find(|e| {
                e.data
                    .as_ref()
                    .and_then(|d| d.get("taskId"))
                    .and_then(|v| v.as_str())
                    == Some(task_id.as_str())
            }) {
                let name = serde_json::to_value(end.r#type)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default();
                return name.trim_start_matches("task.").to_owned();
            }
        }
    }

    /// Spawns the judge task and waits for its verdict, or for it to end without one. Never fails.
    pub async fn judge(&self, input: JudgeInput<'_>) -> JudgeOutcome {
        let w = input.workstream;
        let cursor = self.events.head();
        let artifacts = artifact_lines(&self.ports.tasks_of(&w.project_ref, &w.workstream_id, 20));
        let spawn = JudgeSpawn {
            project_ref: w.project_ref.clone(),
            workstream_id: w.workstream_id.clone(),
            title: format!(
                "Judge {} done:{} for {}",
                w.workstream_id, input.check_index, input.claim_id
            ),
            prompt: judge_prompt(
                &self.events.db().prompts().current(Some(&w.project_ref)),
                &input,
                &artifacts,
            ),
        };
        let (task, verdict) = match self.verdicts.register(self.ports.spawn_judge(spawn)).await {
            Ok(spawned) => spawned,
            Err(Refusal { message, .. }) => {
                return JudgeOutcome {
                    result: CheckOutcome::Error,
                    evidence: utf16_prefix(
                        &format!("could not start the judge task: {message}"),
                        2000,
                    )
                    .to_owned(),
                };
            }
        };
        if task.state == TaskState::Failed {
            self.verdicts.forget(&task.task_id).await;
            let tail = task.result.as_ref().map(|r| r.tail.as_str()).unwrap_or("");
            return JudgeOutcome {
                result: CheckOutcome::Error,
                evidence: utf16_prefix(
                    &format!("the judge task {} failed to start: {tail}", task.task_id),
                    2000,
                )
                .to_owned(),
            };
        }
        let outcome = tokio::select! {
            Ok(v) = verdict => verdict_outcome(&task.task_id, &v),
            state = self.ended(cursor, &task.task_id) => JudgeOutcome {
                result: CheckOutcome::Error,
                evidence: format!("the judge task {} ended ({state}) without a review verdict (`report`)", task.task_id),
            },
        };
        self.verdicts.forget(&task.task_id).await;
        outcome
    }
}
