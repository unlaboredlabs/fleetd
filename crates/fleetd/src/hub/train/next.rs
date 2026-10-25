//! Priority on scarce CI runners. The train puts `fleetd:next` on what it is merging now: its batch PR, or the PR it
//! takes alone (before GitHub rebases it, so that push's CI run already sees the label). It takes the label off once
//! they merge or leave the queue. A repo whose runners are scarce runs its expensive jobs on labelled PRs only (the
//! docs' merge train page shows how); the train knows such a repo by its workflows naming the label. There, a PR it
//! merges alone never merges on a skipped check the label should have run: it waits, and the lead hears once when that
//! run doesn't come. A labelling failure is logged once; elsewhere it changes nothing.
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use super::contract::{ChangeId, ChangeState};
use super::github::{CheckRun, NEXT_LABEL};
use super::service::{Train, lock};
use crate::hub::store::parse_ms;

const LABEL_COLOR: &str = "1d76db";
const LABEL_ABOUT: &str = "The fleetd merge train merges this next";

/// How long a PR merged alone waits for the run its label starts (seconds, where CI reacts to the label) before the
/// train tells the lead, and between its tries to put on a label GitHub refused.
pub(super) const LABEL_HOLD_MS: i64 = 3 * 60_000;
/// How long whether a repo's workflows name the label is trusted before it is read again.
const USES_TTL_MS: i64 = 10 * 60_000;
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
    /// Per repo and base, whether its workflows name the label, and when that was read.
    uses: Mutex<HashMap<(String, String), (i64, bool)>>,
}

/// What putting the label on a PR came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Labelled {
    /// The train put it on then.
    At(i64),
    /// It was on already, since a time the train doesn't know (before a restart).
    Before,
    /// GitHub refused it.
    Failed,
}

/// A PR the train merges alone in a repo whose CI runs its expensive jobs on the label.
pub(super) struct Lone {
    pub label: Labelled,
    /// The checks its base requires.
    pub required: Vec<String>,
}

/// The skipped checks that don't count as passing for a PR merged alone in a repo that uses the label: a required
/// one, and one its CI may have skipped for want of the label: by the label's second (GitHub stamps whole seconds), or
/// any while the PR has no label.
pub(super) fn unproven_skips<'a>(runs: &'a [CheckRun], lone: &Lone) -> Vec<&'a CheckRun> {
    runs.iter()
        .filter(|r| r.conclusion.as_deref() == Some("skipped"))
        .filter(|r| {
            lone.required.contains(&r.name)
                || match lone.label {
                    Labelled::At(at) => skipped_by(r, at),
                    Labelled::Before => false,
                    Labelled::Failed => true,
                }
        })
        .collect()
}

fn skipped_by(run: &CheckRun, at: i64) -> bool {
    let second = at.div_euclid(1000) * 1000;
    run.completed_at
        .as_deref()
        .and_then(parse_ms)
        .is_some_and(|done| done < second + 1000)
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
                "train: the {NEXT_LABEL} label could not be set"
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

    /// Whether the repo's workflows on `base` name the label: its CI runs expensive jobs on labelled PRs only. Read
    /// once per `USES_TTL_MS`; a failed read keeps the last answer (none yet: no).
    pub(super) async fn uses_label(&self, repo: &str, base: &str) -> bool {
        let key = (repo.to_string(), base.to_string());
        let now = self.now_ms();
        let known = lock(&self.next_labels.uses).get(&key).copied();
        if let Some((at, uses)) = known
            && now - at < USES_TTL_MS
        {
            return uses;
        }
        match self.github.workflows_mention(repo, base, NEXT_LABEL).await {
            Ok(uses) => {
                lock(&self.next_labels.uses).insert(key, (now, uses));
                uses
            }
            Err(e) => {
                tracing::warn!(repo, error = %e.message, "train: workflows not read for {NEXT_LABEL}");
                known.is_some_and(|(_, uses)| uses)
            }
        }
    }

    /// Puts the label on PR `n` unless it `has` it.
    pub(super) async fn label(&self, repo: &str, n: i64, has: bool) -> Labelled {
        if !self.labels_known(repo).await {
            return Labelled::Failed;
        }
        if has {
            let mut labelled = lock(&self.next_labels.labelled);
            let at = *labelled
                .entry(repo.to_string())
                .or_default()
                .entry(n)
                .or_insert(None);
            return at.map_or(Labelled::Before, Labelled::At);
        }
        match self.github.add_label(repo, n, NEXT_LABEL).await {
            Ok(()) => {
                self.label_worked(repo);
                let at = self.now_ms();
                lock(&self.next_labels.labelled)
                    .entry(repo.to_string())
                    .or_default()
                    .insert(n, Some(at));
                Labelled::At(at)
            }
            Err(e) => {
                self.label_failed(repo, &e.message);
                Labelled::Failed
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

    /// `note` (`waiting for CI runners (N queued)`) on each of `changes` still in CI, the note it replaced kept in
    /// `earlier`; when None, the note taken off and the earlier one back.
    pub(super) fn runner_note(
        &self,
        changes: &[ChangeId],
        note: Option<&str>,
        earlier: &mut HashMap<ChangeId, Option<String>>,
    ) {
        for id in changes {
            let Some(change) = self.records.get(id) else {
                continue;
            };
            let shown = change.last_error.as_deref();
            let ours = shown.is_some_and(|s| s.starts_with(WAITING_FOR_RUNNERS));
            let next = match note {
                Some(note) => Some(note.to_string()),
                None if ours => earlier.remove(id).flatten(),
                None => continue,
            };
            if shown == next.as_deref() {
                continue;
            }
            if note.is_some() && !ours {
                earlier.insert(id.clone(), shown.map(String::from));
            }
            let state = if note.is_some() {
                ChangeState::Ci
            } else {
                change.state
            };
            self.update(id, Some(&[state]), |mut c| {
                c.last_error = next.as_deref().map(super::service::error_text);
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
    fn a_skip_by_the_labels_second_a_required_one_or_any_without_the_label_is_unproven() {
        let at = parse_ms("2026-10-25T12:00:00.400Z").unwrap();
        let skipped = |name, when| run(name, "completed", Some("skipped"), Some(when));
        let lone = |label, required: &[&str]| Lone {
            label,
            required: required.iter().map(|r| r.to_string()).collect(),
        };
        let names = |runs: &[CheckRun], lone: &Lone| -> Vec<String> {
            unproven_skips(runs, lone)
                .iter()
                .map(|r| r.name.clone())
                .collect()
        };
        let runs = [
            skipped("before", "2026-10-25T11:59:00Z"),
            skipped("same second", "2026-10-25T12:00:00Z"),
            skipped("after", "2026-10-25T12:00:01Z"),
            run(
                "ci",
                "completed",
                Some("success"),
                Some("2026-10-25T11:59:00Z"),
            ),
        ];
        assert_eq!(
            names(&runs, &lone(Labelled::At(at), &[])),
            ["before", "same second"]
        );
        assert_eq!(
            names(&runs, &lone(Labelled::At(at), &["after"])),
            ["before", "same second", "after"]
        );
        assert_eq!(names(&runs, &lone(Labelled::Before, &["after"])), ["after"]);
        assert_eq!(
            names(&runs, &lone(Labelled::Failed, &[])),
            ["before", "same second", "after"]
        );
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
