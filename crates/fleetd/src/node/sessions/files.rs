//! Project files for the app: the file list behind @-mentions, and attachments written under `.fleetd/attachments/`.
use std::path::{Component, Path};
use std::process::Command;

/// Where attachments go, repo-relative; kept out of git through `.git/info/exclude`.
pub const ATTACHMENTS_DIR: &str = ".fleetd/attachments/";
/// More than this many files and the list is cut (the app only shows the best 50 anyway).
const MAX_FILES: usize = 200_000;

/// `git ls-files -co --exclude-standard`: tracked and untracked files that are not ignored.
pub fn git_files(root: &Path) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-co", "--exclude-standard", "-z"])
        .output()
        .map_err(|e| format!("git did not run: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    Ok(out
        .stdout
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .take(MAX_FILES)
        .map(|p| String::from_utf8_lossy(p).into_owned())
        // git never descends into a symlinked directory; a symlink itself is left out too, so a mention never names a
        // path that leads out of the repo.
        .filter(|p| {
            std::fs::symlink_metadata(root.join(p)).is_ok_and(|m| !m.file_type().is_symlink())
        })
        .collect())
}

/// How well `query` matches `path` as a subsequence, case-insensitively; None when it does not. Higher is better:
/// matches in the file name, runs of adjacent characters and short paths win.
pub fn score(path: &str, query: &str) -> Option<i64> {
    let lower: Vec<char> = path.to_lowercase().chars().collect();
    let query: Vec<char> = query
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let name_start = lower.iter().rposition(|c| *c == '/').map_or(0, |i| i + 1);
    // Greedy from the file name first, then from the start: "digest" should find digest.rs, not the d of "fleetd".
    let best = [name_start, 0]
        .into_iter()
        .filter_map(|from| walk(&lower, from, name_start, &query))
        .max()?;
    Some(best * 1000 - lower.len() as i64)
}

fn walk(lower: &[char], from: usize, name_start: usize, query: &[char]) -> Option<i64> {
    let mut score = 0i64;
    let mut at = from;
    let mut last: Option<usize> = None;
    for q in query {
        let found = (at..lower.len()).find(|&i| lower[i] == *q)?;
        score += 1;
        if last.is_some_and(|l| l + 1 == found) {
            score += 5;
        }
        if found >= name_start {
            score += 3;
        }
        if found == 0 || matches!(lower[found - 1], '/' | '_' | '-' | '.') {
            score += 4;
        }
        last = Some(found);
        at = found + 1;
    }
    Some(score)
}

/// The best `limit` paths for `query`, and whether more matched.
pub fn rank(paths: &[String], query: &str, limit: usize) -> (Vec<String>, bool) {
    let mut scored: Vec<(i64, &String)> = paths
        .iter()
        .filter_map(|p| score(p, query).map(|s| (s, p)))
        .collect();
    let more = scored.len() > limit;
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    (
        scored
            .into_iter()
            .take(limit)
            .map(|(_, p)| p.clone())
            .collect(),
        more,
    )
}

/// `rel_path` stays inside `.fleetd/attachments/`.
pub fn attachment_path_ok(rel_path: &str) -> bool {
    let path = Path::new(rel_path);
    rel_path.starts_with(ATTACHMENTS_DIR)
        && path.components().all(|c| matches!(c, Component::Normal(_)))
        && path.components().count() >= 4
}

/// Writes the file, creating its directories, and keeps the attachments directory out of git. Every directory below
/// the workspace root is opened relative to its parent without following symlinks, and the file is created fresh
/// (never through a symlink) in the opened directory, then renamed into place there: a symlinked `.fleetd` or
/// attachments directory in the repo cannot send it outside the workspace.
pub fn put_file(root: &Path, rel_path: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    use nix::fcntl::{OFlag, openat, renameat};
    use nix::sys::stat::{Mode, mkdirat};

    if !attachment_path_ok(rel_path) {
        return Err(format!("{rel_path} is not under {ATTACHMENTS_DIR}"));
    }
    let path = Path::new(rel_path);
    let name = path
        .file_name()
        .ok_or_else(|| format!("{rel_path} names no file"))?;
    let refused = |what: &Path, e: nix::Error| match e {
        nix::Error::ELOOP | nix::Error::ENOTDIR => format!(
            "{} is a symlink or not a directory; refusing to write through it",
            what.display()
        ),
        e => format!("{}: {e}", what.display()),
    };
    let mut dir: std::os::fd::OwnedFd = std::fs::File::open(root)
        .map_err(|e| format!("{}: {e}", root.display()))?
        .into();
    let mut walked = std::path::PathBuf::new();
    for part in path.parent().into_iter().flat_map(Path::components) {
        let Component::Normal(part) = part else {
            return Err(format!("{rel_path} is not a plain relative path"));
        };
        walked.push(part);
        match mkdirat(&dir, part, Mode::from_bits_truncate(0o755)) {
            Ok(()) | Err(nix::Error::EEXIST) => {}
            Err(e) => return Err(refused(&walked, e)),
        }
        dir = openat(
            &dir,
            part,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| refused(&walked, e))?;
    }
    let tmp = format!(
        ".{}.fleetd-part-{}",
        name.to_string_lossy(),
        std::process::id()
    );
    let fd = openat(
        &dir,
        tmp.as_str(),
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::from_bits_truncate(0o644),
    )
    .map_err(|e| refused(&walked.join(&tmp), e))?;
    let mut file = std::fs::File::from(fd);
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    let moved = written
        .map_err(|e| e.to_string())
        .and_then(|()| renameat(&dir, tmp.as_str(), &dir, name).map_err(|e| e.to_string()));
    if let Err(e) = moved {
        let _ = nix::unistd::unlinkat(&dir, tmp.as_str(), nix::unistd::UnlinkatFlags::NoRemoveDir);
        return Err(e);
    }
    exclude_attachments(root)
}

fn exclude_attachments(root: &Path) -> Result<(), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--git-path", "info/exclude"])
        .output()
        .map_err(|e| format!("git did not run: {e}"))?;
    if !out.status.success() {
        // Not a git repository: nothing to keep it out of.
        return Ok(());
    }
    let exclude = root.join(String::from_utf8_lossy(&out.stdout).trim());
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    let line = format!("/{ATTACHMENTS_DIR}");
    if current.lines().any(|l| l.trim() == line) {
        return Ok(());
    }
    if let Some(dir) = exclude.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let sep = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    std::fs::write(&exclude, format!("{current}{sep}{line}\n")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_file_name_matches_and_runs_first() {
        let paths: Vec<String> = [
            "crates/fleetd/src/hub/leads/digest.rs",
            "crates/fleetd/src/hub/digests/mod.rs",
            "docs/design/guide.md",
            "crates/fleetd/src/hub/ledger/digest_text.rs",
        ]
        .map(String::from)
        .to_vec();
        let (best, more) = rank(&paths, "digest", 2);
        assert_eq!(
            best,
            vec![
                "crates/fleetd/src/hub/leads/digest.rs",
                "crates/fleetd/src/hub/ledger/digest_text.rs"
            ]
        );
        assert!(more);
        assert_eq!(rank(&paths, "zzz", 10).0, Vec::<String>::new());
        // An empty query lists the shortest paths first.
        assert_eq!(rank(&paths, "", 1).0, vec!["docs/design/guide.md"]);
    }

    #[test]
    fn attachments_stay_in_their_directory_and_out_of_git() {
        assert!(attachment_path_ok(".fleetd/attachments/W14/shot.png"));
        assert!(!attachment_path_ok(".fleetd/attachments/../../.bashrc"));
        assert!(!attachment_path_ok("src/main.rs"));
        assert!(!attachment_path_ok(".fleetd/attachments/W14"));
        let dir = scratch("put");
        let git = |args: &[&str]| {
            Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .unwrap()
        };
        git(&["init", "-q"]);
        put_file(&dir, ".fleetd/attachments/W14/shot.png", b"png").unwrap();
        put_file(&dir, ".fleetd/attachments/W14/two.txt", b"two").unwrap();
        assert_eq!(
            std::fs::read(dir.join(".fleetd/attachments/W14/shot.png")).unwrap(),
            b"png"
        );
        let exclude = std::fs::read_to_string(dir.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.matches("/.fleetd/attachments/").count(), 1);
        assert!(
            git_files(&dir).unwrap().is_empty(),
            "attachments are not project files"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fleetd-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_symlinked_fleetd_or_attachments_dir_cannot_take_a_file_outside() {
        use std::os::unix::fs::symlink;
        let outside = scratch("outside");
        // .fleetd itself is a symlink out of the repo.
        let repo = scratch("repo-1");
        symlink(&outside, repo.join(".fleetd")).unwrap();
        let err = put_file(&repo, ".fleetd/attachments/W1/x.txt", b"x").unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        // The attachments directory, or a W directory under it, is a symlink.
        let repo2 = scratch("repo-2");
        std::fs::create_dir_all(repo2.join(".fleetd")).unwrap();
        symlink(&outside, repo2.join(".fleetd/attachments")).unwrap();
        assert!(put_file(&repo2, ".fleetd/attachments/W1/x.txt", b"x").is_err());
        let repo3 = scratch("repo-3");
        std::fs::create_dir_all(repo3.join(".fleetd/attachments")).unwrap();
        symlink(&outside, repo3.join(".fleetd/attachments/W1")).unwrap();
        assert!(put_file(&repo3, ".fleetd/attachments/W1/x.txt", b"x").is_err());
        assert_eq!(
            std::fs::read_dir(&outside).unwrap().count(),
            0,
            "nothing landed outside"
        );
        // A symlink in the file's own place is replaced, never written through.
        let repo4 = scratch("repo-4");
        std::fs::create_dir_all(repo4.join(".fleetd/attachments/W1")).unwrap();
        symlink(
            outside.join("target"),
            repo4.join(".fleetd/attachments/W1/x.txt"),
        )
        .unwrap();
        put_file(&repo4, ".fleetd/attachments/W1/x.txt", b"x").unwrap();
        assert!(!outside.join("target").exists());
        for d in [outside, repo, repo2, repo3, repo4] {
            std::fs::remove_dir_all(d).unwrap();
        }
    }

    #[test]
    fn the_file_list_never_reaches_through_symlinks() {
        use std::os::unix::fs::symlink;
        let outside = scratch("list-outside");
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        let repo = scratch("list-repo");
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["init", "-q"])
            .output()
            .unwrap();
        std::fs::write(repo.join("a.rs"), "a").unwrap();
        symlink(&outside, repo.join("linked")).unwrap();
        symlink(outside.join("secret.txt"), repo.join("secret.txt")).unwrap();
        assert_eq!(git_files(&repo).unwrap(), vec!["a.rs".to_owned()]);
        std::fs::remove_dir_all(outside).unwrap();
        std::fs::remove_dir_all(repo).unwrap();
    }
}
