//! Previews' worktrees: a few per project under `<node home>/previews/<project>/<n>`, detached worktrees of the
//! project's checkout. A slot outlives its preview and is the build cache: the next preview takes the slot that last
//! ran the same commits, so setup's skip-when-unchanged and the build's own output carry over, else the slot used
//! longest ago. Checking out resets tracked files and removes untracked ones, but keeps ignored ones (dependencies,
//! build output), which is the point.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use super::super::worktree::{self, GitError};

/// How long a fetch of the PR's branch may take.
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// What a slot records about the commits it holds, in its git directory.
const KEY: &str = "fleetd-preview-key";
/// What a slot records about the build it holds.
const BUILT: &str = "fleetd-preview-built";
/// Who merges an order's PRs together in a slot; nothing is pushed.
const MERGER: [&str; 4] = [
    "-c",
    "user.name=fleetd",
    "-c",
    "user.email=fleetd@localhost",
];

/// The slots in use now, across projects.
#[derive(Default)]
pub struct Slots {
    busy: Mutex<HashSet<PathBuf>>,
}

/// A slot a preview holds; it is free again when this drops.
pub struct Held {
    slots: Arc<Slots>,
    pub path: PathBuf,
}

impl Drop for Held {
    fn drop(&mut self) {
        self.slots.busy.lock().unwrap().remove(&self.path);
    }
}

/// Where a project's slots live.
pub fn project_dir(home: &Path, project_id: &str) -> PathBuf {
    home.join("previews").join(project_id)
}

/// A slot's app's pid file, beside it.
pub fn pid_file(slot: &Path) -> PathBuf {
    slot.with_extension("pid")
}

/// A slot's app's log, beside it.
pub fn log_file(slot: &Path) -> PathBuf {
    slot.with_extension("log")
}

/// The record of which commits a run wants: the same key in a slot means its worktree, setup and build are for them.
pub fn key_of(base: Option<&str>, shas: &[&str]) -> String {
    let mut key = base.map(|b| format!("{b}+")).unwrap_or_default();
    key.push_str(&shas.join("+"));
    key
}

impl Slots {
    /// A free slot of the project, at most `max`: the one holding `key` if free, else a new one, else the free one
    /// used longest ago. None: all `max` are in use.
    pub fn take(self: &Arc<Self>, dir: &Path, max: usize, key: &str) -> Option<Held> {
        let mut busy = self.busy.lock().unwrap();
        let slots: Vec<PathBuf> = (1..=max).map(|n| dir.join(n.to_string())).collect();
        let free: Vec<&PathBuf> = slots.iter().filter(|p| !busy.contains(*p)).collect();
        let pick = free
            .iter()
            .find(|p| read_marker(p, KEY).as_deref() == Some(key))
            .or_else(|| free.iter().find(|p| !p.exists()))
            .or_else(|| free.iter().min_by_key(|p| last_used(p)))
            .map(|p| (*p).clone())?;
        busy.insert(pick.clone());
        Some(Held {
            slots: self.clone(),
            path: pick,
        })
    }
}

fn last_used(slot: &Path) -> SystemTime {
    git_dir(slot)
        .and_then(|d| std::fs::metadata(d.join(KEY)).ok())
        .and_then(|m| m.modified().ok())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// The slot's own git directory (`.git/worktrees/<n>` in the project's checkout), where its markers live.
pub fn git_dir(slot: &Path) -> Option<PathBuf> {
    if !slot.exists() {
        return None;
    }
    worktree::git(slot, &["rev-parse", "--absolute-git-dir"])
        .ok()
        .map(|s| PathBuf::from(s.trim()))
}

fn read_marker(slot: &Path, name: &str) -> Option<String> {
    std::fs::read_to_string(git_dir(slot)?.join(name)).ok()
}

fn write_marker(slot: &Path, name: &str, value: Option<&str>) {
    let Some(dir) = git_dir(slot) else { return };
    let path = dir.join(name);
    let _ = match value {
        Some(v) => std::fs::write(path, v),
        None => std::fs::remove_file(path).map(|_| ()),
    };
}

/// A commit from the hub, before it reaches git: 40 hex digits.
pub fn check_sha(sha: &str) -> Result<(), String> {
    if sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("{sha:?} is not a commit's full SHA"))
    }
}

/// A branch from the hub, before it reaches git: never an option (a leading `-`), and a name git takes for a branch
/// (`git check-ref-format refs/heads/<name>`, which only reads the name).
pub fn check_branch(root: &Path, branch: &str) -> Result<(), String> {
    let refused = || Err(format!("{branch:?} is not a branch name"));
    if branch.is_empty() || branch.starts_with('-') || branch.contains('\0') {
        return refused();
    }
    match worktree::git(root, &["check-ref-format", &format!("refs/heads/{branch}")]) {
        Ok(_) => Ok(()),
        Err(_) => refused(),
    }
}

/// Fetches `branch` from the checkout's origin, and checks `sha` is there after it.
pub fn fetch(root: &Path, branch: &str, sha: &str) -> Result<(), String> {
    if !has_commit(root, sha) {
        worktree::git_remote(
            root,
            &["fetch", "--no-tags", "origin", "--", branch],
            FETCH_TIMEOUT,
        )
        .map_err(|GitError(e)| format!("couldn't fetch {branch}: {e}"))?;
    }
    if has_commit(root, sha) {
        Ok(())
    } else {
        Err(format!(
            "{branch} no longer has {}: it moved, so try it again",
            short(sha)
        ))
    }
}

/// The commit `origin/<base>` is at, fetched now.
pub fn fetch_base(root: &Path, base: &str) -> Result<String, String> {
    worktree::git_remote(
        root,
        &["fetch", "--no-tags", "origin", "--", base],
        FETCH_TIMEOUT,
    )
    .map_err(|GitError(e)| format!("couldn't fetch {base}: {e}"))?;
    worktree::git(root, &["rev-parse", "FETCH_HEAD^{commit}"])
        .map(|s| s.trim().to_owned())
        .map_err(|GitError(e)| e)
}

fn has_commit(root: &Path, sha: &str) -> bool {
    worktree::git(root, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_ok()
}

pub fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// Puts the slot at `start`: a new detached worktree, or the slot's own reset to it, ignored files kept.
pub fn checkout(root: &Path, slot: &Path, start: &str) -> Result<(), String> {
    let fresh = git_dir(slot).is_none();
    if fresh {
        if slot.exists() {
            // A slot whose worktree record is gone: its files are only a cache.
            let _ = std::fs::remove_dir_all(slot);
        }
        worktree::ensure_detached(root, slot, start).map_err(|GitError(e)| e)?;
        return Ok(());
    }
    // A merge a run left half done blocks the checkout.
    let _ = worktree::git(slot, &["merge", "--abort"]);
    worktree::git(
        slot,
        &["checkout", "--detach", "--force", "-q", start, "--"],
    )
    .and_then(|_| worktree::git(slot, &["clean", "-fdq"]))
    .map(|_| ())
    .map_err(|GitError(e)| e)
}

/// Merges `sha` into the slot's HEAD. On a conflict the merge is undone and the conflicting paths are named.
pub fn merge(slot: &Path, branch: &str, sha: &str) -> Result<(), String> {
    let mut args: Vec<&str> = MERGER.to_vec();
    args.extend(["merge", "--no-edit", "--no-ff", "-q", "--", sha]);
    if worktree::git(slot, &args).is_ok() {
        return Ok(());
    }
    let paths =
        worktree::git(slot, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
    let _ = worktree::git(slot, &["merge", "--abort"]);
    let paths: Vec<&str> = paths.lines().take(5).collect();
    Err(if paths.is_empty() {
        format!("{branch} doesn't merge onto the others")
    } else {
        format!(
            "{branch} doesn't merge onto the others: {}",
            paths.join(", ")
        )
    })
}

/// The commit the slot is at.
pub fn head(slot: &Path) -> Option<String> {
    worktree::git(slot, &["rev-parse", "HEAD"])
        .ok()
        .map(|s| s.trim().to_owned())
}

pub fn set_key(slot: &Path, key: Option<&str>) {
    write_marker(slot, KEY, key);
}

/// What the build at `head` with `command` is known as.
pub fn build_key(head: &str, command: &str) -> String {
    let mut h = Sha256::new();
    h.update(head.as_bytes());
    h.update([0]);
    h.update(command.as_bytes());
    format!("{:x}", h.finalize())
}

/// Whether the slot holds this build already.
pub fn built(slot: &Path, key: &str) -> bool {
    read_marker(slot, BUILT).as_deref() == Some(key)
}

pub fn set_built(slot: &Path, key: Option<&str>) {
    write_marker(slot, BUILT, key);
}
