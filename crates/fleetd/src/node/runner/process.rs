//! Process trees of runner sessions: finding every process a session started, killing them, and reaping the ones
//! the node adopts.
//!
//! A process-group kill is not enough. claude's Bash tool starts each command in its own process group, so after a
//! SIGKILL to claude's group the tool's child ran on, reparented to the user manager (fixture `sigkill-mid-tool`).
//! A sweep therefore collects the session's processes three ways, always *before* signalling:
//! - the descendants of the session's root pid, walking ppid links (`/proc/*/stat` on Linux, `ps` on macOS);
//! - on Linux, every process whose environment carries the spawn's [`SESSION_MARKER`] value ([`marker`]). Children
//!   inherit it through forks, `setsid` and reparenting, so this also finds what escaped after its parent died;
//! - on Linux, the node is child subreaper ([`adopt_orphans`]), so orphans reparent to the node instead of escaping to
//!   init. The node then has to reap them, including the ones that exit on their own ([`reap_adopted`]).
//!
//! Nothing here touches a process that is not provably the session's: groups are signalled only when their leader is
//! in the sweep, the node's own group never, and on Linux every pid is re-checked against its start time first.
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::{Signal, kill, killpg};
use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
use nix::unistd::{Pid, getpgrp, getpid};

/// Set in every runner child's environment to its spawn's [`marker`].
pub const SESSION_MARKER: &str = "FLEETD_RUNNER_SESSION";

/// The marker value for one spawn: the session id plus a nonce, so no sweep of this spawn ever matches a process of
/// an earlier or later process of the same session (a respawn while the old tree is still being torn down).
pub fn marker(session: &str) -> String {
    static SPAWNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SPAWNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("{session}.{}.{nanos:x}.{n}", getpid())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    /// Linux: the session id (`setsid` makes a new one). 0 on macOS, where it is not read.
    pub sid: i32,
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
        sid: fields.get(3)?.parse().ok()?,
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
                sid: 0,
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

/// The live processes in `table` whose environment carries `marker`.
#[cfg(target_os = "linux")]
pub fn marked(table: &[Proc], marker: &str) -> Vec<Proc> {
    let own = getpid().as_raw();
    table
        .iter()
        .filter(|p| p.pid != own && !p.zombie)
        .filter(|p| marker_of(p.pid).as_deref() == Some(marker))
        .copied()
        .collect()
}

/// `pid`'s [`SESSION_MARKER`] value. None when it has none, belongs to another user, or is a zombie (no environ).
#[cfg(target_os = "linux")]
fn marker_of(pid: i32) -> Option<String> {
    let env = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    let prefix = format!("{SESSION_MARKER}=");
    env.split(|b| *b == 0)
        .find_map(|var| var.strip_prefix(prefix.as_bytes()))
        .map(|v| String::from_utf8_lossy(v).into_owned())
}

/// Where a process calling the node's socket runs, as the kernel's process tree and its environment say; never what
/// the caller claims.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeerSession {
    /// It descends from that session's claude (claude itself, its MCP servers, its shell commands).
    Session(String),
    /// It carries that session's marker but no longer descends from it: a detached child of the session.
    Detached(String),
    /// Neither: a person's own shell.
    Outside,
}

/// The session `pid` belongs to: the nearest of itself and its ancestors that is a session's claude in `roots`
/// (pid → session id); failing that, the session its [`SESSION_MARKER`] names (Linux), which only a process started
/// inside a session carries.
pub fn peer_session(table: &[Proc], pid: i32, roots: &HashMap<i32, String>) -> PeerSession {
    let parents: HashMap<i32, i32> = table.iter().map(|p| (p.pid, p.ppid)).collect();
    let mut at = pid;
    let mut seen = HashSet::new();
    while at > 1 && seen.insert(at) {
        if let Some(session) = roots.get(&at) {
            return PeerSession::Session(session.clone());
        }
        let Some(parent) = parents.get(&at) else {
            break;
        };
        at = *parent;
    }
    match marker_session(pid) {
        Some(session) => PeerSession::Detached(session),
        None => PeerSession::Outside,
    }
}

/// The session id in `pid`'s marker ([`marker`]: `<session>.<node pid>.<nanos>.<n>`).
#[cfg(target_os = "linux")]
fn marker_session(pid: i32) -> Option<String> {
    marker_of(pid).and_then(|m| m.split('.').next().map(str::to_owned))
}

#[cfg(not(target_os = "linux"))]
fn marker_session(_pid: i32) -> Option<String> {
    None
}

/// macOS cannot read another process's environment without parsing `ps -E`; the ppid walk has to do.
#[cfg(not(target_os = "linux"))]
pub fn marked(_table: &[Proc], _marker: &str) -> Vec<Proc> {
    Vec::new()
}

/// What a sweep of the spawn rooted at `root` and marked `marker` finds right now. Blocking: on macOS it runs `ps`.
pub fn sweep(root: i32, marker: &str) -> Vec<Proc> {
    let table = table();
    let mut found = descendants(&table, root);
    found.extend(marked(&table, marker).into_iter().filter(|p| p.pid != root));
    dedupe(&mut found);
    found
}

/// What a sweep by `marker` alone finds right now, for a spawn whose root is gone and whose pid may be reused.
/// Blocking. Nothing on macOS, where only the ppid walk from the root finds a session's processes.
#[cfg(target_os = "linux")]
pub fn sweep_marked(marker: &str) -> Vec<Proc> {
    marked(&table(), marker)
}

#[cfg(not(target_os = "linux"))]
pub fn sweep_marked(_marker: &str) -> Vec<Proc> {
    Vec::new()
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

/// The live claude processes the runner spawned. tokio reaps those itself (its `wait` fails if anyone else does), so
/// [`reap_adopted`] never touches them, whatever they look like.
static TRACKED: LazyLock<Mutex<HashSet<i32>>> = LazyLock::new(Default::default);
/// A process across pid reuse: (pid, start time).
#[cfg(target_os = "linux")]
type ProcKey = (i32, Option<u64>);
/// Live children of the node seen carrying a runner marker: orphans it adopted.
#[cfg(target_os = "linux")]
static ADOPTED: LazyLock<Mutex<HashSet<ProcKey>>> = LazyLock::new(Default::default);

/// Registers a spawned claude until its exit status has been collected ([`untrack`]).
pub fn track(pid: i32) {
    TRACKED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(pid);
}

pub fn untrack(pid: i32) {
    TRACKED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&pid);
}

/// Whether a zombie child the node never identified alive is an adopted orphan, safe to reap. The node starts its
/// own children (std/tokio defaults, `process_group(0)`) in its own session and either in its own process group or
/// as a group leader, and never with `setsid`. A child outside that shape (a non-leader in a foreign group, or in a
/// session of its own, e.g. a tool that detached) cannot be one tokio waits for.
pub fn adopted(proc: &Proc, own_group: i32, own_session: i32) -> bool {
    proc.pgid != own_group && (proc.pgid != proc.pid || proc.sid != own_session)
}

/// Makes the node child subreaper (Linux), so a session's orphans reparent to the node, where a sweep can still
/// find them by ppid, instead of escaping to init. Idempotent. From then on [`reap_adopted`] runs on every SIGCHLD and
/// every few seconds, so an adopted orphan that exits on its own never lingers as a zombie; swept ones are also reaped
/// by [`reap`].
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
            // The interval catches orphans alive (by their marker) before they die, for the few that look like the
            // node's own children once they are zombies.
            let mut every = tokio::time::interval(Duration::from_secs(5));
            loop {
                tokio::select! {
                    signal = sigchld.recv() => if signal.is_none() { return },
                    _ = every.tick() => {}
                }
                let _ = tokio::task::spawn_blocking(reap_adopted).await;
            }
        });
    });
}

#[cfg(not(target_os = "linux"))]
pub fn adopt_orphans() {}

/// One pass over the node's children: remember live ones that carry a runner marker other than the node's own (an
/// orphan from a session tree, not a child the node spawned), and reap zombies that are known orphans or
/// [`adopted`]. Never a tracked claude, alive or dead.
#[cfg(target_os = "linux")]
pub(crate) fn reap_adopted() {
    let own_pid = getpid().as_raw();
    let own_group = getpgrp().as_raw();
    let own_session = nix::unistd::getsid(None).map_or(0, Pid::as_raw);
    // A node that itself runs inside a session (a lab) passes that marker to every child it spawns.
    let own_marker = std::env::var(SESSION_MARKER).ok();
    let tracked = TRACKED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut known = ADOPTED.lock().unwrap_or_else(|e| e.into_inner());
    let children: Vec<Proc> = table().into_iter().filter(|p| p.ppid == own_pid).collect();
    for proc in &children {
        let key = (proc.pid, proc.start);
        if tracked.contains(&proc.pid) {
            known.remove(&key);
        } else if !proc.zombie {
            if marker_of(proc.pid).is_some_and(|m| own_marker.as_deref() != Some(m.as_str())) {
                known.insert(key);
            }
        } else if known.remove(&key) || adopted(proc, own_group, own_session) {
            let _ = waitpid(Pid::from_raw(proc.pid), Some(WaitPidFlag::WNOHANG));
        }
    }
    // Forget orphans that are gone some other way (a sweep reaped them).
    known.retain(|key| children.iter().any(|p| (p.pid, p.start) == *key));
}

/// The thread id of the fleetd session this process runs in: its own `FLEETD_THREAD_ID` or, on Linux, the nearest
/// ancestor's as it was started (`/proc/<pid>/environ`), so a command in a session's shell still says so after the
/// shell drops the variable. It catches honest mistakes, such as a lead writing to its own chat; it is no boundary,
/// since a process can leave its session's tree. The key decides what a caller may do.
pub fn session_thread_id() -> Option<String> {
    const VAR: &[u8] = b"FLEETD_THREAD_ID=";
    let of = |env: &[u8]| {
        env.split(|b| *b == 0)
            .find_map(|var| var.strip_prefix(VAR))
            .filter(|id| !id.is_empty())
            .map(|id| String::from_utf8_lossy(id).into_owned())
    };
    if let Some(id) = std::env::var("FLEETD_THREAD_ID")
        .ok()
        .filter(|id| !id.is_empty())
    {
        return Some(id);
    }
    let mut at = getpid().as_raw();
    let mut seen = HashSet::new();
    while cfg!(target_os = "linux") && at > 1 && seen.insert(at) {
        if let Some(id) = std::fs::read(format!("/proc/{at}/environ"))
            .ok()
            .and_then(|env| of(&env))
        {
            return Some(id);
        }
        at = std::fs::read_to_string(format!("/proc/{at}/stat"))
            .ok()
            .and_then(|stat| parse_stat(at, &stat))?
            .ppid;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: i32, ppid: i32, pgid: i32) -> Proc {
        Proc {
            pid,
            ppid,
            pgid,
            sid: 100,
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
                sid: 4100,
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
        let (own_group, own_session) = (100, 100);
        let adopted = |p: Proc| adopted(&p, own_group, own_session);
        // Inherited the node's group: a std/tokio child the node spawned itself.
        assert!(!adopted(proc(5, 100, 100)));
        // A group leader in the node's session: claude or a cmd check (`process_group(0)`); tokio reaps those.
        assert!(!adopted(proc(6, 100, 6)));
        // In some other process's group: a tool child orphaned to the node.
        assert!(adopted(proc(7, 100, 6)));
        // A leader of its own session: a tool that detached with setsid. The node never spawns with setsid.
        assert!(adopted(Proc {
            sid: 8,
            ..proc(8, 100, 8)
        }));
    }
}

#[cfg(test)]
mod peer_tests {
    use super::*;

    fn proc(pid: i32, ppid: i32) -> Proc {
        Proc {
            pid,
            ppid,
            pgid: pid,
            sid: pid,
            start: None,
            zombie: false,
        }
    }

    #[test]
    fn a_caller_belongs_to_the_session_whose_claude_it_descends_from() {
        // claude 100 (session lead), its MCP server 101 and a shell 102 → fleetd 103; claude 200 (session task) and
        // its shell 201 → fleetd 202; a person's shell 300 → fleetd 301.
        let table = [
            proc(100, 1),
            proc(101, 100),
            proc(102, 100),
            proc(103, 102),
            proc(200, 1),
            proc(201, 200),
            proc(202, 201),
            proc(300, 1),
            proc(301, 300),
        ];
        let roots = HashMap::from([(100, "lead".to_owned()), (200, "task".to_owned())]);
        assert_eq!(
            peer_session(&table, 101, &roots),
            PeerSession::Session("lead".into())
        );
        assert_eq!(
            peer_session(&table, 103, &roots),
            PeerSession::Session("lead".into())
        );
        assert_eq!(
            peer_session(&table, 202, &roots),
            PeerSession::Session("task".into())
        );
        // Whatever it claims: a task's process is the task's.
        assert_eq!(
            peer_session(&table, 200, &roots),
            PeerSession::Session("task".into())
        );
        assert_eq!(peer_session(&table, 301, &roots), PeerSession::Outside);
        // A cycle in a racy table ends the walk.
        let looped = [proc(400, 401), proc(401, 400)];
        assert_eq!(peer_session(&looped, 400, &roots), PeerSession::Outside);
    }
}
