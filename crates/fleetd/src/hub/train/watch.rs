//! The watch after a merge. The train waits only for its fast set, so the repo's other checks finish after it merged:
//! it watches them on the commit it put on the base, and the checks a batch skips (`batch_skipped`), which never ran on
//! the merged tree before. A check there that fails is re-run once, its own job only: a flake or a GitHub blip passes
//! then, and opens nothing. One that fails again opens a fix order for the project's lead (channel `train`), plainly
//! worded with the run's link, once per failure: the same check failing on later merges, while its order is still
//! open, is that order's, not a new one, and isn't re-run. Runs a person or a schedule started on the commit (a manual
//! release, the nightly Mac checks) aren't the merge's: the watch leaves them, and `scheduled` reports a schedule's.
//! What it did is kept per commit, so a restart re-runs nothing twice. A watch ends once every check on the commit has
//! finished, no re-run is still to show, and after `WATCH_MAX` at most. Same for every repo: nothing here knows a check
//! by name.
use super::github::{CheckRun, TRAIN_CONTEXT};
use super::next::gated_name;
use super::records::Watch;
use super::repeats::warn_hourly;
use super::service::{Train, is_red, short};
use fleetd_contracts::ledger::WorkstreamId;

/// A merged commit is watched at least this long, so checks that start late (a workflow run on the push) are seen.
const WATCH_SETTLE_MS: i64 = 5 * 60_000;
/// And at most this long: a check still running then is not waited for.
const WATCH_MAX_MS: i64 = 6 * 60 * 60_000;
/// A re-run that shows no newer run of its check this long after the train asked for it counts as failed again.
const RERUN_SHOW_MS: i64 = 15 * 60_000;
/// The events of workflow runs a person or a schedule started, not the merge.
const NOT_THE_MERGES: [&str; 2] = ["workflow_dispatch", "schedule"];

/// What the watch did about a check's run on a merged commit (`put_watch_check`): re-ran it once, saw that re-run
/// pass, or left it for being a manual or scheduled run.
const RERAN: &str = "reran";
const RECOVERED: &str = "recovered";
const MANUAL: &str = "manual";

/// The checks on a merged commit that failed outside its fast set, or that a batch skips (`batch`): the ones a fix
/// order is for. Outside the checks a batch skips, none for an empty fast set: the train then waited for every check
/// before the merge.
pub(super) fn failed_after(
    runs: &[CheckRun],
    fast: &super::service::Fast,
    batch: &[String],
) -> Vec<CheckRun> {
    let skipped_by_batch = |r: &CheckRun| batch.iter().any(|n| gated_name(n, &r.name));
    runs.iter()
        .filter(|r| {
            skipped_by_batch(r)
                || (!fast.set.is_empty() && r.name != TRAIN_CONTEXT && !fast.holds(&r.name))
        })
        .filter(|r| is_red(r) && r.conclusion.as_deref() != Some("cancelled"))
        .cloned()
        .collect()
}

/// The fix order's text: what failed, where, the run's link, and what to do.
/// `reran`: the train re-ran it once, and it failed again.
pub(super) fn fix_order_text(w: &Watch, check: &CheckRun, reran: bool) -> String {
    let link = check
        .html_url
        .as_deref()
        .map(|u| format!(" Its run: {u}"))
        .unwrap_or_default();
    let again = if reran {
        ", and again when the train re-ran it once"
    } else {
        ""
    };
    format!(
        "Fix the check `{}` on {}: it failed after the merge train merged {} as {}{again}.{link} The train doesn't wait \
         for this check on what it merges, or its batches skip it, so it ran there only after the merge. Find why it \
         fails on {} and make it pass again there.",
        check.name,
        w.base,
        w.pr_url,
        short(&w.sha),
        w.base
    )
}

impl Train {
    /// After a merge onto `base` as `sha`: its checks outside the fast set are watched there from now on.
    pub(super) fn watch_merge(&self, repo: &str, base: &str, sha: &str, pr_url: &str) {
        let Some(train) = self.records.train(repo) else {
            return;
        };
        let project_ref = self.train_project(repo, &train.project_ref);
        self.records.watch_merge(&Watch {
            repo: repo.to_string(),
            sha: sha.to_lowercase(),
            base: base.to_string(),
            project_ref,
            pr_url: pr_url.to_string(),
            since_ms: self.now_ms(),
        });
    }

    /// Each pass: every watched commit's checks read, each new failure outside the fast set re-run once or given its
    /// fix order (`failed_check`), and the watch ended once they all finished and no re-run is still to show.
    pub(super) async fn watch_pass(&self, repo: &str) {
        for w in self.records.watches(repo) {
            let now = self.now_ms();
            if now - w.since_ms >= WATCH_MAX_MS {
                self.records.end_watch(repo, &w.sha);
                continue;
            }
            let Some(fast) = self.fast(repo, &w.base).await else {
                continue;
            };
            let batch = self
                .workflows(repo, &w.base)
                .await
                .map(|wf| wf.batch_names())
                .unwrap_or_default();
            let runs = match self.github.check_runs(repo, &w.sha).await {
                Ok(runs) => runs,
                Err(e) => {
                    warn_hourly!(self, [repo, w.sha], e.message; repo, sha = w.sha, error = %e.message, "train: merged commit's checks not read");
                    continue;
                }
            };
            self.recovered(&w, &runs);
            let mut events = None;
            let mut waiting = false;
            for check in failed_after(&runs, &fast, &batch) {
                waiting |= self.failed_check(&w, &check, &runs, &mut events).await;
            }
            let done = runs.iter().all(|r| r.status == "completed");
            if done && !waiting && now - w.since_ms >= WATCH_SETTLE_MS {
                self.records.end_watch(repo, &w.sha);
            }
        }
    }

    /// Each check the watch re-ran on `w`'s commit whose newer run passed: recorded, so the status no longer says it
    /// is re-run.
    fn recovered(&self, w: &Watch, runs: &[CheckRun]) {
        let seen = self.records.watch_checks(&w.repo, &w.sha);
        for (name, id, did, _) in &seen {
            let settled = seen.iter().any(|(n, _, d, _)| n == name && d == RECOVERED);
            if did != RERAN || settled {
                continue;
            }
            let passed = runs.iter().find(|r| {
                r.name == *name && r.id as i64 != *id && r.status == "completed" && !is_red(r)
            });
            if let Some(passed) = passed {
                tracing::info!(
                    repo = w.repo,
                    sha = w.sha,
                    check = name,
                    "train: a check re-run after the merge passed; no fix order"
                );
                self.records.put_watch_check(
                    &w.repo,
                    &w.sha,
                    name,
                    passed.id as i64,
                    RECOVERED,
                    self.now_ms(),
                );
            }
        }
    }

    /// What the watch does about `check` failing on `w`'s commit (`runs`, its checks): nothing more once its failure
    /// there has a fix order, or it is a manual or scheduled run (`events`, the commit's workflow runs, read once a
    /// pass). Otherwise the open fix order of the same check takes it; failed again after the train re-ran it, it opens
    /// one; failed the first time, its job is re-run once, when its workflow run is done (GitHub re-runs none before).
    /// True while the watch still has to see that re-run.
    async fn failed_check(
        &self,
        w: &Watch,
        check: &CheckRun,
        runs: &[CheckRun],
        events: &mut Option<Vec<(u64, String)>>,
    ) -> bool {
        let (repo, sha, name) = (w.repo.as_str(), w.sha.as_str(), check.name.as_str());
        let now = self.now_ms();
        if self.records.fix_order_at(repo, name, sha).is_some() {
            return false;
        }
        let seen: Vec<_> = self
            .records
            .watch_checks(repo, sha)
            .into_iter()
            .filter(|(n, ..)| n == name)
            .collect();
        let id = check.id as i64;
        if let Some((_, _, did, at)) = seen.iter().find(|(_, r, ..)| *r == id) {
            if did != RERAN {
                return false;
            }
            if now - at < RERUN_SHOW_MS {
                return true;
            }
            tracing::warn!(
                repo,
                sha,
                check = name,
                "train: a re-run after the merge never showed; opening its fix order"
            );
            self.fix_order(w, check, true).await;
            return false;
        }
        let reran = seen.iter().any(|(_, _, did, _)| did == RERAN);
        let run = check.workflow_run();
        let busy = |run| {
            runs.iter()
                .any(|r| r.status != "completed" && r.workflow_run() == Some(run))
        };
        if !reran && run.is_some_and(busy) {
            return false;
        }
        if let Some(run) = run {
            if events.is_none() {
                match self.github.sha_run_events(repo, sha).await {
                    Ok(read) => *events = Some(read),
                    Err(e) => {
                        tracing::warn!(repo, sha, error = %e.message, "train: merged commit's workflow runs not read");
                        return false;
                    }
                }
            }
            let manual = events
                .iter()
                .flatten()
                .any(|(r, event)| *r == run && NOT_THE_MERGES.contains(&event.as_str()));
            if manual {
                tracing::info!(
                    repo,
                    sha,
                    check = name,
                    run,
                    "train: a manual or scheduled run failed on a merged commit; not the merge's, left to it"
                );
                self.records
                    .put_watch_check(repo, sha, name, id, MANUAL, now);
                return false;
            }
        }
        if let Some(order) = self.open_fix_order(repo, name) {
            self.records.put_fix_order(repo, name, sha, &order, now);
            return false;
        }
        if reran {
            self.fix_order(w, check, true).await;
            return false;
        }
        // A check no Actions job reports: nothing re-runs it.
        let Some(job) = check.job() else {
            self.fix_order(w, check, false).await;
            return false;
        };
        match self.github.rerun_job(repo, job).await {
            Ok(()) => {
                tracing::info!(
                    repo,
                    sha,
                    check = name,
                    job,
                    "train: a check failed after the merge; re-ran it once"
                );
                self.records
                    .put_watch_check(repo, sha, name, id, RERAN, now);
                true
            }
            Err(e) => {
                tracing::warn!(repo, sha, check = name, job, error = %e.message, "train: a check failed after the merge and GitHub refused its re-run; opening its fix order");
                self.fix_order(w, check, false).await;
                false
            }
        }
    }

    /// The newest fix order of `check` failing on the base, while it is open.
    fn open_fix_order(&self, repo: &str, check: &str) -> Option<WorkstreamId> {
        self.records
            .fix_order(repo, check)
            .map(|(_, order)| order)
            .filter(|order| self.host.workstream(order).is_some_and(|o| o.open))
    }

    /// The checks the watch re-ran on merged commit `sha` that haven't passed or got a fix order since: what the status
    /// says is being re-run.
    pub(super) fn rerunning(&self, repo: &str, sha: &str) -> Vec<String> {
        let seen = self.records.watch_checks(repo, &sha.to_lowercase());
        let mut names: Vec<String> = Vec::new();
        for (name, _, did, _) in &seen {
            let settled = seen.iter().any(|(n, _, d, _)| n == name && d == RECOVERED)
                || self
                    .records
                    .fix_order_at(repo, name, &sha.to_lowercase())
                    .is_some();
            if did == RERAN && !settled && !names.contains(name) {
                names.push(name.clone());
            }
        }
        names
    }

    /// Opens the fix order for `check` failing on `w`'s commit (`reran`: again, after its re-run), and records it.
    async fn fix_order(&self, w: &Watch, check: &CheckRun, reran: bool) {
        let repo = w.repo.as_str();
        let request = format!("train-fix:{repo}:{}:{}", w.sha, check.name);
        match self
            .host
            .open_order(&w.project_ref, fix_order_text(w, check, reran), request)
            .await
        {
            Ok(order) => {
                tracing::info!(repo, sha = w.sha, check = check.name, %order, "train: a check failed after the merge; fix order opened");
                self.records
                    .put_fix_order(repo, &check.name, &w.sha, &order, self.now_ms());
            }
            Err(e) => {
                warn_hourly!(self, [repo, w.sha, check.name], e; repo, sha = w.sha, check = check.name, error = %e, "train: fix order not opened; tried again next pass")
            }
        }
    }
}
