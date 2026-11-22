// The machine's load per core, as a screen's frame rate follows it (./live.ts fpsFor): the 1-minute load average
// over the cores this process may run on, read at most once a second.
import { availableParallelism, loadavg } from "node:os";

let readAt = Number.NEGATIVE_INFINITY;
let value = 0;

export function machineLoad(): number {
  const now = performance.now();
  if (now - readAt >= 1_000) {
    readAt = now;
    value = (loadavg()[0] ?? 0) / Math.max(1, availableParallelism());
  }
  return value;
}
