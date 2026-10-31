//! A check that fails on a PR's own head gets one more try before the train counts it red: the train re-runs that job
//! alone, and the PR goes back to its author only when it fails again. #861 sat in `ci_failed` on a flaky test until
//! its author pushed the same code again. A re-run that passes goes on to the merge, and the author and the lead hear
//! in one line that the check was flaky, with the failing test when its log names one.
use super::contract::Change;
use super::github::CheckRun;
use super::next::{Reruns, reran};
use super::service::{TRAIN_BY, Train, short};
use crate::hub::leads::events::Event;

/// How many times the train re-runs a job whose check failed on a PR's own head before it counts it red.
pub(super) const FAILED_RERUNS: u32 = 1;

/// A check that failed and was re-run, with the test its log named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Flaky {
    pub check: String,
    pub test: Option<String>,
}

/// The first failing test a job's log names: cargo's and nextest's, Go's, pytest's, vitest's, jest's and Playwright's
/// words for one. None when it names none.
pub(super) fn failed_test(log: &str) -> Option<String> {
    log.lines().find_map(|line| {
        let line = plain(line);
        let line = line.trim();
        let name = if let Some(rest) = line.strip_prefix("test ")
            && let Some(name) = rest.strip_suffix(" ... FAILED")
        {
            name
        } else if let Some(rest) = line.strip_prefix("FAIL [")
            && let Some((_, name)) = rest.split_once(']')
        {
            name
        } else if let Some(rest) = line.strip_prefix("--- FAIL: ") {
            rest.split_whitespace().next().unwrap_or_default()
        } else if let Some(rest) = line.strip_prefix("FAILED ") {
            rest.split(" - ").next().unwrap_or_default()
        } else {
            ["FAIL ", "× ", "✗ ", "✘ ", "● "]
                .iter()
                .find_map(|mark| line.strip_prefix(mark))?
        };
        let name = name.trim();
        (!name.is_empty()).then(|| name.chars().take(200).collect())
    })
}

/// A log line without GitHub's timestamp and terminal colours.
fn plain(line: &str) -> String {
    let line = match line.split_once(' ') {
        Some((stamp, rest)) if stamp.len() >= 20 && stamp.ends_with('Z') && stamp.contains('T') => {
            rest
        }
        _ => line,
    };
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // An escape: `ESC [ ... letter`.
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// The line the author and the lead get when a re-run passed.
pub(super) fn flaky_text(sha: &str, flaky: &[Flaky]) -> String {
    let checks: Vec<String> = flaky
        .iter()
        .map(|f| match &f.test {
            Some(test) => format!("{} (test {test})", f.check),
            None => f.check.clone(),
        })
        .collect();
    format!(
        "flaky CI on {}: {} failed, then passed when the train re-ran it, so the train carries on; nothing to do",
        short(sha),
        checks.join(", ")
    )
}

impl Train {
    /// Re-runs each job of `red` that failed (not cancelled) on its own, once (`FAILED_RERUNS`), with the jobs that need
    /// it (`rerun_jobs`): whether it re-ran one now. None when the failure stands: a job re-run once failed again, a
    /// check isn't an Actions job, or GitHub refused the re-run `RERUN_TRIES` times. Each job it re-ran goes in `flaky`,
    /// with the test its log names. `runs` all the checks on the head.
    pub(super) async fn rerun_failed(
        &self,
        repo: &str,
        red: &[CheckRun],
        runs: &[CheckRun],
        reruns: &mut Reruns,
        flaky: &mut Vec<Flaky>,
    ) -> Option<bool> {
        let failed: Vec<&CheckRun> = red
            .iter()
            .filter(|r| r.conclusion.as_deref() != Some("cancelled"))
            .collect();
        if failed.is_empty() {
            return Some(false);
        }
        let out = self
            .rerun_jobs(repo, &failed, runs, reruns, FAILED_RERUNS)
            .await;
        if out.unknown || out.spent || out.gave_up {
            return None;
        }
        for r in failed {
            if !reran(reruns, r) || flaky.iter().any(|f| f.check == r.name) {
                continue;
            }
            let test = match r.job() {
                Some(job) => match self.github.job_log(repo, job).await {
                    Ok(log) => failed_test(&log),
                    Err(e) => {
                        tracing::warn!(repo, job, error = %e.message, "train: job log not read");
                        None
                    }
                },
                None => None,
            };
            flaky.push(Flaky {
                check: r.name.clone(),
                test,
            });
        }
        Some(out.now)
    }

    /// Its author and the lead hear, in one line, that `flaky` failed on `sha` and passed on the train's re-run.
    pub(super) async fn flaky_note(&self, change: &Change, sha: &str, flaky: &[Flaky]) {
        if flaky.is_empty() {
            return;
        }
        let text = flaky_text(sha, flaky);
        tracing::info!(change_id = %change.change_id, text, "train: flaky check passed on a re-run");
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_failing_test_from_a_log() {
        let cargo = "2026-10-30T21:00:00.1234567Z test hub::lab::serves_the_page ... FAILED\n";
        assert_eq!(
            failed_test(&format!(
                "2026-10-30T21:00:00.0000000Z test a::ok ... ok\n{cargo}"
            ))
            .as_deref(),
            Some("hub::lab::serves_the_page")
        );
        let nextest = "2026-10-30T21:00:00.1Z         \u{1b}[31mFAIL\u{1b}[0m [   1.204s] fleetd hub::lab::page\n";
        assert_eq!(
            failed_test(nextest).as_deref(),
            Some("fleetd hub::lab::page")
        );
        assert_eq!(
            failed_test("--- FAIL: TestServe (0.01s)").as_deref(),
            Some("TestServe")
        );
        assert_eq!(
            failed_test("FAILED tests/test_lab.py::test_page - AssertionError").as_deref(),
            Some("tests/test_lab.py::test_page")
        );
        assert_eq!(
            failed_test(" FAIL  src/lab.test.ts > lab > serves").as_deref(),
            Some("src/lab.test.ts > lab > serves")
        );
        assert_eq!(failed_test("all good\nerror: build failed"), None);
    }

    #[test]
    fn the_flaky_line_names_each_check_and_its_test() {
        let text = flaky_text(
            "0123456789abcdef",
            &[
                Flaky {
                    check: "rust (linux)".into(),
                    test: Some("hub::lab::page".into()),
                },
                Flaky {
                    check: "qa".into(),
                    test: None,
                },
            ],
        );
        assert_eq!(
            text,
            "flaky CI on 0123456789ab: rust (linux) (test hub::lab::page), qa failed, then passed when the train \
             re-ran it, so the train carries on; nothing to do"
        );
    }
}
