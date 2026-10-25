//! The disk, load and memory guard. A machine short of disk where its worktrees live (below the node's
//! `minFreeBytes`), with a 1-minute load above twice its CPUs, with 90% of its memory in use, with swap full and 80%
//! of memory in use, or under memory pressure (Linux PSI), takes no new agents until it is back clear of the limit by
//! a margin. Agents already running keep going: this guard can't stop them growing, only keep new ones off a machine
//! already short. The node reports the figures with its heartbeat; the hub decides here.
use fleetd_contracts::node_link::NodeLoad;

/// New agents wait above this 1-minute load per CPU.
pub const LOAD_PER_CPU: f64 = 2.0;
/// New agents wait with this much of the machine's memory in use, percent.
pub const MEM_USED_PCT: f64 = 90.0;
/// With swap this full, memory this used pauses: the rest of RAM is all the headroom left. Full swap alone doesn't:
/// idle pages sit there for days.
const SWAP_FULL_PCT: f64 = 90.0;
const MEM_WITH_SWAP_FULL_PCT: f64 = 80.0;
/// New agents wait while tasks stalled on memory this share of the last 10 s (PSI `some avg10`): the kernel is
/// reclaiming or swapping hard, which comes before the OOM killer.
pub const MEM_PRESSURE_PCT: f64 = 10.0;
/// A machine paused under pressure resumes only below this: avg10 swings a lot from one 15 s heartbeat to the next,
/// more than the 10% margin covers.
const MEM_PRESSURE_RESUME_PCT: f64 = 5.0;
/// A paused machine resumes only 10% clear of a limit, so a reading at the edge doesn't flap.
const MARGIN: f64 = 0.1;

/// Why new agents wait on the machine ("14 GB free", "load 70.2 on 32 CPUs", "memory 93%", "memory 84% with swap
/// 100%", "memory pressure 23%"), or None. `paused`: they already do.
pub fn why(load: &NodeLoad, paused: bool) -> Option<String> {
    let margin = if paused { MARGIN } else { 0.0 };
    if let Some(disk) = &load.disk {
        let free = disk.free_bytes.get() as f64;
        if free < disk.min_free_bytes.get() as f64 * (1.0 + margin) {
            return Some(format!("{:.0} GB free", free / 1e9));
        }
    }
    let cpus = load.cpus.get();
    if load.load1.get() > LOAD_PER_CPU * cpus as f64 * (1.0 - margin) {
        return Some(format!("load {:.1} on {cpus} CPUs", load.load1.get()));
    }
    let under = |limit: f64| limit * (1.0 - margin);
    if let Some(mem) = load.mem_used_pct.map(|m| m.get()) {
        if mem as f64 >= under(MEM_USED_PCT) {
            return Some(format!("memory {mem}%"));
        }
        if let Some(swap) = load.swap_used_pct.map(|s| s.get())
            && swap as f64 >= under(SWAP_FULL_PCT)
            && mem as f64 >= under(MEM_WITH_SWAP_FULL_PCT)
        {
            return Some(format!("memory {mem}% with swap {swap}%"));
        }
    }
    let pressure = load.mem_pressure_pct?.get();
    let limit = if paused {
        MEM_PRESSURE_RESUME_PCT
    } else {
        MEM_PRESSURE_PCT
    };
    (pressure >= limit).then(|| format!("memory pressure {pressure:.0}%"))
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
            swap_used_pct: None,
            mem_pressure_pct: None,
            mem_per_agent_bytes: None,
            disk_per_agent_bytes: None,
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
    fn memory_in_use_pauses_at_90_percent_and_only_a_margin_clear_resumes() {
        let at = |pct: i64, paused: bool| {
            let mut l = load(500, 3.0);
            l.mem_used_pct = Some(Int::unchecked(pct));
            why(&l, paused)
        };
        assert_eq!(at(93, false).as_deref(), Some("memory 93%"));
        assert_eq!(at(90, false).as_deref(), Some("memory 90%"));
        assert_eq!(at(89, false), None);
        assert_eq!(
            at(85, true).as_deref(),
            Some("memory 85%"),
            "within the margin a paused machine stays paused"
        );
        assert_eq!(at(80, true), None);
        assert_eq!(
            why(&load(500, 3.0), true),
            None,
            "an unread figure never pauses"
        );
        assert_eq!(
            paused_text(&at(93, false).unwrap(), "mbp"),
            "Paused new agents: memory 93% on mbp"
        );
    }

    #[test]
    fn full_swap_pauses_only_with_memory_80_percent_used() {
        let at = |mem: i64, swap: i64, paused: bool| {
            let mut l = load(500, 3.0);
            l.mem_used_pct = Some(Int::unchecked(mem));
            l.swap_used_pct = Some(Int::unchecked(swap));
            why(&l, paused)
        };
        assert_eq!(
            at(84, 100, false).as_deref(),
            Some("memory 84% with swap 100%")
        );
        assert_eq!(
            at(55, 100, false),
            None,
            "idle pages in swap alone never pause"
        );
        assert_eq!(at(84, 80, false), None);
        assert!(
            at(75, 95, true).is_some(),
            "within the margin it stays paused"
        );
        assert_eq!(at(71, 95, true), None);
    }

    #[test]
    fn memory_pressure_pauses_at_10_percent_and_resumes_below_5() {
        let at = |psi: f64, paused: bool| {
            let mut l = load(500, 3.0);
            l.mem_used_pct = Some(Int::unchecked(60));
            l.mem_pressure_pct = Some(NonNegative::new(psi).unwrap());
            why(&l, paused)
        };
        assert_eq!(at(23.4, false).as_deref(), Some("memory pressure 23%"));
        assert_eq!(at(9.5, false), None);
        assert!(at(5.0, true).is_some());
        assert_eq!(at(4.9, true), None);

        // Heartbeat after heartbeat around the threshold: one pause, no flapping.
        let mut paused = false;
        let mut toggles = 0;
        for psi in [11.0, 9.0, 12.0, 7.5, 10.5, 6.0, 13.0, 8.0] {
            let now = at(psi, paused).is_some();
            toggles += usize::from(now != paused);
            paused = now;
        }
        assert_eq!((paused, toggles), (true, 1));
    }

    #[test]
    fn a_zero_floor_turns_the_disk_pause_off() {
        let mut off = load(0, 1.0);
        off.disk.as_mut().unwrap().min_free_bytes = Count::unchecked(0);
        assert_eq!(why(&off, true), None);
    }
}
