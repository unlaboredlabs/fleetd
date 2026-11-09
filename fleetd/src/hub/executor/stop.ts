// Stopping a session (crates/fleetd/src/hub/executor/mod.rs `Executors::stop`): the node ends its claude, waiting up
// to 25 s for it to exit, and removes its worktree too when asked.
import type { ThreadRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { executors, STOP_TIMEOUT_MS } from "./index.ts";

/** Stops the thread's session; `removeWorktree` also removes its worktree. */
export async function stop(hub: Hub, r: ThreadRef, removeWorktree = false): Promise<void> {
  await executors(hub).call(r.machineId, "stop", { op: "stop", sessionId: r.threadId, removeWorktree }, STOP_TIMEOUT_MS);
}
