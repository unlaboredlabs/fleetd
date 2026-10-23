//! The merge train's review gate. Each time a Change enters `reviewing` the train hands it over with its current patch
//! id; the gate spawns one fresh blocker-only reviewer for that patch through Tasks and answers Pending, or Ready when
//! a clean verdict is already bound to it. Every verdict is bound to the patch id of the head it reviewed, and only
//! verdicts bound to the Change's current patch id count. Blocking findings go back to the author task and the Change
//! waits for a new head, which the train brings back here with its new patch id.
use std::sync::{Arc, Mutex, Weak};

use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use super::rules::{
    BoundReview, FindingsVerdict, Gate, findings_message, gate, one_line, review_prompt,
};
use crate::hub::train::contract::{
    Change, ChangeId, ChangeReview, ChangeState, CommitSha, Count, PatchId, TaskId,
};
use crate::hub::train::host::{BoxFut, EventView, ReviewSpawn, TrainHost};
use crate::hub::train::records::{Db, sql};
use crate::hub::train::service::{ReviewGate, Train, Verdict};

/// Recorded as the spawner of review tasks and the sender of findings.
pub const REVIEWS_BY: &str = "hub:reviews";

const FOLLOWED: [&str; 4] = [
    "review.verdict",
    "task.completed",
    "task.failed",
    "task.cancelled",
];

pub struct Reviews {
    host: Arc<dyn TrainHost>,
    db: Db,
    train: Weak<Train>,
    lock: tokio::sync::Mutex<()>,
}

impl Reviews {
    pub fn new(host: Arc<dyn TrainHost>, db: Db, train: Weak<Train>) -> Self {
        Self {
            host,
            db,
            train,
            lock: tokio::sync::Mutex::new(()),
        }
    }

    fn train(&self) -> Option<Arc<Train>> {
        self.train.upgrade()
    }

    fn note(&self, change_id: &ChangeId, text: &str) {
        if let Some(train) = self.train() {
            train.note(change_id, text);
        }
    }

    /// Follows verdicts and review tasks ending, from now on.
    pub fn start(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        // Read here, not in the task, so nothing appended before the task first runs is missed.
        let from = self.host.events_head();
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut cursor = from;
            loop {
                let Some(reviews) = me.upgrade() else { return };
                let (events, next) = reviews.host.events_wait(cursor, &FOLLOWED, 300).await;
                cursor = next;
                for event in events {
                    reviews.handle(&event).await;
                }
            }
        })
    }

    /// Whether the review gate spawned this task.
    pub fn is_reviewer(&self, task_id: &str) -> bool {
        self.change_of(task_id).is_some()
    }

    /// The Change a review task the gate spawned reviews.
    fn change_of(&self, task_id: &str) -> Option<ChangeId> {
        sql(&self.db, |conn| {
            conn.query_row(
                "SELECT change_id FROM review_tasks WHERE task_id = ?1",
                [task_id],
                |r| Ok(ChangeId::unchecked(r.get::<_, String>(0)?)),
            )
            .optional()
            .expect("review task")
        })
    }

    fn put_patch(&self, change_id: &ChangeId, sha: &str, patch_id: &str) {
        sql(&self.db, |conn| {
            conn
            .execute("INSERT OR REPLACE INTO review_patch_ids (change_id, head_sha, patch_id) VALUES (?1, ?2, ?3)", params![change_id.as_str(), sha, patch_id])
            .expect("put patch id")
        });
    }

    /// The patch id of `sha`: known from the train for heads it handed over, else computed as the train computes it.
    async fn patch_for(&self, change: &Change, sha: &str) -> Result<String, String> {
        let known: Option<String> = sql(&self.db, |conn| {
            conn.query_row(
                "SELECT patch_id FROM review_patch_ids WHERE change_id = ?1 AND head_sha = ?2",
                params![change.change_id.as_str(), sha],
                |r| r.get(0),
            )
            .optional()
            .expect("patch id")
        });
        if let Some(known) = known {
            return Ok(known);
        }
        let train = self.train().ok_or("the train is gone")?;
        let github = train.github();
        let pull = github
            .pull(&change.repo, change.pr_number.get())
            .await
            .map_err(|e| e.message)?;
        let patch_id = github
            .patch_id(&change.repo, &pull.base.ref_, sha)
            .await
            .map_err(|e| e.message)?;
        self.put_patch(&change.change_id, sha, &patch_id);
        Ok(patch_id)
    }

    /// The verdicts bound to `patch_id`, as the gate and `mark_ready` take them.
    fn gate_for(&self, change: &Change, patch_id: &str) -> (Gate, Vec<ChangeReview>) {
        let rows: Vec<(String, String, i64, i64)> = sql(&self.db, |conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT b.task_id, b.pr_head_sha, b.blocking, b.non_blocking
                     FROM review_bindings b JOIN review_tasks t ON t.task_id = b.task_id WHERE t.change_id = ?1 AND b.patch_id = ?2",
                )
                .expect("prepare");
            stmt.query_map(params![change.change_id.as_str(), patch_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .expect("query")
            .map(|r| r.expect("row"))
            .collect()
        });
        let bound: Vec<BoundReview> = rows
            .iter()
            .map(|(task_id, _, blocking, _)| BoundReview {
                task_id: task_id.clone(),
                patch_id: patch_id.to_string(),
                blocking: *blocking,
            })
            .collect();
        let reviews = rows
            .into_iter()
            .map(|(task_id, sha, blocking, non_blocking)| ChangeReview {
                task_id: TaskId::unchecked(task_id),
                pr_head_sha: CommitSha::unchecked(sha),
                patch_id: PatchId::unchecked(patch_id),
                blocking: Count::unchecked(blocking),
                non_blocking: Count::unchecked(non_blocking),
            })
            .collect();
        (gate(patch_id, &bound), reviews)
    }

    /// Spawns this patch's reviewer, once: a reviewer the node refused to start is not counted, so the next pass
    /// tries again.
    async fn ensure_reviewer(&self, change: &Change, patch_id: &str) {
        let spawned = sql(&self.db, |conn| {
            conn.query_row(
                "SELECT 1 FROM review_tasks WHERE change_id = ?1 AND patch_id = ?2 LIMIT 1",
                params![change.change_id.as_str(), patch_id],
                |_| Ok(()),
            )
            .optional()
            .expect("review task")
        });
        if spawned.is_some() {
            return;
        }
        // The newest head an earlier round of this Change reviewed: a re-push is reviewed from its delta.
        let reviewed: Option<String> = sql(&self.db, |conn| {
            conn.query_row(
                "SELECT b.pr_head_sha FROM review_bindings b JOIN review_tasks t ON t.task_id = b.task_id
                 WHERE t.change_id = ?1 AND b.patch_id != ?2 ORDER BY b.rowid DESC LIMIT 1",
                params![change.change_id.as_str(), patch_id],
                |r| r.get(0),
            )
            .optional()
            .expect("reviewed head")
        });
        let spawn = ReviewSpawn {
            project_ref: change.project_ref.clone(),
            by: REVIEWS_BY,
            workstream_id: change.workstream_id.clone(),
            title: one_line(
                &format!(
                    "Review {}#{} for {}",
                    change.repo, change.pr_number, change.change_id
                ),
                80,
            ),
            prompt: review_prompt(
                &self.db.prompts().current(Some(&change.project_ref)),
                change,
                reviewed.as_deref(),
            ),
            pr: change.pr_url.to_string(),
        };
        let task = match self.host.spawn_review(spawn).await {
            Ok(task) => task,
            Err(e) => {
                self.note(
                    &change.change_id,
                    &format!("could not spawn the reviewer: {e}"),
                );
                return;
            }
        };
        if task.state == "failed" {
            self.note(
                &change.change_id,
                &format!(
                    "the reviewer {} failed to start: {}",
                    task.task_id,
                    task.result_tail.unwrap_or_default()
                ),
            );
            return;
        }
        sql(&self.db, |conn| {
            conn
            .execute(
                "INSERT OR IGNORE INTO review_tasks (task_id, change_id, role, patch_id) VALUES (?1, ?2, 'reviewer', ?3)",
                params![task.task_id.as_str(), change.change_id.as_str(), patch_id],
            )
            .expect("put review task")
        });
    }

    async fn review_inner(&self, change: Change) -> Verdict {
        let _held = self.lock.lock().await;
        let patch_id = match &change.patch_id {
            Some(p) => p.to_string(),
            None => match self.patch_for(&change, &change.head_sha).await {
                Ok(p) => p,
                Err(e) => {
                    self.note(&change.change_id, &format!("reviews: {e}"));
                    return Verdict::Pending;
                }
            },
        };
        self.put_patch(&change.change_id, &change.head_sha, &patch_id);
        let (before, reviews) = self.gate_for(&change, &patch_id);
        // Ready on this patch already (a carried-over patch), or held by its blocking findings until the head moves.
        if before.ready {
            return Verdict::Ready(reviews);
        }
        if before.waiting_for_head {
            return Verdict::Pending;
        }
        self.ensure_reviewer(&change, &patch_id).await;
        Verdict::Pending
    }

    /// Marks the Change ready once its current patch has a clean review.
    fn evaluate(&self, change_id: &ChangeId) {
        let Some(train) = self.train() else { return };
        let Some(change) = train.records().get(change_id) else {
            return;
        };
        let Some(patch_id) = change
            .patch_id
            .clone()
            .filter(|_| change.state == ChangeState::Reviewing)
        else {
            return;
        };
        let (g, reviews) = self.gate_for(&change, &patch_id);
        if !g.ready {
            return;
        }
        if let Err(e) = train.mark_ready(change_id, reviews) {
            tracing::warn!(change_id = %change_id, error = %e.message, "reviews: mark ready refused");
        }
    }

    async fn on_verdict(&self, data: &Value) -> Result<(), String> {
        let task_id = data
            .get("taskId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let Some(change_id) = self.change_of(&task_id) else {
            return Ok(());
        };
        let Some(change) = self.train().and_then(|t| t.records().get(&change_id)) else {
            return Ok(());
        };
        let sha = data
            .get("prHeadSha")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let blocking = data.get("blocking").and_then(Value::as_i64).unwrap_or(0);
        let non_blocking = data.get("nonBlocking").and_then(Value::as_i64).unwrap_or(0);
        let patch_id = self.patch_for(&change, &sha).await?;
        sql(&self.db, |conn| {
            conn
            .execute(
                "INSERT OR REPLACE INTO review_bindings (task_id, pr_head_sha, patch_id, blocking, non_blocking) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![task_id, sha, patch_id, blocking, non_blocking],
            )
            .expect("bind verdict")
        });
        // Findings on an older patch were already overtaken by a new head.
        if blocking > 0 && change.patch_id.as_deref() == Some(patch_id.as_str()) {
            let stored: Option<String> = sql(&self.db, |conn| {
                conn
                .query_row("SELECT data FROM review_verdicts WHERE task_id = ?1 AND sha = ?2 ORDER BY n DESC LIMIT 1", params![task_id, sha], |r| r.get(0))
                .optional()
                .expect("verdict")
            });
            let summary = stored
                .and_then(|d| serde_json::from_str::<Value>(&d).ok())
                .and_then(|v| v.get("summary").and_then(Value::as_str).map(String::from))
                .unwrap_or_else(|| "(the verdict had no summary)".into());
            let waiting = format!(
                "waiting for a new head: {task_id} found {blocking} blocking at {}",
                &sha[..sha.len().min(12)]
            );
            let Some(author) = &change.task_id else {
                self.note(
                    &change_id,
                    &format!("{waiting}; no author task to send them to: {summary}"),
                );
                return Ok(());
            };
            self.note(&change_id, &format!("{waiting}; sent to {author}"));
            let text = findings_message(
                &self
                    .db
                    .prompts()
                    .for_task(&change.project_ref, author.as_str()),
                &change,
                &FindingsVerdict {
                    task_id: &task_id,
                    pr_head_sha: &sha,
                    blocking,
                    non_blocking,
                    summary: &summary,
                },
            );
            if let Err(e) = self
                .host
                .message_task(&change.project_ref, REVIEWS_BY, author, text)
                .await
            {
                self.note(
                    &change_id,
                    &format!("{waiting}; sending them to {author} failed: {e}"),
                );
            }
            return Ok(());
        }
        self.evaluate(&change_id);
        Ok(())
    }

    /// A review task ended, perhaps without the verdict it owed.
    fn on_task_ended(&self, event: &EventView) {
        let task_id = event
            .data
            .get("taskId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(change_id) = self.change_of(task_id) else {
            return;
        };
        let bound = sql(&self.db, |conn| {
            conn.query_row(
                "SELECT 1 FROM review_bindings WHERE task_id = ?1 LIMIT 1",
                [task_id],
                |_| Ok(()),
            )
            .optional()
            .expect("bound")
        });
        if bound.is_none() {
            let how = event
                .event_type
                .strip_prefix("task.")
                .unwrap_or(&event.event_type);
            self.note(
                &change_id,
                &format!("the reviewer {task_id} ended ({how}) without a review verdict"),
            );
        }
        self.evaluate(&change_id);
    }

    async fn handle(&self, event: &EventView) {
        let _held = self.lock.lock().await;
        if event.event_type == "review.verdict" {
            if let Err(e) = self.on_verdict(&event.data).await {
                tracing::warn!(seq = event.seq, error = %e, "reviews: verdict not bound");
            }
        } else {
            self.on_task_ended(event);
        }
    }
}

impl ReviewGate for Reviews {
    fn review(&self, change: Change) -> BoxFut<'_, Verdict> {
        Box::pin(self.review_inner(change))
    }
}

/// The train with its review gate: the gate holds the train's handle, so it can mark Changes ready.
pub fn build(
    host: Arc<dyn TrainHost>,
    clock: Arc<dyn crate::clock::Clock>,
    db: Db,
    gh: Arc<dyn crate::hub::train::github::GhRunner>,
    options: crate::hub::train::service::TrainOptions,
) -> (Arc<Train>, Arc<Reviews>) {
    let slot: Mutex<Option<Arc<Reviews>>> = Mutex::new(None);
    let train = Train::new(host.clone(), clock, db.clone(), gh, options, |me| {
        let reviews = Arc::new(Reviews::new(host, db, me));
        *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(reviews.clone());
        reviews
    });
    let reviews = slot
        .into_inner()
        .unwrap_or_else(|e| e.into_inner())
        .expect("the gate was built");
    (train, reviews)
}
