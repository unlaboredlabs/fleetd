import type { Hub } from "../api/hub.ts";
import { startApprovals } from "../approvals/serve.ts";
import { leads } from "../leads/index.ts";
import { queuePorts } from "../leads/seams.ts";
import { registerLeadCalls } from "./calls.ts";
import { usage } from "./wire.ts";

/**
 * Starts this module's loops (Rust: usage::wire::start); each stops on `hub.shutdown`: usage's replay and follower,
 * and approvals' (its `approvals.serve`). The doctor's 15-minute run is the doctor area's. Usage also answers the
 * write queue's and the leads area's hooks: a thread's hold, waiting for it to clear, and a lead's park.
 */
export function start(hub: Hub): void {
  const u = usage(hub);
  void u.serve(hub.shutdown.signal);
  registerLeadCalls(hub);
  const ports = queuePorts(hub);
  ports.usageHold = (thread) => u.hold(thread);
  ports.whenClear = (thread) => u.whenClear(thread, hub.shutdown.signal);
  leads(hub).parkedOf = (thread) => u.parkedOf(thread);
  startApprovals(hub);
}
