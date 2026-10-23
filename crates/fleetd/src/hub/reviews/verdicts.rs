//! Review verdicts: `fleetd review verdict` records one per review task and head SHA, keyed by its PR too. The train's
//! review gate reads them by task and head, the PR view by PR. A judge of a research workstream reports the metric too, and its numbers become the workstream's
//! computed verdict.
use crate::clock::Clock;
use crate::hub::checks::JudgeVerdicts;
use crate::hub::checks::ports::{Ports, Refusal, internal, invalid, not_found};
use crate::hub::store::{EventLog, HubDb, NewEvent, iso_ms, now_ms};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::tasks::TaskKind;
use fleetd_contracts::verification::ReviewVerdict;
use std::sync::Arc;

/// Who is recording: the lead's project and its `by` ("lead:<machine>/<project>", "hub:judge", ...).
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

fn kind_name(kind: TaskKind) -> &'static str {
    match kind {
        TaskKind::Write => "write",
        TaskKind::Read => "read",
        TaskKind::Review => "review",
    }
}

pub struct Verdicts {
    db: Arc<HubDb>,
    events: Arc<EventLog>,
    ports: Arc<dyn Ports>,
    judges: Arc<JudgeVerdicts>,
    clock: Arc<dyn Clock>,
}

impl Verdicts {
    pub fn new(
        db: Arc<HubDb>,
        events: Arc<EventLog>,
        ports: Arc<dyn Ports>,
        judges: Arc<JudgeVerdicts>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            db,
            events,
            ports,
            judges,
            clock,
        }
    }

    /// Stores the verdict against its task and head, emits `review.verdict` and completes a waiting judge check. The
    /// judge of a research workstream must report `metricValues`, and gets the computed verdict back as text.
    pub async fn record(
        &self,
        caller: &Caller,
        verdict: ReviewVerdict,
    ) -> Result<RecordedVerdict, Refusal> {
        let Some(task) = self.ports.task(&verdict.task_id).filter(|t| {
            t.project_ref.machine_id == caller.project_ref.machine_id
                && t.project_ref.project_id == caller.project_ref.project_id
        }) else {
            return Err(not_found(
                format!("No task {} in this project.", verdict.task_id),
                Some("Pass taskId with your own task id."),
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

/// One key per PR however its URL is written: host and path, lowercased, `/pulls/` as `/pull/`, no trailing slash.
pub fn pr_key(url: &str) -> String {
    let trimmed = url.trim();
    match url::Url::parse(trimmed) {
        Ok(u) if u.has_host() => {
            let host = match u.port() {
                Some(p) => format!("{}:{p}", u.host_str().unwrap_or_default()),
                None => u.host_str().unwrap_or_default().to_owned(),
            };
            format!("{host}{}", u.path())
                .to_lowercase()
                .replacen("/pulls/", "/pull/", 1)
                .trim_end_matches('/')
                .to_owned()
        }
        _ => trimmed.to_lowercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::pr_key;

    #[test]
    fn pr_key_is_one_per_pr() {
        assert_eq!(
            pr_key("https://GitHub.com/Acme/Storefront/pull/7/"),
            "github.com/acme/storefront/pull/7"
        );
        assert_eq!(
            pr_key("https://github.com/acme/storefront/pulls/7?x=1#top"),
            "github.com/acme/storefront/pull/7"
        );
    }
}
