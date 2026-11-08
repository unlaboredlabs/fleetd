// The checker's, confirms', recall's, purchases' and erase's part of the navi area's start: approvals' navi hooks, their
// lead calls, and the erase loop (crates/fleetd/src/hub/serve start_loops' navi::erase::run).
import type { Hub } from "../api/hub.ts";
import * as confirm from "./confirm.ts";
import * as erase from "./erase.ts";
import { naviHooks } from "./hooks.ts";
import * as purchases from "./purchases.ts";
import * as recall from "./recall.ts";

export function start(hub: Hub): void {
  naviHooks(hub);
  confirm.start(hub);
  recall.start(hub);
  purchases.start(hub);
  void erase.run(hub);
}
