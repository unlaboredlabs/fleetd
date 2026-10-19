//! The train's git, run on the project's machine through its node (`cmd_check` frames) in a hub-owned worktree of
//! the project's checkout. Every command is argv, never a shell line, except the one pipe for the patch id, whose refs
//! go in as positional arguments.
use super::contract::{CommitSha, MachineId, PatchId};
use super::host::{CmdOut, TrainHost};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitError(pub String);

/// The default train worktree: `<parent of the checkout>/.fleetd-train/<checkout name>`.
pub fn default_worktree(root: &str) -> String {
    let trimmed = root.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(slash) => format!(
            "{}/.fleetd-train/{}",
            &trimmed[..slash],
            &trimmed[slash + 1..]
        ),
        None => format!("/.fleetd-train/{trimmed}"),
    }
}

// Rebased commits get a fixed committer and are never signed; the squash merge on GitHub replaces them anyway.
const IDENTITY: [&str; 6] = [
    "-c",
    "user.name=fleetd train",
    "-c",
    "user.email=train@fleetd.invalid",
    "-c",
    "commit.gpgsign=false",
];

fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.trim().split('\n').collect();
    let joined = lines[lines.len().saturating_sub(6)..].join("\n");
    let chars: Vec<char> = joined.chars().collect();
    chars[chars.len().saturating_sub(600)..].iter().collect()
}

fn is_hex_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// What a linked worktree's `.git` file points at (`gitdir: <repo>/worktrees/<name>`), absolute. None for anything
/// that is not such a file.
fn linked_gitdir(worktree: &str, dot_git: &str) -> Option<String> {
    let path = dot_git.trim().strip_prefix("gitdir:")?.trim();
    let parent = path.trim_end_matches('/').rsplit_once('/')?.0;
    if !(parent == "worktrees" || parent.ends_with("/worktrees")) {
        return None;
    }
    Some(if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{worktree}/{path}")
    })
}

/// Marks the error a person has to fix: something that is not the train's sits where its worktree goes.
pub const BLOCKED: &str = "the train's worktree is blocked: ";

/// Marks the other error a person has to fix: the project's node refuses to run commands in its checkout.
pub const REFUSED_HERE: &str = "the node refuses to run the train's git there: ";

fn blocked(worktree: &str, root: &str, gitdir: Option<&str>) -> String {
    let what = match gitdir {
        Some(gitdir) => format!("a worktree of another repository ({gitdir})"),
        None => "not a worktree of this checkout".into(),
    };
    format!(
        "{BLOCKED}{worktree} is {what}, and fleetd leaves what isn't its own. Move it elsewhere (or delete it if \
         you don't need it), e.g. `mv {worktree} {worktree}.moved`; the train then makes its worktree there from {root}."
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seen {
    pub head_sha: CommitSha,
    pub patch_id: PatchId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rebase {
    Conflict {
        remote_head: String,
        paths: Vec<String>,
        output: String,
    },
    Rebased {
        remote_head: String,
        head_sha: CommitSha,
        patch_id: PatchId,
    },
}

/// A ready Change as a batch build takes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatchMember {
    pub branch: String,
    /// The head it is squashed from, exactly: the one the batch records and the train checked.
    pub head_sha: String,
    pub title: String,
    pub pr_number: i64,
    /// The patch its reviews are bound to.
    pub patch_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatchBuild {
    pub head_sha: CommitSha,
    /// Indexes into the members, in order.
    pub kept: Vec<usize>,
    pub dropped: Vec<(usize, String)>,
}

pub struct TrainGit<'a> {
    pub host: &'a dyn TrainHost,
    pub machine_id: MachineId,
    /// The project's checkout; the train worktree is added from it.
    pub root: String,
    pub worktree: String,
}

impl TrainGit<'_> {
    async fn exec(
        &self,
        argv: &[&str],
        cwd: Option<&str>,
        timeout_sec: u64,
    ) -> Result<CmdOut, GitError> {
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        let head = argv.iter().take(3).cloned().collect::<Vec<_>>().join(" ");
        let time = self.host.time();
        let started = crate::hub::time::wall_ms();
        let out = self
            .host
            .run_command(
                &self.machine_id,
                cwd.unwrap_or(&self.worktree),
                argv,
                timeout_sec,
            )
            .await;
        if let Some(time) = time {
            let lane = format!(
                "train:{}",
                std::path::Path::new(&self.worktree)
                    .file_name()
                    .map_or_else(
                        || self.worktree.clone(),
                        |n| n.to_string_lossy().into_owned()
                    )
            );
            let exit = out.as_ref().ok().and_then(|o| o.exit_code).map(i64::from);
            time.span(crate::hub::time::NewSpan {
                src_key: format!(
                    "git/{}/{started}/{}",
                    self.machine_id,
                    rand::random::<u32>()
                ),
                kind: fleetd_contracts::time::SpanKind::Git,
                start_ms: started,
                end_ms: Some(crate::hub::time::wall_ms().max(started)),
                ids: crate::hub::time::Ids {
                    machine_id: Some(self.machine_id.to_string()),
                    ..Default::default()
                },
                lane,
                label: Some(head.clone()),
                exit_code: exit,
                status: if exit == Some(0) {
                    fleetd_contracts::time::SpanStatus::Ok
                } else {
                    fleetd_contracts::time::SpanStatus::Failed
                },
                ..Default::default()
            });
        }
        let out = out.map_err(|e| GitError(format!("{head} on {}: {e}", self.machine_id)))?;
        // Every command here runs in the checkout or its worktree, so a refusal is about where they are, never git.
        if let Some(why) =
            crate::node::cmd::refusal(out.exit_code.is_none() && !out.timed_out, &out.output_tail)
        {
            return Err(GitError(format!(
                "{REFUSED_HERE}{why} on {}. Fix: {}",
                self.machine_id,
                crate::node::cmd::outside_roots_fix(self.machine_id.as_str())
            )));
        }
        Ok(out)
    }

    /// Fails unless it exits 0; returns the output.
    async fn ok(
        &self,
        argv: &[&str],
        cwd: Option<&str>,
        timeout_sec: u64,
    ) -> Result<String, GitError> {
        let out = self.exec(argv, cwd, timeout_sec).await?;
        if out.exit_code == Some(0) {
            return Ok(out.output_tail);
        }
        let head = argv.iter().take(3).copied().collect::<Vec<_>>().join(" ");
        Err(GitError(format!(
            "{head} failed{}: {}",
            if out.timed_out { " (timed out)" } else { "" },
            tail(&out.output_tail)
        )))
    }

    /// The git dir shared by all worktrees of the checkout whose top is `dir`, as an absolute path.
    async fn common_dir(&self, dir: &str) -> Result<Option<String>, GitError> {
        let out = self
            .exec(
                &[
                    "git",
                    "-C",
                    dir,
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-common-dir",
                    "--show-prefix",
                ],
                Some(&self.root),
                120,
            )
            .await?;
        // The prefix is empty only at the top of a work tree, so a directory merely inside some other checkout fails.
        Ok(
            match out.output_tail.trim_end().split('\n').collect::<Vec<_>>()[..] {
                [common] if out.exit_code == Some(0) => Some(common.trim().to_string()),
                _ => None,
            },
        )
    }

    /// Exit 0 of `argv`, run in the checkout.
    async fn holds(&self, argv: &[&str]) -> Result<bool, GitError> {
        Ok(self.exec(argv, Some(&self.root), 120).await?.exit_code == Some(0))
    }

    /// Makes sure the train worktree is a worktree of this checkout. What is in its place is deleted only when it is
    /// the train's own leftover: a linked worktree whose repository is gone (an earlier clone of the
    /// project, or a run whose checkout was deleted). Anything else stays, and the error says what to move.
    async fn ensure_worktree(&self) -> Result<(), GitError> {
        let ours = self.common_dir(&self.root).await?;
        if ours.is_some() && self.common_dir(&self.worktree).await? == ours {
            return Ok(());
        }
        let ours = ours.ok_or_else(|| {
            GitError(format!(
                "{} on {} is not a git checkout",
                self.root, self.machine_id
            ))
        })?;
        self.ok(&["git", "worktree", "prune"], Some(&self.root), 120)
            .await?;
        let wt = self.worktree.as_str();
        let dot_git = format!("{wt}/.git");
        if self.holds(&["test", "-e", wt]).await? || self.holds(&["test", "-L", wt]).await? {
            let empty = self.exec(&["ls", "-A", wt], Some(&self.root), 120).await?;
            let is_empty = empty.exit_code == Some(0) && empty.output_tail.trim().is_empty();
            if !is_empty {
                let gitdir = if self.holds(&["test", "-f", &dot_git]).await? {
                    let out = self.ok(&["cat", &dot_git], Some(&self.root), 120).await?;
                    linked_gitdir(wt, &out)
                } else {
                    None
                };
                let stale = match &gitdir {
                    Some(gitdir) => {
                        gitdir.starts_with(&format!("{ours}/worktrees/"))
                            || !self.holds(&["test", "-e", gitdir]).await?
                    }
                    None => false,
                };
                if !stale {
                    return Err(GitError(blocked(wt, &self.root, gitdir.as_deref())));
                }
                self.ok(&["rm", "-rf", "--", wt], Some(&self.root), 120)
                    .await?;
                self.ok(&["git", "worktree", "prune"], Some(&self.root), 120)
                    .await?;
            }
        }
        self.ok(
            &["git", "worktree", "add", "--detach", wt],
            Some(&self.root),
            120,
        )
        .await?;
        Ok(())
    }

    async fn fetch(&self, base: &str, branch: &str) -> Result<(), GitError> {
        let base_ref = format!("+refs/heads/{base}:refs/remotes/origin/{base}");
        let branch_ref = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
        self.ok(
            &[
                "git",
                "fetch",
                "--no-tags",
                "origin",
                &base_ref,
                &branch_ref,
            ],
            None,
            300,
        )
        .await
        .map(|_| ())
    }

    async fn rev_parse(&self, r: &str) -> Result<String, GitError> {
        let out = self
            .ok(
                &["git", "rev-parse", "--verify", &format!("{r}^{{commit}}")],
                None,
                120,
            )
            .await?;
        out.lines()
            .map(str::trim_end)
            .find(|l| is_hex_sha(l))
            .map(String::from)
            .ok_or_else(|| GitError(format!("git rev-parse {r} printed no SHA")))
    }

    /// `git patch-id --stable` of `head`'s diff against its merge base with `base`.
    async fn patch_id(&self, base: &str, head: &str) -> Result<String, GitError> {
        let out = self
            .ok(
                &[
                    "sh",
                    "-c",
                    "git diff \"$1...$2\" | git patch-id --stable",
                    "sh",
                    base,
                    head,
                ],
                None,
                120,
            )
            .await?;
        out.lines()
            .find_map(|l| {
                l.split_once(' ')
                    .map(|(id, _)| id)
                    .filter(|id| is_hex_sha(id))
            })
            .map(String::from)
            .ok_or_else(|| GitError(format!("{head} has no changes against {base}")))
    }

    /// Fetches the base and the PR branch into `origin/*` and says where the branch points and its patch id.
    pub async fn inspect(&self, base: &str, branch: &str) -> Result<Seen, GitError> {
        self.ensure_worktree().await?;
        self.fetch(base, branch).await?;
        let head_sha = self.rev_parse(&format!("origin/{branch}")).await?;
        let patch_id = self.patch_id(&format!("origin/{base}"), &head_sha).await?;
        Ok(Seen {
            head_sha: CommitSha::unchecked(head_sha),
            patch_id: PatchId::unchecked(patch_id),
        })
    }

    /// Rebases the fetched PR branch onto `origin/<base>` in the train worktree. On a conflict the rebase is aborted
    /// and the conflicting paths come back. `forks` are where a stacked PR's parent ended before it landed: the first
    /// one the branch contains is cut off (`--onto`), so the parent's own commits, already squashed onto the base, are
    /// not replayed.
    pub async fn rebase(
        &self,
        base: &str,
        branch: &str,
        forks: &[String],
    ) -> Result<Rebase, GitError> {
        self.ensure_worktree().await?;
        self.fetch(base, branch).await?;
        // Whatever an earlier run left behind goes first.
        self.exec(&["git", "rebase", "--abort"], None, 120).await?;
        self.ok(
            &[
                "git",
                "checkout",
                "--force",
                "--detach",
                &format!("origin/{branch}"),
            ],
            None,
            120,
        )
        .await?;
        self.ok(&["git", "clean", "-fdq"], None, 120).await?;
        let remote_head = self.rev_parse("HEAD").await?;
        let onto = format!("origin/{base}");
        let mut fork = None;
        for f in forks.iter().filter(|f| is_hex_sha(f)) {
            let contained = self
                .exec(
                    &["git", "merge-base", "--is-ancestor", f, "HEAD"],
                    None,
                    120,
                )
                .await?;
            if contained.exit_code == Some(0) {
                fork = Some(f.as_str());
                break;
            }
        }
        let mut argv = vec!["git"];
        argv.extend(IDENTITY);
        argv.extend(["rebase", "--no-autosquash"]);
        match fork {
            Some(fork) => argv.extend(["--onto", &onto, fork]),
            None => argv.push(&onto),
        }
        let rebased = self.exec(&argv, None, 600).await?;
        if rebased.exit_code != Some(0) {
            let unmerged = self
                .exec(
                    &["git", "diff", "--name-only", "--diff-filter=U"],
                    None,
                    120,
                )
                .await?;
            self.exec(&["git", "rebase", "--abort"], None, 120).await?;
            let paths = if unmerged.exit_code == Some(0) {
                unmerged
                    .output_tail
                    .split('\n')
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .map(String::from)
                    .collect()
            } else {
                Vec::new()
            };
            return Ok(Rebase::Conflict {
                remote_head,
                paths,
                output: tail(&rebased.output_tail),
            });
        }
        let head_sha = self.rev_parse("HEAD").await?;
        let patch_id = self.patch_id(&onto, &head_sha).await?;
        Ok(Rebase::Rebased {
            remote_head,
            head_sha: CommitSha::unchecked(head_sha),
            patch_id: PatchId::unchecked(patch_id),
        })
    }

    /// The files `branch` changes against its merge base with `base`, both fetched first.
    pub async fn files(&self, base: &str, branch: &str) -> Result<Vec<String>, GitError> {
        self.ensure_worktree().await?;
        self.fetch(base, branch).await?;
        let range = format!("origin/{base}...origin/{branch}");
        let out = self
            .ok(&["git", "diff", "--name-only", &range], None, 120)
            .await?;
        Ok(out
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect())
    }

    /// Squashes each member onto `origin/<base>` in order, one commit each, in the train worktree. A member that does
    /// not apply on top of the ones before it, adds nothing, or whose squash is not the patch it was reviewed at is
    /// left out, with why.
    pub async fn build_batch(
        &self,
        base: &str,
        members: &[BatchMember],
    ) -> Result<BatchBuild, GitError> {
        self.ensure_worktree().await?;
        let mut refspecs = vec![format!("+refs/heads/{base}:refs/remotes/origin/{base}")];
        refspecs.extend(
            members
                .iter()
                .map(|m| format!("+refs/heads/{0}:refs/remotes/origin/{0}", m.branch)),
        );
        let mut argv = vec!["git", "fetch", "--no-tags", "origin"];
        argv.extend(refspecs.iter().map(String::as_str));
        self.ok(&argv, None, 300).await?;
        self.exec(&["git", "rebase", "--abort"], None, 120).await?;
        let onto = format!("origin/{base}");
        self.ok(
            &["git", "checkout", "--force", "--detach", &onto],
            None,
            120,
        )
        .await?;
        self.ok(&["git", "clean", "-fdq"], None, 120).await?;
        let mut kept = Vec::new();
        let mut dropped = Vec::new();
        for (i, m) in members.iter().enumerate() {
            let theirs = format!("{}^{{commit}}", m.head_sha);
            let present = self
                .exec(&["git", "cat-file", "-e", &theirs], None, 120)
                .await?;
            if !is_hex_sha(&m.head_sha) || present.exit_code != Some(0) {
                dropped.push((i, "its head is not the one the train checked".to_string()));
                continue;
            }
            let theirs = m.head_sha.clone();
            let mut argv = vec!["git"];
            argv.extend(IDENTITY);
            argv.extend(["merge", "--squash", &theirs]);
            let merged = self.exec(&argv, None, 600).await?;
            if merged.exit_code != Some(0) {
                self.ok(&["git", "reset", "-q", "--hard", "HEAD"], None, 120)
                    .await?;
                dropped.push((i, "does not apply on top of the batch".to_string()));
                continue;
            }
            let staged = self
                .exec(&["git", "diff", "--cached", "--quiet"], None, 120)
                .await?;
            if staged.exit_code == Some(0) {
                dropped.push((i, format!("adds nothing on top of origin/{base}")));
                continue;
            }
            let message = format!("{} (#{})", m.title, m.pr_number);
            let mut argv = vec!["git"];
            argv.extend(IDENTITY);
            argv.extend(["commit", "-q", "--no-verify", "-m", &message]);
            self.ok(&argv, None, 120).await?;
            let head = self.rev_parse("HEAD").await?;
            if self.patch_id("HEAD^", &head).await? != m.patch_id {
                self.ok(&["git", "reset", "-q", "--hard", "HEAD^"], None, 120)
                    .await?;
                dropped.push((i, format!("its patch changes on origin/{base}")));
                continue;
            }
            kept.push(i);
        }
        Ok(BatchBuild {
            head_sha: CommitSha::unchecked(self.rev_parse("HEAD").await?),
            kept,
            dropped,
        })
    }

    /// The stacked PR at `child_head`: its own commits (those after the first of `forks`, the parent heads it may
    /// have forked from, that it contains) on top of the parent at `parent_head` rebased onto `trunk`, in the train
    /// worktree. That is what it will be once the parent lands. Err(why) when that does not apply or no fork is in
    /// its history.
    pub async fn build_stack(
        &self,
        trunk: &str,
        (parent, parent_head): (&str, &str),
        (child, child_head): (&str, &str),
        forks: &[String],
    ) -> Result<Result<String, String>, GitError> {
        self.ensure_worktree().await?;
        let refspecs: Vec<String> = [trunk, parent, child]
            .iter()
            .map(|b| format!("+refs/heads/{b}:refs/remotes/origin/{b}"))
            .collect();
        let mut argv = vec!["git", "fetch", "--no-tags", "origin"];
        argv.extend(refspecs.iter().map(String::as_str));
        self.ok(&argv, None, 300).await?;
        for sha in [parent_head, child_head] {
            let present = self
                .exec(
                    &["git", "cat-file", "-e", &format!("{sha}^{{commit}}")],
                    None,
                    120,
                )
                .await?;
            if !is_hex_sha(sha) || present.exit_code != Some(0) {
                return Ok(Err(format!("{sha} is no longer on origin")));
            }
        }
        let child_ref = child_head.to_string();
        let mut fork = None;
        for f in forks.iter().filter(|f| is_hex_sha(f)) {
            let contained = self
                .exec(
                    &["git", "merge-base", "--is-ancestor", f, &child_ref],
                    None,
                    120,
                )
                .await?;
            if contained.exit_code == Some(0) {
                fork = Some(f.clone());
                break;
            }
        }
        let Some(fork) = fork else {
            return Ok(Err(format!(
                "none of its parent's heads is in {child}'s history"
            )));
        };
        self.exec(&["git", "rebase", "--abort"], None, 120).await?;
        self.checkout_clean(parent_head).await?;
        if !self.rebase_here(&[&format!("origin/{trunk}")]).await? {
            return Ok(Err(format!("{parent} does not rebase onto origin/{trunk}")));
        }
        let parent_head = self.rev_parse("HEAD").await?;
        self.checkout_clean(&child_ref).await?;
        if !self.rebase_here(&["--onto", &parent_head, &fork]).await? {
            return Ok(Err(format!("{child} does not apply on top of {parent}")));
        }
        Ok(Ok(self.rev_parse("HEAD").await?))
    }

    async fn checkout_clean(&self, target: &str) -> Result<(), GitError> {
        self.ok(
            &["git", "checkout", "--force", "--detach", target],
            None,
            120,
        )
        .await?;
        self.ok(&["git", "clean", "-fdq"], None, 120)
            .await
            .map(|_| ())
    }

    /// `git rebase` of HEAD with `args`; on a failure the rebase is aborted and the answer is false.
    async fn rebase_here(&self, args: &[&str]) -> Result<bool, GitError> {
        let mut argv = vec!["git"];
        argv.extend(IDENTITY);
        argv.extend(["rebase", "--no-autosquash"]);
        argv.extend(args);
        if self.exec(&argv, None, 600).await?.exit_code == Some(0) {
            return Ok(true);
        }
        self.exec(&["git", "rebase", "--abort"], None, 120).await?;
        Ok(false)
    }

    /// Force-pushes HEAD to `branch`, one of the train's own scratch branches, which nobody else writes.
    pub async fn push_scratch(&self, branch: &str) -> Result<(), GitError> {
        let target = format!("HEAD:refs/heads/{branch}");
        self.ok(&["git", "push", "--force", "origin", &target], None, 300)
            .await
            .map(|_| ())
    }

    /// Pushes the rebased HEAD to the PR branch, only if the branch is still at `expected`. Err(output) when refused.
    pub async fn push(&self, branch: &str, expected: &str) -> Result<Result<(), String>, GitError> {
        let lease = format!("--force-with-lease=refs/heads/{branch}:{expected}");
        let target = format!("HEAD:refs/heads/{branch}");
        let out = self
            .exec(&["git", "push", &lease, "origin", &target], None, 300)
            .await?;
        Ok(if out.exit_code == Some(0) {
            Ok(())
        } else {
            Err(tail(&out.output_tail))
        })
    }
}
