//! `wait_ci`: a task asks to be woken when a GitHub Actions run, or the checks on a PR's head, finish. Each wait is a
//! row in `ci_waits`; every [`POLL_EVERY`] the hub reads GitHub for each, and one that finished continues its task's
//! thread (a running task takes it at its next tool boundary) with one line: the outcome and the failing jobs.
//!
//! With `merged`, a PR's wait ends only when the PR merges, read from the merge train (a batch merges its PRs by
//! closing them, so GitHub alone can't say): a writer whose next step needs another PR in waits on it so. It wakes its
//! task too when the PR fails on the train (and goes on, as its writer fixes it) or is closed unmerged (and ends).
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::WaitCiResult;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::prim::Text;
use fleetd_contracts::tasks::{TaskId, TaskKind, TaskState};
use fleetd_contracts::train::GitHubPrUrl;
use rusqlite::params;

use super::ports::TaskError;
use super::{TaskCaller, Tasks, holds_pr, lead_error, store_error};
use crate::hub::api::Hub;
use crate::hub::reviews::read::open_blocking;
use crate::hub::store::{now_ms, parse_ms};
use crate::hub::train::next::{CLOSED, WAITING_ON};
use crate::hub::work::BoxFut;

pub const POLL_EVERY: Duration = Duration::from_secs(60);
/// A wait still open this long ends, telling its task so.
pub const GIVE_UP_MS: i64 = 6 * 3600 * 1000;
/// A wait with `merged` still open this long ends: a PR can sit in the train's line for hours.
pub const MERGE_GIVE_UP_MS: i64 = 24 * 3600 * 1000;
/// GitHub reads that fail in a row before the wait ends, telling its task why.
pub const READ_TRIES: i64 = 3;
/// A PR head counts as finished only once its last check completed this long ago: a workflow another one starts, or
/// a label's, registers its jobs a little after the first ones end.
pub const SETTLE_MS: i64 = 2 * 60_000;
const PER_TASK: i64 = 10;
/// Failing jobs named in the line; the rest are counted.
const NAMED: usize = 10;
const BY: &str = "ci";

/// What a wait names: an Actions run, or a PR whose current head's checks count.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Run { repo: String, id: u64 },
    Pr { repo: String, number: i64 },
}

impl Target {
    pub fn url(&self) -> String {
        match self {
            Target::Run { repo, id } => format!("https://github.com/{repo}/actions/runs/{id}"),
            Target::Pr { repo, number } => format!("https://github.com/{repo}/pull/{number}"),
        }
    }
}

/// `https://github.com/<owner>/<repo>/actions/runs/<id>[/…]` or `…/pull/<n>[/…]`.
pub fn target_of(url: &str) -> Option<Target> {
    let rest = url.trim().strip_prefix("https://github.com/")?;
    let mut parts = rest.split(['/', '?', '#']);
    let (owner, name) = (parts.next()?, parts.next()?);
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    let repo = format!("{owner}/{name}");
    match (parts.next()?, parts.next()?, parts.next()) {
        ("actions", "runs", Some(id)) => Some(Target::Run {
            repo,
            id: id.parse().ok().filter(|&n| n > 0)?,
        }),
        ("pull", n, _) => Some(Target::Pr {
            repo,
            number: n.parse().ok().filter(|&n| n > 0)?,
        }),
        _ => None,
    }
}

/// What GitHub says of a target now.
#[derive(Clone, Debug, PartialEq)]
pub enum Read {
    Running,
    /// Every job (a run's) or check (a PR head's) completed: `failing` names those that didn't pass, of `total`.
    Finished {
        /// A run's conclusion ("success", "failure", "cancelled"); none for a PR head.
        conclusion: Option<String>,
        /// The workflow's name, for a run; the head's short SHA, for a PR.
        label: String,
        failing: Vec<String>,
        total: usize,
    },
    /// Nothing more will happen: why, in a few words ("was merged", "GitHub has no such run").
    Over(String),
}

/// One check run on a PR's head, as [`head_read`] needs it.
pub struct Check {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub completed_ms: Option<i64>,
}

/// A PR head's state from its workflow runs' statuses and its check runs (the latest of each): running while any run
/// or check is, while it has none yet, and for [`SETTLE_MS`] after its last check completed.
pub fn head_read(sha: &str, runs: &[String], checks: &[Check], now: i64) -> Read {
    let last = checks.iter().filter_map(|c| c.completed_ms).max();
    if checks.is_empty()
        || runs.iter().any(|r| r != "completed")
        || checks.iter().any(|c| c.status != "completed")
        || last.is_none_or(|at| now - at < SETTLE_MS)
    {
        return Read::Running;
    }
    Read::Finished {
        conclusion: None,
        label: sha.chars().take(7).collect(),
        failing: checks
            .iter()
            .filter(|c| !passed(c.conclusion.as_deref()))
            .map(|c| c.name.clone())
            .collect(),
        total: checks.len(),
    }
}

/// Where a PR a wait with `merged` names stands.
#[derive(Clone, Debug, PartialEq)]
pub enum Merge {
    /// Neither merged nor failed: in the train's line or CI, back with its writer, or not on the train yet.
    Pending,
    Merged,
    /// It failed on the train, why ("its CI failed"): its writer fixes it, so the wait goes on.
    Failed(String),
    /// It won't merge, why: closed unmerged, or of a project the task's person doesn't see (D338).
    Over(String),
}

/// GitHub's reads, and the train's for `merged`; the hub's go through the train and its `gh` client, tests fake them.
pub trait CiReads: Send + Sync {
    fn read<'a>(&'a self, target: &'a Target) -> BoxFut<'a, Result<Read, String>>;
    /// The PR's way to merging, as `by`'s person may see it.
    fn merge<'a>(&'a self, by: &'a ProjectRef, target: &'a Target) -> BoxFut<'a, Merge>;
}

/// The task's line for a finished wait.
pub fn summary(target: &Target, read: &Read) -> Option<String> {
    let url = target.url();
    let line = match read {
        Read::Running => return None,
        Read::Over(why) => format!("{url} {why}."),
        Read::Finished {
            conclusion,
            label,
            failing,
            total,
        } => {
            let mut names = failing.iter().take(NAMED).cloned().collect::<Vec<_>>();
            if failing.len() > NAMED {
                names.push(format!("and {} more", failing.len() - NAMED));
            }
            let names = names.join(", ");
            match (target, conclusion.as_deref()) {
                (Target::Run { .. }, Some("success")) if failing.is_empty() => {
                    format!("{url} ({label}) succeeded: all {total} jobs passed.")
                }
                (Target::Run { .. }, c) if failing.is_empty() => {
                    format!(
                        "{url} ({label}) ended {}.",
                        c.unwrap_or("without a conclusion")
                    )
                }
                (Target::Run { .. }, c) => format!(
                    "{url} ({label}) ended {}: {} of {total} jobs failed: {names}.",
                    c.unwrap_or("without a conclusion"),
                    failing.len()
                ),
                (Target::Pr { .. }, _) if failing.is_empty() => {
                    format!("{url} at {label}: all {total} checks passed.")
                }
                (Target::Pr { .. }, _) => format!(
                    "{url} at {label}: {} of {total} checks failed: {names}.",
                    failing.len()
                ),
            }
        }
    };
    Some(format!("CI you waited on (wait_ci) finished: {line}"))
}

fn refused(message: String, fix: &str) -> TaskError {
    lead_error(ErrorCode::Invalid, message, Some(fix))
}

impl Tasks {
    /// Keeps `url` for `task_id` until it finishes, or with `merged` (a PR's only), until it merges. Only a run or PR
    /// in one of the task's project's repos, or the task's own PR's repo.
    pub fn wait_ci(
        &self,
        task_id: &TaskId,
        url: &str,
        merged: bool,
    ) -> Result<WaitCiResult, TaskError> {
        let Some(task) = self.get(task_id).map_err(store_error)? else {
            return Err(lead_error(
                ErrorCode::NotFound,
                format!("No task {}.", task_id.as_str()),
                None,
            ));
        };
        let Some(target) = target_of(url) else {
            return Err(refused(
                format!(
                    "{} is not a GitHub Actions run or pull request URL.",
                    url.trim()
                ),
                "Pass https://github.com/<owner>/<repo>/actions/runs/<id> (`gh run view <id> --json url -q .url`) \
                 or the PR's URL.",
            ));
        };
        if merged && !matches!(target, Target::Pr { .. }) {
            return Err(refused(
                format!("{} is not a pull request: only a PR merges.", target.url()),
                "Pass the PR's URL with merged, or the run's without it.",
            ));
        }
        let url = target.url();
        let own_pr = task
            .pr
            .iter()
            .map(|p| p.as_str())
            .chain(
                task.result
                    .iter()
                    .filter_map(|r| r.pr_url.as_ref().map(|p| p.as_str())),
            )
            .filter_map(target_of)
            .any(|t| repo_of(&t) == repo_of(&target));
        if !own_pr
            && !self
                .repos_of(&task.project_ref)
                .iter()
                .any(|repo| holds_pr(repo, &url))
        {
            return Err(lead_error(
                ErrorCode::Forbidden,
                format!("{} is not one of this project's repos.", repo_of(&target)),
                Some("Wait only on CI of your project's repos; ask your lead about another repo."),
            ));
        }
        let now = now_ms(self.d.clock.as_ref());
        let open: i64 = self
            .db(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM ci_waits WHERE task_id = ? AND url <> ?",
                    params![task_id.as_str(), url],
                    |r| r.get(0),
                )
            })
            .map_err(store_error)?;
        if open >= PER_TASK {
            return Err(refused(
                format!("{task_id} already waits on {open} CI runs or PRs."),
                "Wait on fewer at once: each wakes you when it ends.",
            ));
        }
        // Asked again, a wait keeps its start and the failure it last woke for; the newest call says which kind it is.
        self.db(|c| {
            c.execute(
                "INSERT INTO ci_waits (task_id, url, created_ms, merged) VALUES (?, ?, ?, ?)
                 ON CONFLICT (task_id, url) DO UPDATE SET
                   created_ms = CASE WHEN (excluded.merged IS NULL) = (merged IS NULL) THEN created_ms
                                ELSE excluded.created_ms END,
                   merged = CASE WHEN excluded.merged IS NULL THEN NULL ELSE COALESCE(merged, '') END",
                params![task_id.as_str(), url, now, merged.then_some("")],
            )
        })
        .map_err(store_error)?;
        let next = if merged {
            "Waiting. End your turn now if you have nothing else to do: this thread continues when the PR merges, \
             or if it fails on the merge train or is closed unmerged."
        } else {
            "Waiting. End your turn now if you have nothing else to do: when it finishes, this thread continues with \
             the outcome and the failing jobs."
        };
        Ok(WaitCiResult {
            url: Text::unchecked(url),
            next: Some(next.into()),
        })
    }

    /// Every open wait: task, URL, when asked, GitHub reads failed in a row, and for a wait with `merged`, the failure
    /// it last woke its task for ('' none).
    fn ci_waits(&self) -> Vec<(TaskId, String, i64, i64, Option<String>)> {
        self.db(|c| {
            c.prepare(
                "SELECT task_id, url, created_ms, errors, merged FROM ci_waits ORDER BY created_ms",
            )?
            .query_map([], |r| {
                Ok((
                    TaskId::unchecked(r.get::<_, String>(0)?),
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect()
        })
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "ci waits not read");
            Vec::new()
        })
    }

    /// Each task's open wait URLs, by task id; a wait with `merged` says so.
    pub(super) fn open_ci_waits(&self) -> HashMap<String, Vec<String>> {
        let mut open = HashMap::<String, Vec<String>>::new();
        for (task_id, url, _, _, merged) in self.ci_waits() {
            let url = match merged {
                Some(_) => format!("{url} (until it merges)"),
                None => url,
            };
            open.entry(task_id.as_str().to_owned())
                .or_default()
                .push(url);
        }
        open
    }

    /// Whether `task_id` keeps a wait_ci open, which wakes it when what it names ends.
    pub fn has_ci_wait(&self, task_id: &TaskId) -> bool {
        self.db(|c| {
            c.query_row(
                "SELECT EXISTS (SELECT 1 FROM ci_waits WHERE task_id = ?)",
                [task_id.as_str()],
                |r| r.get::<_, bool>(0),
            )
        })
        .unwrap_or(false)
    }

    /// The lead's line for a done task with open waits: wait_ci wakes it, so it needs no steer.
    pub(super) fn waits_note(task_id: &str, urls: &[String]) -> String {
        format!(
            "{task_id} waits on CI, and wait_ci wakes it as each ends: {}.",
            urls.join(" ")
        )
    }

    fn ci_wait_done(&self, task_id: &TaskId, url: &str) {
        if let Err(error) = self.db(|c| {
            c.execute(
                "DELETE FROM ci_waits WHERE task_id = ? AND url = ?",
                params![task_id.as_str(), url],
            )
        }) {
            tracing::warn!(%error, task = %task_id, "ci wait not cleared");
        }
    }

    fn ci_wait_told(&self, task_id: &TaskId, url: &str, why: &str) {
        if let Err(error) = self.db(|c| {
            c.execute(
                "UPDATE ci_waits SET merged = ? WHERE task_id = ? AND url = ?",
                params![why, task_id.as_str(), url],
            )
        }) {
            tracing::warn!(%error, task = %task_id, "merge wait: failure not kept");
        }
    }

    fn ci_wait_errors(&self, task_id: &TaskId, url: &str, errors: i64) {
        if let Err(error) = self.db(|c| {
            c.execute(
                "UPDATE ci_waits SET errors = ? WHERE task_id = ? AND url = ?",
                params![errors, task_id.as_str(), url],
            )
        }) {
            tracing::warn!(%error, task = %task_id, "ci wait: errors not counted");
        }
    }

    /// One pass: each finished wait wakes its task and goes. A wait of a failed, cancelled or deleted task goes
    /// silently: a wake never restarts one. Returns how many tasks were woken.
    pub async fn poll_ci_waits(self: &Arc<Self>, reads: &dyn CiReads) -> usize {
        let now = now_ms(self.d.clock.as_ref());
        let mut woken = 0;
        for (task_id, url, created, errors, merged) in self.ci_waits() {
            let task = match self.get(&task_id) {
                Ok(Some(t)) if !matches!(t.state, TaskState::Cancelled | TaskState::Failed) => t,
                Ok(_) => {
                    self.ci_wait_done(&task_id, &url);
                    continue;
                }
                Err(error) => {
                    tracing::warn!(%error, "ci wait: task not read");
                    continue;
                }
            };
            let Some(target) = target_of(&url) else {
                self.ci_wait_done(&task_id, &url);
                continue;
            };
            // The line, and for a merge wait that goes on after it, the failure it tells.
            let line = match &merged {
                None => match reads.read(&target).await {
                    Ok(read) => {
                        if errors > 0 {
                            self.ci_wait_errors(&task_id, &url, 0);
                        }
                        summary(&target, &read)
                    }
                    Err(error) if errors + 1 < READ_TRIES => {
                        tracing::warn!(%error, %url, "ci wait: GitHub not read");
                        self.ci_wait_errors(&task_id, &url, errors + 1);
                        None
                    }
                    Err(error) => Some(format!(
                        "CI you waited on (wait_ci) could not be read: GitHub failed {READ_TRIES} times in a row \
                         for {url} ({error}). Look at it with `gh`, or call wait_ci again."
                    )),
                }
                .map(|line| (line, None)),
                Some(told) => match reads.merge(&task.project_ref, &target).await {
                    Merge::Pending => {
                        // Back on its way, its next failure wakes the task again.
                        if !told.is_empty() {
                            self.ci_wait_told(&task_id, &url, "");
                        }
                        None
                    }
                    Merge::Failed(why) if why == *told => None,
                    Merge::Failed(why) => Some((
                        format!(
                            "A PR you waited on to merge (wait_ci merged) failed on the merge train: {url}: {why}. \
                             Its writer gets it back to fix; you still wait on it, and are woken when it merges or \
                             fails again."
                        ),
                        Some(why),
                    )),
                    Merge::Merged => Some((
                        format!("A PR you waited on to merge (wait_ci merged) has merged: {url}."),
                        None,
                    )),
                    Merge::Over(why) => Some((
                        format!(
                            "A PR you waited on to merge (wait_ci merged) won't merge: {url}: {why}. Ask your \
                             lead what to build on instead."
                        ),
                        None,
                    )),
                },
            };
            let (give_up_ms, what) = match merged {
                None => (GIVE_UP_MS, "CI you waited on (wait_ci) has not finished"),
                Some(_) => (
                    MERGE_GIVE_UP_MS,
                    "A PR you waited on to merge (wait_ci merged) has not merged",
                ),
            };
            let given_up = now.saturating_sub(created) >= give_up_ms;
            let Some((line, goes_on)) = line.or_else(|| {
                given_up.then(|| {
                    let line = format!(
                        "{what} after {} h: {url}. Look at it with `gh`, or call wait_ci again.",
                        give_up_ms / 3_600_000
                    );
                    (line, None)
                })
            }) else {
                continue;
            };
            // A PR's CI wake carries its still-open blocking findings, so a writer back from a rebase still fixes them.
            let open = match &target {
                Target::Pr { .. } if task.kind != TaskKind::Review && merged.is_none() => {
                    open_blocking(&self.d.db, &target.url())
                }
                _ => String::new(),
            };
            let line = match open.as_str() {
                "" => line,
                open => format!("{line}\n\n{open}"),
            };
            let caller = TaskCaller {
                project_ref: task.project_ref.clone(),
                by: BY.into(),
            };
            match self.message(&caller, &task_id, &line).await {
                Ok(_) => woken += 1,
                // Kept, to try again on the next pass, until it is given up.
                Err(error) if !given_up => {
                    tracing::warn!(message = %error.message, task = %task_id, "ci wait: task not woken");
                    continue;
                }
                Err(error) => {
                    tracing::warn!(message = %error.message, task = %task_id, "ci wait: given up unsent")
                }
            }
            match goes_on {
                Some(why) if !given_up => self.ci_wait_told(&task_id, &url, &why),
                _ => self.ci_wait_done(&task_id, &url),
            }
        }
        woken
    }
}

fn repo_of(target: &Target) -> String {
    match target {
        Target::Run { repo, .. } | Target::Pr { repo, .. } => repo.to_lowercase(),
    }
}

/// The hub's GitHub reads, through the train's `gh` client, and its merge reads, the train's.
pub(super) struct HubReads(pub(super) Arc<Hub>);

/// Job and check conclusions that pass.
fn passed(conclusion: Option<&str>) -> bool {
    matches!(conclusion, Some("success" | "skipped" | "neutral"))
}

impl CiReads for HubReads {
    fn read<'a>(&'a self, target: &'a Target) -> BoxFut<'a, Result<Read, String>> {
        Box::pin(async move {
            let gh = self.0.train.github();
            match target {
                Target::Run { repo, id } => {
                    let run = match gh
                        .get(&format!("repos/{repo}/actions/runs/{id}"))
                        .await
                        .map_err(|e| e.message)?
                    {
                        Ok(run) => run,
                        Err((404, _)) => return Ok(Read::Over("is not a run GitHub has".into())),
                        Err((status, message)) => return Err(format!("{status}: {message}")),
                    };
                    if run["status"].as_str() != Some("completed") {
                        return Ok(Read::Running);
                    }
                    let jobs = gh
                        .get(&format!(
                            "repos/{repo}/actions/runs/{id}/jobs?filter=latest&per_page=100"
                        ))
                        .await
                        .map_err(|e| e.message)?
                        .map_err(|(status, message)| format!("{status}: {message}"))?;
                    let jobs = jobs["jobs"].as_array().cloned().unwrap_or_default();
                    Ok(Read::Finished {
                        conclusion: run["conclusion"].as_str().map(str::to_owned),
                        label: run["name"].as_str().unwrap_or("run").to_owned(),
                        failing: jobs
                            .iter()
                            .filter(|j| !passed(j["conclusion"].as_str()))
                            .filter_map(|j| j["name"].as_str().map(str::to_owned))
                            .collect(),
                        total: jobs.len(),
                    })
                }
                Target::Pr { repo, number } => {
                    let pull = gh.pull(repo, *number).await.map_err(|e| e.message)?;
                    if pull.merged || pull.merged_at.is_some() {
                        return Ok(Read::Over("was merged".into()));
                    }
                    if pull.state != "open" {
                        return Ok(Read::Over("was closed".into()));
                    }
                    let sha = &pull.head.sha;
                    let runs = gh
                        .get(&format!(
                            "repos/{repo}/actions/runs?head_sha={sha}&per_page=100"
                        ))
                        .await
                        .map_err(|e| e.message)?
                        .map_err(|(status, message)| format!("{status}: {message}"))?;
                    let runs: Vec<String> = runs["workflow_runs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|r| r["status"].as_str().map(str::to_owned))
                        .collect();
                    let checks: Vec<Check> = gh
                        .check_runs(repo, sha)
                        .await
                        .map_err(|e| e.message)?
                        .into_iter()
                        .map(|c| Check {
                            completed_ms: c.completed_at.as_deref().and_then(parse_ms),
                            name: c.name,
                            status: c.status,
                            conclusion: c.conclusion,
                        })
                        .collect();
                    Ok(head_read(
                        sha,
                        &runs,
                        &checks,
                        now_ms(self.0.clock.as_ref()),
                    ))
                }
            }
        })
    }

    fn merge<'a>(&'a self, by: &'a ProjectRef, target: &'a Target) -> BoxFut<'a, Merge> {
        Box::pin(async move {
            let url = GitHubPrUrl::unchecked(target.url());
            let train = &self.0.train;
            if !train.sees_pr(by, &url) {
                return Merge::Over("it is in a project you don't see".into());
            }
            let Some(waiting) = train.upstream(&url).await else {
                return Merge::Merged;
            };
            // The train's hold: "held: waiting on owner/name#n: why".
            let why = waiting
                .note
                .strip_prefix(WAITING_ON)
                .and_then(|rest| rest.split_once(": "))
                .map_or(waiting.note.as_str(), |(_, why)| why);
            match why {
                CLOSED => Merge::Over(why.into()),
                _ if waiting.failed => Merge::Failed(why.into()),
                _ => Merge::Pending,
            }
        })
    }
}

/// Every [`POLL_EVERY`]: reads GitHub for each open wait and wakes the tasks whose CI finished.
pub async fn run(hub: Arc<Hub>) {
    let reads = HubReads(hub.clone());
    loop {
        hub.clock.sleep(POLL_EVERY).await;
        let n = hub.tasks.poll_ci_waits(&reads).await;
        if n > 0 {
            tracing::info!(n, "tasks woken by the CI they waited on");
        }
    }
}
