//! The files a task branch changes as its PR would show them: `git diff --name-only <merge-base>..<branch>`, run by
//! the node in the project's checkout. Unlike the thread's changed paths, a writer that rebased onto a newer base is not
//! charged with the base's files.
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

static BRANCH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$").unwrap());
/// The node keeps this much of the output; a list that fills it may have lost its first names.
pub const OUTPUT_MAX: usize = 2000;
pub const TIMEOUT_SEC: u64 = 60;

pub fn branch_diff_argv(base: &str, branch: &str) -> Option<Vec<String>> {
    [base, branch]
        .iter()
        .all(|b| BRANCH.is_match(b) && !b.contains(".."))
        .then(|| {
            ["sh", "-c", SCRIPT, "fleetd-branch-diff", base, branch]
                .iter()
                .map(|s| (*s).to_owned())
                .collect()
        })
}

/// The branch's changed paths, sorted, from the node's exit code and output tail; `None` when the node could not
/// say in full (non-zero exit, a list longer than the output it keeps).
pub fn parse_branch_diff(exit_code: i64, output_tail: &str) -> Option<Vec<String>> {
    if exit_code != 0 || output_tail.encode_utf16().count() >= OUTPUT_MAX {
        return None;
    }
    let mut paths: Vec<String> = output_tail
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    // JS's default sort compares UTF-16 units; for the ASCII paths git prints with quotePath off that is byte order
    // in all but astral-plane names.
    paths.sort();
    Some(paths)
}
