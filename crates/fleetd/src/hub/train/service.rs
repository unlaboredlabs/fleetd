//! The merge train: only fleetd merges. One serial train per repo takes the oldest ready Change, has GitHub rebase it
//! onto the latest base (`gh pr update-branch --rebase`), waits for CI on that exact head, posts
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
    GitHubRepo, NonEmpty, PatchId, Positive, ProjectRef, Timestamp, TrainState, last_error,
    parse_pr_url, state_str,
};
use super::github::{
    BranchUpdate, CheckRun, CommitStatus, GhError, GhRunner, MergeOutcome, Pull, TRAIN_CONTEXT,
    TrainGitHub, batch_heads,
};
use super::host::{BoxFut, TrainHost};
use super::main_ci::{GithubSync, MainCi, ci_state};
use super::next::upstreams;
use super::records::{ChangeRecords, DRAFT, Db, HEAD_STATES, ListFilter, QUEUED_STATES, is_draft};
use super::rules::Refusal;
use crate::clock::Clock;
use crate::hub::leads::events::Event;
use crate::hub::prompts::PromptSet;
use crate::hub::status::fresh::{self, Fresh};
use crate::hub::store::{iso_ms, parse_ms, system_ms};
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

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    /// With the clean reviews bound to the patch that make it ready.
    Ready(Vec<ChangeReview>),
    Pending,
    /// Blocking findings on this patch: only a new head moves it.
    Blocked,
}

/// The port between the train and reviews. The train calls `review` whenever a Change enters `reviewing`: on
/// enqueue, when its author pushed a new patch, and when a rebase changed its patch id. The gate answers Ready when
/// a clean review is already bound to this patch id, or Pending and later calls `Train::mark_ready`. A re-review (of a
/// Change approved at an earlier patch) runs alongside CI: the train then asks `again` until it is Ready or Blocked,
/// and the gate calls `Train::review_recorded` on each verdict.
pub trait ReviewGate: Send + Sync + 'static {
    fn review(&self, change: Change) -> BoxFut<'_, Verdict>;
    /// Each pass over a Change still in `reviewing` at the same head, so a review that could not start, or whose
    /// reviewer ended without a verdict and could not be replaced, starts again; and the train's reads of a re-review
    /// it waits on in CI.
    fn again(&self, _change: Change) -> BoxFut<'_, Verdict> {
        Box::pin(async { Verdict::Pending })
    }
    /// Whether a reviewer is at work on the Change's current patch and nothing blocks it: a Change approved at an
    /// earlier patch may then go through the train while it reviews.
    fn rereview(&self, _change: &Change) -> bool {
        false
    }
}

#[derive(Clone)]
pub struct TrainOptions {
    /// Between idle passes, and the longest wait between reads while the train holds a Change (`busy_wait`).
    pub poll_interval: Duration,
    /// How long a head's CI may run, from when its first check started (`CI_RUNNING_TIMEOUT`).
    pub ci_timeout: Duration,
    /// How long a head's checks may all sit queued for runners before any starts (`CI_QUEUE_CEILING`).
    pub ci_queue_ceiling: Duration,
    /// How often merged PRs are checked for merges outside the train.
    pub bypass_every: Duration,
    /// How often a repo's open PRs are read for a writer's ready PR (a slice) when no writer reported one.
    pub ready_every: Duration,
    /// Merges GitHub refuses (405/409) before the train gives up on a Change.
    pub merge_attempts: u32,
    /// How long the train holds a Change whose CI passed for its re-review to finish (`REVIEW_WAIT`); after that it
    /// waits in review, out of the train's way.
    pub review_wait: Duration,
    /// How long a waiting Change's head may go without any check before its author and the lead hear of it
    /// (`CHECKS_START_WAIT`).
    pub checks_start_wait: Duration,
    /// Run each repo's loop in the background; tests drive `step` themselves.
    pub auto_run: bool,
    /// The status view's freshness registry: every GitHub answer and every pass keeps a repo's sources live.
    pub fresh: Arc<Fresh>,
}

impl Default for TrainOptions {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(15),
            ci_timeout: CI_RUNNING_TIMEOUT,
            ci_queue_ceiling: CI_QUEUE_CEILING,
            bypass_every: Duration::from_secs(60),
            ready_every: Duration::from_secs(60),
            merge_attempts: 3,
            review_wait: REVIEW_WAIT,
            checks_start_wait: CHECKS_START_WAIT,
            auto_run: true,
            fresh: Arc::default(),
        }
    }
}

/// How long a Change whose CI passed is held for its re-review: a review takes about as long as CI, and started with it.
pub const REVIEW_WAIT: Duration = Duration::from_secs(15 * 60);

/// How long a waiting Change's head may go without any check: GitHub skipped its CI, or no workflow took the push (D191).
pub const CHECKS_START_WAIT: Duration = Duration::from_secs(15 * 60);

/// How long a head's CI may run once a runner took its first check (D128).
pub const CI_RUNNING_TIMEOUT: Duration = Duration::from_secs(45 * 60);
/// How long a head's checks may all wait for runners: queued time is not running time, but it ends (D128).
pub const CI_QUEUE_CEILING: Duration = Duration::from_secs(2 * 60 * 60);
/// The start of `last_error` on a Change whose CI timed out rather than went red: the train keeps reading its head's
/// checks, and puts it back in the queue when they finish green.
pub(super) const CI_TIMED_OUT: &str = "CI timed out";
/// What becomes of a Change whose CI timed out; it needs nothing from its author.
pub(super) const CI_WATCHED: &str = "the train keeps watching its checks: once they finish green it goes back in the queue, with no push needed";
/// The lead's line when a timed-out Change's CI finished green after all.
pub(super) const CI_FINISHED_LATE: &str = "CI finished after the timeout; back in the queue";

/// A Change in `ci_failed` because its CI timed out, not because a check went red.
pub(super) fn timed_out(change: &Change) -> bool {
    change.state == ChangeState::CiFailed
        && change
            .last_error
            .as_deref()
            .is_some_and(|e| e.starts_with(CI_TIMED_OUT))
}

/// A repo's CI config for one base as read at a time: its workflows and required checks.
type CiConfig = (i64, CiInfo);

/// How long a repo's CI config (workflows, required checks) is trusted before it is read again.
const CI_CONFIG_TTL_MS: i64 = 10 * 60_000;

const GREEN: [&str; 3] = ["success", "neutral", "skipped"];

/// The first waits between check-run reads of a head in CI: a short CI starts its checks within seconds.
const CI_FIRST_WAIT: Duration = Duration::from_secs(2);
/// The wait before the train tries again a merge GitHub refused for checks it still expects, doubled on each such
/// refusal up to `MERGE_RETRY_MAX`: while the train reads the head green and GitHub doesn't, it would otherwise ask
/// for the merge every `poll_interval` until the CI timeout.
const MERGE_RETRY_FIRST: Duration = Duration::from_secs(15);
const MERGE_RETRY_MAX: Duration = Duration::from_secs(5 * 60);
/// The first waits between reads of a PR GitHub just rebased: its new head shows within a second or two.
const REBASE_FIRST_WAIT: Duration = Duration::from_secs(1);

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

/// The checks the train judges a head by: its base's required checks and the repo's own additions (`TrainSettings`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Fast {
    /// The base's required checks, the train's own status left out.
    pub required: Vec<String>,
    /// The fast set: `required` and the repo's `fastChecks`.
    pub set: Vec<String>,
    pub settings: fleetd_contracts::project_settings::TrainSettings,
}

impl Fast {
    pub fn new(
        required: &[String],
        settings: fleetd_contracts::project_settings::TrainSettings,
    ) -> Self {
        let required: Vec<String> = required
            .iter()
            .filter(|n| *n != TRAIN_CONTEXT)
            .cloned()
            .collect();
        Self {
            set: settings.fast_set(&required),
            required,
            settings,
        }
    }

    pub(super) fn holds(&self, name: &str) -> bool {
        self.set.iter().any(|n| n == name)
    }
}

/// The runs of `runs` (the newest of each check) the train waits on: those in the fast set, a cancelled one that is not
/// required left out, and any other that already failed, unless it is left for after the merge. A check of the fast set
/// with no run yet is waited for by name (`must_report`). An empty fast set (a base that requires nothing, and nothing
/// added) is judged by every check, so a repo with CI but no rules still merges on green CI only. `fast` None when the
/// base's rules or the repo's settings can't be read: every check.
pub(super) fn gated(runs: &[CheckRun], fast: Option<&Fast>) -> Vec<CheckRun> {
    let Some(fast) = fast.filter(|f| !f.set.is_empty()) else {
        return runs.to_vec();
    };
    let cancelled = |r: &CheckRun| r.conclusion.as_deref() == Some("cancelled");
    runs.iter()
        .filter(|r| {
            if fast.holds(&r.name) {
                !cancelled(r) || fast.required.contains(&r.name)
            } else {
                is_red(r) && !cancelled(r) && !fast.settings.after_merge_only(&r.name)
            }
        })
        .cloned()
        .collect()
}

/// The checks that must report on a head before it counts as green: its fast set, or the base's `required` checks
/// alone while the repo's settings can't be read. None when neither can be read.
pub(super) fn must_report(fast: Option<&Fast>, required: Option<&[String]>) -> Option<Vec<String>> {
    fast.map(|f| f.set.clone())
        .or_else(|| required.map(<[String]>::to_vec))
}

/// Whether GitHub refused a merge for required checks that haven't reported on the head yet, or still run, rather than
/// for red ones or anything else: "3 of 3 required status checks are expected.", "Required status check \"build\" is
/// in progress.". Read from GitHub's own words, the quoted check names left out: a check named `error-prone` is still
/// only expected. Every sentence about status checks must say so, and one must.
pub(super) fn awaits_checks(message: &str) -> bool {
    let words: String = message
        .split('"')
        .step_by(2)
        .collect::<Vec<_>>()
        .join("\"\"")
        .to_lowercase();
    let about_checks: Vec<&str> = words
        .split(['.', '\n'])
        .map(str::trim)
        .filter(|s| s.contains("status check"))
        .collect();
    !about_checks.is_empty()
        && about_checks.iter().all(|s| {
            ["is ", "are "].iter().any(|verb| {
                ["expected", "in progress", "pending", "queued"]
                    .iter()
                    .any(|state| s.ends_with(&format!("{verb}{state}")))
            })
        })
}

/// The checks `required` names that `runs` and `statuses` don't show green on a head, but the train's own status,
/// posted only once CI is green: Pending while one has no run or status yet, or its status is pending; Red with each
/// failed status. GitHub refuses a merge while a required check is expected, however green the other checks are: on
/// #522 the train merged 40 s after its rebase, before the new head's CI had started its required checks.
pub(super) fn required_checks(
    runs: &[CheckRun],
    statuses: &[CommitStatus],
    required: &[String],
) -> Checks {
    let mut red = Vec::new();
    let mut waiting = false;
    for name in required.iter().filter(|n| *n != TRAIN_CONTEXT) {
        if runs.iter().any(|r| &r.name == name) {
            continue;
        }
        match statuses.iter().find(|s| &s.context == name) {
            Some(s) if s.state == "success" => {}
            Some(s) if s.state == "failure" || s.state == "error" => red.push(CheckRun {
                id: 0.0,
                name: name.clone(),
                status: "completed".into(),
                conclusion: Some(s.state.clone()),
                html_url: s.target_url.clone(),
                started_at: None,
                completed_at: None,
                head_sha: None,
            }),
            _ => waiting = true,
        }
    }
    if !red.is_empty() {
        Checks::Red(red)
    } else if waiting {
        Checks::Pending
    } else {
        Checks::Green
    }
}

/// How many times the train re-runs one workflow run whose required checks read cancelled before it counts them red.
const CANCELLED_RERUNS: u32 = 2;

/// The checks on a head GitHub's ruleset may read as cancelled: in some workflow run, the newest run of a check
/// `required` names. GitHub doesn't read a required check from its newest run on the head: on #510 it read a PR's own
/// runs, cancelled by runs dispatched on its branch, and refused the merge though the dispatched ones passed. All of
/// `runs` as GitHub lists them; `required` None when the base's rules can't be read, and then every check counts.
pub(super) fn cancelled_required(runs: &[CheckRun], required: Option<&[String]>) -> Vec<CheckRun> {
    let mut newest: HashMap<(Option<u64>, &str), &CheckRun> = HashMap::new();
    for r in runs {
        let seen = newest.entry((r.workflow_run(), &r.name)).or_insert(r);
        if r.id > seen.id {
            *seen = r;
        }
    }
    let mut out: Vec<CheckRun> = newest
        .into_values()
        .filter(|r| r.conclusion.as_deref() == Some("cancelled"))
        .filter(|r| required.is_none_or(|names| names.contains(&r.name)))
        .cloned()
        .collect();
    out.sort_by(|a, b| a.id.total_cmp(&b.id));
    out
}

pub(crate) fn short(sha: &str) -> &str {
    &sha[..sha.len().min(12)]
}

pub(super) fn error_text(text: &str) -> Text<0, 2000> {
    last_error(if text.chars().count() > 2000 {
        format!("{}…", text.chars().take(1999).collect::<String>())
    } else {
        text.to_string()
    })
}

/// How the wait for a re-review alongside CI ended.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum ReviewWait {
    /// With the clean reviews of its patch.
    Clean(Vec<ChangeReview>),
    Blocked,
    /// Still at work after `review_wait`.
    Waiting,
}

pub(super) enum CiOutcome {
    Green,
    Red(Vec<CheckRun>),
    Timeout(Stall),
}

/// How CI on a head ran out of time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Stall {
    /// No check reported within `ci_timeout`.
    NoChecks,
    /// Its checks, this many, all waited `ci_queue_ceiling` for runners and none started.
    Queued(usize),
    /// It ran for `ci_timeout` from its first check's start without finishing.
    Running,
    /// Its checks finished green, but these checks of its fast set never reported, within `ci_timeout` of its first
    /// check's start; whether they are all ones the base requires.
    Unreported(Vec<String>, Required),
}

/// Whether checks that never reported are all ones the base requires, or include ones the repo added to its fast set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Required {
    All,
    NotAll,
}

/// Whether a check run has a runner: a check still waiting for one doesn't count toward CI's running time.
fn taken(run: &CheckRun) -> bool {
    run.status == "in_progress" || run.status == "completed"
}

/// When a head's CI started running: the earliest start stamped on a check a runner took. None while every check
/// still waits for a runner; `fallback` when the provider stamps no start, so its wait counts as before D128.
pub(super) fn running_since(runs: &[CheckRun], fallback: i64) -> Option<i64> {
    let mut taken = runs.iter().filter(|r| taken(r)).peekable();
    taken.peek()?;
    Some(
        taken
            .filter_map(|r| r.started_at.as_deref().and_then(parse_ms))
            .min()
            .unwrap_or(fallback),
    )
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
    /// The heads of writers' PRs already sent to review as a ready slice.
    ready_heads: Mutex<HashSet<(String, i64, String)>>,
    merge_refusals: Mutex<HashMap<ChangeId, u32>>,
    /// Each verdict the gate records: a train waiting on a re-review reads it at once.
    verdicts: Notify,
    /// The patches whose re-review was still at work `review_wait` after CI passed: each waits in review, out of the
    /// line, until that review is done, so CI isn't run again for it. Kept in memory: after a restart such a Change may
    /// go through the train once more.
    overdue: Mutex<HashSet<(ChangeId, String)>>,
    /// The upstream failures the lead was told of, each Change's with its hold: once each, in memory, so a restart
    /// may tell one again.
    pub(super) after_told: Mutex<HashSet<(ChangeId, String)>>,
    /// Held by an enqueue with `after` from its loop check until its Change records them.
    after_lock: tokio::sync::Mutex<()>,
    /// GitHub's answer for an upstream PR with no open Change, by URL, and when it was read (`next::UPSTREAM_TTL_MS`).
    pub(super) upstream_reads: Mutex<HashMap<String, (i64, super::next::UpstreamPull)>>,
    /// The train's last push per change: the head it pushed and when, for `ci.queue` spans.
    pub(super) pushed: Mutex<HashMap<ChangeId, (String, i64)>>,
    /// Per waiting Change, the head the train first saw, when, and whether its checks started or it was flagged
    /// (`unstarted_checks`). Kept in memory: after a restart the wait starts again.
    unstarted: Mutex<HashMap<ChangeId, (String, i64, bool)>>,
    /// Each repo and base branch's CI config and when it was read.
    ci_configs: Mutex<HashMap<(String, String), CiConfig>>,
    /// The PRs that carry `fleetd:next`.
    pub(super) next_labels: super::next::NextLabels,
    pub(super) sync: GithubSync,
    /// The follower and every repo loop, aborted by `stop`.
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
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
            step_locks: Mutex::default(),
            enqueue_locks: Mutex::default(),
            kicks: Mutex::default(),
            loops: Mutex::default(),
            recovered: Mutex::default(),
            last_bypass_check: Mutex::default(),
            bases: Mutex::default(),
            last_ready_check: Mutex::default(),
            ready_heads: Mutex::default(),
            merge_refusals: Mutex::default(),
            verdicts: Notify::new(),
            overdue: Mutex::default(),
            after_told: Mutex::default(),
            after_lock: tokio::sync::Mutex::new(()),
            upstream_reads: Mutex::default(),
            pushed: Mutex::default(),
            unstarted: Mutex::default(),
            ci_configs: Mutex::default(),
            next_labels: Default::default(),
            sync: GithubSync::default(),
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

    pub(crate) fn now_ms(&self) -> i64 {
        system_ms(self.clock.now())
    }

    fn now_iso(&self) -> Timestamp {
        Timestamp(iso_ms(system_ms(self.clock.now())))
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

    pub(super) async fn wake_lead(&self, project_ref: &ProjectRef, line: String) {
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
        let shown = current.last_error.clone();
        let mut changed = next(current);
        changed.updated_at = self.now_iso();
        self.records.put(&changed);
        if changed.state != from {
            self.state_span(Some(from), &changed);
            // The move's reason: the error this update set, or the one a pass that hands it back to ready carries.
            let bounced = changed.state == ChangeState::Ready && HEAD_STATES.contains(&from);
            let reason = (bounced || changed.last_error != shown)
                .then(|| changed.last_error.clone())
                .flatten();
            let data = ChangeStateData {
                change_id: changed.change_id.clone(),
                workstream_id: Some(changed.workstream_id.clone()),
                repo: changed.repo.clone(),
                pr_number: Count::unchecked(changed.pr_number.get()),
                from,
                to: changed.state,
                reason: reason.clone(),
            };
            self.emit(
                &changed.project_ref,
                "change.state",
                format!(
                    "{} {} → {}: {}#{}{}",
                    changed.change_id,
                    state_str(from),
                    state_str(changed.state),
                    changed.repo,
                    changed.pr_number,
                    reason.map(|r| format!(" ({r})")).unwrap_or_default()
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
                        .line(&c.repo)
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

    /// Where the repo's train reads its branch prefix and its rules: that repo's checkout in the project that owns
    /// the train (`train_project`), the project's own directory when the repo is its own.
    pub(super) fn train_checkout(&self, repo: &str, fallback: &ProjectRef) -> ProjectRef {
        let owner = self.train_project(repo, fallback);
        self.host
            .github_repos(&owner)
            .into_iter()
            .find(|(r, _)| r == repo)
            .map_or(owner, |(_, checkout)| checkout)
    }

    pub(super) fn kick(&self, repo: &str) {
        if let Some(waiting) = lock(&self.kicks).get(repo) {
            waiting.notify_one();
        }
    }

    /// A writer in the project opened a PR (its command output named one) or ended: the project's trains read their
    /// open PRs on a pass that starts now, instead of at the next `ready_every` sweep, so a writer's slices are queued
    /// as it opens them.
    pub fn writer_opened_pr(&self, project_ref: &ProjectRef) {
        for train in self.records.trains() {
            if train.project_ref == *project_ref {
                lock(&self.last_ready_check).remove(&train.repo);
                self.kick(&train.repo);
            }
        }
    }

    /// The author task gets it as a task message; without one, or if that fails, the lead gets it.
    /// The `pr.fix` prompt with `problem` to the task that wrote the PR, else to the lead as an event line.
    pub(super) async fn tell_author(&self, change: &Change, problem: &str) {
        let prompts = self.records.db().prompts();
        let set = match &change.task_id {
            Some(task_id) => prompts.for_task(&change.project_ref, task_id.as_str()),
            None => prompts.current(Some(&change.project_ref)),
        };
        let text = fix_your_pr(&set, change, problem, "");
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
            for r in reviews {
                if !c.reviews.contains(&r) {
                    c.reviews.push(r);
                }
            }
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

    /// Hands a Change in `reviewing` to the gate; a clean review already bound to its patch makes it ready at once.
    pub(super) async fn to_gate(&self, change: Change) {
        if let Verdict::Ready(reviews) = self.gate.review(change.clone()).await {
            self.set_ready(&change, reviews);
        }
    }

    /// The PR's head and its patch id, from GitHub.
    async fn seen(&self, change: &Change, pull: &Pull) -> Result<(CommitSha, PatchId), GhError> {
        let head = pull.head.sha.to_lowercase();
        let patch_id = self
            .github
            .patch_id(&change.repo, &pull.base.ref_, &head)
            .await?;
        Ok((CommitSha::unchecked(head), PatchId::unchecked(patch_id)))
    }

    /// Reads the PR branch's head and patch id. A new Change goes to the gate. A parked one (needs_rebase, ci_failed)
    /// whose patch is unchanged keeps its reviews and goes back on the queue; a new patch is reviewed again.
    async fn admit(&self, change: &Change, pull: &Pull) -> Result<(), GhError> {
        let (head_sha, patch_id) = self.seen(change, pull).await?;
        let same_patch = change.patch_id.as_ref() == Some(&patch_id);
        if same_patch && change.state != ChangeState::Queued {
            let moved = self.update(&change.change_id, Some(&[change.state]), |mut c| {
                c.head_sha = head_sha.clone();
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
            c.head_sha = head_sha;
            c.patch_id = Some(patch_id);
            c.state = ChangeState::Reviewing;
            c
        });
        if let Some(reviewing) = reviewing {
            self.to_gate(reviewing).await;
        }
        Ok(())
    }

    /// When an order is stopped, its PRs that are not merged and not already on their way in leave the train with
    /// `why`, so none can merge or wait on a reviewer. They stay open on GitHub: closing them is the person's call.
    /// Returns the ones taken off.
    pub fn take_leftovers(
        &self,
        project_ref: &ProjectRef,
        workstream_id: &WorkstreamId,
        why: &str,
    ) -> Vec<Change> {
        let changes = self.records.unlanded(project_ref, workstream_id.as_str());
        leftovers(&changes, workstream_id)
            .into_iter()
            .filter_map(|change| {
                self.update(&change.change_id, Some(&[change.state]), |mut c| {
                    c.state = ChangeState::Abandoned;
                    c.last_error = Some(last_error(why));
                    c
                })
            })
            .collect()
    }

    pub(crate) async fn abandon(&self, change: &Change, why: &str) {
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

    /// `batch` is the batch PR it landed in with the others, when it did.
    pub(super) async fn finish_merged(
        &self,
        change: &Change,
        merged_sha: Option<&str>,
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
        data["mergedAt"] = json!(iso_ms(self.now_ms()));
        if let Some(b) = batch {
            data["batchPr"] = json!(b.pr_number);
        }
        let note = batch
            .map(|b| format!(" in batch #{}", b.pr_number))
            .unwrap_or_default();
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
            by: merged.task_id.as_ref().map(|t| t.as_str()),
        }
        .render();
        self.wake_lead(&merged.project_ref, line).await;
        // The PRs held for this one may go now, in whichever repo they are.
        for repo in self.records.after_repos(merged.pr_url.as_str()) {
            self.kick(&repo);
        }
    }

    /// `why` completes "it ...". From the train's own rebase, or from the queue when GitHub finds it conflicts.
    pub(super) async fn needs_rebase(&self, change: &Change, why: &str) {
        let from = [
            ChangeState::Rebasing,
            ChangeState::Queued,
            ChangeState::Reviewing,
            ChangeState::Ready,
        ];
        let Some(parked) = self.update(&change.change_id, Some(&from), |mut c| {
            if c.state == ChangeState::Reviewing {
                // Not reviewed yet: its next head goes to review even if its patch stays the same.
                c.patch_id = None;
            }
            c.state = ChangeState::NeedsRebase;
            c.last_error = Some(error_text(why));
            c
        }) else {
            return;
        };
        self.emit(
            &change.project_ref,
            "change.needs_rebase",
            format!("{} needs a rebase: {why}", change.change_id),
            json!({ "changeId": change.change_id, "workstreamId": change.workstream_id }),
        );
        self.tell_author(
            &parked,
            &format!("the merge train could not rebase it: it {why}"),
        )
        .await;
    }

    /// `stall` when CI ran out of time rather than went red: the Change's `last_error` then starts `CI_TIMED_OUT`, and
    /// `refresh` keeps reading its head's checks. A timed-out Change whose checks then go red fails here again, red.
    pub(super) async fn ci_failed(
        &self,
        change: &Change,
        failing: &[CheckRun],
        stall: Option<Stall>,
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
        let min = |d: Duration| (d.as_millis() as f64 / 60_000.0).round();
        let why = if let Some(stall) = &stall {
            let what = match stall {
                Stall::NoChecks => format!(
                    "no check reported within {} min",
                    min(self.options.ci_timeout)
                ),
                Stall::Queued(n) => format!(
                    "{n} check{} waited {} min for a runner and none started",
                    if *n == 1 { "" } else { "s" },
                    min(self.options.ci_queue_ceiling)
                ),
                Stall::Running => format!(
                    "it did not finish within {} min of its first check starting",
                    min(self.options.ci_timeout)
                ),
                Stall::Unreported(names, required) => format!(
                    "the {}check{} {} never reported within {} min; every other check passed",
                    if *required == Required::All {
                        "required "
                    } else {
                        ""
                    },
                    if names.len() == 1 { "" } else { "s" },
                    names.join(", "),
                    min(self.options.ci_timeout)
                ),
            };
            format!("{CI_TIMED_OUT} on {}: {what}", short(&change.head_sha))
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
        let from = [ChangeState::Ci, ChangeState::CiFailed];
        let Some(parked) = self.update(&change.change_id, Some(&from), |mut c| {
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
        if stall.is_some() {
            // A push would only start CI again: the lead hears of it, and the author is left to work.
            let text = format!("{why}; {CI_WATCHED}");
            let line = Event::PrNote {
                change: change.change_id.as_str(),
                pr_url: change.pr_url.as_str(),
                text: &text,
            }
            .render();
            self.wake_lead(&change.project_ref, line).await;
            return;
        }
        self.tell_author(&parked, &format!("the merge train did not merge it: {why}"))
            .await;
    }

    /// Polls the check runs of `sha` until all are done, one is red, or the timeout passes. A head with no checks is
    /// never green: only a repo with CI reaches here (`has_ci`). `lone` is a PR merged alone in a repo whose CI runs
    /// checks on `fleetd:next`: a skipped check the label runs, skipped for want of it (`unproven_skips`), never counts
    /// as green there. The train waits for the run that replaces it, puts on a label GitHub refused again every
    /// `LABEL_HOLD_MS`, and tells the lead once when none came in that time. While the repo's workflows can't be read
    /// (`Gate::Unknown`), any skip holds for `LABEL_HOLD_MS` only. While some checks have been queued for
    /// `RUNNER_WAIT_MS`, `noted` (the Changes in this CI run) say they wait for runners. Never green while a check
    /// `base` requires reads cancelled in some workflow run (`cancelled_required`): the train re-runs that run's jobs
    /// and waits again, and a run still cancelled after `CANCELLED_RERUNS` re-runs is red.
    pub(super) async fn wait_ci(
        &self,
        change: &Change,
        repo: &str,
        sha: &str,
        base: &str,
        lone: Option<super::next::Lone>,
        noted: &[ChangeId],
    ) -> CiOutcome {
        let mut earlier = HashMap::new();
        let outcome = self
            .poll_ci(change, repo, sha, base, lone, noted, &mut earlier)
            .await;
        self.runner_note(noted, None, &mut earlier);
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    async fn poll_ci(
        &self,
        change: &Change,
        repo: &str,
        sha: &str,
        base: &str,
        mut lone: Option<super::next::Lone>,
        noted: &[ChangeId],
        earlier: &mut HashMap<ChangeId, Option<String>>,
    ) -> CiOutcome {
        use super::next::{Gate, LABEL_HOLD_MS, Labelled, RUNNER_WAIT_MS, WAITING_FOR_RUNNERS};
        let mut start = self.now_ms();
        let mut last: Vec<CheckRun> = Vec::new();
        let mut queued_since: Option<i64> = None;
        // Per workflow run the train re-ran: how many times, and the newest cancelled check it saw then.
        let mut reruns: HashMap<u64, (u32, f64)> = HashMap::new();
        let (mut tried_label, mut told) = (start, false);
        loop {
            let mut all = Vec::new();
            // The checks of the fast set that have neither a run nor a status on `sha` while every other is green, and
            // what the base requires.
            let mut unreported = Vec::new();
            let mut base_requires: Vec<String> = Vec::new();
            let runs = match self.github.all_check_runs(repo, sha).await {
                Ok(runs) => {
                    all = runs.clone();
                    Some(super::github::latest(runs))
                }
                Err(e) => {
                    tracing::warn!(repo, sha, error = %e.message, "train: check runs not read");
                    None
                }
            };
            let fast = self.fast(repo, base).await;
            if let Some(runs) = &runs {
                let judged = gated(runs, fast.as_ref());
                let (now, queued) = (self.now_ms(), super::next::queued(&judged));
                queued_since = (queued > 0).then(|| queued_since.unwrap_or(now));
                let note = queued_since
                    .filter(|since| now - since >= RUNNER_WAIT_MS)
                    .map(|_| format!("{WAITING_FOR_RUNNERS} ({queued} queued)"));
                self.runner_note(noted, note.as_deref(), earlier);
            }
            let runs = runs.unwrap_or_default();
            // Only the fast set is waited for; a head whose runs are all outside it waits on its required checks below.
            let judged = gated(&runs, fast.as_ref());
            if !judged.is_empty() {
                last = judged.clone();
            } else if !runs.is_empty() {
                last = runs.clone();
            }
            let judged = match checks(&judged) {
                Checks::None if !runs.is_empty() => Checks::Green,
                judged => judged,
            };
            match judged {
                Checks::Red(red) => {
                    self.check_spans(change, sha, &runs);
                    return CiOutcome::Red(red);
                }
                Checks::Green
                    if let Some(lone) = lone.as_mut()
                        && let unproven = super::next::unproven_skips(&runs, lone)
                        && !unproven.is_empty()
                        // Workflows not read yet: the hold lasts `LABEL_HOLD_MS`, then the skips count.
                        && (lone.gate != Gate::Unknown
                            || self.now_ms() - lone.since(start) < LABEL_HOLD_MS) =>
                {
                    let now = self.now_ms();
                    if lone.label == Labelled::Failed && now - tried_label >= LABEL_HOLD_MS {
                        tried_label = now;
                        lone.label = self.label(repo, change.pr_number.get(), false).await;
                    }
                    if !told && now - lone.since(start) >= LABEL_HOLD_MS {
                        told = true;
                        let names: Vec<&str> = unproven.iter().map(|r| r.name.as_str()).collect();
                        let why = if lone.label == Labelled::Failed {
                            format!(
                                "the train could not put `{}` on it",
                                super::github::NEXT_LABEL
                            )
                        } else {
                            "no run replaced them since the label went on".to_string()
                        };
                        let text = format!(
                            "CI didn't start for the labelled PR: {} skipped, and {why}. The train keeps waiting \
                             and won't merge it on a skipped check; check the repo's label workflow.",
                            names.join(", ")
                        );
                        tracing::warn!(change_id = %change.change_id, text, "train: label run missing");
                        let line = Event::PrNote {
                            change: change.change_id.as_str(),
                            pr_url: change.pr_url.as_str(),
                            text: &text,
                        }
                        .render();
                        self.wake_lead(&change.project_ref, line).await;
                    }
                }
                Checks::Green => {
                    let required = self
                        .ci_config(repo, base)
                        .await
                        .ok()
                        .map(|c| c.required_checks);
                    // Every check of the fast set, an added one as a required one, reports before the merge.
                    let waits = must_report(fast.as_ref(), required.as_deref());
                    base_requires = required.clone().unwrap_or_default();
                    let (reported, missing) = self
                        .required_reported(repo, sha, &runs, waits.as_deref())
                        .await;
                    unreported = missing;
                    match reported {
                        Checks::Red(red) => {
                            self.check_spans(change, sha, &runs);
                            return CiOutcome::Red(red);
                        }
                        Checks::Green => {
                            let cancelled = cancelled_required(&all, required.as_deref());
                            if cancelled.is_empty() {
                                self.check_spans(change, sha, &runs);
                                return CiOutcome::Green;
                            }
                            match self
                                .rerun_cancelled(change, repo, &cancelled, &mut reruns)
                                .await
                            {
                                None => {
                                    self.check_spans(change, sha, &runs);
                                    return CiOutcome::Red(cancelled);
                                }
                                // The re-run's time is its own.
                                Some(true) => start = self.now_ms(),
                                Some(false) => {}
                            }
                        }
                        Checks::None | Checks::Pending => {}
                    }
                }
                Checks::None | Checks::Pending => {}
            }
            if let Some(stall) = self.stalled(&last, start) {
                self.check_spans(change, sha, &last);
                // Every run finished: it is the required checks that never came, not CI that ran long.
                let stall = match stall {
                    Stall::Running if !unreported.is_empty() => {
                        let all = unreported.iter().all(|n| base_requires.contains(n));
                        let required = if all { Required::All } else { Required::NotAll };
                        Stall::Unreported(unreported, required)
                    }
                    stall => stall,
                };
                return CiOutcome::Timeout(stall);
            }
            // A pass waiting on CI is the train running: keep its source live and main CI read.
            self.options.fresh.touch(&fresh::train(repo), self.now_ms());
            if let Some(train) = self.records.train(repo) {
                self.main_ci_pass(repo, &train.project_ref).await;
            }
            self.clock.sleep(self.busy_wait(start, CI_FIRST_WAIT)).await;
        }
    }

    /// Whether the checks `required` names have all reported green on `sha`, whose check runs `runs` read green
    /// (`required_checks`), with those that have neither a run nor a status there. Its commit statuses are read only
    /// for a required check with no run. `required` None when the base's rules can't be read: then the runs alone
    /// count.
    async fn required_reported(
        &self,
        repo: &str,
        sha: &str,
        runs: &[CheckRun],
        required: Option<&[String]>,
    ) -> (Checks, Vec<String>) {
        let required = required.unwrap_or_default();
        if required
            .iter()
            .all(|n| n == TRAIN_CONTEXT || runs.iter().any(|r| &r.name == n))
        {
            return (Checks::Green, Vec::new());
        }
        match self.github.statuses(repo, sha).await {
            Ok(statuses) => {
                let missing = required
                    .iter()
                    .filter(|n| *n != TRAIN_CONTEXT)
                    .filter(|n| !runs.iter().any(|r| &r.name == *n))
                    .filter(|n| !statuses.iter().any(|s| &s.context == *n))
                    .cloned()
                    .collect();
                (required_checks(runs, &statuses, required), missing)
            }
            Err(e) => {
                tracing::warn!(repo, sha, error = %e.message, "train: commit statuses not read");
                (Checks::Pending, Vec::new())
            }
        }
    }

    /// Re-runs the jobs of each workflow run in which a required check reads cancelled, unless the train already
    /// re-ran it and GitHub doesn't show the re-run yet: whether it re-ran any. None when one can't be re-run: it isn't
    /// a workflow run's, it was re-run `CANCELLED_RERUNS` times and is cancelled again, or GitHub refused.
    async fn rerun_cancelled(
        &self,
        change: &Change,
        repo: &str,
        cancelled: &[CheckRun],
        reruns: &mut HashMap<u64, (u32, f64)>,
    ) -> Option<bool> {
        let mut runs: Vec<(u64, f64)> = Vec::new();
        for r in cancelled {
            let run = r.workflow_run()?;
            match runs.iter_mut().find(|(n, _)| *n == run) {
                Some((_, id)) => *id = id.max(r.id),
                None => runs.push((run, r.id)),
            }
        }
        let mut re_ran = false;
        for (run, newest) in runs {
            let times = match reruns.get(&run) {
                Some(&(_, seen)) if newest <= seen => continue,
                Some(&(times, _)) => times,
                None => 0,
            };
            if times >= CANCELLED_RERUNS {
                return None;
            }
            if let Err(e) = self.github.rerun_failed_jobs(repo, run).await {
                tracing::warn!(change_id = %change.change_id, run, error = %e.message, "train: cancelled run not re-run");
                return None;
            }
            tracing::info!(change_id = %change.change_id, run, "train: re-ran a run whose required checks read cancelled");
            reruns.insert(run, (times + 1, newest));
            re_ran = true;
        }
        Some(re_ran)
    }

    /// Whether CI on a head has had its time, `runs` its last checks read and `start` when the train began waiting
    /// (D128). Its running time counts from its first check's start, so time queued for scarce runners isn't spent;
    /// while every check is still queued, only `ci_queue_ceiling` applies. Never from before `start`: checks that ran
    /// before the train took the head (a run it found done, a label run it waits on) aren't its wait. A head with no
    /// checks yet, or whose provider stamps no start times, counts from `start`.
    fn stalled(&self, runs: &[CheckRun], start: i64) -> Option<Stall> {
        let now = self.now_ms();
        let over = |since: i64, limit: Duration| now - since >= limit.as_millis() as i64;
        if runs.is_empty() {
            return over(start, self.options.ci_timeout).then_some(Stall::NoChecks);
        }
        match running_since(runs, start) {
            Some(since) => {
                over(since.max(start), self.options.ci_timeout).then_some(Stall::Running)
            }
            None => over(start, self.options.ci_queue_ceiling).then_some(Stall::Queued(runs.len())),
        }
    }

    /// Whether PRs into `base` get CI: the repo has a workflow, or `base` requires a check other than the train's own.
    /// Read as adding a project reads it, cached per repo and base; a failed read is an error, not "no CI".
    /// The repos whose ready PRs wait because they have no CI, sorted, from the Changes held for it.
    pub fn repos_without_ci(&self) -> Vec<String> {
        let mut repos: Vec<String> = self
            .records
            .trains()
            .into_iter()
            .map(|t| t.repo)
            .filter(|repo| {
                self.records
                    .in_train(repo, &[ChangeState::Ready])
                    .iter()
                    .any(|c| c.last_error.as_deref() == Some(super::batch::NO_CI))
            })
            .collect();
        repos.sort();
        repos
    }

    pub(super) async fn has_ci(&self, repo: &str, base: &str) -> Result<bool, GhError> {
        let ci = self.ci_config(repo, base).await?;
        Ok(!ci.workflows.is_empty() || ci.required_checks.iter().any(|c| c != TRAIN_CONTEXT))
    }

    /// The fast set of a head into `base`: its required checks and the repo's own. None while the base's rules or the
    /// settings of the project that owns the repo's train can't be read: then every check counts.
    pub(super) async fn fast(&self, repo: &str, base: &str) -> Option<Fast> {
        let required = self.ci_config(repo, base).await.ok()?.required_checks;
        let train = self.records.train(repo)?;
        let checkout = self.train_checkout(repo, &train.project_ref);
        Some(Fast::new(&required, self.host.train_settings(&checkout)?))
    }

    /// `base`'s CI config, read at most every `CI_CONFIG_TTL_MS`.
    async fn ci_config(&self, repo: &str, base: &str) -> Result<CiInfo, GhError> {
        let key = (repo.to_string(), base.to_string());
        let now = self.now_ms();
        let cached = lock(&self.ci_configs)
            .get(&key)
            .filter(|(at, _)| now - at < CI_CONFIG_TTL_MS)
            .map(|(_, ci)| ci.clone());
        let ci = match cached {
            Some(ci) => ci,
            None => {
                let ci = self.github.ci_config(repo, base).await?;
                lock(&self.ci_configs).insert(key, (now, ci.clone()));
                ci
            }
        };
        Ok(ci)
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
            let Some(start) = r
                .started_at
                .as_deref()
                .and_then(crate::hub::store::parse_ms)
            else {
                continue;
            };
            let end = r
                .completed_at
                .as_deref()
                .and_then(crate::hub::store::parse_ms);
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

    /// The gate's `rereview`.
    pub(super) fn gate_rereview(&self, change: &Change) -> bool {
        self.gate.rereview(change)
    }

    /// The gate recorded a verdict: a train waiting on a re-review reads it now.
    pub fn review_recorded(&self) {
        self.verdicts.notify_waiters();
    }

    /// The clean `reviews` the gate bound to the Change's patch, added to it.
    pub(super) fn add_reviews(
        &self,
        change: &Change,
        reviews: Vec<ChangeReview>,
    ) -> Option<Change> {
        self.update(&change.change_id, None, |mut c| {
            for r in reviews {
                if !c.reviews.contains(&r) {
                    c.reviews.push(r);
                }
            }
            c
        })
    }

    /// Out of the train and back to review, its place in line kept: blocking findings hold it until a new head (the
    /// gate already noted them and sent them to its author), or `why` when its re-review is still at work.
    pub(super) fn to_review(&self, change: &Change, why: Option<&str>) {
        let from = [
            ChangeState::Ready,
            ChangeState::Rebasing,
            ChangeState::Ci,
            ChangeState::Merging,
        ];
        self.update(&change.change_id, Some(&from), |mut c| {
            c.state = ChangeState::Reviewing;
            if let Some(why) = why {
                c.last_error = Some(error_text(why));
            }
            c
        });
    }

    /// The Change's CI passed, but its re-review didn't finish within `review_wait`: it leaves the train for review
    /// and stays out of the line until that review is done (`overdue_review`). Why, in plain words.
    pub(super) fn review_overdue(&self, change: &Change) -> String {
        if let Some(patch) = &change.patch_id {
            lock(&self.overdue).insert((change.change_id.clone(), patch.to_string()));
        }
        format!(
            "CI passed on {}, but its re-review didn't finish within {} min; it waits in review, out of the line, and merges once the review is clean",
            short(&change.head_sha),
            self.options.review_wait.as_secs() / 60
        )
    }

    /// Whether the Change's re-review of its current patch already outlasted `review_wait` once in the train.
    pub(super) fn overdue_review(&self, change: &Change) -> bool {
        change.patch_id.as_ref().is_some_and(|patch| {
            lock(&self.overdue).contains(&(change.change_id.clone(), patch.to_string()))
        })
    }

    /// Waits for the re-reviews of `changes` (each in CI, its patch not yet approved), at most `review_wait`: each one's
    /// outcome, in order. Stops at the first blocked one, the rest then still `Waiting`.
    pub(super) async fn await_reviews(&self, changes: &[Change]) -> Vec<ReviewWait> {
        let since = self.now_ms();
        let mut out: Vec<Option<ReviewWait>> = vec![None; changes.len()];
        loop {
            // Registered before the reads, so a verdict recorded during them is not missed.
            let recorded = self.verdicts.notified();
            tokio::pin!(recorded);
            recorded.as_mut().enable();
            for (i, change) in changes.iter().enumerate() {
                if out[i].is_some() {
                    continue;
                }
                match self.gate.again(change.clone()).await {
                    Verdict::Ready(reviews) => out[i] = Some(ReviewWait::Clean(reviews)),
                    Verdict::Blocked => {
                        out[i] = Some(ReviewWait::Blocked);
                        return out
                            .into_iter()
                            .map(|o| o.unwrap_or(ReviewWait::Waiting))
                            .collect();
                    }
                    Verdict::Pending => {}
                }
            }
            let waited = self.now_ms() - since;
            let left = self.options.review_wait.as_millis() as i64 - waited;
            if out.iter().all(Option::is_some) || left <= 0 {
                return out
                    .into_iter()
                    .map(|o| o.unwrap_or(ReviewWait::Waiting))
                    .collect();
            }
            // A pass waiting on a review is the train running.
            self.options
                .fresh
                .touch(&fresh::train(&changes[0].repo), self.now_ms());
            let nap = self
                .options
                .poll_interval
                .min(Duration::from_millis(left as u64));
            tokio::select! {
                () = self.clock.sleep(nap) => {}
                () = &mut recorded => {}
            }
        }
    }

    /// A pass that could not finish: the Change goes back to ready in its place in line with the reason, and the loop
    /// retries later.
    pub(super) fn put_back(&self, change: &Change, why: &str) {
        tracing::warn!(change_id = %change.change_id, why, "train: pass failed");
        let from = [
            ChangeState::Ready,
            ChangeState::Rebasing,
            ChangeState::Ci,
            ChangeState::Merging,
        ];
        self.update(&change.change_id, Some(&from), |mut c| {
            c.state = ChangeState::Ready;
            c.last_error = Some(error_text(why));
            c
        });
    }

    /// The head of a ready Change moved: the same patch stays ready, a new one goes back to review.
    pub(super) async fn ready_moved(&self, change: &Change, pull: &Pull) -> Result<(), GhError> {
        let (head_sha, patch_id) = self.seen(change, pull).await?;
        if change.patch_id.as_ref() == Some(&patch_id) {
            self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
                c.head_sha = head_sha;
                c
            });
            return Ok(());
        }
        let reviewing = self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
            c.head_sha = head_sha;
            c.patch_id = Some(patch_id);
            c.state = ChangeState::Reviewing;
            c
        });
        if let Some(reviewing) = reviewing {
            self.to_gate(reviewing).await;
        }
        Ok(())
    }

    /// The wait before the next read of a Change the train holds (its CI, GitHub showing its rebase), `since_ms` the
    /// first read: `first` at the start, then an eighth of the time waited so far, at most `poll_interval`. CI is seen
    /// green within about an eighth of its run (a few seconds for a short one), not up to `poll_interval` later; a long
    /// one settles at the idle rate, so the extra reads are a handful per Change, all in its first minute or two.
    fn busy_wait(&self, since_ms: i64, first: Duration) -> Duration {
        let waited = Duration::from_millis((self.now_ms() - since_ms).max(0) as u64);
        (waited / 8).max(first).min(self.options.poll_interval)
    }

    /// The PR after `update-branch` rebased it. GitHub shows the new head a moment after the rebase returns; until
    /// then the PR reads as its old head, whose CI and status are not the rebase's, and a merge pinned to it is refused.
    async fn rebased_pull(&self, change: &Change) -> Result<Pull, GhError> {
        let start = self.now_ms();
        loop {
            let pull = self
                .github
                .pull(&change.repo, change.pr_number.get())
                .await?;
            if pull.head.sha.to_lowercase() != change.head_sha.as_str() {
                return Ok(pull);
            }
            if self.now_ms() - start >= self.options.ci_timeout.as_millis() as i64 {
                return Err(GhError::failed(format!(
                    "it still shows its old head {} after the rebase",
                    short(change.head_sha.as_str())
                )));
            }
            self.clock
                .sleep(self.busy_wait(start, REBASE_FIRST_WAIT))
                .await;
        }
    }

    /// Rebase on GitHub, CI, status, pinned merge: one ready Change.
    pub(super) async fn take(&self, change: &Change) {
        if let Err(e) = self.take_inner(change).await {
            self.put_back(change, &format!("GitHub: {}", e.message));
        }
    }

    async fn take_inner(&self, change: &Change) -> Result<(), GhError> {
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
            return self.ready_moved(change, &pull).await;
        }
        // A Change in review goes only as a re-review (`next`), which runs alongside its CI.
        let from = [ChangeState::Ready, ChangeState::Reviewing];
        let Some(rebasing) = self.update(&change.change_id, Some(&from), |mut c| {
            c.state = ChangeState::Rebasing;
            c
        }) else {
            return Ok(());
        };
        // Before the rebase: the push it makes then starts a CI run that already sees the label.
        let label = self
            .label(
                repo,
                change.pr_number.get(),
                pull.labelled(super::github::NEXT_LABEL),
            )
            .await;
        let base = pull.base.ref_.as_str();
        let rebased = match self
            .github
            .update_branch(repo, change.pr_number.get())
            .await?
        {
            BranchUpdate::Conflict => {
                self.needs_rebase(&rebasing, &format!("conflicts with {base}"))
                    .await;
                return Ok(());
            }
            BranchUpdate::Current => pull.clone(),
            BranchUpdate::Rebased => self.rebased_pull(change).await?,
        };
        let (head_sha, patch_id) = if rebased.head.sha.to_lowercase() == change.head_sha.as_str() {
            (change.head_sha.clone(), change.patch_id.clone())
        } else {
            let (head_sha, patch_id) = self.seen(change, &rebased).await?;
            lock(&self.pushed).insert(
                change.change_id.clone(),
                (head_sha.to_string(), self.now_ms()),
            );
            (head_sha, Some(patch_id))
        };
        // Reviews are bound to the patch id: a rebase that changed it is reviewed again, alongside its CI. The merge
        // waits for both.
        let moved = patch_id != rebasing.patch_id;
        let Some(in_ci) = self.update(
            &change.change_id,
            Some(&[ChangeState::Rebasing]),
            |mut c| {
                c.head_sha = head_sha.clone();
                c.state = ChangeState::Ci;
                if moved {
                    c.patch_id = patch_id.clone();
                    c.last_error = Some(last_error(format!(
                        "the rebase onto {base} changed the patch id; its re-review runs alongside CI"
                    )));
                }
                c
            },
        ) else {
            return Ok(());
        };
        let in_ci = if moved || !super::batch::reviewed(&in_ci) {
            match self.gate.review(in_ci.clone()).await {
                Verdict::Ready(reviews) => self.add_reviews(&in_ci, reviews).unwrap_or(in_ci),
                Verdict::Blocked => {
                    self.to_review(&in_ci, None);
                    return Ok(());
                }
                Verdict::Pending => in_ci,
            }
        } else {
            in_ci
        };
        self.ci_and_merge(&in_ci, &rebased, base, label).await
    }

    /// From CI on the Change's head, in `ci`, to merged: waits for its fast set, posts `fleetd/train` and merges
    /// pinned to that head. `rebased` is its PR at that head, `base` what it merges into, `label` how `fleetd:next`
    /// went on. Taking a Change and finding one in CI after a restart both end here.
    async fn ci_and_merge(
        &self,
        in_ci: &Change,
        rebased: &Pull,
        base: &str,
        label: super::next::Labelled,
    ) -> Result<(), GhError> {
        let (change, repo, head_sha) = (in_ci, in_ci.repo.as_str(), in_ci.head_sha.clone());
        let lone = match self.label_gate(repo, base).await {
            super::next::Gate::Checks(names) if names.is_empty() => None,
            gate => Some(super::next::Lone { label, gate }),
        };
        let noted = std::slice::from_ref(&in_ci.change_id);
        match self
            .wait_ci(in_ci, repo, &head_sha, base, lone, noted)
            .await
        {
            CiOutcome::Green => {}
            CiOutcome::Red(failing) => {
                self.ci_failed(in_ci, &failing, None).await;
                return Ok(());
            }
            CiOutcome::Timeout(stall) => {
                self.ci_failed(in_ci, &[], Some(stall)).await;
                return Ok(());
            }
        };
        // CI passed: the merge also waits for a re-review still at work.
        let current = self.records.get(&change.change_id);
        if let Some(current) = current.filter(|c| !super::batch::reviewed(c)) {
            match self
                .await_reviews(std::slice::from_ref(&current))
                .await
                .remove(0)
            {
                ReviewWait::Clean(reviews) => {
                    self.add_reviews(&current, reviews);
                }
                ReviewWait::Blocked => {
                    self.to_review(&current, None);
                    return Ok(());
                }
                ReviewWait::Waiting => {
                    let why = self.review_overdue(&current);
                    self.to_review(&current, Some(&why));
                    return Ok(());
                }
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
        // The squash message GitHub would write by the repo's settings, with the Change's trailer added.
        let (title, body) = self.github.squash_message(repo, rebased).await?;
        let body = super::batch::with_trailers(&body, [&merging]);
        let merging_since = self.now_ms();
        let mut retry_wait = MERGE_RETRY_FIRST;
        let (status, message) = loop {
            let (status, message) = match self
                .github
                .merge(
                    repo,
                    change.pr_number.get(),
                    &head_sha,
                    Some((&title, &body)),
                )
                .await?
            {
                MergeOutcome::Merged { sha } => {
                    self.watch_merge(repo, base, &sha, merging.pr_url.as_str());
                    self.finish_merged(&merging, Some(&sha), None).await;
                    return Ok(());
                }
                MergeOutcome::Refused { status, message } => (status, message),
            };
            let waited = self.now_ms() - merging_since;
            if !awaits_checks(&message) || waited >= self.options.ci_timeout.as_millis() as i64 {
                break (status, message);
            }
            // GitHub still waits on a required check for this head: wait for it too and merge again, with no try
            // spent and no push asked of the author.
            tracing::info!(change_id = %change.change_id, message, "train: merge refused until checks report");
            let why = format!(
                "GitHub refused the merge (HTTP {status}): {message}; the train waits for those checks"
            );
            let back = |mut c: Change| {
                c.state = ChangeState::Ci;
                c.last_error = Some(error_text(&why));
                c
            };
            let Some(in_ci) = self.update(&change.change_id, Some(&[ChangeState::Merging]), back)
            else {
                return Ok(());
            };
            self.clock.sleep(retry_wait).await;
            retry_wait = (retry_wait * 2).min(MERGE_RETRY_MAX);
            // GitHub may require a check the cached config doesn't name yet: read the base's rules again, and the
            // head's checks with them.
            lock(&self.ci_configs).remove(&(repo.to_string(), base.to_string()));
            match self
                .wait_ci(&in_ci, repo, &head_sha, base, None, noted)
                .await
            {
                CiOutcome::Green => {}
                CiOutcome::Red(failing) => {
                    self.ci_failed(&in_ci, &failing, None).await;
                    return Ok(());
                }
                CiOutcome::Timeout(stall) => {
                    self.ci_failed(&in_ci, &[], Some(stall)).await;
                    return Ok(());
                }
            }
            if self
                .update(&change.change_id, Some(&[ChangeState::Ci]), |mut c| {
                    c.state = ChangeState::Merging;
                    c
                })
                .is_none()
            {
                return Ok(());
            }
        };

        let refusals = {
            let mut map = lock(&self.merge_refusals);
            let n = map.entry(change.change_id.clone()).or_default();
            *n += 1;
            *n
        };
        let why = format!("GitHub refused the merge (HTTP {status}): {message}");
        if refusals < self.options.merge_attempts {
            // Usually the base moved between CI and the merge: rebase again. It never left its place in line.
            self.update(&change.change_id, Some(&[ChangeState::Merging]), |mut c| {
                c.state = ChangeState::Ready;
                c.last_error = Some(error_text(&why));
                c
            });
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

    /// Changes waiting on something outside the train: a patch id to read, reviews, or the author's next push. A
    /// waiting Change GitHub finds conflicting goes back to its author at once: GitHub runs no CI on it (D191).
    async fn refresh(&self, repo: &str) {
        let waiting = [
            ChangeState::Queued,
            ChangeState::Reviewing,
            ChangeState::Ready,
            ChangeState::NeedsRebase,
            ChangeState::CiFailed,
        ];
        let changes = self.records.in_train(repo, &waiting);
        lock(&self.unstarted).retain(|id, _| changes.iter().any(|c| &c.change_id == id));
        for change in changes {
            let pull = match self.github.pull(repo, change.pr_number.get()).await {
                Ok(pull) => pull,
                Err(e) => {
                    tracing::warn!(change_id = %change.change_id, error = %e.message, "train: refresh failed");
                    continue;
                }
            };
            self.guard_base(repo, &pull.base.ref_);
            let moved = pull.head.sha.to_lowercase() != change.head_sha.as_str();
            let in_line = !moved
                && !pull.draft
                && [
                    ChangeState::Queued,
                    ChangeState::Reviewing,
                    ChangeState::Ready,
                ]
                .contains(&change.state);
            if pull.merged {
                self.abandon(&change, "was merged outside the train").await;
            } else if pull.state != "open" {
                self.abandon(&change, "was closed").await;
            } else if change.state == ChangeState::Queued && pull.draft {
                self.hold_draft(&change);
            } else if in_line && pull.conflicts() {
                let why = format!(
                    "conflicts with {}, so GitHub runs no CI on it",
                    pull.base.ref_
                );
                self.needs_rebase(&change, &why).await;
            } else if change.state == ChangeState::Ready {
                // The train takes it from here, and reads a moved head then (`take`).
                if in_line {
                    self.unstarted_checks(&change, &pull.base.ref_).await;
                }
            } else if change.state == ChangeState::Queued || moved {
                if let Err(e) = self.admit(&change, &pull).await {
                    let why = error_text(&format!("GitHub: {}", e.message));
                    self.update(&change.change_id, Some(&[change.state]), |mut c| {
                        c.last_error = Some(why);
                        c
                    });
                }
            } else if change.state == ChangeState::Reviewing
                && let Verdict::Ready(reviews) = self.gate.again(change.clone()).await
            {
                self.set_ready(&change, reviews);
            } else if timed_out(&change) {
                self.after_timeout(&change).await;
            } else if in_line {
                self.unstarted_checks(&change, &pull.base.ref_).await;
            }
        }
    }

    /// A Change in line whose head has no check `checks_start_wait` after the train first saw it: GitHub skipped its
    /// CI, or no workflow took the push. Only the base's required checks count when it has any; else any check does.
    /// Its author and the lead hear once per head, and it keeps its place (D191).
    async fn unstarted_checks(&self, change: &Change, base: &str) {
        let head = change.head_sha.as_str();
        let now = self.now_ms();
        {
            let mut seen = lock(&self.unstarted);
            let entry = seen
                .entry(change.change_id.clone())
                .or_insert_with(|| (head.to_string(), now, false));
            if entry.0 != head {
                *entry = (head.to_string(), now, false);
            }
            if entry.2 || now - entry.1 < self.options.checks_start_wait.as_millis() as i64 {
                return;
            }
        }
        let Ok(ci) = self.ci_config(&change.repo, base).await else {
            return;
        };
        let required: Vec<&String> = ci
            .required_checks
            .iter()
            .filter(|c| *c != TRAIN_CONTEXT)
            .collect();
        if ci.workflows.is_empty() && required.is_empty() {
            return;
        }
        let counts = |name: &str| {
            name != TRAIN_CONTEXT && (required.is_empty() || required.iter().any(|r| *r == name))
        };
        let started = match self.github.check_runs(&change.repo, head).await {
            Ok(runs) if runs.iter().any(|r| counts(&r.name)) => true,
            Ok(_) => match self.github.statuses(&change.repo, head).await {
                Ok(statuses) => statuses.iter().any(|s| counts(&s.context)),
                Err(e) => {
                    return tracing::warn!(change_id = %change.change_id, error = %e.message, "train: statuses not read");
                }
            },
            Err(e) => {
                return tracing::warn!(change_id = %change.change_id, error = %e.message, "train: check runs not read");
            }
        };
        if let Some(entry) = lock(&self.unstarted).get_mut(&change.change_id) {
            entry.2 = true;
        }
        if started {
            return;
        }
        let min = self.options.checks_start_wait.as_secs() / 60;
        let text = format!(
            "no check started on its head {} in {min} min: GitHub skipped its CI, or no workflow took the push. It \
             keeps its place in the train; push to it again (an empty commit will do) to start its CI",
            short(head)
        );
        if let Some(task_id) = &change.task_id {
            let message = format!("Your PR {} ({}): {text}.", change.pr_url, change.change_id);
            if let Err(e) = self
                .host
                .message_task(&change.project_ref, TRAIN_BY, task_id, message)
                .await
            {
                tracing::warn!(change_id = %change.change_id, task_id = %task_id, error = %e, "train: author not messaged");
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

    /// A queued Change whose PR is a draft waits there, saying so, until the PR is marked ready.
    fn hold_draft(&self, change: &Change) {
        if !is_draft(change) {
            self.update(&change.change_id, Some(&[ChangeState::Queued]), |mut c| {
                c.last_error = Some(last_error(DRAFT));
                c
            });
        }
    }

    /// A Change whose CI timed out, at the same head: once its checks finish green it goes back in the queue, where
    /// the train rebases it as for any ready Change and merges on the green run it finds; once one is red, it fails
    /// as red CI does (D128).
    async fn after_timeout(&self, change: &Change) {
        let runs = match self
            .github
            .check_runs(&change.repo, change.head_sha.as_str())
            .await
        {
            Ok(runs) => runs,
            Err(e) => {
                return tracing::warn!(change_id = %change.change_id, error = %e.message, "train: check runs not read");
            }
        };
        let base = match self.github.pull(&change.repo, change.pr_number.get()).await {
            Ok(pull) => pull.base.ref_,
            Err(e) => {
                return tracing::warn!(change_id = %change.change_id, error = %e.message, "train: PR not read");
            }
        };
        let fast = self.fast(&change.repo, &base).await;
        let judged = match checks(&gated(&runs, fast.as_ref())) {
            Checks::None if !runs.is_empty() => Checks::Green,
            judged => judged,
        };
        let judged = match judged {
            Checks::Green => {
                let required = self
                    .ci_config(&change.repo, &base)
                    .await
                    .ok()
                    .map(|c| c.required_checks);
                let waits = must_report(fast.as_ref(), required.as_deref());
                self.required_reported(&change.repo, &change.head_sha, &runs, waits.as_deref())
                    .await
                    .0
            }
            judged => judged,
        };
        match judged {
            Checks::Green => {
                if self.set_ready(change, Vec::new()).is_some() {
                    let line = Event::PrNote {
                        change: change.change_id.as_str(),
                        pr_url: change.pr_url.as_str(),
                        text: CI_FINISHED_LATE,
                    }
                    .render();
                    self.wake_lead(&change.project_ref, line).await;
                }
            }
            Checks::Red(red) => self.ci_failed(change, &red, None).await,
            Checks::None | Checks::Pending => {}
        }
    }

    /// A writer's ready PR is a slice: any open PR that is not a draft, from the writer's branch or one named after
    /// it (`<branch>-<n>`), goes on the train at once as that writer's, so its review starts while the writer works
    /// on. Once per head, and not while the train already has it. Read from the repo's open PRs at once when a writer
    /// prints a PR URL or ends (`writer_opened_pr`), and every `ready_every` as the backstop, so it needs no webhook
    /// and nothing from the writer.
    async fn ready_pass(&self, repo: &str, project_ref: &ProjectRef) {
        let now = self.now_ms();
        let due = lock(&self.last_ready_check)
            .get(repo)
            .is_none_or(|at| now - at >= self.options.ready_every.as_millis() as i64);
        if !due {
            return;
        }
        let writers = self.host.writers(project_ref);
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
        for pull in pulls.into_iter().filter(|p| !p.draft) {
            let head_ref = pull.head.ref_.as_str();
            let Some((task_id, _)) = writers.iter().find(|(_, b)| {
                head_ref == b
                    || head_ref
                        .strip_prefix(b.as_str())
                        .is_some_and(|r| r.starts_with('-'))
            }) else {
                continue;
            };
            if self.records.open_for(repo, pull.number).is_some() {
                continue;
            }
            let head = (repo.to_string(), pull.number, pull.head.sha.to_lowercase());
            if !lock(&self.ready_heads).insert(head) {
                continue;
            }
            let pr_url = format!("https://github.com/{repo}/pull/{}", pull.number);
            let pr = GitHubPrUrl::unchecked(pr_url.clone());
            match super::calls::slice_ready(self, project_ref, task_id, pr).await {
                Ok(change) => {
                    tracing::info!(change_id = %change.change_id, %pr_url, "train: a writer's ready PR is a slice")
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

    /// After a restart: a Change the train was merging is finished if GitHub merged it, else put back in its place in
    /// line. CI in flight is not lost: a Change alone in `ci` whose PR is still at the head it took, or a batch whose
    /// open PR still names its members at theirs, is watched where it is and merges once green.
    async fn recover(&self, repo: &str) {
        let in_ci = self.records.in_train(repo, &[ChangeState::Ci]);
        let resumed = match in_ci.as_slice() {
            [] => false,
            [one] => self.resume_ci(one).await || self.resume_batch(repo, &in_ci).await,
            _ => self.resume_batch(repo, &in_ci).await,
        };
        for change in self.records.in_train(repo, HEAD_STATES) {
            if resumed && in_ci.iter().any(|c| c.change_id == change.change_id) {
                continue;
            }
            let pull = self.github.pull(repo, change.pr_number.get()).await;
            if let Ok(pull) = &pull {
                self.guard_base(repo, &pull.base.ref_);
            }
            match pull {
                Ok(pull) if pull.merged && change.state == ChangeState::Merging => {
                    self.finish_merged(&change, pull.merge_commit_sha.as_deref(), None)
                        .await
                }
                Ok(pull) if change.state == ChangeState::Merging && pull.state == "open" => {
                    match self.landed_in_batch(&change).await {
                        Some(landed) => self.finish_batch_member(&change, &landed).await,
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

    /// A Change alone in `ci` at a restart, its PR open at the head it took, no batch PR naming it: its CI is watched
    /// again and it merges once green. False when it isn't such a Change.
    async fn resume_ci(&self, change: &Change) -> bool {
        let Ok(pull) = self.github.pull(&change.repo, change.pr_number.get()).await else {
            return false;
        };
        if pull.merged
            || pull.state != "open"
            || pull.head.sha.to_lowercase() != change.head_sha.as_str()
        {
            return false;
        }
        // A batch member's head is in CI on the batch's PR, not its own.
        if let Some(branch) = self.scratch_branch(change, "batch").await
            && let Ok(open) = self.github.pulls_for(&change.repo, &branch, "open").await
            && open.iter().any(|b| {
                batch_heads(b.body.as_deref().unwrap_or_default())
                    .iter()
                    .any(|(n, _)| *n == change.pr_number.get())
            })
        {
            return false;
        }
        tracing::info!(change_id = %change.change_id, "train: the hub restarted; watching its CI again");
        self.guard_base(&change.repo, &pull.base.ref_);
        let label = self
            .label(
                &change.repo,
                change.pr_number.get(),
                pull.labelled(super::github::NEXT_LABEL),
            )
            .await;
        if let Err(e) = self
            .ci_and_merge(change, &pull, &pull.base.ref_, label)
            .await
        {
            self.put_back(change, &format!("GitHub: {}", e.message));
        }
        true
    }

    fn guard_base(&self, repo: &str, base: &str) {
        lock(&self.bases)
            .entry(repo.to_lowercase())
            .or_default()
            .insert(base.to_owned());
    }

    /// PRs merged without the train into the repo's default branch or a base its Changes target: each one is reported
    /// once, as `pr.merged_outside`, and as a line to the lead unless the landing scanner watches that base. Others
    /// share the repo, not the train: another fleet's namespace, or a branch fleetd never merges into. The train's own
    /// batch PRs (its scratch branches) are its merges.
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
        let merged = match self.github.merged_pulls(repo, watch_since_ms).await {
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
            let Some(at) = parse_ms(&pr.merged_at).filter(|at| *at > watch_since_ms) else {
                continue;
            };
            // The watch moves past every merge read, the train's own too, so the next read stops at its first page.
            newest = newest.max(at);
            if pr.base != default && !guarded.contains(&pr.base) || pr.head.starts_with(&scratch) {
                continue;
            }
            let change = self.records.latest_for(repo, pr.number);
            if change
                .as_ref()
                .is_some_and(|c| c.state == ChangeState::Merged)
            {
                continue;
            }
            let project_ref = change.as_ref().map_or(project_ref, |c| &c.project_ref);
            let mut data = json!({
                "repo": repo, "prNumber": pr.number, "mergedAt": iso_ms(at), "head": pr.head, "base": pr.base,
            });
            if let Some(sha) = &pr.merge_sha {
                data["mergedSha"] = json!(sha.to_lowercase());
            }
            if let Some(created) = pr.created_at.as_deref().and_then(parse_ms) {
                data["prCreatedAt"] = json!(iso_ms(created));
            }
            if let Some(bot) = pr.author_bot {
                data["authorKind"] = json!(if bot { "bot" } else { "human" });
            }
            // Only the PR's detail names who merged it; a merge made by the person is one of their touches.
            if let Ok(Some(by)) = self.github.pull(repo, pr.number).await.map(|p| p.merged_by) {
                data["mergedByKind"] = json!(if by.kind == "Bot" { "bot" } else { "human" });
                data["mergedBy"] = json!(by.login);
            }
            if let Some(c) = &change {
                data["changeId"] = json!(c.change_id);
            }
            let line = format!(
                "{repo}#{} was merged into {} without the merge train.",
                pr.number, pr.base
            );
            self.emit(project_ref, "pr.merged_outside", line.clone(), data);
            // Where the landing scanner watches, its `work.landed` line tells the lead, once.
            if !self.host.landings_watched(repo, &pr.base) {
                self.wake_lead(project_ref, line).await;
            }
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
        // Before refresh: a member of a batch that landed is merged, never read as a waiting PR that conflicts.
        self.reconcile_batches(&repo).await;
        self.refresh(&repo).await;
        self.ready_pass(&repo, &train.project_ref).await;
        self.main_ci_pass(&repo, &train.project_ref).await;
        self.watch_pass(&repo).await;
        self.check_merged_outside(&repo, train.watch_since_ms, &train.project_ref)
            .await;
        self.sweep_scratch(&repo).await;
        self.after_pass(&repo).await;
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
        fresh.expect(&fresh::github(repo), fresh::GITHUB_STALE_MS, now);
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

    /// A train on `repo` for `project_ref` whose main CI last read red with `failing`, each check with a fix order
    /// `fix` when given, as `main_ci_pass` and `watch` would leave it.
    #[cfg(test)]
    pub(crate) fn main_red_for_test(
        &self,
        repo: &str,
        project_ref: &ProjectRef,
        failing: &[&str],
        fix: Option<&WorkstreamId>,
    ) {
        let now = self.now_ms();
        self.records.ensure_train(repo, project_ref, now);
        self.sync.set_base(repo, "main".into());
        let failing: Vec<String> = failing.iter().map(|f| f.to_string()).collect();
        if let Some(order) = fix {
            for check in &failing {
                self.records.put_fix_order(repo, check, "a1", order, now);
            }
        }
        self.sync
            .record(repo, "a1".into(), CiState::Red, failing, now);
    }

    /// While main-branch CI is red, a note for the status view: which checks, and whether a fix is under way (an open
    /// fix order for the check, `watch`). The train doesn't hold merges for it, so it is a warning, not a block.
    pub fn main_ci_note(&self, repo: &str) -> Option<String> {
        let repo = repo.to_lowercase();
        let ci = self
            .sync
            .main_ci(&repo)
            .filter(|m| m.state == CiState::Red)?;
        let base = self.sync.base(&repo).unwrap_or_else(|| "main".into());
        let fixing: Vec<&String> = ci
            .failing
            .iter()
            .filter(|name| {
                self.records
                    .fix_order(&repo, name)
                    .and_then(|(_, order)| self.host.workstream(&order))
                    .is_some_and(|o| o.open)
            })
            .collect();
        let quoted = |names: &mut dyn Iterator<Item = &String>| {
            names
                .map(|n| format!("`{n}`"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let what = match ci.failing.len() {
            0 => format!("CI is red on {base}"),
            1 => format!("{} is red on {base}", quoted(&mut ci.failing.iter())),
            _ => format!("{} are red on {base}", quoted(&mut ci.failing.iter())),
        };
        let fix = if fixing.is_empty() {
            "no fix under way".to_string()
        } else if fixing.len() == ci.failing.len() {
            "fix in progress".to_string()
        } else {
            format!("fix in progress for {}", quoted(&mut fixing.into_iter()))
        };
        Some(format!("{what}, {fix}"))
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

    /// Validates the PR and puts it on its repo's train; the same open PR returns its Change.
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
        let repos = self.host.github_repos(project_ref);
        // Only a project with several repos (stage 2) is held to them: a one-repo project's lead has always enqueued PRs
        // of other repos too, such as a fork's upstream.
        if repos.len() >= 2 && !repos.iter().any(|(r, _)| *r == repo) {
            let names: Vec<&str> = repos.iter().map(|(r, _)| r.as_str()).collect();
            let refusal = Refusal::new(
                format!(
                    "{repo} is not one of this project's repos ({}).",
                    names.join(", ")
                ),
                "enqueue a PR of one of its repos, or have a person add the repo to the project",
            );
            return Err(self.refuse(project_ref, &pr_url, refusal, None).await);
        }
        let after = upstreams(input.after.as_deref().map_or(&[][..], Vec::as_slice));
        if after.iter().any(|u| u.as_str() == pr_url) {
            let refusal = Refusal::new("It names itself in `after`.", "drop it from `after`");
            return Err(self.refuse(project_ref, &pr_url, refusal, None).await);
        }
        // One enqueue with `after` at a time, from the loop check until its Change records them, so two at once can't
        // each wait on the other.
        let _order = if after.is_empty() {
            None
        } else {
            Some(self.after_lock.lock().await)
        };
        if let Some(upstream) = self.loops_back(&pr_url, &after) {
            let refusal = Refusal::new(
                format!("{upstream} already waits on it, so neither could merge."),
                format!("drop {upstream} from `after`"),
            );
            return Err(self.refuse(project_ref, &pr_url, refusal, None).await);
        }
        let task = input.task_id.as_ref().and_then(|id| self.host.task(id));
        if let Some(task_id) = &input.task_id
            && !task.as_ref().is_some_and(|t| t.project_ref == *project_ref)
        {
            return Err(TrainError::new(
                "not_found",
                format!("No task {task_id} in this project."),
                Some("Call `agents`."),
            ));
        }
        let enqueue_lock = repo_lock(&self.enqueue_locks, &format!("{repo}#{pr_number}"));
        let held = enqueue_lock.lock().await;
        if let Some(existing) = self.records.open_for(&repo, pr_number) {
            if HEAD_STATES.contains(&existing.state)
                && after.iter().any(|u| !existing.after.contains(u))
            {
                drop(held);
                let refusal = Refusal::new(
                    "It is already being merged (rebasing, in CI or merging), so it can't wait on another PR now.",
                    "to keep it from landing first, add the `hold` label to it, and remove the label once the other PR merges",
                );
                return Err(self.refuse(project_ref, &pr_url, refusal, None).await);
            }
            let existing = self.add_after(existing, &after);
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
        if !workstream.has_brief {
            let refusal = Refusal::new(
                format!("{workstream_id} has no brief yet."),
                format!("register its brief with `brief` for {workstream_id} first"),
            );
            return Err(self.refuse(project_ref, &pr_url, refusal, None).await);
        }

        let pull = self.github.pull(&repo, pr_number).await.map_err(|e| {
            TrainError::new(
                "invalid",
                format!("Could not read {pr_url} from GitHub: {}", e.message),
                Some("Check the URL; the hub reads PRs with its own `gh` login."),
            )
        })?;
        self.guard_base(&repo, &pull.base.ref_);
        let now = self.now_iso();
        let row = Change {
            change_id: ChangeId::unchecked("X0"),
            project_ref: project_ref.clone(),
            repo: GitHubRepo::unchecked(repo.clone()),
            pr_number: Positive::unchecked(pr_number),
            pr_url: GitHubPrUrl::unchecked(pr_url.clone()),
            branch: NonEmpty::unchecked(pull.head.ref_.clone()),
            task_id: input.task_id.clone(),
            workstream_id: workstream_id.clone(),
            head_sha: CommitSha::unchecked(pull.head.sha.to_lowercase()),
            patch_id: None,
            state: ChangeState::Queued,
            reviews: Vec::new(),
            position: None,
            last_error: None,
            merged_sha: None,
            after,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
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
        self.records.ensure_train(&repo, project_ref, self.now_ms());
        self.train_project(&repo, project_ref);
        let at = self.now_iso();
        let change = self.records.create(Change {
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
                "{} queued: {repo}#{}",
                change.change_id, change.pr_number
            ),
            json!({ "changeId": change.change_id, "workstreamId": change.workstream_id, "repo": repo, "prNumber": change.pr_number }),
        );
        // If reading the patch id fails, the loop retries it from `queued`.
        if pull.draft {
            self.hold_draft(&change);
        } else if let Err(e) = self.admit(&change, &pull).await {
            let why = error_text(&format!("GitHub: {}", e.message));
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

    /// A clean review is bound to the Change's current patch id; it may be taken. For the review gate.
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
    // it on the train. The result names one PR, so the ready pass runs now for any other slices the writer opened. A
    // refusal goes to the lead with its fix.
    async fn on_task_completed(&self, data: &Value) {
        if let Some(task_id) = data.get("taskId").and_then(Value::as_str) {
            self.on_task_pr(task_id).await;
        }
    }

    /// The same for a write task whose result names its PR: at `task.completed`, and again when tasks set the PR
    /// after it (D67: the host lookup runs after the task ends), so its Change carries the task and plan items it
    /// serves close when it merges.
    pub async fn on_task_pr(&self, task_id: &str) {
        let Some(task) = self
            .host
            .task(&super::contract::TaskId::unchecked(task_id))
            .filter(|t| t.kind == "write")
        else {
            return;
        };
        self.writer_opened_pr(&task.project_ref);
        let Some(pr_url) = task.pr_url.clone().filter(|u| parse_pr_url(u).is_some()) else {
            return;
        };
        let input = ChangeEnqueueCall {
            task_id: Some(task.task_id.clone()),
            pr_url: GitHubPrUrl::unchecked(pr_url.clone()),
            workstream_id: None,
            after: None,
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

/// The one message that sends a PR back to its author: what is wrong (`problem`), a review's `findings` if any.
pub fn fix_your_pr(set: &PromptSet, change: &Change, problem: &str, findings: &str) -> String {
    let findings = match findings.trim() {
        "" => String::new(),
        f => format!("\n\n{f}\n"),
    };
    set.render(
        "pr.fix",
        &[
            ("pr", &format!("{} ({})", change.pr_url, change.change_id)),
            ("problem", &problem),
            ("findings", &findings),
            ("branch", &change.branch),
        ],
    )
}
