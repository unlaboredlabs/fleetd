//! Batches: up to `batch_max` disjoint ready Changes, each reviewed for its current patch and green on its own head,
//! squashed onto the base in queue order on the train's scratch branch and tested by one CI run on one PR. Green, the
//! train posts `fleetd/train` on that head and squash-merges the batch PR pinned to it; each member is then closed
//! with a link. Red drops the last member and tries again (bisecting), and the dropped one goes alone next. Fewer
//! than two left is the one-at-a-time path, unchanged. No gate is skipped: every member is ready, the batch's CI must
//! pass, and GitHub's rules on the base decide the merge as they would for one PR.
use std::collections::{HashMap, HashSet};

use super::contract::{Change, ChangeId, ChangeState};
use super::git::BatchMember;
use super::github::{BATCH_MARKER, MergeOutcome, Pull, batch_heads};
use super::service::{Checks, CiOutcome, Train, checks, error_text, lock, short};

/// Files every dependency bump touches. Two members both changing one still batch; a real clash shows as the second
/// not applying on top of the first, which leaves it out.
const LOCKFILES: [&str; 10] = [
    "Cargo.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "Gemfile.lock",
    "poetry.lock",
    "uv.lock",
    "composer.lock",
    "go.sum",
];

fn is_lockfile(path: &str) -> bool {
    LOCKFILES.contains(&path.rsplit('/').next().unwrap_or(path))
}

const HELD: &str = "held: the PR has the `hold` label; the train takes it once the label is gone";
pub(super) const NO_CI: &str = "held: this repo has no CI, and fleetd merges only on green CI. Add a GitHub Actions \
     workflow that runs on pull requests; it goes on by itself once one exists.";

/// A clean review is bound to the Change's current patch: nothing else lets the train take it.
fn reviewed(change: &Change) -> bool {
    change.patch_id.as_ref().is_some_and(|patch| {
        change
            .reviews
            .iter()
            .any(|r| r.blocking.get() == 0 && &r.patch_id == patch)
    })
}

/// The train's memory for batches. Lost on a restart, which only costs a rebuild.
#[derive(Default)]
pub struct Lanes {
    /// Dropped from a red batch: each goes alone next, so no second batch turns red for its sake.
    pub(super) suspects: HashSet<ChangeId>,
    /// Repos GitHub would not merge a batch PR for, and why: they go one at a time until the hub restarts.
    pub(super) off: HashMap<String, String>,
    /// Batch members whose PR is known closed, so reconcile reads them no more.
    pub(super) closed: HashSet<ChangeId>,
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

enum Round {
    Merged,
    /// Go again with these, in order; fewer than two is the first one alone.
    Again(Vec<Candidate>),
    /// GitHub refused the merge; go again with these, unless it has refused too often.
    Refused(Vec<Candidate>, String),
    /// Something failed that the members carry as their last error; the next pass starts over.
    Stop,
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

fn batch_body(base: &str, members: &[Candidate]) -> String {
    // Each member's head as built: a member counts as landed only while its PR is still at that head.
    let numbers: Vec<String> = members
        .iter()
        .map(|m| format!("#{}@{}", m.change.pr_number, m.change.head_sha))
        .collect();
    format!(
        "The fleetd merge train's batch: these ready PRs, each reviewed at its current patch and green on its own, \
         squashed onto {base} in queue order and tested by this PR's one CI run. Once this merges, each is closed \
         with a link here. Red CI drops the last one and tries again.\n\n{}\n\n{BATCH_MARKER} {}\n",
        member_lines(members),
        numbers.join(" ")
    )
}

impl Train {
    /// `<prefix>train/<name>`: a scratch branch in the namespace of the project that owns the repo's train; None
    /// while its policy can't be read, since guessing could write outside its namespace.
    pub(super) async fn scratch_branch(&self, change: &Change, name: &str) -> Option<String> {
        let owner = self.train_project(&change.repo, &change.project_ref);
        let prefix = self.host.branch_prefix(&owner).await?;
        Some(format!("{prefix}train/{name}"))
    }

    /// `<prefix>train/` of the project that owns the repo's train.
    pub(super) async fn scratch_prefix(&self, repo: &str) -> Option<String> {
        let owner = self.records.train(repo)?.project_ref;
        let owner = self.train_project(repo, &owner);
        let prefix = self.host.branch_prefix(&owner).await?;
        Some(format!("{prefix}train/"))
    }

    /// After refresh and the freeze: a batch of disjoint ready Changes, or the first takeable one alone. True when
    /// it took or settled one.
    pub(super) async fn next(&self, repo: &str) -> bool {
        let ready = self.records.in_train(repo, &[ChangeState::Ready]);
        let (candidates, settled) = self.candidates(repo, ready).await;
        let Some(head) = candidates.first() else {
            return settled;
        };
        // A batch goes into the first one's base, and only PRs into that same base join it.
        let base = head.pull.base.ref_.clone();
        match self.pick_batch(repo, &base, &candidates).await {
            Some(members) => self.take_batch(repo, &base, members).await,
            None => self.take(&head.change).await,
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
                    let why = error_text(&format!("GitHub: {}", e.message));
                    self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
                        c.last_error = Some(why);
                        c
                    });
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
            if pull.head.sha.to_lowercase() != change.head_sha.as_str() {
                if let Err(e) = self.ready_moved(&change, &pull).await {
                    let why = self.git_failed(&change, &e.0);
                    self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
                        c.last_error = Some(why);
                        c
                    });
                }
                settled = true;
                continue;
            }
            if !reviewed(&change) {
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
            let hold = if pull.held() {
                Some(HELD)
            } else {
                // A read that failed is not "no CI": the head's checks decide, as for any repo.
                let no_ci = matches!(self.has_ci(repo, &pull.base.ref_).await, Ok(false));
                self.no_ci(repo, no_ci);
                no_ci.then_some(NO_CI)
            };
            let shown = change.last_error.as_deref();
            if hold != shown && (hold.is_some() || shown == Some(HELD) || shown == Some(NO_CI)) {
                self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
                    c.last_error = hold.map(error_text);
                    c
                });
            }
            if hold.is_some() {
                continue;
            }
            out.push(Candidate { change, pull });
        }
        (out, settled)
    }

    fn batchable(&self, base: &str, candidate: &Candidate) -> bool {
        candidate.pull.base.ref_ == base
            && candidate.change.patch_id.is_some()
            && !lock(&self.lanes)
                .suspects
                .contains(&candidate.change.change_id)
    }

    /// Green on its own head: every check done and none red.
    async fn own_ci_green(&self, repo: &str, change: &Change) -> bool {
        match self.github.check_runs(repo, change.head_sha.as_str()).await {
            Ok(runs) => matches!(checks(&runs), Checks::Green),
            Err(_) => false,
        }
    }

    /// The first candidate and the ones after it, in order, whose files (lockfiles aside) touch none of the ones
    /// already in; None when that is fewer than two, batching is off, or the first can't lead a batch.
    async fn pick_batch(
        &self,
        repo: &str,
        base: &str,
        candidates: &[Candidate],
    ) -> Option<Vec<Candidate>> {
        let max = self.options.batch_max;
        if max < 2 || candidates.len() < 2 || lock(&self.lanes).off.contains_key(repo) {
            return None;
        }
        let head = &candidates[0];
        if !self.batchable(base, head) || !self.own_ci_green(repo, &head.change).await {
            return None;
        }
        let (git, git_lock) = self.git_for(&head.change).ok()?;
        let _held = git_lock.lock().await;
        let files = |paths: Vec<String>| -> HashSet<String> {
            paths.into_iter().filter(|p| !is_lockfile(p)).collect()
        };
        let mut taken = files(git.files(base, &head.change.branch).await.ok()?);
        let mut members = vec![head.clone()];
        for c in &candidates[1..] {
            if members.len() >= max {
                break;
            }
            if !self.batchable(base, c) {
                continue;
            }
            let Ok(paths) = git.files(base, &c.change.branch).await else {
                continue;
            };
            let paths = files(paths);
            if !paths.is_disjoint(&taken) || !self.own_ci_green(repo, &c.change).await {
                continue;
            }
            taken.extend(paths);
            members.push(c.clone());
        }
        (members.len() >= 2).then_some(members)
    }

    async fn take_batch(&self, repo: &str, base: &str, mut members: Vec<Candidate>) {
        let mut refusals = 0;
        let mut open_pr: Option<i64> = None;
        loop {
            if members.len() < 2 {
                if let Some(n) = open_pr {
                    self.dissolve(repo, n).await;
                }
                let first = members
                    .first()
                    .and_then(|m| self.records.get(&m.change.change_id))
                    .filter(|c| c.state == ChangeState::Ready);
                if let Some(first) = first {
                    self.take(&first).await;
                }
                return;
            }
            match self.batch_round(repo, base, &members, &mut open_pr).await {
                Round::Merged => return,
                Round::Stop => {
                    if let Some(n) = open_pr {
                        self.dissolve(repo, n).await;
                    }
                    return;
                }
                Round::Again(next) => members = next,
                Round::Refused(next, why) => {
                    refusals += 1;
                    if refusals >= self.options.merge_attempts {
                        tracing::warn!(repo, why, "train: batching off for this repo");
                        lock(&self.lanes).off.insert(repo.to_string(), why);
                        if let Some(n) = open_pr {
                            self.dissolve(repo, n).await;
                        }
                        return;
                    }
                    members = next;
                }
            }
        }
    }

    /// Back to ready in place (their queue order never changed), with `why` as their last error when given.
    /// Deletes the train's scratch branches: no batch is in flight between passes, so any left is a leftover (a
    /// restart, a failed delete). GitHub closes a PR whose head branch goes.
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

    fn release(&self, members: &[Candidate], why: Option<&str>) {
        let from = [ChangeState::Rebasing, ChangeState::Ci, ChangeState::Merging];
        for m in members {
            self.update(&m.change.change_id, Some(&from), |mut c| {
                c.state = ChangeState::Ready;
                if let Some(why) = why {
                    c.last_error = Some(error_text(why));
                }
                c
            });
        }
    }

    /// Moves each member from one of `from` to `to`; the ones that were not in it any more are left out.
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

    async fn dissolve(&self, repo: &str, pr: i64) {
        let comment = "Dissolved: fewer than two members are left, so they go through the train one at a time.";
        if let Err(e) = self.github.close(repo, pr, comment).await {
            tracing::warn!(repo, pr, error = %e.message, "train: batch PR not closed");
        }
    }

    async fn batch_round(
        &self,
        repo: &str,
        base: &str,
        members: &[Candidate],
        open_pr: &mut Option<i64>,
    ) -> Round {
        let rebasing = self.advance(members, ChangeState::Ready, ChangeState::Rebasing);
        if rebasing.first().map(|m| &m.change.change_id) != Some(&members[0].change.change_id) {
            self.release(&rebasing, None);
            return Round::Again(Vec::new());
        }
        let first = rebasing[0].change.clone();
        let Some(branch) = self.scratch_branch(&first, "batch").await else {
            self.release(&rebasing, None);
            return Round::Again(vec![rebasing[0].clone()]);
        };
        let (git, git_lock) = match self.git_for(&first) {
            Ok(git) => git,
            Err(e) => {
                let why = self.git_failed(&first, &e.0);
                self.release(&rebasing, Some(why.as_str()));
                return Round::Stop;
            }
        };
        let specs: Vec<BatchMember> = rebasing
            .iter()
            .map(|m| BatchMember {
                branch: m.change.branch.to_string(),
                head_sha: m.change.head_sha.to_string(),
                title: m.pull.title.trim().to_string(),
                pr_number: m.change.pr_number.get(),
                patch_id: m.change.patch_id.as_deref().unwrap_or_default().to_string(),
            })
            .collect();
        let built = {
            let _held = git_lock.lock().await;
            match git.build_batch(base, &specs).await {
                Ok(build) if build.kept.first() == Some(&0) && build.kept.len() >= 2 => {
                    git.push_scratch(&branch).await.map(|()| build)
                }
                other => other,
            }
        };
        let build = match built {
            Ok(build) => build,
            Err(e) => {
                let why = self.git_failed(&first, &e.0);
                self.release(&rebasing, Some(why.as_str()));
                return Round::Stop;
            }
        };
        for (i, why) in &build.dropped {
            tracing::info!(repo, change_id = %rebasing[*i].change.change_id, why, "train: left out of the batch");
        }
        // A first member that doesn't build goes alone, so the one-at-a-time path says what is wrong with it.
        if build.kept.first() != Some(&0) || build.kept.len() < 2 {
            self.release(&rebasing, None);
            return Round::Again(vec![rebasing[0].clone()]);
        }
        let dropped: Vec<Candidate> = build
            .dropped
            .iter()
            .map(|(i, _)| rebasing[*i].clone())
            .collect();
        self.release(&dropped, None);
        let kept: Vec<Candidate> = build.kept.iter().map(|i| rebasing[*i].clone()).collect();
        let sha = build.head_sha.to_string();
        let title = batch_title(&kept);
        let pr = match self
            .github
            .open_pull(repo, &branch, base, &title, &batch_body(base, &kept), false)
            .await
        {
            Ok(pr) => pr,
            Err(e) => {
                self.release(&kept, Some(&format!("GitHub: {}", e.message)));
                return Round::Stop;
            }
        };
        *open_pr = Some(pr);
        let in_ci = self.advance(&kept, ChangeState::Rebasing, ChangeState::Ci);
        if in_ci.len() != kept.len() {
            self.release(&kept, None);
            return Round::Again(in_ci);
        }
        let numbers: Vec<i64> = in_ci.iter().map(|m| m.change.pr_number.get()).collect();
        tracing::info!(repo, pr, sha, ?numbers, "train: batch in CI");
        lock(&self.pushed).insert(
            in_ci[0].change.change_id.clone(),
            (sha.clone(), self.now_ms()),
        );
        match self.wait_ci(&in_ci[0].change, repo, &sha).await {
            CiOutcome::Green => {}
            CiOutcome::Red(_) => {
                // Bisect: the last one in goes alone next; the rest try again without it.
                let last = in_ci[in_ci.len() - 1].change.change_id.clone();
                tracing::info!(repo, pr, sha, change_id = %last, "train: batch red, dropping its last member");
                lock(&self.lanes).suspects.insert(last);
                self.release(&in_ci, None);
                return Round::Again(in_ci[..in_ci.len() - 1].to_vec());
            }
            CiOutcome::Timeout => {
                // A timeout blames no member, and halving would wait it out again per round: each goes alone.
                tracing::info!(
                    repo,
                    pr,
                    sha,
                    "train: batch CI timed out, its members go one at a time"
                );
                lock(&self.lanes)
                    .suspects
                    .extend(in_ci.iter().map(|m| m.change.change_id.clone()));
                self.release(&in_ci, None);
                return Round::Again(vec![in_ci[0].clone()]);
            }
        };

        // A member pushed to, held or closed while CI ran is not what was tested: it leaves, and the rest go again.
        let mut still = Vec::new();
        for m in &in_ci {
            match self.github.pull(repo, m.change.pr_number.get()).await {
                Ok(p)
                    if p.state == "open"
                        && !p.merged
                        && !p.held()
                        && p.head.sha.to_lowercase() == m.change.head_sha.as_str() =>
                {
                    still.push(Candidate {
                        change: m.change.clone(),
                        pull: p,
                    });
                }
                Ok(_) => {}
                Err(e) => {
                    self.release(&in_ci, Some(&format!("GitHub: {}", e.message)));
                    return Round::Stop;
                }
            }
        }
        if still.len() != in_ci.len() {
            self.release(&in_ci, None);
            return Round::Again(still);
        }
        let merging = self.advance(&still, ChangeState::Ci, ChangeState::Merging);
        if merging.len() != still.len() {
            self.release(&still, None);
            return Round::Again(merging);
        }
        let description = format!("batch of {}: rebased onto {base}, CI green", merging.len());
        if let Err(e) = self
            .github
            .post_train_status(repo, &sha, &description)
            .await
        {
            self.release(&merging, Some(&format!("GitHub: {}", e.message)));
            return Round::Stop;
        }
        let commit_title = format!("{title} (#{pr})");
        let commit_body = member_lines(&merging);
        match self
            .github
            .merge(repo, pr, &sha, Some((&commit_title, &commit_body)))
            .await
        {
            Ok(MergeOutcome::Merged { sha: merged_sha }) => {
                let landed = Landed {
                    pr_number: pr,
                    merged_sha,
                    members: numbers,
                };
                for m in &merging {
                    self.finish_batch_member(&m.change, &landed).await;
                }
                *open_pr = None;
                if let Err(e) = self.github.delete_branch(repo, &branch).await {
                    tracing::warn!(repo, branch, error = %e.message, "train: batch branch not deleted");
                }
                Round::Merged
            }
            Ok(MergeOutcome::Refused { status, message }) => {
                let why = format!("GitHub refused to merge batch #{pr} (HTTP {status}): {message}");
                self.release(&merging, Some(&why));
                Round::Refused(merging, why)
            }
            Err(e) => {
                // GitHub may have merged it all the same: the PR stays as it is, and the next pass's reconcile
                // finishes the members if it did.
                *open_pr = None;
                self.release(&merging, Some(&format!("GitHub: {}", e.message)));
                Round::Stop
            }
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

    /// Closes a landed member's PR with a link to its batch; a failure is retried by the next pass's reconcile.
    async fn close_member(&self, change: &Change, landed: &Landed) {
        let others: Vec<String> = landed
            .members
            .iter()
            .filter(|n| **n != change.pr_number.get())
            .map(|n| format!("#{n}"))
            .collect();
        let comment = format!(
            "Landed in #{} ({}) by the fleetd merge train: squashed together with {} and merged after one CI run \
             on the batch.",
            landed.pr_number,
            short(&landed.merged_sha),
            others.join(", ")
        );
        match self
            .github
            .close(&change.repo, change.pr_number.get(), &comment)
            .await
        {
            Ok(()) => {
                lock(&self.lanes).closed.insert(change.change_id.clone());
            }
            Err(e) => {
                tracing::warn!(change_id = %change.change_id, error = %e.message, "train: batch member not closed")
            }
        }
    }

    /// Each pass: the members of merged batch PRs that are not finished, because the hub restarted, a merge call
    /// failed after GitHub merged, or closing the PR failed, are finished now; each only at the head the batch
    /// recorded for it.
    pub(super) async fn reconcile_batches(&self, repo: &str) {
        let Some(prefix) = self.scratch_prefix(repo).await else {
            return;
        };
        let Ok(pulls) = self
            .github
            .pulls_for(repo, &format!("{prefix}batch"), "closed")
            .await
        else {
            return;
        };
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
                if sha.as_deref() != Some(change.head_sha.as_str())
                    || lock(&self.lanes).closed.contains(&change.change_id)
                {
                    continue;
                }
                match change.state {
                    ChangeState::Merged => {
                        let open = self
                            .github
                            .pull(repo, *n)
                            .await
                            .is_ok_and(|pull| pull.state == "open");
                        if !open {
                            lock(&self.lanes).closed.insert(change.change_id.clone());
                            continue;
                        }
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

    /// The merged batch PR that names this Change's PR, for a hub that restarted while merging it.
    pub(super) async fn landed_in_batch(&self, change: &Change) -> Option<Landed> {
        let branch = self.scratch_branch(change, "batch").await?;
        let pulls = self
            .github
            .pulls_for(&change.repo, &branch, "closed")
            .await
            .ok()?;
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
    fn lockfiles_anywhere_in_the_tree_do_not_count_as_overlap() {
        assert!(is_lockfile("Cargo.lock"));
        assert!(is_lockfile("app/desktop/pnpm-lock.yaml"));
        assert!(!is_lockfile("src/Cargo.lock.rs"));
    }

    #[test]
    fn the_batch_marker_lists_every_member_with_its_head() {
        let body = "intro\n\nfleetd-batch: #12@AbC #13@def #20\n";
        assert_eq!(super::super::github::batch_members(body), [12, 13, 20]);
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
