//! Priority on scarce CI runners. The train puts `fleetd:next` on what it is merging now: its batch PR, or the PR it
//! takes alone (before GitHub rebases it, so that push's CI run already sees the label). It takes the label off once
//! they merge or leave the queue. A repo whose runners are scarce runs its expensive jobs on labelled PRs only (the
//! docs' merge train page shows how); the train knows such a repo by its workflows naming the label. There, a PR it
//! merges alone never merges on a skipped check the label should have run: it waits, and the lead hears once when that
//! run doesn't come. A labelling failure is logged once; elsewhere it changes nothing.
//!
//! Merge order across PRs (`after`): a Change whose `after` PRs haven't all merged waits in line, held "waiting on" the
//! first of them, in this repo or another. When one fails CI or review, or leaves the train unmerged, the Change stays
//! held and the lead is told once. Once they have all merged it goes, kicked by their merge.
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use super::contract::{Change, ChangeId, ChangeState, GitHubPrUrl, parse_pr_url};
use super::github::{CheckRun, NEXT_LABEL};
use super::records::QUEUED_STATES;
use super::service::{Train, lock, timed_out};
use crate::hub::leads::events::Event;
use crate::hub::reviews::service::BLOCKED;
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

/// The start of the hold on a ready Change whose `after` PRs haven't all merged: the first one (`owner/name#n`) and why
/// it hasn't.
pub const WAITING_ON: &str = "held: waiting on ";

/// The first of a Change's `after` PRs that hasn't merged.
pub(super) struct Waiting {
    /// The Change's hold: `WAITING_ON`, the PR and why it hasn't merged.
    pub note: String,
    /// It failed CI or review, or left the train unmerged: the lead hears of it.
    pub failed: bool,
}

/// `after` as the train keys it: each PR's URL with its repo lowercased, once.
pub(super) fn upstreams(after: &[GitHubPrUrl]) -> Vec<GitHubPrUrl> {
    let mut out: Vec<GitHubPrUrl> = Vec::new();
    for url in after {
        let Some(p) = parse_pr_url(url.as_str()) else {
            continue;
        };
        let url = GitHubPrUrl::unchecked(format!(
            "https://github.com/{}/pull/{}",
            p.repo.to_lowercase(),
            p.pr_number
        ));
        if !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

/// The checks the label runs in a repo's CI on one base, and when they were read.
type GatedRead = (i64, Vec<String>);

#[derive(Default)]
pub(super) struct NextLabels {
    /// Per repo, the PRs that carry the label and when the train put it on (None: found on it, as after a restart).
    labelled: Mutex<HashMap<String, HashMap<i64, Option<i64>>>>,
    /// The repos whose label exists and whose labelled PRs were read.
    known: Mutex<HashSet<String>>,
    /// The repos whose labelling failure is logged; a success clears it, so the next failure is logged again.
    warned: Mutex<HashSet<String>>,
    /// Per repo and base, the checks the label runs (`label_gated`), and when they were read.
    gated: Mutex<HashMap<(String, String), GatedRead>>,
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

/// The checks the label runs in a repo's CI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Gate {
    /// By name (`gated_name`); none in a repo whose CI doesn't use the label.
    Checks(Vec<String>),
    /// Its workflows could not be read yet: any skipped check may be one, for `LABEL_HOLD_MS` after the label.
    Unknown,
}

/// A PR the train merges alone in a repo whose CI may run checks on the label.
pub(super) struct Lone {
    pub label: Labelled,
    pub gate: Gate,
}

impl Lone {
    /// Since when the run the label starts is waited for: the label, or `start` (the wait's) when it is older or the
    /// train doesn't know when it went on.
    pub fn since(&self, start: i64) -> i64 {
        match self.label {
            Labelled::At(at) => at.max(start),
            _ => start,
        }
    }
}

/// The skipped checks that don't count as passing for a PR merged alone: one the label runs, skipped for want of it,
/// by the label's second (GitHub stamps whole seconds) or while the PR has no label. Any other skip counts as GitHub
/// counts it.
pub(super) fn unproven_skips<'a>(runs: &'a [CheckRun], lone: &Lone) -> Vec<&'a CheckRun> {
    runs.iter()
        .filter(|r| r.conclusion.as_deref() == Some("skipped"))
        .filter(|r| match &lone.gate {
            Gate::Checks(names) => names.iter().any(|n| gated_name(n, &r.name)),
            Gate::Unknown => true,
        })
        .filter(|r| match lone.label {
            Labelled::At(at) => skipped_by(r, at),
            Labelled::Before => false,
            Labelled::Failed => true,
        })
        .collect()
}

/// Whether the check `name` is the job `pattern` names; an expression in it (`qa (${{ matrix.os }})`) matches any text.
fn gated_name(pattern: &str, name: &str) -> bool {
    match pattern.split_once("${{") {
        None => pattern == name,
        Some((head, rest)) => {
            let tail = rest.split_once("}}").map_or("", |(_, t)| t);
            name.len() >= head.len() + tail.len() && name.starts_with(head) && name.ends_with(tail)
        }
    }
}

/// The names of the checks the label runs, from the repo's workflow files (path, text): in a workflow the label
/// triggers, each job whose `if:` names the label. A workflow the label triggers reacts to `labeled` on pull requests
/// and names the label, or is one such a workflow starts (`gh workflow run <file or name>`). A job skipped for any other
/// reason, and every job of other workflows, is not the label's.
pub(super) fn label_gated(files: &[(String, String)]) -> Vec<String> {
    use serde_yaml_ng::Value;
    let parsed: Vec<(&str, &str, Value)> = files
        .iter()
        .filter_map(|(path, text)| {
            Some((
                path.as_str(),
                text.as_str(),
                serde_yaml_ng::from_str(text).ok()?,
            ))
        })
        .collect();
    let on = |doc: &Value| -> Option<Value> {
        let map = doc.as_mapping()?;
        map.get("on")
            .or_else(|| map.get(Value::Bool(true)))
            .cloned()
    };
    let reacts = |doc: &Value, text: &str| {
        text.contains(NEXT_LABEL)
            && on(doc).is_some_and(|on| {
                ["pull_request", "pull_request_target"].iter().any(|event| {
                    on.get(event)
                        .and_then(|e| e.get("types"))
                        .and_then(Value::as_sequence)
                        .is_some_and(|types| types.iter().any(|t| t.as_str() == Some("labeled")))
                })
            })
    };
    let started: Vec<String> = parsed
        .iter()
        .filter(|(_, text, doc)| reacts(doc, text))
        .flat_map(|(_, text, _)| {
            text.match_indices("workflow run ").filter_map(|(i, m)| {
                let rest = &text[i + m.len()..];
                let word = rest.split_whitespace().next()?;
                Some(word.trim_matches(|c| c == '"' || c == '\'').to_string())
            })
        })
        .collect();
    let triggered = |path: &str, text: &str, doc: &Value| {
        let file = path.rsplit('/').next().unwrap_or(path);
        let name = doc.get("name").and_then(Value::as_str);
        reacts(doc, text)
            || started
                .iter()
                .any(|s| s == file || Some(s.as_str()) == name)
    };
    let mut names = Vec::new();
    for (path, text, doc) in &parsed {
        if !triggered(path, text, doc) {
            continue;
        }
        let Some(jobs) = doc.get("jobs").and_then(Value::as_mapping) else {
            continue;
        };
        for (id, job) in jobs {
            let gated = job
                .get("if")
                .and_then(Value::as_str)
                .is_some_and(|cond| cond.contains(NEXT_LABEL));
            let name = job
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| id.as_str());
            if let Some(name) = name.filter(|_| gated)
                && !names.iter().any(|n| n == name)
            {
                names.push(name.to_string());
            }
        }
    }
    names
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

    /// The checks the label runs in the repo's CI on `base`, read once per `USES_TTL_MS`. A failed read keeps the last
    /// answer for the repo; with none yet, they are not known.
    pub(super) async fn label_gate(&self, repo: &str, base: &str) -> Gate {
        let key = (repo.to_string(), base.to_string());
        let now = self.now_ms();
        let known = lock(&self.next_labels.gated).get(&key).cloned();
        if let Some((at, names)) = &known
            && now - at < USES_TTL_MS
        {
            return Gate::Checks(names.clone());
        }
        match self.github.workflow_files(repo, base).await {
            Ok(files) => {
                let names = label_gated(&files);
                lock(&self.next_labels.gated).insert(key, (now, names.clone()));
                Gate::Checks(names)
            }
            Err(e) => {
                tracing::warn!(repo, error = %e.message, "train: workflows not read for {NEXT_LABEL}");
                let last = known.or_else(|| {
                    lock(&self.next_labels.gated)
                        .iter()
                        .filter(|((r, _), _)| r == repo)
                        .max_by_key(|(_, (at, _))| *at)
                        .map(|(_, known)| known.clone())
                });
                last.map_or(Gate::Unknown, |(_, names)| Gate::Checks(names))
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

impl Train {
    /// The first of the Change's `after` PRs that hasn't merged; None once they all have.
    pub(super) async fn waiting_on(&self, change: &Change) -> Option<Waiting> {
        for url in &change.after {
            if let Some(waiting) = self.upstream(url).await {
                return Some(waiting);
            }
        }
        None
    }

    /// Where the upstream PR stands: None once it merged. Its Change on the train says, else GitHub.
    async fn upstream(&self, url: &GitHubPrUrl) -> Option<Waiting> {
        let parsed = parse_pr_url(url.as_str())?;
        let (repo, n) = (parsed.repo.to_lowercase(), parsed.pr_number);
        let latest = self.records.latest_for(&repo, n);
        let (why, failed) = match latest.as_ref().map(|c| (c, c.state)) {
            Some((_, ChangeState::Merged)) => return None,
            Some((c, ChangeState::CiFailed)) if timed_out(c) => {
                ("its CI ran past the timeout".to_string(), false)
            }
            Some((_, ChangeState::CiFailed)) => ("its CI failed".to_string(), true),
            Some((_, ChangeState::NeedsRebase)) => (
                "it conflicts with its base and is back with its writer".to_string(),
                false,
            ),
            Some((c, ChangeState::Reviewing))
                if c.last_error
                    .as_deref()
                    .is_some_and(|e| e.starts_with(BLOCKED)) =>
            {
                ("its review found blocking issues".to_string(), true)
            }
            Some((_, ChangeState::Refused | ChangeState::Abandoned)) | None => {
                match self.github.pull(&repo, n).await {
                    Ok(pull) if pull.merged => return None,
                    Ok(pull) if pull.state != "open" => {
                        ("it was closed without merging".to_string(), true)
                    }
                    Ok(_) => match latest.map(|c| c.state) {
                        Some(ChangeState::Refused) => ("the train refused it".to_string(), true),
                        Some(_) => ("it left the train unmerged".to_string(), true),
                        None => ("it is not on the train yet".to_string(), false),
                    },
                    Err(e) => (
                        format!("it could not be read: GitHub: {}", e.message),
                        false,
                    ),
                }
            }
            Some(_) => ("it hasn't merged yet".to_string(), false),
        };
        Some(Waiting {
            note: format!("{WAITING_ON}{repo}#{n}: {why}"),
            failed,
        })
    }

    /// Each pass: the lead hears once of each upstream failure that holds one of the repo's Changes in line.
    pub(super) async fn after_pass(&self, repo: &str) {
        for change in self.records.in_train(repo, QUEUED_STATES) {
            if change.after.is_empty() {
                continue;
            }
            let Some(waiting) = self.waiting_on(&change).await.filter(|w| w.failed) else {
                continue;
            };
            let key = (change.change_id.clone(), waiting.note.clone());
            if !lock(&self.after_told).insert(key) {
                continue;
            }
            let why = waiting.note.strip_prefix("held: ").unwrap_or(&waiting.note);
            let text = format!(
                "held, {why}. It merges only after that PR does: get it fixed and back on the train, or close this one."
            );
            let line = Event::PrNote {
                change: change.change_id.as_str(),
                pr_url: change.pr_url.as_str(),
                text: &text,
            }
            .render();
            self.wake_lead(&change.project_ref, line).await;
        }
    }

    /// The PRs it waits on, now also `after`'s.
    pub(super) fn add_after(&self, change: Change, after: &[GitHubPrUrl]) -> Change {
        if after.iter().all(|u| change.after.contains(u)) {
            return change;
        }
        let id = change.change_id.clone();
        self.update(&id, None, |mut c| {
            for u in after {
                if !c.after.contains(u) {
                    c.after.push(u.clone());
                }
            }
            c
        })
        .unwrap_or(change)
    }

    /// The upstream PR in `after` that already waits, through its own `after`, on `pr_url`: merging in that order could
    /// never happen.
    pub(super) fn loops_back(&self, pr_url: &str, after: &[GitHubPrUrl]) -> Option<String> {
        for start in after {
            let mut seen: HashSet<String> = HashSet::new();
            let mut todo = vec![start.to_string()];
            while let Some(url) = todo.pop() {
                if url == pr_url {
                    return Some(start.to_string());
                }
                if !seen.insert(url.clone()) {
                    continue;
                }
                let Some(p) = parse_pr_url(&url) else {
                    continue;
                };
                if let Some(c) = self.records.open_for(&p.repo, p.pr_number) {
                    todo.extend(c.after.iter().map(ToString::to_string));
                }
            }
        }
        None
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
    fn only_a_skip_of_a_check_the_label_runs_by_the_labels_second_or_without_the_label_is_unproven()
    {
        let at = parse_ms("2026-10-25T12:00:00.400Z").unwrap();
        let skipped = |name, when| run(name, "completed", Some("skipped"), Some(when));
        let gated = |label| Lone {
            label,
            gate: Gate::Checks(vec!["before".into(), "same second".into(), "after".into()]),
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
            skipped("not the label's", "2026-10-25T11:59:00Z"),
            run(
                "ci",
                "completed",
                Some("success"),
                Some("2026-10-25T11:59:00Z"),
            ),
        ];
        assert_eq!(
            names(&runs, &gated(Labelled::At(at))),
            ["before", "same second"]
        );
        assert!(names(&runs, &gated(Labelled::Before)).is_empty());
        assert_eq!(
            names(&runs, &gated(Labelled::Failed)),
            ["before", "same second", "after"]
        );
        let unknown = Lone {
            label: Labelled::At(at),
            gate: Gate::Unknown,
        };
        assert_eq!(
            names(&runs, &unknown),
            ["before", "same second", "not the label's"]
        );
    }

    /// fleetd's own workflows: the label runs macOS in CI (through macos-label.yml) and the dispatch job; the release
    /// and nightly jobs it never runs, so their skips are never the label's.
    #[test]
    fn fleetds_workflows_gate_its_macos_jobs_and_nothing_of_the_release() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../.github/workflows");
        let mut files: Vec<(String, String)> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "yml"))
            .map(|p| {
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                (
                    format!(".github/workflows/{name}"),
                    std::fs::read_to_string(&p).unwrap(),
                )
            })
            .collect();
        files.sort();
        let mut gated = label_gated(&files);
        gated.sort();
        assert_eq!(
            gated,
            ["desktop-macos", "dispatch", "ios sessions", "rust (macos)"]
        );
    }

    #[test]
    fn a_job_name_with_an_expression_matches_each_of_its_checks() {
        assert!(gated_name("qa (${{ matrix.os }})", "qa (macos-latest)"));
        assert!(!gated_name("qa (${{ matrix.os }})", "lint (macos-latest)"));
        assert!(gated_name("rust (macos)", "rust (macos)"));
        assert!(!gated_name("rust (macos)", "rust (linux)"));
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
