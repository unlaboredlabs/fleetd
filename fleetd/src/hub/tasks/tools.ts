// MCP tools `tasks_list`, `task_get` and `cap_set` (crates/fleetd/src/hub/tasks/tools.rs); cap_set's change is the slot
// board's (`setCaps` in src/hub/slots/cap.ts). The task lead calls are calls.ts.
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import { cap } from "../api/refusals.ts";
import type { Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { others } from "../navi/owner.ts";
import { capSet } from "../slots/cap.ts";
import { TaskRecords } from "./records.ts";

export const unknownTask = (taskId: string) => new ToolError("not_found", `No task ${taskId}.`, "Call tasks_list to see tasks.");

export function register(tools: Registry): void {
  tools.add("tasks_list", (hub, caller, input) => {
    if (input.projectRef) requireRole(caller, "read", input.projectRef.machineId);
    const limit = input.limit ?? 50;
    // Without a project, read wide and keep what the key may see.
    const filter = {
      ...(input.projectRef ? { projectRef: input.projectRef } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      limit: input.projectRef ? limit + 1 : 1000,
    };
    // Another person's Only me project's tasks are theirs alone (D310).
    const navis = others(hub.db, caller);
    const listed = TaskRecords.list(hub.db.conn, filter).filter(
      (t) => allows(caller, "read", t.projectRef.machineId) && !navis.has(t.projectRef),
    );
    const shown = cap(listed, limit);
    return {
      tasks: shown.items,
      ...(shown.truncated ? { truncated: true } : {}),
      next: shown.truncated
        ? "Narrow the list with projectRef or state."
        : "Call task_get for one task's result, or thread_tail on its threadRef for its transcript.",
    };
  });

  tools.add("task_get", (hub, caller, input) => {
    const task = TaskRecords.get(hub.db.conn, input.taskId)?.task;
    if (!task || !allows(caller, "read", task.projectRef.machineId)) throw unknownTask(input.taskId);
    const next = task.threadRef
      ? `Read its transcript with thread_tail (machineId ${task.threadRef.machineId}, threadId ${task.threadRef.threadId}).`
      : `${task.taskId} has not started${task.queuedReason !== undefined ? `: ${task.queuedReason}` : ""}.`;
    return { task, next };
  });

  tools.add("cap_set", (hub, caller, input) => capSet(hub, caller, input));
}
