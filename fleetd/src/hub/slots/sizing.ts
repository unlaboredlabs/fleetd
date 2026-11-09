// What one machine fits, from the facts its node reports with each heartbeat.
// Without I/O.
//
// - CPU: one agent per logical CPU less a reserve of one in eight (at least one).
// - Memory: 2 GB per agent, 4 GB on one of the hub's cloud machines, after a quarter of it, 4 to 16 GB, is left to
//   the OS and the human's own apps.
// - At most HARD_TOP without a person's setting.
//
// Only the default cap, for a machine no person set a number for. Disk is room, not a cap: the new agents its free
// space takes above the guard's floor, 5 GB each. An older node may still send `memPerAgentBytes` and
// `diskPerAgentBytes`, which count in place of these.
import type { NodeLoad } from "../../shared/node_link.ts";

const GIB = 2 ** 30;
/** The most agents a machine runs at once on its own measure; a person may set more. */
export const HARD_TOP = 64;
/** The memory term for a node too old to report its memory. */
const UNKNOWN_MEM_TERM = 4;
/** A machine whose node has reported nothing yet: as many as an older node's memory term allows. */
export const UNMEASURED = UNKNOWN_MEM_TERM;
export const UNMEASURED_WHY = "not measured yet";
/** Decimal GB, as node.json spoke them. */
const MEM_PER_AGENT = 2_000_000_000;
const DISK_PER_AGENT = 5_000_000_000;
/** A cloud machine's GB an agent. */
export const CLOUD_MEM_PER_AGENT_GB = 4;

/** A machine's own cap and the term that sets it, e.g. "memory 18 GB, about 2 GB an agent" or "14 of 16 CPUs". */
export type Auto = { cap: number; why: string };

/** Total memory in GB as the machine is sold: the kernel reports a little less than is installed. */
const soldGb = (bytes: number) => Math.floor((bytes + GIB - 1) / GIB);

/** GB left for agents on a machine of `total` GB, after a quarter of it, 4 to 16 GB, for the OS and the human's apps. */
function usableGb(total: number): number {
  const reserve = Math.min(Math.max(total / 4, 4), 16);
  return Math.max(total - reserve, 0);
}

/** Rust's `f64::round`: half away from zero. */
const roundHalfAway = (n: number) => Math.sign(n) * Math.round(Math.abs(n));

/** "2" or "2.5": GB as a person reads them. */
function gb(n: number): string {
  const tenths = roundHalfAway(n * 10);
  return tenths % 10 === 0 ? String(tenths / 10) : `${Math.trunc(tenths / 10)}.${tenths % 10}`;
}

/** `cloud`: one of the hub's cloud machines, sized for builds. */
export function autoCap(load: NodeLoad, cloud: boolean): Auto {
  const cpus = load.cpus;
  const cpuTerm = Math.max(cpus - Math.trunc((cpus + 7) / 8), 1);
  const fallback = cloud ? CLOUD_MEM_PER_AGENT_GB * 1_000_000_000 : MEM_PER_AGENT;
  const perAgentGb = Math.max(load.memPerAgentBytes ?? fallback, 1) / 1e9;
  let memTerm: number;
  let memWhy: string;
  if (load.memTotalBytes !== undefined && load.memTotalBytes !== null) {
    const total = soldGb(load.memTotalBytes);
    memTerm = Math.max(Math.floor(usableGb(total) / perAgentGb), 1);
    memWhy = `memory ${total} GB, about ${gb(perAgentGb)} GB an agent`;
  } else {
    memTerm = UNKNOWN_MEM_TERM;
    memWhy = "memory unknown";
  }
  // Memory first on a tie: it is the term a person can act on, and the one that fails when overrun.
  const [cap, why] = memTerm <= cpuTerm ? [memTerm, memWhy] : [cpuTerm, `${cpuTerm} of ${cpus} CPUs`];
  if (cap > HARD_TOP) return { cap: HARD_TOP, why: `top of ${HARD_TOP}` };
  return { cap, why };
}

/** New agents the machine's free disk takes above the floor; undefined while the node reports no disk. */
export function diskRoom(load: NodeLoad): number | undefined {
  const disk = load.disk;
  if (!disk) return undefined;
  const perAgent = Math.max(load.diskPerAgentBytes ?? DISK_PER_AGENT, 1);
  return Math.floor(Math.max(disk.freeBytes - disk.minFreeBytes, 0) / perAgent);
}
