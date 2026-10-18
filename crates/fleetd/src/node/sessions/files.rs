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

/// Writes the file, creating its directories, and keeps the attachments directory out of git.
pub fn put_file(root: &Path, rel_path: &str, bytes: &[u8]) -> Result<(), String> {
    if !attachment_path_ok(rel_path) {
        return Err(format!("{rel_path} is not under {ATTACHMENTS_DIR}"));
    }
    let path = root.join(rel_path);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("fleetd-part");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
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
        let dir = std::env::temp_dir().join(format!("fleetd-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
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
}
