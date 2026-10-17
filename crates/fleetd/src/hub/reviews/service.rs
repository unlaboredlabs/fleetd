//! The merge train's review gate. Each time a Change enters `reviewing` the train hands it over with its current patch
//! id; the gate spawns the tier's review tasks through Tasks and answers Pending, or Ready when that patch needs
//! nothing more. Every verdict is bound to the patch id of the head it reviewed, and only verdicts bound to the
//! Change's current patch id count. Blocking findings go back to the author task and the Change waits for a new head,
//! which the train brings back here with its new patch id; M6's polish-loop rule caps those rounds.
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::patch_ids;
use super::rules::{
    FindingsVerdict, Gate, ReviewProvider, ReviewRole, RoleReview, codex_instance,
    findings_message, gate, has_receipts, missing_reviews, needs_no_review, one_line, other_codex,
    review_plan, review_prompt, rule_for,
};
use crate::hub::train::contract::{
    Change, ChangeId, ChangeReview, ChangeState, CommitSha, Count, PatchId, ReviewRule, TaskId,
    tier_str,
};
use crate::hub::train::host::{BoxFut, EventView, PrVerdict, ReviewSpawn, TrainHost};
use crate::hub::train::records::Db;
use crate::hub::train::service::{ReviewGate, Train, Verdict};

/// Recorded as the spawner of review tasks and the sender of findings.
pub const REVIEWS_BY: &str = "hub:reviews";

const FOLLOWED: [&str; 4] = [
    "review.verdict",
    "task.completed",
    "task.failed",
    "task.cancelled",
];

/// One key per PR however its URL is written: host and path, lowercased, `/pulls/` as `/pull/`, no trailing slash.
/// The value bar keys its verdict history the same way (valuebar/rules.ts `prKey`).
pub fn pr_key(url: &str) -> String {
    let url = url.trim();
    let Some((_, rest)) = url
        .split_once("://")
        .filter(|(scheme, rest)| !scheme.is_empty() && !rest.is_empty())
    else {
        return url.to_lowercase();
    };
    let rest = &rest[..rest.find(['?', '#']).unwrap_or(rest.len())];
    let lowered = rest.to_lowercase().replacen("/pulls/", "/pull/", 1);
    lowered.trim_end_matches('/').to_string()
}

pub struct Reviews {
    host: Arc<dyn TrainHost>,
    db: Db,
    train: Weak<Train>,
    lock: tokio::sync::Mutex<()>,
}

struct ReviewerTask {
    change_id: ChangeId,
    role: ReviewRole,
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

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
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
    pub fn start(self: &Arc<Self>) {
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
        });
    }

    /// The review rule for the Change's tier from its workstream's pinned playbook, else the coded one.
    fn rule_of(&self, change: &Change) -> ReviewRule {
        let pinned = self
            .host
            .workstream(&change.workstream_id)
            .and_then(|w| w.playbook);
        let loaded = pinned.as_deref().and_then(|pin| self.host.playbook(pin));
        rule_for(change.tier, loaded.as_ref())
    }

    fn reviewer_task(&self, task_id: &str) -> Option<ReviewerTask> {
        self.conn()
            .query_row(
                "SELECT change_id, role FROM review_tasks WHERE task_id = ?1",
                [task_id],
                |r| {
                    Ok(ReviewerTask {
                        change_id: ChangeId::unchecked(r.get::<_, String>(0)?),
                        role: ReviewRole::parse(&r.get::<_, String>(1)?),
                    })
                },
            )
            .optional()
            .expect("review task")
    }

    fn put_patch(&self, change_id: &ChangeId, sha: &str, patch_id: &str) {
        self.conn()
            .execute("INSERT OR REPLACE INTO review_patch_ids (change_id, head_sha, patch_id) VALUES (?1, ?2, ?3)", params![change_id.as_str(), sha, patch_id])
            .expect("put patch id");
    }

    /// The patch id of `sha`: known from the train for heads it handed over, else computed on the project's machine.
    async fn patch_for(&self, change: &Change, sha: &str) -> Result<String, String> {
        let known: Option<String> = self
            .conn()
            .query_row(
                "SELECT patch_id FROM review_patch_ids WHERE change_id = ?1 AND head_sha = ?2",
                params![change.change_id.as_str(), sha],
                |r| r.get(0),
            )
            .optional()
            .expect("patch id");
        if let Some(known) = known {
            return Ok(known);
        }
        let root = self.host.project_root(&change.project_ref).ok_or_else(|| {
            format!(
                "the hub has no record of project {}",
                change.project_ref.project_id
            )
        })?;
        let train = self.train().ok_or("the train is gone")?;
        let pull = train
            .github()
            .pull(&change.repo, change.pr_number.get())
            .await
            .map_err(|e| e.message)?;
        let patch_id = patch_ids::compute(
            self.host.as_ref(),
            &change.project_ref.machine_id,
            &root,
            &pull.base.ref_,
            change.pr_number.get(),
            sha,
        )
        .await?;
        self.put_patch(&change.change_id, sha, &patch_id);
        Ok(patch_id)
    }

    /// The verdicts bound to `patch_id`, with their roles, as the gate and `mark_ready` take them.
    fn bound_to(&self, change: &Change, patch_id: &str) -> Vec<(ChangeReview, RoleReview)> {
        let rows: Vec<(String, String, i64, i64, String)> = {
            let conn = self.conn();
            let mut stmt = conn
                .prepare_cached(
                    "SELECT b.task_id, b.pr_head_sha, b.blocking, b.non_blocking, t.role
                     FROM review_bindings b JOIN review_tasks t ON t.task_id = b.task_id WHERE t.change_id = ?1 AND b.patch_id = ?2",
                )
                .expect("prepare");
            stmt.query_map(params![change.change_id.as_str(), patch_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .expect("query")
            .map(|r| r.expect("row"))
            .collect()
        };
        rows.into_iter()
            .map(|(task_id, sha, blocking, non_blocking, role)| {
                let role = ReviewRole::parse(&role);
                let receipts = role == ReviewRole::Verifier
                    && has_receipts(self.host.task(&TaskId::unchecked(&task_id)).as_ref());
                let review = ChangeReview {
                    task_id: TaskId::unchecked(&task_id),
                    pr_head_sha: CommitSha::unchecked(sha),
                    patch_id: PatchId::unchecked(patch_id),
                    blocking: Count::unchecked(blocking),
                    non_blocking: Count::unchecked(non_blocking),
                };
                (
                    review,
                    RoleReview {
                        task_id,
                        role,
                        patch_id: patch_id.to_string(),
                        blocking,
                        receipts,
                    },
                )
            })
            .collect()
    }

    fn gate_for(&self, change: &Change, patch_id: &str) -> (Gate, Vec<ChangeReview>) {
        let bound = self.bound_to(change, patch_id);
        let waived: Option<String> = self
            .conn()
            .query_row(
                "SELECT reason FROM review_waivers WHERE change_id = ?1 AND patch_id = ?2",
                params![change.change_id.as_str(), patch_id],
                |r| r.get(0),
            )
            .optional()
            .expect("waiver");
        let roles: Vec<RoleReview> = bound.iter().map(|(_, r)| r.clone()).collect();
        let g = gate(
            change.tier,
            &self.rule_of(change),
            Some(patch_id),
            &roles,
            waived.as_deref(),
        );
        (g, bound.into_iter().map(|(r, _)| r).collect())
    }

    /// Spawns what the tier still needs for this patch. Idempotent per patch; a waived patch needs nothing.
    async fn ensure_round(&self, change: &Change, patch_id: &str) {
        let rule = self.rule_of(change);
        // Codex takes the second reviewer, so it matters only from two reviewers on.
        let wants_codex = rule.reviewers >= 2;
        let instances = if wants_codex {
            self.host
                .provider_instances(&change.project_ref.machine_id)
                .await
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let codex = codex_instance(&instances);
        let spawned: Vec<ReviewRole> = {
            let conn = self.conn();
            let mut stmt = conn
                .prepare_cached(
                    "SELECT role FROM review_tasks WHERE change_id = ?1 AND patch_id = ?2",
                )
                .expect("prepare");
            stmt.query_map(params![change.change_id.as_str(), patch_id], |r| {
                r.get::<_, String>(0)
            })
            .expect("query")
            .map(|r| ReviewRole::parse(&r.expect("row")))
            .collect()
        };
        let missing = missing_reviews(&review_plan(&rule, codex.is_some()), &spawned);
        if missing.is_empty() {
            return;
        }

        // The hub's rounds are held to M6's review rules like anyone's. When the polish-loop rule says review is over
        // for this PR, this patch rides on the earlier clean rounds instead of getting a third.
        let verdicts: Vec<PrVerdict> = {
            let conn = self.conn();
            let mut stmt = conn.prepare_cached("SELECT task_id, sha, blocking FROM review_verdicts WHERE pr_key = ?1 ORDER BY n DESC LIMIT 200").expect("prepare");
            stmt.query_map([pr_key(&change.pr_url)], |r| {
                Ok(PrVerdict {
                    task_id: r.get(0)?,
                    sha: r.get(1)?,
                    blocking: r.get(2)?,
                })
            })
            .expect("query")
            .map(|r| r.expect("row"))
            .collect()
        };
        if let Some(refusal) = self.host.review_refusal(
            &change.workstream_id,
            &change.pr_url,
            &change.head_sha,
            &verdicts,
        ) {
            if refusal.polish_loop {
                let reason = format!("review waived by the polish-loop rule: {}", refusal.message);
                self.conn()
                    .execute(
                        "INSERT OR IGNORE INTO review_waivers (change_id, patch_id, reason) VALUES (?1, ?2, ?3)",
                        params![change.change_id.as_str(), patch_id, reason],
                    )
                    .expect("put waiver");
                return self.note(&change.change_id, &reason);
            }
            return self.note(
                &change.change_id,
                &format!(
                    "no review round for patch {}: {}",
                    &patch_id[..patch_id.len().min(12)],
                    refusal.message
                ),
            );
        }

        if wants_codex && codex.is_none() {
            let others = other_codex(&instances);
            let (machine, tier) = (&change.project_ref.machine_id, change.tier);
            self.note(
                &change.change_id,
                &if others.is_empty() {
                    format!("No usable Codex instance on {machine}, so both {} reviewers run on Claude.", tier_str(tier))
                } else {
                    format!(
                        "Codex {} on {machine} is not fleetd's (ids must start with \"fleetd\"; others could reach T3's spawn tools), so both {} reviewers run on Claude.",
                        others.join(", "),
                        tier_str(tier)
                    )
                },
            );
        }
        let codex_model = codex.map(|(_, model)| model.to_string());
        for planned in missing {
            let verb = if planned.role == ReviewRole::Verifier {
                "Verify"
            } else {
                "Review"
            };
            let spawn = ReviewSpawn {
                project_ref: change.project_ref.clone(),
                by: REVIEWS_BY,
                workstream_id: change.workstream_id.clone(),
                title: one_line(
                    &format!(
                        "{verb} {}#{} for {}",
                        change.repo, change.pr_number, change.change_id
                    ),
                    80,
                ),
                prompt: review_prompt(change, planned.role),
                serves: change.serves.to_string(),
                pr: change.pr_url.to_string(),
                tier: change.tier,
                model: if planned.provider == ReviewProvider::Codex {
                    codex_model.clone()
                } else {
                    None
                },
            };
            let role = planned.role.as_str();
            let task = match self.host.spawn_review(spawn).await {
                Ok(task) => task,
                Err(e) => {
                    self.note(
                        &change.change_id,
                        &format!("could not spawn the {role}: {e}"),
                    );
                    continue;
                }
            };
            // A task T3 refused to launch is not counted, so the next review of this patch tries that role again.
            if task.state == "failed" {
                self.note(
                    &change.change_id,
                    &format!(
                        "the {role} {} failed to start: {}",
                        task.task_id,
                        task.result_tail.unwrap_or_default()
                    ),
                );
                continue;
            }
            self.conn()
                .execute(
                    "INSERT OR IGNORE INTO review_tasks (task_id, change_id, role, patch_id) VALUES (?1, ?2, ?3, ?4)",
                    params![task.task_id.as_str(), change.change_id.as_str(), role, patch_id],
                )
                .expect("put review task");
        }
    }

    async fn review_inner(&self, change: Change) -> Verdict {
        let _held = self.lock.lock().await;
        if needs_no_review(&self.rule_of(&change)) {
            return Verdict::Ready;
        }
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
        let (before, _) = self.gate_for(&change, &patch_id);
        // Ready on this patch already (a carried-over patch), or held by its blocking findings until the head moves.
        if before.ready {
            return Verdict::Ready;
        }
        if before.waiting_for_head {
            return Verdict::Pending;
        }
        self.ensure_round(&change, &patch_id).await;
        if self.gate_for(&change, &patch_id).0.ready {
            Verdict::Ready
        } else {
            Verdict::Pending
        }
    }

    /// Marks the Change ready once its current patch satisfies the tier.
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
        let Some(row) = self.reviewer_task(&task_id) else {
            return Ok(());
        };
        let Some(change) = self.train().and_then(|t| t.records().get(&row.change_id)) else {
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
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO review_bindings (task_id, pr_head_sha, patch_id, blocking, non_blocking) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![task_id, sha, patch_id, blocking, non_blocking],
            )
            .expect("bind verdict");
        // Findings on an older patch were already overtaken by a new head.
        if blocking > 0 && change.patch_id.as_deref() == Some(patch_id.as_str()) {
            let stored: Option<String> = self
                .conn()
                .query_row("SELECT data FROM review_verdicts WHERE task_id = ?1 AND sha = ?2 ORDER BY n DESC LIMIT 1", params![task_id, sha], |r| r.get(0))
                .optional()
                .expect("verdict");
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
                    &row.change_id,
                    &format!("{waiting}; no author task to send them to: {summary}"),
                );
                return Ok(());
            };
            self.note(&row.change_id, &format!("{waiting}; sent to {author}"));
            let text = findings_message(
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
                    &row.change_id,
                    &format!("{waiting}; sending them to {author} failed: {e}"),
                );
            }
            return Ok(());
        }
        self.evaluate(&row.change_id);
        Ok(())
    }

    /// A review task ended: a verifier's receipts are now in, or it ended without the verdict it owed.
    fn on_task_ended(&self, event: &EventView) {
        let task_id = event
            .data
            .get("taskId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(row) = self.reviewer_task(task_id) else {
            return;
        };
        let bound = self
            .conn()
            .query_row(
                "SELECT 1 FROM review_bindings WHERE task_id = ?1 LIMIT 1",
                [task_id],
                |_| Ok(()),
            )
            .optional()
            .expect("bound");
        if bound.is_none() {
            let how = event
                .event_type
                .strip_prefix("task.")
                .unwrap_or(&event.event_type);
            self.note(
                &row.change_id,
                &format!(
                    "the {} {task_id} ended ({how}) without a review verdict",
                    row.role.as_str()
                ),
            );
        }
        self.evaluate(&row.change_id);
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

#[cfg(test)]
mod tests {
    use super::pr_key;

    #[test]
    fn keys_a_pr_however_its_url_is_written() {
        assert_eq!(
            pr_key(" https://GitHub.com/Wynn-Dev/Lab/pulls/7/ "),
            "github.com/wynn-dev/lab/pull/7"
        );
        assert_eq!(
            pr_key("https://github.com/o/r/pull/7?x=1#y"),
            "github.com/o/r/pull/7"
        );
        assert_eq!(pr_key("not a url"), "not a url");
    }
}
