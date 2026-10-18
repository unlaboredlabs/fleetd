//! A recorded claude process from before a node restart: identified by pid plus start time, so a pid the kernel
//! has since reused is never signalled, and stopped together with every process its session started.
use std::time::Duration;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;

use crate::node::runner::process::{self, Proc};

/// After SIGKILL: how long to wait for the swept processes to be gone.
const KILL_WAIT: Duration = Duration::from_secs(2);

/// The process's start time as the kernel reports it, `None` when it is gone. Opaque: only compared for equality.
pub fn start_time(pid: u32) -> Option<String> {
    if cfg!(target_os = "linux") {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // Field 22, counted after the parenthesised command name (which may itself contain spaces).
        let fields: Vec<&str> = stat[stat.rfind(')')? + 2..].split(' ').collect();
        // A zombie has exited; it only waits for its parent to reap it.
        (fields.first() != Some(&"Z"))
            .then(|| fields.get(19).map(|s| (*s).to_owned()))
            .flatten()
    } else {
        let out = std::process::Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (out.status.success() && !text.is_empty()).then_some(text)
    }
}

fn gone(proc: &Proc) -> bool {
    let now = start_time(proc.pid as u32);
    match proc.start {
        Some(start) => now.and_then(|s| s.parse().ok()) != Some(start),
        None => now.is_none(),
    }
}

/// Session `session`'s processes: claude's descendants while claude (`root`) is still the recorded process, and
/// on Linux every process carrying the session's marker, which also finds tool children orphaned when claude died.
async fn sweep(root: Option<i32>, session: &str) -> Vec<Proc> {
    let session = session.to_owned();
    tokio::task::spawn_blocking(move || match root {
        Some(root) => process::sweep(root, &session),
        None => process::marked(&process::table(), &session),
    })
    .await
    .unwrap_or_default()
}

/// Stops what session `session` left running when the node went away: SIGTERM to claude's process group (claude
/// kills its tool children on SIGTERM), SIGKILL after `grace`, then SIGKILL to every swept process and group. The
/// sweep comes before each signal, because once claude is gone its children can no longer be found by ppid. Claude
/// itself is signalled only while `pid` still has the recorded start time.
pub async fn kill_recorded(pid: u32, started: &str, session: &str, grace: Duration) {
    let alive = || start_time(pid).as_deref() == Some(started);
    let root = (pid > 1 && pid <= i32::MAX as u32 && alive()).then_some(pid as i32);
    let mut swept = sweep(root, session).await;
    if root.is_none() && swept.is_empty() {
        return;
    }
    tracing::warn!(
        pid,
        session_id = session,
        leftover = swept.len(),
        "stopping claude processes left from before the node restarted"
    );
    if let Some(root) = root {
        let group = Pid::from_raw(root);
        let _ = killpg(group, Signal::SIGTERM);
        let deadline = tokio::time::Instant::now() + grace;
        while alive() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        swept.extend(sweep(alive().then_some(root), session).await);
        process::dedupe(&mut swept);
        if alive() {
            let _ = killpg(group, Signal::SIGKILL);
        }
    }
    process::signal(&swept, Signal::SIGKILL);
    let deadline = tokio::time::Instant::now() + KILL_WAIT;
    while !swept.iter().all(gone) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    /// A stand-in for claude that starts a "tool" in its own process group (as claude's Bash tool does), prints the
    /// tool's pid and waits.
    async fn claude_with_tool(session: &str) -> (tokio::process::Child, u32) {
        let mut child = tokio::process::Command::new("sh")
            .args(["-c", "setsid sleep 30 & echo $!; wait"])
            .env(process::SESSION_MARKER, session)
            .stdout(std::process::Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
        let tool: u32 = lines.next_line().await.unwrap().unwrap().parse().unwrap();
        (child, tool)
    }

    #[tokio::test]
    async fn a_restart_kills_the_recorded_claude_and_its_tool_children_only() {
        let (mut child, tool) = claude_with_tool("restart-a").await;
        let pid = child.id().unwrap();
        let started = start_time(pid).unwrap();
        // A pid reused by another process (another start time) is left alone, and so are its descendants.
        kill_recorded(pid, "not-its-start-time", "restart-other", Duration::ZERO).await;
        assert_eq!(start_time(pid).as_deref(), Some(started.as_str()));
        assert!(start_time(tool).is_some());

        kill_recorded(pid, &started, "restart-a", Duration::from_secs(5)).await;
        let status = child.wait().await.unwrap();
        assert_eq!(
            std::os::unix::process::ExitStatusExt::signal(&status),
            Some(15)
        );
        // The tool ran in its own group, so the SIGTERM to claude's group missed it; the sweep did not.
        assert_eq!(start_time(tool), None);
    }

    #[tokio::test]
    async fn a_restart_finds_tool_children_orphaned_by_a_claude_that_already_died() {
        let (mut child, tool) = claude_with_tool("restart-b").await;
        let pid = child.id().unwrap();
        let started = start_time(pid).unwrap();
        child.kill().await.unwrap();
        assert!(start_time(tool).is_some());

        kill_recorded(pid, &started, "restart-b", Duration::from_secs(5)).await;
        assert_eq!(start_time(tool), None);
    }
}
