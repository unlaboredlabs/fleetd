// The Navi area's loops and seams (crates/fleetd/src/hub/serve start_loops' navi::bridge::run, and the bridge's lead
// calls). `hub.area("navi_bridge")` is filled here whichever area asked for it first.
import type { Hub } from "../api/hub.ts";
import { leadCalls } from "../lead_calls/index.ts";
import { answer, bridgeOf, OPS, run } from "./bridge.ts";
import { start as startNavi } from "./start.ts";

/** Starts this module's loops (Rust: navi::bridge::run, navi::erase::run); each stops on `hub.shutdown`. */
export function start(hub: Hub): void {
  Object.assign(
    hub.area("navi_bridge", () => ({})),
    bridgeOf(hub),
  );
  for (const op of OPS) leadCalls(hub).register(op, (caller, call) => answer(hub, caller.projectRef, call) as never);
  void run(hub);
  startNavi(hub);
}
