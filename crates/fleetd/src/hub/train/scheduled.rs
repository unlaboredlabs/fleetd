//! Scheduled runs on the base. A workflow a schedule starts (fleetd's nightly Mac checks, mac.yml) checks what pull
//! requests don't, long after their merge, so the watch after a merge rarely sees it. When the newest finished scheduled
//! run of a workflow on the base failed, a fix order opens for the project's lead (channel `train`): it names the failed
//! jobs, the run's link and the commits since that workflow's last green scheduled run. One failure opens one order, as
//! after a merge: the same job failing again while its order is open is that order's, and the same commit failing
//! again is the same failure. Only a run that finished in the last day counts, so a hub that starts doesn't dig up old
//! ones. Same for every repo: nothing here knows a workflow by name.
use super::contract::ProjectRef;
use super::github::WorkflowRun;
use super::service::{Train, lock, short};
use crate::hub::store::parse_ms;

/// A repo's scheduled runs are read at most this often.
const SCHEDULED_EVERY_MS: i64 = 10 * 60_000;
/// A failed run that finished longer ago than this opens nothing.
const SCHEDULED_RECENT_MS: i64 = 24 * 60 * 60_000;
/// The commits a fix order lists; the rest are counted.
const COMMITS_SHOWN: usize = 20;

/// A run or job that failed: a cancelled one didn't.
fn failed(conclusion: Option<&str>) -> bool {
    matches!(
        conclusion,
        Some("failure" | "timed_out" | "startup_failure")
    )
}

/// Of `runs` (newest first), each workflow's newest run when it failed and finished at `since_ms` or later, with the
/// newest green run of that workflow before it.
pub(super) fn newest_failures(
    runs: &[WorkflowRun],
    since_ms: i64,
) -> Vec<(&WorkflowRun, Option<&WorkflowRun>)> {
    let mut workflows = std::collections::HashSet::new();
    runs.iter()
        .enumerate()
        .filter(|(_, r)| workflows.insert(r.workflow_id))
        .filter(|(_, r)| {
            failed(r.conclusion.as_deref())
                && r.updated_at
                    .as_deref()
                    .and_then(parse_ms)
                    .is_some_and(|t| t >= since_ms)
        })
        .map(|(i, r)| {
            let green = runs[i + 1..].iter().find(|g| {
                g.workflow_id == r.workflow_id && g.conclusion.as_deref() == Some("success")
            });
            (r, green)
        })
        .collect()
}

/// The fix order's text: which workflow failed where, its failed jobs and link, the commits since its last green
/// scheduled run (`commits`: those listed, and how many in all), and what to do.
pub(super) fn scheduled_order_text(
    base: &str,
    run: &WorkflowRun,
    jobs: &[String],
    green: Option<&WorkflowRun>,
    commits: Option<&(Vec<(String, String)>, usize)>,
) -> String {
    let workflow = run.name.as_deref().unwrap_or("a scheduled workflow");
    let jobs = jobs
        .iter()
        .map(|j| format!("`{j}`"))
        .collect::<Vec<_>>()
        .join(", ");
    let since = match (green, commits) {
        (None, _) => "None of its recent scheduled runs passed, so the commits that broke it aren't narrowed down."
            .to_string(),
        (Some(g), _) if g.head_sha.eq_ignore_ascii_case(&run.head_sha) => format!(
            "Its scheduled run passed on this same commit before ({}), so a flaky check or a change outside the repo \
             is likelier than a commit.",
            g.html_url
        ),
        (Some(g), None) => format!(
            "GitHub didn't list the commits since its last green scheduled run, at {}.",
            short(&g.head_sha)
        ),
        (Some(g), Some((listed, total))) => {
            let mut text = format!(
                "The commits since its last green scheduled run, at {}:",
                short(&g.head_sha)
            );
            for (sha, title) in listed.iter().take(COMMITS_SHOWN) {
                text.push_str(&format!("\n- {sha} {title}"));
            }
            let more = total.saturating_sub(listed.len().min(COMMITS_SHOWN));
            if more > 0 {
                text.push_str(&format!("\n- and {more} more"));
            }
            text
        }
    };
    let again = run
        .path
        .as_deref()
        .and_then(|p| p.rsplit('/').next())
        .map(|file| format!(" `gh workflow run {file} --ref {base}` runs it again."))
        .unwrap_or_default();
    format!(
        "Fix the scheduled run of `{workflow}` on {base}: it failed at {} in {jobs}. Its run: {} Pull requests and the \
         merge train don't run it, so this is the first check of these commits there. {since}\nFind what broke it and \
         make it pass again on {base}.{again}",
        short(&run.head_sha),
        run.html_url
    )
}

impl Train {
    /// At most every `SCHEDULED_EVERY_MS`: each workflow's newest scheduled run on the base read, and a fix order opened
    /// for one that failed, once per failure.
    pub(super) async fn scheduled_pass(&self, repo: &str, project_ref: &ProjectRef) {
        let now = self.now_ms();
        {
            let mut reads = lock(&self.scheduled_reads);
            if reads
                .get(repo)
                .is_some_and(|t| now - t < SCHEDULED_EVERY_MS)
            {
                return;
            }
            reads.insert(repo.to_string(), now);
        }
        let Some(base) = self.sync.base(repo) else {
            return;
        };
        let runs = match self.github.scheduled_runs(repo, &base).await {
            Ok(runs) => runs,
            Err(e) => {
                return tracing::debug!(repo, error = %e.message, "train: scheduled runs not read");
            }
        };
        let project_ref = self.train_project(repo, project_ref);
        for (run, green) in newest_failures(&runs, now - SCHEDULED_RECENT_MS) {
            let key = (repo.to_string(), run.id);
            if lock(&self.scheduled_seen).contains(&key) {
                continue;
            }
            let jobs = match self.github.run_jobs(repo, run.id).await {
                Ok(jobs) => jobs,
                Err(e) => {
                    tracing::warn!(repo, run = run.id, error = %e.message, "train: a scheduled run's jobs not read");
                    continue;
                }
            };
            let mut red: Vec<String> = jobs
                .into_iter()
                .filter(|j| failed(j.conclusion.as_deref()))
                .map(|j| j.name)
                .collect();
            // A run that failed before any job started (a broken workflow file): the workflow is what failed.
            if red.is_empty() {
                red.push(run.name.clone().unwrap_or_else(|| run.id.to_string()));
            }
            if self
                .scheduled_fix_order(repo, &project_ref, &base, run, green, &red)
                .await
            {
                lock(&self.scheduled_seen).insert(key);
            }
        }
    }

    /// One fix order per failure: none when each of `jobs` already failed on this commit, and the open order of one of
    /// them takes the rest. False when the order couldn't be opened, to try again next pass.
    async fn scheduled_fix_order(
        &self,
        repo: &str,
        project_ref: &ProjectRef,
        base: &str,
        run: &WorkflowRun,
        green: Option<&WorkflowRun>,
        jobs: &[String],
    ) -> bool {
        let now = self.now_ms();
        let sha = run.head_sha.to_lowercase();
        let known: Vec<_> = jobs
            .iter()
            .filter_map(|j| self.records.fix_order(repo, j))
            .collect();
        if known.len() == jobs.len() && known.iter().all(|(s, _)| *s == sha) {
            return true;
        }
        if let Some((_, order)) = known
            .iter()
            .find(|(_, o)| self.host.workstream(o).is_some_and(|w| w.open))
        {
            for job in jobs {
                self.records.put_fix_order(repo, job, &sha, order, now);
            }
            return true;
        }
        let commits = match green {
            Some(g) if !g.head_sha.eq_ignore_ascii_case(&run.head_sha) => self
                .github
                .commits_since(repo, &g.head_sha, &run.head_sha)
                .await
                .ok(),
            _ => None,
        };
        let text = scheduled_order_text(base, run, jobs, green, commits.as_ref());
        let request = format!("train-scheduled:{repo}:{}", run.id);
        match self.host.open_order(project_ref, text, request).await {
            Ok(order) => {
                tracing::info!(repo, run = run.id, %order, "train: a scheduled run failed; fix order opened");
                for job in jobs {
                    self.records.put_fix_order(repo, job, &sha, &order, now);
                }
                true
            }
            Err(e) => {
                tracing::warn!(repo, run = run.id, error = %e, "train: fix order not opened; tried again next pass");
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: u64, workflow: u64, conclusion: &str, sha: &str, at: &str) -> WorkflowRun {
        WorkflowRun {
            id,
            workflow_id: workflow,
            name: Some(if workflow == 1 { "Mac" } else { "Staple" }.into()),
            path: Some(".github/workflows/mac.yml".into()),
            head_sha: sha.into(),
            conclusion: Some(conclusion.into()),
            html_url: format!("https://github.com/acme/app/actions/runs/{id}"),
            updated_at: Some(at.into()),
        }
    }

    /// Only each workflow's newest run counts, when it failed recently; its last green run is the one before it.
    #[test]
    fn each_workflows_newest_failed_run_with_its_last_green_one() {
        let since = parse_ms("2026-10-30T00:00:00Z").unwrap();
        let runs = [
            run(9, 1, "failure", "c3", "2026-10-30T04:50:00Z"),
            run(8, 2, "success", "c3", "2026-10-30T04:40:00Z"),
            run(7, 1, "failure", "c2", "2026-10-29T04:50:00Z"),
            run(6, 2, "failure", "c2", "2026-10-30T04:10:00Z"),
            run(5, 1, "success", "c1", "2026-10-28T04:50:00Z"),
            run(4, 3, "timed_out", "c1", "2026-10-28T04:50:00Z"),
            run(3, 4, "cancelled", "c3", "2026-10-30T04:50:00Z"),
        ];
        let found = newest_failures(&runs, since);
        let ids: Vec<(u64, Option<u64>)> =
            found.iter().map(|(r, g)| (r.id, g.map(|g| g.id))).collect();
        // Staple's newest passed; workflow 3's failure is too old; a cancelled run is no failure.
        assert_eq!(ids, [(9, Some(5))]);
        assert!(newest_failures(&runs[1..2], since).is_empty());
    }

    #[test]
    fn the_order_names_the_jobs_the_run_and_the_commits_since_the_last_green_run() {
        let red = run(9, 1, "failure", "c3c3c3c3c3", "2026-10-30T04:50:00Z");
        let green = run(5, 1, "success", "c1c1c1c1c1", "2026-10-28T04:50:00Z");
        let commits = (
            vec![
                ("c2c2c2c".into(), "fix(node): sandbox".into()),
                ("c3c3c3c".into(), "feat(app): chat".into()),
            ],
            2,
        );
        let jobs = ["rust (macos)".to_string(), "ios sessions".to_string()];
        let text = scheduled_order_text("main", &red, &jobs, Some(&green), Some(&commits));
        assert!(
            text.starts_with(
                "Fix the scheduled run of `Mac` on main: it failed at c3c3c3c3c3 in `rust (macos)`, `ios sessions`. \
                 Its run: https://github.com/acme/app/actions/runs/9 "
            ),
            "{text}"
        );
        assert!(
            text.contains(
                "since its last green scheduled run, at c1c1c1c1c1:\n- c2c2c2c fix(node): sandbox\n- c3c3c3c feat(app): chat\n"
            ),
            "{text}"
        );
        assert!(
            text.ends_with("`gh workflow run mac.yml --ref main` runs it again."),
            "{text}"
        );

        let many = (
            (0..25).map(|i| (format!("s{i}"), "t".into())).collect(),
            300,
        );
        let text = scheduled_order_text("main", &red, &jobs, Some(&green), Some(&many));
        assert!(text.contains("- s19 t\n- and 280 more\n"), "{text}");
        assert!(!text.contains("s20"), "{text}");

        let again = run(5, 1, "success", "C3C3C3C3C3", "2026-10-28T04:50:00Z");
        let text = scheduled_order_text("main", &red, &jobs, Some(&again), None);
        assert!(
            text.contains(
                "passed on this same commit before (https://github.com/acme/app/actions/runs/5)"
            ),
            "{text}"
        );
        let text = scheduled_order_text("main", &red, &jobs, None, None);
        assert!(
            text.contains("None of its recent scheduled runs passed"),
            "{text}"
        );
    }
}
