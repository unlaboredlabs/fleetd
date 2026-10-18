//! A recorded claude process from before a node restart: identified by pid plus start time, so a pid the kernel
//! has since reused is never signalled, and stopped with the same escalation as a live interrupt.
use std::time::Duration;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;

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

/// SIGTERM the process group claude leads (it is spawned with `process_group(0)`), then SIGKILL it after `grace`.
/// Does nothing unless `pid` still has the recorded start time.
pub async fn kill_recorded(pid: u32, started: &str, grace: Duration) {
    let alive = || start_time(pid).as_deref() == Some(started);
    if pid <= 1 || pid > i32::MAX as u32 || !alive() {
        return;
    }
    let group = Pid::from_raw(pid as i32);
    tracing::warn!(
        pid,
        "stopping a claude process left from before the node restarted"
    );
    let _ = killpg(group, Signal::SIGTERM);
    let deadline = tokio::time::Instant::now() + grace;
    while tokio::time::Instant::now() < deadline {
        if !alive() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if alive() {
        let _ = killpg(group, Signal::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_the_recorded_process_is_killed() {
        let mut child = tokio::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let started = start_time(pid).unwrap();
        // A pid reused by another process (another start time) is left alone.
        kill_recorded(pid, "not-its-start-time", Duration::ZERO).await;
        assert_eq!(start_time(pid).as_deref(), Some(started.as_str()));
        kill_recorded(pid, &started, Duration::from_secs(5)).await;
        let status = child.wait().await.unwrap();
        assert_eq!(
            std::os::unix::process::ExitStatusExt::signal(&status),
            Some(15)
        );
    }
}
