//! Priority on scarce CI runners. The train puts `fleetd:next` on what it merges next: its batch PR, the PR it takes
//! alone (before GitHub rebases it, so that push's CI run already sees the label) and the next few ready PRs in line.
//! It takes the label off once they merge, leave the queue or fall behind others. A repo whose runners are scarce runs
//! its expensive jobs on labelled PRs only (the docs' merge train page shows how). Labelling never stops a merge: a
//! failure is logged once and the train goes on.
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use super::contract::{ChangeId, ChangeState};
use super::github::{CheckRun, NEXT_LABEL};
use super::service::{Train, lock};
use crate::hub::store::parse_ms;

/// How many ready PRs in line carry the label: the one taken alone, or the first after a batch's members, and the rest.
pub(super) const NEXT_READY: usize = 3;
const LABEL_COLOR: &str = "1d76db";
const LABEL_ABOUT: &str = "The fleetd merge train merges this next";

/// How long a check skipped before the train labelled a PR it merges alone holds that PR's green: the label's own CI
/// run replaces it within seconds where CI reacts to the label, and it stands where CI doesn't.
pub(super) const LABEL_GRACE_MS: i64 = 3 * 60_000;
/// How long a head's checks may sit queued before its Changes say they wait for runners.
pub(super) const RUNNER_WAIT_MS: i64 = 5 * 60_000;
/// The start of the note on a Change in CI whose checks have waited `RUNNER_WAIT_MS` for runners.
pub const WAITING_FOR_RUNNERS: &str = "waiting for CI runners";

#[derive(Default)]
pub(super) struct NextLabels {
    /// Per repo, the PRs that carry the label and when the train put it on (None: found on it, as after a restart).
    labelled: Mutex<HashMap<String, HashMap<i64, Option<i64>>>>,
    /// The repos whose label exists and whose labelled PRs were read.
    known: Mutex<HashSet<String>>,
    /// The repos whose labelling failure is logged; a success clears it, so the next failure is logged again.
    warned: Mutex<HashSet<String>>,
}

/// Whether `runs` has a check skipped by the time the PR got the label at `labelled_at`: a job its CI may have
/// skipped for want of the label. GitHub stamps whole seconds, so one in the label's second counts as before it.
pub(super) fn skipped_before_label(runs: &[CheckRun], labelled_at: i64) -> bool {
    let label_second = labelled_at.div_euclid(1000) * 1000;
    runs.iter().any(|r| {
        r.conclusion.as_deref() == Some("skipped")
            && r.completed_at
                .as_deref()
                .and_then(parse_ms)
                .is_some_and(|at| at < label_second + 1000)
    })
}

/// The head's checks that wait for a runner.
pub(super) fn queued(runs: &[CheckRun]) -> usize {
    runs.iter()
        .filter(|r| r.status != "completed" && r.status != "in_progress")
        .count()
}

impl Train {
    fn label_failed(&self, repo: &str, why: &str) {
        if lock(&self.next_labels.warned).insert(repo.to_string()) {
            tracing::warn!(
                repo,
                error = why,
                "train: the {NEXT_LABEL} label could not be set; merges go on without it"
            );
        }
    }

    fn label_worked(&self, repo: &str) {
        lock(&self.next_labels.warned).remove(repo);
    }

    /// Creates the repo's label and reads the PRs that carry it, once per repo.
    async fn labels_known(&self, repo: &str) -> bool {
        if lock(&self.next_labels.known).contains(repo) {
            return true;
        }
        let read = async {
            self.github
                .create_label(repo, NEXT_LABEL, LABEL_COLOR, LABEL_ABOUT)
                .await?;
            self.github.labelled_pulls(repo, NEXT_LABEL).await
        };
        match read.await {
            Ok(found) => {
                let mut labelled = lock(&self.next_labels.labelled);
                let prs = labelled.entry(repo.to_string()).or_default();
                for n in found {
                    prs.entry(n).or_insert(None);
                }
                drop(labelled);
                lock(&self.next_labels.known).insert(repo.to_string());
                self.label_worked(repo);
                true
            }
            Err(e) => {
                self.label_failed(repo, &e.message);
                false
            }
        }
    }

    /// Puts the label on PR `n` unless it `has` it. When the train put it on, if it knows: a skipped check from before
    /// then may be one the label runs.
    pub(super) async fn label(&self, repo: &str, n: i64, has: bool) -> Option<i64> {
        if !self.labels_known(repo).await {
            return None;
        }
        if has {
            let mut labelled = lock(&self.next_labels.labelled);
            return *labelled
                .entry(repo.to_string())
                .or_default()
                .entry(n)
                .or_insert(None);
        }
        match self.github.add_label(repo, n, NEXT_LABEL).await {
            Ok(()) => {
                self.label_worked(repo);
                let at = self.now_ms();
                lock(&self.next_labels.labelled)
                    .entry(repo.to_string())
                    .or_default()
                    .insert(n, Some(at));
                Some(at)
            }
            Err(e) => {
                self.label_failed(repo, &e.message);
                None
            }
        }
    }

    /// The label on each of `wanted` (PR number, whether it has the label), in line order, and off every other PR
    /// that carries it but `kept`: a batch's members keep a label they have, as a red batch sends each alone.
    pub(super) async fn relabel(&self, repo: &str, wanted: &[(i64, bool)], kept: &[i64]) {
        if !self.labels_known(repo).await {
            return;
        }
        for (n, has) in wanted {
            self.label(repo, *n, *has).await;
        }
        let stale: Vec<i64> = lock(&self.next_labels.labelled)
            .get(repo)
            .map(|prs| {
                prs.keys()
                    .filter(|n| !kept.contains(n) && !wanted.iter().any(|(w, _)| w == *n))
                    .copied()
                    .collect()
            })
            .unwrap_or_default();
        for n in stale {
            match self.github.remove_label(repo, n, NEXT_LABEL).await {
                Ok(()) => {
                    self.label_worked(repo);
                    if let Some(prs) = lock(&self.next_labels.labelled).get_mut(repo) {
                        prs.remove(&n);
                    }
                }
                Err(e) => self.label_failed(repo, &e.message),
            }
        }
    }

    /// `note` (`waiting for CI runners (N queued)`) on each of `changes` still in CI, or, when None, the note taken off.
    pub(super) fn runner_note(&self, changes: &[ChangeId], note: Option<&str>) {
        for id in changes {
            let Some(change) = self.records.get(id) else {
                continue;
            };
            let shown = change.last_error.as_deref();
            let ours = shown.is_none_or(|s| s.starts_with(WAITING_FOR_RUNNERS));
            if shown == note || (note.is_none() && !ours) {
                continue;
            }
            let state = if note.is_some() {
                ChangeState::Ci
            } else {
                change.state
            };
            self.update(id, Some(&[state]), |mut c| {
                c.last_error = note.map(super::service::error_text);
                c
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(
        name: &str,
        status: &str,
        conclusion: Option<&str>,
        completed_at: Option<&str>,
    ) -> CheckRun {
        CheckRun {
            id: 1.0,
            name: name.into(),
            status: status.into(),
            conclusion: conclusion.map(String::from),
            html_url: None,
            started_at: None,
            completed_at: completed_at.map(String::from),
            head_sha: None,
        }
    }

    #[test]
    fn only_a_skip_by_the_labels_second_is_one_the_label_may_run() {
        let at = parse_ms("2026-10-25T12:00:00.400Z").unwrap();
        let skipped = |when| {
            [run(
                "rust (macos)",
                "completed",
                Some("skipped"),
                Some(when),
            )]
        };
        assert!(skipped_before_label(&skipped("2026-10-25T11:59:00Z"), at));
        assert!(skipped_before_label(&skipped("2026-10-25T12:00:00Z"), at));
        assert!(!skipped_before_label(&skipped("2026-10-25T12:00:01Z"), at));
        let passed = [run(
            "ci",
            "completed",
            Some("success"),
            Some("2026-10-25T11:59:00Z"),
        )];
        assert!(!skipped_before_label(&passed, at));
    }

    #[test]
    fn queued_counts_the_checks_no_runner_took_yet() {
        let runs = [
            run("a", "queued", None, None),
            run("b", "waiting", None, None),
            run("c", "in_progress", None, None),
            run("d", "completed", Some("success"), None),
        ];
        assert_eq!(queued(&runs), 2);
    }
}
