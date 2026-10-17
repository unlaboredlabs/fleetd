//! The files a task branch changes as its PR would show them: `git diff --name-only <merge-base>..<branch>`, run by
//! the node in the project's checkout. Unlike T3's checkpoint paths, a writer that rebased onto a newer base is not
//! charged with the base's files. TS spec: apps/hub/src/tasks/branchDiff.ts.
use std::sync::LazyLock;

use regex::Regex;

// Positional arguments, never interpolated: $1 base branch, $2 task branch. The merge base is taken against
// origin/<base> when that is newer than the local base, since a writer rebases onto what it fetched.
const SCRIPT: &str = concat!(
    "set -eu\n",
    "mb=$(git merge-base \"refs/heads/$2\" \"refs/heads/$1\")\n",
    "if o=$(git merge-base \"refs/heads/$2\" \"refs/remotes/origin/$1\" 2>/dev/null) && git merge-base --is-ancestor \"$mb\" \"$o\"; then mb=$o; fi\n",
    "git -c core.quotePath=false diff --name-only --no-renames \"$mb\" \"refs/heads/$2\"",
);

static BRANCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$").expect("static regex"));
/// The node keeps this much of the output; a list that fills it may have lost its first names.
const OUTPUT_MAX: usize = 2000;

pub fn branch_diff_argv(base: &str, branch: &str) -> Option<Vec<String>> {
    [base, branch].iter().all(|b| BRANCH.is_match(b) && !b.contains("..")).then(|| {
        ["sh", "-c", SCRIPT, "fleetd-branch-diff", base, branch].iter().map(|s| (*s).to_owned()).collect()
    })
}

/// The changed paths from the command's result, sorted; None when the node could not say in full (a failed command,
/// or a list longer than the output it keeps).
pub fn parse_branch_diff(exit_code: Option<i64>, output_tail: &str) -> Option<Vec<String>> {
    if exit_code != Some(0) || super::shell_mapper::js_len(output_tail) >= OUTPUT_MAX {
        return None;
    }
    let mut paths: Vec<String> = output_tail.split('\n').map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect();
    paths.sort();
    Some(paths)
}
