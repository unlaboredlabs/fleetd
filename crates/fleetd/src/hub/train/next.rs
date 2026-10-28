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
use super::records::{HEAD_STATES, QUEUED_STATES};
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

/// How long GitHub's answer for an upstream PR with no open Change is trusted: a pass reads it for the hold and for the
/// lead's line, and each held Change asks.
const UPSTREAM_TTL_MS: i64 = 10_000;

/// GitHub's answer for an upstream PR: merged, open, closed unmerged, or the read's error.
#[derive(Clone)]
pub(super) enum UpstreamPull {
    Merged,
    Open,
    Closed,
    Unread(String),
}

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

/// What the train reads from a repo's workflows on one base: the checks the label runs (`label_gated`) and those the
/// batch PR skips (`batch_skipped`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Workflows {
    pub label: Vec<String>,
    pub batch: Vec<BatchSkip>,
}

impl Workflows {
    /// The names of the checks the batch PR skips.
    pub fn batch_names(&self) -> Vec<String> {
        self.batch.iter().map(|b| b.name.clone()).collect()
    }
}

/// A check the batch PR skips (`batch_skipped`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct BatchSkip {
    pub name: String,
    /// The checks of the jobs it `needs`: skipped on a PR's own head, it passes only once they all passed there and
    /// one said it had no work (`NO_WORK`).
    pub needs: Vec<String>,
}

/// How a job that another job needs says, in a notice (`::notice::no work for rust (macos)`), that it skips that one
/// for want of work.
pub const NO_WORK: &str = "no work for ";

/// A repo's `Workflows` on one base, and when they were read.
type GatedRead = (i64, Workflows);

#[derive(Default)]
pub(super) struct NextLabels {
    /// Per repo, the PRs that carry the label and when the train put it on (None: found on it, as after a restart).
    labelled: Mutex<HashMap<String, HashMap<i64, Option<i64>>>>,
    /// The repos whose label exists and whose labelled PRs were read.
    known: Mutex<HashSet<String>>,
    /// The repos whose labelling failure is logged; a success clears it, so the next failure is logged again.
    warned: Mutex<HashSet<String>>,
    /// Per repo and base, what its workflows say (`Workflows`), and when they were read.
    gated: Mutex<HashMap<(String, String), GatedRead>>,
    /// Per repo and head in the line, what the train read of its checks the batch skips and did about them
    /// (`HeadSkips`); dropped once the head leaves the line (`prune_heads`).
    pub(super) heads: Mutex<HashMap<(String, String), HeadSkips>>,
}

/// What the train knows of one head's checks the batch skips.
#[derive(Default)]
pub(super) struct HeadSkips {
    /// The annotation messages of its finished check runs, by run id: they never change.
    notes: HashMap<u64, Vec<String>>,
    /// What the train re-ran on it for being cancelled (`rerun_cancelled_skips`): once each.
    reruns: Reruns,
}

/// Per job the train re-ran for being cancelled, by workflow run and check name (a re-run keeps both), what it did.
pub(super) type Reruns = HashMap<(u64, String), Rerun>;

/// What the train did about one cancelled job.
#[derive(Clone, Copy, Default)]
pub(super) struct Rerun {
    /// The re-runs GitHub took.
    times: u32,
    /// The newest cancelled run of it at the last re-run: until a newer one shows, that re-run hasn't started.
    seen: f64,
    /// GitHub's refusals since that re-run, and when the train may ask again.
    refused: u32,
    at: i64,
}

/// What `rerun_jobs` came to, over every job it was given.
#[derive(Default)]
pub(super) struct Reran {
    /// It re-ran one now.
    pub now: bool,
    /// One it re-ran earlier hasn't shown its new run yet.
    pub pending: bool,
    /// One waits for a job of its workflow run still going: GitHub re-runs none before the run is done.
    pub busy: bool,
    /// GitHub refused one, and the train asks again after a while.
    pub refused: bool,
    /// One was re-run as often as allowed and reads cancelled again.
    pub spent: bool,
    /// GitHub refused one `RERUN_TRIES` times.
    pub gave_up: bool,
    /// One isn't an Actions job, which nothing re-runs.
    pub unknown: bool,
}

/// How many times the train asks GitHub to re-run a cancelled job before it stops asking.
pub(super) const RERUN_TRIES: u32 = 3;
/// How long the train waits after GitHub refuses that re-run before it asks again, doubled on each refusal.
const RERUN_BACKOFF_MS: i64 = 60_000;

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
pub(super) fn gated_name(pattern: &str, name: &str) -> bool {
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

/// A workflow's `on:` (YAML 1.1 reads the bare key as `true`).
fn on(doc: &serde_yaml_ng::Value) -> Option<serde_yaml_ng::Value> {
    let map = doc.as_mapping()?;
    map.get("on")
        .or_else(|| map.get(serde_yaml_ng::Value::Bool(true)))
        .cloned()
}

/// How a job's `if:` skips it on the train's batch PR (`<prefix>train/batch`), spaces left out.
const SKIPPED_ON_BATCH: &str = "!endsWith(github.head_ref,'train/batch')";

/// The checks the train's batch PR skips, from the repo's workflow files (path, text): in a workflow that runs on each
/// push to a PR (`pull_request` with its default types, or with `opened` and `synchronize`), each job whose `if:` says
/// `!endsWith(github.head_ref, 'train/batch')`, with the checks of the jobs it `needs`. The batch never waits for them;
/// each PR's own head must pass them, or skip them for want of work, before it joins a batch (`own_checks`).
pub(super) fn batch_skipped(files: &[(String, String)]) -> Vec<BatchSkip> {
    use serde_yaml_ng::Value;
    let runs_on_pushes = |doc: &Value| match on(doc) {
        Some(Value::String(event)) => event == "pull_request",
        Some(Value::Sequence(events)) => events.iter().any(|e| e.as_str() == Some("pull_request")),
        Some(on) => on.get("pull_request").is_some_and(|pr| {
            pr.get("types")
                .and_then(Value::as_sequence)
                .is_none_or(|types| {
                    ["opened", "synchronize"]
                        .iter()
                        .all(|t| types.iter().any(|x| x.as_str() == Some(t)))
                })
        }),
        None => false,
    };
    let mut skips: Vec<BatchSkip> = Vec::new();
    for (_, text) in files {
        let Ok(doc) = serde_yaml_ng::from_str::<Value>(text) else {
            continue;
        };
        if !runs_on_pushes(&doc) {
            continue;
        }
        let Some(jobs) = doc.get("jobs").and_then(Value::as_mapping) else {
            continue;
        };
        for (id, job) in jobs {
            let skipped = job.get("if").and_then(Value::as_str).is_some_and(|cond| {
                let cond: String = cond
                    .split_whitespace()
                    .collect::<String>()
                    .replace('"', "'");
                cond.contains(SKIPPED_ON_BATCH)
            });
            let check = |id: &Value, job: &Value| {
                job.get("name")
                    .and_then(Value::as_str)
                    .or_else(|| id.as_str())
                    .map(str::to_string)
            };
            let needs: Vec<String> = match job.get("needs") {
                Some(Value::String(one)) => vec![one.clone()],
                Some(Value::Sequence(many)) => many
                    .iter()
                    .filter_map(|n| n.as_str().map(str::to_string))
                    .collect(),
                _ => Vec::new(),
            };
            let needs = needs
                .iter()
                .filter_map(|n| {
                    let key = Value::String(n.clone());
                    check(&key, jobs.get(&key)?)
                })
                .collect();
            if let Some(name) = check(id, job).filter(|_| skipped)
                && !skips.iter().any(|s| s.name == name)
            {
                skips.push(BatchSkip { name, needs });
            }
        }
    }
    skips
}

/// The skipped runs among `runs` (a head's newest of each check) of the checks the batch skips whose skip nothing
/// proves: one whose job `needs` others counts as skipped for want of work only once those all passed on the head and
/// one of them said so (`NO_WORK`, read by `notes`). Skipped any other way, as when its run was cancelled before it
/// started, it never ran: not reported.
pub(super) fn unproven_batch_skips<'a>(
    runs: &'a [CheckRun],
    batch: &[BatchSkip],
    notes: &dyn Fn(&CheckRun) -> Option<Vec<String>>,
) -> Vec<&'a CheckRun> {
    runs.iter()
        .filter(|r| r.conclusion.as_deref() == Some("skipped"))
        .filter(|r| {
            let Some(skip) = batch.iter().find(|b| gated_name(&b.name, &r.name)) else {
                return false;
            };
            if skip.needs.is_empty() {
                return false;
            }
            let needed: Vec<&CheckRun> = skip
                .needs
                .iter()
                .filter_map(|n| runs.iter().find(|x| gated_name(n, &x.name)))
                .collect();
            let passed = needed.len() == skip.needs.len()
                && needed
                    .iter()
                    .all(|x| x.conclusion.as_deref() == Some("success"));
            let said = format!("{NO_WORK}{}", r.name);
            !(passed
                && needed
                    .iter()
                    .any(|x| notes(x).is_some_and(|n| n.contains(&said))))
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

    /// The checks the label runs in the repo's CI on `base` (`workflows`); not known while those can't be read.
    pub(super) async fn label_gate(&self, repo: &str, base: &str) -> Gate {
        self.workflows(repo, base)
            .await
            .map_or(Gate::Unknown, |w| Gate::Checks(w.label))
    }

    /// What the repo's workflows on `base` say, read once per `USES_TTL_MS`. A failed read keeps the last answer for
    /// the repo; with none yet, None.
    pub(super) async fn workflows(&self, repo: &str, base: &str) -> Option<Workflows> {
        let key = (repo.to_string(), base.to_string());
        let now = self.now_ms();
        let known = lock(&self.next_labels.gated).get(&key).cloned();
        if let Some((at, workflows)) = &known
            && now - at < USES_TTL_MS
        {
            return Some(workflows.clone());
        }
        match self.github.workflow_files(repo, base).await {
            Ok(files) => {
                let workflows = Workflows {
                    label: label_gated(&files),
                    batch: batch_skipped(&files),
                };
                lock(&self.next_labels.gated).insert(key, (now, workflows.clone()));
                Some(workflows)
            }
            Err(e) => {
                tracing::warn!(repo, error = %e.message, "train: workflows not read");
                let last = known.or_else(|| {
                    lock(&self.next_labels.gated)
                        .iter()
                        .filter(|((r, _), _)| r == repo)
                        .max_by_key(|(_, (at, _))| *at)
                        .map(|(_, known)| known.clone())
                });
                last.map(|(_, workflows)| workflows)
            }
        }
    }

    /// How the label is on PR `n`, which `has` it or not, as far as the train knows, putting nothing on.
    pub(super) fn labelled(&self, repo: &str, n: i64, has: bool) -> Labelled {
        if !has {
            return Labelled::Failed;
        }
        let at = lock(&self.next_labels.labelled)
            .get(repo)
            .and_then(|prs| prs.get(&n).copied())
            .flatten();
        at.map_or(Labelled::Before, Labelled::At)
    }

    /// `runs` (of head `sha`) without the checks the batch skips whose skip on this head nothing proves
    /// (`unproven_batch_skips`): to `own_checks` they have not reported. The notes of the passed runs they need are
    /// read once per run; one that can't be read proves nothing.
    pub(super) async fn proven_runs(
        &self,
        repo: &str,
        sha: &str,
        runs: Vec<CheckRun>,
        batch: &[BatchSkip],
    ) -> Vec<CheckRun> {
        let key = (repo.to_string(), sha.to_string());
        let needed: Vec<&CheckRun> = runs
            .iter()
            .filter(|r| r.conclusion.as_deref() == Some("success"))
            .filter(|r| {
                batch
                    .iter()
                    .flat_map(|b| &b.needs)
                    .any(|n| gated_name(n, &r.name))
            })
            .collect();
        for r in needed {
            let id = r.id as u64;
            let read = lock(&self.next_labels.heads)
                .get(&key)
                .is_some_and(|h| h.notes.contains_key(&id));
            if read {
                continue;
            }
            match self.github.annotations(repo, id).await {
                Ok(notes) => {
                    lock(&self.next_labels.heads)
                        .entry(key.clone())
                        .or_default()
                        .notes
                        .insert(id, notes);
                }
                Err(e) => {
                    tracing::warn!(repo, run = id, error = %e.message, "train: a check run's notes not read")
                }
            }
        }
        let heads = lock(&self.next_labels.heads);
        let read = |r: &CheckRun| {
            heads
                .get(&key)
                .and_then(|h| h.notes.get(&(r.id as u64)))
                .cloned()
        };
        let unproven: Vec<String> = unproven_batch_skips(&runs, batch, &read)
            .iter()
            .map(|r| r.name.clone())
            .collect();
        drop(heads);
        runs.into_iter()
            .filter(|r| !unproven.contains(&r.name))
            .collect()
    }

    /// Re-runs each job of `cancelled` on its own, with the jobs that need it, never the rest of its workflow run: a
    /// job that failed there stays failed. `most` re-runs each at most, kept in `reruns`; `runs` the checks on the
    /// head, as a workflow run with a job still going re-runs none yet. GitHub refusing, it asks again after
    /// `RERUN_BACKOFF_MS`, doubled each time, and after `RERUN_TRIES` refusals stops asking.
    pub(super) async fn rerun_jobs(
        &self,
        repo: &str,
        cancelled: &[&CheckRun],
        runs: &[CheckRun],
        reruns: &mut Reruns,
        most: u32,
    ) -> Reran {
        let now = self.now_ms();
        // The workflow runs with a job still going, and those it re-ran a job of now.
        let mut busy: HashSet<u64> = runs
            .iter()
            .filter(|r| r.status != "completed")
            .filter_map(CheckRun::workflow_run)
            .collect();
        let mut out = Reran::default();
        for r in cancelled {
            let (Some(run), Some(job)) = (r.workflow_run(), r.job()) else {
                out.unknown = true;
                continue;
            };
            let rerun = reruns.entry((run, r.name.clone())).or_default();
            if rerun.times > 0 && r.id <= rerun.seen {
                out.pending = true;
            } else if rerun.times >= most {
                out.spent = true;
            } else if rerun.refused >= RERUN_TRIES {
                out.gave_up = true;
            } else if now < rerun.at {
                out.refused = true;
            } else if busy.contains(&run) {
                out.busy = true;
            } else {
                match self.github.rerun_job(repo, job).await {
                    Ok(()) => {
                        tracing::info!(
                            repo,
                            run,
                            job,
                            check = r.name,
                            "train: re-ran a cancelled job"
                        );
                        *rerun = Rerun {
                            times: rerun.times + 1,
                            seen: r.id,
                            ..Rerun::default()
                        };
                        busy.insert(run);
                        out.now = true;
                    }
                    Err(e) => {
                        rerun.refused += 1;
                        rerun.at = now + (RERUN_BACKOFF_MS << (rerun.refused - 1));
                        let tries = rerun.refused;
                        tracing::warn!(repo, run, job, tries, error = %e.message, "train: cancelled job not re-run");
                        if tries >= RERUN_TRIES {
                            out.gave_up = true;
                        } else {
                            out.refused = true;
                        }
                    }
                }
            }
        }
        out
    }

    /// A cancelled check the batch skips, or a cancelled job one of them needs, on head `sha` (`runs`, the newest of
    /// each check): nothing re-runs it by itself, so the PR would never join a batch. The train re-runs that job once
    /// (`rerun_jobs`) and says so; cancelled again after that, or refused `RERUN_TRIES` times, it says the check needs
    /// a push or a re-run by hand. None when none is cancelled.
    pub(super) async fn rerun_cancelled_skips(
        &self,
        repo: &str,
        sha: &str,
        runs: &[CheckRun],
        batch: &[BatchSkip],
    ) -> Option<String> {
        let watched = |name: &str| {
            batch
                .iter()
                .any(|b| gated_name(&b.name, name) || b.needs.iter().any(|n| gated_name(n, name)))
        };
        let cancelled: Vec<&CheckRun> = runs
            .iter()
            .filter(|r| r.conclusion.as_deref() == Some("cancelled") && watched(&r.name))
            .collect();
        if cancelled.is_empty() {
            return None;
        }
        let key = (repo.to_string(), sha.to_string());
        let names = cancelled
            .iter()
            .map(|r| format!("`{}`", r.name))
            .collect::<Vec<_>>()
            .join(", ");
        let mut reruns = lock(&self.next_labels.heads)
            .get_mut(&key)
            .map(|h| std::mem::take(&mut h.reruns))
            .unwrap_or_default();
        let reran = self
            .rerun_jobs(repo, &cancelled, runs, &mut reruns, 1)
            .await;
        lock(&self.next_labels.heads).entry(key).or_default().reruns = reruns;
        Some(if reran.gave_up {
            format!(
                "its own head's {names} was cancelled, and GitHub refused to re-run it {RERUN_TRIES} times: push \
                 again or re-run it"
            )
        } else if reran.spent {
            format!(
                "its own head's {names} was cancelled again after the train re-ran it: push again or re-run it"
            )
        } else if reran.now || reran.pending {
            format!("its own head's {names} was cancelled; the train re-ran it")
        } else if reran.busy {
            format!(
                "its own head's {names} was cancelled; the train re-runs it once its workflow run is done"
            )
        } else if reran.refused {
            format!(
                "its own head's {names} was cancelled, and GitHub refused to re-run it: the train asks again"
            )
        } else {
            format!("its own head's {names} was cancelled, and the train could not re-run it")
        })
    }

    /// Forgets what it knew of the heads of `repo` no longer in its line, nor in the train's hands.
    pub(super) fn prune_heads(&self, repo: &str) {
        let line: HashSet<String> = self
            .records
            .in_train(repo, &[QUEUED_STATES, HEAD_STATES].concat())
            .into_iter()
            .map(|c| c.head_sha.as_str().to_string())
            .collect();
        lock(&self.next_labels.heads).retain(|(r, sha), _| r != repo || line.contains(sha));
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
                match self.upstream_pull(url.as_str(), &repo, n).await {
                    UpstreamPull::Merged => return None,
                    UpstreamPull::Closed => ("it was closed without merging".to_string(), true),
                    UpstreamPull::Open => match latest.map(|c| c.state) {
                        Some(ChangeState::Refused) => ("the train refused it".to_string(), true),
                        Some(_) => ("it left the train unmerged".to_string(), true),
                        None => ("it is not on the train yet".to_string(), false),
                    },
                    UpstreamPull::Unread(message) => {
                        (format!("it could not be read: GitHub: {message}"), false)
                    }
                }
            }
            Some(_) => ("it hasn't merged yet".to_string(), false),
        };
        Some(Waiting {
            note: format!("{WAITING_ON}{repo}#{n}: {why}"),
            failed,
        })
    }

    /// The upstream PR as GitHub has it, read at most every `UPSTREAM_TTL_MS`.
    async fn upstream_pull(&self, url: &str, repo: &str, n: i64) -> UpstreamPull {
        let now = self.now_ms();
        if let Some((at, read)) = lock(&self.upstream_reads).get(url)
            && now - at < UPSTREAM_TTL_MS
        {
            return read.clone();
        }
        let read = match self.github.pull(repo, n).await {
            Ok(pull) if pull.merged => UpstreamPull::Merged,
            Ok(pull) if pull.state != "open" => UpstreamPull::Closed,
            Ok(_) => UpstreamPull::Open,
            Err(e) => UpstreamPull::Unread(e.message),
        };
        let mut reads = lock(&self.upstream_reads);
        reads.retain(|_, (at, _)| now - *at < UPSTREAM_TTL_MS);
        reads.insert(url.to_string(), (now, read.clone()));
        read
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

    /// fleetd's own workflows (D204): no check waits for the label, and the batch PR skips the macOS jobs, which each
    /// PR's own head runs. Nothing of the release or of the jobs that never run on a PR's push counts.
    #[test]
    fn fleetds_workflows_gate_nothing_on_the_label_and_skip_their_macos_jobs_on_a_batch() {
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
        assert!(label_gated(&files).is_empty());
        let mut skipped = batch_skipped(&files);
        skipped.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<&str> = skipped.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["desktop-macos", "ios sessions", "rust (macos)"]);
        // Each waits on the Linux job that decides whether it has work.
        assert!(
            skipped.iter().all(|s| s.needs == ["macos scope"]),
            "{skipped:?}"
        );
    }

    /// Only a job that skips the batch's branch, in a workflow that runs on each push to a PR: not one a label or a
    /// later push starts, nor one that runs only on the batch.
    #[test]
    fn the_batch_skips_the_jobs_of_a_prs_push_whose_if_skips_its_branch() {
        let workflow = |on: &str, jobs: &str| format!("name: W\non:\n{on}\njobs:\n{jobs}");
        let job =
            |id: &str, cond: &str| format!("  {id}:\n    if: {cond}\n    runs-on: macos-latest\n");
        let skips = "${{ !endsWith( github.head_ref , \"train/batch\") }}";
        let files = vec![
            (
                "ci.yml".to_string(),
                workflow(
                    "  pull_request:\n  push:",
                    &(job("mac", skips)
                        + &job("batch-only", "endsWith(github.head_ref, 'train/batch')")
                        + "  linux:\n    runs-on: ubuntu-latest\n"),
                ),
            ),
            (
                "typed.yml".to_string(),
                workflow(
                    "  pull_request:\n    types: [opened, synchronize, reopened]",
                    &job("typed", skips),
                ),
            ),
            (
                "list.yml".to_string(),
                workflow("  [push, pull_request]", &job("listed", skips)),
            ),
            (
                "label.yml".to_string(),
                workflow(
                    "  pull_request:\n    types: [labeled]",
                    &job("labelled", skips),
                ),
            ),
            (
                "stale.yml".to_string(),
                workflow(
                    "  pull_request:\n    types: [synchronize]",
                    &job("stale", skips),
                ),
            ),
            (
                "main.yml".to_string(),
                workflow("  push:", &job("main", skips)),
            ),
        ];
        let names: Vec<String> = batch_skipped(&files).into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["mac", "typed", "listed"]);
    }

    /// The jobs a skipped job needs, by their checks' names: one with a name, one without, and none that isn't there.
    #[test]
    fn a_skip_knows_the_checks_of_the_jobs_it_needs() {
        let ci = "name: CI\non: pull_request\njobs:\n  scope:\n    name: mac scope\n    runs-on: ubuntu-latest\n  \
                  lint:\n    runs-on: ubuntu-latest\n  mac:\n    needs: [scope, lint, gone]\n    \
                  if: ${{ !endsWith(github.head_ref, 'train/batch') }}\n    runs-on: macos-latest\n  one:\n    \
                  needs: scope\n    if: ${{ !endsWith(github.head_ref, 'train/batch') }}\n    runs-on: macos-latest\n";
        let skips = batch_skipped(&[("ci.yml".to_string(), ci.to_string())]);
        assert_eq!(
            skips,
            [
                BatchSkip {
                    name: "mac".into(),
                    needs: vec!["mac scope".into(), "lint".into()]
                },
                BatchSkip {
                    name: "one".into(),
                    needs: vec!["mac scope".into()]
                },
            ]
        );
    }

    /// D204: a skip of a check the batch skips proves no work only when every job it needs passed on the head and one
    /// said so. A scope cancelled, missing, or silent about it leaves the skip unproven: a run cancelled before the
    /// check started. A check that needs nothing is skipped by its own `if:`, which counts.
    #[test]
    fn a_skip_the_batch_skips_counts_only_when_the_scope_passed_and_said_no_work() {
        let batch = [
            BatchSkip {
                name: "mac".into(),
                needs: vec!["scope".into()],
            },
            BatchSkip {
                name: "plain".into(),
                needs: Vec::new(),
            },
        ];
        let skipped = |name| run(name, "completed", Some("skipped"), None);
        let unproven = |scope: Option<CheckRun>, notes: Vec<&str>| -> Vec<String> {
            let mut runs = vec![skipped("mac"), skipped("plain"), skipped("other")];
            runs.extend(scope);
            let notes: Vec<String> = notes.into_iter().map(String::from).collect();
            let read = |r: &CheckRun| (r.name == "scope").then(|| notes.clone());
            unproven_batch_skips(&runs, &batch, &read)
                .iter()
                .map(|r| r.name.clone())
                .collect()
        };
        let scope = |conclusion| Some(run("scope", "completed", Some(conclusion), None));
        assert!(unproven(scope("success"), vec!["no work for mac"]).is_empty());
        assert_eq!(
            unproven(scope("success"), vec!["no work for plain"]),
            ["mac"]
        );
        assert_eq!(
            unproven(scope("cancelled"), vec!["no work for mac"]),
            ["mac"]
        );
        assert_eq!(unproven(None, Vec::new()), ["mac"]);
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
