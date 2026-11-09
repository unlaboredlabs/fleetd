// What the node reports about its machine with each heartbeat (crates/fleetd/src/node/load.rs, busy.rs): CPUs, the
// 1-minute load, memory, free disk where its worktrees live, its IPv4 (./network.ts), and the claude.ai usage windows its sessions last saw.
// The screens' health (hosts, android, ios, desktop, mac) is the screens' modules' to add (`extra`).
import { availableParallelism, loadavg } from "node:os";
import { readFileSync, statfsSync } from "node:fs";
import type { LoginLimit, NodeDisk, NodeLoad } from "../../shared/contracts.ts";
import { readConfig } from "../config.ts";
import { memTotal } from "../build_slots.ts";
import { read as network } from "./network.ts";

export type Memory = { total: number; available: number };

export function parseMeminfo(text: string): Memory | undefined {
  const field = (name: string) => {
    const line = text.split("\n").find((l) => l.startsWith(name));
    const kb = line ? Number(line.slice(name.length).trim().split(/\s+/)[0]) : NaN;
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  };
  const total = field("MemTotal:");
  const available = field("MemAvailable:");
  return total === undefined || available === undefined ? undefined : { total, available };
}

export const usedPct = (m: Memory) =>
  m.total > 0 ? Math.min(100, Math.max(0, Math.round(((m.total - Math.min(m.available, m.total)) / m.total) * 100))) : undefined;

/** The default free-space floor: 10% of the volume or 20 GB, whichever is larger. */
export const minFreeBytes = (total: number, minFreeGb?: number) =>
  minFreeGb === undefined ? Math.max(Math.floor(total / 10), 20_000_000_000) : minFreeGb * 1_000_000_000;

/** The memory an agent is sized for here, as the hub sizes the machine's cap. */
const MEM_PER_AGENT = 2_000_000_000;

/** The agents this machine fits by its own measure, as the hub sizes its cap (load.rs `agents_fit`): one per CPU less a
 * reserve of one in eight, and the memory left after a quarter of it (4 to 16 GB) at `memPerAgent` bytes each, at most
 * 64. An unknown total counts as 4 on memory, as the hub counts it. */
export function agentsFit(cpus: number, memTotalBytes: number | undefined, memPerAgent: number): number {
  const cpuTerm = Math.max(1, cpus - Math.ceil(cpus / 8));
  let memTerm = 4;
  if (memTotalBytes !== undefined) {
    // As sold: a 32 GB machine whose kernel reports 31.3 counts as 32.
    const total = Math.ceil(memTotalBytes / 2 ** 30);
    const reserve = Math.min(16, Math.max(4, total / 4));
    memTerm = Math.max(1, Math.floor(Math.max(0, total - reserve) / (Math.max(1, memPerAgent) / 1e9)));
  }
  return Math.min(cpuTerm, memTerm, 64);
}

/** Parallel build jobs for each agent: its share of the CPUs when the machine runs all the agents it fits, at least 2. */
export const buildJobs = (cpus: number, agents: number) => Math.max(2, Math.floor(cpus / Math.max(1, agents)));

/** buildJobs for this machine now. */
export function buildJobsHere(): number {
  const cpus = Math.max(1, availableParallelism());
  return buildJobs(cpus, agentsFit(cpus, memTotal(), MEM_PER_AGENT));
}

function memory(): Memory | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return undefined;
  }
}

function disk(home: string, minFreeGb?: number): NodeDisk | undefined {
  try {
    const s = statfsSync(home);
    const total = s.blocks * s.bsize;
    return { freeBytes: s.bavail * s.bsize, totalBytes: total, minFreeBytes: minFreeBytes(total, minFreeGb) };
  } catch {
    return undefined;
  }
}

/** Reads the machine now; undefined when its figures can't be read. */
export function read(limits: LoginLimit[], home: string, extra?: (load: NodeLoad) => void): NodeLoad | undefined {
  const load1 = loadavg()[0];
  if (load1 === undefined || !Number.isFinite(load1)) return undefined;
  let config;
  try {
    config = readConfig(home);
  } catch {
    config = undefined;
  }
  const mem = memory();
  const load: NodeLoad = {
    cpus: Math.min(4096, Math.max(1, availableParallelism())),
    load1: Math.max(0, load1),
    limits: limits.slice(0, 4),
  };
  const pct = mem && usedPct(mem);
  if (pct !== undefined) load.memUsedPct = pct;
  if (mem) load.memTotalBytes = mem.total;
  const d = disk(home, config?.minFreeGb);
  if (d) load.disk = d;
  const net = network();
  if (net) load.network = net;
  extra?.(load);
  return load;
}
