import type { Hub } from "../api/hub.ts";
import { startApprovals } from "../approvals/serve.ts";
import { leadAccountKey } from "../claude_accounts/index.ts";
import { startDoctor } from "../doctor/loops.ts";
import { leads } from "../leads/index.ts";
import { leadWiring } from "../leads/ports.ts";
import { queuePorts } from "../leads/seams.ts";
import { statusInputs } from "../status/rows.ts";
import { registerLeadCalls } from "./calls.ts";
import { usage } from "./wire.ts";

/**
 * Starts this module's loops (Rust: usage::wire::start); each stops on `hub.shutdown`: usage's replay and follower,
 * and approvals' (its `approvals.serve`). The doctor's 15-minute run is the doctor area's. Usage also answers the
 * write queue's and the leads area's hooks: a thread's hold, waiting for it to clear, a lead's park, and the pause on
 * the login a project's lead runs on (hooks.rs `usage_gate`), for its digest and its start; and the status rows' pause.
 */
export function start(hub: Hub): void {
  const u = usage(hub);
  void u.serve(hub.shutdown.signal);
  registerLeadCalls(hub);
  const ports = queuePorts(hub);
  ports.usageHold = (thread) => u.hold(thread);
  ports.whenClear = (thread) => u.whenClear(thread, hub.shutdown.signal);
  leads(hub).parkedOf = (thread) => u.parkedOf(thread);
  leadWiring(hub).hooks.usageGate = (r) => u.gateFor(r.machineId, leadAccountKey(hub.db, r));
  statusInputs(hub).usageGate = (machineId, account) => u.gateFor(machineId, account);
  startApprovals(hub);
  startDoctor(hub);
}
