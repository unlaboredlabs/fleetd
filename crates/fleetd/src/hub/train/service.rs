//! The merge train: only fleetd merges. One serial train per repo takes the oldest ready Change, rebases it onto the
//! latest base in a hub-owned worktree on the project's machine, waits for CI on that exact head, posts
//! `fleetd/train=success` and squash-merges pinned to the head. Conflicts and red CI go back to the task that wrote
//! the code; a merge goes to the lead inline. A PR merged into a guarded base without the train is reported once
//! (`pr.merged_outside`) and told to the lead. The `hold` label holds one PR.
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
use super::git::{BLOCKED, GitError, REFUSED_HERE, Rebase, TrainGit, default_worktree};
use super::github::{CheckRun, GhError, GhRunner, MergeOutcome, Pull, TRAIN_CONTEXT, TrainGitHub};
use super::host::{BoxFut, TrainHost};
use super::main_ci::{GithubSync, MainCi, ci_state};
use super::records::{ChangeRecords, Db, HEAD_STATES, ListFilter, QUEUED_STATES};
use super::rules::{Refusal, check_source, check_tier};
use super::time::{iso, millis, parse_iso};
use super::triggers;
use crate::clock::Clock;
use crate::hub::leads::events::Event;
use crate::hub::prompts::fixed::{FixPr, fix_your_pr};
use crate::hub::status::fresh::{self, Fresh};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::prim::Text;
use fleetd_contracts::projects::CiInfo;
use fleetd_contracts::status::{ChangeStateData, CiMainData, CiState};

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
    /// How long a head may have no checks at all before the train asks GitHub whether its PR has CI; the answer comes
    /// from the workflows' triggers, not this wait (`FLEETD_TRAIN_NO_CI_GRACE_SEC`, default 90).
    pub no_ci_grace: Duration,
    /// How often merged PRs are checked for merges outside the train.
    pub bypass_every: Duration,
    /// How often a repo's open PRs are read for a running writer's draft marked ready.
    pub ready_every: Duration,
    /// Merges GitHub refuses (405/409) before the train gives up on a Change.
    pub merge_attempts: u32,
    /// Most ready Changes merged as one batch (one CI run, one squash); 1 takes each alone
    /// (`FLEETD_TRAIN_BATCH_MAX`, default 4).
    pub batch_max: usize,
    /// Run each repo's loop in the background; tests drive `step` themselves.
    pub auto_run: bool,
    /// Where a project's train worktree lives, from its checkout.
    pub worktree_for: WorktreeFor,
    /// The status view's freshness registry: every GitHub answer and every pass keeps a repo's sources live.
    pub fresh: Arc<Fresh>,
}

impl Default for TrainOptions {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(15),
            ci_timeout: Duration::from_secs(30 * 60),
            no_ci_grace: Duration::from_secs(
                std::env::var("FLEETD_TRAIN_NO_CI_GRACE_SEC")
                    .ok()
                    .and_then(|v| v.parse::<u64>().ok())
                    .filter(|s| *s > 0)
                    .unwrap_or(90),
            ),
            bypass_every: Duration::from_secs(60),
            ready_every: Duration::from_secs(60),
            merge_attempts: 3,
            batch_max: std::env::var("FLEETD_TRAIN_BATCH_MAX")
                .ok()
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|n| *n > 0)
                .unwrap_or(4),
            auto_run: true,
            worktree_for: Arc::new(default_worktree),
            fresh: Arc::default(),
        }
    }
}

/// A repo's CI config for one base as read at a time: workflows and required checks, and the workflow files.
type CiConfig = (i64, CiInfo, Vec<Option<String>>);

/// How long a repo's CI config (workflows, required checks) is trusted before it is read again.
const CI_CONFIG_TTL_MS: i64 = 10 * 60_000;

const GREEN: [&str; 3] = ["success", "neutral", "skipped"];

pub(super) fn is_red(run: &CheckRun) -> bool {
    run.status == "completed" && !GREEN.contains(&run.conclusion.as_deref().unwrap_or(""))
}

pub(super) enum Checks {
    /// No check runs at all.
    None,
    Pending,
    Green,
    Red(Vec<CheckRun>),
}

/// One read of a head's checks. A cancelled check is red only once nothing else is still running: a superseded
/// workflow run is cancelled while its replacement is still being set up.
pub(super) fn checks(runs: &[CheckRun]) -> Checks {
    if runs.is_empty() {
        return Checks::None;
    }
    let running = runs.iter().any(|r| r.status != "completed");
    let red: Vec<CheckRun> = runs
        .iter()
        .filter(|r| is_red(r))
        .filter(|r| !(running && r.conclusion.as_deref() == Some("cancelled")))
        .cloned()
        .collect();
    if !red.is_empty() {
        Checks::Red(red)
    } else if running {
        Checks::Pending
    } else {
        Checks::Green
    }
}

pub(super) fn short(sha: &str) -> &str {
    &sha[..sha.len().min(12)]
}

pub(super) fn error_text(text: &str) -> Text<0, 2000> {
    last_error(if text.chars().count() > 2000 {
        format!("{}…", text.chars().take(1999).collect::<String>())
    } else {
        text.to_string()
    })
}

pub(super) enum CiOutcome {
    Green,
    /// The repo has no CI: the head passes on fleetd's own checks (receipts and reviews before it was ready).
    NoCi(String),
    Red(Vec<CheckRun>),
    /// With the last GitHub read error, when one kept the train from deciding.
    Timeout(Option<String>),
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
    pub(super) host: Arc<dyn TrainHost>,
    clock: Arc<dyn Clock>,
    pub(super) records: ChangeRecords,
    pub(super) github: TrainGitHub,
    gate: Arc<dyn ReviewGate>,
    pub(super) options: TrainOptions,
    /// Row updates re-read the Change under this lock, so a slow pass never overwrites a newer state.
    rows: Mutex<()>,
    /// One user of a repo's train worktree at a time: the loop's rebase, an enqueue's patch id.
    git_locks: RepoLocks,
    /// One pass of a repo's loop at a time.
    step_locks: RepoLocks,
    /// One enqueue of a PR at a time, from its open check to its row, so callers racing on one PR (a writer's
    /// report, its result, the draft-ready pass) get one Change.
    enqueue_locks: RepoLocks,
    kicks: Mutex<HashMap<String, Arc<Notify>>>,
    loops: Mutex<HashSet<String>>,
    recovered: Mutex<HashSet<String>>,
    last_bypass_check: Mutex<HashMap<String, i64>>,
    /// Per repo, the bases its Changes' PRs target: a PR merged into another branch is not the train's to judge.
    bases: Mutex<HashMap<String, HashSet<String>>>,
    last_ready_check: Mutex<HashMap<String, i64>>,
    /// Each watched PR's draft flag as last read, and the heads already sent to review as a ready slice.
    drafts: Mutex<HashMap<(String, i64), bool>>,
    ready_heads: Mutex<HashSet<(String, i64, String)>>,
    merge_refusals: Mutex<HashMap<ChangeId, u32>>,
    /// The train's last push per change: the head it pushed and when, for `ci.queue` spans.
    pub(super) pushed: Mutex<HashMap<ChangeId, (String, i64)>>,
    /// Each repo and base branch's CI config and when it was read.
    ci_configs: Mutex<HashMap<(String, String), CiConfig>>,
    pub(super) sync: GithubSync,
    /// The follower and every repo loop, aborted by `stop`.
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// Batches: suspects, repos batching is off for, rewritten heads.
    pub(super) lanes: Mutex<super::batch::Lanes>,
}

pub(super) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
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
            github: TrainGitHub::new(gh, options.fresh.clone(), clock.clone()),
            clock,
            records: ChangeRecords::new(db),
            options,
            rows: Mutex::new(()),
            git_locks: Mutex::default(),
            step_locks: Mutex::default(),
            enqueue_locks: Mutex::default(),
            kicks: Mutex::default(),
            loops: Mutex::default(),
            recovered: Mutex::default(),
            last_bypass_check: Mutex::default(),
            bases: Mutex::default(),
            last_ready_check: Mutex::default(),
            drafts: Mutex::default(),
            ready_heads: Mutex::default(),
            merge_refusals: Mutex::default(),
            pushed: Mutex::default(),
            ci_configs: Mutex::default(),
            sync: GithubSync::default(),
            tasks: Mutex::default(),
            lanes: Mutex::default(),
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

    pub(super) fn now_ms(&self) -> i64 {
        millis(self.clock.now())
    }

    fn now_iso(&self) -> Timestamp {
        Timestamp(iso(self.clock.now()))
    }

    pub(super) fn emit(
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

    /// The texts of the project's lead, or of the change's author task, for a message to it.
    /// Applies `next` to the stored Change if it is still in one of `from` (any state when None); else does nothing.
    pub(super) fn update(
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
        let from = current.state;
        let mut changed = next(current);
        changed.updated_at = self.now_iso();
        self.records.put(&changed);
        if changed.state != from {
            self.state_span(Some(from), &changed);
            let data = ChangeStateData {
                change_id: changed.change_id.clone(),
                workstream_id: Some(changed.workstream_id.clone()),
                repo: changed.repo.clone(),
                pr_number: Count::unchecked(changed.pr_number.get()),
                from,
                to: changed.state,
            };
            self.emit(
                &changed.project_ref,
                "change.state",
                format!(
                    "{} {} → {}: {}#{}",
                    changed.change_id,
                    state_str(from),
                    state_str(changed.state),
                    changed.repo,
                    changed.pr_number
                ),
                serde_json::to_value(data).unwrap_or(Value::Null),
            );
        }
        Some(changed)
    }

    /// The time inspector's change lane: the span of the state the change left closes, and the new state's opens.
    fn state_span(&self, left: Option<ChangeState>, change: &Change) {
        use fleetd_contracts::time::{SpanExtra, SpanKind};
        let Some(time) = self.host.time() else { return };
        let now = self.now_ms();
        let prefix = format!("change/{}/", change.change_id);
        if left.is_some() {
            time.close(prefix.clone(), now);
        }
        let (kind, reason) = match change.state {
            ChangeState::Queued | ChangeState::Reviewing => (SpanKind::ChangeReview, None),
            ChangeState::Ready => (SpanKind::ChangeQueue, None),
            ChangeState::Rebasing => (SpanKind::ChangeRebase, None),
            ChangeState::Ci => (SpanKind::ChangeCi, None),
            ChangeState::Merging => (SpanKind::ChangeMerge, None),
            ChangeState::NeedsRebase => (SpanKind::ChangeBlocked, Some("needs_rebase")),
            ChangeState::CiFailed => (SpanKind::ChangeBlocked, Some("ci_failed")),
            ChangeState::Merged | ChangeState::Refused | ChangeState::Abandoned => return,
        };
        let state = serde_json::to_value(change.state)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        time.span(crate::hub::time::NewSpan {
            src_key: format!("{prefix}{state}/{now}"),
            kind,
            start_ms: now,
            end_ms: None,
            ids: change_ids(change),
            lane: change_lane(change),
            label: Some(format!("{}#{}", change.repo, change.pr_number)),
            extra: reason.map(|r| SpanExtra {
                reason: fleetd_contracts::prim::Text::new(r).ok(),
                ..SpanExtra::default()
            }),
            ..Default::default()
        });
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

    /// The project the repo's train runs in: the one it was created for, or `fallback` once that one is removed (the
    /// repo re-added under a new id), so the train follows the repo instead of failing on a dead project forever.
    pub(super) fn train_project(&self, repo: &str, fallback: &ProjectRef) -> ProjectRef {
        match self.records.train(repo) {
            Some(t)
                if t.project_ref == *fallback
                    || self.host.project_root(&t.project_ref).is_some() =>
            {
                t.project_ref
            }
            Some(_) if self.host.project_root(fallback).is_some() => {
                self.records.rebind_train(repo, fallback);
                fallback.clone()
            }
            Some(t) => t.project_ref,
            None => fallback.clone(),
        }
    }

    pub(super) fn git_for(
        &self,
        change: &Change,
    ) -> Result<(TrainGit<'_>, Arc<tokio::sync::Mutex<()>>), GitError> {
        let project_ref = self.train_project(&change.repo, &change.project_ref);
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
    pub(super) async fn tell_author(&self, change: &Change, text: String) {
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
        let line = Event::PrNote {
            change: change.change_id.as_str(),
            pr_url: change.pr_url.as_str(),
            text: &text,
        }
        .render();
        self.wake_lead(&change.project_ref, line).await;
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
            json!({ "changeId": ready.change_id, "workstreamId": ready.workstream_id }),
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

    /// When an order's done-when passed, its PRs that are not merged and not already on their way in are left
    /// over: each leaves the train and is closed on GitHub with `why`. The design's rule is that done-when alone
    /// decides done, so an orphan PR must not stay open looking like work in progress. Returns the ones closed.
    pub async fn close_leftovers(
        &self,
        project_ref: &ProjectRef,
        workstream_id: &WorkstreamId,
        why: &str,
        keep: &[ChangeId],
    ) -> Vec<Change> {
        let changes = self.list(&ListFilter {
            project_ref: Some(project_ref.clone()),
            limit: 500,
            ..Default::default()
        });
        let mut closed = Vec::new();
        for change in leftovers(&changes, workstream_id)
            .into_iter()
            .filter(|c| !keep.contains(&c.change_id))
        {
            let Some(left) = self.update(&change.change_id, Some(&[change.state]), |mut c| {
                c.state = ChangeState::Abandoned;
                c.last_error = Some(last_error(why));
                c
            }) else {
                continue;
            };
            let comment = format!("Closed by fleetd: {why}");
            if let Err(error) = self
                .github
                .close(&left.repo, left.pr_number.get(), &comment)
                .await
            {
                tracing::warn!(change = %left.change_id, ?error, "train: leftover PR not closed on GitHub");
            }
            closed.push(left);
        }
        closed
    }

    pub(super) async fn abandon(&self, change: &Change, why: &str) {
        let done = self.update(&change.change_id, Some(&[change.state]), |mut c| {
            c.state = ChangeState::Abandoned;
            c.last_error = Some(last_error(why));
            c
        });
        if done.is_some() {
            let line = Event::PrLeft {
                change: change.change_id.as_str(),
                pr_url: change.pr_url.as_str(),
                why,
            }
            .render();
            self.wake_lead(&change.project_ref, line).await;
        }
    }

    /// `ci_note` says how CI passed when it was not GitHub's checks (a repo with no CI); `batch` is the batch PR it
    /// landed in with the others, when it did.
    pub(super) async fn finish_merged(
        &self,
        change: &Change,
        merged_sha: Option<&str>,
        ci_note: Option<&str>,
        batch: Option<&super::batch::Landed>,
    ) {
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
        lock(&self.lanes).suspects.remove(&change.change_id);
        let as_sha = sha
            .as_deref()
            .map(|s| format!(" as {}", short(s)))
            .unwrap_or_default();
        let mut data = json!({ "changeId": merged.change_id, "workstreamId": merged.workstream_id, "repo": merged.repo, "prNumber": merged.pr_number });
        if let Some(sha) = &sha {
            data["mergedSha"] = json!(sha);
        }
        if let Some(task_id) = &merged.task_id {
            data["taskId"] = json!(task_id);
        }
        let mut note = ci_note.map(|n| format!(" ({n})")).unwrap_or_default();
        if let Some(n) = ci_note {
            data["ci"] = json!(n);
        }
        if let Some(batch) = batch {
            note.push_str(&format!(" in batch #{}", batch.pr_number));
        }
        self.emit(
            &merged.project_ref,
            "pr.merged",
            format!(
                "{} merged: {}#{}{as_sha}{note}",
                merged.change_id, merged.repo, merged.pr_number
            ),
            data,
        );
        let line = Event::PrMerged {
            change: merged.change_id.as_str(),
            pr_url: merged.pr_url.as_str(),
            sha: &as_sha,
            tier: tier_str(merged.tier),
            serves: merged.serves.as_str(),
            by: merged.task_id.as_ref().map(|t| t.as_str()),
        }
        .render();
        self.wake_lead(&merged.project_ref, line).await;
    }

    pub(super) async fn needs_rebase(
        &self,
        change: &Change,
        base: &str,
        paths: &[String],
        output: &str,
    ) {
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
            json!({ "changeId": change.change_id, "workstreamId": change.workstream_id, "paths": paths.iter().take(50).collect::<Vec<_>>() }),
        );
        let text = fix_your_pr(
            change.pr_url.as_str(),
            Some(change.change_id.as_str()),
            change.branch.as_str(),
            &FixPr::Rebase { why: &why, base },
        );
        self.tell_author(&parked, text).await;
    }

    /// `timed_out` carries the GitHub read error that kept the train from deciding, when there was one.
    pub(super) async fn ci_failed(
        &self,
        change: &Change,
        failing: &[CheckRun],
        timed_out: Option<Option<String>>,
    ) {
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
        let why = if let Some(unread) = timed_out {
            let unread = unread.map(|e| format!(" ({e})")).unwrap_or_default();
            format!(
                "CI on {} did not finish within {} min{unread}",
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
        let mut data = json!({ "changeId": change.change_id, "workstreamId": change.workstream_id, "checks": failing.iter().map(|r| r.name.clone()).collect::<Vec<_>>() });
        if let Some(url) = &log_url {
            data["logUrl"] = json!(url);
        }
        self.emit(
            &change.project_ref,
            "change.ci_failed",
            format!("{} {why}", change.change_id),
            data,
        );
        let text = fix_your_pr(
            change.pr_url.as_str(),
            Some(change.change_id.as_str()),
            change.branch.as_str(),
            &FixPr::Ci { why: &why },
        );
        self.tell_author(&parked, text).await;
    }

    /// Polls the check runs of `sha`, the head of a PR from `head` into `base`, until all are done, one is red, or
    /// the timeout passes. A head with no checks past the grace period, on a repo with no workflows and no required
    /// checks, passes on fleetd's own checks.
    pub(super) async fn wait_ci(
        &self,
        change: &Change,
        repo: &str,
        base: &str,
        head: &str,
        sha: &str,
    ) -> CiOutcome {
        let start = self.now_ms();
        let mut last: Vec<CheckRun> = Vec::new();
        let mut unread: Option<String> = None;
        loop {
            let runs = match self.github.check_runs(repo, sha).await {
                Ok(runs) => Some(runs),
                Err(e) => {
                    tracing::warn!(repo, sha, error = %e.message, "train: check runs not read");
                    None
                }
            };
            let runs_seen = runs.as_ref().map(|r| !r.is_empty());
            let runs = runs.unwrap_or_default();
            if !runs.is_empty() {
                last = runs.clone();
            }
            match checks(&runs) {
                Checks::Red(red) => {
                    self.check_spans(change, sha, &runs);
                    return CiOutcome::Red(red);
                }
                Checks::Green => {
                    self.check_spans(change, sha, &runs);
                    return CiOutcome::Green;
                }
                Checks::None | Checks::Pending => {}
            }
            let elapsed = self.now_ms() - start;
            if runs_seen == Some(false) && elapsed >= self.options.no_ci_grace.as_millis() as i64 {
                match self.has_ci(repo, base, head, sha).await {
                    Ok(false) => {
                        self.check_spans(change, sha, &[]);
                        return CiOutcome::NoCi(format!("no CI on {repo}: used local checks"));
                    }
                    Ok(true) => {
                        if unread.take().is_some() {
                            self.update(&change.change_id, Some(&[ChangeState::Ci]), |mut c| {
                                c.last_error = None;
                                c
                            });
                        }
                    }
                    Err(e) => {
                        let why = format!(
                            "GitHub: could not tell whether {repo} has CI: {}",
                            e.message
                        );
                        if unread.as_ref() != Some(&why) {
                            tracing::warn!(repo, sha, error = %why, "train: CI config not read");
                            self.update(&change.change_id, Some(&[ChangeState::Ci]), |mut c| {
                                c.last_error = Some(error_text(&why));
                                c
                            });
                            unread = Some(why);
                        }
                    }
                }
            }
            if elapsed >= self.options.ci_timeout.as_millis() as i64 {
                self.check_spans(change, sha, &last);
                return CiOutcome::Timeout(unread);
            }
            // A pass waiting on CI is the train running: keep its source live and main CI read.
            self.options.fresh.touch(&fresh::train(repo), self.now_ms());
            if let Some(train) = self.records.train(repo) {
                self.main_ci_pass(repo, &train.project_ref).await;
            }
            self.clock.sleep(self.options.poll_interval).await;
        }
    }

    /// Whether `sha`, the head of a PR from `head` into `base`, has CI: anything reports on it (a commit status other
    /// than the train's, a workflow run), `base` requires a check other than the train's own, or one of the repo's
    /// workflows has a trigger that can run for this PR. Decided from the workflows' `on:`, never from how long GitHub
    /// takes to start a run, and "may run" wins every doubt. The config is cached per repo and base; a failed read is
    /// an error, not "no CI".
    pub(super) async fn has_ci(
        &self,
        repo: &str,
        base: &str,
        head: &str,
        sha: &str,
    ) -> Result<bool, GhError> {
        if !self.github.status_contexts(repo, sha).await?.is_empty() {
            return Ok(true);
        }
        let key = (repo.to_string(), base.to_string());
        let now = self.now_ms();
        let cached = lock(&self.ci_configs)
            .get(&key)
            .filter(|(at, ..)| now - at < CI_CONFIG_TTL_MS)
            .map(|(_, ci, files)| (ci.clone(), files.clone()));
        let (ci, files) = match cached {
            Some(read) => read,
            None => {
                let ci = self.github.ci_config(repo, base).await?;
                let files = if ci.workflows.is_empty() {
                    Vec::new()
                } else {
                    self.github.workflow_files(repo, base).await?
                };
                lock(&self.ci_configs).insert(key, (now, ci.clone(), files.clone()));
                (ci, files)
            }
        };
        if ci.required_checks.iter().any(|c| c != TRAIN_CONTEXT) {
            return Ok(true);
        }
        if ci.workflows.is_empty() {
            return Ok(false);
        }
        if self.github.workflow_runs(repo, sha).await? > 0 {
            return Ok(true);
        }
        Ok(files.iter().any(|f| {
            f.as_deref()
                .is_none_or(|yaml| triggers::may_run(yaml, base, head))
        }))
    }

    /// One `ci.check` span per check run of the deciding poll, from GitHub's own stamps; a check still running when
    /// the train decided ends at the decision, `incomplete`. With the train's own push time, `ci.queue` spans run
    /// from the push to each check's start.
    fn check_spans(&self, change: &Change, sha: &str, runs: &[CheckRun]) {
        use fleetd_contracts::time::{SpanExtra, SpanKind, SpanStatus};
        let Some(time) = self.host.time() else { return };
        let now = self.now_ms();
        let pushed = lock(&self.pushed)
            .remove(&change.change_id)
            .filter(|(s, _)| s == sha)
            .map(|(_, at)| at);
        for r in runs {
            let Some(start) = r.started_at.as_deref().and_then(crate::hub::time::parse_ms) else {
                continue;
            };
            let end = r
                .completed_at
                .as_deref()
                .and_then(crate::hub::time::parse_ms);
            let status = match (end, r.conclusion.as_deref()) {
                (None, _) => SpanStatus::Incomplete,
                (Some(_), Some("success" | "neutral" | "skipped")) => SpanStatus::Ok,
                (Some(_), Some("cancelled")) => SpanStatus::Cancelled,
                (Some(_), _) => SpanStatus::Failed,
            };
            let extra = SpanExtra {
                check: fleetd_contracts::prim::Text::new(crate::hub::api::clip(&r.name, 200)).ok(),
                url: r.html_url.as_deref().and_then(|u| {
                    fleetd_contracts::prim::Text::new(crate::hub::api::clip(u, 500)).ok()
                }),
                ..SpanExtra::default()
            };
            let lane = format!("{}/ci", change_lane(change));
            time.span(crate::hub::time::NewSpan {
                src_key: format!("check/{}/{sha}/{}", change.change_id, r.name),
                kind: SpanKind::CiCheck,
                start_ms: start,
                end_ms: Some(end.unwrap_or(now).max(start)),
                ids: change_ids(change),
                lane: lane.clone(),
                label: Some(r.name.clone()),
                status,
                extra: Some(extra.clone()),
                ..Default::default()
            });
            if let Some(push) = pushed.filter(|p| *p <= start) {
                time.span(crate::hub::time::NewSpan {
                    src_key: format!("ciqueue/{}/{sha}/{}", change.change_id, r.name),
                    kind: SpanKind::CiQueue,
                    start_ms: push,
                    end_ms: Some(start),
                    ids: change_ids(change),
                    lane,
                    label: Some(r.name.clone()),
                    extra: Some(extra),
                    ..Default::default()
                });
            }
        }
    }

    /// A git failure goes on the Change as its last error and the loop retries it. A blocked worktree or a checkout
    /// the node won't run commands in needs a person, so it is also an event, once per Change and error rather than
    /// every pass.
    pub(super) fn git_failed(&self, change: &Change, error: &str) -> Text<0, 2000> {
        let text = error_text(&format!("git: {error}"));
        if (error.starts_with(BLOCKED) || error.starts_with(REFUSED_HERE))
            && change.last_error.as_ref() != Some(&text)
        {
            self.emit(
                &change.project_ref,
                "train.blocked",
                format!("train {}: {error}", change.repo),
                json!({ "changeId": change.change_id, "repo": change.repo, "error": error }),
            );
        }
        text
    }

    /// A pass that could not finish: the Change goes back first in line with the reason, and the loop retries later.
    pub(super) fn put_back(&self, change: &Change, why: &str) {
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
    pub(super) async fn ready_moved(&self, change: &Change, pull: &Pull) -> Result<(), GitError> {
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
    pub(super) async fn take(&self, change: &Change) {
        // Taken alone, it is no longer suspected of having turned a batch red.
        lock(&self.lanes).suspects.remove(&change.change_id);
        match self.take_inner(change).await {
            Ok(()) => {}
            Err(TakeError::Gh(e)) => self.put_back(change, &format!("GitHub: {}", e.message)),
            Err(TakeError::Git(e)) => {
                let why = self.git_failed(change, &e.0);
                self.put_back(change, why.as_str())
            }
        }
    }

    async fn take_inner(&self, change: &Change) -> Result<(), TakeError> {
        let repo = &change.repo;
        let pull = self.github.pull(repo, change.pr_number.get()).await?;
        self.guard_base(repo, &pull.base.ref_);
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
                    let pushed = git.push(&change.branch, &remote_head).await?;
                    if pushed.is_ok() {
                        lock(&self.pushed).insert(
                            change.change_id.clone(),
                            (head_sha.to_string(), self.now_ms()),
                        );
                    }
                    match pushed {
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
        let ci_note = match self
            .wait_ci(&in_ci, repo, base, change.branch.as_str(), &head_sha)
            .await
        {
            CiOutcome::Green => None,
            CiOutcome::NoCi(note) => Some(note),
            CiOutcome::Red(failing) => {
                self.ci_failed(&in_ci, &failing, None).await;
                return Ok(());
            }
            CiOutcome::Timeout(unread) => {
                self.ci_failed(&in_ci, &[], Some(unread)).await;
                return Ok(());
            }
        };

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
                &format!(
                    "{}: rebased onto {base}, {}",
                    change.change_id,
                    ci_note.as_deref().unwrap_or("CI green")
                ),
            )
            .await?;
        let (status, message) = match self
            .github
            .merge(repo, change.pr_number.get(), &head_sha, None)
            .await?
        {
            MergeOutcome::Merged { sha } => {
                self.finish_merged(&merging, Some(&sha), ci_note.as_deref(), None)
                    .await;
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
        let line = Event::PrGaveUp {
            change: change.change_id.as_str(),
            pr_url: change.pr_url.as_str(),
            why: &why,
            tries: refusals as i64,
        }
        .render();
        self.wake_lead(&change.project_ref, line).await;
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
            self.guard_base(repo, &pull.base.ref_);
            if pull.merged {
                self.abandon(&change, "was merged outside the train").await;
            } else if pull.state != "open" {
                self.abandon(&change, "was closed").await;
            } else if (change.state == ChangeState::Queued
                || pull.head.sha.to_lowercase() != change.head_sha.as_str())
                && let Err(GitError(e)) = self.admit(&change, &pull).await
            {
                let why = self.git_failed(&change, &e);
                self.update(&change.change_id, Some(&[change.state]), |mut c| {
                    c.last_error = Some(why);
                    c
                });
            }
        }
    }

    /// A running writer's PR seen as a draft and now marked ready is a ready slice: it goes on the train at once, as
    /// that writer's, so its review starts while the writer works on (the same path as its `report` with kind
    /// slice_ready). Once per head. Read from the repo's open PRs on the train's own polling, so it needs no
    /// webhook; a PR opened ready goes on the train with the writer's result as before.
    async fn ready_pass(&self, repo: &str, project_ref: &ProjectRef) {
        let now = self.now_ms();
        let due = lock(&self.last_ready_check)
            .get(repo)
            .is_none_or(|at| now - at >= self.options.ready_every.as_millis() as i64);
        if !due {
            return;
        }
        let writers = self.host.running_writers(project_ref);
        if writers.is_empty() {
            return;
        }
        lock(&self.last_ready_check).insert(repo.to_string(), now);
        let pulls = match self.github.open_pulls(repo).await {
            Ok(pulls) => pulls,
            Err(e) => {
                tracing::warn!(repo, error = %e.message, "train: open PRs not read");
                return;
            }
        };
        for pull in pulls {
            let Some((task_id, _)) = writers.iter().find(|(_, b)| *b == pull.head.ref_) else {
                continue;
            };
            let key = (repo.to_string(), pull.number);
            let was_draft = lock(&self.drafts).insert(key, pull.draft);
            if pull.draft || was_draft != Some(true) {
                continue;
            }
            let head = (repo.to_string(), pull.number, pull.head.sha.to_lowercase());
            if !lock(&self.ready_heads).insert(head) {
                continue;
            }
            let pr_url = format!("https://github.com/{repo}/pull/{}", pull.number);
            let call = fleetd_contracts::lead_calls::SliceReadyCall {
                pr_url: GitHubPrUrl::unchecked(pr_url.clone()),
            };
            match super::calls::slice_ready(self, project_ref, task_id, call).await {
                Ok((change, _)) => {
                    tracing::info!(change_id = %change.change_id, %pr_url, "train: a draft marked ready is a slice")
                }
                Err(e) => {
                    let line = Event::PrRefused {
                        pr_url: &pr_url,
                        task: task_id.as_str(),
                        message: &e.message,
                        fix: e.fix.as_deref(),
                    }
                    .render();
                    self.wake_lead(project_ref, line).await;
                }
            }
        }
    }

    /// After a restart: a Change the train was merging is finished if GitHub merged it, else put back first in line.
    async fn recover(&self, repo: &str) {
        for change in self.records.in_train(repo, HEAD_STATES) {
            let pull = self.github.pull(repo, change.pr_number.get()).await;
            if let Ok(pull) = &pull {
                self.guard_base(repo, &pull.base.ref_);
            }
            match pull {
                Ok(pull) if pull.merged && change.state == ChangeState::Merging => {
                    self.finish_merged(&change, pull.merge_commit_sha.as_deref(), None, None)
                        .await
                }
                Ok(pull) if change.state == ChangeState::Merging && pull.state == "open" => {
                    match self.landed_in_batch(&change).await {
                        Some(landed) => self.finish_batch_member(&change, &landed, None).await,
                        None => {
                            self.put_back(&change, "the hub restarted while the train worked on it")
                        }
                    }
                }
                _ => self.put_back(&change, "the hub restarted while the train worked on it"),
            }
        }
        lock(&self.recovered).insert(repo.to_string());
    }

    fn guard_base(&self, repo: &str, base: &str) {
        lock(&self.bases)
            .entry(repo.to_lowercase())
            .or_default()
            .insert(base.to_owned());
    }

    /// PRs merged without the train into the repo's default branch or a base its Changes target: each one is reported
    /// once, as `pr.merged_outside` and a line to the lead. Others share the repo, not the train: another fleet's
    /// namespace, or a branch fleetd never merges into. The train's own batch PRs (its scratch branches) are its merges.
    async fn check_merged_outside(
        &self,
        repo: &str,
        watch_since_ms: i64,
        project_ref: &ProjectRef,
    ) {
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
        let failed =
            |e: GhError| tracing::warn!(repo, error = %e.message, "train: merged PRs not read");
        let merged = match self.github.merged_pulls(repo).await {
            Ok(merged) => merged,
            Err(e) => return failed(e),
        };
        let default = match self.sync.base(repo) {
            Some(base) => base,
            None => match self.github.default_branch(repo).await {
                Ok(base) => {
                    self.sync.set_base(repo, base.clone());
                    base
                }
                Err(e) => return failed(e),
            },
        };
        // Unknown while the owner's policy can't be read: the scan waits rather than report a batch of the train's.
        let Some(scratch) = self.scratch_prefix(repo).await else {
            return;
        };
        let guarded = lock(&self.bases).get(repo).cloned().unwrap_or_default();
        let mut newest = watch_since_ms;
        for pr in merged {
            if pr.base != default && !guarded.contains(&pr.base) || pr.head.starts_with(&scratch) {
                continue;
            }
            let Some(at) = parse_iso(&pr.merged_at).filter(|at| *at > watch_since_ms) else {
                continue;
            };
            let change = self.records.latest_for(repo, pr.number);
            if change
                .as_ref()
                .is_some_and(|c| c.state == ChangeState::Merged)
            {
                continue;
            }
            newest = newest.max(at);
            let project_ref = change.as_ref().map_or(project_ref, |c| &c.project_ref);
            let mut data = json!({ "repo": repo, "prNumber": pr.number });
            if let Some(sha) = &pr.merge_sha {
                data["mergedSha"] = json!(sha.to_lowercase());
            }
            if let Some(c) = &change {
                data["changeId"] = json!(c.change_id);
            }
            let line = format!(
                "{repo}#{} was merged into {} without the merge train.",
                pr.number, pr.base
            );
            self.emit(project_ref, "pr.merged_outside", line.clone(), data);
            self.wake_lead(project_ref, line).await;
        }
        if newest > watch_since_ms {
            self.records.watch_past(repo, newest);
        }
    }

    /// One pass of the repo's loop: refresh waiting Changes, report merges outside the train, then take one ready
    /// Change through to merged or parked. True when it took one.
    pub async fn step(&self, raw_repo: &str) -> bool {
        let repo = raw_repo.to_lowercase();
        let step_lock = repo_lock(&self.step_locks, &repo);
        let _held = step_lock.lock().await;
        let took = self.step_inner(&repo).await;
        self.options
            .fresh
            .touch(&fresh::train(&repo), self.now_ms());
        took
    }

    async fn step_inner(&self, repo: &str) -> bool {
        let repo = repo.to_string();
        let Some(train) = self.records.train(&repo) else {
            return false;
        };
        if !lock(&self.recovered).contains(&repo) {
            self.recover(&repo).await;
        }
        self.refresh(&repo).await;
        self.ready_pass(&repo, &train.project_ref).await;
        self.main_ci_pass(&repo, &train.project_ref).await;
        self.check_merged_outside(&repo, train.watch_since_ms, &train.project_ref)
            .await;
        self.reconcile_batches(&repo).await;
        self.sweep_scratch(&repo).await;
        self.next(&repo).await
    }

    fn ensure_loop(&self, repo: &str) {
        if !self.options.auto_run || !lock(&self.loops).insert(repo.to_string()) {
            return;
        }
        self.expect_sources(repo);
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
                    // Its own task, so a panic in one pass is logged and the loop goes on.
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

    /// The repo's status sources: GitHub answers and train passes.
    fn expect_sources(&self, repo: &str) {
        let (fresh, now) = (&self.options.fresh, self.now_ms());
        fresh.expect(&fresh::github(repo), fresh::github_stale_ms(), now);
        fresh.expect(&fresh::train(repo), fresh::TRAIN_STALE_MS, now);
    }

    /// Reads main-branch CI when due: `ci.main` on a state change.
    async fn main_ci_pass(&self, repo: &str, project_ref: &ProjectRef) {
        if !self.sync.take_due(repo, self.now_ms()) {
            return;
        }
        let base = match self.sync.base(repo) {
            Some(base) => base,
            None => match self.github.default_branch(repo).await {
                Ok(base) => {
                    self.sync.set_base(repo, base.clone());
                    base
                }
                Err(e) => {
                    return tracing::warn!(repo, error = %e.message, "train: default branch not read");
                }
            },
        };
        let runs = match self.github.check_runs(repo, &base).await {
            Ok(runs) => runs,
            Err(e) => return tracing::warn!(repo, error = %e.message, "train: main CI not read"),
        };
        let (state, failing) = ci_state(&runs);
        let sha = runs
            .iter()
            .find_map(|r| r.head_sha.clone())
            .unwrap_or_default()
            .to_lowercase();
        if self
            .sync
            .record(repo, sha.clone(), state, failing.clone(), self.now_ms())
        {
            let word = match state {
                CiState::Green => "green",
                CiState::Red => "red",
                CiState::Pending => "pending",
                CiState::Unknown => "unknown",
            };
            let failing_text = if failing.is_empty() {
                String::new()
            } else {
                format!(": {}", failing.join(", "))
            };
            let data = CiMainData {
                repo: GitHubRepo::unchecked(repo),
                sha,
                state,
                failing: failing
                    .iter()
                    .filter_map(|f| Text::new(f.chars().take(120).collect::<String>()).ok())
                    .collect::<Vec<_>>()
                    .try_into()
                    .unwrap_or_default(),
            };
            self.emit(
                project_ref,
                "ci.main",
                format!("main CI {word} on {repo}{failing_text}"),
                serde_json::to_value(data).unwrap_or(Value::Null),
            );
        }
    }

    /// Main-branch CI as last read, for the status view.
    pub fn main_ci(&self, repo: &str) -> Option<MainCi> {
        self.sync.main_ci(&repo.to_lowercase())
    }

    /// Every repo with a train, and the project it belongs to.
    pub fn repos(&self) -> Vec<(String, ProjectRef)> {
        self.records
            .trains()
            .into_iter()
            .map(|t| (t.repo, t.project_ref))
            .collect()
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
                Some("Call `list_agents`."),
            ));
        }
        let enqueue_lock = repo_lock(&self.enqueue_locks, &format!("{repo}#{pr_number}"));
        let held = enqueue_lock.lock().await;
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
                "pass taskId T<n> (the write task that opened it) or workstreamId W<n>",
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
                format!("register its brief with `brief` for {workstream_id} first"),
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
        self.guard_base(&repo, &pull.base.ref_);
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
        // The train merges each PR into its own base, so one based on another open PR's branch would land in that PR.
        let open = [
            QUEUED_STATES,
            HEAD_STATES,
            &[ChangeState::NeedsRebase, ChangeState::CiFailed],
        ]
        .concat();
        if let Some(parent) = self
            .records
            .in_train(&repo, &open)
            .into_iter()
            .find(|c| c.branch.as_str() == pull.base.ref_)
        {
            let refusal = Refusal::new(
                format!(
                    "It is based on #{}'s branch, not on a branch the train merges into.",
                    parent.pr_number
                ),
                format!(
                    "once #{} merges, point it at that PR's base (`gh pr edit {pr_number} --base <base>`) and enqueue it again",
                    parent.pr_number
                ),
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
        self.train_project(&repo, project_ref);
        let at = self.now_iso();
        let change = self.records.create(Change {
            tier,
            state: ChangeState::Queued,
            created_at: at.clone(),
            updated_at: at,
            ..row
        });
        // The row exists: a racing enqueue of this PR now finds it.
        drop(held);
        self.state_span(None, &change);
        self.emit(
            project_ref,
            "change.queued",
            format!(
                "{} queued: {repo}#{} (tier {}, {serves})",
                change.change_id,
                change.pr_number,
                tier_str(change.tier)
            ),
            json!({ "changeId": change.change_id, "workstreamId": change.workstream_id, "repo": repo, "prNumber": change.pr_number }),
        );
        // Reading the patch id needs the machine; if that fails, the loop retries it from `queued`.
        if let Err(GitError(e)) = self.admit(&change, &pull).await {
            let why = self.git_failed(&change, &e);
            self.update(&change.change_id, Some(&[ChangeState::Queued]), |mut c| {
                c.last_error = Some(why);
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
            item: None,
        };
        if let Err(e) = self.enqueue(&task.project_ref, input).await {
            let line = Event::PrRefused {
                pr_url: &pr_url,
                task: task.task_id.as_str(),
                message: &e.message,
                fix: e.fix.as_deref(),
            }
            .render();
            self.wake_lead(&task.project_ref, line).await;
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

/// The order's Changes that are neither merged (or otherwise ended) nor being rebased, checked or merged now.
pub fn leftovers<'a>(changes: &'a [Change], workstream_id: &WorkstreamId) -> Vec<&'a Change> {
    changes
        .iter()
        .filter(|c| &c.workstream_id == workstream_id)
        .filter(|c| {
            matches!(
                c.state,
                ChangeState::Queued
                    | ChangeState::Reviewing
                    | ChangeState::Ready
                    | ChangeState::NeedsRebase
                    | ChangeState::CiFailed
            )
        })
        .collect()
}

fn change_lane(change: &Change) -> String {
    format!("change:{}#{}", change.repo, change.pr_number)
}

fn change_ids(change: &Change) -> crate::hub::time::Ids {
    crate::hub::time::Ids {
        machine_id: Some(change.project_ref.machine_id.to_string()),
        project_id: Some(change.project_ref.project_id.to_string()),
        workstream_id: Some(change.workstream_id.to_string()),
        task_id: change.task_id.as_ref().map(|t| t.to_string()),
        ..Default::default()
    }
}
