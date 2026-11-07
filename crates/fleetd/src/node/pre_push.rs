//! A writer pushes only a tree its repo's pre-push check passed on. A repo names its check in [`DECLARED`]
//! (`{"check": "scripts/check.sh"}`), and the check, once it passes, adds the tree it checked (the worktree's, committed
//! or not) to [`CHECKED`] in the worktree's git dir. fleetd points the writer's git, and only for its own worktree,
//! at hooks whose `pre-push` refuses a branch whose tree isn't listed there, then runs the hooks git would have run.
//! It does so through the session's environment (`includeIf.gitdir:<the worktree's git dir>`), never a config file:
//! the person's checkout, the person in the same worktree, other repos and the merge train's pushes keep their hooks
//! as they are, and nothing about a person's push changes.
use std::path::{Path, PathBuf};

use super::landed::{HOOKS, HOT_HOOKS, own_hooks_dir, quoted};
use super::worktree::{GitError, git};

/// In a commit's tree: the repo's pre-push check, `{"check": "<command>"}`. A branch without it pushes as before.
pub const DECLARED: &str = ".fleetd/pre-push.json";
/// In the worktree's git dir (`git rev-parse --git-path fleetd-checked`): the trees the check passed on, one per line.
pub const CHECKED: &str = "fleetd-checked";
/// In the worktree's git dir: fleetd's hooks for it, and the config the session's environment includes.
const DIR: &str = "fleetd-push";

/// Runs the hook `$1` git would run without fleetd's: from the hooks path the worktree's, the repo's, the user's or
/// the system's config says (the worktree's is fleetd's trailer hooks, `landed::trailer_hooks`, when they are set),
/// else `.git/hooks`.
const BENEATH: &str = r#"#!/bin/sh
# fleetd: the hook git runs without fleetd's pre-push gate.
name=$1; shift
dir=$(git config --includes --type=path --worktree core.hooksPath 2>/dev/null ||
  git config --includes --type=path --local core.hooksPath ||
  git config --includes --type=path --global core.hooksPath ||
  git config --includes --type=path --system core.hooksPath) || dir="$(git rev-parse --git-common-dir)/hooks"
if [ -x "$dir/$name" ]; then exec "$dir/$name" "$@"; fi
exit 0
"#;

/// The gate: each branch pushed (not deleted) whose tree has [`DECLARED`] goes only if [`CHECKED`] lists that tree.
/// Every refused branch is named, with what to do; else the hooks beneath it run, with git's lines on their stdin.
const GATE: &str = r#"#!/bin/sh
# fleetd: a writer pushes only a tree its repo's pre-push check (.fleetd/pre-push.json) passed on.
input=$(cat)
checked=$(git rev-parse --git-path fleetd-checked) || exit 1
refused=$(printf '%s\n' "$input" | while read -r _ sha ref _; do
  case $sha in *[!0]*) ;; *) continue ;; esac
  case $ref in refs/heads/*) ;; *) continue ;; esac
  declared=$(git cat-file blob "$sha:.fleetd/pre-push.json" 2>/dev/null) || continue
  tree=$(git rev-parse --verify -q "$sha^{tree}") || continue
  grep -qxF "$tree" "$checked" 2>/dev/null && continue
  check=$(printf '%s\n' "$declared" | sed -n 's/.*"check"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  echo "fleetd: push refused: ${check:-the check in .fleetd/pre-push.json} hasn't passed on ${ref#refs/heads/}'s tree at $(git rev-parse --short "$sha")."
done)
if [ -n "$refused" ]; then
  printf '%s\n' "$refused" "Run it in this worktree after your final rebase, commit exactly what it checked, then push again." \
    "Too long for one command? Its header or help may say how to run it in the background or a part at a time." >&2
  exit 1
fi
[ -z "$input" ] || input="$input
"
printf '%s' "$input" | exec BENEATH pre-push "$@"
"#;

/// Sets up the gate for the worktree `cwd` and adds to `env`, a writer's session environment, what points its git
/// there: one more `GIT_CONFIG_KEY_<n>`, after those `env` already has.
pub fn gate(cwd: &Path, env: &mut Vec<(String, String)>) -> Result<(), GitError> {
    use std::os::unix::fs::PermissionsExt;
    let git_dir = git(cwd, &["rev-parse", "--absolute-git-dir"])?;
    let git_dir = std::fs::canonicalize(git_dir.trim())
        .map_err(|e| GitError(format!("cannot read {}: {e}", git_dir.trim())))?;
    let dir = git_dir.join(DIR);
    let hooks = dir.join("hooks");
    let (Some(at), Some(hooks_at)) = (git_dir.to_str(), hooks.to_str()) else {
        return Err(GitError(format!("{} is not UTF-8", git_dir.display())));
    };
    if at.contains('\n') {
        return Err(GitError(format!("{at} has a line break")));
    }
    let io = |e: std::io::Error| GitError(format!("cannot write {}: {e}", dir.display()));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(io)?;
    }
    std::fs::create_dir_all(&hooks).map_err(io)?;
    let write = |path: PathBuf, body: &str| -> std::io::Result<()> {
        std::fs::write(&path, body)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
    };
    let beneath = quoted(&hooks.join("beneath").to_string_lossy());
    write(hooks.join("beneath"), BENEATH).map_err(io)?;
    write(
        hooks.join("pre-push"),
        &GATE.replace("exec BENEATH", &format!("exec {beneath}")),
    )
    .map_err(io)?;
    // The hot hooks only where they run already, as `trailer_hooks` has them: with fleetd's trailer hooks set, they
    // are what the worktree's own config points at.
    let theirs = match git(
        cwd,
        &[
            "config",
            "--includes",
            "--type=path",
            "--worktree",
            "core.hooksPath",
        ],
    ) {
        Ok(dir) => cwd.join(dir.trim()),
        Err(_) => own_hooks_dir(cwd)?,
    };
    let hot = HOT_HOOKS.iter().filter(|name| theirs.join(name).is_file());
    for name in HOOKS
        .iter()
        .chain(&["prepare-commit-msg"])
        .chain(hot)
        .filter(|name| **name != "pre-push")
    {
        write(
            hooks.join(name),
            &format!("#!/bin/sh\nexec {beneath} {name} \"$@\"\n"),
        )
        .map_err(io)?;
    }
    let config = dir.join("config");
    let value = hooks_at.replace('\\', r"\\").replace('"', "\\\"");
    std::fs::write(&config, format!("[core]\n\thooksPath = \"{value}\"\n")).map_err(io)?;
    // `gitdir:` is a glob: the dir's own name, its glob characters escaped.
    let mut pattern = String::new();
    for c in at.chars() {
        if matches!(c, '*' | '?' | '[' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    add_config(
        env,
        &format!("includeIf.gitdir:{pattern}.path"),
        &config.to_string_lossy(),
    );
    Ok(())
}

/// Adds `key = value` to the git config `env` gives every git it starts, after the entries it has.
fn add_config(env: &mut Vec<(String, String)>, key: &str, value: &str) {
    let n = env
        .iter()
        .rev()
        .find(|(k, _)| k == "GIT_CONFIG_COUNT")
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    env.retain(|(k, _)| k != "GIT_CONFIG_COUNT");
    env.extend([
        ("GIT_CONFIG_COUNT".to_owned(), (n + 1).to_string()),
        (format!("GIT_CONFIG_KEY_{n}"), key.to_owned()),
        (format!("GIT_CONFIG_VALUE_{n}"), value.to_owned()),
    ]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::worktree::tests::{repo, run};
    use std::process::Command;

    /// `git <args>` in `dir`, with `env` on top of the test's own: the agent's git when `env` is the gate's.
    fn agent_git(dir: &Path, env: &[(String, String)], args: &[&str]) -> std::process::Output {
        Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .envs(env.iter().cloned())
            .output()
            .unwrap()
    }

    fn commit(dir: &Path, env: &[(String, String)], file: &str, text: &str) {
        std::fs::create_dir_all(dir.join(file).parent().unwrap()).unwrap();
        std::fs::write(dir.join(file), text).unwrap();
        for args in [&["add", "-A"][..], &["commit", "-q", "-m", file]] {
            let out = agent_git(dir, env, args);
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }

    /// What `scripts/check.sh` records when it passes: the worktree's tree.
    fn passed(dir: &Path) {
        let tree = git(dir, &["write-tree"]).unwrap();
        let at = git(
            dir,
            &["rev-parse", "--path-format=absolute", "--git-path", CHECKED],
        )
        .unwrap();
        let mut list = std::fs::read_to_string(at.trim()).unwrap_or_default();
        list.push_str(&tree);
        std::fs::write(at.trim(), list).unwrap();
    }

    /// A repo whose main declares its check, a bare remote it pushes to, and a writer's worktree on `fleetd/T9-x`.
    fn setup(dir: &Path, declared: bool) -> (PathBuf, PathBuf) {
        let root = repo(dir);
        if declared {
            commit(&root, &[], DECLARED, "{\"check\": \"scripts/check.sh\"}\n");
        }
        let remote = dir.join("remote.git");
        run(dir, &["init", "-q", "--bare", &remote.to_string_lossy()]);
        run(
            &root,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        );
        run(&root, &["push", "-q", "origin", "main"]);
        let wt = dir.join("wt");
        run(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "fleetd/T9-x",
                &wt.to_string_lossy(),
            ],
        );
        (root, wt)
    }

    fn push(dir: &Path, env: &[(String, String)], args: &[&str]) -> Result<(), String> {
        let out = agent_git(dir, env, &[&["push", "-q", "origin"][..], args].concat());
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        if out.status.success() {
            Ok(())
        } else {
            Err(err)
        }
    }

    fn gated(wt: &Path) -> Vec<(String, String)> {
        let mut env = Vec::new();
        gate(wt, &mut env).unwrap();
        env
    }

    #[test]
    fn a_writer_pushes_only_a_tree_its_check_passed_on() {
        let dir = tempfile::tempdir().unwrap();
        let (_root, wt) = setup(dir.path(), true);
        let env = gated(&wt);
        commit(&wt, &env, "src/a.rs", "fn a() {}\n");

        let refused = push(&wt, &env, &["fleetd/T9-x"]).unwrap_err();
        assert!(
            refused.contains(
                "fleetd: push refused: scripts/check.sh hasn't passed on fleetd/T9-x's tree at "
            ) && refused.contains("Run it in this worktree after your final rebase"),
            "{refused}"
        );

        passed(&wt);
        push(&wt, &env, &["fleetd/T9-x"]).unwrap();

        // A commit after the check, or a rebase onto a newer base, is another tree.
        commit(&wt, &env, "src/a.rs", "fn a() { b() }\n");
        assert!(push(&wt, &env, &["fleetd/T9-x"]).is_err());
        // Only the branch that hasn't passed is refused, and a branch deleted goes.
        passed(&wt);
        commit(&wt, &env, "src/b.rs", "fn b() {}\n");
        let refused = push(
            &wt,
            &env,
            &[
                "HEAD~1:refs/heads/fleetd/T9-y",
                "HEAD:refs/heads/fleetd/T9-z",
            ],
        )
        .unwrap_err();
        assert!(
            refused.contains("fleetd/T9-z's tree") && !refused.contains("T9-y"),
            "{refused}"
        );
        push(&wt, &env, &["HEAD~1:refs/heads/fleetd/T9-y"]).unwrap();
        push(&wt, &env, &[":fleetd/T9-y"]).unwrap();
    }

    #[test]
    fn a_repo_with_no_check_and_a_persons_pushes_are_not_gated() {
        let dir = tempfile::tempdir().unwrap();
        let (root, wt) = setup(dir.path(), true);
        let env = gated(&wt);
        // The person, in the writer's worktree and in their own checkout: no session environment, no gate.
        commit(&wt, &[], "a.md", "a\n");
        push(&wt, &[], &["fleetd/T9-x"]).unwrap();
        commit(&root, &env, "b.md", "b\n");
        push(&root, &env, &["main"]).unwrap();

        // A repo that names no check.
        let other = tempfile::tempdir().unwrap();
        let (_root, wt) = setup(other.path(), false);
        let env = gated(&wt);
        commit(&wt, &env, "a.md", "a\n");
        push(&wt, &env, &["fleetd/T9-x"]).unwrap();
    }

    #[test]
    fn the_hooks_git_would_run_still_run_beneath_the_gate() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (root, wt) = setup(dir.path(), true);
        run(&root, &["config", "extensions.worktreeConfig", "true"]);
        assert!(crate::node::landed::trailer_hooks(&wt, "T9").unwrap());
        let log = dir.path().join("hooks.log");
        for name in ["pre-push", "commit-msg"] {
            let hook = root.join(".git/hooks").join(name);
            // The pre-push hook logs the lines git gives it.
            let read = if name == "pre-push" { "cat" } else { ":" };
            let body = format!(
                "#!/bin/sh\necho {name} \"$@\" >> {0}\n{read} >> {0}\n",
                quoted(&log.to_string_lossy())
            );
            std::fs::write(&hook, body).unwrap();
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut env = vec![
            ("GIT_CONFIG_COUNT".to_owned(), "1".to_owned()),
            ("GIT_CONFIG_KEY_0".to_owned(), "user.name".to_owned()),
            ("GIT_CONFIG_VALUE_0".to_owned(), "w".to_owned()),
        ];
        gate(&wt, &mut env).unwrap();
        assert!(
            env.contains(&("GIT_CONFIG_COUNT".to_owned(), "2".to_owned())),
            "{env:?}"
        );
        assert!(env.iter().any(|(k, _)| k == "GIT_CONFIG_KEY_1"), "{env:?}");

        commit(&wt, &env, "a.md", "a\n");
        // fleetd's trailer hooks, and the repo's own, from beneath the gate.
        let msg = agent_git(&wt, &env, &["log", "-1", "--format=%B"]);
        assert!(String::from_utf8_lossy(&msg.stdout).contains("Fleetd-Task: T9"));
        passed(&wt);
        push(&wt, &env, &["fleetd/T9-x"]).unwrap();
        let sha = git(&wt, &["rev-parse", "HEAD"]).unwrap();
        let ran = std::fs::read_to_string(&log).unwrap();
        assert!(ran.starts_with("commit-msg "), "{ran}");
        assert!(
            ran.contains(&format!(
                "pre-push origin {}\nrefs/heads/fleetd/T9-x {}",
                dir.path().join("remote.git").display(),
                sha.trim()
            )),
            "{ran}"
        );
    }
}
