import type { Hub } from "../api/hub.ts";
import { startApprovals } from "../approvals/serve.ts";

/**
 * Starts this module's loops (Rust: usage::wire::start); each stops on `hub.shutdown`. Only approvals' (its
 * `approvals.serve`) is ported so far: usage's own serve and the doctor's are not.
 */
export function start(hub: Hub): void {
  startApprovals(hub);
}
