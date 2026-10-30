//! `wait_ci`: a task asks to be woken when a GitHub Actions run, or the checks on a PR's head, finish. Each wait is a
//! row in `ci_waits`; every [`POLL_EVERY`] the hub reads GitHub for each, and one that finished continues its task's
//! thread (a running task takes it at its next tool boundary) with one line: the outcome and the failing jobs.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::lead_calls::WaitCiResult;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::prim::Text;
use fleetd_contracts::tasks::{TaskId, TaskState};
use rusqlite::params;

use super::ports::TaskError;
use super::{TaskCaller, Tasks, holds_pr, lead_error, store_error};
use crate::hub::api::Hub;
use crate::hub::store::now_ms;
use crate::hub::work::BoxFut;

pub const POLL_EVERY: Duration = Duration::from_secs(60);
/// A wait still open this long ends, telling its task so.
pub const GIVE_UP_MS: i64 = 6 * 3600 * 1000;
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

/// GitHub's reads; the hub's goes through the train's `gh` client, tests fake it.
pub trait CiReads: Send + Sync {
    fn read<'a>(&'a self, target: &'a Target) -> BoxFut<'a, Result<Read, String>>;
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
    /// Keeps `url` for `task_id` until it finishes. Only a run or PR in one of the task's project's repos, or the
    /// task's own PR's repo.
    pub fn wait_ci(&self, task_id: &TaskId, url: &str) -> Result<WaitCiResult, TaskError> {
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
        self.db(|c| {
            c.execute(
                "INSERT OR IGNORE INTO ci_waits (task_id, url, created_ms) VALUES (?, ?, ?)",
                params![task_id.as_str(), url, now],
            )
        })
        .map_err(store_error)?;
        Ok(WaitCiResult {
            url: Text::unchecked(url),
            next: Some(
                "Waiting. End your turn now if you have nothing else to do: when it finishes, this thread continues \
                 with the outcome and the failing jobs."
                    .into(),
            ),
        })
    }

    /// Every open wait: task, URL, when asked.
    fn ci_waits(&self) -> Vec<(TaskId, String, i64)> {
        self.db(|c| {
            c.prepare("SELECT task_id, url, created_ms FROM ci_waits ORDER BY created_ms")?
                .query_map([], |r| {
                    Ok((
                        TaskId::unchecked(r.get::<_, String>(0)?),
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })?
                .collect()
        })
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "ci waits not read");
            Vec::new()
        })
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

    /// One pass: each finished wait wakes its task and goes; a wait of a cancelled or deleted task goes silently.
    /// Returns how many tasks were woken.
    pub async fn poll_ci_waits(self: &Arc<Self>, reads: &dyn CiReads) -> usize {
        let now = now_ms(self.d.clock.as_ref());
        let mut woken = 0;
        for (task_id, url, created) in self.ci_waits() {
            let task = match self.get(&task_id) {
                Ok(Some(t)) if t.state != TaskState::Cancelled => t,
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
            let line = match reads.read(&target).await {
                Ok(read) => summary(&target, &read),
                Err(error) => {
                    tracing::warn!(%error, %url, "ci wait: GitHub not read");
                    None
                }
            };
            let given_up = now.saturating_sub(created) >= GIVE_UP_MS;
            let Some(line) = line.or_else(|| {
                given_up.then(|| {
                    format!(
                        "CI you waited on (wait_ci) has not finished after {} h: {url}. Look at it with `gh`, or \
                         call wait_ci again.",
                        GIVE_UP_MS / 3_600_000
                    )
                })
            }) else {
                continue;
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
            self.ci_wait_done(&task_id, &url);
        }
        woken
    }
}

fn repo_of(target: &Target) -> String {
    match target {
        Target::Run { repo, .. } | Target::Pr { repo, .. } => repo.to_lowercase(),
    }
}

/// The hub's GitHub reads, through the train's `gh` client.
struct HubReads(Arc<Hub>);

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
                    let checks = gh
                        .check_runs(repo, &pull.head.sha)
                        .await
                        .map_err(|e| e.message)?;
                    // None yet is a head GitHub hasn't started on.
                    if checks.is_empty() || checks.iter().any(|c| c.status != "completed") {
                        return Ok(Read::Running);
                    }
                    Ok(Read::Finished {
                        conclusion: None,
                        label: pull.head.sha.chars().take(7).collect(),
                        failing: checks
                            .iter()
                            .filter(|c| !passed(c.conclusion.as_deref()))
                            .map(|c| c.name.clone())
                            .collect(),
                        total: checks.len(),
                    })
                }
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
