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
        self.host
            .run_command(
                &self.machine_id,
                cwd.unwrap_or(&self.worktree),
                argv,
                timeout_sec,
            )
            .await
            .map_err(|e| GitError(format!("{head} on {}: {e}", self.machine_id)))
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

    async fn ensure_worktree(&self) -> Result<(), GitError> {
        let there = self
            .exec(
                &[
                    "git",
                    "-C",
                    &self.worktree,
                    "rev-parse",
                    "--is-inside-work-tree",
                ],
                Some(&self.root),
                120,
            )
            .await?;
        if there.exit_code == Some(0) {
            return Ok(());
        }
        self.ok(&["git", "worktree", "prune"], Some(&self.root), 120)
            .await?;
        self.ok(
            &["git", "worktree", "add", "--detach", &self.worktree],
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
    /// and the conflicting paths come back.
    pub async fn rebase(&self, base: &str, branch: &str) -> Result<Rebase, GitError> {
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
        let mut argv = vec!["git"];
        argv.extend(IDENTITY);
        argv.extend(["rebase", "--no-autosquash", &onto]);
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
