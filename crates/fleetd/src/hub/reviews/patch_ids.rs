//! `git patch-id --stable` of a PR head's diff against its merge base with the PR's base branch, run by the node on
//! the project's machine. A rebase that applies cleanly keeps it, so reviews bound to it survive the train's rebase.
use crate::hub::train::contract::MachineId;
use crate::hub::train::host::TrainHost;

// Positional arguments, never interpolated: $1 base branch, $2 PR number, $3 head SHA.
const SCRIPT: &str = "set -eu
git fetch -q --no-tags origin \"+refs/heads/$1:refs/fleetd/reviews/base/$1\" \"+refs/pull/$2/head:refs/fleetd/reviews/pull/$2\"
mb=$(git merge-base \"$3\" \"refs/fleetd/reviews/base/$1\")
git diff --no-color --no-ext-diff --no-textconv \"$mb\" \"$3\" | git patch-id --stable";

fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_branch(s: &str) -> bool {
    s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
        && !s.contains("..")
}

/// The argv the node runs, or why the input is refused.
pub fn patch_id_argv(base: &str, pr_number: i64, sha: &str) -> Result<Vec<String>, String> {
    if !is_sha(sha) {
        return Err(format!("not a full commit SHA: {}", sha.chars().take(80).collect::<String>()));
    }
    if !is_branch(base) {
        return Err(format!("not a branch name: {}", base.chars().take(80).collect::<String>()));
    }
    if pr_number < 1 {
        return Err(format!("not a PR number: {pr_number}"));
    }
    Ok(["sh", "-c", SCRIPT, "fleetd-patch-id", base, &pr_number.to_string(), sha].map(String::from).into())
}

/// `git patch-id` prints "<patch id> <commit id>"; the commit id is zeros for a diff read from stdin.
pub fn parse_patch_id(output: &str) -> Option<String> {
    output.split('\n').find_map(|line| {
        let (id, commit) = line.trim().split_once(' ')?;
        (is_sha(id) && !commit.is_empty() && commit.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then(|| id.to_string())
    })
}

pub async fn compute(host: &dyn TrainHost, machine_id: &MachineId, cwd: &str, base: &str, pr_number: i64, sha: &str) -> Result<String, String> {
    let argv = patch_id_argv(base, pr_number, sha)?;
    let at = format!("#{pr_number} at {} on {machine_id}", &sha[..sha.len().min(12)]);
    let out = host.run_command(machine_id, cwd, argv, 300).await.map_err(|e| format!("patch id of {at}: {e}"))?;
    if out.exit_code == Some(0)
        && let Some(id) = parse_patch_id(&out.output_tail)
    {
        return Ok(id);
    }
    let lines: Vec<&str> = out.output_tail.trim().split('\n').collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" | ");
    let why = match out.exit_code {
        Some(0) => "the diff against its merge base is empty".to_string(),
        Some(code) => format!("exit {code}"),
        None => "exit none".to_string(),
    };
    let tail = if tail.is_empty() { String::new() } else { format!(": {tail}") };
    Err(format!("patch id of {at}: {why}{tail}").chars().take(500).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_inputs_that_could_reach_the_shell_and_reads_the_patch_id() {
        let sha = "a".repeat(40);
        assert_eq!(patch_id_argv("main", 7, &sha).unwrap()[3..], ["fleetd-patch-id", "main", "7", sha.as_str()]);
        assert!(patch_id_argv("main", 7, "HEAD").is_err());
        assert!(patch_id_argv("-x", 7, &sha).is_err());
        assert!(patch_id_argv("a/../b", 7, &sha).is_err());
        assert!(patch_id_argv("main", 0, &sha).is_err());
        let id = "b".repeat(40);
        assert_eq!(parse_patch_id(&format!("noise\n{id} {}\n", "0".repeat(40))), Some(id));
        assert_eq!(parse_patch_id(""), None);
    }
}
