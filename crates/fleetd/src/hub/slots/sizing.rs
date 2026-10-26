//! What one machine fits, from the facts its node reports with each heartbeat. Without I/O.
//!
//! - CPU: one agent per logical CPU less a reserve of one in eight (at least one). Most of an agent's time is spent
//!   waiting on the model, and the guard's load clause catches the builds that do line up.
//! - Memory: 2 GB per agent (the node's `memPerAgentGb`) after a quarter of it, 4 to 16 GB, is left to the OS and the
//!   human's own apps. Too many agents on memory fail rather than slow down, so this is usually the term that binds.
//! - At most [`HARD_TOP`] without a person's setting: past that the login's rate limit binds anyway.
//!
//! This is only the default cap, for a machine no person set a number for: a setting replaces it outright, and no
//! agent ever waits for memory it is estimated to take. What does hold new agents back is memory really in use, the
//! guard's pause (`hub::link::guard`).
//!
//! Disk is room, not a cap: the new agents its free space takes above the guard's floor, 5 GB each (`diskPerAgentGb`).
use fleetd_contracts::node_link::NodeLoad;

const GIB: i64 = 1 << 30;
/// The most agents a machine runs at once on its own measure; a person may set more.
pub const HARD_TOP: i64 = 64;
/// The memory term for a node too old to report its memory.
const UNKNOWN_MEM_TERM: i64 = 4;
/// A machine whose node has reported nothing yet: as many as an older node's memory term allows.
pub const UNMEASURED: i64 = UNKNOWN_MEM_TERM;
pub const UNMEASURED_WHY: &str = "not measured yet";
/// The node applies its own default; these stand in for an older node that sends none. node.json speaks in decimal GB.
const MEM_PER_AGENT: i64 = 2_000_000_000;
const DISK_PER_AGENT: i64 = 5_000_000_000;

/// A machine's own cap and the term that sets it, e.g. "memory 18 GB, about 2 GB an agent" or "14 of 16 CPUs".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Auto {
    pub cap: i64,
    pub why: String,
}

/// Total memory in GB as the machine is sold: RAM comes in binary GB, and the kernel reports a little less than is
/// installed, so a 32 GB machine counts as 32, not 31.3.
fn sold_gb(bytes: i64) -> i64 {
    (bytes + GIB - 1) / GIB
}

/// GB left for agents on a machine of `total` GB, after a quarter of it, 4 to 16 GB, for the OS and the human's apps.
fn usable_gb(total: i64) -> f64 {
    let reserve = (total as f64 / 4.0).clamp(4.0, 16.0);
    (total as f64 - reserve).max(0.0)
}

/// "2" or "2.5": GB as a person reads them.
fn gb(n: f64) -> String {
    let tenths = (n * 10.0).round() as i64;
    if tenths % 10 == 0 {
        (tenths / 10).to_string()
    } else {
        format!("{}.{}", tenths / 10, tenths % 10)
    }
}

pub fn auto_cap(load: &NodeLoad) -> Auto {
    let cpus = load.cpus.get();
    let cpu_term = (cpus - (cpus + 7) / 8).max(1);
    // Both read as the GB a person means: an 18 GB machine at 2 GB an agent fits (18 − 4.5) / 2 = 6.
    let per_agent_gb = load
        .mem_per_agent_bytes
        .map_or(MEM_PER_AGENT, |b| b.get())
        .max(1) as f64
        / 1e9;
    let (mem_term, mem_why) = match load.mem_total_bytes.map(|b| sold_gb(b.get())) {
        Some(total) => {
            let term = ((usable_gb(total) / per_agent_gb).floor() as i64).max(1);
            (
                term,
                format!("memory {total} GB, about {} GB an agent", gb(per_agent_gb)),
            )
        }
        None => (UNKNOWN_MEM_TERM, "memory unknown".to_owned()),
    };
    // Memory first on a tie: it is the term a person can act on, and the one that fails when overrun.
    let (cap, why) = if mem_term <= cpu_term {
        (mem_term, mem_why)
    } else {
        (cpu_term, format!("{cpu_term} of {cpus} CPUs"))
    };
    if cap > HARD_TOP {
        return Auto {
            cap: HARD_TOP,
            why: format!("top of {HARD_TOP}"),
        };
    }
    Auto { cap, why }
}

/// New agents the machine's free disk takes above the floor, before counting the ones started in the last 10
/// minutes, whose worktrees haven't grown yet. None while the node reports no disk.
pub fn disk_room(load: &NodeLoad) -> Option<i64> {
    let disk = load.disk.as_ref()?;
    let per_agent = load
        .disk_per_agent_bytes
        .map_or(DISK_PER_AGENT, |b| b.get())
        .max(1);
    Some((disk.free_bytes.get() - disk.min_free_bytes.get()).max(0) / per_agent)
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::node_link::NodeDisk;
    use fleetd_contracts::prim::{Count, Int, List, NonNegative};

    use super::*;

    const GB: i64 = 1_000_000_000;

    fn machine(cpus: i64, mem_gib: Option<i64>) -> NodeLoad {
        NodeLoad {
            cpus: Int::unchecked(cpus),
            load1: NonNegative::new(0.5).unwrap(),
            mem_used_pct: None,
            swap_used_pct: None,
            mem_pressure_pct: None,
            limits: List::unchecked(Vec::new()),
            hosts: None,
            disk: None,
            android: None,
            ios: None,
            mem_total_bytes: mem_gib.map(|g| Count::unchecked(g * GIB)),
            mem_per_agent_bytes: None,
            disk_per_agent_bytes: None,
        }
    }

    fn with_disk(mut load: NodeLoad, free_gb: i64, min_free_gb: i64) -> NodeLoad {
        load.disk = Some(NodeDisk {
            free_bytes: Count::unchecked(free_gb * GB),
            total_bytes: Count::unchecked(2000 * GB),
            min_free_bytes: Count::unchecked(min_free_gb * GB),
        });
        load
    }

    fn auto(cap: i64, why: &str) -> Auto {
        Auto {
            cap,
            why: why.to_owned(),
        }
    }

    /// The design's examples (5-throughput §1).
    #[test]
    fn the_example_machines() {
        // MacBook Air, 8 CPU, 8 GB: (8 − 4) / 2.
        assert_eq!(
            auto_cap(&machine(8, Some(8))),
            auto(2, "memory 8 GB, about 2 GB an agent")
        );
        // MacBook Pro, 12 CPU, 18 GB: (18 − 4.5) / 2.
        assert_eq!(
            auto_cap(&machine(12, Some(18))),
            auto(6, "memory 18 GB, about 2 GB an agent")
        );
        // Linux laptop, 16 threads, 32 GB: (32 − 8) / 2 under 14 CPUs.
        assert_eq!(
            auto_cap(&machine(16, Some(32))),
            auto(12, "memory 32 GB, about 2 GB an agent")
        );
        // Workstation, 32 threads, 128 GB: the CPUs bind.
        assert_eq!(auto_cap(&machine(32, Some(128))), auto(28, "28 of 32 CPUs"));
        // Big server, 64 threads, 256 GB.
        assert_eq!(auto_cap(&machine(64, Some(256))), auto(56, "56 of 64 CPUs"));
        // 128 threads, 512 GB: the hard top.
        assert_eq!(auto_cap(&machine(128, Some(512))), auto(64, "top of 64"));
        // Small VM, 2 vCPU, 4 GB: never below one.
        assert_eq!(
            auto_cap(&machine(2, Some(4))),
            auto(1, "memory 4 GB, about 2 GB an agent")
        );
    }

    #[test]
    fn the_kernels_short_count_of_memory_is_rounded_up() {
        let mut linux = machine(16, None);
        // What /proc/meminfo says on a 32 GB machine.
        linux.mem_total_bytes = Some(Count::unchecked(33_520_000_000));
        assert_eq!(
            auto_cap(&linux),
            auto(12, "memory 32 GB, about 2 GB an agent")
        );
    }

    #[test]
    fn an_older_node_without_memory_counts_four() {
        assert_eq!(auto_cap(&machine(16, None)), auto(4, "memory unknown"));
        assert_eq!(auto_cap(&machine(2, None)), auto(1, "1 of 2 CPUs"));
    }

    #[test]
    fn the_nodes_memory_per_agent_replaces_two_gb() {
        // What a node sends by default: the same 2 GB.
        let mut load = machine(12, Some(18));
        load.mem_per_agent_bytes = Some(Count::unchecked(2 * GB));
        assert_eq!(
            auto_cap(&load),
            auto(6, "memory 18 GB, about 2 GB an agent")
        );
        let mut load = machine(16, Some(32));
        load.mem_per_agent_bytes = Some(Count::unchecked(4 * GB));
        assert_eq!(
            auto_cap(&load),
            auto(6, "memory 32 GB, about 4 GB an agent")
        );
        load.mem_per_agent_bytes = Some(Count::unchecked(2_500_000_000));
        assert_eq!(
            auto_cap(&load),
            auto(9, "memory 32 GB, about 2.5 GB an agent")
        );
    }

    #[test]
    fn disk_room_counts_5_gb_agents_above_the_floor() {
        // MacBook Air: 60 GB free over a 25.6 GB floor.
        assert_eq!(disk_room(&with_disk(machine(8, Some(8)), 60, 26)), Some(6));
        // Small VM: 25 free over 20.
        assert_eq!(disk_room(&with_disk(machine(2, Some(4)), 25, 20)), Some(1));
        // Below the floor: none, never negative.
        assert_eq!(disk_room(&with_disk(machine(2, Some(4)), 10, 20)), Some(0));
        assert_eq!(disk_room(&machine(2, Some(4))), None);
        let mut big = with_disk(machine(64, Some(256)), 1500, 200);
        big.disk_per_agent_bytes = Some(Count::unchecked(2 * GB));
        assert_eq!(disk_room(&big), Some(650));
    }
}
