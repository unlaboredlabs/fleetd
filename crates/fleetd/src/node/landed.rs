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

/// Git's client-side hooks, each forwarded from fleetd's hooks dir to the repo's own when it has one.
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
    "p4-changelist",
    "p4-prepare-changelist",
    "p4-post-changelist",
    "p4-pre-submit",
];

/// Runs the repo's own hook `$1` with the rest of the arguments, from the hooks path the repo's own config says when
/// it runs (husky's `core.hooksPath`, say), else `.git/hooks`, so a hook added or moved later runs too.
const OWN_HOOK: &str = r#"#!/bin/sh
# fleetd: the repo's own hook, from its own hooks path.
name=$1; shift
dir=$(git config --type=path --local core.hooksPath || git config --type=path --global core.hooksPath ||
  git config --type=path --system core.hooksPath) || dir="$(git rev-parse --git-common-dir)/hooks"
if [ -x "$dir/$name" ]; then exec "$dir/$name" "$@"; fi
exit 0
"#;

/// Makes every commit in the linked worktree `cwd` of a writer on `task` name it in a `Fleetd-Task: <task>` trailer,
/// and nothing else: the worktree's own config (`git config --worktree`, which needs `extensions.worktreeConfig`)
/// points its hooks at a dir in its own git dir, where `prepare-commit-msg` adds the trailer (git runs it for
/// `commit -m`, merges and amends, `--no-verify` or not) and every hook then runs the repo's own. Other worktrees,
/// the human's checkout and any other repo the agent touches keep their hooks as they are. A checkout that isn't a
/// linked worktree is left alone.
pub fn trailer_hooks(cwd: &Path, task: &str) -> Result<(), GitError> {
    use std::os::unix::fs::PermissionsExt;
    let path = |what: &str| -> Result<PathBuf, GitError> {
        git(cwd, &["rev-parse", "--path-format=absolute", what]).map(|p| PathBuf::from(p.trim()))
    };
    let git_dir = path("--git-dir")?;
    if git_dir == path("--git-common-dir")? {
        return Err(GitError(format!(
            "{} is not a linked worktree",
            cwd.display()
        )));
    }
    let dir = git_dir.join("fleetd-hooks");
    let io = |e: std::io::Error| GitError(format!("cannot write {}: {e}", dir.display()));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(io)?;
    }
    std::fs::create_dir_all(&dir).map_err(io)?;
    let write = |name: &str, body: &str| -> std::io::Result<()> {
        let path = dir.join(name);
        std::fs::write(&path, body)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
    };
    let own = quoted(&dir.join("own-hook").to_string_lossy());
    let trailer = quoted(&format!("{TASK_TRAILER}: {task}"));
    write("own-hook", OWN_HOOK).map_err(io)?;
    write(
        "prepare-commit-msg",
        &format!(
            "#!/bin/sh\n# fleetd: each commit names its task, so its work is found from git alone.\n\
             git interpret-trailers --in-place --if-exists addIfDifferent --trailer {trailer} \"$1\" || true\n\
             exec {own} prepare-commit-msg \"$@\"\n"
        ),
    )
    .map_err(io)?;
    for name in HOOKS {
        write(name, &format!("#!/bin/sh\nexec {own} {name} \"$@\"\n")).map_err(io)?;
    }
    let on = git(
        cwd,
        &[
            "config",
            "--local",
            "--type=bool",
            "extensions.worktreeConfig",
        ],
    )
    .is_ok_and(|v| v.trim() == "true");
    if !on {
        git(
            cwd,
            &["config", "--local", "extensions.worktreeConfig", "true"],
        )?;
    }
    git(
        cwd,
        &[
            "config",
            "--worktree",
            "core.hooksPath",
            &dir.to_string_lossy(),
        ],
    )?;
    Ok(())
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
        git(root, &["log", "-1", "--format=%B"])
            .unwrap()
            .trim()
            .to_owned()
    }

    /// A commit of `file` in `dir` as the agent's own git makes it, with no fleetd environment.
    fn commit(dir: &Path, file: &str, msg: &str) {
        std::fs::write(dir.join(file), msg).unwrap();
        run(dir, &["add", "."]);
        run(dir, &["commit", "-q", "-m", msg]);
    }

    /// An executable hook that appends `tag` to `log` each time it runs.
    fn hook(path: &Path, log: &Path, tag: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = format!(
            "#!/bin/sh\necho {tag} >> {}\n",
            quoted(&log.to_string_lossy())
        );
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn ran(log: &Path) -> Vec<String> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn a_writers_commits_in_its_worktree_name_its_task_and_the_repos_own_hooks_still_run() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::node::worktree::tests::repo(dir.path());
        let log = dir.path().join("hooks.log");
        hook(&root.join(".git/hooks/commit-msg"), &log, "commit-msg");
        let wt = dir.path().join("wt");
        run(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "fleetd/T45-x",
                &wt.to_string_lossy(),
            ],
        );
        trailer_hooks(&wt, "T45").unwrap();

        commit(&wt, "b.txt", "fix: totals");
        assert_eq!(message(&wt), "fix: totals\n\nFleetd-Task: T45");
        // Beside the agent's own trailers, once.
        commit(
            &wt,
            "b.txt",
            "fix: more\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nFleetd-Task: T45",
        );
        assert_eq!(
            message(&wt),
            "fix: more\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nFleetd-Task: T45"
        );
        assert_eq!(
            ran(&log),
            ["commit-msg", "commit-msg"],
            "the repo's own hook ran on each"
        );

        // A hook the repo gets after the session started runs too, from wherever its hooks path says now.
        run(&root, &["config", "core.hooksPath", ".husky"]);
        hook(&wt.join(".husky/pre-commit"), &log, "husky-pre-commit");
        commit(&wt, "c.txt", "fix: last");
        assert_eq!(message(&wt), "fix: last\n\nFleetd-Task: T45");
        assert_eq!(
            ran(&log).last().map(String::as_str),
            Some("husky-pre-commit")
        );
    }

    #[test]
    fn only_the_writers_worktree_gets_the_trailer_never_the_humans_checkout_or_another_repo() {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::node::worktree::tests::repo(dir.path());
        let log = dir.path().join("hooks.log");
        hook(&root.join(".git/hooks/commit-msg"), &log, "first-repo");
        let wt = dir.path().join("wt");
        run(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "fleetd/T45-x",
                &wt.to_string_lossy(),
            ],
        );
        trailer_hooks(&wt, "T45").unwrap();
        let before = ran(&log);

        // A second repo the agent makes from inside its worktree: a scratch clone, say.
        let other = wt.join("scratch");
        std::fs::create_dir_all(&other).unwrap();
        run(&other, &["init", "-q", "-b", "main"]);
        commit(&other, "x.txt", "scratch");
        assert_eq!(message(&other), "scratch");
        assert_eq!(
            ran(&log),
            before,
            "none of the first repo's hooks ran in the second"
        );

        // The human's own checkout of the same repo keeps its hooks and gets no trailer.
        commit(&root, "h.txt", "human");
        assert_eq!(message(&root), "human");
        assert_eq!(ran(&log).len(), before.len() + 1);

        // The human's checkout is never given fleetd's hooks.
        assert!(trailer_hooks(&root, "T45").is_err());
        assert_eq!(
            git(&root, &["config", "--get", "core.hooksPath"]).ok(),
            None
        );
    }
}
