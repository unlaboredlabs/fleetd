// Starts machine roles' wiring and loops: `session_route` and `session_step`
// and the hosted callers (calls.rs), the agents' Mac's `mac_where` and `mac_send` (hub/mac_tool), and the loops
// `run_prune` and `screens::run`. Each loop stops on `hub.shutdown`.
import type { Hub } from "../api/hub.ts";
import { sleep } from "../browser/thumbs.ts";
import { registerLeadCalls as registerMac } from "../mac_tool/index.ts";
import { registerLeadCalls } from "./calls.ts";
import { machineRoles, prune } from "./places.ts";
import { run as runScreens } from "./screens.ts";

export function start(hub: Hub): void {
  machineRoles(hub);
  registerLeadCalls(hub);
  registerMac(hub);
  void runPrune(hub);
  void runScreens(hub);
}

/** The hourly prune of session places nobody needs, until the hub stops. */
export async function runPrune(hub: Hub): Promise<void> {
  const signal = hub.shutdown.signal;
  while (!signal.aborted) {
    try {
      hub.db.transaction((c) => prune(c, hub.clock.now()));
    } catch (e) {
      console.warn("session places not pruned:", e);
    }
    await sleep(3_600_000, signal);
  }
}
