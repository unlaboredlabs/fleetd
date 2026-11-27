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
import { chat } from "../chat/index.ts";
import { taskStopped } from "../checklist/index.ts";
import { mention } from "../people/mention.ts";
import { nowMs } from "../store/time.ts";
import type { Task, TodoItem } from "../../shared/contracts.ts";
import { tasks } from "./index.ts";
import { TaskRecords } from "./records.ts";

/** How long a stopped agent ran: "40s", "1m 12s", "2h 5m". */
export function ranFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 === 0 ? "" : ` ${s % 60}s`}`;
  const m = Math.floor(s / 60) % 60;
  return `${Math.floor(s / 3600)}h${m === 0 ? "" : ` ${m}m`}`;
}

/** The chat's line for an agent a person stopped: who, which, after how long, and where its plan items went. */
export function stoppedLine(who: string | undefined, task: Pick<Task, "title" | "startedAt">, moved: number, now: number): string {
  const started = task.startedAt === undefined ? NaN : Date.parse(task.startedAt);
  const after = Number.isFinite(started) ? ` after ${ranFor(now - started)}` : "";
  const plan = moved === 0 ? "" : moved === 1 ? " Its item in the plan is back under To do." : " Its items in the plan are back under To do.";
  return `${who ?? "Someone"} stopped “${oneLine(task.title, 80)}”${after}.${plan}`;
}

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

  // A person stops one agent from its panel: the lead's stop_agent, for a person's key. At once the plan's items for it
  // go back to To do, the chat says so, and its lead is woken with it (at its next step when mid-turn).
  tools.add("task_stop", async (hub, caller, input) => {
    requireHuman(caller, "task_stop");
    const stored = TaskRecords.get(hub.db.conn, input.taskId)?.task;
    if (!stored || !allows(caller, "read", stored.projectRef.machineId)) throw unknownTask(input.taskId);
    const r = stored.projectRef;
    requireRole(caller, "operate", r.machineId);
    if (stored.state === "cancelled") return { task: stored };
    const task = await tasks(hub).cancel({ projectRef: r, by: "the human" }, stored.taskId, "Stopped by the human.");
    const now = nowMs(hub.clock);
    let moved: TodoItem[] = [];
    try {
      moved = taskStopped(hub, r, task.taskId, task.workstreamId, now);
    } catch (error) {
      console.warn("a stopped agent's checklist items were not moved back:", error);
    }
    try {
      chat(hub).systemLine(r, stoppedLine(caller.person ? mention(caller.person) : undefined, task, moved.length, now));
    } catch (error) {
      console.warn("a stopped agent's chat line was not posted:", error);
    }
    const back = moved.length === 0 ? "" : ` Its checklist ${moved.length === 1 ? "item" : "items"} ${moved.map((i) => i.id).join(", ")} went back to todo.`;
    leadWakes(hub).trigger(r, {
      kind: "line",
      line: "human",
      text: `- ${task.taskId} stopped by the human: ${oneLine(task.title, 80)}; its slot is free.${back} The chat already says so: don't repeat it. Start it again only if they ask.`,
    });
    return { task, next: `${task.taskId} is stopped and its slot is free. Its lead is told now.` };
  });

  tools.add("cap_set", (hub, caller, input) => capSet(hub, caller, input));
}
