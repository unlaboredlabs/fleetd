import type { Hub } from "../api/hub.ts";
import { startApprovals } from "../approvals/serve.ts";
import { startDoctor } from "../doctor/loops.ts";

/**
 * Starts this module's loops (Rust: usage::wire::start); each stops on `hub.shutdown`. Approvals' (its
 * `approvals.serve`) and the doctor's minute run are ported; usage's own serve is not.
 */
export function start(hub: Hub): void {
  startApprovals(hub);
  startDoctor(hub);
}
