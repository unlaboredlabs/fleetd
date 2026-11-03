//! `mac push`, the agent's node's half: the worktree as it is now (its commits, uncommitted changes and new files git
//! doesn't ignore) becomes one snapshot commit, made through a copy of the worktree's index so the real one is never
//! touched. Its parent is a snapshot the Mac's mirror holds already (the agent's own last one first), so git leaves
//! out every object that one has: only the rest go across, as a thin git pack.
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// Who a snapshot commit says made it: the worktree's own git config may have no identity.
const WHO: &[(&str, &str)] = &[
    ("GIT_AUTHOR_NAME", "fleetd mac"),
    ("GIT_AUTHOR_EMAIL", "mac@fleetd.invalid"),
    ("GIT_COMMITTER_NAME", "fleetd mac"),
    ("GIT_COMMITTER_EMAIL", "mac@fleetd.invalid"),
];

fn git(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git didn't run: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// The worktree's state now, as a commit on `parent` (one the Mac holds), or `parent` itself when nothing changed.
pub fn snapshot(worktree: &Path, scratch: &Path, parent: Option<&str>) -> Result<String, String> {
    let index = scratch.join("mac-push.index");
    let real = git(
        worktree,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        &[],
    )?;
    // A copy keeps the real index's stat cache, so only changed files are read again; none yet (no commit) is fine.
    let _ = std::fs::remove_file(&index);
    if Path::new(&real).exists() {
        std::fs::copy(&real, &index).map_err(|e| format!("the index wasn't copied: {e}"))?;
    }
    let index_env = index.to_string_lossy().into_owned();
    let env = [("GIT_INDEX_FILE", index_env.as_str())];
    let made = (|| {
        git(worktree, &["add", "--all", "."], &env)?;
        let tree = git(worktree, &["write-tree"], &env)?;
        if let Some(parent) = parent
            && git(worktree, &["rev-parse", &format!("{parent}^{{tree}}")], &[])
                .is_ok_and(|t| t == tree)
        {
            return Ok(parent.to_owned());
        }
        let mut args = vec!["commit-tree", tree.as_str(), "-m", "fleetd mac push"];
        if let Some(parent) = parent {
            args.extend(["-p", parent]);
        }
        git(worktree, &args, WHO)
    })();
    let _ = std::fs::remove_file(&index);
    made
}

/// The ids among `haves` this worktree's repository has too, in `haves`' order.
pub fn known(worktree: &Path, haves: &[String]) -> Vec<String> {
    haves
        .iter()
        .filter(|h| h.len() >= 40 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .filter(|h| {
            git(
                worktree,
                &["cat-file", "-e", &format!("{h}^{{commit}}")],
                &[],
            )
            .is_ok()
        })
        .cloned()
        .collect()
}

/// A thin pack of `snapshot`'s objects that `known` don't hold, written to a file in `scratch`.
pub fn pack(
    worktree: &Path,
    scratch: &Path,
    snapshot: &str,
    known: &[String],
) -> Result<PathBuf, String> {
    use std::io::Write;
    let path = scratch.join("mac-push.pack");
    let file = std::fs::File::create(&path).map_err(|e| format!("the pack wasn't made: {e}"))?;
    let mut child = std::process::Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(["pack-objects", "--revs", "--thin", "--stdout", "--quiet"])
        .stdin(Stdio::piped())
        .stdout(file)
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git didn't run: {e}"))?;
    let mut revs = format!("{snapshot}\n");
    for k in known {
        revs.push_str(&format!("^{k}\n"));
    }
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(revs.as_bytes())
            .map_err(|e| format!("git pack-objects didn't take its list: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("git pack-objects failed: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&path);
        return Err(format!(
            "git pack-objects failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(path)
}
