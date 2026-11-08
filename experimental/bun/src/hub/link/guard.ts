// The disk guard (crates/fleetd/src/hub/link/guard.rs). A machine short of disk where its worktrees live (below the
// node's `minFreeBytes`) takes no new agents until it is back clear of the floor by a margin. Agents already running
// keep going. Load and memory never hold new agents back (D336). The node reports the figures with its heartbeat.
import type { NodeLoad } from "../../shared/node_link.ts";

/** A paused machine resumes only 10% clear of the floor, so a reading at the edge doesn't flap. */
const MARGIN = 0.1;

/** Why new agents wait on the machine ("14 GB free"), or undefined. `paused`: they already do. */
export function why(load: NodeLoad, paused: boolean): string | undefined {
  const disk = load.disk;
  if (!disk) return undefined;
  const margin = paused ? MARGIN : 0;
  return disk.freeBytes < disk.minFreeBytes * (1 + margin) ? `${(disk.freeBytes / 1e9).toFixed(0)} GB free` : undefined;
}

/** The line the project's status, the doctor and a waiting agent show. */
export const pausedText = (why: string, machine: string) => `Paused new agents: ${why} on ${machine}`;
