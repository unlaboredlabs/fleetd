//! Each session's share of the machine: build tools held to its part of the CPUs, and a scratch dir of its own on
//! disk. With 20 agents building at once and no limit, every `cargo`, `make` and `go build` sized itself to all the
//! machine's cores, and their temporary files and build output went to /tmp, which is often tmpfs and held in RAM.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The parallelism variables of the common build tools, each with its value for `n` jobs.
fn jobs_vars(n: u64) -> [(&'static str, String); 4] {
    [
        ("CARGO_BUILD_JOBS", n.to_string()),
        ("MAKEFLAGS", format!("-j{n}")),
        ("CMAKE_BUILD_PARALLEL_LEVEL", n.to_string()),
        ("GOFLAGS", format!("-p={n}")),
    ]
}

/// The build parallelism variables for `n` jobs that `env` (the user's own setup, `claude.env` included) doesn't
/// already set: a person's own choice stands.
pub fn jobs_env(env: &[(String, String)], n: u64) -> Vec<(String, String)> {
    jobs_vars(n)
        .into_iter()
        .filter(|(key, _)| !env.iter().any(|(k, _)| k == key))
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

/// A session's scratch dir: `<node home>/tmp/<first 8 characters of its id>`. Short, so a Unix socket a tool makes in
/// it stays under the 104 bytes macOS allows a socket path. Never under /tmp, which is often tmpfs and counts against
/// memory.
pub fn scratch_dir(home: &Path, session_id: &str) -> PathBuf {
    home.join("tmp").join(scratch_name(session_id))
}

fn scratch_name(session_id: &str) -> String {
    session_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect()
}

/// TMPDIR, TMP and TEMP, all at `dir`.
pub fn scratch_env(dir: &Path) -> Vec<(String, String)> {
    let dir = dir.to_string_lossy();
    ["TMPDIR", "TMP", "TEMP"]
        .map(|key| (key.to_owned(), dir.clone().into_owned()))
        .into()
}

/// What a worker's brief says about its share of the machine. Names only the variables fleetd set.
pub fn brief_note(set: &[(String, String)], n: u64) -> String {
    let mut note = String::from("## This machine\n");
    if !set.is_empty() {
        let names: Vec<&str> = set.iter().map(|(k, _)| k.as_str()).collect();
        note.push_str(&format!(
            "- Builds get {n} parallel jobs per agent, your share of this machine's CPUs: {} {} set to it. Keep any \
             other build or test runner to {n} jobs too.\n",
            names.join(", "),
            if names.len() == 1 { "is" } else { "are" },
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

/// Removes every scratch dir under `<home>/tmp` but those of `keep`, the sessions whose worktree is still there.
/// Returns how many went.
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
            ])
        );
        // Set, even to something other than a job count: theirs stands.
        assert_eq!(
            jobs_env(
                &env(&[
                    ("MAKEFLAGS", "--no-print-directory"),
                    ("GOFLAGS", "-mod=vendor")
                ]),
                2
            ),
            env(&[
                ("CARGO_BUILD_JOBS", "2"),
                ("CMAKE_BUILD_PARALLEL_LEVEL", "2")
            ])
        );
    }

    #[test]
    fn the_scratch_dir_is_short_under_the_node_home_and_never_tmp() {
        let home = Path::new("/home/ada/.fleetd/node");
        let dir = scratch_dir(home, "7f0c1d2e-0000-4000-8000-000000000001");
        assert_eq!(dir, Path::new("/home/ada/.fleetd/node/tmp/7f0c1d2e"));
        assert_eq!(
            scratch_env(&dir),
            env(&[
                ("TMPDIR", "/home/ada/.fleetd/node/tmp/7f0c1d2e"),
                ("TMP", "/home/ada/.fleetd/node/tmp/7f0c1d2e"),
                ("TEMP", "/home/ada/.fleetd/node/tmp/7f0c1d2e"),
            ])
        );
        // Room left for a socket: macOS allows 104 bytes, Linux 108.
        let mac = scratch_dir(
            Path::new("/Users/someone-long/.fleetd/node"),
            "a-b-c-d-e-f-g-h-i",
        );
        assert_eq!(
            mac,
            Path::new("/Users/someone-long/.fleetd/node/tmp/abcdefgh")
        );
        assert!(mac.as_os_str().len() + "/tmux-501/default".len() < 104);
    }

    #[test]
    fn the_brief_says_how_many_jobs_and_which_variables() {
        let note = brief_note(&jobs_env(&[], 4), 4);
        assert_eq!(
            note,
            "## This machine\n\
             - Builds get 4 parallel jobs per agent, your share of this machine's CPUs: CARGO_BUILD_JOBS, MAKEFLAGS, \
             CMAKE_BUILD_PARALLEL_LEVEL, GOFLAGS are set to it. Keep any other build or test runner to 4 jobs too.\n\
             - Scratch files go in $TMPDIR, a directory of your own on disk; never in /tmp, which may be held in \
             memory.\n"
        );
        let one = brief_note(&env(&[("GOFLAGS", "-p=2")]), 2);
        assert!(one.contains(": GOFLAGS is set to it."), "{one}");
        // Nothing fleetd set: no jobs line.
        assert!(!brief_note(&[], 2).contains("jobs"));
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
