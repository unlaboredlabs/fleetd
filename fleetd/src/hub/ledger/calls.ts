// The ledger's lead calls, `decide` and `decisions_search` (crates/fleetd/src/hub/ledger/tools.rs `lead_call`), for a
// caller the link attributed to its project by its cwd.
import type { Hub } from "../api/hub.ts";
import { leadCalls } from "../lead_calls/index.ts";
import { type DecideCall, type DecisionsSearchCall, decide, decisionsSearch } from "./tools.ts";

export function registerLeadCalls(hub: Hub): void {
  leadCalls(hub).register("decide", (caller, call) => decide(hub, caller.projectRef, caller.by, call as unknown as DecideCall) as never);
  leadCalls(hub).register(
    "decisions_search",
    (caller, call) => decisionsSearch(hub, caller.projectRef, call as unknown as DecisionsSearchCall) as never,
  );
}
