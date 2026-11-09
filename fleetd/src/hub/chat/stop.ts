// One order stopped for the person, the stop the chat's Stop and
// project_stop make for each open order: its PRs off the train, its agents cancelled, what waits on a person
// withdrawn, the order marked stopped and its lead told.
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { approvals } from "../approvals/index.ts";
import { renderEvent } from "../leads/events.ts";
import { leads } from "../leads/index.ts";
import { leadWiring } from "../leads/ports.ts";
import { orderTasks } from "../orders/index.ts";
import { events } from "../store/events.ts";
import { isoMs, nowMs } from "../store/time.ts";

/** The train's hook for an order's PRs not yet on their way in (train/service.rs `take_leftovers`). */
export type TakeLeftovers = (r: ProjectRef, workstreamId: string, why: string) => number[];

/** The train sets this when it starts; until then a stop takes no PR off it. */
export const stopHooks = (hub: Hub) => hub.area<{ takeLeftovers?: TakeLeftovers }>("chat_stop_hooks", () => ({}));

const unknownOrder = (id: string) => new ToolError("not_found", `No order ${id}.`, "Call orders_board to see open orders.");

/** Stops the order `workstreamId`: the agents cancelled and the PRs taken off the train. An order already stopped is 0. */
export async function stopOrder(
  hub: Hub,
  caller: Caller,
  workstreamId: string,
  reason: string | undefined,
): Promise<{ cancelled: number; offTrain: number[] }> {
  const records = leads(hub).records;
  const stored = /^W[0-9]+$/.test(workstreamId) ? records.workstreamGet(workstreamId) : undefined;
  if (!stored || !allows(caller, "read", stored.projectRef.machineId)) throw unknownOrder(workstreamId);
  const r = stored.projectRef;
  requireRole(caller, "operate", r.machineId);
  const id = stored.workstreamId;
  if (stored.state === "stopped") return { cancelled: 0, offTrain: [] };
  if (stored.state === "done") throw new ToolError("invalid", `${id} already ended (done); there is nothing to stop.`);
  const by = caller.keyId;
  const why = reason ?? "stopped by the human";
  // Its PRs not already on their way in leave the train, so none merges or waits for a reviewer the stop cancels.
  const offTrain = stopHooks(hub).takeLeftovers?.(r, id, `${id} was stopped: ${why}`) ?? [];
  let cancelled = 0;
  const tasks = leadWiring(hub).hooks.tasks;
  for (const task of orderTasks(hub, id)) {
    if (task.state !== "queued" && task.state !== "running" && task.state !== "idle") continue;
    try {
      if (!tasks) throw new Error("the tasks area isn't running");
      await tasks.cancel(r, task.taskId, `Cancelled: ${id} ${why}.`);
      cancelled++;
    } catch (error) {
      console.warn(`stop: cancel of ${task.taskId} failed:`, error);
    }
  }
  await approvals(hub).closeOpen(r, id, `${id} was stopped`);
  const at = isoMs(nowMs(hub.clock));
  records.workstreamPut({ ...stored, state: "stopped", headline: "Stopped by you", headlineAt: at, updatedAt: at });
  events(hub).append({
    at,
    type: "workstream.state",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: `${id} is stopped: ${why}`,
    data: { workstreamId: id, state: "stopped", reason: why, by },
  });
  leads(hub).wakes.trigger(r, {
    kind: "line",
    line: "human",
    text: renderEvent({ kind: "order_stopped", workstream: id, title: stored.title, why, cancelled }),
  });
  return { cancelled, offTrain };
}
