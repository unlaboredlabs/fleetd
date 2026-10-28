//! Git worktrees for task sessions, made with `git` directly: one per session, never shared, at
//! `<node home>/worktrees/<project>/<session>` on its own branch. A session's worktree path never changes once claude
//! has a session file for it, because `claude --resume` finds sessions by cwd. A new branch starts from a fresh fetch
//! of the remote's default branch, never from the human's local checkout. A read or review session gets a detached
//! worktree at the same place, at that base or at its PR's head, so it never works in the human's checkout either.
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use fleetd_contracts::sessions::{BaseError, BaseErrorKind};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;

use fleetd_contracts::sessions::WorktreeSource;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct GitError(pub String);

/// Asking the remote for its default branch: the hub reads it within 15 s.
const LS_REMOTE_TIMEOUT: Duration = Duration::from_secs(10);
/// Fetching the base: it and `worktree add` fit in the hub's 60 s launch timeout.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// The remote's HEAD is asked again after this long; until then the answer is reused.
const HEAD_FRESH: Duration = Duration::from_secs(3600);
/// A fetch this recent is reused, so a lead spawning six writers fetches once.
const FETCH_FRESH: Duration = Duration::from_secs(30);
/// The remote a fork's `origin` was forked from, by convention.
const UPSTREAM: &str = "upstream";
/// How often a fork's upstream is fetched to count how far behind the fork is.
const UPSTREAM_EVERY: Duration = Duration::from_secs(600);

fn command(dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        // A prompt for credentials or an editor would hang the node.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_EDITOR", "true");
    cmd
}

fn failed(args: &[&str], stderr: &[u8]) -> GitError {
    GitError(format!(
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(stderr).trim()
    ))
}

pub(super) fn git(dir: &Path, args: &[&str]) -> Result<String, GitError> {
    let out = command(dir, args)
        .output()
        .map_err(|e| GitError(format!("cannot run git: {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(failed(args, &out.stderr))
    }
}

/// `git` that talks to a remote: never waits on ssh for a passphrase or a host key, and is killed with whatever it
/// started (ssh, a credential helper) at `timeout`.
pub(super) fn git_remote(dir: &Path, args: &[&str], timeout: Duration) -> Result<String, GitError> {
    let mut cmd = command(dir, args);
    let ssh_set = std::env::var_os("GIT_SSH_COMMAND").is_some()
        || std::env::var_os("GIT_SSH").is_some()
        || git(dir, &["config", "--get", "core.sshCommand"]).is_ok_and(|c| !c.trim().is_empty());
    if !ssh_set {
        cmd.env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=10",
        );
    }
    let mut child = std::os::unix::process::CommandExt::process_group(&mut cmd, 0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| GitError(format!("cannot run git: {e}")))?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as _));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => break None,
        }
    };
    let Some(status) = status else {
        let _ = killpg(Pid::from_raw(child.id() as i32), Signal::SIGKILL);
        let _ = child.wait();
        return Err(GitError(format!(
            "git {} failed: timed out after {} s",
            args.join(" "),
            timeout.as_secs()
        )));
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if status.success() {
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    } else {
        Err(failed(args, &stderr))
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
/// (a worktree that was removed, then resumed), else creates the branch at `start`, a commit or ref.
pub fn ensure(root: &Path, path: &Path, branch: &str, start: &str) -> Result<(), GitError> {
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
        git(
            root,
            &[
                "worktree",
                "add",
                "--no-track",
                "-b",
                branch,
                &target,
                start,
            ],
        )?;
    }
    Ok(())
}

/// What is left of a lost worktree's branch, best first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// The local branch.
    Local,
    /// The local branch is gone; `<remote>/<branch>`, freshly fetched, holds what was pushed.
    Remote(String),
    /// Nothing of the branch is left, here or on a remote: a new branch at `sha`, as for a new task.
    Base { base_ref: String, sha: String },
}

impl Source {
    /// What the session's agent is told, ahead of its next message, once its worktree came back from here.
    pub fn note(&self, branch: &str) -> String {
        match self {
            Source::Local => format!(
                "fleetd: your worktree was gone, so it was recreated at the same path from your local branch {branch}. \
                 Your commits are there; uncommitted changes from before are gone."
            ),
            Source::Remote(remote) => format!(
                "fleetd: your worktree and its local branch were gone, so the worktree was recreated at the same path \
                 from {remote}/{branch}, freshly fetched. What you pushed is there; unpushed commits and uncommitted \
                 changes from before are gone."
            ),
            Source::Base { base_ref, .. } => format!(
                "fleetd: your worktree was gone and {branch} was neither here nor pushed, so the worktree was \
                 recreated at the same path on a new {branch} from {base_ref}. Work that is not in {base_ref} is gone."
            ),
        }
    }

    pub fn kind(&self) -> WorktreeSource {
        match self {
            Source::Local => WorktreeSource::Local,
            Source::Remote(_) => WorktreeSource::Remote,
            Source::Base { .. } => WorktreeSource::Base,
        }
    }
}

/// Where a lost worktree of `branch` comes back from: the local branch, else the branch as pushed, else a fresh fetch
/// of the default branch `base_ref` names, as a new task starts. Everything that talks to a remote happens here, so
/// the node calls it before taking its spawn lock.
pub fn source(root: &Path, branch: &str, base_ref: &str) -> Result<Source, GitError> {
    if branch_exists(root, branch) {
        return Ok(Source::Local);
    }
    if let Some(remote) = pushed(root, branch) {
        return Ok(Source::Remote(remote));
    }
    let name = remote(root)
        .and_then(|r| base_ref.strip_prefix(&format!("{r}/")).map(str::to_owned))
        .unwrap_or_else(|| base_ref.to_owned());
    let base = fresh_base(root, &name)?;
    if let Some(note) = &base.note {
        tracing::warn!(root = %root.display(), branch, "rebuilt worktree {note}");
    }
    Ok(Source::Base {
        base_ref: base.base_ref,
        sha: base.sha,
    })
}

/// The remote that holds `branch` as pushed, `origin` first, after fetching it from each: any git remote, by git
/// alone. A remote that can't be reached keeps its last fetched copy, which still holds what was pushed by then.
fn pushed(root: &Path, branch: &str) -> Option<String> {
    let remotes = git(root, &["remote"]).ok()?;
    let mut remotes: Vec<&str> = remotes.lines().filter(|r| !r.is_empty()).collect();
    remotes.sort_by_key(|r| *r != "origin");
    remotes.into_iter().find_map(|remote| {
        let _ = fetch(root, remote, branch);
        ref_sha(root, &format!("refs/remotes/{remote}/{branch}")).map(|_| remote.to_owned())
    })
}

/// Brings back a session's worktree that is gone, at the same path so `claude --resume` still finds its session, from
/// `from` (see [`source`]). Only local git: no remote is asked.
pub fn restore(root: &Path, path: &Path, branch: &str, from: &Source) -> Result<(), GitError> {
    // A worktree whose directory was deleted stays registered, holding its path and branch. Only this one record goes:
    // the human's own worktrees on a disk that isn't mounted right now keep theirs, unlike with `git worktree prune`.
    if !path.exists() {
        let _ = git(
            root,
            &["worktree", "remove", "--force", &path.to_string_lossy()],
        );
    }
    let start = match from {
        Source::Local => branch.to_owned(),
        Source::Remote(remote) => format!("refs/remotes/{remote}/{branch}"),
        Source::Base { sha, .. } => sha.clone(),
    };
    ensure(root, path, branch, &start)
}

/// Makes `path` a detached worktree of `root` at `start`, a commit, for a read or review session: reuses it when it
/// already is one.
pub fn ensure_detached(root: &Path, path: &Path, start: &str) -> Result<(), GitError> {
    match worktree_branch(root, path)? {
        Some(None) if path.exists() => return Ok(()),
        // Its directory was deleted: only this one record goes, as in `restore`.
        Some(None) => {
            git(
                root,
                &["worktree", "remove", "--force", &path.to_string_lossy()],
            )?;
        }
        Some(Some(on)) => {
            return Err(GitError(format!(
                "{} is already a worktree on {on}, not detached",
                path.display()
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
    git(
        root,
        &[
            "worktree",
            "add",
            "--detach",
            &path.to_string_lossy(),
            start,
        ],
    )?;
    Ok(())
}

/// Removes a read or review session's detached worktree, build output and any stray edits included: it holds no work
/// of its own.
pub fn remove_detached(root: &Path, path: &Path) -> Result<(), GitError> {
    if worktree_branch(root, path)?.is_some() {
        git(
            root,
            &["worktree", "remove", "--force", &path.to_string_lossy()],
        )?;
    }
    Ok(())
}

/// Whether the worktree at `path` has changes git hasn't committed; gitignored files don't count.
pub fn uncommitted(path: &Path) -> Result<bool, GitError> {
    Ok(!git(path, &["status", "--porcelain"])?.trim().is_empty())
}

/// Removes every worktree of a project that is going: each worktree of `root` that git records under `dir` (fleetd's
/// own directory under the node home), uncommitted changes and build output included, and git's record of one whose
/// directory is already gone; then `dir` itself. Nothing else git records is touched (no `git worktree prune`, which
/// would also drop the records of the person's own worktrees that are missing for now). Branches stay, so every
/// commit stays reachable, and nothing in the checkout's working tree changes. With the checkout itself gone, or a
/// root that isn't a git repository (a Navi's folder, any plain folder), only `dir` goes. Returns how many worktrees
/// it removed.
pub fn remove_all(root: &Path, dir: &Path) -> Result<usize, GitError> {
    let mut removed = 0;
    if root.is_dir() && git(root, &["rev-parse", "--git-dir"]).is_ok() {
        let real = dir.canonicalize().ok();
        let list = git(root, &["worktree", "list", "--porcelain"])?;
        let ours: Vec<&str> = list
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .filter(|p| {
                let p = Path::new(p);
                p != dir
                    && (p.starts_with(dir) || real.as_deref().is_some_and(|r| p.starts_with(r)))
            })
            .collect();
        for path in ours {
            git(root, &["worktree", "remove", "--force", path])?;
            removed += 1;
        }
    }
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            return Err(GitError(format!("cannot remove {}: {e}", dir.display())));
        }
        _ => {}
    }
    Ok(removed)
}

/// The PR keywords that end a repo's path in a PR URL.
const PR_SEGMENTS: [&str; 4] = ["pull", "pulls", "merge_requests", "pull-requests"];

/// A PR's number from its URL on any host: `…/pull/7` (GitHub, Gitea, Forgejo), `…/-/merge_requests/7` (GitLab),
/// `…/pull-requests/7` (Bitbucket).
fn pr_number(url: &str) -> Option<u64> {
    let path = url.split(['?', '#']).next()?;
    let segments: Vec<&str> = path.split('/').collect();
    segments.windows(2).find_map(|w| {
        PR_SEGMENTS
            .contains(&w[0])
            .then(|| w[1].parse().ok())
            .flatten()
    })
}

/// The repo a PR belongs to, as `host/owner/name` in lowercase: `https://github.com/o/r/pull/7` is `github.com/o/r`,
/// `https://gitlab.com/g/sub/r/-/merge_requests/8` is `gitlab.com/g/sub/r`.
fn pr_repo(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let mut segments: Vec<&str> = rest.split(['?', '#']).next()?.split('/').collect();
    let at = segments.iter().position(|s| PR_SEGMENTS.contains(s))?;
    segments.truncate(at);
    if segments.last() == Some(&"-") {
        segments.pop();
    }
    repo_key(&segments.join("/"))
}

/// A remote's repo as `host/owner/name` in lowercase, from any of git's URL forms: `https://host/o/r.git`,
/// `ssh://git@host:22/o/r`, `git@host:o/r.git`. `None` for a local path.
fn remote_repo(url: &str) -> Option<String> {
    let rest = match url.split_once("://") {
        Some((_, rest)) => rest.to_owned(),
        // scp-like `[user@]host:path`, which has a colon before any slash.
        None => {
            let (host, path) = url.split_once(':')?;
            if host.contains('/') {
                return None;
            }
            format!("{host}/{path}")
        }
    };
    repo_key(&rest)
}

/// `[user@]host[:port]/path[.git][/]` as `host/path`, lowercased; `None` without both.
fn repo_key(rest: &str) -> Option<String> {
    let (host, path) = rest.split_once('/')?;
    let host = host.rsplit('@').next()?.split(':').next()?;
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    (!host.is_empty() && !path.is_empty()).then(|| format!("{host}/{path}").to_lowercase())
}

/// The remote whose URL is `repo`'s: `origin` first, then `upstream` (a fork's PRs are often upstream's), then any
/// other. `None` when none is, rather than a guess.
fn pr_remote(root: &Path, repo: &str) -> Option<String> {
    let remotes = git(root, &["remote"]).ok()?;
    let mut remotes: Vec<&str> = remotes.lines().filter(|r| !r.is_empty()).collect();
    remotes.sort_by_key(|r| match *r {
        "origin" => 0,
        "upstream" => 1,
        _ => 2,
    });
    remotes.into_iter().find_map(|remote| {
        // As configured: `url.<base>.insteadOf` rewrites only where git connects.
        let url = git(root, &["config", "--get", &format!("remote.{remote}.url")]).ok()?;
        (remote_repo(url.trim()).as_deref() == Some(repo)).then(|| remote.to_owned())
    })
}

/// The head commit of the PR at `url`, fetched from the remote the PR belongs to (its URL is the PR's repo), from
/// whichever of GitHub's, GitLab's or Bitbucket's PR refs it publishes, into the object store alone: no ref, no
/// FETCH_HEAD, nothing of the human's moves. An error when no remote is the PR's repo.
pub fn pr_head(root: &Path, url: &str) -> Result<String, String> {
    let n = pr_number(url).ok_or_else(|| format!("no PR number in {url}"))?;
    let repo = pr_repo(url).ok_or_else(|| format!("no repo in {url}"))?;
    let remote = pr_remote(root, &repo).ok_or_else(|| format!("no remote is {repo}"))?;
    let refs = [
        format!("refs/pull/{n}/head"),
        format!("refs/merge-requests/{n}/head"),
        format!("refs/pull-requests/{n}/from"),
    ];
    let mut args = vec!["ls-remote", remote.as_str()];
    args.extend(refs.iter().map(String::as_str));
    let listed = git_remote(root, &args, LS_REMOTE_TIMEOUT).map_err(|e| e.0)?;
    let (sha, name) = listed
        .lines()
        .find_map(|l| l.split_once('\t'))
        .ok_or_else(|| format!("{remote} publishes no ref for PR {n}"))?;
    let (sha, name) = (sha.trim().to_owned(), name.trim().to_owned());
    if ref_sha(root, &sha).is_none() {
        git_remote(
            root,
            &[
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                &remote,
                &name,
            ],
            FETCH_TIMEOUT,
        )
        .map_err(|e| e.0)?;
    }
    ref_sha(root, &sha).ok_or_else(|| format!("{name} fetched without its commit {sha}"))
}

/// How [`remove`]'s refusals start: `kept <path>: <why>`. The hub's worktree sweep reads them as work kept, not as a
/// removal that failed.
pub const KEPT: &str = "kept ";
pub const UNCOMMITTED: &str = "it has uncommitted changes";
pub const UNPUSHED: &str = "not pushed";

/// Removes the worktree, build output included, and deletes its branch only when `base_ref` already contains it, so
/// unmerged work stays reachable. Refuses, keeping it, while it holds work that exists nowhere else: uncommitted
/// changes (gitignored files don't count) or commits on neither a remote branch nor `base_ref`. Returns whether the
/// branch was deleted.
pub fn remove(root: &Path, path: &Path, branch: &str, base_ref: &str) -> Result<bool, GitError> {
    if worktree_branch(root, path)?.is_some() {
        if !git(path, &["status", "--porcelain"])?.trim().is_empty() {
            return Err(GitError(format!("{KEPT}{}: {UNCOMMITTED}", path.display())));
        }
        let unpushed = git(
            path,
            &[
                "rev-list",
                "--count",
                "HEAD",
                "--not",
                "--remotes",
                base_ref,
            ],
        )?;
        if unpushed.trim() != "0" {
            return Err(GitError(format!(
                "{KEPT}{}: {} commit(s) {UNPUSHED}",
                path.display(),
                unpushed.trim()
            )));
        }
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
    // A query: without optional locks, git doesn't refresh and rewrite the index of the person's own checkout.
    let status = git(
        cwd,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
        ],
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

/// What a worktree's changes are measured from: the remote's copy of the branch its PRs target, as last fetched
/// (by a start's fresh base, or the writer itself), whatever `recorded` (the base it started from) says. A session
/// that started from a stale local `main`, or a writer that rebased onto a newer base since, then lists only what
/// it changed. Read-only: it fetches nothing and writes nothing to the person's checkout. `recorded` when there is
/// no such copy.
pub fn changes_base(root: &Path, recorded: &str) -> String {
    let Some(remote) = remote(root) else {
        return recorded.to_owned();
    };
    let name = recorded
        .strip_prefix(&format!("{remote}/"))
        .unwrap_or(recorded);
    let tracking = format!("{remote}/{name}");
    if ref_sha(root, &format!("refs/remotes/{tracking}")).is_some() {
        tracking
    } else {
        recorded.to_owned()
    }
}

/// The remote worktrees are based on: `origin`, else the only remote. A fork's `origin` is where the human pushes and
/// the train merges, so an `upstream` beside it is never picked.
pub fn remote(root: &Path) -> Option<String> {
    let remotes = git(root, &["remote"]).ok()?;
    let remotes: Vec<&str> = remotes.lines().filter(|r| !r.is_empty()).collect();
    match remotes.as_slice() {
        [only] => Some((*only).to_owned()),
        _ => remotes.contains(&"origin").then(|| "origin".to_owned()),
    }
}

/// A repo's root and one of its remotes.
type RemoteKey = (PathBuf, String);

/// When a remote told us its default branch, and what it said: `None` when it answered but named none.
type Said = (Instant, Option<String>);

/// What each repo's remote last said its default branch is.
static HEADS: LazyLock<Mutex<HashMap<RemoteKey, Said>>> = LazyLock::new(Default::default);

pub(super) fn ref_sha(root: &Path, name: &str) -> Option<String> {
    git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{name}^{{commit}}"),
        ],
    )
    .ok()
    .map(|s| s.trim().to_owned())
    .filter(|s| !s.is_empty())
}

/// `refs/remotes/<remote>/HEAD` as a branch name.
fn cached_head(root: &Path, remote: &str) -> Option<String> {
    let head = git(
        root,
        &[
            "symbolic-ref",
            "--short",
            &format!("refs/remotes/{remote}/HEAD"),
        ],
    )
    .ok()?;
    head.trim()
        .strip_prefix(&format!("{remote}/"))
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
}

/// The remote's default branch: asked of the remote at most hourly, which also mends a `HEAD` that a repo made with
/// `git init` and pushed never had, or one a renamed default branch left stale; when the remote can't be asked, or
/// names none, its cached `HEAD`.
fn remote_default(root: &Path, remote: &str) -> Option<String> {
    asked_head(root, remote)
        .flatten()
        .or_else(|| cached_head(root, remote))
}

/// What the remote says its default branch is, asked at most hourly: `Some(None)` when it answered but named none (a
/// bare remote whose HEAD points at a branch it doesn't have), `None` when it couldn't be asked.
fn asked_head(root: &Path, remote: &str) -> Option<Option<String>> {
    let key = (root.to_path_buf(), remote.to_owned());
    if let Some((at, name)) = HEADS.lock().unwrap().get(&key)
        && at.elapsed() < HEAD_FRESH
    {
        return Some(name.clone());
    }
    let asked = git_remote(
        root,
        &["ls-remote", "--symref", remote, "HEAD"],
        LS_REMOTE_TIMEOUT,
    )
    .map(|out| {
        out.lines().find_map(|l| {
            let (target, name) = l.strip_prefix("ref: refs/heads/")?.split_once('\t')?;
            (name == "HEAD" && !target.is_empty()).then(|| target.to_owned())
        })
    });
    match asked {
        Ok(Some(name)) => {
            // Caches it for git too; set-head refuses a branch not fetched yet, and the fetch then sets it.
            if cached_head(root, remote).as_deref() != Some(name.as_str()) {
                let _ = git(root, &["remote", "set-head", remote, &name]);
            }
            HEADS
                .lock()
                .unwrap()
                .insert(key, (Instant::now(), Some(name.clone())));
            Some(Some(name))
        }
        Ok(None) => {
            tracing::warn!(root = %root.display(), "{remote} names no default branch");
            HEADS.lock().unwrap().insert(key, (Instant::now(), None));
            Some(None)
        }
        Err(e) => {
            tracing::warn!(root = %root.display(), "cannot ask {remote} for its default branch: {e}");
            None
        }
    }
}

/// Whether the repo at `root` has any commit, on any branch or remote-tracking ref: a new repo has none.
pub fn has_commit(root: &Path) -> bool {
    git(root, &["rev-list", "-n", "1", "--all"]).is_ok_and(|out| !out.trim().is_empty())
}

/// The branch checked out at `root`.
fn current_branch(root: &Path) -> Option<String> {
    git(root, &["symbolic-ref", "--short", "HEAD"])
        .ok()
        .map(|b| b.trim().to_owned())
        .filter(|b| !b.is_empty())
}

/// The repo's default branch as a short name: the remote's (see [`remote_default`]). The branch checked out at
/// `root` only when there is no remote, or the remote can't be asked and has never said: a writer then starts from
/// that local branch, as offline, rather than not at all.
pub fn default_branch(root: &Path) -> Option<String> {
    remote(root)
        .and_then(|remote| remote_default(root, &remote))
        .or_else(|| current_branch(root))
}

/// Why a fetch failed, from git's stderr.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FetchError {
    /// The network, or a connection cut short: the host's name doesn't resolve, the connection is refused, reset or
    /// times out, or there is no route.
    Offline,
    /// git can't run ssh: it isn't installed.
    NoSsh(String),
    /// The remote refused the credentials; the agent's pushes will fail the same way.
    Auth(String),
    /// The remote answered that there is no such repository: a wrong URL or name, or credentials that can't see it
    /// (GitHub and GitLab say "not found" for a private repo the key can't read).
    NoAccess(String),
    Other(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Offline => f.write_str("offline"),
            FetchError::NoSsh(line)
            | FetchError::Auth(line)
            | FetchError::NoAccess(line)
            | FetchError::Other(line) => f.write_str(line),
        }
    }
}

impl FetchError {
    fn base_error(&self) -> BaseError {
        let kind = match self {
            FetchError::Offline => BaseErrorKind::Offline,
            FetchError::NoSsh(_) => BaseErrorKind::NoSsh,
            FetchError::Auth(_) => BaseErrorKind::Auth,
            FetchError::NoAccess(_) => BaseErrorKind::NoAccess,
            FetchError::Other(_) => BaseErrorKind::Failed,
        };
        BaseError {
            kind,
            message: self.to_string(),
        }
    }

    fn of(e: &GitError) -> Self {
        Self::of_text(&e.0)
    }

    /// Why a fetch failed, from what git printed (the hub's landing scanner reads it from a node command's output).
    pub fn of_text(text: &str) -> Self {
        let has = |needles: &[&str]| needles.iter().any(|n| text.contains(n));
        // The first line git explains itself on, without our "git … failed: " prefix.
        let line = text
            .split_once(" failed: ")
            .map_or(text, |(_, rest)| rest)
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or_default()
            .trim()
            .to_owned();
        // The network first: a dropped or refused connection says nothing about access, whatever git adds after it.
        if has(&[
            "timed out after",
            "kex_exchange_identification",
            "Connection closed by remote host",
            "Connection reset by peer",
            "Broken pipe",
            "Could not resolve host",
            "Could not resolve hostname",
            "Temporary failure in name resolution",
            "Connection refused",
            "Connection timed out",
            "Operation timed out",
            "Network is unreachable",
            "No route to host",
            "Failed to connect",
        ]) {
            FetchError::Offline
        } else if has(&[
            "ssh: not found",
            "cannot run ssh",
            "ssh: No such file or directory",
        ]) {
            FetchError::NoSsh(line)
        } else if has(&[
            "Authentication failed",
            "Permission denied (publickey",
            "could not read Username",
            "could not read Password",
            "error: 403",
            "Host key verification failed",
        ]) {
            FetchError::Auth(line)
        } else if has(&[
            "Repository not found",
            "does not appear to be a git repository",
            "could not be found",
        ]) {
            FetchError::NoAccess(line)
        } else {
            FetchError::Other(line)
        }
    }
}

/// When each branch was last fetched, and how it went.
type Fetched = HashMap<String, (Instant, Result<(), FetchError>)>;

/// Each project and remote's last fetches. Its lock lets one fetch run at a time per project and remote, and a start
/// that waited on it takes that fetch's result; other projects never wait.
static FETCHES: LazyLock<Mutex<HashMap<RemoteKey, Arc<Mutex<Fetched>>>>> =
    LazyLock::new(Default::default);

/// Brings `refs/remotes/<remote>/<branch>` up to date and nothing else: never the human's branches or working tree.
/// A fetch under 30 s old is reused, failed or not, so a burst of spawns waits on the network once.
pub(super) fn fetch(root: &Path, remote: &str, branch: &str) -> Result<(), FetchError> {
    let per_root = FETCHES
        .lock()
        .unwrap()
        .entry((root.to_path_buf(), remote.to_owned()))
        .or_default()
        .clone();
    let mut last = per_root.lock().unwrap();
    if let Some((at, result)) = last.get(branch)
        && at.elapsed() < FETCH_FRESH
    {
        return result.clone();
    }
    let refspec = format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}");
    // FETCH_HEAD is the human's: their `git pull` or `git merge FETCH_HEAD` reads it.
    let args = [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        remote,
        refspec.as_str(),
    ];
    let mut result = git_remote(root, &args, FETCH_TIMEOUT);
    // The human's own fetch racing ours.
    if result
        .as_ref()
        .is_err_and(|e| e.0.contains("cannot lock ref"))
    {
        result = git_remote(root, &args, FETCH_TIMEOUT);
    }
    let result = result.map(|_| ()).map_err(|e| {
        tracing::warn!(root = %root.display(), "cannot fetch {remote}/{branch}: {e}");
        FetchError::of(&e)
    });
    last.insert(branch.to_owned(), (Instant::now(), result.clone()));
    result
}

/// Where a new writer's branch starts.
#[derive(Debug, PartialEq, Eq)]
pub struct Base {
    /// What the session's changes and merged check compare against: `origin/main`, or a local branch when there is
    /// no remote or no copy of it.
    pub base_ref: String,
    pub sha: String,
    /// When `base_ref` was last fetched, RFC 3339; `None` for a local branch, or when git can't tell.
    pub fetched_at: Option<String>,
    /// Why the base may be behind the remote.
    pub error: Option<BaseError>,
    /// A fork only: the commits `upstream`'s copy of the branch has that `base_ref` lacks, as last fetched.
    pub fork_behind: Option<u32>,
    /// `error` as the node logs it: "based on origin/main as of 10-24 18:02 UTC (fetch failed: offline)".
    pub note: Option<String>,
}

/// When `name` (a remote-tracking ref) last moved: from its reflog, else when git last wrote the ref (a clone packs it
/// and writes no reflog).
fn fetched_at(root: &Path, name: &str) -> Option<DateTime<Utc>> {
    let logged = git(
        root,
        &["log", "-g", "-1", "--format=%gd", "--date=unix", name],
    )
    .ok()
    .and_then(|out| {
        let out = out.trim();
        let secs = out[out.find("@{")? + 2..out.rfind('}')?].parse().ok()?;
        DateTime::from_timestamp(secs, 0)
    });
    logged.or_else(|| {
        [name, "packed-refs"].into_iter().find_map(|file| {
            let path = git(
                root,
                &["rev-parse", "--path-format=absolute", "--git-path", file],
            )
            .ok()?;
            let written = std::fs::metadata(path.trim()).ok()?.modified().ok()?;
            Some(DateTime::<Utc>::from(written))
        })
    })
}

fn rfc3339(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// When each project's upstream was last brought up to date for [`fork_behind`].
static UPSTREAM_CHECKED: LazyLock<Mutex<HashMap<PathBuf, Instant>>> =
    LazyLock::new(Default::default);

/// A fork's lag: the commits upstream's own default branch has that `<remote>/<name>` lacks, as last fetched. Upstream
/// is asked for its default branch and fetched behind the start, at most every 10 minutes, so no start waits on it and
/// the next start counts what it brought. Unknown, and nothing fetched, while upstream can't say its default branch.
fn fork_behind(root: &Path, remote: &str, name: &str) -> Option<u32> {
    if remote == UPSTREAM || !git(root, &["remote"]).ok()?.lines().any(|r| r == UPSTREAM) {
        return None;
    }
    let due = UPSTREAM_CHECKED
        .lock()
        .unwrap()
        .get(root)
        .is_none_or(|at| at.elapsed() >= UPSTREAM_EVERY);
    if due {
        UPSTREAM_CHECKED
            .lock()
            .unwrap()
            .insert(root.to_path_buf(), Instant::now());
        let r = root.to_path_buf();
        std::thread::spawn(move || {
            if let Some(Some(upstream)) = asked_head(&r, UPSTREAM) {
                let _ = fetch(&r, UPSTREAM, &upstream);
            }
        });
    }
    // What upstream last said, without asking it.
    // What upstream last said, without asking it; once it said it names none, a cached branch is no answer.
    let said = HEADS
        .lock()
        .unwrap()
        .get(&(root.to_path_buf(), UPSTREAM.to_owned()))
        .map(|(_, n)| n.clone());
    let upstream = match said {
        Some(said) => said?,
        None => cached_head(root, UPSTREAM)?,
    };
    let range = format!("refs/remotes/{remote}/{name}..refs/remotes/{UPSTREAM}/{upstream}");
    git(root, &["rev-list", "--count", &range])
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// The start point for a new branch whose PRs target `name`, the default branch the hub asked for: the remote's
/// `name` freshly fetched. Offline or refused, the last fetched copy, else the local branch `name`, each with an error
/// saying so. With no remote, the local `name`, else the branch checked out at `root`. A remote that names no default
/// branch is an error too: `name` then came from a cached `HEAD` or the branch checked out at `root`, so the start says
/// so rather than quietly basing on it.
pub fn fresh_base(root: &Path, name: &str) -> Result<Base, GitError> {
    let Some(remote) = remote(root) else {
        let name = if ref_sha(root, &format!("refs/heads/{name}")).is_some() {
            name.to_owned()
        } else {
            current_branch(root).ok_or_else(|| {
                GitError(format!("{} has no branch to start from", root.display()))
            })?
        };
        let sha = ref_sha(root, &format!("refs/heads/{name}"))
            .ok_or_else(|| GitError(format!("{} has no commit on {name}", root.display())))?;
        return Ok(Base {
            note: Some(format!("no remote: from local {name}")),
            error: Some(BaseError {
                kind: BaseErrorKind::NoRemote,
                message: "no remote".into(),
            }),
            fetched_at: None,
            fork_behind: None,
            base_ref: name,
            sha,
        });
    };
    // What the remote last said, as the hub's `DefaultBranch` asked just before; never asked again here, so an
    // unreachable remote costs a start one timeout, the fetch's.
    let said = HEADS
        .lock()
        .unwrap()
        .get(&(root.to_path_buf(), remote.clone()))
        .filter(|(at, _)| at.elapsed() < HEAD_FRESH)
        .map(|(_, name)| name.clone());
    let headless = (said == Some(None)).then(|| BaseError {
        kind: BaseErrorKind::NoDefaultBranch,
        message: format!(
            "{remote} names no default branch: its HEAD points at a branch it doesn't have"
        ),
    });
    let fetched = fetch(root, &remote, name);
    let tracking = format!("{remote}/{name}");
    let tracking_sha = ref_sha(root, &format!("refs/remotes/{tracking}"));
    let failed = match fetched {
        Ok(()) => {
            if let Some(sha) = tracking_sha {
                // The remote's HEAD named a branch not fetched yet when it was asked, so git's copy waited for this.
                // Never when it named none: `name` may be the human's feature branch.
                let asked = said.flatten();
                let cached = cached_head(root, &remote);
                if headless.is_none()
                    && (cached.is_none()
                        || (asked.as_deref() == Some(name) && cached.as_deref() != Some(name)))
                {
                    let _ = git(root, &["remote", "set-head", &remote, name]);
                }
                return Ok(Base {
                    note: headless
                        .as_ref()
                        .map(|e| format!("based on {tracking} ({})", e.message)),
                    error: headless,
                    fetched_at: Some(rfc3339(Utc::now())),
                    fork_behind: fork_behind(root, &remote, name),
                    base_ref: tracking,
                    sha,
                });
            }
            FetchError::Other(format!("{tracking} is missing after the fetch"))
        }
        Err(e) => e,
    };
    let error = headless.unwrap_or_else(|| failed.base_error());
    let why = match error.kind {
        BaseErrorKind::NoDefaultBranch => error.message.clone(),
        _ => format!("fetch failed: {failed}"),
    };
    if let Some(sha) = tracking_sha {
        let at = fetched_at(root, &format!("refs/remotes/{tracking}"));
        let when = at.map_or_else(
            || "an unknown time".to_owned(),
            |at| at.format("%m-%d %H:%M UTC").to_string(),
        );
        return Ok(Base {
            note: Some(format!("based on {tracking} as of {when} ({why})")),
            fetched_at: at.map(rfc3339),
            error: Some(error),
            fork_behind: fork_behind(root, &remote, name),
            base_ref: tracking,
            sha,
        });
    }
    match ref_sha(root, &format!("refs/heads/{name}")) {
        Some(sha) => Ok(Base {
            note: Some(format!("based on local {name} ({why})")),
            fetched_at: None,
            error: Some(error),
            fork_behind: None,
            base_ref: name.to_owned(),
            sha,
        }),
        None if error.kind == BaseErrorKind::NoDefaultBranch => Err(GitError(format!(
            "{why}, and there is no {tracking} or local {name} to start from"
        ))),
        None => Err(GitError(format!(
            "can't reach {remote} and have no copy of {tracking} ({why})"
        ))),
    }
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
        pushed(&path, "fleetd/s1");
        // Removed with pushed, unmerged work: the branch stays, and a resume checks it out again at the same path.
        assert!(!remove(&root, &path, "fleetd/s1", "main").unwrap());
        assert!(!path.exists());
        ensure(&root, &path, "fleetd/s1", "main").unwrap();
        assert!(path.join("b.txt").exists());

        // A plain directory in the way is refused, not adopted.
        let squatter = dir.path().join("wt/p1/s2");
        std::fs::create_dir_all(&squatter).unwrap();
        assert!(ensure(&root, &squatter, "fleetd/s2", "main").is_err());
    }

    /// A bare repo at `<dir>/<name>.git` holding `repo`'s `main`, and a clone of it at `<dir>/<name>` whose remote is
    /// called `remote`.
    pub(crate) fn cloned(dir: &Path, name: &str, remote: &str) -> (PathBuf, PathBuf) {
        let bare = dir.join(format!("{name}.git"));
        let clone = dir.join(name);
        let source = repo(&dir.join(format!("{name}-source")));
        let path = |p: &Path| p.to_string_lossy().into_owned();
        run(
            dir,
            &["clone", "-q", "--bare", &path(&source), &path(&bare)],
        );
        run(
            dir,
            &["clone", "-q", "-o", remote, &path(&bare), &path(&clone)],
        );
        (bare, clone)
    }

    fn commit(path: &Path, file: &str) {
        std::fs::write(path.join(file), "x\n").unwrap();
        run(path, &["add", "."]);
        run(path, &["commit", "-q", "-m", file]);
    }

    /// What a person or a cleanup can do to a session's worktree: delete its directory, and its branch with it.
    fn lose(root: &Path, path: &Path, branch: Option<&str>) {
        std::fs::remove_dir_all(path).unwrap();
        if let Some(branch) = branch {
            run(
                root,
                &["worktree", "remove", "--force", &path.to_string_lossy()],
            );
            run(root, &["branch", "-q", "-D", branch]);
        }
    }

    /// What the node does for a session whose worktree is gone.
    fn rebuild(root: &Path, path: &Path, branch: &str, base_ref: &str) -> Source {
        let from = source(root, branch, base_ref).unwrap();
        restore(root, path, branch, &from).unwrap();
        from
    }

    fn registered(root: &Path, path: &Path) -> bool {
        let list = git(root, &["worktree", "list", "--porcelain"]).unwrap();
        let want = format!("worktree {}", path.display());
        list.lines().any(|l| l == want)
    }

    #[test]
    fn a_lost_worktree_comes_back_from_its_local_branch_with_its_commits() {
        let dir = tempfile::tempdir().unwrap();
        let (_, root) = cloned(dir.path(), "repo", "origin");
        let path = dir.path().join("wt/p1/s1");
        ensure(&root, &path, "fleetd/s1", "origin/main").unwrap();
        commit(&path, "b.txt");
        std::fs::write(path.join("draft.txt"), "d\n").unwrap();
        // The directory is deleted, but git still has it registered on the branch.
        lose(&root, &path, None);
        let from = rebuild(&root, &path, "fleetd/s1", "origin/main");
        assert_eq!(from, Source::Local);
        assert!(path.join("b.txt").exists());
        assert!(!path.join("draft.txt").exists());
        assert!(
            from.note("fleetd/s1")
                .contains("from your local branch fleetd/s1")
        );
    }

    #[test]
    fn a_rebuild_forgets_only_its_own_worktree_never_the_humans_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        let (_, root) = cloned(dir.path(), "repo", "origin");
        let path = dir.path().join("wt/p1/s1");
        ensure(&root, &path, "fleetd/s1", "origin/main").unwrap();
        // The human's own worktree, on a disk that isn't mounted right now.
        let theirs = dir.path().join("usb/feature");
        run(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                &theirs.to_string_lossy(),
            ],
        );
        let theirs = theirs.canonicalize().unwrap();
        std::fs::remove_dir_all(&theirs).unwrap();
        lose(&root, &path, None);
        assert_eq!(
            rebuild(&root, &path, "fleetd/s1", "origin/main"),
            Source::Local
        );
        assert!(
            registered(&root, &theirs),
            "the human's worktree keeps its record"
        );
        assert!(branch_exists(&root, "feature"));
    }

    #[test]
    fn a_lost_worktree_and_branch_come_back_from_the_pushed_branch_fetched_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let (bare, root) = cloned(dir.path(), "repo", "origin");
        let path = dir.path().join("wt/p1/s1");
        ensure(&root, &path, "fleetd/s1", "origin/main").unwrap();
        commit(&path, "pushed.txt");
        run(&path, &["push", "-q", "origin", "fleetd/s1"]);
        commit(&path, "unpushed.txt");
        // Someone else adds to the pushed branch: only a fetch sees it.
        let other = dir.path().join("other");
        run(
            dir.path(),
            &[
                "clone",
                "-q",
                "-b",
                "fleetd/s1",
                &bare.to_string_lossy(),
                &other.to_string_lossy(),
            ],
        );
        commit(&other, "theirs.txt");
        run(&other, &["push", "-q", "origin", "fleetd/s1"]);

        lose(&root, &path, Some("fleetd/s1"));
        let from = rebuild(&root, &path, "fleetd/s1", "origin/main");
        assert_eq!(from, Source::Remote("origin".into()));
        assert!(path.join("pushed.txt").exists());
        assert!(
            path.join("theirs.txt").exists(),
            "fetched, not the stale copy"
        );
        assert!(!path.join("unpushed.txt").exists());
        assert!(from.note("fleetd/s1").contains("from origin/fleetd/s1"));
        assert_eq!(from.kind(), WorktreeSource::Remote);

        // The remote is out of reach: the copy from the last fetch still holds what was pushed.
        lose(&root, &path, Some("fleetd/s1"));
        run(
            &root,
            &[
                "remote",
                "set-url",
                "origin",
                &dir.path().join("gone.git").to_string_lossy(),
            ],
        );
        assert_eq!(
            rebuild(&root, &path, "fleetd/s1", "origin/main"),
            Source::Remote("origin".into())
        );
        assert!(path.join("theirs.txt").exists());
    }

    #[test]
    fn a_branch_pushed_to_a_remote_not_called_origin_is_found_there() {
        let dir = tempfile::tempdir().unwrap();
        let (_, root) = cloned(dir.path(), "repo", "upstream");
        // An `origin` that never had the branch comes first, and is passed over.
        let (origin, _) = cloned(dir.path(), "mirror", "origin");
        run(
            &root,
            &["remote", "add", "origin", &origin.to_string_lossy()],
        );
        let path = dir.path().join("wt/p1/s1");
        ensure(&root, &path, "fleetd/s1", "upstream/main").unwrap();
        commit(&path, "pushed.txt");
        run(&path, &["push", "-q", "upstream", "fleetd/s1"]);
        // Only the remote has it: a lost node home leaves no remote-tracking ref either.
        lose(&root, &path, Some("fleetd/s1"));
        run(
            &root,
            &["update-ref", "-d", "refs/remotes/upstream/fleetd/s1"],
        );
        assert_eq!(
            rebuild(&root, &path, "fleetd/s1", "upstream/main"),
            Source::Remote("upstream".into())
        );
        assert!(path.join("pushed.txt").exists());
    }

    #[test]
    fn a_lost_worktree_never_pushed_starts_again_from_a_fresh_base() {
        let dir = tempfile::tempdir().unwrap();
        let (bare, root) = cloned(dir.path(), "repo", "origin");
        let path = dir.path().join("wt/p1/s1");
        ensure(&root, &path, "fleetd/s1", "origin/main").unwrap();
        commit(&path, "local-only.txt");
        // main moves on upstream after the session started: a new task would start from it.
        let other = dir.path().join("other");
        run(
            dir.path(),
            &[
                "clone",
                "-q",
                &bare.to_string_lossy(),
                &other.to_string_lossy(),
            ],
        );
        commit(&other, "upstream.txt");
        run(&other, &["push", "-q", "origin", "main"]);
        lose(&root, &path, Some("fleetd/s1"));
        let from = rebuild(&root, &path, "fleetd/s1", "origin/main");
        assert!(
            matches!(&from, Source::Base { base_ref, .. } if base_ref == "origin/main"),
            "{from:?}"
        );
        assert!(
            path.join("upstream.txt").exists(),
            "the fresh base, as for a new task"
        );
        assert!(!path.join("local-only.txt").exists());
        let note = from.note("fleetd/s1");
        assert!(
            note.contains("neither here nor pushed") && note.contains("from origin/main"),
            "{note}"
        );
    }

    /// What a push leaves behind: the remote-tracking ref.
    fn pushed(path: &Path, branch: &str) {
        run(
            path,
            &[
                "update-ref",
                &format!("refs/remotes/origin/{branch}"),
                "HEAD",
            ],
        );
    }

    #[test]
    fn remove_keeps_a_worktree_with_uncommitted_or_unpushed_work() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        let path = dir.path().join("wt/p1/s1");
        ensure(&root, &path, "fleetd/s1", "main").unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(path.join(".gitignore"), "target/\n").unwrap();
        run(&path, &["add", "."]);
        run(&path, &["commit", "-q", "-m", "ignore"]);
        pushed(&path, "fleetd/s1");

        std::fs::write(path.join("draft.txt"), "d\n").unwrap();
        assert!(remove(&root, &path, "fleetd/s1", "main").is_err());
        assert!(
            path.join("draft.txt").exists(),
            "an untracked file keeps it"
        );

        run(&path, &["add", "."]);
        run(&path, &["commit", "-q", "-m", "draft"]);
        assert!(remove(&root, &path, "fleetd/s1", "main").is_err());
        assert!(
            path.join("draft.txt").exists(),
            "an unpushed commit keeps it"
        );

        pushed(&path, "fleetd/s1");
        std::fs::create_dir_all(path.join("target/debug")).unwrap();
        std::fs::write(path.join("target/debug/build-output"), "x").unwrap();
        assert!(!remove(&root, &path, "fleetd/s1", "main").unwrap());
        assert!(
            !path.exists(),
            "pushed work goes, gitignored build output with it"
        );
        assert!(branch_exists(&root, "fleetd/s1"));
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
        assert!(!path.exists());
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

    /// A remote on a port nothing listens on: the connection is refused, as offline.
    const REFUSED: &str = "http://127.0.0.1:1/origin.git";

    fn sha(dir: &Path, rev: &str) -> String {
        git(dir, &["rev-parse", rev]).unwrap().trim().to_owned()
    }

    fn clone(from: &Path, to: &Path) {
        let (from, to) = (from.to_string_lossy(), to.to_string_lossy());
        run(Path::new("/"), &["clone", "-q", &from, &to]);
    }

    /// Someone else's work landing on the remote's `branch`.
    fn land(origin: &Path, branch: &str, file: &str) -> String {
        let scratch = tempfile::tempdir().unwrap();
        let work = scratch.path().join("w");
        clone(origin, &work);
        run(&work, &["checkout", "-q", "-B", branch]);
        std::fs::write(work.join(file), "x\n").unwrap();
        run(&work, &["add", "."]);
        run(&work, &["commit", "-q", "-m", file]);
        run(
            &work,
            &["push", "-q", "origin", &format!("HEAD:refs/heads/{branch}")],
        );
        sha(&work, "HEAD")
    }

    /// A bare `origin.git` on `main` and the human's clone of it, `checkout`.
    fn origin_and_checkout(dir: &Path) -> (PathBuf, PathBuf) {
        let seed = repo(dir);
        let origin = dir.join("origin.git");
        run(
            dir,
            &[
                "clone",
                "-q",
                "--bare",
                &seed.to_string_lossy(),
                &origin.to_string_lossy(),
            ],
        );
        let checkout = dir.join("checkout");
        clone(&origin, &checkout);
        (origin, checkout)
    }

    /// A writer that touched two files lists two, however far main has moved and whichever base its session
    /// recorded: a stale local `main` (sessions from before fresh bases, or a failed fetch) or the remote's copy.
    #[test]
    fn changes_are_measured_from_a_fresh_merge_base_with_the_remote() {
        let dir = tempfile::tempdir().unwrap();
        let (origin, checkout) = origin_and_checkout(dir.path());
        let path = dir.path().join("wt/p1/s1");
        ensure(&checkout, &path, "fleetd/s1", "origin/main").unwrap();
        for file in ["app/one.txt", "app/two.txt"] {
            std::fs::create_dir_all(path.join("app")).unwrap();
            std::fs::write(path.join(file), "w\n").unwrap();
        }
        run(&path, &["add", "."]);
        run(&path, &["commit", "-q", "-m", "two files"]);
        // Others land on main, and the writer rebases onto it; the human's local main stays where it was.
        for file in ["ci.yml", "release.sh", "docs.md"] {
            land(&origin, "main", file);
        }
        run(&path, &["fetch", "-q", "origin"]);
        run(&path, &["rebase", "-q", "origin/main"]);
        for file in ["site.html", "three.txt"] {
            land(&origin, "main", file);
        }

        assert_eq!(
            changes(&path, Some("main")).unwrap().len(),
            5,
            "against the stale local main, main's own commits count"
        );
        for recorded in ["main", "origin/main"] {
            let base = changes_base(&checkout, recorded);
            assert_eq!(base, "origin/main", "{recorded}");
            assert_eq!(
                changes(&path, Some(&base)).unwrap(),
                ["app/one.txt", "app/two.txt"],
                "{recorded}"
            );
        }
    }

    /// Everything a person's checkout keeps that a query could change: its config and every ref.
    fn checkout_state(root: &Path) -> (String, String) {
        (
            git(root, &["config", "--local", "--list"]).unwrap(),
            git(
                root,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname) %(symref)",
                ],
            )
            .unwrap(),
        )
    }

    /// Asking what a writer changed is a read: it neither fetches into the person's checkout nor sets its remote's
    /// HEAD, even when the remote has moved and git has no copy of that HEAD.
    #[test]
    fn a_changes_query_leaves_the_checkouts_config_and_refs_alone() {
        let dir = tempfile::tempdir().unwrap();
        let (origin, checkout) = origin_and_checkout(dir.path());
        let path = dir.path().join("wt/p1/s1");
        ensure(&checkout, &path, "fleetd/s1", "origin/main").unwrap();
        std::fs::write(path.join("mine.txt"), "w\n").unwrap();
        run(&checkout, &["remote", "set-head", "origin", "-d"]);
        land(&origin, "main", "theirs.txt");
        let before = checkout_state(&checkout);

        for recorded in ["main", "origin/main"] {
            let base = changes_base(&checkout, recorded);
            assert_eq!(base, "origin/main");
            assert_eq!(changes(&path, Some(&base)).unwrap(), ["mine.txt"]);
        }
        assert_eq!(checkout_state(&checkout), before);
    }

    #[test]
    fn a_new_worktree_starts_from_the_remote_not_the_stale_local_main() {
        let dir = tempfile::tempdir().unwrap();
        let (origin, checkout) = origin_and_checkout(dir.path());
        let stale = sha(&checkout, "main");
        // The human's own last fetch, which their `git pull` reads back.
        run(&checkout, &["fetch", "-q", "origin"]);
        let fetch_head = std::fs::read_to_string(checkout.join(".git/FETCH_HEAD")).unwrap();
        let fresh = land(&origin, "main", "upstream.txt");
        // The human is on a feature branch with work in progress.
        run(&checkout, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(checkout.join("wip.txt"), "wip\n").unwrap();

        assert_eq!(default_branch(&checkout).as_deref(), Some("main"));
        let base = fresh_base(&checkout, "main").unwrap();
        assert_eq!(
            (base.base_ref.as_str(), base.sha.as_str()),
            ("origin/main", fresh.as_str())
        );
        assert_eq!(
            (base.error, base.note, base.fork_behind),
            (None, None, None)
        );
        // Fetched just now.
        let at = DateTime::parse_from_rfc3339(base.fetched_at.as_deref().unwrap()).unwrap();
        assert!((Utc::now() - at.to_utc()).num_seconds() < 60);
        let path = dir.path().join("wt/p1/s1");
        ensure(&checkout, &path, "fleetd/s1", &base.sha).unwrap();
        assert_eq!(sha(&path, "HEAD"), fresh);
        assert!(path.join("upstream.txt").exists());
        // The new branch tracks nothing, and the fetch touched only the remote-tracking ref.
        assert!(git(&path, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_err());
        assert_eq!(sha(&checkout, "main"), stale);
        assert_eq!(
            git(&checkout, &["symbolic-ref", "--short", "HEAD"])
                .unwrap()
                .trim(),
            "feature"
        );
        assert!(checkout.join("wip.txt").exists());
        assert_eq!(
            std::fs::read_to_string(checkout.join(".git/FETCH_HEAD")).unwrap(),
            fetch_head
        );
        // Changes compare against the remote, so upstream's commits aren't the session's.
        std::fs::write(path.join("mine.txt"), "m\n").unwrap();
        assert_eq!(changes(&path, Some(&base.base_ref)).unwrap(), ["mine.txt"]);

        // A fetch under 30 s old is reused: a burst of spawns fetches once.
        let later = land(&origin, "main", "later.txt");
        assert_eq!(fresh_base(&checkout, "main").unwrap().sha, fresh);
        assert_ne!(later, fresh);
    }

    #[test]
    fn a_repo_that_was_init_and_pushed_asks_the_remote_for_its_default_branch() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = repo(dir.path());
        let origin = dir.path().join("origin.git");
        run(
            dir.path(),
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "trunk",
                &origin.to_string_lossy(),
            ],
        );
        run(
            &checkout,
            &["remote", "add", "origin", &origin.to_string_lossy()],
        );
        run(&checkout, &["push", "-q", "origin", "main:trunk"]);
        run(&checkout, &["checkout", "-q", "-b", "feature"]);
        assert_eq!(cached_head(&checkout, "origin"), None);

        // Not `feature`, the branch checked out, and not `main`, the local name.
        assert_eq!(default_branch(&checkout).as_deref(), Some("trunk"));
        let base = fresh_base(&checkout, "trunk").unwrap();
        assert_eq!(base.base_ref, "origin/trunk");
        assert_eq!(base.sha, sha(&origin, "trunk"));
        assert_eq!(cached_head(&checkout, "origin").as_deref(), Some("trunk"));
    }

    #[test]
    fn a_renamed_default_branch_is_followed() {
        let dir = tempfile::tempdir().unwrap();
        let (origin, checkout) = origin_and_checkout(dir.path());
        assert_eq!(cached_head(&checkout, "origin").as_deref(), Some("main"));
        let trunk = land(&origin, "trunk", "t.txt");
        run(&origin, &["symbolic-ref", "HEAD", "refs/heads/trunk"]);
        run(&origin, &["branch", "-q", "-D", "main"]);

        assert_eq!(default_branch(&checkout).as_deref(), Some("trunk"));
        let base = fresh_base(&checkout, "trunk").unwrap();
        assert_eq!(
            (base.base_ref.as_str(), base.sha.as_str()),
            ("origin/trunk", trunk.as_str())
        );
        assert_eq!(cached_head(&checkout, "origin").as_deref(), Some("trunk"));
    }

    #[test]
    fn offline_starts_from_the_last_fetched_copy_then_the_local_branch_then_fails() {
        let dir = tempfile::tempdir().unwrap();
        let (origin, checkout) = origin_and_checkout(dir.path());
        let fetched = land(&origin, "main", "u.txt");
        run(&checkout, &["fetch", "-q", "origin"]);
        let local = sha(&checkout, "main");
        run(&checkout, &["remote", "set-url", "origin", REFUSED]);

        // The cached HEAD answers when the remote can't.
        assert_eq!(default_branch(&checkout).as_deref(), Some("main"));
        let base = fresh_base(&checkout, "main").unwrap();
        assert_eq!(
            (base.base_ref.as_str(), base.sha.as_str()),
            ("origin/main", fetched.as_str())
        );
        let note = base.note.unwrap();
        assert!(note.starts_with("based on origin/main as of "), "{note}");
        assert!(note.ends_with(" (fetch failed: offline)"), "{note}");
        assert_eq!(base.error.unwrap().kind, BaseErrorKind::Offline);
        // As of the last fetch, the human's own.
        assert!(base.fetched_at.is_some());

        run(&checkout, &["update-ref", "-d", "refs/remotes/origin/main"]);
        let base = fresh_base(&checkout, "main").unwrap();
        assert_eq!(
            (
                base.base_ref.as_str(),
                base.sha.as_str(),
                base.note.as_deref()
            ),
            (
                "main",
                local.as_str(),
                Some("based on local main (fetch failed: offline)")
            )
        );
        assert_eq!(base.fetched_at, None);

        run(&checkout, &["checkout", "-q", "--detach"]);
        run(&checkout, &["branch", "-q", "-D", "main"]);
        let e = fresh_base(&checkout, "main").unwrap_err();
        assert_eq!(
            e.0,
            "can't reach origin and have no copy of origin/main (fetch failed: offline)"
        );
    }

    /// A remote whose path is gone answers, so it isn't offline: the URL is wrong, and a person has to fix it.
    #[test]
    fn a_remote_that_is_gone_is_no_access_not_offline() {
        let dir = tempfile::tempdir().unwrap();
        let (origin, checkout) = origin_and_checkout(dir.path());
        std::fs::rename(&origin, dir.path().join("moved.git")).unwrap();
        let base = fresh_base(&checkout, "main").unwrap();
        assert_eq!(base.base_ref, "origin/main");
        let error = base.error.unwrap();
        assert_eq!(error.kind, BaseErrorKind::NoAccess);
        assert!(
            error
                .message
                .ends_with("does not appear to be a git repository"),
            "{}",
            error.message
        );
    }

    #[test]
    fn starts_that_arrive_together_share_one_fetch_and_other_projects_never_wait() {
        let dir = tempfile::tempdir().unwrap();
        let (_, slow) = origin_and_checkout(&dir.path().join("a"));
        let count = dir.path().join("fetches");
        // A remote that takes 2 s to fail, counting each time it is asked.
        let ssh = format!(
            "echo x >> '{}'; sleep 2; echo 'ssh: connect to host example.invalid port 22: Connection timed out' >&2; \
             exit 255 #",
            count.display()
        );
        run(&slow, &["config", "core.sshCommand", &ssh]);
        // Else git first runs it with -G to learn which ssh it is.
        run(&slow, &["config", "ssh.variant", "simple"]);
        run(
            &slow,
            &["remote", "set-url", "origin", "ssh://example.invalid/a.git"],
        );
        let (origin, fast) = origin_and_checkout(&dir.path().join("b"));
        let fresh = land(&origin, "main", "b.txt");

        let starts: Vec<_> = (0..3)
            .map(|_| {
                let slow = slow.clone();
                std::thread::spawn(move || fresh_base(&slow, "main").unwrap())
            })
            .collect();
        std::thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        assert_eq!(fresh_base(&fast, "main").unwrap().sha, fresh);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "waited on another project's fetch"
        );
        for start in starts {
            let note = start.join().unwrap().note.unwrap();
            // A fresh clone has no reflog for the ref; when it was written still dates it.
            assert!(note.starts_with("based on origin/main as of "), "{note}");
            assert!(!note.contains("unknown"), "{note}");
            assert!(note.ends_with("(fetch failed: offline)"), "{note}");
        }
        assert_eq!(std::fs::read_to_string(&count).unwrap().lines().count(), 1);
    }

    #[test]
    fn offline_with_a_remote_that_never_said_its_default_branch_the_local_branch_is_used() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        run(&root, &["remote", "add", "origin", REFUSED]);
        assert_eq!(cached_head(&root, "origin"), None);

        assert_eq!(default_branch(&root).as_deref(), Some("main"));
        let base = fresh_base(&root, "main").unwrap();
        assert_eq!(
            (base.base_ref, base.sha, base.note.as_deref()),
            (
                "main".to_owned(),
                sha(&root, "main"),
                Some("based on local main (fetch failed: offline)")
            )
        );
    }

    #[test]
    fn with_no_remote_the_base_is_the_local_default_branch() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        run(&root, &["checkout", "-q", "-b", "feature"]);
        let base = fresh_base(&root, "main").unwrap();
        assert_eq!(
            base,
            Base {
                base_ref: "main".into(),
                sha: sha(&root, "main"),
                fetched_at: None,
                error: Some(BaseError {
                    kind: BaseErrorKind::NoRemote,
                    message: "no remote".into()
                }),
                fork_behind: None,
                note: Some("no remote: from local main".into())
            }
        );
        // A name the repo doesn't have: the branch checked out.
        assert_eq!(fresh_base(&root, "trunk").unwrap().base_ref, "feature");
    }

    #[test]
    fn the_remote_is_origin_even_in_a_fork_else_the_only_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        assert_eq!(remote(&root), None);
        run(&root, &["remote", "add", "upstream", "/nowhere/upstream"]);
        assert_eq!(remote(&root).as_deref(), Some("upstream"));
        run(&root, &["remote", "add", "origin", "/nowhere/fork"]);
        assert_eq!(remote(&root).as_deref(), Some("origin"));
        run(&root, &["remote", "add", "mirror", "/nowhere/mirror"]);
        run(&root, &["remote", "remove", "origin"]);
        assert_eq!(remote(&root), None);
    }

    #[test]
    fn a_remote_that_names_no_default_branch_says_so_and_is_never_cached() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = repo(dir.path());
        let origin = dir.path().join("origin.git");
        // A bare remote whose HEAD points at `main`, which was never pushed; only `feature` was.
        run(
            dir.path(),
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                &origin.to_string_lossy(),
            ],
        );
        run(
            &checkout,
            &["remote", "add", "origin", &origin.to_string_lossy()],
        );
        run(&checkout, &["checkout", "-q", "-b", "feature"]);
        run(&checkout, &["push", "-q", "origin", "feature"]);

        // The hub then asks for the branch checked out; the start says the remote named none.
        assert_eq!(default_branch(&checkout).as_deref(), Some("feature"));
        let base = fresh_base(&checkout, "feature").unwrap();
        assert_eq!(base.base_ref, "origin/feature");
        let error = base.error.unwrap();
        assert_eq!(error.kind, BaseErrorKind::NoDefaultBranch);
        assert_eq!(
            error.message,
            "origin names no default branch: its HEAD points at a branch it doesn't have"
        );
        assert_eq!(
            base.note.as_deref(),
            Some(
                "based on origin/feature (origin names no default branch: its HEAD points at a branch it doesn't have)"
            )
        );
        // The feature branch never becomes origin/HEAD.
        assert_eq!(cached_head(&checkout, "origin"), None);
    }

    #[test]
    fn a_fork_behind_upstream_counts_the_commits_it_lacks() {
        let dir = tempfile::tempdir().unwrap();
        let (origin, checkout) = origin_and_checkout(dir.path());
        let upstream = dir.path().join("upstream.git");
        run(
            dir.path(),
            &[
                "clone",
                "-q",
                "--bare",
                &origin.to_string_lossy(),
                &upstream.to_string_lossy(),
            ],
        );
        // Upstream's default branch is `trunk`, two ahead of the fork's `main`; its `main` is stale.
        land(&upstream, "trunk", "u1.txt");
        run(&upstream, &["symbolic-ref", "HEAD", "refs/heads/trunk"]);
        land(&upstream, "trunk", "u2.txt");
        run(
            &checkout,
            &["remote", "add", "upstream", &upstream.to_string_lossy()],
        );
        // Not fetched yet: unknown, and the start doesn't wait for it.
        assert_eq!(fresh_base(&checkout, "main").unwrap().fork_behind, None);
        // A later start counts what the fetch behind the first one brought.
        let started = Instant::now();
        let base = loop {
            let base = fresh_base(&checkout, "main").unwrap();
            if base.fork_behind.is_some() || started.elapsed() > Duration::from_secs(10) {
                break base;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(base.base_ref, "origin/main");
        assert_eq!(base.fork_behind, Some(2));
    }

    /// Upstream once named `main`, which is cached, then its HEAD lost its branch: the count is unknown, not counted
    /// against the cached branch.
    #[test]
    fn an_upstream_that_stops_naming_its_default_branch_is_unknown_despite_a_cached_one() {
        let dir = tempfile::tempdir().unwrap();
        let (origin, checkout) = origin_and_checkout(dir.path());
        let upstream = dir.path().join("upstream.git");
        run(
            dir.path(),
            &[
                "clone",
                "-q",
                "--bare",
                &origin.to_string_lossy(),
                &upstream.to_string_lossy(),
            ],
        );
        land(&upstream, "main", "u1.txt");
        run(
            &checkout,
            &["remote", "add", "upstream", &upstream.to_string_lossy()],
        );
        run(&checkout, &["fetch", "-q", "upstream"]);
        run(&checkout, &["remote", "set-head", "upstream", "main"]);
        assert_eq!(cached_head(&checkout, "upstream").as_deref(), Some("main"));
        run(&upstream, &["symbolic-ref", "HEAD", "refs/heads/gone"]);

        // The first start, before upstream has been asked, counts against the cached branch and asks behind it.
        assert_eq!(fresh_base(&checkout, "main").unwrap().fork_behind, Some(1));
        let started = Instant::now();
        while HEADS
            .lock()
            .unwrap()
            .get(&(checkout.clone(), UPSTREAM.to_owned()))
            .is_none()
            && started.elapsed() < Duration::from_secs(10)
        {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(fresh_base(&checkout, "main").unwrap().fork_behind, None);
        assert_eq!(cached_head(&checkout, "upstream").as_deref(), Some("main"));
    }

    /// An upstream that names no default branch is left alone: no count, and nothing fetched on later starts.
    #[test]
    fn an_upstream_with_no_default_branch_is_skipped_quietly() {
        let dir = tempfile::tempdir().unwrap();
        let (_, checkout) = origin_and_checkout(dir.path());
        let upstream = dir.path().join("upstream.git");
        run(
            dir.path(),
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "gone",
                &upstream.to_string_lossy(),
            ],
        );
        run(
            &checkout,
            &["push", "-q", &upstream.to_string_lossy(), "main:other"],
        );
        run(
            &checkout,
            &["remote", "add", "upstream", &upstream.to_string_lossy()],
        );
        assert_eq!(fresh_base(&checkout, "main").unwrap().fork_behind, None);
        std::thread::sleep(Duration::from_secs(1));
        assert_eq!(fresh_base(&checkout, "main").unwrap().fork_behind, None);
        let fetched = git(&checkout, &["for-each-ref", "refs/remotes/upstream"]).unwrap();
        assert_eq!(fetched.trim(), "", "nothing of upstream's was fetched");
    }

    #[test]
    fn a_hung_remote_is_killed_at_the_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        // git appends the host and command, which the `#` turns into a comment.
        run(&root, &["config", "core.sshCommand", "sleep 30 #"]);
        run(
            &root,
            &["remote", "add", "origin", "ssh://example.invalid/repo.git"],
        );
        let started = Instant::now();
        let e = git_remote(
            &root,
            &["ls-remote", "origin", "HEAD"],
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(e.0.ends_with("timed out after 1 s"), "{e}");
        assert!(started.elapsed() < Duration::from_secs(10), "{e}");
        assert_eq!(FetchError::of(&e), FetchError::Offline);
    }

    #[test]
    fn a_pr_number_is_read_from_any_hosts_url() {
        for (url, n) in [
            ("https://github.com/o/r/pull/7", Some(7)),
            ("https://github.com/o/r/pull/7/files#diff", Some(7)),
            ("https://gitea.example.com/o/r/pulls/12", Some(12)),
            (
                "https://gitlab.com/g/sub/r/-/merge_requests/8/diffs",
                Some(8),
            ),
            (
                "https://bitbucket.org/o/r/pull-requests/3?tab=diff",
                Some(3),
            ),
            ("https://git.example.com/o/r/commit/abc", None),
        ] {
            assert_eq!(pr_number(url), n, "{url}");
        }
    }

    #[test]
    fn a_prs_repo_and_a_remotes_are_read_from_any_hosts_urls() {
        for (url, repo) in [
            (
                "https://github.com/O/R/pull/7/files",
                Some("github.com/o/r"),
            ),
            (
                "https://gitlab.com/g/sub/r/-/merge_requests/8",
                Some("gitlab.com/g/sub/r"),
            ),
            (
                "https://bitbucket.org/o/r/pull-requests/3",
                Some("bitbucket.org/o/r"),
            ),
            ("https://github.com/o/r/commit/abc", None),
        ] {
            assert_eq!(pr_repo(url).as_deref(), repo, "{url}");
        }
        for (url, repo) in [
            ("https://github.com/o/r.git", Some("github.com/o/r")),
            ("https://user@github.com/o/r/", Some("github.com/o/r")),
            ("git@github.com:o/r.git", Some("github.com/o/r")),
            (
                "ssh://git@gitlab.com:2222/g/sub/r.git",
                Some("gitlab.com/g/sub/r"),
            ),
            ("/srv/git/r.git", None),
        ] {
            assert_eq!(remote_repo(url).as_deref(), repo, "{url}");
        }
    }

    #[test]
    fn fetch_failures_are_told_apart() {
        let of =
            |stderr: &str| FetchError::of(&GitError(format!("git fetch origin failed: {stderr}")));
        assert_eq!(
            of(
                "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/a/b.git/'"
            ),
            FetchError::Auth("remote: Invalid username or token.".into())
        );
        assert_eq!(
            of(
                "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."
            ),
            FetchError::Auth("git@github.com: Permission denied (publickey).".into())
        );
        assert!(matches!(
            of(
                "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
            ),
            FetchError::Auth(_)
        ));
        assert!(matches!(
            of(
                "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403"
            ),
            FetchError::Auth(_)
        ));
        assert_eq!(
            of(
                "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com"
            ),
            FetchError::Offline
        );
        assert_eq!(
            of(
                "ssh: Could not resolve hostname github.com: Temporary failure in name resolution\nfatal: Could not read \
                 from remote repository."
            ),
            FetchError::Offline
        );
        assert_eq!(
            of(
                "ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote \
                 repository."
            ),
            FetchError::Offline
        );
        assert_eq!(
            of(
                "ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote \
                 repository."
            ),
            FetchError::Offline
        );
        assert_eq!(
            of(
                "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443: \
                 Network is unreachable"
            ),
            FetchError::Offline
        );
        // Transient: a connection cut short is the network, whatever git adds after it.
        for transient in [
            "kex_exchange_identification: read: Connection reset by peer\nConnection reset by 140.82.121.4 port 22",
            "kex_exchange_identification: Connection closed by remote host\nfatal: Could not read from remote \
             repository.",
            "Connection closed by remote host\nfatal: Could not read from remote repository.",
            "client_loop: send disconnect: Broken pipe\nfatal: the remote end hung up unexpectedly",
            "ssh: connect to host github.com port 22: Connection timed out\nfatal: Authentication failed",
            "ssh: Could not resolve hostname github.com: Name or service not known\nERROR: Repository not found.",
            "ssh: connect to host github.com port 22: Network is unreachable",
        ] {
            assert_eq!(of(transient), FetchError::Offline, "{transient}");
        }
        // No ssh to run: only the doctor says so.
        assert_eq!(
            of("error: cannot run ssh: No such file or directory\nfatal: unable to fork"),
            FetchError::NoSsh("error: cannot run ssh: No such file or directory".into())
        );
        assert_eq!(
            of("sh: 1: ssh: not found\nfatal: Could not read from remote repository."),
            FetchError::NoSsh("sh: 1: ssh: not found".into())
        );
        // A missing key file is ssh's warning, not a missing ssh.
        assert!(matches!(
            of(
                "Warning: Identity file /home/u/.ssh/id_work not accessible: No such file or directory.\n\
                 git@github.com: Permission denied (publickey)."
            ),
            FetchError::Auth(_)
        ));
        // The remote answered: no such repository, or none these credentials can see.
        assert_eq!(
            of(
                "fatal: '/gone.git' does not appear to be a git repository\nfatal: Could not read from remote repository."
            ),
            FetchError::NoAccess(
                "fatal: '/gone.git' does not appear to be a git repository".into()
            )
        );
        assert_eq!(
            of("ERROR: Repository not found.\nfatal: Could not read from remote repository."),
            FetchError::NoAccess("ERROR: Repository not found.".into())
        );
        assert_eq!(
            of(
                "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found"
            ),
            FetchError::NoAccess("remote: Repository not found.".into())
        );
        assert!(matches!(
            of(
                "remote: The project you were looking for could not be found or you don't have permission to view \
                 it.\nfatal: repository 'https://gitlab.com/a/b.git/' not found"
            ),
            FetchError::NoAccess(_)
        ));
        // Neither the network nor a named access problem.
        assert_eq!(
            of("fatal: Could not read from remote repository."),
            FetchError::Other("fatal: Could not read from remote repository.".into())
        );
        assert_eq!(
            of("fatal: couldn't find remote ref refs/heads/trunk"),
            FetchError::Other("fatal: couldn't find remote ref refs/heads/trunk".into())
        );
    }
}
