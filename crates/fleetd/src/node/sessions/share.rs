//! Each session's share of the machine: build tools and test runners held to its part of the CPUs, and a scratch dir
//! of its own on disk. With 20 agents building at once and no limit, every `cargo`, `make` and `go build` sized itself
//! to all the machine's cores, every `pnpm test` started a vitest worker per core (31 forks, 11 GB at peak), and their
//! temporary files and build output went to /tmp, which is often tmpfs and held in RAM.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::node::store::SessionRow;

/// The test runner's variable: vitest's worker count, the desktop's and the phone's suites alike.
const TEST_WORKERS_VAR: &str = "VITEST_MAX_WORKERS";

/// Test workers for an agent whose builds get `n` jobs: its share, but at least 4, since a suite of many small files
/// run on 2 workers takes minutes.
pub fn test_workers(n: u64) -> u64 {
    n.max(4)
}

/// The parallelism variables of the common build tools and the test runner, each with its value for `n` jobs.
fn jobs_vars(n: u64) -> [(&'static str, String); 5] {
    [
        ("CARGO_BUILD_JOBS", n.to_string()),
        ("MAKEFLAGS", format!("-j{n}")),
        ("CMAKE_BUILD_PARALLEL_LEVEL", n.to_string()),
        ("GOFLAGS", format!("-p={n}")),
        (TEST_WORKERS_VAR, test_workers(n).to_string()),
    ]
}

/// The build and test parallelism variables for `n` jobs that `env` (the user's own setup, `claude.env` included) doesn't
/// already set: a person's own choice stands.
pub fn jobs_env(env: &[(String, String)], n: u64) -> Vec<(String, String)> {
    jobs_vars(n)
        .into_iter()
        .filter(|(key, _)| !env.iter().any(|(k, _)| k == key))
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

/// A session's scratch dir: `<node home>/tmp/<16 hex characters of its id's SHA-256>`, one per session however alike
/// two ids begin, so removing one session's never touches another's. Short, so a Unix socket a tool makes in it stays
/// under the 104 bytes macOS allows a socket path. Never under /tmp, which is often tmpfs and counts against memory.
pub fn scratch_dir(home: &Path, session_id: &str) -> PathBuf {
    home.join("tmp").join(scratch_name(session_id))
}

/// The session whose scratch dir `row` uses: the one it took over (`SessionLocal::scratch_of`), else its own.
pub fn scratch_owner(row: &SessionRow) -> &str {
    row.local
        .scratch_of
        .as_deref()
        .unwrap_or(row.summary.session_id.as_str())
}

fn scratch_name(session_id: &str) -> String {
    Sha256::digest(session_id.as_bytes())[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// TMPDIR, TMP and TEMP, all at `dir`, and claude's own temp root (`CLAUDE_CODE_TMPDIR`, under which it makes
/// `claude-<uid>`), which it reads before TMPDIR. A Navi's sandbox lets it write nowhere else: on macOS a claude that
/// fell back to `/private/tmp` failed every command with EPERM.
pub fn scratch_env(dir: &Path) -> Vec<(String, String)> {
    let dir = dir.to_string_lossy();
    ["TMPDIR", "TMP", "TEMP", "CLAUDE_CODE_TMPDIR"]
        .map(|key| (key.to_owned(), dir.clone().into_owned()))
        .into()
}

/// What a worker's brief says about its share of the machine. Names only the variables fleetd set.
pub fn brief_note(set: &[(String, String)], n: u64) -> String {
    let mut note = String::from("## This machine\n");
    let names: Vec<&str> = set
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| *k != TEST_WORKERS_VAR)
        .collect();
    if !names.is_empty() {
        note.push_str(&format!(
            "- Builds get {n} parallel jobs per agent, your share of this machine's CPUs: {} {} set to it. Keep any \
             other build to {n} jobs too.\n",
            names.join(", "),
            if names.len() == 1 { "is" } else { "are" },
        ));
    }
    if set.iter().any(|(k, _)| k == TEST_WORKERS_VAR) {
        let w = test_workers(n);
        note.push_str(&format!(
            "- Test runners get {w} workers: {TEST_WORKERS_VAR} is set to it. Keep any other test runner to {w} \
             workers too.\n"
        ));
    }
    note.push_str(
        "- Scratch files go in $TMPDIR, a directory of your own on disk; never in /tmp, which may be held in memory.\n",
    );
    note
}

/// Removes a session's scratch dir and everything in it.
pub fn remove_scratch(home: &Path, session_id: &str) {
    let dir = scratch_dir(home, session_id);
    if let Err(e) = std::fs::remove_dir_all(&dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(dir = %dir.display(), "scratch dir not removed: {e}");
    }
}

/// Removes every scratch dir under `<home>/tmp` but those of `keep`, the scratch owners of the sessions whose worktree
/// is still there. Returns how many went.
pub fn sweep_scratch(home: &Path, keep: &[String]) -> usize {
    let keep: HashSet<String> = keep.iter().map(|id| scratch_name(id)).collect();
    let Ok(entries) = std::fs::read_dir(home.join("tmp")) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter(|e| !keep.contains(&*e.file_name().to_string_lossy()))
        .filter(|e| std::fs::remove_dir_all(e.path()).is_ok())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn every_build_tool_gets_the_share_unless_the_user_set_its_own() {
        assert_eq!(
            jobs_env(&env(&[("PATH", "/usr/bin")]), 3),
            env(&[
                ("CARGO_BUILD_JOBS", "3"),
                ("MAKEFLAGS", "-j3"),
                ("CMAKE_BUILD_PARALLEL_LEVEL", "3"),
                ("GOFLAGS", "-p=3"),
                ("VITEST_MAX_WORKERS", "4"),
            ])
        );
        // Set, even to something other than a job count: theirs stands.
        assert_eq!(
            jobs_env(
                &env(&[
                    ("MAKEFLAGS", "--no-print-directory"),
                    ("GOFLAGS", "-mod=vendor"),
                    ("VITEST_MAX_WORKERS", "1")
                ]),
                2
            ),
            env(&[
                ("CARGO_BUILD_JOBS", "2"),
                ("CMAKE_BUILD_PARALLEL_LEVEL", "2")
            ])
        );
    }

    /// The test runner gets the agent's share of the cores, never fewer than 4 workers.
    #[test]
    fn test_workers_are_the_share_with_a_floor_of_four() {
        let workers = |n| {
            jobs_env(&[], n)
                .into_iter()
                .find(|(k, _)| k == "VITEST_MAX_WORKERS")
                .map(|(_, v)| v)
        };
        assert_eq!(workers(2).as_deref(), Some("4"));
        assert_eq!(workers(4).as_deref(), Some("4"));
        assert_eq!(workers(8).as_deref(), Some("8"));
    }

    #[test]
    fn the_scratch_dir_is_short_under_the_node_home_and_never_tmp() {
        let home = Path::new("/home/ada/.fleetd/node");
        let dir = scratch_dir(home, "7f0c1d2e-0000-4000-8000-000000000001");
        let name = dir.file_name().unwrap().to_str().unwrap();
        assert_eq!(dir.parent(), Some(Path::new("/home/ada/.fleetd/node/tmp")));
        assert!(
            name.len() == 16 && name.chars().all(|c| c.is_ascii_hexdigit()),
            "{name}"
        );
        let path = dir.to_str().unwrap();
        assert_eq!(
            scratch_env(&dir),
            env(&[
                ("TMPDIR", path),
                ("TMP", path),
                ("TEMP", path),
                ("CLAUDE_CODE_TMPDIR", path)
            ])
        );
        // The same id, the same dir, across node restarts.
        assert_eq!(
            scratch_dir(home, "7f0c1d2e-0000-4000-8000-000000000001"),
            dir
        );
        // Room left for a socket: macOS allows 104 bytes, Linux 108.
        let mac = scratch_dir(Path::new("/Users/someone-long/.fleetd/node"), "a-b");
        assert!(mac.as_os_str().len() + "/tmux-501/default".len() < 104);
    }

    #[test]
    fn the_brief_says_how_many_jobs_and_which_variables() {
        let note = brief_note(&jobs_env(&[], 2), 2);
        assert_eq!(
            note,
            "## This machine\n\
             - Builds get 2 parallel jobs per agent, your share of this machine's CPUs: CARGO_BUILD_JOBS, MAKEFLAGS, \
             CMAKE_BUILD_PARALLEL_LEVEL, GOFLAGS are set to it. Keep any other build to 2 jobs too.\n\
             - Test runners get 4 workers: VITEST_MAX_WORKERS is set to it. Keep any other test runner to 4 workers \
             too.\n\
             - Scratch files go in $TMPDIR, a directory of your own on disk; never in /tmp, which may be held in \
             memory.\n"
        );
        let one = brief_note(&env(&[("GOFLAGS", "-p=2")]), 2);
        assert!(one.contains(": GOFLAGS is set to it."), "{one}");
        assert!(!one.contains("Test runners"), "{one}");
        let tests_only = brief_note(&env(&[("VITEST_MAX_WORKERS", "6")]), 6);
        assert!(!tests_only.contains("Builds get"), "{tests_only}");
        assert!(
            tests_only.contains("Test runners get 6 workers"),
            "{tests_only}"
        );
        // Nothing fleetd set: no jobs line.
        assert!(!brief_note(&[], 2).contains("jobs"));
    }

    /// Two sessions whose ids share their first 8 characters get dirs of their own: one's removal leaves the other's.
    #[test]
    fn ids_alike_at_the_start_never_share_a_scratch_dir() {
        let home = tempfile::tempdir().unwrap();
        let (a, b) = (
            "7f0c1d2e-0000-4000-8000-000000000001",
            "7f0c1d2e-0000-4000-8000-000000000002",
        );
        assert_ne!(scratch_dir(home.path(), a), scratch_dir(home.path(), b));
        for id in [a, b] {
            std::fs::create_dir_all(scratch_dir(home.path(), id)).unwrap();
        }
        remove_scratch(home.path(), a);
        assert!(!scratch_dir(home.path(), a).exists());
        assert!(scratch_dir(home.path(), b).is_dir());
        assert_eq!(sweep_scratch(home.path(), &[b.to_owned()]), 0);
        assert!(scratch_dir(home.path(), b).is_dir());
    }

    #[test]
    fn a_sweep_keeps_only_the_scratch_of_sessions_with_a_worktree() {
        let home = tempfile::tempdir().unwrap();
        for id in ["aaaaaaaa-1", "bbbbbbbb-2"] {
            let dir = scratch_dir(home.path(), id);
            std::fs::create_dir_all(dir.join("deep")).unwrap();
            std::fs::write(dir.join("deep/f"), "x").unwrap();
        }
        assert_eq!(sweep_scratch(home.path(), &["aaaaaaaa-1".into()]), 1);
        assert!(scratch_dir(home.path(), "aaaaaaaa-1").is_dir());
        assert!(!scratch_dir(home.path(), "bbbbbbbb-2").exists());
        remove_scratch(home.path(), "aaaaaaaa-1");
        remove_scratch(home.path(), "never-made");
        assert!(!scratch_dir(home.path(), "aaaaaaaa-1").exists());
        assert_eq!(sweep_scratch(&home.path().join("none"), &[]), 0);
    }
}
