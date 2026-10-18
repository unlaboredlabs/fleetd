//! Adding a project, the machine's half: find checkouts, look at one, clone one with git's progress, and run
//! `gh repo list` when gh is logged in here.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use fleetd_contracts::projects::ClonePhase;
use fleetd_contracts::sessions::{GhRepo, GhRepos, RepoFacts, ScannedRepo};
use tokio::io::AsyncReadExt;

use crate::cli::setup::detect::{REPO_ROOTS, find_repos, parse_git_remote};

/// The checkout scan stops after this many.
const MAX_REPOS: usize = 200;
/// `gh repo list` per owner.
const GH_LIMIT: &str = "100";

/// Where a clone goes by default: the first of ~/src, ~/code, ~/projects that exists, else ~/src.
pub fn clone_root(home: &Path) -> PathBuf {
    ["src", "code", "projects"]
        .iter()
        .map(|d| home.join(d))
        .find(|d| d.is_dir())
        .unwrap_or_else(|| home.join("src"))
}

pub fn scan(home: &Path) -> (String, Vec<ScannedRepo>) {
    let roots: Vec<PathBuf> = REPO_ROOTS.iter().map(|r| home.join(r)).collect();
    let mut repos: Vec<ScannedRepo> = find_repos(&roots)
        .into_iter()
        .filter(|r| !r.path.to_string_lossy().contains(PARTIAL))
        .map(|r| ScannedRepo {
            path: r.path.to_string_lossy().into_owned(),
            remote: r.remote,
        })
        .collect();
    // `~/src` and `~/Developer` can be one directory on a case-insensitive disk.
    repos.dedup_by(|a, b| a.path.eq_ignore_ascii_case(&b.path));
    repos.truncate(MAX_REPOS);
    (clone_root(home).to_string_lossy().into_owned(), repos)
}

pub fn inspect(path: &Path) -> RepoFacts {
    if !path.exists() {
        return RepoFacts::default();
    }
    let git = path.join(".git");
    let is_git = git.exists();
    if !is_git {
        return RepoFacts {
            exists: true,
            ..RepoFacts::default()
        };
    }
    let remote = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::fs::read_to_string(git.join("config"))
                .ok()
                .and_then(|c| parse_git_remote(&c))
        });
    let mut workflow_files: Vec<String> = std::fs::read_dir(path.join(".github/workflows"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".yml") || n.ends_with(".yaml"))
        .collect();
    workflow_files.sort();
    RepoFacts {
        exists: true,
        is_git,
        remote,
        default_branch: super::worktree::default_branch(path),
        workflow_files,
    }
}

/// One progress report from git's stderr: "Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Progress {
    pub phase: ClonePhase,
    pub percent: Option<u8>,
    pub detail: Option<String>,
}

pub fn parse_progress(line: &str) -> Option<Progress> {
    let line = line.trim();
    let line = line.strip_prefix("remote: ").unwrap_or(line);
    let (label, rest) = line.split_once(':')?;
    let phase = match label {
        "Receiving objects" => ClonePhase::Receiving,
        "Resolving deltas" => ClonePhase::Resolving,
        "Updating files" | "Checking out files" => ClonePhase::CheckingOut,
        "Enumerating objects" | "Counting objects" | "Compressing objects" => ClonePhase::Starting,
        _ => return None,
    };
    let rest = rest.trim();
    let percent = rest
        .split_once('%')
        .and_then(|(n, _)| n.trim().parse::<u8>().ok())
        .filter(|p| *p <= 100);
    // What follows the counts: "1.20 MiB | 2.00 MiB/s", without the trailing ", done."
    let detail = rest
        .split_once("), ")
        .map(|(_, d)| d.trim_end_matches(", done.").trim().to_owned())
        .filter(|d| !d.is_empty() && d != "done.");
    Some(Progress {
        phase,
        percent,
        detail,
    })
}

/// Whether gh is on PATH, without running it.
fn has_gh() -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join("gh").is_file()))
}

/// Clones `url` into `dest` with git, through gh's credentials when gh is installed (so private repos work wherever
/// `gh auth login` was run). Never prompts. The error is git's own last line.
pub async fn clone(
    url: &str,
    dest: &Path,
    add_id: &str,
    progress: impl FnMut(Progress) + Send,
) -> Result<(), String> {
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    // git writes into a sibling that is renamed into place only when complete, so `dest` existing always means a
    // whole clone (one cut off by a restart is never offered for reuse).
    let id: String = add_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(40)
        .collect();
    let partial = PathBuf::from(format!("{}{PARTIAL}{id}", dest.display()));
    let _ = std::fs::remove_dir_all(&partial);
    let result = git_clone(url, &partial, progress).await;
    let result = result.and_then(|()| {
        std::fs::rename(&partial, dest)
            .map_err(|e| format!("cannot move the clone into {}: {e}", dest.display()))
    });
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&partial);
    }
    result
}

/// The suffix of a clone in progress: `<dest>.fleetd-partial-<addId>`.
pub const PARTIAL: &str = ".fleetd-partial-";

/// Removes clones a previous node process left half done, under the usual source dirs (two levels down). Run at
/// start, before any clone.
pub fn remove_partials(home: &Path) -> usize {
    let mut removed = 0;
    let mut dirs: Vec<PathBuf> = REPO_ROOTS.iter().map(|r| home.join(r)).collect();
    let mut depth = 0;
    while depth < 2 && !dirs.is_empty() {
        let mut next = Vec::new();
        for dir in dirs {
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                    continue;
                }
                let path = entry.path();
                if entry.file_name().to_string_lossy().contains(PARTIAL) {
                    if std::fs::remove_dir_all(&path).is_ok() {
                        removed += 1;
                    }
                } else if !path.join(".git").exists() {
                    next.push(path);
                }
            }
        }
        dirs = next;
        depth += 1;
    }
    removed
}

async fn git_clone(
    url: &str,
    dest: &Path,
    mut progress: impl FnMut(Progress) + Send,
) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new("git");
    if has_gh() {
        cmd.args([
            "-c",
            "credential.https://github.com.helper=!gh auth git-credential",
        ]);
    }
    cmd.args(["clone", "--progress", "--", url])
        .arg(dest)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("git could not start: {e}"))?;
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut buf = [0u8; 4096];
    let mut line = Vec::new();
    let mut last_line = String::new();
    let mut last_sent: Option<(Instant, Progress)> = None;
    loop {
        let n = stderr.read(&mut buf).await.unwrap_or(0);
        if n == 0 {
            break;
        }
        // git rewrites one line with `\r` while a phase runs, and ends it with `\n`.
        for &b in &buf[..n] {
            if b != b'\r' && b != b'\n' {
                line.push(b);
                continue;
            }
            let text = String::from_utf8_lossy(&line).into_owned();
            line.clear();
            if text.trim().is_empty() {
                continue;
            }
            last_line = text.clone();
            let Some(p) = parse_progress(&text) else {
                continue;
            };
            let due = match &last_sent {
                None => true,
                Some((at, prev)) => {
                    prev.phase != p.phase
                        || (p.percent == Some(100) && prev.percent != Some(100))
                        || at.elapsed() >= Duration::from_millis(250)
                }
            };
            if due {
                last_sent = Some((Instant::now(), p.clone()));
                progress(p);
            }
        }
    }
    let status = child
        .wait()
        .await
        .map_err(|e| format!("git clone did not finish: {e}"))?;
    if status.success() {
        return Ok(());
    }
    let last = last_line.trim();
    let last = last.strip_prefix("fatal: ").unwrap_or(last);
    Err(if last.is_empty() {
        format!("git clone exited with {status}")
    } else {
        last.chars().take(500).collect()
    })
}

/// `gh repo list` for the logged-in user, then each org they belong to.
pub async fn gh_repo_list() -> GhRepos {
    async fn gh(args: &[&str]) -> Result<String, String> {
        let out = tokio::time::timeout(
            Duration::from_secs(30),
            tokio::process::Command::new("gh")
                .args(args)
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| "gh timed out after 30 s".to_owned())?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "gh is not installed".to_owned()
            } else {
                format!("gh could not start: {e}")
            }
        })?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        let lower = stderr.to_lowercase();
        if out.status.code() == Some(4)
            || lower.contains("gh auth login")
            || lower.contains("not logged")
        {
            return Err("gh is not logged in".into());
        }
        Err(stderr
            .trim()
            .lines()
            .last()
            .unwrap_or("gh failed")
            .to_owned())
    }
    let login = match gh(&["api", "user", "--jq", ".login"]).await {
        Ok(login) => login.trim().to_owned(),
        Err(problem) => {
            return GhRepos {
                problem: Some(problem),
                ..GhRepos::default()
            };
        }
    };
    let orgs = gh(&["api", "user/orgs", "--paginate", "--jq", ".[].login"])
        .await
        .unwrap_or_default();
    let mut owners = vec![login];
    owners.extend(
        orgs.lines()
            .map(str::trim)
            .filter(|o| !o.is_empty())
            .map(str::to_owned),
    );
    let mut repos = Vec::new();
    for owner in &owners {
        let fields = "nameWithOwner,url,isPrivate,description,pushedAt";
        if let Ok(text) = gh(&["repo", "list", owner, "--limit", GH_LIMIT, "--json", fields]).await
            && let Ok(mut rows) = serde_json::from_str::<Vec<GhRepo>>(&text)
        {
            repos.append(&mut rows);
        }
    }
    GhRepos {
        owners,
        repos,
        problem: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_git_clone_progress() {
        assert_eq!(
            parse_progress("Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s"),
            Some(Progress {
                phase: ClonePhase::Receiving,
                percent: Some(45),
                detail: Some("1.20 MiB | 2.00 MiB/s".into()),
            })
        );
        assert_eq!(
            parse_progress("Resolving deltas: 100% (20/20), done."),
            Some(Progress {
                phase: ClonePhase::Resolving,
                percent: Some(100),
                detail: None,
            })
        );
        assert_eq!(
            parse_progress("remote: Counting objects:  50% (5/10)").map(|p| p.phase),
            Some(ClonePhase::Starting)
        );
        assert_eq!(
            parse_progress("Updating files:  30% (3/10)").map(|p| (p.phase, p.percent)),
            Some((ClonePhase::CheckingOut, Some(30)))
        );
        assert_eq!(
            parse_progress("Cloning into '/home/me/src/storefront'..."),
            None
        );
        assert_eq!(parse_progress("fatal: repository not found"), None);
    }

    #[tokio::test]
    async fn clones_a_local_repo_and_inspects_it() {
        let dir = tempfile::tempdir().unwrap();
        let origin = crate::node::worktree::tests::repo(dir.path());
        std::fs::create_dir_all(origin.join(".github/workflows")).unwrap();
        std::fs::write(origin.join(".github/workflows/ci.yml"), "on: push\n").unwrap();
        crate::node::worktree::tests::run(&origin, &["add", "."]);
        crate::node::worktree::tests::run(&origin, &["commit", "-q", "-m", "ci"]);
        let dest = dir.path().join("src/storefront");
        let url = format!("file://{}", origin.display());
        clone(&url, &dest, "a1", |_| {}).await.unwrap();
        assert!(!dir.path().join("src/storefront.fleetd-partial-a1").exists());
        let facts = inspect(&dest);
        assert!(facts.is_git);
        assert_eq!(facts.remote.as_deref(), Some(url.as_str()));
        assert_eq!(facts.workflow_files, vec!["ci.yml".to_owned()]);
        assert!(facts.default_branch.is_some());
        let again = clone(&url, &dest, "a2", |_| {}).await.unwrap_err();
        assert!(again.contains("already exists"), "{again}");
        assert!(!inspect(&dir.path().join("missing")).exists);
    }

    #[tokio::test]
    async fn a_cut_off_clone_never_takes_the_destination() {
        let home = tempfile::tempdir().unwrap();
        let dest = home.path().join("src/storefront");
        // A failed clone leaves neither the destination nor its partial behind.
        let bad = format!("file://{}/nope", home.path().display());
        assert!(clone(&bad, &dest, "b1", |_| {}).await.is_err());
        assert!(!dest.exists());
        assert!(
            !home
                .path()
                .join("src/storefront.fleetd-partial-b1")
                .exists()
        );
        // A node killed mid-clone leaves a partial; the next start removes it and the scan never lists it.
        let partial = home.path().join("src/storefront.fleetd-partial-b2");
        std::fs::create_dir_all(partial.join(".git")).unwrap();
        let nested = home.path().join("src/acme/storefront.fleetd-partial-b3");
        std::fs::create_dir_all(nested.join(".git")).unwrap();
        assert!(scan(home.path()).1.is_empty());
        assert_eq!(remove_partials(home.path()), 2);
        assert!(!partial.exists() && !nested.exists());
    }
}
