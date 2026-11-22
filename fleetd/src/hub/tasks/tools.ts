// MCP tools `tasks_list`, `task_get`, `task_stop` and `cap_set`; cap_set's change is the slot
// board's (`setCaps` in src/hub/slots/cap.ts). The task lead calls are calls.ts.
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import { cap } from "../api/refusals.ts";
import type { Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { leadWakes, requireHuman } from "../leads/seams.ts";
import { oneLine } from "../leads/text.ts";
import { capSet } from "../slots/cap.ts";
import { tasks } from "./index.ts";
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
    const listed = TaskRecords.list(hub.db.conn, filter).filter((t) => allows(caller, "read", t.projectRef.machineId));
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

  // A person stops one agent from its panel: the lead's stop_agent, for a person's key. Its lead hears it at its next
  // wake, never woken for it.
  tools.add("task_stop", async (hub, caller, input) => {
    requireHuman(caller, "task_stop");
    const stored = TaskRecords.get(hub.db.conn, input.taskId)?.task;
    if (!stored || !allows(caller, "read", stored.projectRef.machineId)) throw unknownTask(input.taskId);
    const r = stored.projectRef;
    requireRole(caller, "operate", r.machineId);
    if (stored.state === "cancelled") return { task: stored };
    const task = await tasks(hub).cancel({ projectRef: r, by: "the human" }, stored.taskId, "Stopped by the human.");
    leadWakes(hub).trigger(r, {
      kind: "line",
      line: "quiet",
      text: `- ${task.taskId} stopped by the human: ${oneLine(task.title, 80)}; its slot is free. Start it again only if they ask.`,
    });
    return { task, next: `${task.taskId} is stopped and its slot is free. Its lead hears it at its next wake.` };
  });

  tools.add("cap_set", (hub, caller, input) => capSet(hub, caller, input));
}
