// Approvals' background work (tools.rs `register_lead_calls`), which
// the Rust hub starts from usage::wire::start: src/hub/usage/loops.ts calls startApprovals.
import type { Hub } from "../api/hub.ts";
import { approvals } from "./index.ts";
import { registerLeadCalls } from "./lead_calls.ts";
import { followThreads } from "./permissions.ts";
import { expireUnfilled } from "./purchases.ts";

/**
 * Starts approvals (Rust: approvals.serve and register_lead_calls): first the approved commands a stopped hub never
 * finished are settled, then the threads' follower (tool prompts), the removed-projects follower and the fill windows'
 * expiry, each until the hub stops.
 */
export function startApprovals(hub: Hub): void {
  registerLeadCalls(hub);
  const a = approvals(hub);
  a.reopenUnfinished();
  const signal = hub.shutdown.signal;
  void followThreads(a).catch((e) => console.error("approvals: the thread follower stopped:", e));
  void a.followRemovals().catch((e) => console.error("approvals: the removals follower stopped:", e));
  const expire = setInterval(() => expireUnfilled(a), 60_000);
  expireUnfilled(a);
  signal.addEventListener("abort", () => clearInterval(expire), { once: true });
}
