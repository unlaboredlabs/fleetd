//! Running commands locally and on a machine over SSH, each with its stdin given up front.

use std::process::Stdio;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::units::q;

#[derive(Clone)]
pub struct SshTarget {
    pub host: String,
    /// An ssh_config file (`ssh -F`), e.g. a lab's own host, port and key.
    pub config: Option<String>,
}

pub struct RunResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

fn config_args(target: &SshTarget) -> Vec<String> {
    target
        .config
        .iter()
        .flat_map(|config| ["-F".to_owned(), config.clone()])
        .collect()
}

/// How a command is shown before it runs: what you would type to run it yourself.
pub fn show_ssh(target: &SshTarget, command: &str) -> String {
    let mut words = config_args(target);
    words.push(target.host.clone());
    format!(
        "ssh {} {}",
        words.iter().map(|w| q(w)).collect::<Vec<_>>().join(" "),
        q(command)
    )
}

/// Runs `command` under the remote user's `sh`, whatever their login shell is.
pub async fn run_ssh(target: &SshTarget, command: &str, stdin: Option<&[u8]>) -> RunResult {
    let mut args = config_args(target);
    args.extend(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"].map(String::from));
    args.push(target.host.clone());
    args.push("--".into());
    args.push(format!("sh -c {}", q(command)));
    run_local("ssh", &args, stdin).await
}

pub async fn run_local(file: &str, args: &[String], stdin: Option<&[u8]>) -> RunResult {
    let child = tokio::process::Command::new(file)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            return RunResult {
                code: 127,
                stdout: String::new(),
                stderr: error.to_string(),
            };
        }
    };
    let mut input = child.stdin.take().expect("piped");
    let data = stdin.map(<[u8]>::to_vec).unwrap_or_default();
    let mut out = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    // Feed stdin while draining both pipes, so a large stdin (the binary) cannot deadlock against a chatty child.
    let feed = async move {
        let _ = input.write_all(&data).await;
        drop(input);
    };
    let read_out = async move {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf).await;
        buf
    };
    let read_err = async move {
        let mut buf = Vec::new();
        let _ = err.read_to_end(&mut buf).await;
        buf
    };
    let ((), stdout, stderr) = tokio::join!(feed, read_out, read_err);
    let code = child
        .wait()
        .await
        .ok()
        .and_then(|status| status.code())
        .unwrap_or(1);
    RunResult {
        code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    }
}
