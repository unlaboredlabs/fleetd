//! Process trees of runner sessions: finding every process a session started, killing them, and reaping the ones
//! the node adopts.
//!
//! A process-group kill is not enough. claude's Bash tool starts each command in its own process group, so after a
//! SIGKILL to claude's group the tool's child ran on, reparented to the user manager (fixture `sigkill-mid-tool`).
//! A sweep therefore collects the session's processes three ways, always *before* signalling:
//! - the descendants of the session's root pid, walking ppid links (`/proc/*/stat` on Linux, `ps` on macOS);
//! - on Linux, every process whose environment carries [`SESSION_MARKER`] for the session. Children inherit it through
//!   forks, `setsid` and reparenting, so this also finds what escaped after its parent died;
//! - on Linux, the node is child subreaper ([`adopt_orphans`]), so orphans reparent to the node instead of escaping to
//!   init, and get reaped here.
//!
//! Nothing here touches a process that is not provably the session's: groups are signalled only when their leader is
//! in the sweep, the node's own group never, and on Linux every pid is re-checked against its start time first.
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::{Signal, kill, killpg};
use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
use nix::unistd::{Pid, getpgrp, getpid};

/// Set to the session id in every runner child's environment.
pub const SESSION_MARKER: &str = "FLEETD_RUNNER_SESSION";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    /// Linux: start time in clock ticks since boot (`/proc/<pid>/stat` field 22), so a reused pid is never mistaken
    /// for the process that was swept. `None` on macOS.
    pub start: Option<u64>,
    pub zombie: bool,
}

/// One `/proc/<pid>/stat` line. The command name sits in parentheses and may itself contain spaces and `)`.
pub fn parse_stat(pid: i32, stat: &str) -> Option<Proc> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    Some(Proc {
        pid,
        zombie: *fields.first()? == "Z",
        ppid: fields.get(1)?.parse().ok()?,
        pgid: fields.get(2)?.parse().ok()?,
        start: fields.get(19).and_then(|s| s.parse().ok()),
    })
}

/// Every process on the machine, as far as this user can see.
#[cfg(target_os = "linux")]
pub fn table() -> Vec<Proc> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| {
            let pid: i32 = entry.ok()?.file_name().to_str()?.parse().ok()?;
            parse_stat(
                pid,
                &std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?,
            )
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
pub fn table() -> Vec<Proc> {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,pgid=,stat="])
        .env_clear()
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut f = line.split_whitespace();
            Some(Proc {
                pid: f.next()?.parse().ok()?,
                ppid: f.next()?.parse().ok()?,
                pgid: f.next()?.parse().ok()?,
                start: None,
                zombie: f.next().is_some_and(|s| s.starts_with('Z')),
            })
        })
        .collect()
}

/// Every descendant of `root` in `table`, not `root` itself. Nothing for pid 0 or 1: their descendants are the
/// whole machine.
pub fn descendants(table: &[Proc], root: i32) -> Vec<Proc> {
    if root <= 1 {
        return Vec::new();
    }
    let mut children: HashMap<i32, Vec<&Proc>> = HashMap::new();
    for proc in table {
        children.entry(proc.ppid).or_default().push(proc);
    }
    let mut out = Vec::new();
    let mut seen = HashSet::from([root]);
    let mut next = vec![root];
    while let Some(pid) = next.pop() {
        for child in children.get(&pid).into_iter().flatten() {
            if seen.insert(child.pid) {
                out.push(**child);
                next.push(child.pid);
            }
        }
    }
    out
}

/// The live processes in `table` whose environment marks them as `session`'s.
#[cfg(target_os = "linux")]
pub fn marked(table: &[Proc], session: &str) -> Vec<Proc> {
    let needle = format!("{SESSION_MARKER}={session}");
    let own = getpid().as_raw();
    table
        .iter()
        .filter(|p| p.pid != own && !p.zombie)
        .filter(|p| {
            // Unreadable for other users' processes, empty for zombies: neither is ours to sweep.
            std::fs::read(format!("/proc/{}/environ", p.pid))
                .is_ok_and(|env| env.split(|b| *b == 0).any(|var| var == needle.as_bytes()))
        })
        .copied()
        .collect()
}

/// macOS cannot read another process's environment without parsing `ps -E`; the ppid walk has to do.
#[cfg(not(target_os = "linux"))]
pub fn marked(_table: &[Proc], _session: &str) -> Vec<Proc> {
    Vec::new()
}

/// What a sweep of `session` (rooted at `root`) finds right now. Blocking: on macOS it runs `ps`.
pub fn sweep(root: i32, session: &str) -> Vec<Proc> {
    let table = table();
    let mut found = descendants(&table, root);
    found.extend(
        marked(&table, session)
            .into_iter()
            .filter(|p| p.pid != root),
    );
    dedupe(&mut found);
    found
}

/// Keeps the first entry per pid.
pub fn dedupe(procs: &mut Vec<Proc>) {
    let mut seen = HashSet::new();
    procs.retain(|p| seen.insert(p.pid));
}

/// Still the same process that was swept (its pid was not reused since).
fn same(proc: &Proc) -> bool {
    match proc.start {
        Some(start) => std::fs::read_to_string(format!("/proc/{}/stat", proc.pid))
            .ok()
            .and_then(|stat| parse_stat(proc.pid, &stat))
            .is_some_and(|now| now.start == Some(start)),
        None => true,
    }
}

/// Signals every swept process: first each group led by a swept process (catching members that forked after the
/// sweep), then each pid. Never the node's own group or pid. Errors (already gone, not ours) are ignored.
pub fn signal(procs: &[Proc], sig: Signal) {
    let own_pid = getpid().as_raw();
    let own_group = getpgrp().as_raw();
    for leader in procs.iter().filter(|p| p.pgid == p.pid) {
        if leader.pgid > 1 && leader.pgid != own_group && same(leader) {
            let _ = killpg(Pid::from_raw(leader.pgid), sig);
        }
    }
    for proc in procs {
        if proc.pid > 1 && proc.pid != own_pid && same(proc) {
            let _ = kill(Pid::from_raw(proc.pid), sig);
        }
    }
}

/// Reaps the swept processes that became the node's children (adopted as subreaper), waiting up to `limit` for the
/// ones still dying. Pids that are not the node's children are left to their parents.
pub async fn reap(procs: &[Proc], limit: Duration) {
    let mut dying = Vec::new();
    for proc in procs {
        if !same(proc) {
            continue;
        }
        let pid = Pid::from_raw(proc.pid);
        if let Ok(WaitStatus::StillAlive) = waitpid(pid, Some(WaitPidFlag::WNOHANG)) {
            dying.push(pid);
        }
    }
    if dying.is_empty() {
        return;
    }
    // Each was sent SIGKILL, so these waits end as soon as the kernel finishes tearing the process down.
    let waits = tokio::task::spawn_blocking(move || {
        for pid in dying {
            while waitpid(pid, None) == Err(Errno::EINTR) {}
        }
    });
    let _ = tokio::time::timeout(limit, waits).await;
}

/// Whether the node may reap an adopted zombie it never identified. The node itself starts children only in its
/// own process group (std and tokio defaults) or as group leaders (`process_group(0)`), and tokio must reap those
/// itself or its `wait` fails. A child in neither is therefore an orphan the node adopted as subreaper.
pub fn adopted(proc: &Proc, own_group: i32) -> bool {
    proc.pgid != proc.pid && proc.pgid != own_group
}

/// Makes the node child subreaper (Linux), so a session's orphans reparent to the node, where a sweep can still
/// find them by ppid, instead of escaping to init. Idempotent. Adopted orphans that exit on their own are reaped on
/// each SIGCHLD (see [`adopted`]); swept ones by [`reap`].
#[cfg(target_os = "linux")]
pub fn adopt_orphans() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if let Err(error) = nix::sys::prctl::set_child_subreaper(true) {
            tracing::warn!("could not become child subreaper: {error}");
            return;
        }
        let Ok(mut sigchld) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child())
        else {
            return;
        };
        tokio::spawn(async move {
            while sigchld.recv().await.is_some() {
                let _ = tokio::task::spawn_blocking(reap_adopted).await;
            }
        });
    });
}

#[cfg(not(target_os = "linux"))]
pub fn adopt_orphans() {}

#[cfg(target_os = "linux")]
fn reap_adopted() {
    let own_pid = getpid().as_raw();
    let own_group = getpgrp().as_raw();
    for proc in table() {
        if proc.ppid == own_pid && proc.zombie && adopted(&proc, own_group) {
            let _ = waitpid(Pid::from_raw(proc.pid), Some(WaitPidFlag::WNOHANG));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: i32, ppid: i32, pgid: i32) -> Proc {
        Proc {
            pid,
            ppid,
            pgid,
            start: None,
            zombie: false,
        }
    }

    #[test]
    fn parses_stat_lines_whose_command_holds_parentheses() {
        let stat = "4242 (we (ird) name) S 4200 4242 4100 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 1 1";
        assert_eq!(
            parse_stat(4242, stat),
            Some(Proc {
                pid: 4242,
                ppid: 4200,
                pgid: 4242,
                start: Some(987654),
                zombie: false
            })
        );
        let zombie = "7 (sleep) Z 1 6 6 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 55 0 0";
        assert!(parse_stat(7, zombie).unwrap().zombie);
    }

    #[test]
    fn descendants_follow_ppid_links_across_process_groups() {
        // 10 is claude; 11 its tool shell in its own group; 12 a grandchild; 20 an unrelated process; 13 a cycle
        // guard (a pid listing itself as parent must not loop).
        let table = [
            proc(10, 1, 10),
            proc(11, 10, 11),
            proc(12, 11, 11),
            proc(20, 1, 20),
            proc(13, 13, 13),
        ];
        let mut found: Vec<i32> = descendants(&table, 10).iter().map(|p| p.pid).collect();
        found.sort();
        assert_eq!(found, vec![11, 12]);
        assert!(descendants(&table, 13).is_empty());
        assert!(descendants(&table, 1).is_empty());
        assert!(descendants(&table, 0).is_empty());
    }

    #[test]
    fn only_orphans_outside_the_nodes_own_spawn_patterns_count_as_adopted() {
        let own_group = 100;
        // Inherited the node's group: a std/tokio child the node spawned itself.
        assert!(!adopted(&proc(5, 100, 100), own_group));
        // A group leader: claude or a cmd check (`process_group(0)`); tokio reaps those.
        assert!(!adopted(&proc(6, 100, 6), own_group));
        // In some other process's group: a tool child orphaned to the node.
        assert!(adopted(&proc(7, 100, 6), own_group));
    }
}
