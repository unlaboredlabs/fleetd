//! The merge train: only fleetd merges. One serial train per repo takes the oldest ready Change, rebases it onto the
//! latest base in a hub-owned worktree on the project's machine, waits for CI on that exact head, posts
//! `fleetd/train=success` and squash-merges pinned to the head. Conflicts and red CI go back to the task that wrote
//! the code; a merge goes to the lead inline. A freeze decision holds the train; merges it did not do are incidents.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Notify;

use super::contract::{
    Change, ChangeEnqueueCall, ChangeId, ChangeReview, ChangeState, CommitSha, Count, GitHubPrUrl,
    GitHubRepo, NonEmpty, Positive, ProjectRef, Serves, Timestamp, TrainState, last_error,
    parse_pr_url, state_str, tier_str,
};
use super::git::{GitError, Rebase, TrainGit, default_worktree};
use super::github::{CheckRun, GhError, GhRunner, MergeOutcome, Pull, TrainGitHub};
use super::host::{BoxFut, IncidentInput, TrainHost};
use super::records::{ChangeRecords, Db, HEAD_STATES, ListFilter, QUEUED_STATES};
use super::rules::{Refusal, check_source, check_tier, freeze_key, is_frozen_value};
use super::time::{iso, millis, parse_iso};
use crate::clock::Clock;
use fleetd_contracts::prim::Text;

/// Recorded as the sender of the train's task messages.
pub const TRAIN_BY: &str = "hub:train";

/// A refusal in the lead/tool error shape `{ code, message, fix? }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrainError {
    /// "invalid" or "not_found".
    pub code: &'static str,
    pub message: String,
    pub fix: Option<String>,
}

impl TrainError {
    fn new(code: &'static str, message: impl Into<String>, fix: Option<&str>) -> Self {
        Self {
            code,
            message: message.into(),
            fix: fix.map(String::from),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Ready,
    Pending,
}

/// The port between the train and reviews. The train calls `review` whenever a Change enters `reviewing`: on
/// enqueue, when its author pushed a new patch, and when a rebase changed its patch id. The gate answers Ready when
/// the tier needs nothing more for this patch id, or Pending and later calls `Train::mark_ready`.
pub trait ReviewGate: Send + Sync + 'static {
    fn review(&self, change: Change) -> BoxFut<'_, Verdict>;
}

pub type WorktreeFor = Arc<dyn Fn(&str) -> String + Send + Sync>;

#[derive(Clone)]
pub struct TrainOptions {
    /// Between CI polls and between idle passes.
    pub poll_interval: Duration,
    /// How long CI may take on a rebased head.
    pub ci_timeout: Duration,
    /// How often merged PRs are checked for bypasses.
    pub bypass_every: Duration,
    /// Merges GitHub refuses (405/409) before the train gives up on a Change.
    pub merge_attempts: u32,
    /// Run each repo's loop in the background; tests drive `step` themselves.
    pub auto_run: bool,
    /// Where a project's train worktree lives, from its checkout.
    pub worktree_for: WorktreeFor,
}

impl Default for TrainOptions {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(15),
            ci_timeout: Duration::from_secs(30 * 60),
            bypass_every: Duration::from_secs(60),
            merge_attempts: 3,
            auto_run: true,
            worktree_for: Arc::new(default_worktree),
        }
    }
}

const GREEN: [&str; 3] = ["success", "neutral", "skipped"];

fn is_red(run: &CheckRun) -> bool {
    run.status == "completed" && !GREEN.contains(&run.conclusion.as_deref().unwrap_or(""))
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(12)]
}

fn error_text(text: &str) -> Text<0, 2000> {
    last_error(if text.chars().count() > 2000 {
        format!("{}…", text.chars().take(1999).collect::<String>())
    } else {
        text.to_string()
    })
}

enum CiOutcome {
    Green,
    Red(Vec<CheckRun>),
    Timeout,
}

enum TakeError {
    Gh(GhError),
    Git(GitError),
}

impl From<GhError> for TakeError {
    fn from(e: GhError) -> Self {
        TakeError::Gh(e)
    }
}

impl From<GitError> for TakeError {
    fn from(e: GitError) -> Self {
        TakeError::Git(e)
    }
}

type RepoLocks = Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>;

pub struct Train {
    me: Weak<Train>,
    host: Arc<dyn TrainHost>,
    clock: Arc<dyn Clock>,
    records: ChangeRecords,
    github: TrainGitHub,
    gate: Arc<dyn ReviewGate>,
    options: TrainOptions,
    /// Row updates re-read the Change under this lock, so a slow pass never overwrites a newer state.
    rows: Mutex<()>,
    /// One user of a repo's train worktree at a time: the loop's rebase, an enqueue's patch id.
    git_locks: RepoLocks,
    /// One pass of a repo's loop at a time.
    step_locks: RepoLocks,
    kicks: Mutex<HashMap<String, Arc<Notify>>>,
    loops: Mutex<HashSet<String>>,
    recovered: Mutex<HashSet<String>>,
    last_bypass_check: Mutex<HashMap<String, i64>>,
    merge_refusals: Mutex<HashMap<ChangeId, u32>>,
    /// The follower and every repo loop, aborted by `stop`.
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn repo_lock(locks: &RepoLocks, repo: &str) -> Arc<tokio::sync::Mutex<()>> {
    lock(locks).entry(repo.to_string()).or_default().clone()
}

impl Train {
    /// `gate` gets the train's own handle, so a gate that marks Changes ready (reviews) can hold it.
    pub fn new(
        host: Arc<dyn TrainHost>,
        clock: Arc<dyn Clock>,
        db: Db,
        gh: Arc<dyn GhRunner>,
        options: TrainOptions,
        gate: impl FnOnce(Weak<Train>) -> Arc<dyn ReviewGate>,
    ) -> Arc<Train> {
        Arc::new_cyclic(|me| Train {
            me: me.clone(),
            gate: gate(me.clone()),
            host,
            clock,
            records: ChangeRecords::new(db),
            github: TrainGitHub::new(gh),
            options,
            rows: Mutex::new(()),
            git_locks: Mutex::default(),
            step_locks: Mutex::default(),
            kicks: Mutex::default(),
            loops: Mutex::default(),
            recovered: Mutex::default(),
            last_bypass_check: Mutex::default(),
            merge_refusals: Mutex::default(),
            tasks: Mutex::default(),
        })
    }

    pub fn records(&self) -> &ChangeRecords {
        &self.records
    }

    pub fn github(&self) -> &TrainGitHub {
        &self.github
    }

    pub fn host(&self) -> &dyn TrainHost {
        self.host.as_ref()
    }

    /// Stops the follower and every repo loop.
    pub fn stop(&self) {
        for task in lock(&self.tasks).drain(..) {
            task.abort();
        }
    }

    /// Follows `task.completed` for auto-enqueue and starts the loop of every known train.
    pub fn start(self: &Arc<Self>) {
        // The cursor is read here, not in the task, so nothing appended before the task first runs is missed.
        let from = self.host.events_head();
        let me = Arc::downgrade(self);
        let follower = tokio::spawn(async move {
            let mut cursor = from;
            loop {
                let Some(train) = me.upgrade() else { return };
                let (events, next) = train
                    .host
                    .events_wait(cursor, &["task.completed"], 300)
                    .await;
                cursor = next;
                for event in events {
                    train.on_task_completed(&event.data).await;
                }
            }
        });
        lock(&self.tasks).push(follower);
        for train in self.records.trains() {
            self.ensure_loop(&train.repo);
        }
    }

    fn now_ms(&self) -> i64 {
        millis(self.clock.now())
    }

    fn now_iso(&self) -> Timestamp {
        Timestamp(iso(self.clock.now()))
    }

    fn emit(
        &self,
        project_ref: &ProjectRef,
        event_type: &'static str,
        summary: String,
        data: Value,
    ) {
        self.host
            .append_event(project_ref, event_type, summary, data);
    }

    async fn wake_lead(&self, project_ref: &ProjectRef, line: String) {
        self.host.wake_lead(project_ref, line).await;
    }

    /// Applies `next` to the stored Change if it is still in one of `from` (any state when None); else does nothing.
    fn update(
        &self,
        change_id: &ChangeId,
        from: Option<&[ChangeState]>,
        next: impl FnOnce(Change) -> Change,
    ) -> Option<Change> {
        let _rows = lock(&self.rows);
        let current = self.records.get(change_id)?;
        if from.is_some_and(|from| !from.contains(&current.state)) {
            return None;
        }
        let mut changed = next(current);
        changed.updated_at = self.now_iso();
        self.records.put(&changed);
        Some(changed)
    }

    fn positioned(&self, changes: Vec<Change>) -> Vec<Change> {
        let mut queues: HashMap<String, Vec<ChangeId>> = HashMap::new();
        for c in &changes {
            if !queues.contains_key(c.repo.as_str()) {
                queues.insert(
                    c.repo.to_string(),
                    self.records
                        .in_train(&c.repo, QUEUED_STATES)
                        .into_iter()
                        .map(|c| c.change_id)
                        .collect(),
                );
            }
        }
        changes
            .into_iter()
            .map(|mut c| {
                c.position = queues
                    .get(c.repo.as_str())
                    .and_then(|q| q.iter().position(|id| *id == c.change_id))
                    .map(|p| Count::unchecked(p as i64));
                c
            })
            .collect()
    }

    fn one(&self, change: Change) -> Change {
        self.positioned(vec![change]).remove(0)
    }

    fn git_for(
        &self,
        change: &Change,
    ) -> Result<(TrainGit<'_>, Arc<tokio::sync::Mutex<()>>), GitError> {
        let project_ref = self
            .records
            .train(&change.repo)
            .map(|t| t.project_ref)
            .unwrap_or_else(|| change.project_ref.clone());
        let root = self.host.project_root(&project_ref).ok_or_else(|| {
            GitError(format!(
                "no project {} on {} to run git in",
                project_ref.project_id, project_ref.machine_id
            ))
        })?;
        let git = TrainGit {
            host: self.host.as_ref(),
            machine_id: project_ref.machine_id.clone(),
            worktree: (self.options.worktree_for)(&root),
            root,
        };
        Ok((git, repo_lock(&self.git_locks, &change.repo)))
    }

    fn kick(&self, repo: &str) {
        if let Some(waiting) = lock(&self.kicks).get(repo) {
            waiting.notify_one();
        }
    }

    /// The author task gets it as a task message; without one, or if that fails, the lead gets it.
    async fn tell_author(&self, change: &Change, text: String) {
        if let Some(task_id) = &change.task_id {
            match self
                .host
                .message_task(&change.project_ref, TRAIN_BY, task_id, text.clone())
                .await
            {
                Ok(()) => return,
                Err(e) => {
                    tracing::warn!(change_id = %change.change_id, task_id = %task_id, error = %e, "train: author not messaged")
                }
            }
        }
        self.wake_lead(
            &change.project_ref,
            format!("{} ({}): {text}", change.change_id, change.pr_url),
        )
        .await;
    }

    fn set_ready(&self, change: &Change, reviews: Vec<ChangeReview>) -> Option<Change> {
        let from = [
            ChangeState::Queued,
            ChangeState::Reviewing,
            ChangeState::NeedsRebase,
            ChangeState::CiFailed,
        ];
        let ready = self.update(&change.change_id, Some(&from), |mut c| {
            c.last_error = None;
            c.state = ChangeState::Ready;
            c.reviews.extend(reviews);
            c
        })?;
        self.emit(
            &ready.project_ref,
            "change.ready",
            format!(
                "{} ready for the train: {}#{}",
                ready.change_id, ready.repo, ready.pr_number
            ),
            json!({ "changeId": ready.change_id }),
        );
        self.kick(&ready.repo);
        Some(ready)
    }

    /// Hands a Change in `reviewing` to the gate; the tier may need nothing more, making it ready at once.
    async fn to_gate(&self, change: Change) {
        if self.gate.review(change.clone()).await == Verdict::Ready {
            self.set_ready(&change, Vec::new());
        }
    }

    /// Reads the PR branch's head and patch id. A new Change goes to the gate. A parked one (needs_rebase, ci_failed)
    /// whose patch is unchanged keeps its reviews and goes back on the queue; a new patch is reviewed again.
    async fn admit(&self, change: &Change, pull: &Pull) -> Result<(), GitError> {
        let (git, git_lock) = self.git_for(change)?;
        let seen = {
            let _held = git_lock.lock().await;
            git.inspect(&pull.base.ref_, &change.branch).await?
        };
        let same_patch = change.patch_id.as_deref() == Some(seen.patch_id.as_str());
        if same_patch && change.state != ChangeState::Queued {
            let moved = self.update(&change.change_id, Some(&[change.state]), |mut c| {
                c.head_sha = seen.head_sha.clone();
                c
            });
            if let Some(moved) = moved
                && moved.state != ChangeState::Reviewing
                && moved.state != ChangeState::Ready
            {
                self.set_ready(&moved, Vec::new());
            }
            return Ok(());
        }
        let reviewing = self.update(&change.change_id, Some(&[change.state]), |mut c| {
            c.last_error = None;
            c.head_sha = seen.head_sha;
            c.patch_id = Some(seen.patch_id);
            c.state = ChangeState::Reviewing;
            c
        });
        if let Some(reviewing) = reviewing {
            self.to_gate(reviewing).await;
        }
        Ok(())
    }

    async fn abandon(&self, change: &Change, why: &str) {
        let done = self.update(&change.change_id, Some(&[change.state]), |mut c| {
            c.state = ChangeState::Abandoned;
            c.last_error = Some(last_error(why));
            c
        });
        if done.is_some() {
            self.wake_lead(
                &change.project_ref,
                format!(
                    "{} left the train: {} {why}.",
                    change.change_id, change.pr_url
                ),
            )
            .await;
        }
    }

    async fn finish_merged(&self, change: &Change, merged_sha: Option<&str>) {
        let sha = merged_sha.map(str::to_lowercase);
        let Some(merged) = self.update(&change.change_id, None, |mut c| {
            c.last_error = None;
            c.state = ChangeState::Merged;
            if let Some(sha) = &sha {
                c.merged_sha = Some(CommitSha::unchecked(sha.clone()));
            }
            c
        }) else {
            return;
        };
        lock(&self.merge_refusals).remove(&change.change_id);
        let as_sha = sha
            .as_deref()
            .map(|s| format!(" as {}", short(s)))
            .unwrap_or_default();
        let mut data = json!({ "changeId": merged.change_id, "repo": merged.repo, "prNumber": merged.pr_number });
        if let Some(sha) = &sha {
            data["mergedSha"] = json!(sha);
        }
        self.emit(
            &merged.project_ref,
            "pr.merged",
            format!(
                "{} merged: {}#{}{as_sha}",
                merged.change_id, merged.repo, merged.pr_number
            ),
            data,
        );
        let by = merged
            .task_id
            .as_ref()
            .map(|t| format!(", by {t}"))
            .unwrap_or_default();
        self.wake_lead(
            &merged.project_ref,
            format!(
                "{} merged by the train: {}{as_sha} (tier {}, serves {}{by}).",
                merged.change_id,
                merged.pr_url,
                tier_str(merged.tier),
                merged.serves
            ),
        )
        .await;
    }

    async fn needs_rebase(&self, change: &Change, base: &str, paths: &[String], output: &str) {
        let why = if paths.is_empty() {
            format!("does not rebase onto origin/{base}: {output}")
        } else {
            format!("conflicts with origin/{base} in {}", paths.join(", "))
        };
        let Some(parked) = self.update(
            &change.change_id,
            Some(&[ChangeState::Rebasing]),
            |mut c| {
                c.state = ChangeState::NeedsRebase;
                c.last_error = Some(error_text(&why));
                c
            },
        ) else {
            return;
        };
        self.emit(
            &change.project_ref,
            "change.needs_rebase",
            format!("{} needs a rebase: {why}", change.change_id),
            json!({ "changeId": change.change_id, "paths": paths.iter().take(50).collect::<Vec<_>>() }),
        );
        self.tell_author(
            &parked,
            format!(
                "The merge train could not rebase your PR {} ({}): it {why}. Rebase {} onto origin/{base}, resolve the conflicts, push, and stop; the train takes the new head by itself.",
                change.pr_url, change.change_id, change.branch
            ),
        )
        .await;
    }

    async fn ci_failed(&self, change: &Change, failing: &[CheckRun], timed_out: bool) {
        let names: Vec<String> = failing
            .iter()
            .map(|r| {
                format!(
                    "{} ({})",
                    r.name,
                    r.conclusion.as_deref().unwrap_or(&r.status)
                )
            })
            .collect();
        let log_url = failing.iter().find_map(|r| r.html_url.clone());
        let why = if timed_out {
            format!(
                "CI on {} did not finish within {} min",
                short(&change.head_sha),
                (self.options.ci_timeout.as_millis() as f64 / 60_000.0).round()
            )
        } else {
            let log = log_url
                .as_ref()
                .map(|u| format!(" (log: {u})"))
                .unwrap_or_default();
            format!(
                "CI failed on {}: {}{log}",
                short(&change.head_sha),
                names.join(", ")
            )
        };
        let Some(parked) = self.update(&change.change_id, Some(&[ChangeState::Ci]), |mut c| {
            c.state = ChangeState::CiFailed;
            c.last_error = Some(error_text(&why));
            c
        }) else {
            return;
        };
        let mut data = json!({ "changeId": change.change_id, "checks": failing.iter().map(|r| r.name.clone()).collect::<Vec<_>>() });
        if let Some(url) = &log_url {
            data["logUrl"] = json!(url);
        }
        self.emit(
            &change.project_ref,
            "change.ci_failed",
            format!("{} {why}", change.change_id),
            data,
        );
        self.tell_author(
            &parked,
            format!(
                "The merge train did not merge your PR {} ({}): {why}. Fix it on {}, push, and stop; the train retries the new head by itself.",
                change.pr_url, change.change_id, change.branch
            ),
        )
        .await;
    }

    /// Polls the head's check runs until all are done, one is red, or the timeout passes.
    async fn wait_ci(&self, repo: &str, sha: &str) -> CiOutcome {
        let start = self.now_ms();
        loop {
            let runs = match self.github.check_runs(repo, sha).await {
                Ok(runs) => runs,
                Err(e) => {
                    tracing::warn!(repo, sha, error = %e.message, "train: check runs not read");
                    Vec::new()
                }
            };
            let red: Vec<CheckRun> = runs.iter().filter(|r| is_red(r)).cloned().collect();
            if !red.is_empty() {
                return CiOutcome::Red(red);
            }
            if !runs.is_empty() && runs.iter().all(|r| r.status == "completed") {
                return CiOutcome::Green;
            }
            if self.now_ms() - start >= self.options.ci_timeout.as_millis() as i64 {
                return CiOutcome::Timeout;
            }
            self.clock.sleep(self.options.poll_interval).await;
        }
    }

    /// A pass that could not finish: the Change goes back first in line with the reason, and the loop retries later.
    fn put_back(&self, change: &Change, why: &str) {
        tracing::warn!(change_id = %change.change_id, why, "train: pass failed");
        let from = [
            ChangeState::Ready,
            ChangeState::Rebasing,
            ChangeState::Ci,
            ChangeState::Merging,
        ];
        let back = self.update(&change.change_id, Some(&from), |mut c| {
            c.state = ChangeState::Ready;
            c.last_error = Some(error_text(why));
            c
        });
        if back.is_some() {
            self.records.to_front(&change.change_id);
        }
    }

    /// The head of a ready Change moved: the same patch stays ready, a new one goes back to review.
    async fn ready_moved(&self, change: &Change, pull: &Pull) -> Result<(), GitError> {
        let (git, git_lock) = self.git_for(change)?;
        let seen = {
            let _held = git_lock.lock().await;
            git.inspect(&pull.base.ref_, &change.branch).await?
        };
        if change.patch_id.as_deref() == Some(seen.patch_id.as_str()) {
            self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
                c.head_sha = seen.head_sha;
                c
            });
            return Ok(());
        }
        let reviewing = self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
            c.head_sha = seen.head_sha;
            c.patch_id = Some(seen.patch_id);
            c.state = ChangeState::Reviewing;
            c
        });
        if let Some(reviewing) = reviewing {
            self.to_gate(reviewing).await;
        }
        Ok(())
    }

    /// Rebase, push, CI, status, pinned merge: one ready Change.
    async fn take(&self, change: &Change) {
        match self.take_inner(change).await {
            Ok(()) => {}
            Err(TakeError::Gh(e)) => self.put_back(change, &format!("GitHub: {}", e.message)),
            Err(TakeError::Git(e)) => self.put_back(change, &format!("git: {}", e.0)),
        }
    }

    async fn take_inner(&self, change: &Change) -> Result<(), TakeError> {
        let repo = &change.repo;
        let pull = self.github.pull(repo, change.pr_number.get()).await?;
        if pull.merged {
            self.abandon(change, "was merged outside the train").await;
            return Ok(());
        }
        if pull.state != "open" {
            self.abandon(change, "was closed").await;
            return Ok(());
        }
        if pull.head.sha.to_lowercase() != change.head_sha.as_str() {
            return Ok(self.ready_moved(change, &pull).await?);
        }
        let Some(rebasing) =
            self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
                c.state = ChangeState::Rebasing;
                c
            })
        else {
            return Ok(());
        };
        let base = pull.base.ref_.as_str();

        enum Outcome {
            Rebase(Rebase),
            PushRejected(String),
        }
        let (git, git_lock) = self.git_for(change)?;
        let outcome = {
            let _held = git_lock.lock().await;
            match git.rebase(base, &change.branch).await? {
                Rebase::Rebased {
                    remote_head,
                    head_sha,
                    patch_id,
                } if head_sha.as_str() != remote_head => {
                    match git.push(&change.branch, &remote_head).await? {
                        Ok(()) => Outcome::Rebase(Rebase::Rebased {
                            remote_head,
                            head_sha,
                            patch_id,
                        }),
                        Err(output) => Outcome::PushRejected(output),
                    }
                }
                other => Outcome::Rebase(other),
            }
        };
        let (head_sha, patch_id) = match outcome {
            Outcome::Rebase(Rebase::Conflict { paths, output, .. }) => {
                self.needs_rebase(&rebasing, base, &paths, &output).await;
                return Ok(());
            }
            Outcome::PushRejected(output) => {
                self.put_back(
                    &rebasing,
                    &format!("push refused, the branch moved: {output}"),
                );
                return Ok(());
            }
            Outcome::Rebase(Rebase::Rebased {
                head_sha, patch_id, ..
            }) => (head_sha, patch_id),
        };
        if Some(patch_id.as_str()) != rebasing.patch_id.as_deref() {
            // Reviews are bound to the patch id; a rebase that changed it needs them again.
            let reviewing = self.update(
                &change.change_id,
                Some(&[ChangeState::Rebasing]),
                |mut c| {
                    c.head_sha = head_sha.clone();
                    c.patch_id = Some(patch_id.clone());
                    c.state = ChangeState::Reviewing;
                    c.last_error = Some(last_error(format!(
                        "the rebase onto origin/{base} changed the patch id; it needs review again"
                    )));
                    c
                },
            );
            if let Some(reviewing) = reviewing {
                self.to_gate(reviewing).await;
            }
            return Ok(());
        }

        let Some(in_ci) = self.update(
            &change.change_id,
            Some(&[ChangeState::Rebasing]),
            |mut c| {
                c.head_sha = head_sha.clone();
                c.state = ChangeState::Ci;
                c
            },
        ) else {
            return Ok(());
        };
        match self.wait_ci(repo, &head_sha).await {
            CiOutcome::Green => {}
            CiOutcome::Red(failing) => {
                self.ci_failed(&in_ci, &failing, false).await;
                return Ok(());
            }
            CiOutcome::Timeout => {
                self.ci_failed(&in_ci, &[], true).await;
                return Ok(());
            }
        }

        let Some(merging) = self.update(&change.change_id, Some(&[ChangeState::Ci]), |mut c| {
            c.state = ChangeState::Merging;
            c
        }) else {
            return Ok(());
        };
        self.github
            .post_train_status(
                repo,
                &head_sha,
                &format!("{}: rebased onto {base}, CI green", change.change_id),
            )
            .await?;
        let (status, message) = match self
            .github
            .merge(repo, change.pr_number.get(), &head_sha)
            .await?
        {
            MergeOutcome::Merged { sha } => {
                self.finish_merged(&merging, Some(&sha)).await;
                return Ok(());
            }
            MergeOutcome::Refused { status, message } => (status, message),
        };

        let refusals = {
            let mut map = lock(&self.merge_refusals);
            let n = map.entry(change.change_id.clone()).or_default();
            *n += 1;
            *n
        };
        let why = format!("GitHub refused the merge (HTTP {status}): {message}");
        if refusals < self.options.merge_attempts {
            // Usually the base moved between CI and the merge: rebase again, first in line.
            self.update(&change.change_id, Some(&[ChangeState::Merging]), |mut c| {
                c.state = ChangeState::Ready;
                c.last_error = Some(error_text(&why));
                c
            });
            self.records.to_front(&change.change_id);
            return Ok(());
        }
        lock(&self.merge_refusals).remove(&change.change_id);
        self.update(&change.change_id, Some(&[ChangeState::Merging]), |mut c| {
            c.state = ChangeState::CiFailed;
            c.last_error = Some(error_text(&format!(
                "{why}; gave up after {refusals} tries"
            )));
            c
        });
        self.wake_lead(
            &change.project_ref,
            format!(
                "{} ({}) was not merged: {why}. The train gave up after {refusals} tries; check the repo's merge settings.",
                change.change_id, change.pr_url
            ),
        )
        .await;
        Ok(())
    }

    /// Changes waiting on something outside the train: a patch id to read, reviews, or the author's next push.
    async fn refresh(&self, repo: &str) {
        let waiting = [
            ChangeState::Queued,
            ChangeState::Reviewing,
            ChangeState::NeedsRebase,
            ChangeState::CiFailed,
        ];
        for change in self.records.in_train(repo, &waiting) {
            let pull = match self.github.pull(repo, change.pr_number.get()).await {
                Ok(pull) => pull,
                Err(e) => {
                    tracing::warn!(change_id = %change.change_id, error = %e.message, "train: refresh failed");
                    continue;
                }
            };
            if pull.merged {
                self.abandon(&change, "was merged outside the train").await;
            } else if pull.state != "open" {
                self.abandon(&change, "was closed").await;
            } else if (change.state == ChangeState::Queued
                || pull.head.sha.to_lowercase() != change.head_sha.as_str())
                && let Err(GitError(e)) = self.admit(&change, &pull).await
            {
                self.update(&change.change_id, Some(&[change.state]), |mut c| {
                    c.last_error = Some(error_text(&format!("git: {e}")));
                    c
                });
            }
        }
    }

    /// After a restart: a Change the train was merging is finished if GitHub merged it, else put back first in line.
    async fn recover(&self, repo: &str) {
        for change in self.records.in_train(repo, HEAD_STATES) {
            match self.github.pull(repo, change.pr_number.get()).await {
                Ok(pull) if pull.merged && change.state == ChangeState::Merging => {
                    self.finish_merged(&change, pull.merge_commit_sha.as_deref())
                        .await
                }
                _ => self.put_back(&change, "the hub restarted while the train worked on it"),
            }
        }
        lock(&self.recovered).insert(repo.to_string());
    }

    async fn check_bypasses(&self, repo: &str, watch_since_ms: i64, project_ref: &ProjectRef) {
        let now = self.now_ms();
        {
            let mut last = lock(&self.last_bypass_check);
            if last
                .get(repo)
                .is_some_and(|l| now - l < self.options.bypass_every.as_millis() as i64)
            {
                return;
            }
            last.insert(repo.to_string(), now);
        }
        let merged = match self.github.merged_pulls(repo).await {
            Ok(merged) => merged,
            Err(e) => return tracing::warn!(repo, error = %e.message, "train: bypass check failed"),
        };
        for pr in merged {
            // Date.parse of an unreadable time is NaN, which is never before the watch start.
            if parse_iso(&pr.merged_at).is_some_and(|at| at < watch_since_ms) {
                continue;
            }
            let change = self.records.latest_for(repo, pr.number);
            if change
                .as_ref()
                .is_some_and(|c| c.state == ChangeState::Merged)
            {
                continue;
            }
            if !self.records.mark_bypass(repo, pr.number) {
                continue;
            }
            let sha = pr
                .merge_sha
                .as_deref()
                .map(|s| format!(" ({})", short(s)))
                .unwrap_or_default();
            self.host.record_incident(IncidentInput {
                class: "policy_bypass",
                project_ref: change
                    .as_ref()
                    .map(|c| c.project_ref.clone())
                    .unwrap_or_else(|| project_ref.clone()),
                workstream_id: change.as_ref().map(|c| c.workstream_id.clone()),
                task_id: change.as_ref().and_then(|c| c.task_id.clone()),
                evidence: vec![
                    format!(
                        "{repo}#{} was merged at {} without the merge train{sha}.",
                        pr.number, pr.merged_at
                    ),
                    match &change {
                        None => "No Change was ever enqueued for it.".to_string(),
                        Some(c) => {
                            format!("Its Change {} was {}.", c.change_id, state_str(c.state))
                        }
                    },
                ],
            });
        }
    }

    /// Holds the train while `policy.freeze.<owner>.<name>` is true; announces each change of that.
    fn frozen(&self, repo: &str, was_frozen: bool, project_ref: &ProjectRef) -> bool {
        let decision = self.host.resolve_decision(&freeze_key(repo), project_ref);
        let now = decision.as_ref().is_some_and(|d| is_frozen_value(&d.value));
        if now != was_frozen {
            self.records.set_frozen(repo, now);
            match decision.filter(|_| now) {
                Some(d) => {
                    let reason = d
                        .why
                        .clone()
                        .unwrap_or_else(|| format!("{} {} = {}", d.decision_id, d.key, d.value));
                    self.emit(
                        project_ref,
                        "train.frozen",
                        format!("Train for {repo} frozen: {reason}"),
                        json!({ "repo": repo, "reason": reason }),
                    );
                }
                None => self.emit(
                    project_ref,
                    "train.resumed",
                    format!("Train for {repo} resumed"),
                    json!({ "repo": repo }),
                ),
            }
        }
        now
    }

    /// One pass of the repo's loop: refresh waiting Changes, check bypasses and the freeze, then take one ready
    /// Change through to merged or parked. True when it took one.
    pub async fn step(&self, raw_repo: &str) -> bool {
        let repo = raw_repo.to_lowercase();
        let step_lock = repo_lock(&self.step_locks, &repo);
        let _held = step_lock.lock().await;
        let Some(train) = self.records.train(&repo) else {
            return false;
        };
        if !lock(&self.recovered).contains(&repo) {
            self.recover(&repo).await;
        }
        self.refresh(&repo).await;
        self.check_bypasses(&repo, train.watch_since_ms, &train.project_ref)
            .await;
        if self.frozen(&repo, train.frozen, &train.project_ref) {
            return false;
        }
        let Some(next) = self
            .records
            .in_train(&repo, &[ChangeState::Ready])
            .into_iter()
            .next()
        else {
            return false;
        };
        self.take(&next).await;
        true
    }

    fn ensure_loop(&self, repo: &str) {
        if !self.options.auto_run || !lock(&self.loops).insert(repo.to_string()) {
            return;
        }
        let notify = lock(&self.kicks)
            .entry(repo.to_string())
            .or_default()
            .clone();
        let (me, repo) = (self.me.clone(), repo.to_string());
        let task = tokio::spawn(async move {
            loop {
                let Some(train) = me.upgrade() else { return };
                let pass = {
                    let (train, repo) = (train.clone(), repo.clone());
                    // Its own task, so a panic in one pass is logged and the loop goes on, as TS caught every defect.
                    tokio::spawn(async move { train.step(&repo).await }).await
                };
                let took = pass.unwrap_or_else(|e| {
                    tracing::warn!(repo, error = %e, "train: pass failed");
                    false
                });
                if !took {
                    let (clock, poll) = (train.clock.clone(), train.options.poll_interval);
                    drop(train);
                    tokio::select! {
                        () = clock.sleep(poll) => {}
                        () = notify.notified() => {}
                    }
                }
            }
        });
        lock(&self.tasks).push(task);
    }

    async fn refuse(
        &self,
        project_ref: &ProjectRef,
        pr_url: &str,
        refusal: Refusal,
        row: Option<Change>,
    ) -> TrainError {
        if let Some(mut row) = row {
            let at = self.now_iso();
            row.state = ChangeState::Refused;
            row.last_error = Some(error_text(&format!(
                "{} Fix: {}",
                refusal.message, refusal.fix
            )));
            row.created_at = at.clone();
            row.updated_at = at;
            self.records.create(row);
        }
        self.emit(
            project_ref,
            "change.refused",
            format!("Refused {pr_url}: {}", refusal.message),
            json!({ "prUrl": pr_url, "fix": refusal.fix }),
        );
        TrainError::new(
            "invalid",
            format!("The train refused {pr_url}: {}", refusal.message),
            Some(&refusal.fix),
        )
    }

    /// Validates the PR (`Source:`, tier) and puts it on its repo's train; the same open PR returns its Change.
    pub async fn enqueue(
        &self,
        project_ref: &ProjectRef,
        input: ChangeEnqueueCall,
    ) -> Result<Change, TrainError> {
        let Some(parsed) = parse_pr_url(&input.pr_url) else {
            return Err(TrainError::new(
                "invalid",
                format!("{} is not a github.com pull request URL.", input.pr_url),
                Some("Pass https://github.com/<owner>/<name>/pull/<n>."),
            ));
        };
        let (repo, pr_number) = (parsed.repo.to_lowercase(), parsed.pr_number);
        let pr_url = format!("https://github.com/{repo}/pull/{pr_number}");
        let task = input.task_id.as_ref().and_then(|id| self.host.task(id));
        if let Some(task_id) = &input.task_id
            && !task.as_ref().is_some_and(|t| t.project_ref == *project_ref)
        {
            return Err(TrainError::new(
                "not_found",
                format!("No task {task_id} in this project."),
                Some("Run `fleetd task list`."),
            ));
        }
        if let Some(existing) = self.records.open_for(&repo, pr_number) {
            self.kick(&repo);
            return Ok(self.one(existing));
        }

        let Some(workstream_id) = input
            .workstream_id
            .clone()
            .or_else(|| task.as_ref().map(|t| t.workstream_id.clone()))
        else {
            let refusal = Refusal::new(
                "It names no workstream.",
                "pass --task T<n> (the write task that opened it) or --workstream W<n>",
            );
            return Err(self.refuse(project_ref, &pr_url, refusal, None).await);
        };
        let Some(workstream) = self
            .host
            .workstream(&workstream_id)
            .filter(|w| w.project_ref == *project_ref)
        else {
            return Err(TrainError::new(
                "not_found",
                format!("No workstream {workstream_id} in this project."),
                Some("Use a workstream id from your digest."),
            ));
        };
        let Some(brief) = workstream.brief.clone() else {
            let refusal = Refusal::new(
                format!("{workstream_id} has no brief, so it has no tier or done-when."),
                format!(
                    "register its brief with `fleetd brief create --workstream {workstream_id}` first"
                ),
            );
            return Err(self.refuse(project_ref, &pr_url, refusal, None).await);
        };

        let pull = self.github.pull(&repo, pr_number).await.map_err(|e| {
            TrainError::new(
                "invalid",
                format!("Could not read {pr_url} from GitHub: {}", e.message),
                Some("Check the URL; the hub reads PRs with its own `gh` login."),
            )
        })?;
        let expected = input
            .serves
            .as_ref()
            .map(|s| s.to_string())
            .or_else(|| task.as_ref().and_then(|t| t.serves.clone()));
        let require_source = workstream
            .playbook
            .as_deref()
            .and_then(|pin| self.host.playbook(pin))
            .is_none_or(|p| p.require_source);
        let source = check_source(
            pull.body.as_deref(),
            expected.as_deref(),
            &workstream_id,
            brief.done_when,
            require_source,
        );
        let now = self.now_iso();
        let row_of = |serves: &str| Change {
            change_id: ChangeId::unchecked("X0"),
            project_ref: project_ref.clone(),
            repo: GitHubRepo::unchecked(repo.clone()),
            pr_number: Positive::unchecked(pr_number),
            pr_url: GitHubPrUrl::unchecked(pr_url.clone()),
            branch: NonEmpty::unchecked(pull.head.ref_.clone()),
            task_id: input.task_id.clone(),
            workstream_id: workstream_id.clone(),
            serves: Serves::unchecked(serves),
            tier: brief.tier,
            head_sha: CommitSha::unchecked(pull.head.sha.to_lowercase()),
            patch_id: None,
            state: ChangeState::Queued,
            reviews: Vec::new(),
            position: None,
            last_error: None,
            merged_sha: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        // With no serves to record, a refusal writes no row; with one, the refused Change is kept for the record.
        let serves = match source {
            Ok(serves) => serves,
            Err(refusal) => {
                let row = expected.as_deref().map(row_of);
                return Err(self.refuse(project_ref, &pr_url, refusal, row).await);
            }
        };
        let row = row_of(&serves);
        if pull.merged || pull.state != "open" {
            let what = if pull.merged {
                "already merged".to_string()
            } else {
                pull.state.clone()
            };
            return Err(self
                .refuse(
                    project_ref,
                    &pr_url,
                    Refusal::new(format!("It is {what}."), "enqueue an open PR"),
                    Some(row),
                )
                .await);
        }
        if pull
            .head
            .repo
            .as_ref()
            .map(|r| r.full_name.to_lowercase())
            .as_deref()
            != Some(repo.as_str())
        {
            let refusal = Refusal::new(
                "Its branch lives in another repository.",
                format!("push the branch to {repo} and open the PR from there"),
            );
            return Err(self.refuse(project_ref, &pr_url, refusal, Some(row)).await);
        }
        let tier = match check_tier(brief.tier, input.tier, task.as_ref().and_then(|t| t.tier)) {
            Ok(tier) => tier,
            Err(refusal) => {
                return Err(self.refuse(project_ref, &pr_url, refusal, Some(row)).await);
            }
        };

        self.records.ensure_train(&repo, project_ref, self.now_ms());
        let at = self.now_iso();
        let change = self.records.create(Change {
            tier,
            state: ChangeState::Queued,
            created_at: at.clone(),
            updated_at: at,
            ..row
        });
        self.emit(
            project_ref,
            "change.queued",
            format!(
                "{} queued: {repo}#{} (tier {}, {serves})",
                change.change_id,
                change.pr_number,
                tier_str(change.tier)
            ),
            json!({ "changeId": change.change_id, "repo": repo, "prNumber": change.pr_number }),
        );
        // Reading the patch id needs the machine; if that fails, the loop retries it from `queued`.
        if let Err(GitError(e)) = self.admit(&change, &pull).await {
            self.update(&change.change_id, Some(&[ChangeState::Queued]), |mut c| {
                c.last_error = Some(error_text(&format!("git: {e}")));
                c
            });
        }
        self.ensure_loop(&repo);
        self.kick(&repo);
        Ok(self.one(
            self.records
                .get(&change.change_id)
                .expect("the Change just created"),
        ))
    }

    /// Reviews satisfied the tier for the Change's current patch id; it may be taken. For the review gate.
    pub fn mark_ready(
        &self,
        change_id: &ChangeId,
        reviews: Vec<ChangeReview>,
    ) -> Result<Change, TrainError> {
        let Some(change) = self.records.get(change_id) else {
            return Err(TrainError::new(
                "not_found",
                format!("No change {change_id}."),
                None,
            ));
        };
        if change.state != ChangeState::Reviewing {
            return Err(TrainError::new(
                "invalid",
                format!("{change_id} is {}, not reviewing.", state_str(change.state)),
                None,
            ));
        }
        let stale: Vec<&ChangeReview> = reviews
            .iter()
            .filter(|r| Some(r.patch_id.as_str()) != change.patch_id.as_deref())
            .collect();
        if let Some(first) = stale.first() {
            let ids = stale
                .iter()
                .map(|r| r.task_id.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            let at = change.patch_id.as_deref().map(short).unwrap_or("(unread)");
            return Err(TrainError::new(
                "invalid",
                format!(
                    "{ids} reviewed patch {}, but {change_id} is at patch {at}.",
                    short(&first.patch_id)
                ),
                Some("Review the current head."),
            ));
        }
        match self.set_ready(&change, reviews) {
            Some(ready) => Ok(self.one(ready)),
            None => Err(TrainError::new(
                "invalid",
                format!("{change_id} changed state while it was marked ready; read it again."),
                None,
            )),
        }
    }

    // M7 auto-enqueue, hooked onto task completion through the event log: a write task whose result names a PR puts
    // it on the train. A refusal goes to the lead with its fix.
    async fn on_task_completed(&self, data: &Value) {
        let Some(task_id) = data.get("taskId").and_then(Value::as_str) else {
            return;
        };
        let Some(task) = self.host.task(&super::contract::TaskId::unchecked(task_id)) else {
            return;
        };
        let Some(pr_url) = task
            .pr_url
            .clone()
            .filter(|u| task.kind == "write" && parse_pr_url(u).is_some())
        else {
            return;
        };
        let input = ChangeEnqueueCall {
            task_id: Some(task.task_id.clone()),
            pr_url: GitHubPrUrl::unchecked(pr_url.clone()),
            workstream_id: None,
            serves: None,
            tier: None,
        };
        if let Err(e) = self.enqueue(&task.project_ref, input).await {
            let fix = e
                .fix
                .as_ref()
                .map(|f| format!(" Fix: {f}."))
                .unwrap_or_default();
            self.wake_lead(
                &task.project_ref,
                format!(
                    "The train refused {pr_url} from {}: {}{fix}",
                    task.task_id, e.message
                ),
            )
            .await;
        }
    }

    pub fn get(&self, change_id: &ChangeId) -> Option<Change> {
        self.records.get(change_id).map(|c| self.one(c))
    }

    /// Newest first.
    pub fn list(&self, filter: &ListFilter) -> Vec<Change> {
        self.positioned(self.records.list(filter))
    }

    pub fn state(&self, repo: &str) -> TrainState {
        self.records.train_state(repo)
    }

    /// Sets the Change's `lastError` and nothing else.
    pub fn note(&self, change_id: &ChangeId, text: &str) {
        self.records.note(change_id, text);
    }
}
