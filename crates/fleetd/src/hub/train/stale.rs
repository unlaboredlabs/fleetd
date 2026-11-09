//! A check GitHub still shows pending after its workflow run finished. On #1362 the Desktop QA run had completed green,
//! but GitHub kept its job `qa (ubuntu-latest, 1/4)` in_progress (conclusion success), and the PR waited 45 minutes
//! as "still running" until the lead re-ran the run by hand. Nothing finishes such a check by itself: once its run has
//! been done `STALE_AFTER_MS`, the train re-runs that workflow run, once per head, and waits for the fresh result. The
//! stale check never counts as passed.
use std::collections::HashMap;

use super::github::CheckRun;
use super::repeats::warn_hourly;
use super::service::{Train, lock};
use crate::hub::store::parse_ms;

/// How long a workflow run has been finished before a check of it GitHub still shows pending counts as stale.
pub(super) const STALE_AFTER_MS: i64 = 5 * 60_000;
/// How often the train reads the workflow run of a check still pending on a head.
const READ_EVERY_MS: i64 = 60_000;
/// How long the train remembers a head it looked at.
const KEPT_MS: i64 = 24 * 60 * 60_000;

/// What the train read and did about one head's pending checks.
#[derive(Default)]
pub(super) struct StaleHead {
    /// The workflow run it re-ran, and the checks of it that were stale then: once per head.
    reran: Option<(u64, Vec<f64>)>,
    /// When it last read each workflow run with a check pending.
    read: HashMap<u64, i64>,
    /// When it last looked at the head.
    at: i64,
}

/// Per repo and head.
pub(super) type StaleHeads = HashMap<(String, String), StaleHead>;

/// A head held by a stale check, and what the train did about it.
pub(super) struct Stale {
    /// It re-ran the check's workflow run now.
    pub now: bool,
    /// Why the head still waits, as a PR left out of a batch says it.
    pub why: String,
}

/// Why a head waits on `stale`, checks of a workflow run the train re-ran.
fn rerun_why(stale: &[&CheckRun]) -> String {
    let names: Vec<String> = stale.iter().map(|r| format!("`{}`", r.name)).collect();
    format!(
        "its own head's {} stayed pending after its workflow run finished; the train re-ran that run and waits for \
         the fresh result",
        names.join(", ")
    )
}

impl Train {
    /// Re-runs the workflow run of a check in `waited` (the checks the train waits on, on head `sha`) that GitHub
    /// still shows pending though the run finished `STALE_AFTER_MS` ago: once per head, its runs read at most every
    /// `READ_EVERY_MS`. Some while a check it re-ran is still the stale one; None when no check is stale.
    pub(super) async fn rerun_stale(
        &self,
        repo: &str,
        sha: &str,
        waited: &[CheckRun],
    ) -> Option<Stale> {
        let pending: Vec<&CheckRun> = waited.iter().filter(|r| r.status != "completed").collect();
        if pending.is_empty() {
            return None;
        }
        let now = self.now_ms();
        let key = (repo.to_string(), sha.to_string());
        let due: Vec<u64> = {
            let mut heads = lock(&self.stale_heads);
            heads.retain(|_, h| now - h.at < KEPT_MS);
            let head = heads.entry(key.clone()).or_default();
            head.at = now;
            if let Some((_, stale)) = &head.reran {
                let still: Vec<&CheckRun> = pending
                    .iter()
                    .filter(|r| stale.contains(&r.id))
                    .copied()
                    .collect();
                return (!still.is_empty()).then(|| Stale {
                    now: false,
                    why: rerun_why(&still),
                });
            }
            let mut due: Vec<u64> = pending.iter().filter_map(|r| r.workflow_run()).collect();
            due.sort_unstable();
            due.dedup();
            due.retain(|run| {
                head.read
                    .get(run)
                    .is_none_or(|at| now - at >= READ_EVERY_MS)
            });
            for run in &due {
                head.read.insert(*run, now);
            }
            due
        };
        for run in due {
            let read = match self.github.workflow_run(repo, run).await {
                Ok(read) => read,
                Err(e) => {
                    warn_hourly!(self, [repo, run], e.message; repo, run, error = %e.message, "train: workflow run not read");
                    continue;
                }
            };
            let done_at = read
                .updated_at
                .as_deref()
                .filter(|_| read.status.as_deref() == Some("completed"))
                .and_then(parse_ms);
            if done_at.is_none_or(|at| now - at < STALE_AFTER_MS) {
                continue;
            }
            let stale: Vec<&CheckRun> = pending
                .iter()
                .filter(|r| r.workflow_run() == Some(run))
                .copied()
                .collect();
            let checks: Vec<&str> = stale.iter().map(|r| r.name.as_str()).collect();
            match self.github.rerun_run(repo, run).await {
                Ok(()) => {
                    tracing::info!(
                        repo,
                        sha,
                        run,
                        ?checks,
                        "train: re-ran a workflow run whose check stayed pending after it finished"
                    );
                    lock(&self.stale_heads).entry(key).or_default().reran =
                        Some((run, stale.iter().map(|r| r.id).collect()));
                    return Some(Stale {
                        now: true,
                        why: rerun_why(&stale),
                    });
                }
                Err(e) => {
                    warn_hourly!(self, [repo, run], e.message; repo, run, error = %e.message, "train: stale workflow run not re-run");
                }
            }
        }
        None
    }
}
