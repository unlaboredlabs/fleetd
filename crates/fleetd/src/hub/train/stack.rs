//! Stacks: a PR whose base is the branch of another open Change waits for that parent to land, and meanwhile is
//! tested ahead: rebased onto the base with its parent under it, on a scratch branch in the project's namespace
//! (`<prefix>train/stack-<n>`), as a draft PR whose CI says how it fares. The result shows on the PR as the
//! `fleetd/stack` status, which nothing requires; red also goes to its author. When the parent lands, the PR is
//! retargeted to the base and goes through the train like any other, CI again on its rebased head, since the base's
//! rules want an up-to-date branch. The speculative build is then closed.
use std::collections::HashSet;

use super::contract::{Change, ChangeId, ChangeState};
use super::git::Rebase;
use super::github::Pull;
use super::records::TERMINAL_STATES;
use super::service::{Checks, Train, checks, lock, short};

/// A PR stacked on a queued one.
#[derive(Clone, Debug)]
pub struct Stacked {
    pub parent: ChangeId,
    /// The parent's heads as the train saw them, oldest first: the stacked branch forked from one of them.
    pub heads: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpecState {
    Pending,
    Green,
    Red,
    /// Doesn't rebase onto the base with its parent: nothing to test.
    Conflict,
}

/// The speculative build of one stacked PR, for one pair of heads.
#[derive(Clone, Debug)]
pub struct Spec {
    pub repo: String,
    pub branch: String,
    pub child_head: String,
    pub parent_head: String,
    pub sha: Option<String>,
    pub pr: Option<i64>,
    pub state: SpecState,
}

/// States a Change can be stacked in and tested ahead from: its patch is known.
const SPECULATED: [ChangeState; 2] = [ChangeState::Reviewing, ChangeState::Ready];

fn open_states() -> Vec<ChangeState> {
    use ChangeState::*;
    [
        Queued,
        Reviewing,
        Ready,
        Rebasing,
        Ci,
        Merging,
        NeedsRebase,
        CiFailed,
    ]
    .into_iter()
    .filter(|s| !TERMINAL_STATES.contains(s))
    .collect()
}

impl Train {
    /// The open Change whose branch `pull` is based on: its parent in a stack.
    pub(super) fn parent_of(&self, repo: &str, change: &Change, pull: &Pull) -> Option<Change> {
        self.records
            .in_train(repo, &open_states())
            .into_iter()
            .rfind(|c| c.change_id != change.change_id && c.branch.as_str() == pull.base.ref_)
    }

    /// A stacked PR waits while its parent is open, and after the parent landed until it is retargeted off the
    /// parent's branch.
    pub(super) fn waits_on_parent(&self, repo: &str, change: &Change, pull: &Pull) -> bool {
        if self.parent_of(repo, change, pull).is_some() {
            return true;
        }
        let parent = lock(&self.lanes)
            .stacked
            .get(&change.change_id)
            .map(|s| s.parent.clone());
        parent
            .and_then(|p| self.records.get(&p))
            .is_some_and(|p| p.branch.as_str() == pull.base.ref_)
    }

    /// Where a stacked Change whose parent landed forked from it, newest first: the parent's merged head, then the
    /// heads seen before the train rebased it. The rebase cuts the first one the branch contains.
    pub(super) fn forks_of(&self, change: &Change) -> Vec<String> {
        let Some(stacked) = lock(&self.lanes).stacked.get(&change.change_id).cloned() else {
            return Vec::new();
        };
        let Some(parent) = self
            .records
            .get(&stacked.parent)
            .filter(|p| p.state == ChangeState::Merged)
        else {
            return Vec::new();
        };
        let mut forks = vec![parent.head_sha.to_string()];
        forks.extend(stacked.heads.into_iter().rev());
        forks.dedup();
        forks
    }

    /// Each pass, before the freeze: stacked Changes are tested ahead on their parent, retargeted to the base once it
    /// landed, and builds nobody needs any more are closed. Never merges anything.
    pub(super) async fn stack_pass(&self, repo: &str) {
        let mut live: HashSet<ChangeId> = HashSet::new();
        for child in self.records.in_train(repo, &SPECULATED) {
            let Ok(pull) = self.github.pull(repo, child.pr_number.get()).await else {
                // Unread is not gone: its build stays.
                live.insert(child.change_id.clone());
                continue;
            };
            if pull.state != "open" {
                continue;
            }
            let parent = match self.parent_of(repo, &child, &pull) {
                Some(parent) => {
                    let mut lanes = lock(&self.lanes);
                    let stacked =
                        lanes
                            .stacked
                            .entry(child.change_id.clone())
                            .or_insert_with(|| Stacked {
                                parent: parent.change_id.clone(),
                                heads: Vec::new(),
                            });
                    stacked.parent = parent.change_id.clone();
                    if stacked.heads.last().map(String::as_str) != Some(parent.head_sha.as_str()) {
                        stacked.heads.push(parent.head_sha.to_string());
                    }
                    parent
                }
                None => {
                    let parent = lock(&self.lanes)
                        .stacked
                        .get(&child.change_id)
                        .and_then(|s| self.records.get(&s.parent));
                    if let Some(parent) = parent.filter(|p| {
                        p.state == ChangeState::Merged && p.branch.as_str() == pull.base.ref_
                    }) {
                        self.retarget(repo, &child, &parent).await;
                    }
                    continue;
                }
            };
            // The parent's own base is the trunk both go into.
            let Ok(parent_pull) = self.github.pull(repo, parent.pr_number.get()).await else {
                live.insert(child.change_id.clone());
                continue;
            };
            live.insert(child.change_id.clone());
            let trunk = parent_pull.base.ref_.clone();
            self.speculate(repo, &trunk, &child, &pull, &parent).await;
        }
        // A stacked PR whose parent landed waits for its retarget above; one that left needs no build.
        let gone: Vec<(ChangeId, Spec)> = {
            let mut lanes = lock(&self.lanes);
            let ids: Vec<ChangeId> = lanes
                .specs
                .iter()
                .filter(|(id, s)| s.repo == repo && !live.contains(*id))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| lanes.specs.remove(&id).map(|s| (id, s)))
                .collect()
        };
        for (_, spec) in gone {
            self.close_spec(&spec).await;
        }
        let mut lanes = lock(&self.lanes);
        let records = &self.records;
        lanes.stacked.retain(|id, _| {
            records
                .get(id)
                .is_some_and(|c| !TERMINAL_STATES.contains(&c.state))
        });
    }

    /// The parent landed: the stacked PR now goes into the parent's base, through the train like any other.
    async fn retarget(&self, repo: &str, child: &Change, parent: &Change) {
        let base = match self.github.pull(repo, parent.pr_number.get()).await {
            Ok(p) => p.base.ref_,
            Err(e) => {
                return tracing::warn!(repo, change_id = %child.change_id, error = %e.message, "train: stacked PR's parent not read");
            }
        };
        let base = base.as_str();
        match self
            .github
            .edit_pull(repo, child.pr_number.get(), &[("base", base)])
            .await
        {
            Ok(()) => tracing::info!(
                repo,
                change_id = %child.change_id,
                parent = %parent.change_id,
                "train: stacked PR retargeted to {base} after its parent landed"
            ),
            Err(e) => {
                tracing::warn!(repo, change_id = %child.change_id, error = %e.message, "train: stacked PR not retargeted")
            }
        }
    }

    async fn close_spec(&self, spec: &Spec) {
        if let Some(pr) = spec.pr
            && let Err(e) = self
                .github
                .close(
                    &spec.repo,
                    pr,
                    "Closed by the fleetd train: this speculative build is no longer needed.",
                )
                .await
        {
            tracing::warn!(repo = spec.repo, pr, error = %e.message, "train: speculative PR not closed");
        }
        if let Err(e) = self.github.delete_branch(&spec.repo, &spec.branch).await {
            tracing::warn!(repo = spec.repo, branch = spec.branch, error = %e.message, "train: speculative branch not deleted");
        }
    }

    /// Builds the stacked PR on its parent when either head moved, else reads the build's checks once.
    async fn speculate(
        &self,
        repo: &str,
        base: &str,
        child: &Change,
        pull: &Pull,
        parent: &Change,
    ) {
        let spec = lock(&self.lanes).specs.get(&child.change_id).cloned();
        let same = spec.as_ref().is_some_and(|s| {
            s.child_head == child.head_sha.as_str() && s.parent_head == parent.head_sha.as_str()
        });
        match spec {
            Some(spec) if same => {
                if spec.state == SpecState::Pending {
                    self.read_spec(repo, child, parent, spec).await;
                }
            }
            _ => self.build_spec(repo, base, child, pull, parent).await,
        }
    }

    async fn build_spec(
        &self,
        repo: &str,
        base: &str,
        child: &Change,
        pull: &Pull,
        parent: &Change,
    ) {
        let Some(branch) = self
            .scratch_branch(child, &format!("stack-{}", child.pr_number))
            .await
        else {
            return;
        };
        let (git, git_lock) = match self.git_for(child) {
            Ok(git) => git,
            Err(e) => {
                return tracing::warn!(repo, change_id = %child.change_id, error = e.0, "train: no git for a speculative build");
            }
        };
        let built = {
            let _held = git_lock.lock().await;
            match git.rebase(base, &child.branch, &[]).await {
                Ok(Rebase::Rebased { head_sha, .. }) => git
                    .push_scratch(&branch)
                    .await
                    .map(|()| Some(head_sha.to_string())),
                Ok(Rebase::Conflict { .. }) => Ok(None),
                Err(e) => Err(e),
            }
        };
        let mut spec = Spec {
            repo: repo.to_string(),
            branch: branch.clone(),
            child_head: child.head_sha.to_string(),
            parent_head: parent.head_sha.to_string(),
            sha: None,
            pr: lock(&self.lanes)
                .specs
                .get(&child.change_id)
                .and_then(|s| s.pr),
            state: SpecState::Conflict,
        };
        match built {
            Err(e) => {
                return tracing::warn!(repo, change_id = %child.change_id, error = e.0, "train: speculative build failed");
            }
            Ok(None) => {
                tracing::info!(repo, change_id = %child.change_id, "train: stacked PR does not rebase onto {base} with its parent");
            }
            Ok(Some(sha)) => {
                let title = format!(
                    "fleetd: #{} on top of #{}, tested ahead",
                    child.pr_number, parent.pr_number
                );
                let body = format!(
                    "Speculative CI for #{child_pr} (\"{child_title}\"), which is stacked on #{parent_pr}: #{child_pr} \
                     rebased onto {base} with #{parent_pr} under it, so its CI result is known before #{parent_pr} \
                     lands. This PR is never merged; the fleetd train closes it when #{parent_pr} lands, then merges \
                     #{child_pr} itself after CI on its rebased head.",
                    child_pr = child.pr_number,
                    child_title = pull.title.trim(),
                    parent_pr = parent.pr_number,
                );
                match self
                    .github
                    .open_pull(repo, &branch, base, &title, &body, true)
                    .await
                {
                    Ok(pr) => {
                        spec.pr = Some(pr);
                        spec.sha = Some(sha.clone());
                        spec.state = SpecState::Pending;
                        self.stack_status(&spec, child, parent, "pending").await;
                    }
                    Err(e) => {
                        return tracing::warn!(repo, change_id = %child.change_id, error = %e.message, "train: speculative PR not opened");
                    }
                }
            }
        }
        lock(&self.lanes)
            .specs
            .insert(child.change_id.clone(), spec);
    }

    async fn read_spec(&self, repo: &str, child: &Change, parent: &Change, mut spec: Spec) {
        let Some(sha) = spec.sha.clone() else { return };
        let Ok(runs) = self.github.check_runs(repo, &sha).await else {
            return;
        };
        let failing = match checks(&runs) {
            Checks::Green => {
                spec.state = SpecState::Green;
                Vec::new()
            }
            Checks::Red(red) => {
                spec.state = SpecState::Red;
                red
            }
            Checks::None | Checks::Pending => return,
        };
        self.stack_status(
            &spec,
            child,
            parent,
            if spec.state == SpecState::Green {
                "success"
            } else {
                "failure"
            },
        )
        .await;
        lock(&self.lanes)
            .specs
            .insert(child.change_id.clone(), spec.clone());
        if spec.state == SpecState::Red {
            let names: Vec<String> = failing
                .iter()
                .map(|r| {
                    format!(
                        "{} ({})",
                        r.name,
                        r.conclusion.as_deref().unwrap_or(&r.status)
                    )
                })
                .collect();
            let log = failing
                .iter()
                .find_map(|r| r.html_url.clone())
                .map(|u| format!(" (log: {u})"))
                .unwrap_or_default();
            let why = format!(
                "speculative CI of this PR on top of #{} (not merged yet) failed on {}: {}{log}. The train checks it \
                 again when #{} lands; if the failure is this PR's, fix it now",
                parent.pr_number,
                short(&sha),
                names.join(", "),
                parent.pr_number
            );
            let text = self.author_prompts(child).render(
                "task.train_ci_failed",
                &[
                    ("prUrl", &child.pr_url),
                    ("changeId", &child.change_id),
                    ("why", &why),
                    ("branch", &child.branch),
                ],
            );
            self.tell_author(child, text).await;
        }
    }

    /// `fleetd/stack` on the stacked PR's head, linking the speculative PR.
    async fn stack_status(&self, spec: &Spec, child: &Change, parent: &Change, state: &str) {
        let pr = spec.pr.unwrap_or_default();
        let description = match state {
            "pending" => format!("testing on top of #{} in #{pr}", parent.pr_number),
            "success" => format!(
                "green on top of #{} (tested ahead in #{pr})",
                parent.pr_number
            ),
            _ => format!(
                "red on top of #{} (tested ahead in #{pr})",
                parent.pr_number
            ),
        };
        let url = format!("https://github.com/{}/pull/{pr}", spec.repo);
        if let Err(e) = self
            .github
            .post_stack_status(
                &spec.repo,
                child.head_sha.as_str(),
                state,
                &description,
                &url,
            )
            .await
        {
            tracing::warn!(change_id = %child.change_id, error = %e.message, "train: fleetd/stack status not posted");
        }
    }
}
