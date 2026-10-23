//! What the node reports about its machine with each heartbeat: CPUs, the 1-minute load, memory in use, free disk
//! where its worktrees live, and the claude.ai usage windows its sessions last saw. Absent when the figures cannot be
//! read. The hub pauses new agents on a machine whose disk or load is past its limit.
use std::path::Path;

use fleetd_contracts::node_link::{LoginLimit, NodeDisk, NodeLoad};
use fleetd_contracts::prim::{Count, Int, List, NonNegative};

/// `/proc/loadavg`'s first field.
pub fn parse_loadavg(text: &str) -> Option<f64> {
    text.split_whitespace().next()?.parse().ok()
}

/// Percent of memory in use from `/proc/meminfo`: total minus available.
pub fn parse_meminfo(text: &str) -> Option<i64> {
    let field = |name: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(name))
            .and_then(|rest| rest.split_whitespace().next()?.parse::<f64>().ok())
    };
    let total = field("MemTotal:")?;
    let available = field("MemAvailable:")?;
    (total > 0.0).then(|| {
        (((total - available) / total) * 100.0)
            .round()
            .clamp(0.0, 100.0) as i64
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
        let out = std::process::Command::new("sysctl")
            .args(["-n", "vm.loadavg"])
            .output()
            .ok()?;
        parse_sysctl_loadavg(&String::from_utf8_lossy(&out.stdout))
    }
}

fn mem_used_pct() -> Option<i64> {
    if cfg!(target_os = "linux") {
        parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
    } else {
        None
    }
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
fn disk(home: &Path) -> Option<NodeDisk> {
    let s = nix::sys::statvfs::statvfs(home).ok()?;
    let block = s.fragment_size() as u64;
    let total = (s.blocks() as u64).saturating_mul(block);
    let free = (s.blocks_available() as u64).saturating_mul(block);
    let min_free_gb = super::config::read_config(home)
        .ok()
        .flatten()
        .and_then(|c| c.min_free_gb);
    let count = |n: u64| Count::new(i64::try_from(n).ok()?).ok();
    Some(NodeDisk {
        free_bytes: count(free)?,
        total_bytes: count(total)?,
        min_free_bytes: count(min_free_bytes(total, min_free_gb))?,
    })
}

/// Reads the machine now. Blocking (file reads, or `sysctl` on macOS): run it off the async threads.
pub fn read(limits: Vec<LoginLimit>, home: &Path) -> Option<NodeLoad> {
    let cpus = std::thread::available_parallelism().ok()?.get() as i64;
    let load1 = NonNegative::new(load1()?).ok()?;
    Some(NodeLoad {
        cpus: Int::new(cpus.clamp(1, 4096)).ok()?,
        load1,
        mem_used_pct: mem_used_pct().and_then(|p| Int::new(p).ok()),
        limits: List::unchecked(limits.into_iter().take(4).collect()),
        disk: disk(home),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_load_and_memory_as_the_kernel_prints_them() {
        assert_eq!(parse_loadavg("3.10 2.05 1.00 2/1234 5678\n"), Some(3.1));
        let meminfo =
            "MemTotal:       32000000 kB\nMemFree:  1000 kB\nMemAvailable:   18880000 kB\n";
        assert_eq!(parse_meminfo(meminfo), Some(41));
        assert_eq!(parse_meminfo("MemTotal: 0 kB\nMemAvailable: 0 kB\n"), None);
        assert_eq!(parse_sysctl_loadavg("{ 1.23 1.10 0.98 }\n"), Some(1.23));
    }

    #[test]
    fn the_disk_floor_is_a_tenth_or_20_gb_unless_node_json_sets_it() {
        assert_eq!(min_free_bytes(1_800_000_000_000, None), 180_000_000_000);
        assert_eq!(min_free_bytes(100_000_000_000, None), 20_000_000_000);
        assert_eq!(min_free_bytes(1_800_000_000_000, Some(5)), 5_000_000_000);
        assert_eq!(min_free_bytes(1_800_000_000_000, Some(0)), 0);
    }
}
