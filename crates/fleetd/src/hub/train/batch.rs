//! Batches: two or more ready Changes into one base, each reviewed for its current patch and green on its own head,
//! up to `BATCH_MAX` of them in queue order, merged together after one CI run. The train builds the batch on GitHub: its
//! scratch branch at the base, each member's head merged into it in order, and one PR for it. A member that conflicts
//! is left out and goes back to its writer. Green, the train posts `fleetd/train` on that head and squash-merges the
//! batch PR pinned to it; each member is then closed with a link. Red, timed out or refused, every member goes alone.
//! No gate is skipped: every member is ready, the batch's CI must pass, and GitHub's rules on the base decide the merge
//! as they would for one PR. The next pass's sweep deletes the scratch branch, which closes a batch PR left open.
use super::contract::{Change, ChangeState};
use super::github::{BATCH_MARKER, BranchMerge, MergeOutcome, Pull, batch_heads};
use super::service::{Checks, CiOutcome, Train, checks, error_text, lock, short};

const BATCH_MAX: usize = 8;

const HELD: &str = "held: the PR has the `hold` label; the train takes it once the label is gone";
pub(super) const NO_CI: &str = "held: this repo has no CI, and fleetd merges only on green CI. Add a GitHub Actions \
     workflow that runs on pull requests; it goes on by itself once one exists.";
/// Why a batch's members went back to ready when one of them was no longer where the batch left it.
const MEMBER_LEFT: &str = "a PR left the batch while it formed; the next pass forms it again";
/// The last error of a merged member whose PR the train could not close; the next pass's reconcile closes it.
const NOT_CLOSED: &str = "landed, but its PR is not closed yet";

/// A clean review is bound to the Change's current patch: nothing else lets the train take it.
fn reviewed(change: &Change) -> bool {
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

/// A squash message's body with the trailers last, where git reads them.
pub(super) fn with_trailers<'a>(
    body: &str,
    changes: impl IntoIterator<Item = &'a Change>,
) -> String {
    let trailers: Vec<String> = changes.into_iter().map(change_trailer).collect();
    match body.replace("\r\n", "\n").trim() {
        "" => trailers.join("\n"),
        body => format!("{body}\n\n{}", trailers.join("\n")),
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

    /// After refresh and the freeze: a batch of the ready Changes into the first one's base that are green on their
    /// own heads, or the first one alone. True when it took or settled one.
    pub(super) async fn next(&self, repo: &str) -> bool {
        let ready = self.records.in_train(repo, &[ChangeState::Ready]);
        let (candidates, settled) = self.candidates(repo, ready).await;
        let Some(head) = candidates.first() else {
            return settled;
        };
        let base = head.pull.base.ref_.clone();
        let mut members = Vec::new();
        if candidates.len() >= 2 {
            for c in &candidates {
                if members.len() == BATCH_MAX {
                    break;
                }
                if c.pull.base.ref_ == base && self.own_ci_green(repo, &c.change).await {
                    members.push(c.clone());
                }
            }
        }
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
            if pull.head.sha.to_lowercase() != change.head_sha.as_str() {
                if let Err(e) = self.ready_moved(&change, &pull).await {
                    self.ready_error(&change, &e.message);
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
                matches!(self.has_ci(repo, &pull.base.ref_).await, Ok(false)).then_some(NO_CI)
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

    fn ready_error(&self, change: &Change, message: &str) {
        let why = error_text(&format!("GitHub: {message}"));
        self.update(&change.change_id, Some(&[ChangeState::Ready]), |mut c| {
            c.last_error = Some(why);
            c
        });
    }

    /// Green on its own head: every check done and none red.
    async fn own_ci_green(&self, repo: &str, change: &Change) -> bool {
        match self.github.check_runs(repo, change.head_sha.as_str()).await {
            Ok(runs) => matches!(checks(&runs), Checks::Green),
            Err(_) => false,
        }
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

    /// Back to ready in place (their queue order never changed), with `why` as their last error.
    fn release(&self, members: &[Candidate], why: &str) {
        let from = [ChangeState::Rebasing, ChangeState::Ci, ChangeState::Merging];
        for m in members {
            self.update(&m.change.change_id, Some(&from), |mut c| {
                c.state = ChangeState::Ready;
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
                .filter(|c| c.state == ChangeState::Ready);
            if let Some(ready) = ready {
                self.take(&ready).await;
                if self
                    .records
                    .get(&m.change.change_id)
                    .is_some_and(|c| c.state == ChangeState::Ready)
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
                BranchMerge::Conflict => {
                    let why = format!("conflicts with {base} and the PRs ahead of it in the train");
                    self.needs_rebase(&m.change, &why).await;
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
        let building = self.advance(&members, ChangeState::Ready, ChangeState::Rebasing);
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
        let in_ci = self.advance(&kept, ChangeState::Rebasing, ChangeState::Ci);
        if in_ci.len() != kept.len() {
            return self.release(&kept, MEMBER_LEFT);
        }
        let numbers: Vec<i64> = in_ci.iter().map(|m| m.change.pr_number.get()).collect();
        tracing::info!(repo, pr, sha, ?numbers, "train: batch in CI");
        lock(&self.pushed).insert(
            in_ci[0].change.change_id.clone(),
            (sha.clone(), self.now_ms()),
        );
        let red = match self.wait_ci(&in_ci[0].change, repo, &sha).await {
            CiOutcome::Green => None,
            CiOutcome::Red(_) => Some("red"),
            CiOutcome::Timeout => Some("timed out"),
        };
        if let Some(red) = red {
            tracing::info!(repo, pr, sha, "train: batch red, each member goes alone");
            let why = format!("batch #{pr}'s CI {red}; each of its PRs goes alone");
            return self.alone(&in_ci, &why).await;
        }

        // A member pushed to, held or closed while CI ran is not what was tested: the batch goes, and the next pass
        // builds one without it.
        for m in &in_ci {
            match self.github.pull(repo, m.change.pr_number.get()).await {
                Ok(p)
                    if p.state == "open"
                        && !p.merged
                        && !p.held()
                        && p.head.sha.to_lowercase() == m.change.head_sha.as_str() => {}
                Ok(_) => {
                    let why = format!(
                        "#{} was pushed to, held or closed while batch #{pr} was in CI",
                        m.change.pr_number
                    );
                    return self.release(&in_ci, &why);
                }
                Err(e) => return self.release(&in_ci, &format!("GitHub: {}", e.message)),
            }
        }
        let merging = self.advance(&in_ci, ChangeState::Ci, ChangeState::Merging);
        if merging.len() != in_ci.len() {
            return self.release(&in_ci, MEMBER_LEFT);
        }
        let description = format!("batch of {}: merged onto {base}, CI green", merging.len());
        if let Err(e) = self
            .github
            .post_train_status(repo, &sha, &description)
            .await
        {
            return self.release(&merging, &format!("GitHub: {}", e.message));
        }
        let commit_title = format!("{title} (#{pr})");
        let commit_body = with_trailers(&member_lines(&merging), merging.iter().map(|m| &m.change));
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
            }
            Ok(MergeOutcome::Refused { status, message }) => {
                tracing::info!(
                    repo,
                    pr,
                    status,
                    message,
                    "train: batch refused, each member goes alone"
                );
                let why = format!(
                    "GitHub refused batch #{pr} (HTTP {status}): {message}; each of its PRs goes alone"
                );
                self.alone(&merging, &why).await;
            }
            // GitHub may have merged it all the same: the next pass's reconcile finishes the members if it did.
            Err(e) => self.release(&merging, &format!("GitHub: {}", e.message)),
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
