//! What git alone records of fleetd's work, for a repo whose host fleetd can't read: every commit a writer makes
//! names its task in a `Fleetd-Task:` trailer, and `landed_log` reads the default branch's own line with those
//! trailers and the train's `Fleetd-Change:` ones, so the hub can tell the train's merges, merges by hand and direct
//! pushes apart.
use std::path::{Path, PathBuf};

use fleetd_contracts::metrics::{CHANGE_TRAILER, TASK_TRAILER};
use fleetd_contracts::sessions::{GitCommit, LandedLog};

use super::worktree::{GitError, fetch, git, ref_sha, remote};

/// Field and record separators in `git log --format`: unit and record separators, which no subject holds.
const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';
const VALUE: char = '\u{1d}';
/// A merge brings in at most this many commits whose trailers are read.
const MERGED_MAX: &str = "500";

/// The task a fleetd branch names: `fleetd/T12-…` → "T12".
pub fn branch_task(branch: &str) -> Option<String> {
    let rest = branch.strip_prefix("fleetd/")?.strip_prefix('T')?;
    let n: String = rest.chars().take_while(char::is_ascii_digit).collect();
    (!n.is_empty() && !n.starts_with('0')).then(|| format!("T{n}"))
}

/// `text` as one shell word.
fn quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// Git's client-side hooks a repo may have, each forwarded from fleetd's hooks dir when the repo has it.
const HOOKS: &[&str] = &[
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "post-rewrite",
    "reference-transaction",
    "pre-auto-gc",
    "post-index-change",
    "sendemail-validate",
    "fsmonitor-watchman",
];

/// Writes `dir` as a hooks dir for a writer on `task` in the worktree `cwd`: a `prepare-commit-msg` that adds
/// `Fleetd-Task: <task>` to every commit message (git runs it for `commit -m`, merges and amends, `--no-verify` or
/// not), and a forwarder to each of the repo's own hooks, so they run as before. Returns the git config the session's
/// environment sets to use it.
pub fn trailer_hooks(cwd: &Path, dir: &Path, task: &str) -> std::io::Result<(String, String)> {
    use std::os::unix::fs::PermissionsExt;
    // The repo's own hooks: `core.hooksPath` when set (husky's, say), else `.git/hooks`.
    let own = git(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    )
    .map(|p| PathBuf::from(p.trim()))
    .map_err(std::io::Error::other)?;
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    std::fs::create_dir_all(dir)?;
    let write = |name: &str, body: String| -> std::io::Result<()> {
        let path = dir.join(name);
        std::fs::write(&path, body)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
    };
    let trailer = quoted(&format!("{TASK_TRAILER}: {task}"));
    let theirs = quoted(&own.join("prepare-commit-msg").to_string_lossy());
    write(
        "prepare-commit-msg",
        format!(
            "#!/bin/sh\n# fleetd: each commit names its task, so its work is found from git alone.\n\
             git interpret-trailers --in-place --if-exists addIfDifferent --trailer {trailer} \"$1\" || true\n\
             if [ -x {theirs} ]; then exec {theirs} \"$@\"; fi\nexit 0\n"
        ),
    )?;
    for name in HOOKS {
        let hook = own.join(name);
        if hook.is_file() {
            write(
                name,
                format!(
                    "#!/bin/sh\nexec {} \"$@\"\n",
                    quoted(&hook.to_string_lossy())
                ),
            )?;
        }
    }
    Ok((
        "core.hooksPath".to_owned(),
        dir.to_string_lossy().into_owned(),
    ))
}

/// Adds `key = value` to the git config an environment carries (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, …), after
/// any entries it already has.
pub fn with_git_config(env: &mut Vec<(String, String)>, key: &str, value: &str) {
    let n = env
        .iter()
        .rev()
        .find(|(k, _)| k == "GIT_CONFIG_COUNT")
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    env.retain(|(k, _)| k != "GIT_CONFIG_COUNT");
    env.extend([
        (format!("GIT_CONFIG_KEY_{n}"), key.to_owned()),
        (format!("GIT_CONFIG_VALUE_{n}"), value.to_owned()),
        ("GIT_CONFIG_COUNT".to_owned(), (n + 1).to_string()),
    ]);
}

fn values(field: &str) -> Vec<String> {
    field
        .split(VALUE)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The default branch `branch` of the checkout at `root`, as its remote has it after a fetch (the last fetched copy
/// when the fetch fails, else the local branch): its first-parent line newest first, back to `stop_at` when that is
/// on it, else the commits made since `since_ms`, at most [`LandedLog::MAX`].
pub fn landed_log(
    root: &Path,
    branch: &str,
    since_ms: i64,
    stop_at: Option<&str>,
) -> Result<LandedLog, GitError> {
    let mut fetch_failed = None;
    let mut read = None;
    if let Some(remote) = remote(root) {
        if let Err(e) = fetch(root, &remote, branch) {
            fetch_failed = Some(e.to_string());
        }
        let tracking = format!("{remote}/{branch}");
        if ref_sha(root, &format!("refs/remotes/{tracking}")).is_some() {
            read = Some((format!("refs/remotes/{tracking}"), tracking));
        }
    }
    let (rev, read) = match read {
        Some(r) => r,
        None if ref_sha(root, &format!("refs/heads/{branch}")).is_some() => {
            (format!("refs/heads/{branch}"), branch.to_owned())
        }
        None => return Err(GitError(format!("{} has no {branch}", root.display()))),
    };
    let on_line = stop_at.filter(|s| git(root, &["merge-base", "--is-ancestor", s, &rev]).is_ok());
    let since = chrono::DateTime::from_timestamp_millis(since_ms)
        .unwrap_or_default()
        .to_rfc3339();
    let range = match on_line {
        Some(s) => format!("{s}..{rev}"),
        None => rev.clone(),
    };
    let format = format!(
        "--format=%H{FIELD}%P{FIELD}%ct{FIELD}%an{FIELD}%s{FIELD}\
         %(trailers:key={CHANGE_TRAILER},valueonly,unfold,separator=%x1d){FIELD}\
         %(trailers:key={TASK_TRAILER},valueonly,unfold,separator=%x1d){RECORD}"
    );
    let max = LandedLog::MAX.to_string();
    let mut args = vec!["log", "--first-parent", "-n", &max, &format];
    let since_arg = format!("--since={since}");
    if on_line.is_none() {
        args.push(&since_arg);
    }
    args.extend([range.as_str(), "--"]);
    let out = git(root, &args)?;
    let mut commits = Vec::new();
    for record in out.split(RECORD) {
        let fields: Vec<&str> = record.trim_start_matches('\n').split(FIELD).collect();
        let [sha, parents, at, author, subject, changes, tasks] = fields[..] else {
            continue;
        };
        let mut c = GitCommit {
            sha: sha.to_owned(),
            parents: parents.split_whitespace().map(str::to_owned).collect(),
            at_ms: at.trim().parse::<i64>().unwrap_or_default() * 1000,
            author_name: author.to_owned(),
            subject: subject.to_owned(),
            changes: values(changes),
            tasks: values(tasks),
            merged_tasks: Vec::new(),
        };
        if let [first, ..] = &c.parents[..]
            && c.parents.len() > 1
        {
            let side = format!("{first}..{}", c.sha);
            let format = format!(
                "--format=%(trailers:key={TASK_TRAILER},valueonly,unfold,separator=%x1d){VALUE}"
            );
            let merged = git(root, &["log", "-n", MERGED_MAX, &format, &side, "--"])?;
            for task in values(&merged) {
                if !c.merged_tasks.contains(&task) {
                    c.merged_tasks.push(task);
                }
            }
        }
        commits.push(c);
    }
    Ok(LandedLog {
        read,
        fetch_failed,
        commits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::worktree::tests::run;

    #[test]
    fn a_fleetd_branch_names_its_task() {
        assert_eq!(branch_task("fleetd/T153-metrics").as_deref(), Some("T153"));
        assert_eq!(branch_task("fleetd/T7").as_deref(), Some("T7"));
        assert_eq!(branch_task("fleetd/train/batch"), None);
        assert_eq!(branch_task("feature/T1-x"), None);
    }

    fn message(root: &Path) -> String {
        git(root, &["log", "-1", "--format=%B"]).unwrap()
    }

    #[test]
    fn a_writers_commits_name_its_task_and_the_repos_own_hooks_still_run() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::node::worktree::tests::repo(dir.path());
        // The repo's own commit-msg hook, which must still run.
        let own = root.join(".git/hooks/commit-msg");
        std::fs::write(
            &own,
            "#!/bin/sh\necho ran >> \"$(git rev-parse --git-dir)/own-hook\"\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&own, std::fs::Permissions::from_mode(0o755)).unwrap();

        let hooks = dir.path().join("hooks");
        let (key, value) = trailer_hooks(&root, &hooks, "T45").unwrap();
        let mut env = vec![("GIT_CONFIG_COUNT".to_owned(), "1".to_owned())];
        with_git_config(&mut env, &key, &value);
        assert!(env.contains(&("GIT_CONFIG_KEY_1".into(), "core.hooksPath".into())));
        assert!(env.contains(&("GIT_CONFIG_COUNT".into(), "2".into())));
        let commit = |msg: &str| {
            std::fs::write(root.join("b.txt"), msg).unwrap();
            run(&root, &["add", "."]);
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@t",
                    "commit",
                    "-q",
                    "-m",
                    msg,
                ])
                .env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", &key)
                .env("GIT_CONFIG_VALUE_0", &value)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        commit("fix: totals");
        assert_eq!(message(&root).trim(), "fix: totals\n\nFleetd-Task: T45");
        // Beside the agent's own trailers, once.
        commit("fix: more\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nFleetd-Task: T45");
        assert_eq!(
            message(&root).trim(),
            "fix: more\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nFleetd-Task: T45"
        );
        let ran = std::fs::read_to_string(root.join(".git/own-hook")).unwrap();
        assert_eq!(
            ran.lines().count(),
            2,
            "the repo's own hook ran on each commit"
        );
    }
}
