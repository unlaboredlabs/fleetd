//! The disk guard. A machine short of disk where its worktrees live (below the node's `minFreeBytes`) takes no new
//! agents until it is back clear of the floor by a margin. Agents already running keep going. Load and memory never
//! hold new agents back (D336): starts follow the agent caps, and builds wait for the node's build slots. The node
//! reports the figures with its heartbeat; the hub decides here.
use fleetd_contracts::node_link::NodeLoad;

/// A paused machine resumes only 10% clear of the floor, so a reading at the edge doesn't flap.
const MARGIN: f64 = 0.1;

/// Why new agents wait on the machine ("14 GB free"), or None. `paused`: they already do.
pub fn why(load: &NodeLoad, paused: bool) -> Option<String> {
    let margin = if paused { MARGIN } else { 0.0 };
    let disk = load.disk.as_ref()?;
    let free = disk.free_bytes.get() as f64;
    (free < disk.min_free_bytes.get() as f64 * (1.0 + margin))
        .then(|| format!("{:.0} GB free", free / 1e9))
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
            mem_total_bytes: None,
            mem_per_agent_bytes: None,
            disk_per_agent_bytes: None,
            limits: List::unchecked(Vec::new()),
            hosts: None,
            disk: Some(NodeDisk {
                free_bytes: Count::unchecked(free_gb * 1_000_000_000),
                total_bytes: Count::unchecked(1_000_000_000_000),
                min_free_bytes: Count::unchecked(100_000_000_000),
            }),
            network: None,
            android: None,
            ios: None,
            desktop: None,
            mac: None,
        }
    }

    #[test]
    fn low_disk_pauses_and_only_a_margin_clear_resumes() {
        assert_eq!(why(&load(14, 3.0), false).as_deref(), Some("14 GB free"));
        assert_eq!(why(&load(105, 3.0), false), None);
        assert_eq!(
            why(&load(105, 3.0), true).as_deref(),
            Some("105 GB free"),
            "within the margin a paused machine stays paused"
        );
        assert_eq!(why(&load(111, 3.0), true), None);
        assert_eq!(
            paused_text("14 GB free", "mbp"),
            "Paused new agents: 14 GB free on mbp"
        );
    }

    #[test]
    fn high_load_and_full_memory_never_pause() {
        let mut busy = load(500, 70.2);
        busy.mem_used_pct = Some(Int::unchecked(97));
        assert_eq!(why(&busy, false), None);
        assert_eq!(why(&busy, true), None);
    }

    #[test]
    fn a_zero_floor_turns_the_disk_pause_off() {
        let mut off = load(0, 1.0);
        off.disk.as_mut().unwrap().min_free_bytes = Count::unchecked(0);
        assert_eq!(why(&off, true), None);
    }
}
