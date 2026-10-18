//! `cmd_check` frames from the hub: run argv (never through a shell) in a directory under the node's command roots,
//! kill the whole process group at the timeout, and reply with the exit code and the tail of the output.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

use super::util::{Utf8Stream, errno_name, scrubbed_env, tail_utf16};
use super::wire::{CmdCheck, CmdResult, Text, exit_code, tail_text};

pub const OUTPUT_TAIL_MAX: usize = 2000;
const SCRUBBED: &str = "[secret]";

/// The real directory `cwd` names, when it lies under one of `roots` after following symlinks on both sides.
pub fn confine(cwd: &str, roots: &[String]) -> Result<PathBuf, String> {
    let Ok(dir) = std::fs::canonicalize(cwd) else {
        return Err(format!("{cwd} does not exist on this machine"));
    };
    if !dir.is_dir() {
        return Err(format!("{cwd} is not a directory"));
    }
    let inside = roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| dir.starts_with(&root));
    if !inside {
        return Err(format!(
            "{cwd} is outside the directories this node runs commands in ({})",
            roots.join(", ")
        ));
    }
    Ok(dir)
}

pub struct ConfinedRun<'a> {
    pub cwd: &'a str,
    pub argv: &'a [String],
    pub timeout_sec: u64,
    /// The child's whole environment. Default: the scrubbed node environment.
    pub env: Option<Vec<(String, String)>>,
    /// Values replaced by `[secret]` in the output, so they never leave the node.
    pub scrub: &'a [String],
}

#[derive(Debug, PartialEq)]
pub struct RunOutcome {
    pub exit_code: Option<i32>,
    /// Scrubbed, at most OUTPUT_TAIL_MAX characters, with a note on how it ended when it did not exit on its own.
    pub output_tail: String,
    pub timed_out: bool,
    /// Why it never ran: a cwd outside the roots, or a command that could not start.
    pub not_run: Option<String>,
}

/// Every occurrence of each value replaced, longest first so a value inside another cannot leave a piece behind.
pub fn scrub_values(text: &str, values: &[String]) -> String {
    let mut sorted: Vec<&String> = values.iter().filter(|v| !v.is_empty()).collect();
    sorted.sort_by_key(|v| std::cmp::Reverse(v.len()));
    sorted.into_iter().fold(text.to_owned(), |out, value| {
        out.replace(value.as_str(), SCRUBBED)
    })
}

/// Kills the process group on drop unless disarmed: a dropped run (a lost link) takes its commands with it.
struct GroupGuard(Option<Pid>);

impl GroupGuard {
    fn kill(&self) {
        if let Some(pid) = self.0 {
            let _ = killpg(pid, Signal::SIGKILL);
        }
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

fn not_run(why: String) -> RunOutcome {
    RunOutcome {
        exit_code: None,
        output_tail: String::new(),
        timed_out: false,
        not_run: Some(why),
    }
}

async fn pump(mut from: impl tokio::io::AsyncRead + Unpin, to: mpsc::UnboundedSender<String>) {
    let mut decoder = Utf8Stream::default();
    let mut buf = vec![0u8; 8192];
    loop {
        match from.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let text = decoder.push(&buf[..n]);
                if !text.is_empty() && to.send(text).is_err() {
                    return;
                }
            }
        }
    }
    let rest = decoder.finish();
    if !rest.is_empty() {
        let _ = to.send(rest);
    }
}

/// Runs argv (never through a shell) in a directory under `roots`, killing the whole process group at the timeout.
/// Dropping the future kills the process group too.
pub async fn run_confined(run: ConfinedRun<'_>, roots: &[String]) -> RunOutcome {
    let scrub = run.scrub;
    let longest = scrub.iter().map(String::len).max().unwrap_or(0);
    let dir = match confine(run.cwd, roots) {
        Ok(dir) => dir,
        Err(why) => return not_run(format!("fleetd node refused to run this: {why}")),
    };
    let (command, args) = run
        .argv
        .split_first()
        .map_or(("", &[][..]), |(c, a)| (c.as_str(), a));
    let mut cmd = tokio::process::Command::new(command);
    // Its own process group, so a timeout also kills whatever the command started.
    cmd.args(args)
        .current_dir(Path::new(&dir))
        .env_clear()
        .envs(run.env.unwrap_or_else(scrubbed_env))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let code = errno_name(&error).unwrap_or_else(|| error.to_string());
            return not_run(format!("could not start {command}: spawn {command} {code}"));
        }
    };
    let mut guard = GroupGuard(child.id().map(|pid| Pid::from_raw(pid as i32)));
    let (tx, mut chunks) = mpsc::unbounded_channel();
    if let Some(out) = child.stdout.take() {
        tokio::spawn(pump(out, tx.clone()));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(pump(err, tx.clone()));
    }
    drop(tx);

    let mut output = String::new();
    // Keeps a little more than the tail so a multi-chunk tail is never cut short, and scrubs before trimming so a
    // secret split across chunks is whole when it is replaced; only a value still arriving can be at the end.
    let keep = 2 * OUTPUT_TAIL_MAX + longest;
    let push = |output: &mut String, chunk: String| {
        let joined = scrub_values(&(std::mem::take(output) + &chunk), scrub);
        *output = tail_utf16(&joined, keep).to_owned();
    };
    // Like Node's "close": the process has exited and every pipe has closed.
    let finished = async {
        let mut status = None;
        let mut streams_open = true;
        while status.is_none() || streams_open {
            tokio::select! {
                chunk = chunks.recv(), if streams_open => match chunk {
                    Some(chunk) => push(&mut output, chunk),
                    None => streams_open = false,
                },
                exited = child.wait(), if status.is_none() => status = Some(exited),
            }
        }
        status
    };
    let status = tokio::time::timeout(Duration::from_secs(run.timeout_sec), finished).await;
    let (exit_code, note, timed_out) = match status {
        Ok(Some(Ok(status))) => match status.code() {
            Some(code) => (Some(code), None, false),
            None => {
                let signal = std::os::unix::process::ExitStatusExt::signal(&status)
                    .and_then(|s| Signal::try_from(s).ok())
                    .map_or("a signal", Signal::as_str);
                (None, Some(format!("[fleetd: ended by {signal}]")), false)
            }
        },
        Ok(_) => (None, Some("[fleetd: ended by a signal]".to_owned()), false),
        Err(_) => {
            guard.kill();
            let _ = child.wait().await;
            while let Some(chunk) = chunks.recv().await {
                push(&mut output, chunk);
            }
            (
                None,
                Some(format!("[fleetd: killed after {} s]", run.timeout_sec)),
                true,
            )
        }
    };
    guard.0 = None;
    let text = match note {
        None => output,
        Some(note) if output.is_empty() => note,
        Some(note) => format!("{}\n{note}", output.strip_suffix('\n').unwrap_or(&output)),
    };
    let text = scrub_values(&text, scrub);
    RunOutcome {
        exit_code,
        output_tail: tail_utf16(&text, OUTPUT_TAIL_MAX).to_owned(),
        timed_out,
        not_run: None,
    }
}

/// Runs one `cmd_check` and always answers it. `exitCode` is null when the command timed out, died of a signal,
/// could not start, or was refused; `outputTail` then says which.
pub async fn run_cmd_check(frame: CmdCheck, roots: &[String]) -> CmdResult {
    let run = ConfinedRun {
        cwd: &frame.cwd,
        argv: &frame.argv,
        timeout_sec: frame.timeout_sec.get() as u64,
        env: None,
        scrub: &[],
    };
    let outcome = run_confined(run, roots).await;
    CmdResult {
        id: frame.id,
        exit_code: exit_code(outcome.exit_code),
        output_tail: outcome.not_run.map_or_else(
            || Text::unchecked(outcome.output_tail),
            |why| tail_text(&why),
        ),
        timed_out: outcome.timed_out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(cwd: &Path, argv: &[&str], timeout_sec: u64) -> CmdCheck {
        serde_json::from_value(
            serde_json::json!({ "id": "c1", "cwd": cwd, "argv": argv, "timeoutSec": timeout_sec }),
        )
        .unwrap()
    }

    /// (exitCode, outputTail, timedOut)
    fn parts(result: &CmdResult) -> (Option<i64>, &str, bool) {
        (
            result.exit_code.map(i64::from),
            result.output_tail.as_str(),
            result.timed_out,
        )
    }

    /// True when `pid` is gone, a zombie, or already inside the kernel's exit path (`PF_EXITING`, stat field 9):
    /// past that point it never runs user code again.
    fn dead(pid: i32) -> bool {
        const PF_EXITING: u64 = 0x4;
        std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true, |stat| {
            let fields: Vec<&str> = stat
                .rsplit_once(") ")
                .map_or(vec![], |(_, rest)| rest.split_whitespace().collect());
            fields.first() == Some(&"Z")
                || fields
                    .get(6)
                    .and_then(|f| f.parse::<u64>().ok())
                    .is_some_and(|flags| flags & PF_EXITING != 0)
        })
    }

    #[tokio::test]
    async fn confines_the_cwd_to_the_roots_through_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let workspace = root.path().join("repo");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("README.md"), "hi\n").unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.join("escape")).unwrap();
        let roots = vec![root.path().to_string_lossy().into_owned()];

        let ok = run_cmd_check(
            check(
                &workspace,
                &["sh", "-c", "echo out; echo err >&2; exit 3"],
                30,
            ),
            &roots,
        )
        .await;
        assert_eq!(parts(&ok), (Some(3), "out\nerr\n", false));
        let literal = run_cmd_check(
            check(&workspace, &["echo", "$HOME; touch pwned"], 30),
            &roots,
        )
        .await;
        assert_eq!(literal.output_tail.as_str(), "$HOME; touch pwned\n");
        assert!(!workspace.join("pwned").exists());

        let marker = outside.path().join("ran");
        for cwd in [
            outside.path().to_path_buf(),
            workspace.join("escape"),
            workspace.join("..").join(".."),
        ] {
            let refused = run_cmd_check(
                check(&cwd, &["touch", marker.to_str().unwrap()], 30),
                &roots,
            )
            .await;
            assert_eq!((refused.exit_code, refused.timed_out), (None, false));
            assert!(
                refused
                    .output_tail
                    .starts_with("fleetd node refused to run this:"),
                "{}",
                refused.output_tail
            );
            assert!(
                refused
                    .output_tail
                    .contains("outside the directories this node runs commands in")
            );
        }
        assert!(!marker.exists());
        let missing = run_cmd_check(check(&workspace.join("missing"), &["true"], 30), &roots).await;
        assert!(
            missing
                .output_tail
                .contains("does not exist on this machine")
        );
        let file = run_cmd_check(check(&workspace.join("README.md"), &["true"], 30), &roots).await;
        assert!(file.output_tail.contains("is not a directory"));
        let unknown =
            run_cmd_check(check(&workspace, &["no-such-command-fleetd"], 30), &roots).await;
        assert_eq!(unknown.exit_code, None);
        assert_eq!(
            unknown.output_tail.as_str(),
            "could not start no-such-command-fleetd: spawn no-such-command-fleetd ENOENT"
        );

        let long = run_cmd_check(
            check(
                &workspace,
                &[
                    "sh",
                    "-c",
                    "i=0; while [ $i -lt 600 ]; do echo line$i; i=$((i+1)); done",
                ],
                30,
            ),
            &roots,
        )
        .await;
        assert_eq!(long.output_tail.len(), OUTPUT_TAIL_MAX);
        assert!(long.output_tail.ends_with("line599\n"));
    }

    /// Paused time: the 1 s timeout can only fire once nothing else is pending. The blocking read of the script's
    /// fifo holds the clock (tokio does not auto-advance while a blocking task runs), so the kill comes exactly after
    /// the script has started its background child and printed, however loaded the machine is.
    #[tokio::test(start_paused = true)]
    async fn kills_the_whole_process_group_at_the_timeout() {
        let root = tempfile::tempdir().unwrap();
        let roots = vec![root.path().to_string_lossy().into_owned()];
        let fifo = root.path().join("bg.pid");
        nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::S_IRWXU).unwrap();
        let script = format!(
            "sleep 3600 & echo started; echo $! > {}; wait",
            fifo.display()
        );
        let ready = tokio::task::spawn_blocking(move || std::fs::read_to_string(fifo).unwrap());
        let (result, pid) = tokio::join!(
            run_cmd_check(check(root.path(), &["sh", "-c", &script], 1), &roots),
            ready
        );
        assert_eq!(
            parts(&result),
            (None, "started\n[fleetd: killed after 1 s]", true)
        );
        // run_cmd_check returns only after the output pipes closed, and the background sleep held them: it has
        // been killed and is exiting, whoever reaps it.
        let pid: i32 = pid.unwrap().trim().parse().unwrap();
        assert!(dead(pid));
    }
}
