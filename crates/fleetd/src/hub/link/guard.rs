//! The disk and load guard. A machine short of disk where its worktrees live (below the node's `minFreeBytes`), or
//! with a 1-minute load above twice its CPUs, takes no new agents until it is back clear of the limit by a margin.
//! Agents already running keep going. The node reports both figures with its heartbeat; the hub decides here.
use fleetd_contracts::node_link::NodeLoad;

/// New agents wait above this 1-minute load per CPU.
pub const LOAD_PER_CPU: f64 = 2.0;
/// A paused machine resumes only 10% clear of a limit, so a reading at the edge doesn't flap.
const MARGIN: f64 = 0.1;

/// Why new agents wait on the machine ("14 GB free", "load 70.2 on 32 CPUs"), or None. `paused`: they already do.
pub fn why(load: &NodeLoad, paused: bool) -> Option<String> {
    let margin = if paused { MARGIN } else { 0.0 };
    if let Some(disk) = &load.disk {
        let free = disk.free_bytes.get() as f64;
        if free < disk.min_free_bytes.get() as f64 * (1.0 + margin) {
            return Some(format!("{:.0} GB free", free / 1e9));
        }
    }
    let cpus = load.cpus.get();
    (load.load1.get() > LOAD_PER_CPU * cpus as f64 * (1.0 - margin))
        .then(|| format!("load {:.1} on {cpus} CPUs", load.load1.get()))
}

/// The line the project's status, the doctor and a waiting agent show.
pub fn paused_text(why: &str, machine: &str) -> String {
    format!("Paused new agents: {why} on {machine}")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use fleetd_contracts::node_link::NodeDisk;
    use fleetd_contracts::prim::{Count, Int, List, NonNegative};

    /// A 1 TB volume with a 100 GB floor, `free_gb` free, on 32 CPUs.
    pub(crate) fn load(free_gb: i64, load1: f64) -> NodeLoad {
        NodeLoad {
            cpus: Int::unchecked(32),
            load1: NonNegative::new(load1).unwrap(),
            mem_used_pct: None,
            limits: List::unchecked(Vec::new()),
            disk: Some(NodeDisk {
                free_bytes: Count::unchecked(free_gb * 1_000_000_000),
                total_bytes: Count::unchecked(1_000_000_000_000),
                min_free_bytes: Count::unchecked(100_000_000_000),
            }),
        }
    }

    #[test]
    fn low_disk_or_high_load_pauses_and_only_a_margin_clear_resumes() {
        assert_eq!(why(&load(14, 3.0), false).as_deref(), Some("14 GB free"));
        assert_eq!(why(&load(105, 3.0), false), None);
        assert_eq!(
            why(&load(105, 3.0), true).as_deref(),
            Some("105 GB free"),
            "within the margin a paused machine stays paused"
        );
        assert_eq!(why(&load(111, 3.0), true), None);

        assert_eq!(
            why(&load(500, 70.2), false).as_deref(),
            Some("load 70.2 on 32 CPUs")
        );
        assert_eq!(why(&load(500, 60.0), false), None);
        assert!(why(&load(500, 60.0), true).is_some());
        assert_eq!(why(&load(500, 57.0), true), None);
    }

    #[test]
    fn a_zero_floor_turns_the_disk_pause_off() {
        let mut off = load(0, 1.0);
        off.disk.as_mut().unwrap().min_free_bytes = Count::unchecked(0);
        assert_eq!(why(&off, true), None);
    }
}
