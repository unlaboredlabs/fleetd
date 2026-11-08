//! Who the kernel's OOM killer takes first when a machine runs out of memory: an agent's processes, never the hub or
//! the node. Before, every one of them ran at the 200 a systemd user manager gives its services, so the services were
//! as likely a pick as a 9 GB rustc, and the pressure before each kill stalled them until the machine showed offline.
//!
//! The hub and node lower their own score as far as the kernel lets them ([`protect_service`]): to [`SERVICE`] where
//! the process may, otherwise to the user manager's own score, 100 under systemd's `user@.service`, which is as low as
//! an unprivileged process goes. Their units say the same (`OOMScoreAdjust=`, `cli/setup/units.rs`), and a unit from
//! before that is rewritten when its service starts (`update::service::refresh_own_unit`), so an update applies it. Everything
//! the node starts for an agent (its claude or session host, a browser, an emulator, a Linux desktop) starts at
//! [`AGENT`] ([`agent`]), and the agent's own children inherit it: builds, rust-analyzer, test runners.
//!
//! macOS has no OOM score to set: it compresses and swaps memory before it ends anything, and launchd already runs the
//! hub and node as `ProcessType=Interactive`, the band it ends last, so these are no-ops there.
use std::process::Command;

/// The hub's and node's score, where the process may set it (as root, or under a manager that runs lower).
pub const SERVICE: i32 = -900;
/// An agent's processes. The kernel adds the thousandths of memory a process holds to its score, so a service at 100
/// goes before an agent's process only if it holds over 40% more of the machine than that process does.
pub const AGENT: i32 = 500;

/// The score of process `pid` (`self` for this one), None where there is none (macOS).
pub fn score(pid: &str) -> Option<i32> {
    std::fs::read_to_string(format!("/proc/{pid}/oom_score_adj"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Lowers this process's score as far as the kernel allows. Returns it.
pub fn protect_service() -> Option<i32> {
    Some(lowest(score("self")?, |adj| {
        std::fs::write("/proc/self/oom_score_adj", adj.to_string()).is_ok()
    }))
}

/// From score `now`, the first of [`SERVICE`], 0 and 100 that `set` takes (an unprivileged process can't go below the
/// score its user manager started with), never one above `now`.
fn lowest(now: i32, mut set: impl FnMut(i32) -> bool) -> i32 {
    [SERVICE, 0, 100]
        .into_iter()
        .take_while(|&adj| adj < now)
        .find(|&adj| set(adj))
        .unwrap_or(now)
}

/// Starts `cmd` at [`AGENT`], so the kernel kills it, and whatever it starts, before the hub and the node. A score the
/// child can't take leaves it at the node's, and the spawn goes ahead.
pub fn agent(cmd: &mut Command) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let text = AGENT.to_string();
        // SAFETY: open and write are system calls only, on a path and bytes made before the fork: nothing allocates.
        unsafe {
            cmd.pre_exec(move || {
                let _ = raise(text.as_bytes());
                Ok(())
            });
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = cmd;
}

#[cfg(target_os = "linux")]
fn raise(text: &[u8]) -> nix::Result<usize> {
    use nix::fcntl::{OFlag, open};
    use nix::sys::stat::Mode;
    let fd = open(
        c"/proc/self/oom_score_adj",
        OFlag::O_WRONLY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )?;
    nix::unistd::write(&fd, text)
}

/// At a hub's or node's start: its score now, so it is the last the kernel kills.
pub fn protect(what: &str) {
    let before = score("self");
    let after = protect_service();
    tracing::info!(?before, ?after, "the {what}'s OOM score");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_service_goes_as_low_as_it_may_and_never_up() {
        // Under systemd's user manager: nothing below 100.
        assert_eq!(lowest(200, |adj| adj >= 100), 100);
        assert_eq!(lowest(200, |_| true), SERVICE);
        // No manager: the 0 every process starts with is the floor.
        assert_eq!(lowest(0, |adj| adj >= 0), 0);
        // Already lower: nothing is written.
        assert_eq!(lowest(-1000, |_| panic!("wrote a score")), -1000);
        assert_eq!(lowest(300, |_| false), 300);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_agents_process_starts_at_the_agent_score() {
        let mut cmd = Command::new("cat");
        cmd.arg("/proc/self/oom_score_adj");
        agent(&mut cmd);
        let out = cmd.output().unwrap();
        assert!(out.status.success());
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            AGENT.to_string()
        );
    }
}
