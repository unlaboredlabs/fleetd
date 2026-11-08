import type { Hub } from "../api/hub.ts";
import { registerLeadCalls as registerLedger } from "../ledger/calls.ts";
import { lookups, prRef, projectChanges, taskLane } from "../orders/index.ts";
import type { Change, ProjectRef, Task } from "../../shared/contracts.ts";

/**
 * Starts this module's loops (Rust: tasks.run, tasks::ci_wait::run, tasks::worktrees::run); each stops on
 * `hub.shutdown`. The loops aren't ported yet. It also registers the ledger's lead calls, and fills
 * `hub.area("status_groups")` with the orders' lanes for the status area: modules with no loops of their own.
 */
export function start(hub: Hub): void {
  registerLedger(hub);
  Object.assign(
    hub.area("status_groups", () => ({})),
    {
      /** orders' `task_lane`, with the hub's lookups. */
      taskLane: (task: Task, changes: Change[]) => taskLane(task, changes.map((c) => [c, prRef(c)]), lookups(hub)),
      /** orders' `project_changes`. */
      projectChanges: (r: ProjectRef) => projectChanges(hub, r),
      prRef,
    },
  );
}
