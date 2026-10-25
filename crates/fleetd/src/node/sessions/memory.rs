//! What each agent takes in memory: the peak resident memory of its session's whole process tree (claude, its tools,
//! their builds and test runners), sampled every [`SAMPLE_EVERY`]. Kept per project over its latest [`KEEP`] sessions
//! in `<node home>/memory.json`, and reported with each heartbeat, so the hub sizes the project's cap on this machine
//! by what its agents really take rather than a flat 2 GB.
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use fleetd_contracts::ids::ProjectId;
use fleetd_contracts::node_link::ProjectMemory;
use fleetd_contracts::prim::{Count, Int};
use serde::{Deserialize, Serialize};

use crate::node::runner::process::{self, Proc};

pub const SAMPLE_EVERY: Duration = Duration::from_secs(10);
/// Sessions kept per project.
const KEEP: usize = 20;

/// Each project's latest sessions and the most each one's process tree has held.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Peaks {
    /// Per project id: (session id, peak bytes), oldest session first.
    projects: BTreeMap<String, Vec<(String, u64)>>,
}

impl Peaks {
    /// The file's peaks; none when it is missing or unreadable.
    pub fn load(file: &Path) -> Self {
        std::fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> std::io::Result<()> {
        let tmp = file.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_string(self).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(tmp, file)
    }

    /// Raises the session's peak to `bytes`. A session new to the project pushes out its oldest past [`KEEP`]. True
    /// when anything changed.
    pub fn record(&mut self, project: &str, session: &str, bytes: u64) -> bool {
        let sessions = self.projects.entry(project.to_owned()).or_default();
        match sessions.iter_mut().find(|(s, _)| s == session) {
            Some((_, peak)) if *peak >= bytes => false,
            Some((_, peak)) => {
                *peak = bytes;
                true
            }
            None => {
                sessions.push((session.to_owned(), bytes));
                if sessions.len() > KEEP {
                    sessions.remove(0);
                }
                true
            }
        }
    }

    /// Each project's sample count and the 90th percentile of its sessions' peaks.
    pub fn report(&self) -> Vec<ProjectMemory> {
        self.projects
            .iter()
            .filter_map(|(project, sessions)| {
                let peaks: Vec<u64> = sessions.iter().map(|(_, b)| *b).collect();
                Some(ProjectMemory {
                    project_id: ProjectId::new(project).ok()?,
                    samples: Int::new(peaks.len() as i64).ok()?,
                    p90_bytes: Count::new(i64::try_from(p90(&peaks)?).ok()?).ok()?,
                })
            })
            .collect()
    }
}

/// The nearest-rank 90th percentile: the smallest value at least 90% of them are at or below.
pub fn p90(values: &[u64]) -> Option<u64> {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let rank = (sorted.len() * 9).div_ceil(10);
    sorted.get(rank.checked_sub(1)?).copied()
}

/// The cgroup v2 path in a `/proc/<pid>/cgroup` text.
fn cgroup_path(text: &str) -> Option<&str> {
    text.lines().find_map(|l| l.strip_prefix("0::"))
}

/// The pids of `root`'s tree: every process in its cgroup when it runs in one of its own (a systemd scope), which also
/// holds what escaped its parent; else `root` and its descendants by parent pid.
fn tree(root: i32, table: &[Proc]) -> Vec<i32> {
    let read = |pid: &str| std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok();
    let (own, theirs) = (read("self"), read(&root.to_string()));
    if let (Some(own), Some(theirs)) = (&own, &theirs)
        && let (Some(own), Some(theirs)) = (cgroup_path(own), cgroup_path(theirs))
        && own != theirs
        && let Ok(procs) = std::fs::read_to_string(format!("/sys/fs/cgroup{theirs}/cgroup.procs"))
    {
        return procs
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .collect();
    }
    std::iter::once(root)
        .chain(process::descendants(table, root).iter().map(|p| p.pid))
        .collect()
}

/// Resident bytes of these processes, from `/proc/<pid>/status`, which prints KB.
#[cfg(target_os = "linux")]
fn rss(pids: &[i32]) -> u64 {
    pids.iter()
        .filter_map(|pid| {
            let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
            let line = status.lines().find_map(|l| l.strip_prefix("VmRSS:"))?;
            line.split_whitespace().next()?.parse::<u64>().ok()
        })
        .map(|kb| kb.saturating_mul(1024))
        .sum()
}

/// Resident bytes of these processes, from `ps`, which prints KB.
#[cfg(not(target_os = "linux"))]
fn rss(pids: &[i32]) -> u64 {
    if pids.is_empty() {
        return 0;
    }
    let list: Vec<String> = pids.iter().map(i32::to_string).collect();
    let Ok(out) = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &list.join(",")])
        .env_clear()
        .output()
    else {
        return 0;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<u64>().ok())
        .map(|kb| kb.saturating_mul(1024))
        .sum()
}

/// Resident bytes of each root's whole tree now. Blocking: it reads the process table.
pub fn sample(roots: &[i32]) -> Vec<u64> {
    let table = process::table();
    roots.iter().map(|&root| rss(&tree(root, &table))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1_000_000_000;

    #[test]
    fn the_p90_is_the_nearest_rank() {
        assert_eq!(p90(&[]), None);
        assert_eq!(p90(&[3]), Some(3));
        assert_eq!(p90(&(1..=10).collect::<Vec<_>>()), Some(9));
        assert_eq!(p90(&(1..=20).rev().collect::<Vec<_>>()), Some(18));
        // One outlier in five is the p90.
        assert_eq!(p90(&[1, 1, 1, 1, 9]), Some(9));
    }

    #[test]
    fn each_session_keeps_its_highest_peak_and_a_project_its_latest_20() {
        let mut peaks = Peaks::default();
        assert!(peaks.record("rust", "s1", 3 * GB));
        assert!(
            !peaks.record("rust", "s1", GB),
            "a lower sample changes nothing"
        );
        assert!(peaks.record("rust", "s1", 4 * GB));
        for n in 2..=21 {
            peaks.record("rust", &format!("s{n}"), 2 * GB);
        }
        peaks.record("docs", "d1", GB / 2);
        let report = peaks.report();
        assert_eq!(report.len(), 2);
        let docs = &report[0];
        assert_eq!(
            (
                docs.project_id.as_str(),
                docs.samples.get(),
                docs.p90_bytes.get()
            ),
            ("docs", 1, 500_000_000)
        );
        // s1, the 4 GB one, has gone: 20 sessions of 2 GB remain.
        let rust = &report[1];
        assert_eq!(
            (rust.samples.get(), rust.p90_bytes.get()),
            (20, 2_000_000_000)
        );
    }

    #[test]
    fn peaks_survive_a_node_restart() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("memory.json");
        assert_eq!(Peaks::load(&file), Peaks::default());
        let mut peaks = Peaks::default();
        peaks.record("rust", "s1", 4 * GB);
        peaks.save(&file).unwrap();
        assert_eq!(Peaks::load(&file), peaks);
        std::fs::write(&file, "not json").unwrap();
        assert_eq!(Peaks::load(&file), Peaks::default());
    }

    #[test]
    fn a_tree_counts_its_root_and_the_processes_under_it() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .spawn()
            .unwrap();
        let root = child.id() as i32;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let pids = loop {
            let pids = tree(root, &process::table());
            if pids.len() >= 2 || std::time::Instant::now() > deadline {
                break pids;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let bytes = sample(&[root]);
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(root),
            nix::sys::signal::Signal::SIGKILL,
        );
        let _ = child.wait();
        assert!(pids.contains(&root) && pids.len() >= 2, "{pids:?}");
        assert!(bytes[0] > 0);
    }
}
