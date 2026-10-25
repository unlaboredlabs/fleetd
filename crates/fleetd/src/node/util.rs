//! Small helpers shared by the node's modules: the scrubbed child environment, errno names as Node prints them,
//! UTF-16 length rules the contracts check, and ISO timestamps.
use std::path::PathBuf;
use std::time::Duration;

/// What children get of the node's environment, so the `CLAUDE*` ones of whatever started the node never leak into
/// the commands and sessions it runs.
const BASE_ENV: [&str; 4] = ["HOME", "PATH", "USER", "LANG"];
/// What git the hub runs on a project (`cmd_check`) also gets: the SSH agent and git's SSH command, so it reaches an
/// SSH remote whose key lives in the agent. Never claude sessions.
const GIT_SSH_ENV: [&str; 4] = [
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "GIT_SSH_COMMAND",
    "GIT_SSH",
];

/// Children get only `BASE_ENV`.
pub fn scrubbed_env() -> Vec<(String, String)> {
    passed_env(&BASE_ENV, |key| std::env::var(key).ok())
}

/// `scrubbed_env` plus `GIT_SSH_ENV`, for git the hub runs.
pub fn git_command_env() -> Vec<(String, String)> {
    let mut env = scrubbed_env();
    env.extend(passed_env(&GIT_SSH_ENV, |key| std::env::var(key).ok()));
    env
}

pub(crate) fn passed_env(
    keys: &[&str],
    var: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    keys.iter()
        .filter_map(|key| var(key).map(|value| ((*key).to_owned(), value)))
        .collect()
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The errno name Node puts in `error.code` (`ENOENT`, `EACCES`, ...).
pub fn errno_name(error: &std::io::Error) -> Option<String> {
    let errno = nix::errno::Errno::from_raw(error.raw_os_error()?);
    (errno != nix::errno::Errno::UnknownErrno).then(|| format!("{errno:?}"))
}

/// The last `max` UTF-16 code units of `text` (JS `slice(-max)`), never splitting a character.
pub fn tail_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices().rev() {
        units += ch.len_utf16();
        if units > max {
            return &text[index + ch.len_utf8()..];
        }
    }
    text
}

/// The first `max` UTF-16 code units of `text` (JS `slice(0, max)`), never splitting a character.
pub fn head_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

/// Decodes one output stream chunk by chunk like Node's `setEncoding("utf8")`: a character split across chunks is
/// held back until it completes, invalid bytes become U+FFFD.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    return out;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
                    match error.error_len() {
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + bad);
                        }
                    }
                }
            }
        }
    }

    pub fn finish(&mut self) -> String {
        let rest = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        rest
    }
}

/// Aborts the task when dropped, so a task lives exactly as long as whatever holds it.
pub struct AbortOnDrop(pub tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What Node's `execFile` callback sees: stdout, stderr, the exit code when there is one, and an error message for
/// anything but a clean exit 0.
pub struct Exec {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

/// `execFile(argv[0], argv[1..], { env: scrubbedEnv(), timeout })`: no shell, killed with SIGTERM at the timeout.
pub async fn exec(argv: &[String], timeout: Duration) -> Exec {
    let (command, args) = argv
        .split_first()
        .map_or(("", &[][..]), |(c, a)| (c.as_str(), a));
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args)
        .env_clear()
        .envs(scrubbed_env())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let code = errno_name(&error).unwrap_or_else(|| error.to_string());
            return Exec {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                error: Some(format!("spawn {command} {code}")),
            };
        }
    };
    let output = tokio::time::timeout(timeout, child.wait_with_output()).await;
    // At the timeout the dropped child is killed (kill_on_drop).
    let Ok(Ok(output)) = output else {
        return Exec {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            error: Some(format!("Command failed: {}", argv.join(" "))),
        };
    };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let exit_code = output.status.code();
    let error =
        (!output.status.success()).then(|| format!("Command failed: {}\n{stderr}", argv.join(" ")));
    Exec {
        stdout,
        stderr,
        exit_code,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_git_the_hub_runs_gets_the_ssh_agent_and_gits_ssh_command() {
        let node: std::collections::HashMap<&str, &str> = [
            ("HOME", "/home/me"),
            ("PATH", "/usr/bin"),
            ("SSH_AUTH_SOCK", "/run/user/1000/ssh-agent.sock"),
            ("SSH_AGENT_PID", "4242"),
            ("GIT_SSH_COMMAND", "ssh -i ~/.ssh/deploy"),
            ("GIT_SSH", "/usr/bin/ssh"),
            ("CLAUDE_CODE_ENTRYPOINT", "cli"),
            ("GITHUB_TOKEN", "secret"),
        ]
        .into();
        let var = |key: &str| node.get(key).map(|v| (*v).to_owned());
        let keys = |env: Vec<(String, String)>| env.into_iter().map(|(k, _)| k).collect::<Vec<_>>();
        assert_eq!(keys(passed_env(&BASE_ENV, var)), ["HOME", "PATH"]);
        assert_eq!(
            keys(passed_env(&GIT_SSH_ENV, var)),
            [
                "SSH_AUTH_SOCK",
                "SSH_AGENT_PID",
                "GIT_SSH_COMMAND",
                "GIT_SSH"
            ]
        );
    }
}
