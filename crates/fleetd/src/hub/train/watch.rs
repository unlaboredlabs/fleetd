//! The watch after a merge. The train waits only for its fast set, so the repo's other checks finish after it merged:
//! it watches them on the commit it put on the base. A check there that fails opens a fix order for the project's lead
//! (channel `train`), plainly worded with the run's link, once per failure: the same check failing again on later
//! merges, while its order is still open, is that order's, not a new one. A watch ends once every check on the commit
//! has finished, and after `WATCH_MAX` at most. Same for every repo: nothing here knows a check by name.
use super::github::{CheckRun, TRAIN_CONTEXT};
use super::records::Watch;
use super::service::{Train, is_red, short};

/// A merged commit is watched at least this long, so checks that start late (a workflow run on the push) are seen.
const WATCH_SETTLE_MS: i64 = 5 * 60_000;
/// And at most this long: a check still running then is not waited for.
const WATCH_MAX_MS: i64 = 6 * 60 * 60_000;

/// The checks on a merged commit that failed outside its fast set: the ones a fix order is for. None for an empty fast
/// set: the train then waited for every check before the merge.
pub(super) fn failed_after(runs: &[CheckRun], fast: &super::service::Fast) -> Vec<CheckRun> {
    if fast.set.is_empty() {
        return Vec::new();
    }
    runs.iter()
        .filter(|r| r.name != TRAIN_CONTEXT && !fast.holds(&r.name))
        .filter(|r| is_red(r) && r.conclusion.as_deref() != Some("cancelled"))
        .cloned()
        .collect()
}

/// The fix order's text: what failed, where, the run's link, and what to do.
pub(super) fn fix_order_text(w: &Watch, check: &CheckRun) -> String {
    let link = check
        .html_url
        .as_deref()
        .map(|u| format!(" Its run: {u}"))
        .unwrap_or_default();
    format!(
        "Fix the check `{}` on {}: it failed after the merge train merged {} as {}.{link} The train doesn't wait for \
         this check before merging, so it ran after the merge. Find why it fails on {} and make it pass again there.",
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

    /// Each pass: every watched commit's checks read, a fix order opened for each new failure outside the fast set,
    /// and the watch ended once they all finished.
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
            let runs = match self.github.check_runs(repo, &w.sha).await {
                Ok(runs) => runs,
                Err(e) => {
                    tracing::warn!(repo, sha = w.sha, error = %e.message, "train: merged commit's checks not read");
                    continue;
                }
            };
            for check in failed_after(&runs, &fast) {
                self.fix_order(&w, &check).await;
            }
            let done = runs.iter().all(|r| r.status == "completed");
            if done && now - w.since_ms >= WATCH_SETTLE_MS {
                self.records.end_watch(repo, &w.sha);
            }
        }
    }

    /// One fix order per failure: none when this commit's failure of `check` has one, or an earlier one of the same
    /// check still has an open order.
    async fn fix_order(&self, w: &Watch, check: &CheckRun) {
        let repo = w.repo.as_str();
        let now = self.now_ms();
        if let Some((sha, order)) = self.records.fix_order(repo, &check.name) {
            if sha == w.sha {
                return;
            }
            if self.host.workstream(&order).is_some_and(|o| o.open) {
                self.records
                    .put_fix_order(repo, &check.name, &w.sha, &order, now);
                return;
            }
        }
        let request = format!("train-fix:{repo}:{}:{}", w.sha, check.name);
        match self
            .host
            .open_order(&w.project_ref, fix_order_text(w, check), request)
            .await
        {
            Ok(order) => {
                tracing::info!(repo, sha = w.sha, check = check.name, %order, "train: a check failed after the merge; fix order opened");
                self.records
                    .put_fix_order(repo, &check.name, &w.sha, &order, now);
            }
            Err(e) => {
                tracing::warn!(repo, sha = w.sha, check = check.name, error = %e, "train: fix order not opened; tried again next pass")
            }
        }
    }
}
