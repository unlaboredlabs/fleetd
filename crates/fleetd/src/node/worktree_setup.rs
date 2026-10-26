//! A project's setup commands (`SessionLaunch::setup`): run in order in a new worktree before its agent starts,
//! each with `sh -c`, the project's (and order's) variables and the project's time limit, until one fails. A worktree
//! set up before (an agent taking over another's) is not set up again while its commands and the contents of the
//! files setup names as its inputs are unchanged: the node keeps their digest in the worktree's own git directory,
//! which goes when the worktree does.
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use fleetd_contracts::project_settings::WorktreeSetup;
use sha2::{Digest, Sha256};

use super::cmd::{ConfinedRun, run_confined};

/// Where a worktree keeps the digest of the setup it was given.
const MARKER: &str = "fleetd-setup";

/// One command's run.
#[derive(Clone, Debug, PartialEq)]
pub struct Ran {
    pub command: String,
    pub exit_code: Option<i32>,
    /// The end of its output, at most `cmd::OUTPUT_TAIL_MAX` characters, with every secret value scrubbed.
    pub output_tail: String,
    pub timed_out: bool,
    pub took: Duration,
}

impl Ran {
    pub fn ok(&self) -> bool {
        self.exit_code == Some(0)
    }

    /// "exited 1 after 12 s", "passed its 600 s limit", "could not start".
    pub fn how(&self, timeout_sec: u64) -> String {
        let secs = self.took.as_secs();
        match self.exit_code {
            _ if self.timed_out => format!("passed its {timeout_sec} s limit"),
            Some(code) => format!("exited {code} after {secs} s"),
            None => format!("ended by a signal after {secs} s"),
        }
    }
}

/// What setup did in a worktree.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// Every command exited 0.
    Done(Vec<Ran>),
    /// The commands ran here before with the same inputs: nothing ran.
    Reused,
    /// The last command failed; the ones after it did not run.
    Failed { ran: Vec<Ran>, skipped: Vec<String> },
}

/// The git directory of the worktree at `cwd`: `.git` itself, or where a linked worktree's `.git` file points.
fn git_dir(cwd: &Path) -> Option<PathBuf> {
    let dot = cwd.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let target = text
        .lines()
        .find_map(|l| l.strip_prefix("gitdir: "))?
        .trim();
    let path = Path::new(target);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    })
}

/// The digest of the commands and of each input file's contents; `None` when setup names no inputs, which means it
/// always runs.
pub fn digest(setup: &WorktreeSetup, cwd: &Path) -> Option<String> {
    if setup.inputs.is_empty() {
        return None;
    }
    let mut hash = Sha256::new();
    for command in setup.commands.iter() {
        hash.update(b"command\0");
        hash.update(command.as_str().as_bytes());
        hash.update(b"\0");
    }
    for input in setup.inputs.iter() {
        hash.update(b"input\0");
        hash.update(input.as_str().as_bytes());
        match std::fs::read(cwd.join(input.as_str())) {
            Ok(bytes) => {
                hash.update(b"\0present\0");
                hash.update(Sha256::digest(&bytes));
            }
            Err(_) => hash.update(b"\0absent\0"),
        }
    }
    Some(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// The worktree at `cwd` was set up with this digest.
pub fn reusable(cwd: &Path, digest: &str) -> bool {
    git_dir(cwd)
        .and_then(|dir| std::fs::read_to_string(dir.join(MARKER)).ok())
        .is_some_and(|saved| saved.trim() == digest)
}

/// Records that the worktree at `cwd` was set up with this digest; a failed setup clears it.
pub fn record(cwd: &Path, digest: Option<&str>) {
    let Some(dir) = git_dir(cwd) else { return };
    let marker = dir.join(MARKER);
    let result = match digest {
        Some(d) => std::fs::write(&marker, format!("{d}\n")),
        None => match std::fs::remove_file(&marker) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
    };
    if let Err(e) = result {
        tracing::warn!(worktree = %cwd.display(), "setup digest not saved: {e}");
    }
}

/// Runs the commands in order in `cwd` with `env`, stopping at the first that fails. `scrub`: values replaced in
/// every output. `started(i)` is called as command `i` starts, `ended(i, ran)` as it ends.
pub async fn run(
    setup: &WorktreeSetup,
    cwd: &Path,
    env: &[(String, String)],
    scrub: &[String],
    mut started: impl FnMut(usize),
    mut ended: impl FnMut(usize, &Ran),
) -> Outcome {
    let digest = digest(setup, cwd);
    if digest.as_deref().is_some_and(|d| reusable(cwd, d)) {
        return Outcome::Reused;
    }
    let root = cwd.to_string_lossy().into_owned();
    let roots = [root.clone()];
    let timeout_sec = setup.timeout_sec.get() as u64;
    let mut ran = Vec::new();
    for (i, command) in setup.commands.iter().enumerate() {
        started(i);
        let argv = [
            "sh".to_owned(),
            "-c".to_owned(),
            command.as_str().to_owned(),
        ];
        let at = Instant::now();
        let outcome = run_confined(
            ConfinedRun {
                cwd: &root,
                argv: &argv,
                timeout_sec,
                env: Some(env.to_vec()),
                scrub,
            },
            &roots,
        )
        .await;
        let one = Ran {
            command: command.as_str().to_owned(),
            exit_code: outcome.exit_code,
            output_tail: outcome.not_run.unwrap_or(outcome.output_tail),
            timed_out: outcome.timed_out,
            took: at.elapsed(),
        };
        ended(i, &one);
        let ok = one.ok();
        ran.push(one);
        if !ok {
            record(cwd, None);
            let skipped = setup
                .commands
                .iter()
                .skip(i + 1)
                .map(|c| c.as_str().to_owned())
                .collect();
            return Outcome::Failed { ran, skipped };
        }
    }
    record(cwd, digest.as_deref());
    Outcome::Done(ran)
}

/// A shell line in one Markdown code span.
fn code(command: &str) -> String {
    let ticks = if command.contains('`') { "``" } else { "`" };
    format!("{ticks}{command}{ticks}")
}

/// The end of a command's output for a note: its last lines, at most `max` characters.
fn tail(text: &str, max: usize) -> &str {
    super::util::tail_utf16(text.trim_end(), max)
}

/// What the agent hears first about setup, or `None` when there was none. `again`: it ran before the agent went on
/// (its worktree rebuilt, or the node stopped in the middle of it), not before it started.
pub fn note(outcome: &Outcome, timeout_sec: u64, again: bool) -> Option<String> {
    let when = if again {
        "before you went on"
    } else {
        "before you started"
    };
    match outcome {
        Outcome::Done(ran) if ran.is_empty() => None,
        Outcome::Done(ran) => Some(format!(
            "Setup ran in this worktree {when}: {}.",
            ran.iter()
                .map(|r| format!("{} ({})", code(&r.command), r.how(timeout_sec)))
                .collect::<Vec<_>>()
                .join(", ")
        )),
        Outcome::Reused => Some(
            "Setup did not run again: this worktree was set up before with the same commands and inputs.".to_owned(),
        ),
        Outcome::Failed { ran, skipped } => {
            let last = ran.last()?;
            let mut note = format!(
                "Setup failed in this worktree {when}, and the project starts its agents anyway: {} {}.",
                code(&last.command),
                last.how(timeout_sec)
            );
            if !skipped.is_empty() {
                note.push_str(&format!(
                    " Not run after it: {}.",
                    skipped.iter().map(|c| code(c)).collect::<Vec<_>>().join(", ")
                ));
            }
            note.push_str(&format!(
                " The end of its output:\n```\n{}\n```\nFix what you need, or tell your lead if you can't.",
                tail(&last.output_tail, 1500)
            ));
            Some(note)
        }
    }
}

/// Why the start failed, for the run's failure: the command, how it ended and the end of its output.
pub fn failure(outcome: &Outcome, timeout_sec: u64) -> Option<String> {
    let Outcome::Failed { ran, skipped } = outcome else {
        return None;
    };
    let last = ran.last()?;
    let mut text = format!(
        "setup failed, so the agent did not start: {} {}",
        code(&last.command),
        last.how(timeout_sec)
    );
    if !skipped.is_empty() {
        text.push_str(&format!("; {} not run after it", skipped.len()));
    }
    text.push_str(&format!(
        ". Fix the project's setup commands (Settings › Projects) or turn on \"Start the agent anyway\". The end of its output:\n{}",
        tail(&last.output_tail, 3000)
    ));
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(commands: &[&str], inputs: &[&str]) -> WorktreeSetup {
        serde_json::from_value(serde_json::json!({
            "commands": commands, "inputs": inputs, "timeoutSec": 5
        }))
        .unwrap()
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        dir
    }

    #[tokio::test]
    async fn commands_run_in_order_with_the_env_and_stop_at_the_first_failure() {
        let dir = repo();
        let env = vec![
            ("PATH".to_owned(), std::env::var("PATH").unwrap()),
            ("TOKEN".to_owned(), "tok-secret-1".to_owned()),
        ];
        let s = setup(
            &[
                "echo one > made.txt",
                "echo \"using $TOKEN\"; cat made.txt; exit 3",
                "echo never > never.txt",
            ],
            &[],
        );
        let seen = std::sync::Mutex::new(Vec::new());
        let outcome = run(
            &s,
            dir.path(),
            &env,
            &["tok-secret-1".to_owned()],
            |i| seen.lock().unwrap().push(format!("start {i}")),
            |i, r| {
                seen.lock()
                    .unwrap()
                    .push(format!("end {i} {:?}", r.exit_code))
            },
        )
        .await;
        assert_eq!(
            *seen.lock().unwrap(),
            ["start 0", "end 0 Some(0)", "start 1", "end 1 Some(3)"]
        );
        let Outcome::Failed { ran, skipped } = &outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(ran.len(), 2);
        assert_eq!(skipped, &["echo never > never.txt"]);
        assert!(ran[1].output_tail.contains("using [secret]"), "{ran:?}");
        assert!(ran[1].output_tail.contains("one"));
        assert!(!dir.path().join("never.txt").exists());
        let why = failure(&outcome, 5).unwrap();
        assert!(
            why.contains("`echo \"using $TOKEN\"; cat made.txt; exit 3` exited 3"),
            "{why}"
        );
        assert!(why.contains("1 not run after it"), "{why}");
        assert!(!why.contains("tok-secret-1"));
        let told = note(&outcome, 5, false).unwrap();
        assert!(told.contains("starts its agents anyway"), "{told}");
    }

    #[tokio::test]
    async fn a_timeout_ends_the_command() {
        let dir = repo();
        let mut s = setup(&["sleep 30"], &[]);
        s.timeout_sec = fleetd_contracts::prim::Int::unchecked(1);
        let env = vec![("PATH".to_owned(), std::env::var("PATH").unwrap())];
        let outcome = run(&s, dir.path(), &env, &[], |_| {}, |_, _| {}).await;
        let Outcome::Failed { ran, .. } = &outcome else {
            panic!("{outcome:?}")
        };
        assert!(ran[0].timed_out);
        assert!(
            failure(&outcome, 1)
                .unwrap()
                .contains("passed its 1 s limit")
        );
    }

    #[tokio::test]
    async fn an_unchanged_worktree_is_not_set_up_again() {
        let dir = repo();
        std::fs::write(dir.path().join("pnpm-lock.yaml"), "a: 1\n").unwrap();
        let env = vec![("PATH".to_owned(), std::env::var("PATH").unwrap())];
        let s = setup(&["echo x >> count.txt"], &["pnpm-lock.yaml"]);
        let count = || {
            std::fs::read_to_string(dir.path().join("count.txt"))
                .unwrap_or_default()
                .lines()
                .count()
        };
        assert!(matches!(
            run(&s, dir.path(), &env, &[], |_| {}, |_, _| {}).await,
            Outcome::Done(_)
        ));
        assert_eq!(
            run(&s, dir.path(), &env, &[], |_| {}, |_, _| {}).await,
            Outcome::Reused
        );
        assert_eq!(count(), 1);
        assert!(
            note(&Outcome::Reused, 5, false)
                .unwrap()
                .contains("did not run again")
        );
        // A changed lockfile, or other commands, run it again.
        std::fs::write(dir.path().join("pnpm-lock.yaml"), "a: 2\n").unwrap();
        run(&s, dir.path(), &env, &[], |_| {}, |_, _| {}).await;
        assert_eq!(count(), 2);
        let other = setup(&["echo x >> count.txt", "true"], &["pnpm-lock.yaml"]);
        run(&other, dir.path(), &env, &[], |_| {}, |_, _| {}).await;
        assert_eq!(count(), 3);
        // Without inputs it always runs.
        let always = setup(&["echo x >> count.txt"], &[]);
        run(&always, dir.path(), &env, &[], |_| {}, |_, _| {}).await;
        run(&always, dir.path(), &env, &[], |_| {}, |_, _| {}).await;
        assert_eq!(count(), 5);
    }

    #[test]
    fn a_linked_worktree_keeps_its_marker_in_its_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        let gitdir = dir.path().join("main/.git/worktrees/w1");
        std::fs::create_dir_all(&gitdir).unwrap();
        let wt = dir.path().join("w1");
        std::fs::create_dir(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        record(&wt, Some("abc"));
        assert!(gitdir.join(MARKER).exists());
        assert!(reusable(&wt, "abc"));
        assert!(!reusable(&wt, "abd"));
        record(&wt, None);
        assert!(!reusable(&wt, "abc"));
    }
}
