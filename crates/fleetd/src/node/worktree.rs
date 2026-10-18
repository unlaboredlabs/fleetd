//! Git worktrees for writer sessions, made with `git` directly: one per writer session, never shared, at
//! `<node home>/worktrees/<project>/<session>` on its own branch. A session's worktree path never changes once claude
//! has a session file for it, because `claude --resume` finds sessions by cwd.
use std::path::Path;
use std::process::Command;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct GitError(pub String);

fn git(dir: &Path, args: &[&str]) -> Result<String, GitError> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        // A prompt for credentials or an editor would hang the node.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .output()
        .map_err(|e| GitError(format!("cannot run git: {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(GitError(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

/// The branch checked out at `path` when it is a worktree of `root`'s repository.
fn worktree_branch(root: &Path, path: &Path) -> Result<Option<Option<String>>, GitError> {
    let list = git(root, &["worktree", "list", "--porcelain"])?;
    let want = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut current: Option<std::path::PathBuf> = None;
    let mut found = None;
    for line in list.lines().chain(std::iter::once("")) {
        if let Some(p) = line.strip_prefix("worktree ") {
            current = Some(Path::new(p).canonicalize().unwrap_or_else(|_| p.into()));
            found = None;
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            found = Some(b.to_owned());
        } else if line.is_empty() && current.as_deref() == Some(want.as_path()) {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn branch_exists(root: &Path, branch: &str) -> bool {
    git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok()
}

/// Makes `path` a worktree of `root` on `branch`: reuses it when it already is one, checks out an existing branch
/// (a worktree that was removed, then resumed), else creates the branch from `base_ref`.
pub fn ensure(root: &Path, path: &Path, branch: &str, base_ref: &str) -> Result<(), GitError> {
    match worktree_branch(root, path)? {
        Some(Some(on)) if on == branch => return Ok(()),
        Some(on) => {
            return Err(GitError(format!(
                "{} is already a worktree on {}, not {branch}",
                path.display(),
                on.as_deref().unwrap_or("a detached HEAD")
            )));
        }
        None => {}
    }
    if path.exists() {
        return Err(GitError(format!(
            "{} exists and is not a worktree of {}",
            path.display(),
            root.display()
        )));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| GitError(e.to_string()))?;
    }
    let target = path.to_string_lossy();
    if branch_exists(root, branch) {
        git(root, &["worktree", "add", &target, branch])?;
    } else {
        git(root, &["worktree", "add", "-b", branch, &target, base_ref])?;
    }
    Ok(())
}

/// Removes the worktree (uncommitted work included) and deletes its branch only when `base_ref` already contains
/// it, so unmerged work stays reachable. Returns whether the branch was deleted.
pub fn remove(root: &Path, path: &Path, branch: &str, base_ref: &str) -> Result<bool, GitError> {
    if worktree_branch(root, path)?.is_some() {
        git(
            root,
            &["worktree", "remove", "--force", &path.to_string_lossy()],
        )?;
    }
    let merged = branch_exists(root, branch)
        && git(root, &["merge-base", "--is-ancestor", branch, base_ref]).is_ok();
    if merged {
        git(root, &["branch", "-D", branch])?;
    }
    Ok(merged)
}

/// Repo-relative paths the work at `cwd` touched: committed since its merge base with `base_ref`, plus everything
/// `git status` shows. Sorted and unique.
pub fn changes(cwd: &Path, base_ref: Option<&str>) -> Result<Vec<String>, GitError> {
    let mut paths = std::collections::BTreeSet::new();
    if let Some(base_ref) = base_ref {
        let base = git(cwd, &["merge-base", base_ref, "HEAD"])?;
        let committed = git(cwd, &["diff", "--name-only", base.trim(), "HEAD"])?;
        paths.extend(
            committed
                .lines()
                .filter(|l| !l.is_empty())
                .map(str::to_owned),
        );
    }
    let status = git(
        cwd,
        &["status", "--porcelain", "-z", "--untracked-files=all"],
    )?;
    let mut entries = status.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        let (code, path) = entry.split_at(entry.len().min(3));
        paths.insert(path.to_owned());
        // A rename lists its source as the next entry.
        if (code.starts_with('R') || code.starts_with('C'))
            && let Some(from) = entries.next()
        {
            paths.insert(from.to_owned());
        }
    }
    Ok(paths.into_iter().collect())
}

/// `origin`'s default branch as a local name, else the branch checked out at `root`.
pub fn default_branch(root: &Path) -> Option<String> {
    if let Ok(head) = git(
        root,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) {
        let head = head.trim();
        if let Some(name) = head.strip_prefix("origin/").filter(|n| !n.is_empty()) {
            return Some(name.to_owned());
        }
    }
    git(root, &["symbolic-ref", "--short", "HEAD"])
        .ok()
        .map(|b| b.trim().to_owned())
        .filter(|b| !b.is_empty())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn run(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repo on `main` with one commit.
    pub(crate) fn repo(dir: &Path) -> std::path::PathBuf {
        let root = dir.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        run(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("a.txt"), "a\n").unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "-q", "-m", "init"]);
        root
    }

    #[test]
    fn a_worktree_is_created_reused_and_recreated_on_its_branch() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        let path = dir.path().join("wt/p1/s1");
        ensure(&root, &path, "fleetd/s1", "main").unwrap();
        assert!(path.join("a.txt").exists());
        // Idempotent: a retried launch or a resume reuses it.
        ensure(&root, &path, "fleetd/s1", "main").unwrap();
        // Another branch may not take over the session's directory.
        assert!(ensure(&root, &path, "fleetd/other", "main").is_err());

        std::fs::write(path.join("b.txt"), "b\n").unwrap();
        run(&path, &["add", "."]);
        run(&path, &["commit", "-q", "-m", "b"]);
        // Removed with unmerged work: the branch stays, and a resume checks it out again at the same path.
        assert!(!remove(&root, &path, "fleetd/s1", "main").unwrap());
        assert!(!path.exists());
        ensure(&root, &path, "fleetd/s1", "main").unwrap();
        assert!(path.join("b.txt").exists());

        // A plain directory in the way is refused, not adopted.
        let squatter = dir.path().join("wt/p1/s2");
        std::fs::create_dir_all(&squatter).unwrap();
        assert!(ensure(&root, &squatter, "fleetd/s2", "main").is_err());
    }

    #[test]
    fn remove_deletes_the_branch_only_once_merged() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        let path = dir.path().join("wt/p1/s1");
        ensure(&root, &path, "fleetd/s1", "main").unwrap();
        std::fs::write(path.join("b.txt"), "b\n").unwrap();
        run(&path, &["add", "."]);
        run(&path, &["commit", "-q", "-m", "b"]);
        run(&root, &["merge", "-q", "--ff-only", "fleetd/s1"]);
        assert!(remove(&root, &path, "fleetd/s1", "main").unwrap());
        assert!(!branch_exists(&root, "fleetd/s1"));
    }

    #[test]
    fn changes_cover_commits_since_the_base_and_uncommitted_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        let path = dir.path().join("wt/p1/s1");
        ensure(&root, &path, "fleetd/s1", "main").unwrap();
        std::fs::write(path.join("committed.txt"), "c\n").unwrap();
        run(&path, &["add", "."]);
        run(&path, &["commit", "-q", "-m", "c"]);
        // main moves on: its own commits are not the session's changes.
        std::fs::write(root.join("main-only.txt"), "m\n").unwrap();
        run(&root, &["add", "."]);
        run(&root, &["commit", "-q", "-m", "m"]);
        std::fs::write(path.join("a.txt"), "edited\n").unwrap();
        std::fs::create_dir_all(path.join("new dir")).unwrap();
        std::fs::write(path.join("new dir/x.txt"), "x\n").unwrap();
        run(&path, &["mv", "committed.txt", "moved.txt"]);
        assert_eq!(
            changes(&path, Some("main")).unwrap(),
            ["a.txt", "committed.txt", "moved.txt", "new dir/x.txt"]
        );
        assert_eq!(changes(&root, None).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn default_branch_prefers_origin_head() {
        let dir = tempfile::tempdir().unwrap();
        let origin = repo(dir.path());
        run(&origin, &["branch", "trunk"]);
        run(&origin, &["symbolic-ref", "HEAD", "refs/heads/trunk"]);
        let clone = dir.path().join("clone");
        run(
            dir.path(),
            &[
                "clone",
                "-q",
                &origin.to_string_lossy(),
                &clone.to_string_lossy(),
            ],
        );
        run(&clone, &["checkout", "-q", "-b", "feature"]);
        assert_eq!(default_branch(&clone).as_deref(), Some("trunk"));
        assert_eq!(default_branch(&origin).as_deref(), Some("trunk"));
    }
}
