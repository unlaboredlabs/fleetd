//! What the node reports about its machine with each heartbeat: CPUs, the 1-minute load, memory in use, and the
//! claude.ai usage windows its sessions last saw. Absent when the figures cannot be read.
use fleetd_contracts::node_link::{LoginLimit, NodeLoad};
use fleetd_contracts::prim::{Int, List, NonNegative};

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

/// Reads the machine now. Blocking (a file read, or `sysctl` on macOS): run it off the async threads.
pub fn read(limits: Vec<LoginLimit>) -> Option<NodeLoad> {
    let cpus = std::thread::available_parallelism().ok()?.get() as i64;
    let load1 = NonNegative::new(load1()?).ok()?;
    Some(NodeLoad {
        cpus: Int::new(cpus.clamp(1, 4096)).ok()?,
        load1,
        mem_used_pct: mem_used_pct().and_then(|p| Int::new(p).ok()),
        limits: List::unchecked(limits.into_iter().take(4).collect()),
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
}
