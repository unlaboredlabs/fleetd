//! What the node reports about its machine with each heartbeat: CPUs, the 1-minute load, memory in all and in use,
//! swap in use and memory pressure (Linux), free disk where its worktrees live, the memory and disk to allow per agent, and the claude.ai usage windows its
//! sessions last saw. Absent when the figures cannot be read. The hub pauses new agents on a machine whose disk,
//! load or memory is past its limit.
use std::path::Path;
use std::sync::OnceLock;

use fleetd_contracts::node_link::{LoginLimit, NodeDisk, NodeLoad};
use fleetd_contracts::prim::{Count, Int, List, NonNegative};

use super::config::NodeConfig;

/// Memory to allow per agent when node.json sets none.
pub const MEM_PER_AGENT_GB: u64 = 2;
/// Disk to allow per new agent's worktree when node.json sets none: roughly a Rust worktree with sccache.
pub const DISK_PER_AGENT_GB: u64 = 5;

/// Physical memory and how much of it is available, with swap, in bytes. macOS reports no swap here.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Memory {
    pub total: u64,
    pub available: u64,
    pub swap_total: u64,
    pub swap_free: u64,
}

impl Memory {
    /// Percent in use: total minus available.
    pub fn used_pct(&self) -> Option<i64> {
        (self.total > 0).then(|| {
            ((self.total.saturating_sub(self.available) as f64 / self.total as f64) * 100.0)
                .round()
                .clamp(0.0, 100.0) as i64
        })
    }

    /// Percent of swap in use; None without swap.
    pub fn swap_used_pct(&self) -> Option<i64> {
        (self.swap_total > 0).then(|| {
            ((self.swap_total.saturating_sub(self.swap_free) as f64 / self.swap_total as f64)
                * 100.0)
                .round()
                .clamp(0.0, 100.0) as i64
        })
    }
}

/// `/proc/loadavg`'s first field.
pub fn parse_loadavg(text: &str) -> Option<f64> {
    text.split_whitespace().next()?.parse().ok()
}

/// `/proc/meminfo`'s `MemTotal`, `MemAvailable`, `SwapTotal` and `SwapFree`, which it prints in kB.
pub fn parse_meminfo(text: &str) -> Option<Memory> {
    let field = |name: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(name))
            .and_then(|rest| rest.split_whitespace().next()?.parse::<u64>().ok())
            .map(|kb| kb.saturating_mul(1024))
    };
    Some(Memory {
        total: field("MemTotal:")?,
        available: field("MemAvailable:")?,
        swap_total: field("SwapTotal:").unwrap_or(0),
        swap_free: field("SwapFree:").unwrap_or(0),
    })
}

/// `/proc/pressure/memory`'s `some avg10`: the share of the last 10 s some task stalled on memory, percent.
pub fn parse_psi(text: &str) -> Option<f64> {
    text.lines()
        .find_map(|l| l.strip_prefix("some "))?
        .split_whitespace()
        .find_map(|f| f.strip_prefix("avg10="))?
        .parse()
        .ok()
}

fn mem_pressure() -> Option<f64> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    parse_psi(&std::fs::read_to_string("/proc/pressure/memory").ok()?)
}

/// macOS's `vm_stat` with `sysctl -n hw.memsize`'s total. Available is free plus inactive pages, as psutil and
/// Zabbix count it.
pub fn parse_vm_stat(text: &str, total: u64) -> Option<Memory> {
    let page = text
        .lines()
        .next()?
        .split_once("page size of ")?
        .1
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    let pages = |name: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(name))
            .and_then(|rest| rest.trim().trim_end_matches('.').parse::<u64>().ok())
    };
    let available = pages("Pages free:")?
        .saturating_add(pages("Pages inactive:")?)
        .saturating_mul(page);
    Some(Memory {
        total,
        available: available.min(total),
        ..Memory::default()
    })
}

/// `sysctl -n vm.loadavg`: "{ 1.23 1.10 0.98 }".
pub fn parse_sysctl_loadavg(text: &str) -> Option<f64> {
    text.trim()
        .trim_start_matches('{')
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

fn load1() -> Option<f64> {
    if cfg!(target_os = "linux") {
        parse_loadavg(&std::fs::read_to_string("/proc/loadavg").ok()?)
    } else {
        parse_sysctl_loadavg(&output("sysctl", &["-n", "vm.loadavg"])?)
    }
}

fn output(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn memory() -> Option<Memory> {
    if cfg!(target_os = "linux") {
        parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
    } else {
        parse_vm_stat(&output("vm_stat", &[])?, macos_total()?)
    }
}

/// `sysctl -n hw.memsize`: fixed while the machine is up, so asked once.
fn macos_total() -> Option<u64> {
    static TOTAL: OnceLock<Option<u64>> = OnceLock::new();
    *TOTAL.get_or_init(|| output("sysctl", &["-n", "hw.memsize"])?.trim().parse().ok())
}

/// Physical memory in bytes.
fn mem_total() -> Option<u64> {
    if cfg!(target_os = "linux") {
        memory().map(|m| m.total)
    } else {
        macos_total()
    }
}

/// node.json's per-agent figure in bytes, else the default. 0 counts as unset: the hub divides by it.
pub fn per_agent_bytes(gb: Option<u64>, default_gb: u64) -> u64 {
    gb.filter(|&gb| gb > 0)
        .unwrap_or(default_gb)
        .saturating_mul(1_000_000_000)
}

/// The agents this machine fits by its own measure, as the hub sizes its cap (5-throughput §1): one per CPU less a
/// reserve of one in eight, and the memory left after a quarter of it (4 to 16 GB) at `mem_per_agent` bytes each, at
/// most 64. An unknown total counts as 4 on memory, as the hub counts it.
pub fn agents_fit(cpus: u64, mem_total: Option<u64>, mem_per_agent: u64) -> u64 {
    const GIB: u64 = 1 << 30;
    let cpu_term = cpus.saturating_sub(cpus.div_ceil(8)).max(1);
    let mem_term = mem_total.map_or(4, |total| {
        // As sold: a 32 GB machine whose kernel reports 31.3 counts as 32.
        let total = total.div_ceil(GIB) as f64;
        let reserve = (total / 4.0).clamp(4.0, 16.0);
        (((total - reserve).max(0.0) / (mem_per_agent.max(1) as f64 / 1e9)).floor() as u64).max(1)
    });
    cpu_term.min(mem_term).min(64)
}

/// Parallel build jobs for each agent: its share of the CPUs when the machine runs all the agents it fits, at least 2.
pub fn build_jobs(cpus: u64, agents: u64) -> u64 {
    (cpus / agents.max(1)).max(2)
}

/// [`build_jobs`] for this machine now, with node.json's `memPerAgentGb`. Blocking on macOS (`sysctl` once).
pub fn build_jobs_here(home: &Path) -> u64 {
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get() as u64);
    let config = super::config::read_config(home).ok().flatten();
    let per_agent = per_agent_bytes(config.and_then(|c| c.mem_per_agent_gb), MEM_PER_AGENT_GB);
    build_jobs(cpus, agents_fit(cpus, mem_total(), per_agent))
}

fn count(n: u64) -> Option<Count> {
    Count::new(i64::try_from(n).ok()?).ok()
}

/// The default free-space floor: 10% of the volume or 20 GB, whichever is larger.
pub fn min_free_bytes(total: u64, min_free_gb: Option<u64>) -> u64 {
    min_free_gb.map_or((total / 10).max(20_000_000_000), |gb| {
        gb.saturating_mul(1_000_000_000)
    })
}

/// The volume holding `home` (the node home: worktrees and transcripts), with node.json's `minFreeGb`.
// The statvfs field types differ by platform.
#[allow(clippy::unnecessary_cast)]
fn disk(home: &Path, min_free_gb: Option<u64>) -> Option<NodeDisk> {
    let s = nix::sys::statvfs::statvfs(home).ok()?;
    let block = s.fragment_size() as u64;
    let total = (s.blocks() as u64).saturating_mul(block);
    let free = (s.blocks_available() as u64).saturating_mul(block);
    Some(NodeDisk {
        free_bytes: count(free)?,
        total_bytes: count(total)?,
        min_free_bytes: count(min_free_bytes(total, min_free_gb))?,
    })
}

/// Reads the machine now. Blocking (file reads, or `sysctl` and `vm_stat` on macOS): run it off the async threads.
pub fn read(limits: Vec<LoginLimit>, home: &Path) -> Option<NodeLoad> {
    let cpus = std::thread::available_parallelism().ok()?.get() as i64;
    let load1 = NonNegative::new(load1()?).ok()?;
    let config = super::config::read_config(home).ok().flatten();
    let setting = |f: fn(&NodeConfig) -> Option<u64>| config.as_ref().and_then(f);
    let memory = memory();
    Some(NodeLoad {
        cpus: Int::new(cpus.clamp(1, 4096)).ok()?,
        load1,
        mem_used_pct: memory
            .as_ref()
            .and_then(Memory::used_pct)
            .and_then(|p| Int::new(p).ok()),
        mem_total_bytes: memory.as_ref().and_then(|m| count(m.total)),
        swap_used_pct: memory
            .as_ref()
            .and_then(Memory::swap_used_pct)
            .and_then(|p| Int::new(p).ok()),
        mem_pressure_pct: mem_pressure().and_then(|p| NonNegative::new(p).ok()),
        mem_per_agent_bytes: count(per_agent_bytes(
            setting(|c| c.mem_per_agent_gb),
            MEM_PER_AGENT_GB,
        )),
        disk_per_agent_bytes: count(per_agent_bytes(
            setting(|c| c.disk_per_agent_gb),
            DISK_PER_AGENT_GB,
        )),
        limits: List::unchecked(limits.into_iter().take(4).collect()),
        disk: disk(home, setting(|c| c.min_free_gb)),
        android: super::device::health(
            home,
            &config
                .as_ref()
                .and_then(|c| c.device.clone())
                .unwrap_or_default(),
        ),
        // The session service's, added by the heartbeat.
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_load_and_memory_as_the_kernel_prints_them() {
        assert_eq!(parse_loadavg("3.10 2.05 1.00 2/1234 5678\n"), Some(3.1));
        assert_eq!(parse_sysctl_loadavg("{ 1.23 1.10 0.98 }\n"), Some(1.23));
    }

    #[test]
    fn reads_linux_memory_from_proc_meminfo() {
        let meminfo =
            "MemTotal:       32000000 kB\nMemFree:  1000 kB\nMemAvailable:   18880000 kB\n";
        let memory = parse_meminfo(meminfo).unwrap();
        assert_eq!(
            memory,
            Memory {
                total: 32_768_000_000,
                available: 19_333_120_000,
                ..Memory::default()
            }
        );
        assert_eq!(memory.used_pct(), Some(41));
        assert_eq!(memory.swap_used_pct(), None, "no swap lines: no swap");
        let swapped = parse_meminfo(&format!(
            "{meminfo}SwapTotal:       8388604 kB\nSwapFree:             96 kB\n"
        ))
        .unwrap();
        assert_eq!(swapped.swap_used_pct(), Some(100));
        let off = parse_meminfo(&format!("{meminfo}SwapTotal: 0 kB\nSwapFree: 0 kB\n")).unwrap();
        assert_eq!(off.swap_used_pct(), None);
        let empty = parse_meminfo("MemTotal: 0 kB\nMemAvailable: 0 kB\n").unwrap();
        assert_eq!(empty.used_pct(), None);
        // Kernels before 3.14 print no MemAvailable.
        assert_eq!(parse_meminfo("MemTotal: 1000 kB\nMemFree: 10 kB\n"), None);
    }

    #[test]
    fn reads_memory_pressure_from_proc_pressure() {
        let psi = "some avg10=23.45 avg60=8.10 avg300=0.88 total=183565427\nfull avg10=11.00 avg60=4.00 avg300=0.86 total=173442963\n";
        assert_eq!(parse_psi(psi), Some(23.45));
        assert_eq!(
            parse_psi("full avg10=1.00 avg60=0.00 avg300=0.00 total=1\n"),
            None
        );
        assert_eq!(parse_psi(""), None);
    }

    #[test]
    fn reads_macos_memory_from_vm_stat() {
        let vm_stat = "Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               13604.
Pages active:                            344018.
Pages inactive:                          339738.
Pages speculative:                         4560.
Pages throttled:                              0.
Pages wired down:                        150046.
Pages purgeable:                          16180.
\"Translation faults\":                 812938417.
Pages occupied by compressor:            273395.
";
        let total = 17_179_869_184; // 16 GB, as `sysctl -n hw.memsize` prints it
        let memory = parse_vm_stat(vm_stat, total).unwrap();
        assert_eq!(memory.total, total);
        assert_eq!(memory.available, (13_604 + 339_738) * 16_384);
        assert_eq!(memory.used_pct(), Some(66));
        // Intel Macs use 4 KB pages.
        let intel = "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 100.\nPages inactive: 900.\n";
        assert_eq!(
            parse_vm_stat(intel, 8_192_000).unwrap().used_pct(),
            Some(50)
        );
        assert_eq!(
            parse_vm_stat("Pages free: 100.\nPages inactive: 900.\n", 8_192_000),
            None
        );
    }

    #[test]
    fn per_agent_sizes_default_to_2_gb_of_memory_and_5_gb_of_disk() {
        assert_eq!(per_agent_bytes(None, MEM_PER_AGENT_GB), 2_000_000_000);
        assert_eq!(per_agent_bytes(None, DISK_PER_AGENT_GB), 5_000_000_000);
        assert_eq!(per_agent_bytes(Some(3), MEM_PER_AGENT_GB), 3_000_000_000);
        assert_eq!(per_agent_bytes(Some(0), DISK_PER_AGENT_GB), 5_000_000_000);
    }

    /// The design's example machines, and the one of 08:39: 20 agents at once on 32 cores and 59 GB.
    #[test]
    fn each_agent_builds_with_its_share_of_the_cpus_and_never_fewer_than_2_jobs() {
        const GB: u64 = 1 << 30;
        let jobs = |cpus, gb: Option<u64>| {
            build_jobs(cpus, agents_fit(cpus, gb.map(|g| g * GB), 2_000_000_000))
        };
        // 32 threads, 59 GB: (59 − 14.75) / 2 = 22 agents under 28 CPUs; 32 / 22 rounds down to 1, so 2.
        assert_eq!(agents_fit(32, Some(59 * GB), 2_000_000_000), 22);
        assert_eq!(jobs(32, Some(59)), 2);
        // MacBook Air, 8 CPUs, 8 GB: 2 agents, 4 jobs each.
        assert_eq!(agents_fit(8, Some(8 * GB), 2_000_000_000), 2);
        assert_eq!(jobs(8, Some(8)), 4);
        // Workstation, 32 threads, 128 GB: 28 on CPU.
        assert_eq!(agents_fit(32, Some(128 * GB), 2_000_000_000), 28);
        // 128 threads, 512 GB: the top of 64, 2 jobs each.
        assert_eq!(agents_fit(128, Some(512 * GB), 2_000_000_000), 64);
        assert_eq!(jobs(128, Some(512)), 2);
        // 64 threads on a 16 GB box: 6 agents, 10 jobs each.
        assert_eq!(jobs(64, Some(16)), 10);
        // Small VM, 2 vCPUs, 4 GB: 1 agent, still 2 jobs.
        assert_eq!(jobs(2, Some(4)), 2);
        // Memory unknown counts 4 agents.
        assert_eq!(jobs(16, None), 4);
        // 4 GB per agent halves the agents and doubles the jobs.
        assert_eq!(
            build_jobs(16, agents_fit(16, Some(32 * GB), 4_000_000_000)),
            2
        );
        assert_eq!(
            build_jobs(16, agents_fit(16, Some(16 * GB), 4_000_000_000)),
            5
        );
    }

    #[test]
    fn the_disk_floor_is_a_tenth_or_20_gb_unless_node_json_sets_it() {
        assert_eq!(min_free_bytes(1_800_000_000_000, None), 180_000_000_000);
        assert_eq!(min_free_bytes(100_000_000_000, None), 20_000_000_000);
        assert_eq!(min_free_bytes(1_800_000_000_000, Some(5)), 5_000_000_000);
        assert_eq!(min_free_bytes(1_800_000_000_000, Some(0)), 0);
    }
}
