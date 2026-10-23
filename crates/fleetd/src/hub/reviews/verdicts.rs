//! Review verdicts: `fleetd review verdict` records one per review task and head SHA, keyed by its PR too. The train's
//! review gate reads them by task and head, the PR view by PR.
use crate::clock::Clock;
use crate::hub::checks::ports::{Ports, Refusal, internal, invalid, not_found};
use crate::hub::store::{EventLog, HubDb, NewEvent, iso_ms, now_ms};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::tasks::{TaskId, TaskKind};
use fleetd_contracts::verification::ReviewVerdict;
use std::sync::Arc;

/// Who is recording: the lead's project and its `by` ("lead:<machine>/<project>", "hub:judge", ...), and the task when
/// the call comes from a task's session.
#[derive(Debug, Clone, PartialEq)]
pub struct Caller {
    pub project_ref: ProjectRef,
    pub by: String,
    pub task: Option<TaskId>,
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
    clock: Arc<dyn Clock>,
}

impl Verdicts {
    pub fn new(
        db: Arc<HubDb>,
        events: Arc<EventLog>,
        ports: Arc<dyn Ports>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            db,
            events,
            ports,
            clock,
        }
    }

    /// Stores the verdict against its task and head and emits `review.verdict`. A task's session records its own
    /// verdict, and the head it reviewed is filled in when left out.
    pub async fn record(
        &self,
        caller: &Caller,
        mut verdict: ReviewVerdict,
    ) -> Result<ReviewVerdict, Refusal> {
        let task_id = match (&caller.task, verdict.task_id.take()) {
            (Some(own), Some(named)) if *own != named => {
                return Err(invalid(
                    format!("You are {own}, so you record only your own verdict, not {named}'s."),
                    Some("Leave out taskId."),
                ));
            }
            (Some(own), _) => own.clone(),
            (None, Some(named)) => named,
            (None, None) => {
                return Err(invalid(
                    "Name the review task whose verdict this is.",
                    Some("Pass taskId."),
                ));
            }
        };
        let Some(task) = self.ports.task(&task_id).filter(|t| {
            t.project_ref.machine_id == caller.project_ref.machine_id
                && t.project_ref.project_id == caller.project_ref.project_id
        }) else {
            return Err(not_found(
                format!("No task {task_id} in this project."),
                Some("Pass taskId with a review task of your project."),
            ));
        };
        verdict.task_id = Some(task_id);
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
        if verdict.pr_head_sha.is_none() {
            verdict.pr_head_sha = self.ports.reviewed_head(&task).await;
        }
        let sha = verdict.pr_head_sha.as_ref().map_or("", |s| s.as_str());
        let now = now_ms(self.clock.as_ref());
        let data = serde_json::to_string(&verdict).map_err(|e| internal(e.into()))?;
        self.db
            .with(|conn| {
                conn.prepare_cached("INSERT INTO review_verdicts (task_id, pr_key, sha, blocking, at_ms, data) VALUES (?, ?, ?, ?, ?, ?)")?
                    .execute(rusqlite::params![
                        task.task_id.as_str(),
                        task.pr.as_deref().map(pr_key),
                        sha,
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
                    "{} review verdict{}: {} blocking, {} non-blocking",
                    task.task_id,
                    sha.get(..12)
                        .map(|s| format!(" at {s}"))
                        .unwrap_or_default(),
                    verdict.blocking,
                    verdict.non_blocking
                ),
                data: Some(event_data),
                attention: None,
            })
            .map_err(internal)?;
        Ok(verdict)
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

    use super::{Caller, Verdicts};
    use crate::clock::{Clock, SystemClock};
    use crate::hub::checks::ports::{BoxFuture, Ports};
    use crate::hub::store::{EventLog, HubDb};
    use fleetd_contracts::tasks::{Task, TaskId};
    use fleetd_contracts::verification::{CommitSha, ReviewVerdict};
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Fake {
        tasks: Mutex<HashMap<TaskId, Task>>,
        /// The head `reviewed_head` answers.
        head: Mutex<Option<CommitSha>>,
    }

    impl Ports for Fake {
        fn task(&self, id: &TaskId) -> Option<Task> {
            self.tasks.lock().unwrap().get(id).cloned()
        }
        fn reviewed_head<'a>(&'a self, _: &'a Task) -> BoxFuture<'a, Option<CommitSha>> {
            let head = self.head.lock().unwrap().clone();
            Box::pin(async move { head })
        }
    }

    /// From a task's session a verdict is that task's, with the head the hub knows it reviewed; a task can't record
    /// another's, and a call from no session must name its task.
    #[tokio::test]
    async fn a_review_task_records_its_own_verdict_and_the_hub_fills_its_head() {
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let db = HubDb::open_memory().unwrap();
        let events = Arc::new(EventLog::new(db.clone(), clock.clone()).unwrap());
        let ports = Arc::new(Fake::default());
        for id in ["T4", "T5"] {
            let task: Task = serde_json::from_value(json!({
                "taskId": id, "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "workstreamId": "W1",
                "title": "review", "kind": "review", "prompt": "review it", "areas": [], "state": "running",
                "attempt": 1, "createdAt": "2026-10-17T10:00:00.000Z", "pr": "https://github.com/o/r/pull/7",
            }))
            .unwrap();
            ports
                .tasks
                .lock()
                .unwrap()
                .insert(task.task_id.clone(), task);
        }
        let head = CommitSha::unchecked("a".repeat(40));
        *ports.head.lock().unwrap() = Some(head.clone());
        let dyn_ports: Arc<dyn Ports> = ports.clone();
        let verdicts = Verdicts::new(db, events, dyn_ports, clock);
        let verdict = |task: Option<&str>| -> ReviewVerdict {
            serde_json::from_value(
                json!({ "taskId": task, "blocking": 1, "nonBlocking": 0, "summary": "a.rs:3 leaks" }),
            )
            .unwrap()
        };
        let from = |task: Option<&str>| Caller {
            project_ref: serde_json::from_value(json!({ "machineId": "lab-a", "projectId": "p1" }))
                .unwrap(),
            by: "lead:lab-a/p1".into(),
            task: task.map(TaskId::unchecked),
        };

        let recorded = verdicts
            .record(&from(Some("T4")), verdict(None))
            .await
            .unwrap();
        assert_eq!(
            (recorded.task_id, recorded.pr_head_sha),
            (Some(TaskId::unchecked("T4")), Some(head))
        );
        let other = verdicts
            .record(&from(Some("T4")), verdict(Some("T5")))
            .await
            .unwrap_err();
        assert!(
            other.message.contains("only your own verdict"),
            "{}",
            other.message
        );
        let unnamed = verdicts
            .record(&from(None), verdict(None))
            .await
            .unwrap_err();
        assert_eq!(unnamed.fix.as_deref(), Some("Pass taskId."));
        assert!(
            verdicts
                .record(&from(None), verdict(Some("T5")))
                .await
                .is_ok()
        );
    }
}
