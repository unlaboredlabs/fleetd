//! What each agent takes in memory: the peak, sampled every [`SAMPLE_EVERY`], of what its session's whole process
//! tree (claude, its tools, their builds and test runners) holds and the kernel can't just drop ([`sample`]). Kept per
//! project over its latest [`KEEP`] sessions in `<node home>/memory.json`, and reported with each heartbeat, so the
//! hub sizes the project's cap and memory budget on this machine by what its agents really take rather than a flat
//! 2 GB.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
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

/// One agent to measure: its claude's pid, and the start time the node recorded when it spawned it.
pub struct Root {
    pub pid: i32,
    /// `/proc/<pid>/stat` field 22 on Linux ([`super::proc::start_time`]); None: not recorded, so not checked.
    pub start: Option<String>,
}

/// Where the kernel's files are: `/proc` and `/sys/fs/cgroup`, or a test's fixture tree.
struct Fs {
    proc: PathBuf,
    cgroup: PathBuf,
}

impl Fs {
    fn read(&self, path: impl AsRef<Path>) -> Option<String> {
        std::fs::read_to_string(self.proc.join(path)).ok()
    }

    fn stat(&self, pid: i32) -> Option<Proc> {
        process::parse_stat(pid, &self.read(format!("{pid}/stat"))?)
    }

    /// Every process, from each `<pid>/stat`.
    fn table(&self) -> Vec<Proc> {
        let Ok(entries) = std::fs::read_dir(&self.proc) else {
            return Vec::new();
        };
        entries
            .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
            .filter_map(|pid| self.stat(pid))
            .collect()
    }

    /// The cgroup v2 path of a process (`self` for the node), from its `cgroup` file's `0::` line.
    fn cgroup_of(&self, pid: &str) -> Option<String> {
        let text = self.read(format!("{pid}/cgroup"))?;
        text.lines()
            .find_map(|l| l.strip_prefix("0::"))
            .map(str::to_owned)
    }
}

/// Memory a cgroup holds that the kernel can't just drop, from its `memory.stat`: anonymous memory, the kernel's own
/// for it, and shmem (tmpfs files, which live in RAM). File cache is left out: a build fills it with gigabytes of
/// output the kernel reclaims at will, so `memory.current` and `memory.peak` read far above what an agent needs.
pub fn parse_memory_stat(text: &str) -> Option<u64> {
    let field = |name: &str| {
        text.lines().find_map(|l| {
            let (key, value) = l.split_once(' ')?;
            (key == name).then(|| value.trim().parse::<u64>().ok())?
        })
    };
    // Kernels before 5.18 print no `kernel` total.
    let kernel = field("kernel").unwrap_or_else(|| {
        ["kernel_stack", "pagetables", "slab"]
            .iter()
            .filter_map(|k| field(k))
            .sum()
    });
    Some(field("anon")? + kernel + field("shmem").unwrap_or(0))
}

/// `Pss:` of a `/proc/<pid>/smaps_rollup`, in bytes: each shared page split among the processes that share it, so a
/// tree's sum counts it once.
pub fn parse_pss(text: &str) -> Option<u64> {
    let kb = text.lines().find_map(|l| l.strip_prefix("Pss:"))?;
    Some(
        kb.split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()?
            .saturating_mul(1024),
    )
}

/// Whether `path` is the agent's own transient scope, as the node starts one per session (`systemd-run --user
/// --scope`, named `run-….scope` under the user manager): never the node's own cgroup, a login session's scope or any
/// cgroup another agent is in.
fn own_scope(path: &str, node: Option<&str>, others: &[Option<String>]) -> bool {
    let name = path.rsplit('/').next().unwrap_or_default();
    path.contains("/user@")
        && name.starts_with("run-")
        && name.ends_with(".scope")
        && node != Some(path)
        && !others.iter().any(|o| o.as_deref() == Some(path))
}

/// Linux: each agent's memory now. In a scope of its own, the scope's `memory.stat` ([`parse_memory_stat`]), which
/// also holds what escaped its parent; else the sum of PSS ([`parse_pss`]) over claude and its descendants. 0 for an
/// agent whose pid now names another process.
fn sample_in(fs: &Fs, roots: &[Root]) -> Vec<u64> {
    let same = |root: &Root| {
        let now = fs.stat(root.pid).filter(|p| !p.zombie);
        match &root.start {
            Some(start) => now.and_then(|p| p.start).map(|s| s.to_string()).as_ref() == Some(start),
            None => now.is_some(),
        }
    };
    let node = fs.cgroup_of("self");
    let cgroups: Vec<Option<String>> = roots
        .iter()
        .map(|r| fs.cgroup_of(&r.pid.to_string()).filter(|_| same(r)))
        .collect();
    let table = fs.table();
    roots
        .iter()
        .enumerate()
        .map(|(i, root)| {
            if !same(root) {
                return 0;
            }
            let others: Vec<Option<String>> = cgroups
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, c)| c.clone())
                .collect();
            if let Some(path) = &cgroups[i]
                && own_scope(path, node.as_deref(), &others)
                && let Ok(text) = std::fs::read_to_string(
                    fs.cgroup
                        .join(path.trim_start_matches('/'))
                        .join("memory.stat"),
                )
                && let Some(bytes) = parse_memory_stat(&text)
            {
                // Still the same claude, so the scope read was its own.
                return if same(root) { bytes } else { 0 };
            }
            std::iter::once(root.pid)
                .chain(process::descendants(&table, root.pid).iter().map(|p| p.pid))
                .filter_map(|pid| parse_pss(&fs.read(format!("{pid}/smaps_rollup"))?))
                .sum()
        })
        .collect()
}

/// Each agent's memory now ([`sample_in`]). Blocking: it reads the process table.
#[cfg(target_os = "linux")]
pub fn sample(roots: &[Root]) -> Vec<u64> {
    let fs = Fs {
        proc: PathBuf::from("/proc"),
        cgroup: PathBuf::from("/sys/fs/cgroup"),
    };
    sample_in(&fs, roots)
}

/// macOS has neither cgroups nor PSS: the resident memory `ps` reports (in KB) of claude and its descendants, which
/// counts shared pages once per process.
#[cfg(not(target_os = "linux"))]
pub fn sample(roots: &[Root]) -> Vec<u64> {
    let table = process::table();
    roots
        .iter()
        .map(|root| {
            if root.start.is_some() && super::proc::start_time(root.pid as u32) != root.start {
                return 0;
            }
            let pids: Vec<String> = std::iter::once(root.pid)
                .chain(process::descendants(&table, root.pid).iter().map(|p| p.pid))
                .map(|p| p.to_string())
                .collect();
            let Ok(out) = std::process::Command::new("ps")
                .args(["-o", "rss=", "-p", &pids.join(",")])
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
        })
        .collect()
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

    /// A fake `/proc` and `/sys/fs/cgroup`: the node in its service's cgroup, and agents as `(pid, ppid, start,
    /// cgroup, Pss KB)`.
    fn fixture(agents: &[(i32, i32, u64, &str, u64)]) -> (tempfile::TempDir, Fs) {
        let dir = tempfile::tempdir().unwrap();
        let fs = Fs {
            proc: dir.path().join("proc"),
            cgroup: dir.path().join("cgroup"),
        };
        let write = |path: PathBuf, text: String| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(fs.proc.join("self/cgroup"), format!("0::{NODE}\n"));
        for (pid, ppid, start, cgroup, pss) in agents {
            write(
                fs.proc.join(format!("{pid}/stat")),
                format!(
                    "{pid} (claude) S {ppid} {pid} {pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 {start} 0 0\n"
                ),
            );
            write(
                fs.proc.join(format!("{pid}/cgroup")),
                format!("0::{cgroup}\n"),
            );
            write(
                fs.proc.join(format!("{pid}/smaps_rollup")),
                format!("Rss: {} kB\nPss: {pss} kB\nShared_Clean: 0 kB\n", pss * 3),
            );
        }
        (dir, fs)
    }

    const NODE: &str =
        "/user.slice/user-1000.slice/user@1000.service/app.slice/fleetd-node.service";
    const SCOPE: &str = "/user.slice/user-1000.slice/user@1000.service/app.slice/run-p100-i7.scope";
    /// What a build leaves in a scope: 3 GB its own, 27 GB of file cache.
    const STAT: &str =
        "anon 3000000000\nfile 27000000000\nkernel 200000000\nkernel_stack 1000\nshmem 100000000\n";

    fn root(pid: i32, start: u64) -> Root {
        Root {
            pid,
            start: Some(start.to_string()),
        }
    }

    #[test]
    fn memory_stat_counts_anon_kernel_and_shmem_but_not_the_file_cache() {
        assert_eq!(parse_memory_stat(STAT), Some(3_300_000_000));
        // A kernel before 5.18: its parts.
        let old = "anon 10\nfile 99\nkernel_stack 1\npagetables 2\nslab 3\n";
        assert_eq!(parse_memory_stat(old), Some(16));
        assert_eq!(parse_memory_stat("file 99\n"), None);
        assert_eq!(parse_pss("Rss: 900 kB\nPss: 300 kB\n"), Some(300 * 1024));
    }

    #[test]
    fn an_agent_in_its_own_scope_is_measured_from_the_scope_else_by_pss() {
        let (_dir, fs) = fixture(&[
            // In its own scope.
            (100, 1, 5000, SCOPE, 1),
            // In the node's own cgroup, with a child: PSS of both.
            (200, 1, 6000, NODE, 1000),
            (201, 200, 6001, NODE, 500),
            // In a login session's scope: shared with the person's shell, so not counted as the agent's.
            (
                300,
                1,
                7000,
                "/user.slice/user-1000.slice/session-3.scope",
                40,
            ),
        ]);
        let scope = fs.cgroup.join(SCOPE.trim_start_matches('/'));
        std::fs::create_dir_all(&scope).unwrap();
        std::fs::write(scope.join("memory.stat"), STAT).unwrap();
        let session = fs.cgroup.join("user.slice/user-1000.slice/session-3.scope");
        std::fs::create_dir_all(&session).unwrap();
        std::fs::write(session.join("memory.stat"), STAT).unwrap();
        assert_eq!(
            sample_in(&fs, &[root(100, 5000), root(200, 6000), root(300, 7000)]),
            [3_300_000_000, 1500 * 1024, 40 * 1024]
        );
    }

    #[test]
    fn a_shared_scope_or_a_reused_pid_is_never_counted_as_the_agents() {
        let (_dir, fs) = fixture(&[
            // Two agents in one scope: neither takes the scope's memory as its own.
            (100, 1, 5000, SCOPE, 7),
            (101, 1, 5001, SCOPE, 9),
            // A pid the kernel gave another process since the node spawned its claude.
            (400, 1, 9999, NODE, 800),
        ]);
        let scope = fs.cgroup.join(SCOPE.trim_start_matches('/'));
        std::fs::create_dir_all(&scope).unwrap();
        std::fs::write(scope.join("memory.stat"), STAT).unwrap();
        assert_eq!(
            sample_in(&fs, &[root(100, 5000), root(101, 5001), root(400, 1234)]),
            [7 * 1024, 9 * 1024, 0]
        );
        // Without a recorded start, a live pid is measured.
        let unrecorded = Root {
            pid: 400,
            start: None,
        };
        assert_eq!(sample_in(&fs, &[unrecorded]), [800 * 1024]);
        // Gone: nothing.
        assert_eq!(sample_in(&fs, &[root(500, 1)]), [0]);
    }

    #[test]
    fn only_a_run_scope_under_the_user_manager_is_an_agents_own() {
        let others = [Some("/other".to_owned())];
        assert!(own_scope(SCOPE, Some(NODE), &others));
        assert!(!own_scope(NODE, Some(NODE), &[]));
        assert!(!own_scope(SCOPE, Some(SCOPE), &[]), "the node's own");
        assert!(!own_scope(SCOPE, Some(NODE), &[Some(SCOPE.to_owned())]));
        assert!(!own_scope(
            "/user.slice/user-1000.slice/session-3.scope",
            Some(NODE),
            &[]
        ));
        assert!(!own_scope("/system.slice/run-u5.scope", Some(NODE), &[]));
    }
}
