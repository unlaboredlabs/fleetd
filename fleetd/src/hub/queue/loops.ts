import type { Hub } from "../api/hub.ts";
import { queuePorts } from "../leads/seams.ts";
import { sweep, WAKE_OVERDUE_MS } from "../sweep/index.ts";
import { wakes } from "../wakes/index.ts";
import { writeQueue } from "./index.ts";

/**
 * Starts this module's loops (Rust: queue::start_loops): the sweep's overdue-wakes check, then delivery of writes
 * queued before a restart and the expiry timer, until the hub stops. The areas that send turns reach the queue
 * through the leads' `queue_ports`, filled here.
 */
export function start(hub: Hub): void {
  // Sweep order: its own built-in checks, then overdue wakes.
  sweep(hub).register({ name: "wakes", run: () => void wakes(hub).sweepOverdue(WAKE_OVERDUE_MS) });
  const queue = writeQueue(hub);
  Object.assign(queuePorts(hub), {
    send: (thread: { machineId: string; threadId: string }, message: string, clientRequestId: string, wakeId?: string) =>
      queue.send(thread, message, clientRequestId, wakeId),
    isConnected: (machineId: string) => queue.isConnected(machineId),
  });
  queue.start();
  hub.shutdown.signal.addEventListener("abort", () => queue.stop(), { once: true });
}
