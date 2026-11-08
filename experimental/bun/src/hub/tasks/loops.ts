import type { Hub } from "../api/hub.ts";
import { registerLeadCalls as registerLedger } from "../ledger/calls.ts";

/**
 * Starts this module's loops (Rust: tasks.run, tasks::ci_wait::run, tasks::worktrees::run); each stops on
 * `hub.shutdown`. The loops aren't ported yet. It also registers the ledger's lead calls, whose module has no loops of
 * its own to start them from.
 */
export function start(hub: Hub): void {
  registerLedger(hub);
}
