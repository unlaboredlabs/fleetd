//! Batches: two or more ready Changes into one base, each reviewed for its current patch and green on its own head by
//! its fast set (the base's required checks and the repo's own; cancelled and superseded runs and every other check
//! left to the batch's CI) and by the checks the batch's CI skips (`batch_skipped`: a repo's scarce macOS jobs, D204),
//! up to `BATCH_MAX` of them in queue order, merged together after one CI run. Each pass
//! records why each ready PR was left out, on the Change and in the log. A PR approved at an earlier patch whose
//! re-review is at work joins as a ready one does: the merge waits for that review too, and blocking findings drop it
//! from the batch, which forms again without it. The train builds the batch on GitHub: its
//! scratch branch at the base, each member's head merged into it in order, and one PR for it. A member that conflicts
//! is left out and goes back to its writer. Green, the train posts `fleetd/train` on that head and squash-merges the
//! batch PR pinned to it; each member is then closed with a link. Red, timed out or refused, every member goes alone.
//! No gate is skipped: every member is reviewed clean at its patch before the merge, the batch's CI must pass, and GitHub's rules on the base decide the merge
//! as they would for one PR. The next pass's sweep deletes the scratch branch, which closes a batch PR left open.
use std::time::Duration;

use super::contract::{Change, ChangeId, ChangeState};
use super::github::{
    BATCH_MARKER, BranchMerge, CheckRun, CommitStatus, MergeOutcome, NEXT_LABEL, Pull, batch_heads,
};
use super::host::BoxFut;
use super::next::{WAITING_ON, gated_name};
use super::records::DRAFT;
use super::regen::{Conflict, REGENERATING};
use super::service::{
    Between, CiOutcome, Fast, ReviewWait, Train, error_text, is_red, lock, short,
};

const BATCH_MAX: usize = 8;

const HELD: &str = "held: the PR has the `hold` label; the train takes it once the label is gone";
pub(super) const NO_CI: &str = "held: this repo has no CI, and fleetd merges only on green CI. Add a GitHub Actions \
     workflow that runs on pull requests; it goes on by itself once one exists.";
/// Why a batch's members went back to ready when one of them was no longer where the batch left it.
const MEMBER_LEFT: &str = "a PR left the batch while it formed; the next pass forms it again";
/// The last error of a merged member whose PR the train could not close; the next pass's reconcile closes it.
const NOT_CLOSED: &str = "landed, but its PR is not closed yet";

/// The start of a ready Change's `lastError` while the batch forming left it out, followed by why.
pub(crate) const LEFT_OUT: &str = "not in this batch: ";

/// The checks a list names, in backticks.
fn named(runs: &[String]) -> String {
    runs.iter()
        .map(|n| format!("`{n}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Why a ready PR's own head keeps it out of a batch, by its fast set and the checks the batch skips (`batch`, as
/// `batch_skipped` names them): a check there failed or still runs, or one of them never reported (`statuses` are read
/// for those), or the head has no checks at all. A cancelled or superseded run of the fast set, and any check outside
/// both, doesn't count: the batch's own CI decides. A check the batch skips is decided here only, so a cancelled one
/// counts as failed. None when it may join. `runs` are the newest of each check; `fast` None when the base's rules or
/// the settings can't be read, and an empty fast set, judge by every check.
pub(super) fn own_checks(
    runs: &[CheckRun],
    statuses: &[CommitStatus],
    fast: Option<&Fast>,
    batch: &[String],
) -> Option<String> {
    if runs.is_empty() && statuses.is_empty() {
        return Some("its own head has no checks yet".into());
    }
    let cancelled = |r: &CheckRun| r.conclusion.as_deref() == Some("cancelled");
    let skipped_by_batch = |r: &CheckRun| batch.iter().any(|n| gated_name(n, &r.name));
    let judged: Vec<&CheckRun> = match fast.filter(|f| !f.set.is_empty()) {
        Some(fast) => runs
            .iter()
            .filter(|r| skipped_by_batch(r) || (fast.holds(&r.name) && !cancelled(r)))
            .collect(),
        None if fast.is_some() => runs
            .iter()
            .filter(|r| skipped_by_batch(r) || !cancelled(r))
            .collect(),
        None => runs.iter().collect(),
    };
    let names = |f: &dyn Fn(&CheckRun) -> bool| -> Vec<String> {
        judged
            .iter()
            .filter(|r| f(r))
            .map(|r| r.name.clone())
            .collect()
    };
    let mut red = names(&|r| is_red(r));
    let set = fast.map(|f| f.set.as_slice()).unwrap_or_default();
    let mut wanted: Vec<&String> = Vec::new();
    for name in set.iter().chain(batch) {
        if !wanted.contains(&name) && !runs.iter().any(|r| gated_name(name, &r.name)) {
            wanted.push(name);
        }
    }
    let mut missing = Vec::new();
    for name in wanted {
        match statuses
            .iter()
            .find(|s| &s.context == name)
            .map(|s| s.state.as_str())
        {
            Some("success") => {}
            Some("failure" | "error") => red.push(name.clone()),
            _ => missing.push(name.clone()),
        }
    }
    let running = names(&|r| r.status != "completed");
    if !red.is_empty() {
        Some(format!("its own head's {} failed", named(&red)))
    } else if !running.is_empty() {
        Some(format!("its own head's {} still running", named(&running)))
    } else if !missing.is_empty() {
        Some(format!(
            "its own head hasn't reported {} yet",
            named(&missing)
        ))
    } else {
        None
    }
}

/// A clean review is bound to the Change's current patch: nothing else lets the train take it.
pub(super) fn reviewed(change: &Change) -> bool {
    change.patch_id.as_ref().is_some_and(|patch| {
        change
            .reviews
            .iter()
            .any(|r| r.blocking.get() == 0 && &r.patch_id == patch)
    })
}

/// The batch PR a Change landed in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Landed {
    pub pr_number: i64,
    pub merged_sha: String,
    /// Every member's PR number.
    pub members: Vec<i64>,
}

/// A ready Change and its PR as this pass read it.
#[derive(Clone)]
pub(super) struct Candidate {
    pub change: Change,
    pub pull: Pull,
}

/// A batch PR in CI: its members are those of the batches it was built on, then its own `added`.
#[derive(Clone)]
pub(super) struct Stage {
    pub pr: i64,
    pub sha: String,
    pub title: String,
    pub members: Vec<Candidate>,
    pub added: usize,
}

impl Stage {
    /// The members it added to the batch it was built on.
    fn own(&self) -> &[Candidate] {
        &self.members[self.members.len() - self.added..]
    }
}

/// How a batch in CI failed to pass.
enum Failed {
    /// Its CI went red, timed out or was superseded.
    Ci(&'static str),
    /// It was still in CI this long after the batch ahead of it passed.
    Late(Duration),
}

impl Failed {
    fn ci(&self) -> &'static str {
        match self {
            Failed::Ci(what) => what,
            Failed::Late(_) => "ran late",
        }
    }

    /// What the batch did, for the PRs built on it.
    fn what(&self) -> String {
        match self {
            Failed::Ci(what) => format!("didn't pass: its CI {what}"),
            Failed::Late(wait) => format!(
                "was still in CI {} s after the one ahead passed",
                wait.as_secs()
            ),
        }
    }
}

/// Why a batch whose CI passed didn't land, nothing released yet.
enum Unlanded {
    /// These members can't land now (a re-review, a push, a PR GitHub couldn't read); a batch without them could.
    Members(Vec<ChangeId>, String),
    /// GitHub refused the merge: each of its PRs goes alone.
    Refused(String),
    /// It couldn't be merged now, for no member's fault.
    Failed(String),
    /// The merge may have happened: nothing else lands until the next pass reads it.
    Unknown(String),
}

impl Unlanded {
    fn why(&self) -> &str {
        match self {
            Unlanded::Members(_, why)
            | Unlanded::Refused(why)
            | Unlanded::Failed(why)
            | Unlanded::Unknown(why) => why,
        }
    }
}

/// The scratch branch of the `k`th batch behind the one that lands next (from 1), under `<prefix>train/`: it ends in
/// `train/batch` as that one's does, so a repo's CI treats each alike.
fn follower_name(k: usize) -> String {
    format!("{k}/train/batch")
}

/// The scratch branch names under `<prefix>train/` of every batch a train of `depth` may have in CI.
pub(super) fn batch_names(depth: usize) -> Vec<String> {
    std::iter::once("batch".to_string())
        .chain((1..depth.max(1)).map(follower_name))
        .collect()
}

fn batch_title(members: &[Candidate]) -> String {
    let parts: Vec<String> = members
        .iter()
        .map(|m| {
            let title = m.pull.title.trim();
            if title.is_empty() {
                format!("#{}", m.change.pr_number)
            } else {
                format!("{title} (#{})", m.change.pr_number)
            }
        })
        .collect();
    let title = format!("batch: {}", parts.join("; "));
    if title.chars().count() > 250 {
        format!("{}…", title.chars().take(249).collect::<String>())
    } else {
        title
    }
}

fn member_lines(members: &[Candidate]) -> String {
    members
        .iter()
        .map(|m| format!("- #{} {}", m.change.pr_number, m.pull.title.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The trailer that names a Change on the squash that lands it, `Fleetd-Change: X12 (T45, W9)`: the train's merges are
/// told apart from git alone, on any host.
pub(super) fn change_trailer(change: &Change) -> String {
    let task = change
        .task_id
        .as_ref()
        .map(|t| format!("{t}, "))
        .unwrap_or_default();
    format!(
        "{}: {} ({task}{})",
        fleetd_contracts::metrics::CHANGE_TRAILER,
        change.change_id,
        change.workstream_id
    )
}

/// A squash message's body with the Changes' trailers last, where git reads them: in its own trailer block when it
/// ends with one (the commits' `Co-authored-by` lines), so those stay trailers too.
pub(super) fn with_trailers<'a>(
    body: &str,
    changes: impl IntoIterator<Item = &'a Change>,
) -> String {
    let trailers: Vec<String> = changes.into_iter().map(change_trailer).collect();
    let body = body.replace("\r\n", "\n");
    let body = body.trim();
    let last = body.rsplit("\n\n").next().unwrap_or_default();
    let trailer_block = !last.is_empty()
        && last.lines().all(|l| {
            l.split_once(": ").is_some_and(|(token, value)| {
                !token.is_empty()
                    && !value.trim().is_empty()
                    && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
        });
    match (body, trailer_block) {
        ("", _) => trailers.join("\n"),
        (body, true) => format!("{body}\n{}", trailers.join("\n")),
        (body, false) => format!("{body}\n\n{}", trailers.join("\n")),
    }
}

fn batch_body(base: &str, members: &[Candidate]) -> String {
    // Each member's head as built: a member counts as landed only while its PR is still at that head.
    let numbers: Vec<String> = members
        .iter()
        .map(|m| format!("#{}@{}", m.change.pr_number, m.change.head_sha))
        .collect();
    format!(
        "The fleetd merge train's batch: these ready PRs, each reviewed at its current patch and green on its own, \
         merged onto {base} in queue order and tested by this PR's one CI run. Once this merges, each is closed \
         with a link here. Red CI sends each through the train alone.\n\n{}\n\n{BATCH_MARKER} {}\n",
        member_lines(members),
        numbers.join(" ")
    )
}

impl Train {
    /// `<prefix>train/<name>`: a scratch branch in the namespace of the repo's checkout in the project that owns its
    /// train; None while its policy can't be read, since guessing could write outside its namespace.
    pub(super) async fn scratch_branch(&self, change: &Change, name: &str) -> Option<String> {
        let checkout = self.train_checkout(&change.repo, &change.project_ref);
        let prefix = self.host.branch_prefix(&checkout).await?;
        Some(format!("{prefix}train/{name}"))
    }

    /// `<prefix>train/` of the repo's checkout in the project that owns its train.
    pub(super) async fn scratch_prefix(&self, repo: &str) -> Option<String> {
        let owner = self.records.train(repo)?.project_ref;
        let checkout = self.train_checkout(repo, &owner);
        let prefix = self.host.branch_prefix(&checkout).await?;
        Some(format!("{prefix}train/"))
    }

    /// After refresh and the freeze: a batch of the ready Changes into the first one's base that are green on their
    /// own heads, or the first one alone. True when it took or settled one. First, `fleetd:next` goes on the one taken
    /// alone and off every PR the train is not merging now. Never on the PRs behind it: the run the label starts would
    /// cancel their own CI, keep them out of the next batch, and take the runners the batch needs.
    pub(super) async fn next(&self, repo: &str) -> bool {
        let ready = self
            .records
            .in_train(repo, &[ChangeState::Reviewing, ChangeState::Ready])
            .into_iter()
            .filter(|c| c.state == ChangeState::Ready || self.rereviewing(c))
            .collect();
        let (candidates, settled) = self.candidates(repo, ready).await;
        self.prune_heads(repo);
        let Some(head) = candidates.first() else {
            self.relabel(repo, &[], &[]).await;
            return settled;
        };
        let base = head.pull.base.ref_.clone();
        let mut members = Vec::new();
        let mut left = Vec::new();
        if candidates.len() >= 2 {
            for c in &candidates {
                let why = if members.len() == BATCH_MAX {
                    Some(format!("the batch is full ({BATCH_MAX} PRs)"))
                } else if c.pull.base.ref_ != base {
                    Some(format!(
                        "it merges into {}, and this batch into {base}",
                        c.pull.base.ref_
                    ))
                } else {
                    self.own_ci(repo, &c.change, &base).await
                };
                match why {
                    None => members.push(c.clone()),
                    Some(why) => left.push((c, why)),
                }
            }
        }
        if members.len() < 2 {
            // Alone: the head goes, and every other PR waits for it.
            let alone = match left
                .iter()
                .find(|(c, _)| c.change.change_id == head.change.change_id)
            {
                Some((_, why)) => format!("{} goes alone first, as {why}", head.change.change_id),
                None => format!(
                    "{} goes alone first: no other ready PR could join it",
                    head.change.change_id
                ),
            };
            for m in &members {
                left.push((
                    candidates
                        .iter()
                        .find(|c| c.change.change_id == m.change.change_id)
                        .unwrap_or(head),
                    alone.clone(),
                ));
            }
        }
        let taken: Vec<&Candidate> = if members.len() >= 2 {
            members.iter().collect()
        } else {
            vec![head]
        };
        for c in &candidates {
            let why = left
                .iter()
                .find(|(l, _)| l.change.change_id == c.change.change_id)
                .map(|(_, why)| why.as_str())
                .filter(|_| {
                    !taken
                        .iter()
                        .any(|t| t.change.change_id == c.change.change_id)
                });
            self.left_out(repo, &c.change, why);
        }
        // The batch PR gets its label once it is open (`take_batch`); its members keep one they have, as a red batch
        // sends each alone.
        // A PR its own CI already tested on the base as it is now needs no label: it would only run that CI again.
        let tested = members.len() < 2 && self.tested_alone(&head.change, &head.pull).await;
        let wanted = if members.len() >= 2 || tested {
            Vec::new()
        } else {
            vec![(head.change.pr_number.get(), head.pull.labelled(NEXT_LABEL))]
        };
        let mut kept: Vec<i64> = members.iter().map(|m| m.change.pr_number.get()).collect();
        if tested {
            kept.push(head.change.pr_number.get());
        }
        self.relabel(repo, &wanted, &kept).await;
        if members.len() >= 2 {
            self.take_batch(repo, &base, members).await;
        } else {
            self.take(&head.change).await;
        }
        true
    }

    /// The ready Changes the train may take now, in order, with their PRs. A PR merged, closed or pushed to since is
    /// settled here as the one-at-a-time path would, and one with no clean review of its patch goes back to review.
    /// A held PR and one into a base with no CI wait.
    async fn candidates(&self, repo: &str, ready: Vec<Change>) -> (Vec<Candidate>, bool) {
        let mut out = Vec::new();
        let mut settled = false;
        for change in ready {
            let pull = match self.github.pull(repo, change.pr_number.get()).await {
                Ok(pull) => pull,
                Err(e) => {
                    self.ready_error(&change, &e.message);
                    continue;
                }
            };
            if pull.merged {
                self.abandon(&change, "was merged outside the train").await;
                settled = true;
                continue;
            }
            if pull.state != "open" {
                self.abandon(&change, "was closed").await;
                settled = true;
                continue;
            }
            // A re-review whose head moved is refresh's to send to the gate.
            if change.state == ChangeState::Reviewing
                && pull.head.sha.to_lowercase() != change.head_sha.as_str()
            {
                continue;
            }
            let mut change = change;
            if pull.head.sha.to_lowercase() != change.head_sha.as_str() {
                if let Err(e) = self.ready_moved(&change, &pull).await {
                    self.ready_error(&change, &e.message);
                }
                settled = true;
                // A new patch of an approved PR is reviewed again while it goes through the train, from this pass on.
                match self
                    .records
                    .get(&change.change_id)
                    .filter(|c| c.head_sha.as_str() == pull.head.sha.to_lowercase())
                    .filter(|c| c.state == ChangeState::Ready || self.rereviewing(c))
                {
                    Some(moved) => change = moved,
                    None => continue,
                }
            }
            if !reviewed(&change) && change.state == ChangeState::Ready {
                if let Some(reviewing) =
                    self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
                        c.state = ChangeState::Reviewing;
                        c
                    })
                {
                    self.to_gate(reviewing).await;
                }
                settled = true;
                continue;
            }
            let waiting = self.waiting_on(&change).await;
            let hold = if pull.draft {
                Some(DRAFT)
            } else if pull.held() {
                Some(HELD)
            } else if let Some(waiting) = &waiting {
                Some(waiting.note.as_str())
            } else {
                // A read that failed is not "no CI": the head's checks decide, as for any repo.
                matches!(self.has_ci(repo, &pull.base.ref_).await, Ok(false)).then_some(NO_CI)
            };
            let shown = change.last_error.as_deref();
            let ours = [Some(DRAFT), Some(HELD), Some(NO_CI)];
            let was_waiting = shown.is_some_and(|s| s.starts_with(WAITING_ON));
            if hold != shown && (hold.is_some() || was_waiting || ours.contains(&shown)) {
                self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
                    c.last_error = hold.map(error_text);
                    c
                });
            }
            if hold.is_some() {
                continue;
            }
            // Regenerated first, or still being regenerated: its new head comes through as a push.
            if self.early_migration(&change, &pull).await {
                continue;
            }
            out.push(Candidate { change, pull });
        }
        (out, settled)
    }

    fn ready_error(&self, change: &Change, message: &str) {
        let why = error_text(&format!("GitHub: {message}"));
        self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
            c.last_error = Some(why);
            c
        });
    }

    /// Why the Change's own head keeps it out of a batch into `base` (`own_checks`); None when it may join.
    pub(super) async fn own_ci(&self, repo: &str, change: &Change, base: &str) -> Option<String> {
        let runs = match self.github.check_runs(repo, change.head_sha.as_str()).await {
            Ok(runs) => runs,
            Err(e) => {
                return Some(format!(
                    "its checks could not be read: GitHub: {}",
                    e.message
                ));
            }
        };
        let fast = self.fast(repo, base).await;
        let Some(workflows) = self.workflows(repo, base).await else {
            return Some("its workflows could not be read for the checks a batch skips".into());
        };
        let sha = change.head_sha.as_str();
        if let Some(why) = self
            .rerun_cancelled_skips(repo, sha, &runs, &workflows.batch)
            .await
        {
            return Some(why);
        }
        let runs = self.proven_runs(repo, sha, runs, &workflows.batch).await;
        let batch = workflows.batch_names();
        let unrun = fast
            .as_ref()
            .map(|f| f.set.as_slice())
            .unwrap_or_default()
            .iter()
            .chain(&batch)
            .any(|n| !runs.iter().any(|r| gated_name(n, &r.name)));
        // A head with no check runs may still carry statuses.
        let statuses = if unrun || runs.is_empty() {
            match self.github.statuses(repo, change.head_sha.as_str()).await {
                Ok(statuses) => statuses,
                Err(e) => {
                    return Some(format!(
                        "its statuses could not be read: GitHub: {}",
                        e.message
                    ));
                }
            }
        } else {
            Vec::new()
        };
        own_checks(&runs, &statuses, fast.as_ref(), &batch)
    }

    /// Records why this pass left a ready Change out of the batch, on the Change (`LEFT_OUT`) and in the log; None
    /// clears a reason an earlier pass recorded.
    fn left_out(&self, repo: &str, change: &Change, why: Option<&str>) {
        let shown = change.last_error.as_deref();
        let ours = shown.is_some_and(|e| e.starts_with(LEFT_OUT));
        let note = why.map(|why| format!("{LEFT_OUT}{why}"));
        if let Some(why) = why {
            tracing::info!(repo, change_id = %change.change_id, pr = change.pr_number.get(), why, "train: left out of the batch");
        }
        // Another reason an earlier pass left (a red batch, a refusal) gives way to this pass's.
        if note.as_deref() == shown || (note.is_none() && !ours) {
            return;
        }
        self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
            c.last_error = note.as_deref().map(error_text);
            c
        });
    }

    /// Deletes the train's scratch branches: no batch is in flight between passes, so any left is a leftover (a
    /// batch that merged or failed, a restart). GitHub closes a PR whose head branch goes.
    pub(super) async fn sweep_scratch(&self, repo: &str) {
        let Some(prefix) = self.scratch_prefix(repo).await else {
            return;
        };
        let Ok(branches) = self.github.matching_branches(repo, &prefix).await else {
            return;
        };
        for branch in branches {
            if let Err(e) = self.github.delete_branch(repo, &branch).await {
                tracing::warn!(repo, branch, error = %e.message, "train: scratch branch not deleted");
            }
        }
    }

    /// A Change in review, approved at an earlier patch, whose re-review is at work: it may go through the train
    /// meanwhile, the merge waiting for both. Not once that review outlasted `review_wait` in the train: it then waits
    /// out of the line until the review is done.
    pub(super) fn rereviewing(&self, change: &Change) -> bool {
        change.state == ChangeState::Reviewing
            && !self.overdue_review(change)
            && change.patch_id.as_ref().is_some_and(|patch| {
                change
                    .reviews
                    .iter()
                    .any(|r| r.blocking.get() == 0 && &r.patch_id != patch)
            })
            && self.gate_rereview(change)
    }

    /// Back in place (their queue order never changed), with `why` as their last error: to ready, or to review for one
    /// whose re-review is not done.
    fn release(&self, members: &[Candidate], why: &str) {
        let from = [ChangeState::Rebasing, ChangeState::Ci, ChangeState::Merging];
        for m in members {
            self.update(&m.change.change_id, Some(&from), |mut c| {
                c.state = if reviewed(&c) {
                    ChangeState::Ready
                } else {
                    ChangeState::Reviewing
                };
                c.last_error = Some(error_text(why));
                c
            });
        }
    }

    /// Moves each member from `from` to `to`; the ones that were not in it any more are left out.
    fn advance(&self, members: &[Candidate], from: ChangeState, to: ChangeState) -> Vec<Candidate> {
        members
            .iter()
            .filter_map(|m| {
                let change = self.update(&m.change.change_id, Some(&[from]), |mut c| {
                    c.state = to;
                    c
                })?;
                Some(Candidate {
                    change,
                    pull: m.pull.clone(),
                })
            })
            .collect()
    }

    /// Each member alone, in order, released to ready first with `why`. One handed back to ready stops the rest: it is
    /// still first in line, and the next pass takes it before them.
    async fn alone(&self, members: &[Candidate], why: &str) {
        self.release(members, why);
        for m in members {
            let ready = self
                .records
                .get(&m.change.change_id)
                .filter(|c| c.state == ChangeState::Ready || self.rereviewing(c));
            if let Some(ready) = ready {
                self.take(&ready).await;
                if self
                    .records
                    .get(&m.change.change_id)
                    .is_some_and(|c| c.state == ChangeState::Ready || self.rereviewing(&c))
                {
                    return;
                }
            }
        }
    }

    /// Makes `branch` the base with each member's head merged in, in order, on GitHub. A member that conflicts goes
    /// back to its writer, one the base already has back to ready. The batch's head and the members in it.
    async fn build_batch(
        &self,
        repo: &str,
        base: &str,
        branch: &str,
        members: &[Candidate],
    ) -> Result<(String, Vec<Candidate>), super::github::GhError> {
        let mut head = self.github.branch_sha(repo, base).await?;
        self.github.create_branch(repo, branch, &head).await?;
        let mut kept = Vec::new();
        for m in members {
            let message = format!("{} (#{})", m.pull.title.trim(), m.change.pr_number);
            match self
                .github
                .merge_into(repo, branch, m.change.head_sha.as_str(), &message)
                .await?
            {
                BranchMerge::Merged(sha) => {
                    head = sha;
                    kept.push(m.clone());
                }
                // Only with the PRs ahead of it in this batch: it goes again once they land, and a conflict with the
                // base then is regenerated, or goes back to its author.
                BranchMerge::Conflict if !kept.is_empty() && m.pull.mergeable != Some(false) => {
                    let why = format!(
                        "conflicts with the PRs ahead of it in this batch; it goes again once they land on {base}"
                    );
                    self.release(std::slice::from_ref(m), &why);
                }
                BranchMerge::Conflict => {
                    let why = format!("conflicts with {base}");
                    if self.conflicted(&m.change, &m.pull, &why).await == Conflict::Regenerating {
                        self.release(
                            std::slice::from_ref(m),
                            &format!("it {why}; {REGENERATING}"),
                        );
                    }
                }
                BranchMerge::Nothing => self.release(
                    std::slice::from_ref(m),
                    &format!("left out of the batch: {base} already has its head"),
                ),
            }
        }
        Ok((head, kept))
    }

    async fn take_batch(&self, repo: &str, base: &str, members: Vec<Candidate>) {
        let building: Vec<Candidate> = [ChangeState::Ready, ChangeState::Reviewing]
            .into_iter()
            .flat_map(|from| {
                let at: Vec<Candidate> = members
                    .iter()
                    .filter(|m| m.change.state == from)
                    .cloned()
                    .collect();
                self.advance(&at, from, ChangeState::Rebasing)
            })
            .collect();
        let building: Vec<Candidate> = members
            .iter()
            .filter_map(|m| {
                building
                    .iter()
                    .find(|b| b.change.change_id == m.change.change_id)
                    .cloned()
            })
            .collect();
        if building.len() != members.len() {
            return self.release(&building, MEMBER_LEFT);
        }
        let Some(branch) = self.scratch_branch(&building[0].change, "batch").await else {
            return self.release(&building, "the batch's branch name could not be read");
        };
        let (sha, kept) = match self.build_batch(repo, base, &branch, &building).await {
            Ok(built) => built,
            Err(e) => return self.release(&building, &format!("GitHub: {}", e.message)),
        };
        if kept.len() < 2 {
            return self
                .alone(
                    &kept,
                    "the batch's other PRs conflict or are already in its base",
                )
                .await;
        }
        let title = batch_title(&kept);
        let pr = match self
            .github
            .open_pull(repo, &branch, base, &title, &batch_body(base, &kept), false)
            .await
        {
            Ok(pr) => pr,
            Err(e) => return self.release(&kept, &format!("GitHub: {}", e.message)),
        };
        // Its branch already gets the expensive jobs; the label shows it is next.
        self.label(repo, pr, false).await;
        let in_ci = self.advance(&kept, ChangeState::Rebasing, ChangeState::Ci);
        if in_ci.len() != kept.len() {
            return self.release(&kept, MEMBER_LEFT);
        }
        lock(&self.pushed).insert(
            in_ci[0].change.change_id.clone(),
            (sha.clone(), self.now_ms()),
        );
        let added = in_ci.len();
        let lead = Stage {
            pr,
            sha,
            title,
            members: in_ci,
            added,
        };
        self.ride(repo, base, lead).await
    }

    /// The batch PR behind `ahead` (the `k`th of the chain, from 1): the ready PRs green on their own heads that
    /// aren't in it, merged on top of its head on a branch of their own, in CI with it. None when there are none, or it
    /// couldn't be built; a PR that conflicts with the batches ahead goes back in line, for a batch on the base once
    /// they land.
    async fn follower(&self, repo: &str, base: &str, ahead: &Stage, k: usize) -> Option<Stage> {
        let ready = self
            .records
            .in_train(repo, &[ChangeState::Reviewing, ChangeState::Ready])
            .into_iter()
            .filter(|c| c.state == ChangeState::Ready || self.rereviewing(c))
            .collect();
        let (candidates, _) = self.candidates(repo, ready).await;
        let mut picked = Vec::new();
        for c in candidates {
            if picked.len() == BATCH_MAX {
                break;
            }
            if c.pull.base.ref_ == base && self.own_ci(repo, &c.change, base).await.is_none() {
                picked.push(c);
            }
        }
        if picked.is_empty() {
            return None;
        }
        let building: Vec<Candidate> = [ChangeState::Ready, ChangeState::Reviewing]
            .into_iter()
            .flat_map(|from| {
                let at: Vec<Candidate> = picked
                    .iter()
                    .filter(|m| m.change.state == from)
                    .cloned()
                    .collect();
                self.advance(&at, from, ChangeState::Rebasing)
            })
            .collect();
        if building.len() != picked.len() {
            self.release(&building, MEMBER_LEFT);
            return None;
        }
        let Some(branch) = self
            .scratch_branch(&ahead.members[0].change, &follower_name(k))
            .await
        else {
            self.release(&building, "the batch's branch name could not be read");
            return None;
        };
        let built = async {
            self.github.create_branch(repo, &branch, &ahead.sha).await?;
            let (mut head, mut kept) = (ahead.sha.clone(), Vec::new());
            for m in &building {
                let message = format!("{} (#{})", m.pull.title.trim(), m.change.pr_number);
                match self
                    .github
                    .merge_into(repo, &branch, m.change.head_sha.as_str(), &message)
                    .await?
                {
                    BranchMerge::Merged(sha) => {
                        head = sha;
                        kept.push(m.clone());
                    }
                    BranchMerge::Conflict => self.release(
                        std::slice::from_ref(m),
                        &format!(
                            "conflicts with the PRs in batch #{} ahead of it; it goes again once they land",
                            ahead.pr
                        ),
                    ),
                    BranchMerge::Nothing => self.release(
                        std::slice::from_ref(m),
                        &format!("left out of the batch: {base} already has its head"),
                    ),
                }
            }
            Ok::<_, super::github::GhError>((head, kept))
        };
        let (sha, kept) = match built.await {
            Ok(built) => built,
            Err(e) => {
                self.release(&building, &format!("GitHub: {}", e.message));
                return None;
            }
        };
        if kept.is_empty() {
            return None;
        }
        let members: Vec<Candidate> = ahead.members.iter().chain(&kept).cloned().collect();
        let title = batch_title(&members);
        let pr = match self
            .github
            .open_pull(
                repo,
                &branch,
                base,
                &title,
                &batch_body(base, &members),
                false,
            )
            .await
        {
            Ok(pr) => pr,
            Err(e) => {
                self.release(&kept, &format!("GitHub: {}", e.message));
                return None;
            }
        };
        self.label(repo, pr, false).await;
        let in_ci = self.advance(&kept, ChangeState::Rebasing, ChangeState::Ci);
        if in_ci.len() != kept.len() {
            self.release(&kept, MEMBER_LEFT);
            return None;
        }
        lock(&self.pushed).insert(
            in_ci[0].change.change_id.clone(),
            (sha.clone(), self.now_ms()),
        );
        let numbers: Vec<i64> = in_ci.iter().map(|m| m.change.pr_number.get()).collect();
        tracing::info!(
            repo,
            pr,
            sha,
            ?numbers,
            ahead = ahead.pr,
            "train: a batch in CI behind the one ahead"
        );
        let added = in_ci.len();
        Some(Stage {
            pr,
            sha,
            title,
            members: ahead.members.iter().cloned().chain(in_ci).collect(),
            added,
        })
    }

    /// From `lead` in CI to merged, with up to `pipeline_depth - 1` batches behind it in CI meanwhile, each built on
    /// the one ahead as ready PRs come. The furthest batch that passed, with every batch ahead of it passed, lands as
    /// one squash of all their members, on exactly the tree its CI tested. A batch that fails sends its own PRs alone
    /// and those of the batches behind it back in line, for a batch on the base. Once `lead` passed, the batches
    /// behind it get `follower_wait` (by default as long as `lead`'s CI took): one still in CI then goes back in line,
    /// and the batches ahead of it land without it.
    async fn ride(&self, repo: &str, base: &str, lead: Stage) {
        let started = self.now_ms();
        let depth = self.options.pipeline_depth.max(1);
        let every = self.options.poll_interval.as_millis() as i64;
        let chain = std::sync::Mutex::new(vec![lead.clone()]);
        let tried = std::sync::Mutex::new(None::<i64>);
        // Between reads of `lead`'s checks, at most once per `poll_interval`: a batch behind it, from the ready PRs.
        let extend = || -> BoxFut<'_, ()> {
            Box::pin(async {
                let now = self.now_ms();
                let ahead = {
                    let chain = lock(&chain);
                    let mut tried = lock(&tried);
                    if chain.len() >= depth || tried.is_some_and(|at| now - at < every) {
                        return;
                    }
                    *tried = Some(now);
                    chain.last().cloned().map(|ahead| (ahead, chain.len()))
                };
                let Some((ahead, k)) = ahead else { return };
                if let Some(next) = self.follower(repo, base, &ahead, k).await {
                    lock(&chain).push(next);
                }
            })
        };
        let lead_failed = self.stage_ci(repo, base, &lead, None, Some(&extend)).await;
        let chain = chain.into_inner().unwrap_or_else(|e| e.into_inner());
        if let Some(failed) = lead_failed {
            let why = format!(
                "batch #{} ahead of it {}; it forms again on {base}",
                lead.pr,
                failed.what()
            );
            for stage in &chain[1..] {
                self.release(stage.own(), &why);
            }
            return self.fail_alone(&lead, &failed).await;
        }
        let wait = self
            .options
            .follower_wait
            .unwrap_or_else(|| Duration::from_millis((self.now_ms() - started).max(0) as u64));
        let until = self.now_ms() + wait.as_millis() as i64;
        let mut landing = 0;
        let mut failed = None;
        for (i, stage) in chain.iter().enumerate().skip(1) {
            match self
                .stage_ci(repo, base, stage, Some((until, wait)), None)
                .await
            {
                None => landing = i,
                Some(f) => {
                    failed = Some((i, f));
                    break;
                }
            }
        }
        let lands = &chain[landing];
        if let Some((at, f)) = &failed {
            let stage = &chain[*at];
            if let Failed::Late(_) = f {
                tracing::info!(
                    repo,
                    pr = stage.pr,
                    ahead = lands.pr,
                    "train: the batch behind is still in CI; the one ahead lands without it"
                );
                let why = format!(
                    "batch #{} was still in CI {} s after batch #{} ahead of it passed, which landed without it; it \
                     forms again on {base}",
                    stage.pr,
                    wait.as_secs(),
                    lands.pr
                );
                self.release(stage.own(), &why);
            }
            let why = format!(
                "batch #{} ahead of it {}; it forms again on {base}",
                stage.pr,
                f.what()
            );
            for behind in &chain[at + 1..] {
                self.release(behind.own(), &why);
            }
        }
        // The furthest passed batch lands; one that can't (a member re-reviewed with findings, pushed to, or a merge
        // refused) gives way to the nearest passed batch ahead of it whose members are all still clean, so a green
        // batch is never lost to the one built on it.
        let mut at = landing;
        let landed = loop {
            let unlanded = match self.land(repo, base, &chain[at]).await {
                Ok(()) => break Ok(at),
                Err(unlanded) => unlanded,
            };
            let ahead = match &unlanded {
                _ if at == 0 => None,
                Unlanded::Members(ids, _) => chain[..at]
                    .iter()
                    .rposition(|st| !st.members.iter().any(|m| ids.contains(&m.change.change_id))),
                Unlanded::Refused(_) | Unlanded::Failed(_) => Some(at - 1),
                Unlanded::Unknown(_) => None,
            };
            match ahead {
                Some(ahead) => {
                    tracing::info!(
                        repo,
                        pr = chain[at].pr,
                        ahead = chain[ahead].pr,
                        why = unlanded.why(),
                        "train: the batch behind can't land; the one ahead lands"
                    );
                    let why = format!(
                        "batch #{} passed CI but couldn't land ({}); batch #{} ahead of it landed without it, and it \
                         forms again on {base}",
                        chain[at].pr,
                        unlanded.why(),
                        chain[ahead].pr
                    );
                    for stage in &chain[ahead + 1..=at] {
                        self.release(stage.own(), &why);
                    }
                    at = ahead;
                }
                None => break Err((at, unlanded)),
            }
        };
        match landed {
            Ok(_) => {
                if let Some((at, f)) = failed
                    && !matches!(f, Failed::Late(_))
                {
                    self.fail_alone(&chain[at], &f).await;
                }
            }
            Err((at, unlanded)) => {
                if let Some((red, _)) = &failed {
                    // Nothing landed ahead of the red batch: its own PRs form again with the rest.
                    self.release(chain[*red].own(), unlanded.why());
                }
                match unlanded {
                    Unlanded::Refused(why) => self.alone(&chain[at].members, &why).await,
                    other => self.release(&chain[at].members, other.why()),
                }
            }
        }
    }

    /// The batch's CI on its head: None once it passed, else how it failed. `late`: when it is given up if still
    /// running, and the wait that was; `between`, what runs between reads.
    async fn stage_ci(
        &self,
        repo: &str,
        base: &str,
        stage: &Stage,
        late: Option<(i64, Duration)>,
        between: Option<&Between<'_>>,
    ) -> Option<Failed> {
        let numbers: Vec<i64> = stage
            .members
            .iter()
            .map(|m| m.change.pr_number.get())
            .collect();
        tracing::info!(
            repo,
            pr = stage.pr,
            sha = stage.sha,
            ?numbers,
            "train: batch in CI"
        );
        let noted: Vec<_> = stage
            .own()
            .iter()
            .map(|m| m.change.change_id.clone())
            .collect();
        let outcome = self
            .watch_ci(
                &stage.own()[0].change,
                repo,
                &stage.sha,
                base,
                None,
                &noted,
                late.map(|(until, _)| until),
                between,
            )
            .await;
        match outcome {
            Some(CiOutcome::Green) => None,
            Some(CiOutcome::Red(_)) => Some(Failed::Ci("red")),
            Some(CiOutcome::Timeout(_)) => Some(Failed::Ci("timed out")),
            // Never for a batch's own head.
            Some(CiOutcome::Moved) => Some(Failed::Ci("superseded")),
            None => Some(Failed::Late(late.map(|(_, wait)| wait).unwrap_or_default())),
        }
    }

    /// A batch whose CI failed: each of its own PRs goes alone.
    async fn fail_alone(&self, stage: &Stage, failed: &Failed) {
        tracing::info!(
            pr = stage.pr,
            sha = stage.sha,
            "train: batch red, each member goes alone"
        );
        let why = format!(
            "batch #{}'s CI {}; each of its PRs goes alone",
            stage.pr,
            failed.ci()
        );
        self.alone(stage.own(), &why).await;
    }

    /// The batch PR `stage`, whose CI passed, to merged: waits for its members' re-reviews, checks each member is
    /// still where the batch took it, posts `fleetd/train` and merges pinned to its head. When it can't, why, with
    /// its members back in `ci` (but those a re-review sent back to review): the caller lands a batch ahead of it or
    /// lets them go.
    async fn land(&self, repo: &str, base: &str, stage: &Stage) -> Result<(), Unlanded> {
        let (pr, sha, title) = (stage.pr, stage.sha.clone(), stage.title.as_str());
        let in_ci = stage.members.clone();
        let numbers: Vec<i64> = in_ci.iter().map(|m| m.change.pr_number.get()).collect();
        // CI passed: the merge also waits for the re-reviews still at work. One with blocking findings, or still at work
        // after `review_wait`, leaves the batch for review, and the others go back in place for a batch without it.
        let pending: Vec<Change> = in_ci
            .iter()
            .filter_map(|m| self.records.get(&m.change.change_id))
            .filter(|c| !reviewed(c))
            .collect();
        if !pending.is_empty() {
            let waits = self.await_reviews(&pending).await;
            let mut dropped = Vec::new();
            let mut ids = Vec::new();
            for (change, wait) in pending.iter().zip(waits) {
                match wait {
                    ReviewWait::Clean(reviews) => {
                        self.add_reviews(change, reviews);
                    }
                    ReviewWait::Blocked => {
                        self.to_review(change, None);
                        ids.push(change.change_id.clone());
                        dropped.push(format!(
                            "#{}'s re-review found blocking findings",
                            change.pr_number
                        ));
                    }
                    ReviewWait::Waiting => {
                        self.to_review(change, Some(&self.review_overdue(change)));
                        ids.push(change.change_id.clone());
                        dropped.push(format!(
                            "#{}'s re-review is still at work",
                            change.pr_number
                        ));
                    }
                }
            }
            if !dropped.is_empty() {
                tracing::info!(
                    repo,
                    pr,
                    ?dropped,
                    "train: a re-review dropped PRs from the batch"
                );
                let why = format!(
                    "batch #{pr} passed CI, but {}; the batch forms again without it",
                    dropped.join(" and ")
                );
                return Err(Unlanded::Members(ids, why));
            }
        }

        // A member pushed to, held or closed while CI ran is not what was tested: the batch goes, and the next pass
        // builds one without it.
        let mut moved = Vec::new();
        let mut why = None;
        for m in &in_ci {
            match self.github.pull(repo, m.change.pr_number.get()).await {
                Ok(p)
                    if p.state == "open"
                        && !p.merged
                        && !p.held()
                        && p.head.sha.to_lowercase() == m.change.head_sha.as_str() => {}
                Ok(_) => {
                    moved.push(m.change.change_id.clone());
                    why.get_or_insert_with(|| {
                        format!(
                            "#{} was pushed to, held or closed while batch #{pr} was in CI",
                            m.change.pr_number
                        )
                    });
                }
                Err(e) => {
                    moved.push(m.change.change_id.clone());
                    why.get_or_insert_with(|| format!("GitHub: {}", e.message));
                }
            }
        }
        if let Some(why) = why {
            return Err(Unlanded::Members(moved, why));
        }
        let merging = self.advance(&in_ci, ChangeState::Ci, ChangeState::Merging);
        // Back in `ci` for whatever lands instead.
        let back = |unlanded: Unlanded| {
            self.advance(&merging, ChangeState::Merging, ChangeState::Ci);
            Err(unlanded)
        };
        if merging.len() != in_ci.len() {
            return back(Unlanded::Failed(MEMBER_LEFT.to_string()));
        }
        let description = format!("batch of {}: merged onto {base}, CI green", merging.len());
        if let Err(e) = self
            .github
            .post_train_status(repo, &sha, &description)
            .await
        {
            return back(Unlanded::Failed(format!("GitHub: {}", e.message)));
        }
        let commit_title = format!("{title} (#{pr})");
        let commit_body = with_trailers(&member_lines(&merging), merging.iter().map(|m| &m.change));
        match self
            .github
            .merge(repo, pr, &sha, Some((&commit_title, &commit_body)))
            .await
        {
            Ok(MergeOutcome::Merged { sha: merged_sha }) => {
                let batch_url = format!("https://github.com/{repo}/pull/{pr}");
                self.watch_merge(repo, base, &merged_sha, &batch_url);
                let landed = Landed {
                    pr_number: pr,
                    merged_sha,
                    members: numbers,
                };
                for m in &merging {
                    self.finish_batch_member(&m.change, &landed).await;
                }
                Ok(())
            }
            Ok(MergeOutcome::Refused { status, message }) => {
                tracing::info!(
                    repo,
                    pr,
                    status,
                    message,
                    "train: batch refused, each member goes alone"
                );
                back(Unlanded::Refused(format!(
                    "GitHub refused batch #{pr} (HTTP {status}): {message}; each of its PRs goes alone"
                )))
            }
            // GitHub may have merged it all the same: the next pass's reconcile finishes the members if it did. Nothing
            // else lands meanwhile.
            Err(e) => back(Unlanded::Unknown(format!("GitHub: {}", e.message))),
        }
    }

    /// Merged in `landed`: recorded as merged with the batch's squash, and its own PR closed with a link to it.
    /// Its PR is read first: one pushed to since its head was batched did not land as it is now, so it goes back to
    /// ready for its new head instead (read again later when GitHub can't be read now).
    pub(super) async fn finish_batch_member(&self, change: &Change, landed: &Landed) {
        let pull = match self.github.pull(&change.repo, change.pr_number.get()).await {
            Ok(pull) => pull,
            Err(e) => {
                return tracing::warn!(change_id = %change.change_id, error = %e.message, "train: batch member not read; the next pass finishes it");
            }
        };
        if pull.head.sha.to_lowercase() != change.head_sha.as_str() {
            let why = format!(
                "pushed to while batch #{} merged: the batch landed its head {}, not the new one, which goes \
                 through the train",
                landed.pr_number,
                short(change.head_sha.as_str())
            );
            let from = [
                ChangeState::Ready,
                ChangeState::Rebasing,
                ChangeState::Ci,
                ChangeState::Merging,
            ];
            self.update(&change.change_id, Some(&from), |mut c| {
                c.state = ChangeState::Ready;
                c.last_error = Some(error_text(&why));
                c
            });
            return;
        }
        self.finish_merged(change, Some(&landed.merged_sha), Some(landed))
            .await;
        if pull.state == "open" {
            self.close_member(change, landed).await;
        }
    }

    /// Closes a landed member's PR with a link to its batch; a failure stays on the Change for reconcile to retry.
    async fn close_member(&self, change: &Change, landed: &Landed) {
        let others: Vec<String> = landed
            .members
            .iter()
            .filter(|n| **n != change.pr_number.get())
            .map(|n| format!("#{n}"))
            .collect();
        let comment = format!(
            "Landed in #{} ({}) by the fleetd merge train: merged together with {} after one CI run on the batch.",
            landed.pr_number,
            short(&landed.merged_sha),
            others.join(", ")
        );
        let closed = self
            .github
            .close(&change.repo, change.pr_number.get(), &comment)
            .await;
        self.update(&change.change_id, Some(&[ChangeState::Merged]), |mut c| {
            c.last_error = closed
                .as_ref()
                .err()
                .map(|e| error_text(&format!("{NOT_CLOSED}: GitHub: {}", e.message)));
            c
        });
    }

    /// Each pass: the members of merged batch PRs that are not finished, because the hub restarted or a merge call
    /// failed after GitHub merged, are finished now, and a member PR the train could not close is closed; each only at
    /// the head the batch recorded for it.
    pub(super) async fn reconcile_batches(&self, repo: &str) {
        let Some(prefix) = self.scratch_prefix(repo).await else {
            return;
        };
        let mut pulls = Vec::new();
        for name in batch_names(self.options.pipeline_depth) {
            match self
                .github
                .pulls_for(repo, &format!("{prefix}{name}"), "closed")
                .await
            {
                Ok(found) => pulls.extend(found),
                Err(_) => return,
            }
        }
        for p in pulls.into_iter().filter(|p| p.merged_at.is_some()) {
            let heads = batch_heads(p.body.as_deref().unwrap_or_default());
            let landed = Landed {
                pr_number: p.number,
                merged_sha: p.merge_commit_sha.clone().unwrap_or_default(),
                members: heads.iter().map(|(n, _)| *n).collect(),
            };
            for (n, sha) in &heads {
                let Some(change) = self.records.latest_for(repo, *n) else {
                    continue;
                };
                if sha.as_deref() != Some(change.head_sha.as_str()) {
                    continue;
                }
                match change.state {
                    ChangeState::Merged
                        if change
                            .last_error
                            .as_deref()
                            .is_some_and(|e| e.starts_with(NOT_CLOSED)) =>
                    {
                        self.close_member(&change, &landed).await;
                    }
                    ChangeState::Ready
                    | ChangeState::Rebasing
                    | ChangeState::Ci
                    | ChangeState::Merging => self.finish_batch_member(&change, &landed).await,
                    _ => {}
                }
            }
        }
    }

    /// After a restart, the batch whose members are all in `ci`, each at the head the open batch PR names, goes on
    /// being watched where it is: true when it was (merged, red or released). False when there is none.
    pub(super) async fn resume_batch(&self, repo: &str, in_ci: &[Change]) -> bool {
        let Some(first) = in_ci.first() else {
            return false;
        };
        let Some(branch) = self.scratch_branch(first, "batch").await else {
            return false;
        };
        let Ok(pulls) = self.github.pulls_for(repo, &branch, "open").await else {
            return false;
        };
        let Some(batch) = pulls.into_iter().next() else {
            return false;
        };
        let heads = batch_heads(batch.body.as_deref().unwrap_or_default());
        let built_from = |c: &Change| {
            heads.iter().any(|(n, sha)| {
                *n == c.pr_number.get() && sha.as_deref() == Some(c.head_sha.as_str())
            })
        };
        if heads.len() != in_ci.len() || !in_ci.iter().all(built_from) {
            return false;
        }
        let mut members = Vec::new();
        for n in heads.iter().map(|(n, _)| *n) {
            let Some(change) = in_ci.iter().find(|c| c.pr_number.get() == n) else {
                return false;
            };
            match self.github.pull(repo, n).await {
                Ok(pull) => members.push(Candidate {
                    change: change.clone(),
                    pull,
                }),
                Err(_) => return false,
            }
        }
        tracing::info!(
            repo,
            pr = batch.number,
            "train: the hub restarted; watching the batch's CI again"
        );
        let added = members.len();
        let lead = Stage {
            pr: batch.number,
            sha: batch.head.sha.to_lowercase(),
            title: batch.title.clone(),
            members,
            added,
        };
        self.ride(repo, &batch.base.ref_, lead).await;
        true
    }

    /// The merged batch PR that names this Change's PR, for a hub that restarted while merging it.
    pub(super) async fn landed_in_batch(&self, change: &Change) -> Option<Landed> {
        let mut pulls = Vec::new();
        for name in batch_names(self.options.pipeline_depth) {
            let branch = self.scratch_branch(change, &name).await?;
            pulls.extend(
                self.github
                    .pulls_for(&change.repo, &branch, "closed")
                    .await
                    .ok()?,
            );
        }
        // Only at the head it has now: a batch built from an earlier head did not land this one.
        pulls.into_iter().find_map(|p| {
            let heads = batch_heads(p.body.as_deref().unwrap_or_default());
            let built_at_head = heads.iter().any(|(n, sha)| {
                *n == change.pr_number.get() && sha.as_deref() == Some(change.head_sha.as_str())
            });
            (p.merged_at.is_some() && built_at_head).then(|| Landed {
                pr_number: p.number,
                merged_sha: p.merge_commit_sha.clone().unwrap_or_default(),
                members: heads.into_iter().map(|(n, _)| n).collect(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_batch_marker_lists_every_member_with_its_head() {
        let body = "intro\n\nfleetd-batch: #12@AbC #13@def #20\n";
        assert_eq!(
            batch_heads(body),
            [
                (12, Some("abc".into())),
                (13, Some("def".into())),
                (20, None)
            ]
        );
        assert!(batch_heads("no marker").is_empty());
    }
}
