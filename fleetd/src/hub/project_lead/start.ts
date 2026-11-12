// The checker's, confirms', recall's, purchases' and erase's part of the project-lead area's start: approvals' project
// hooks, their lead calls, and the erase loop (crates/fleetd/src/hub/serve start_loops' erase::run).
import type { Hub } from "../api/hub.ts";
import { wireChecker } from "../executor/checker.ts";
import * as confirm from "./confirm.ts";
import * as erase from "./erase.ts";
import { projectHooks } from "./hooks.ts";
import * as purchases from "./purchases.ts";
import * as recall from "./recall.ts";

export function start(hub: Hub): void {
  wireChecker(hub);
  projectHooks(hub);
  confirm.start(hub);
  recall.start(hub);
  purchases.start(hub);
  void erase.run(hub);
}
