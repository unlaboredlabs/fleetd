//! vercel-labs' agent-desktop, the agents' GUI vocabulary on the Mac: it reads an app's accessibility tree into refs
//! (`snapshot --app Finder -i`) and acts on them (`click @s8f3k2p9:e12`), headless by default. The node installs a
//! pinned release under `<node home>/desktop/mac/agent-desktop/<version>` and runs it itself, one command per
//! `desktop` action `agent_desktop`, so it acts in the node's own GUI session under the node's Accessibility and
//! Screen Recording grants (it is the node's child), and never from an agent's shell. Each session gets its own
//! agent-desktop home (its snapshots and refs), thrown away at its end.
//!
//! An app launched with `--cdp` opens a DevTools port on the Mac's loopback (agent-desktop binds 127.0.0.1 and
//! checks the listener is the app's). The node keeps it there: a launch that names another address is refused, and
//! the app is closed when the session ends. A `batch` that launches with `--cdp` is refused, since the node could not
//! tell which app to close.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use sha2::Digest;

/// The agent-desktop release the node installs.
pub const VERSION: &str = "1.1.0";

/// The release's archive for this Mac and its sha256, as the release's checksums.txt lists them.
fn archive() -> (&'static str, &'static str) {
    if cfg!(target_arch = "aarch64") {
        (
            "aarch64-apple-darwin",
            "3048e00aa0741bf25ffe0326f78c966408be4490ce13513f3f94ecf2a0b5270d",
        )
    } else {
        (
            "x86_64-apple-darwin",
            "b6352ac66aa49e0280c6f690de791dc03c827623a838950856b20ddbebcdc382",
        )
    }
}

fn archive_url(target: &str) -> String {
    format!(
        "https://github.com/vercel-labs/agent-desktop/releases/download/v{VERSION}/agent-desktop-v{VERSION}-{target}.tar.gz"
    )
}

/// How long one command may run: under the hub's wait for a call it forwards to the Mac (hub/machine_roles/calls.rs,
/// CALL_WAIT 45 s), so the agent always gets the command's own answer, a stop at this limit included. A longer `wait`
/// is the agent's to take in steps.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(40);

/// The start of what a command printed that the agent gets back.
pub const OUTPUT_CHARS: usize = 100_000;

pub fn install_dir(home: &Path) -> PathBuf {
    super::mac_dir(home).join("agent-desktop").join(VERSION)
}

/// The pinned binary, once installed.
pub fn find(home: &Path) -> Option<PathBuf> {
    let dir = install_dir(home);
    let bin = dir.join("agent-desktop");
    let version = std::fs::read_to_string(dir.join("VERSION")).ok()?;
    (version.trim() == VERSION && bin.is_file() && dir.join("agent-desktop-macos-helper").is_file())
        .then_some(bin)
}

/// Installs the pinned release (its archive, checked against the digest pinned here; it holds the CLI and its macOS
/// helper, which must sit beside it), unless it is there already.
pub async fn install(home: &Path) -> Result<PathBuf, String> {
    // One install at a time: the node's start and a first session may both ask.
    static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one = INSTALLING.lock().await;
    if let Some(bin) = find(home) {
        return Ok(bin);
    }
    let (target, sha256) = archive();
    let dir = install_dir(home);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
    let url = archive_url(target);
    let bytes = reqwest::get(&url)
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("cannot download agent-desktop: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("cannot download agent-desktop: {e}"))?;
    let digest: String = sha2::Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if digest != sha256 {
        return Err(format!(
            "agent-desktop's archive is not the pinned one (sha256 {digest})"
        ));
    }
    let file = dir.join("agent-desktop.tar.gz");
    std::fs::write(&file, &bytes).map_err(|e| format!("cannot write {}: {e}", file.display()))?;
    let out = tokio::process::Command::new("tar")
        .arg("-xzf")
        .arg(&file)
        .arg("-C")
        .arg(&dir)
        .args(["agent-desktop", "agent-desktop-macos-helper"])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("cannot unpack agent-desktop: {e}"))?;
    let _ = std::fs::remove_file(&file);
    if !out.status.success() {
        return Err(format!(
            "unpacking agent-desktop failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    std::fs::write(dir.join("VERSION"), VERSION).map_err(|e| e.to_string())?;
    find(home).ok_or_else(|| "agent-desktop's archive lacks its CLI or its helper".to_owned())
}

/// agent-desktop's arguments as a shell would split them: words, with '…' and "…" quoting and \ escaping.
pub fn split(text: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => word.push(c),
                        None => return Err("a ' that doesn't close".into()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(c @ ('"' | '\\')) => word.push(c),
                            Some(c) => {
                                word.push('\\');
                                word.push(c);
                            }
                            None => return Err("a \" that doesn't close".into()),
                        },
                        Some(c) => word.push(c),
                        None => return Err("a \" that doesn't close".into()),
                    }
                }
            }
            '\\' => {
                in_word = true;
                if let Some(c) = chars.next() {
                    word.push(c);
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                word.push(c);
            }
        }
    }
    if in_word {
        words.push(word);
    }
    Ok(words)
}

/// The commands that only read the screen and its apps: a session that doesn't hold the Mac's lease may run them.
const OBSERVING: [&str; 15] = [
    "version",
    "status",
    "skills",
    "permissions",
    "snapshot",
    "find",
    "get",
    "is",
    "wait",
    "screenshot",
    "list-apps",
    "list-windows",
    "list-displays",
    "list-surfaces",
    "list-notifications",
];

/// One command, checked before it runs: its arguments, and whether it only observes.
#[derive(Debug, PartialEq, Eq)]
pub struct Command {
    pub args: Vec<String>,
    pub observing: bool,
    /// A launch with `--cdp`: the node closes the app it starts when the session ends.
    pub cdp: bool,
}

/// `text` as one agent-desktop command, or why the node won't run it.
pub fn command(text: &str) -> Result<Command, String> {
    let args = split(text)?;
    let Some(name) = args.first() else {
        return Err(
            "agent_desktop needs its arguments, the command first (`snapshot --app Finder -i`)"
                .into(),
        );
    };
    if name.starts_with('-') {
        return Err(format!(
            "put agent-desktop's command first and its flags after it (`click @ref --headed`, not `{name} click @ref`)"
        ));
    }
    let has = |flag: &str| {
        args.iter()
            .any(|a| a == flag || a.starts_with(&format!("{flag}=")))
    };
    let cdp = name == "launch" && has("--cdp");
    if args
        .iter()
        .any(|a| a.contains("--remote-debugging-address"))
    {
        return Err(
            "a DevTools port stays on the Mac's loopback: launch with --cdp alone, without --remote-debugging-address"
                .into(),
        );
    }
    if name == "batch" && text.contains("cdp") {
        return Err(
            "run `launch <app> --cdp` on its own, not in a batch, so the node can close the app when your session ends"
                .into(),
        );
    }
    let observing = OBSERVING.contains(&name.as_str())
        && !(name == "permissions" && (has("--request") || has("--guide")));
    Ok(Command {
        args,
        observing,
        cdp,
    })
}

/// The pid of the app a `launch --cdp` started, from its JSON answer (`data.pid`, with `data.cdp` set).
pub fn launched_pid(output: &str) -> Option<u32> {
    let answer: serde_json::Value = serde_json::from_str(output.trim()).ok()?;
    let data = &answer["data"];
    if answer["ok"] != true || data["cdp"].is_null() {
        return None;
    }
    data["pid"].as_u64().and_then(|p| u32::try_from(p).ok())
}

/// What a command printed, cut for the agent.
pub fn answer(stdout: &str, stderr: &str, code: Option<i32>) -> String {
    let mut text = stdout.trim().to_owned();
    if text.is_empty() {
        text = stderr.trim().to_owned();
    }
    if text.is_empty() {
        text = match code {
            Some(0) => "agent-desktop printed nothing.".to_owned(),
            Some(c) => format!("agent-desktop exited with code {c} and printed nothing."),
            None => format!(
                "agent-desktop was stopped after {} s and printed nothing: wait in shorter steps (--timeout-ms), or read a \
                 smaller part (snapshot --skeleton, --root <ref>)",
                COMMAND_TIMEOUT.as_secs()
            ),
        };
    }
    if text.chars().count() > OUTPUT_CHARS {
        let cut: String = text.chars().take(OUTPUT_CHARS).collect();
        text = format!(
            "{cut}\n[cut at {OUTPUT_CHARS} characters: read a smaller part, with snapshot --skeleton, --root <ref> or -i]"
        );
    }
    text
}

/// Runs one command (blocking) with the session's own agent-desktop home, at most [`COMMAND_TIMEOUT`]: its exit
/// code (None when it was stopped), what it printed and what it said on stderr.
pub fn run(
    bin: &Path,
    session_home: &Path,
    args: &[String],
) -> Result<(Option<i32>, String, String), String> {
    crate::node::config::mkdir_private(session_home)
        .map_err(|e| format!("cannot make {}: {e}", session_home.display()))?;
    let mut child = std::process::Command::new(bin)
        .args(args)
        .env("AGENT_DESKTOP_HOME", session_home)
        .current_dir(session_home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run agent-desktop: {e}"))?;
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let read = |pipe: Option<std::process::ChildStdout>| {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = std::io::Read::read_to_end(&mut pipe, &mut out);
            }
            String::from_utf8_lossy(&out).into_owned()
        })
    };
    let out = read(stdout);
    let err = std::thread::spawn(move || {
        let mut text = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = std::io::Read::read_to_end(&mut pipe, &mut text);
        }
        String::from_utf8_lossy(&text).into_owned()
    });
    let started = Instant::now();
    let code = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status.code();
        }
        if started.elapsed() > COMMAND_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok((
        code,
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default(),
    ))
}
