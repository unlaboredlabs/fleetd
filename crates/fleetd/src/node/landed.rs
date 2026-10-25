//! What git alone records of fleetd's work, for a repo whose host fleetd can't read: `landed_log` reads the default
//! branch's own line with the train's `Fleetd-Change:` trailers and any `Fleetd-Task:` ones, so the hub can tell the
//! train's merges, merges by hand and direct pushes apart.
use std::path::Path;

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

    #[test]
    fn a_fleetd_branch_names_its_task() {
        assert_eq!(branch_task("fleetd/T153-metrics").as_deref(), Some("T153"));
        assert_eq!(branch_task("fleetd/T7").as_deref(), Some("T7"));
        assert_eq!(branch_task("fleetd/train/batch"), None);
        assert_eq!(branch_task("feature/T1-x"), None);
    }
}
