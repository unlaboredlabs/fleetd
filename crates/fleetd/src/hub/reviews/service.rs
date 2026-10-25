//! The merge train's review gate. Each time a Change enters `reviewing` the train hands it over with its current patch
//! id; the gate spawns one fresh blocker-only reviewer for that patch through Tasks and answers Pending, or Ready when
//! a clean verdict is already bound to it. Every verdict is bound to the patch id of the head it reviewed, and only
//! verdicts bound to the Change's current patch id count. Blocking findings go back to the author task and the Change
//! waits for a new head, which the train brings back here with its new patch id.
//!
//! A reviewer that ends without a verdict is replaced, `RETRIES` times per patch, then the lead is told. A reviewer
//! still on an older patch when the Change moves on is stopped, and what it reports later is ignored. A new patch that
//! only drops commits already on the base from an approved head keeps that approval (`carry`).
use std::collections::HashSet;
use std::sync::{Arc, Mutex, Weak};

use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use super::rules::{
    BoundReview, FindingsVerdict, Gate, findings_message, gate, one_line, review_prompt,
};
use crate::hub::leads::events::Event;
use crate::hub::train::contract::{
    Change, ChangeId, ChangeReview, ChangeState, CommitSha, Count, PatchId, TaskId,
};
use crate::hub::train::github::{GhError, TrainGitHub};
use crate::hub::train::host::{BoxFut, EventView, ReviewSpawn, TrainHost};
use crate::hub::train::records::{Db, sql};
use crate::hub::train::service::{ReviewGate, Train, Verdict, lock, short};

/// Recorded as the spawner of review tasks and the sender of findings.
pub const REVIEWS_BY: &str = "hub:reviews";

/// New reviewers started for one patch after one ended without a verdict, before the gate stops and tells the lead.
const RETRIES: usize = 2;
/// The most commits landed on the base since an approved head whose patches are read to find its dropped commits.
const LANDED_MAX: usize = 100;

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
    /// The patches whose approval carry was checked: GitHub is read for it once per patch.
    carry_checked: Mutex<HashSet<(ChangeId, String)>>,
}

/// A review task the gate spawned: the Change, the patch its round was for, and whether a newer patch superseded it.
struct Round {
    change_id: ChangeId,
    patch_id: String,
    superseded: bool,
}

fn ended(state: &str) -> bool {
    matches!(state, "done" | "failed" | "cancelled")
}

impl Reviews {
    pub fn new(host: Arc<dyn TrainHost>, db: Db, train: Weak<Train>) -> Self {
        Self {
            host,
            db,
            train,
            lock: tokio::sync::Mutex::new(()),
            carry_checked: Mutex::default(),
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

    fn round_of(&self, task_id: &str) -> Option<Round> {
        sql(&self.db, |conn| {
            conn.query_row(
                "SELECT change_id, patch_id, role FROM review_tasks WHERE task_id = ?1",
                [task_id],
                |r| {
                    Ok(Round {
                        change_id: ChangeId::unchecked(r.get::<_, String>(0)?),
                        patch_id: r.get(1)?,
                        superseded: r.get::<_, String>(2)? == "superseded",
                    })
                },
            )
            .optional()
            .expect("review task")
        })
    }

    /// The reviewers spawned for this patch of the Change, oldest first.
    fn reviewers(&self, change_id: &ChangeId, patch_id: &str) -> Vec<String> {
        sql(&self.db, |conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT task_id FROM review_tasks WHERE change_id = ?1 AND patch_id = ?2 AND role = 'reviewer' ORDER BY rowid",
                )
                .expect("prepare");
            stmt.query_map(params![change_id.as_str(), patch_id], |r| r.get(0))
                .expect("query")
                .map(|r| r.expect("row"))
                .collect()
        })
    }

    /// Not ended, or not known now: an unread task is never taken for a dead one, so it is never replaced twice.
    fn live(&self, task_id: &str) -> bool {
        self.host
            .task(&TaskId::unchecked(task_id))
            .is_none_or(|t| !ended(&t.state))
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

    /// Spawns a reviewer for this patch; the task id when it started. A reviewer the node refused to start is not
    /// counted, so the next pass tries again.
    async fn spawn_reviewer(&self, change: &Change, patch_id: &str) -> Option<String> {
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
                let why = format!("could not spawn the reviewer: {e}");
                // A closed workstream never gets a reviewer, so waiting in reviewing would stall unseen: the Change
                // leaves the train and the lead hears why.
                let closed = self
                    .host
                    .workstream(&change.workstream_id)
                    .is_some_and(|w| !w.open);
                match self.train().filter(|_| closed) {
                    Some(train) => {
                        let why = format!("{why} Enqueue it for an open workstream to land it.");
                        train.abandon(change, &why).await;
                    }
                    None => self.note(&change.change_id, &why),
                }
                return None;
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
            return None;
        }
        sql(&self.db, |conn| {
            conn
            .execute(
                "INSERT OR IGNORE INTO review_tasks (task_id, change_id, role, patch_id) VALUES (?1, ?2, 'reviewer', ?3)",
                params![task.task_id.as_str(), change.change_id.as_str(), patch_id],
            )
            .expect("put review task")
        });
        Some(task.task_id.to_string())
    }

    /// The Change is at `patch_id` now: its reviewers of an older patch that gave no verdict are stopped, and what
    /// they report later is ignored.
    async fn supersede(&self, change: &Change, patch_id: &str) {
        let stale: Vec<String> = sql(&self.db, |conn| {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT task_id FROM review_tasks t WHERE change_id = ?1 AND patch_id != ?2 AND role = 'reviewer'
                       AND NOT EXISTS (SELECT 1 FROM review_bindings b WHERE b.task_id = t.task_id)",
                )
                .expect("prepare");
            stmt.query_map(params![change.change_id.as_str(), patch_id], |r| r.get(0))
                .expect("query")
                .map(|r| r.expect("row"))
                .collect()
        });
        for task_id in stale {
            sql(&self.db, |conn| {
                conn.execute(
                    "UPDATE review_tasks SET role = 'superseded' WHERE task_id = ?1",
                    [&task_id],
                )
                .expect("supersede review task")
            });
            if !self.live(&task_id) {
                continue;
            }
            let reason = format!(
                "Superseded: {}#{} has a new head {}; its reviewer reviews that.",
                change.repo,
                change.pr_number,
                short(&change.head_sha)
            );
            let id = TaskId::unchecked(&task_id);
            if let Err(e) = self
                .host
                .cancel_task(&change.project_ref, REVIEWS_BY, &id, reason)
                .await
            {
                tracing::warn!(change_id = %change.change_id, task_id, error = %e, "reviews: superseded reviewer not stopped");
            }
        }
    }

    /// Whether the Change's new patch keeps the approval of its last reviewed head, binding it to the new patch when
    /// it does. It does when the new head only drops commits already on the base from that head: the approved head's
    /// last commits, as many as the new head has, make the same patch on the commit below them as the new head makes
    /// on its base, so `git range-diff` shows the PR's own commits unchanged, and the commits below them are on the
    /// base (`on_base`). Any change to the PR's own commits, a conflict resolution included, or a dropped commit the
    /// base lacks, gets a review.
    async fn carry(&self, change: &Change, patch_id: &str) -> Result<bool, String> {
        let approved: Option<(String, String, String, i64)> = sql(&self.db, |conn| {
            conn.query_row(
                "SELECT b.task_id, b.pr_head_sha, b.patch_id, b.non_blocking FROM review_bindings b
                 JOIN review_tasks t ON t.task_id = b.task_id
                 WHERE t.change_id = ?1 AND b.patch_id != ?2 ORDER BY b.rowid DESC LIMIT 1",
                params![change.change_id.as_str(), patch_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .expect("approved head")
        });
        let Some((task_id, approved_head, approved_patch, non_blocking)) = approved else {
            return Ok(false);
        };
        if !self.gate_for(change, &approved_patch).0.ready {
            return Ok(false);
        }
        let train = self.train().ok_or("the train is gone")?;
        let (github, repo) = (train.github(), change.repo.as_str());
        let pull = github
            .pull(repo, change.pr_number.get())
            .await
            .map_err(|e| e.message)?;
        let base = github
            .branch_sha(repo, &pull.base.ref_)
            .await
            .map_err(|e| e.message)?;
        let own = github.range(repo, &base, &change.head_sha).await;
        let reviewed = github.range(repo, &base, &approved_head).await;
        let (Some((_, own)), Some((reviewed_base, reviewed))) = (
            own.map_err(|e| e.message)?,
            reviewed.map_err(|e| e.message)?,
        ) else {
            return Ok(false);
        };
        if own.is_empty() || own.len() > reviewed.len() {
            return Ok(false);
        }
        let dropped = &reviewed[..reviewed.len() - own.len()];
        if !dropped.is_empty()
            && !on_base(github, repo, &base, &reviewed_base, dropped)
                .await
                .map_err(|e| e.message)?
        {
            return Ok(false);
        }
        let below = dropped.last().cloned().unwrap_or(reviewed_base);
        let same = github
            .patch_id_from(repo, &below, &approved_head)
            .await
            .map_err(|e| e.message)?
            == patch_id;
        if same {
            sql(&self.db, |conn| {
                conn
                .execute(
                    "INSERT OR REPLACE INTO review_bindings (task_id, pr_head_sha, patch_id, blocking, non_blocking) VALUES (?1, ?2, ?3, 0, ?4)",
                    params![task_id, change.head_sha.as_str(), patch_id, non_blocking],
                )
                .expect("carry the approval")
            });
            tracing::info!(change_id = %change.change_id, task_id, approved_head, head = %change.head_sha, "reviews: a rebase kept the approval");
        }
        Ok(same)
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
        self.round(&change, &patch_id).await
    }

    /// Where the review of the Change's patch stands, starting what it lacks: a stale reviewer is stopped, a carried
    /// approval or a new reviewer is tried when none was started, and a reviewer that ended without a verdict is
    /// replaced up to `RETRIES` times, then the lead is told. Under the gate's lock.
    async fn round(&self, change: &Change, patch_id: &str) -> Verdict {
        self.supersede(change, patch_id).await;
        let (before, reviews) = self.gate_for(change, patch_id);
        // Ready on this patch already (a carried-over patch), or held by its blocking findings until the head moves.
        if before.ready {
            return Verdict::Ready(reviews);
        }
        if before.waiting_for_head {
            return Verdict::Pending;
        }
        let reviewers = self.reviewers(&change.change_id, patch_id);
        // One still at work owes the verdict.
        if reviewers.iter().any(|t| self.live(t)) {
            return Verdict::Pending;
        }
        let Some(last) = reviewers.last() else {
            if self.carried(change, patch_id).await {
                return Verdict::Ready(self.gate_for(change, patch_id).1);
            }
            self.spawn_reviewer(change, patch_id).await;
            return Verdict::Pending;
        };
        let tries = reviewers.len();
        if tries > RETRIES {
            self.stalled(change, patch_id, last, tries).await;
        } else if let Some(next) = self.spawn_reviewer(change, patch_id).await {
            self.note(
                &change.change_id,
                &format!(
                    "the reviewer {last} ended without a review verdict; {next} reviews it again (retry {tries} of {RETRIES})"
                ),
            );
        }
        Verdict::Pending
    }

    /// `carry`, read from GitHub once per patch unless the read failed.
    async fn carried(&self, change: &Change, patch_id: &str) -> bool {
        let key = (change.change_id.clone(), patch_id.to_string());
        if lock(&self.carry_checked).contains(&key) {
            return false;
        }
        match self.carry(change, patch_id).await {
            Ok(carried) => {
                lock(&self.carry_checked).insert(key);
                carried
            }
            Err(e) => {
                tracing::warn!(change_id = %change.change_id, error = %e, "reviews: approval not carried; reviewing");
                false
            }
        }
    }

    /// The lead hears once, across restarts, that the patch's reviewers keep ending without a verdict, with the last
    /// one's final lines; no more start until a new head.
    async fn stalled(&self, change: &Change, patch_id: &str, last: &str, tries: usize) {
        let first = sql(&self.db, |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO review_stalls (change_id, patch_id) VALUES (?1, ?2)",
                params![change.change_id.as_str(), patch_id],
            )
            .expect("put review stall")
        }) == 1;
        if !first {
            return;
        }
        self.note(
            &change.change_id,
            &format!(
                "the reviewer {last} ended without a review verdict; {tries} reviewers of patch {} did, so no more start until a new head; the lead was told",
                short(patch_id)
            ),
        );
        let tail = self
            .host
            .task(&TaskId::unchecked(last))
            .and_then(|t| t.result_tail)
            .unwrap_or_default();
        let line = Event::PrReviewStalled {
            change: change.change_id.as_str(),
            pr_url: change.pr_url.as_str(),
            task: last,
            tries: tries as i64,
            tail: &tail,
        }
        .render();
        self.host.wake_lead(&change.project_ref, line).await;
    }

    /// The train's pass over a Change still in reviewing at the same head.
    async fn again_inner(&self, change: Change) -> Verdict {
        let _held = self.lock.lock().await;
        match change.patch_id.clone() {
            Some(patch_id) => self.round(&change, &patch_id).await,
            None => Verdict::Pending,
        }
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
        // A reviewer of a patch the Change has moved past was stopped; what it says counts for nothing.
        let Some(change_id) = self
            .round_of(&task_id)
            .filter(|r| !r.superseded)
            .map(|r| r.change_id)
        else {
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
                short(&sha)
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

    /// A review task ended, perhaps without the verdict it owed: then the current patch gets a new reviewer.
    async fn on_task_ended(&self, event: &EventView) {
        let task_id = event
            .data
            .get("taskId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(round) = self.round_of(task_id) else {
            return;
        };
        let change_id = round.change_id.clone();
        let bound = sql(&self.db, |conn| {
            conn.query_row(
                "SELECT 1 FROM review_bindings WHERE task_id = ?1 LIMIT 1",
                [task_id],
                |_| Ok(()),
            )
            .optional()
            .expect("bound")
        });
        self.evaluate(&change_id);
        if bound.is_some() || round.superseded {
            return;
        }
        let how = event
            .event_type
            .strip_prefix("task.")
            .unwrap_or(&event.event_type);
        self.note(
            &change_id,
            &format!("the reviewer {task_id} ended ({how}) without a review verdict"),
        );
        // The Change still waits on this patch's review: a new reviewer, or the lead told.
        let Some(change) = self
            .train()
            .and_then(|t| t.records().get(&change_id))
            .filter(|c| c.state == ChangeState::Reviewing)
            .filter(|c| c.patch_id.as_deref() == Some(round.patch_id.as_str()))
        else {
            return;
        };
        if let Verdict::Ready(_) = self.round(&change, &round.patch_id).await {
            self.evaluate(&change_id);
        }
    }

    async fn handle(&self, event: &EventView) {
        let _held = self.lock.lock().await;
        if event.event_type == "review.verdict" {
            if let Err(e) = self.on_verdict(&event.data).await {
                tracing::warn!(seq = event.seq, error = %e, "reviews: verdict not bound");
            }
        } else {
            self.on_task_ended(event).await;
        }
    }
}

impl ReviewGate for Reviews {
    fn review(&self, change: Change) -> BoxFut<'_, Verdict> {
        Box::pin(self.review_inner(change))
    }

    fn again(&self, change: Change) -> BoxFut<'_, Verdict> {
        Box::pin(self.again_inner(change))
    }
}

/// Whether the approved head's commits `dropped`, below the PR's own, are on `base` already: the last is an ancestor
/// of it (a rebase or merge landed them), or `base` gained since `from`, their merge base, one commit with their
/// patch (a squash landed them) or a commit with each one's patch (they were picked one by one).
async fn on_base(
    github: &TrainGitHub,
    repo: &str,
    base: &str,
    from: &str,
    dropped: &[String],
) -> Result<bool, GhError> {
    let Some(last) = dropped.last() else {
        return Ok(true);
    };
    if github
        .range(repo, base, last)
        .await?
        .is_some_and(|(_, missing)| missing.is_empty())
    {
        return Ok(true);
    }
    let Some((_, landed)) = github.range(repo, from, base).await? else {
        return Ok(false);
    };
    if landed.is_empty() || landed.len() > LANDED_MAX {
        return Ok(false);
    }
    let mut patches = HashSet::new();
    for sha in &landed {
        // A commit with no diff of its own lands nothing.
        if let Ok(patch) = github.commit_patch_id(repo, sha).await {
            patches.insert(patch);
        }
    }
    if patches.contains(&github.patch_id_from(repo, from, last).await?) {
        return Ok(true);
    }
    for sha in dropped {
        if !patches.contains(&github.commit_patch_id(repo, sha).await?) {
            return Ok(false);
        }
    }
    Ok(true)
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
