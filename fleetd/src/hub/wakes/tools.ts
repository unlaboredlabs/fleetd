// wake_set, wake_list and wake_cancel.
import type { Wake } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { readable, requireRole } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { cap, queuePorts, unknownMachine, unknownThread } from "../leads/seams.ts";
import { others, type Refs, threadAmong } from "../navi/owner.ts";
import { store } from "../store/hub_store.ts";
import { WakeInvalid, wakes } from "./index.ts";

const WAKES_LISTED = 200;

/** A write that may wait in the queue needs a target the hub has seen, since the node can't vouch for it offline. */
function requireKnownThread(hub: Hub, target: { machineId: string; threadId: string }): void {
  if (!store(hub).machineGet(target.machineId)) throw unknownMachine(target.machineId);
  if (!store(hub).threadGet(target) && !queuePorts(hub).isConnected(target.machineId)) throw unknownThread(target);
}

const theirs = (hub: Hub, navis: Refs, w: Wake) => threadAmong(hub.db, navis, w.target.machineId, w.target.threadId);

export function register(tools: Registry): void {
  tools.add("wake_set", (hub, caller, input) => {
    requireRole(caller, "operate", input.target.machineId);
    requireKnownThread(hub, input.target);
    let set: { wakeId: string; nextRunAt: string };
    try {
      set = wakes(hub).set({
        target: input.target,
        schedule: input.schedule,
        message: input.message,
        once: input.once ?? true,
        catchUp: input.catchUp ?? "fire_once",
        clientRequestId: input.clientRequestId,
        createdBy: caller.keyId,
      });
    } catch (error) {
      if (!(error instanceof WakeInvalid)) throw error;
      throw new ToolError(
        "invalid",
        `Invalid schedule: ${error.message}`,
        "Use at (ISO time, future), every (everySec >= 60) or a 5-field cron, with an IANA tz such as Europe/London.",
      );
    }
    return {
      wakeId: set.wakeId,
      nextRunAt: set.nextRunAt,
      next: `Call events_wait with types ["wake.fired"] to see it fire, or wake_cancel with wakeId ${set.wakeId}.`,
    };
  });

  tools.add("wake_list", (hub, caller, input) => {
    if (input.machineId !== undefined) requireRole(caller, "read", input.machineId);
    const navis = others(hub.db, caller);
    const all = wakes(hub)
      .list({ machineId: input.machineId, threadId: input.threadId, state: input.state })
      .filter((w) => readable(caller, w.target.machineId) && !theirs(hub, navis, w));
    const shown = cap(all, WAKES_LISTED);
    return {
      wakes: shown.items,
      ...(shown.truncated ? { next: "Narrow the list with machineId, threadId or state.", truncated: true } : {}),
    };
  });

  tools.add("wake_cancel", (hub, caller, input) => {
    const navis = others(hub.db, caller);
    const wake = wakes(hub).get(input.wakeId);
    if (!wake || !readable(caller, wake.target.machineId) || theirs(hub, navis, wake)) {
      throw new ToolError("not_found", `No wake ${input.wakeId}.`, "Call wake_list to see wakes.");
    }
    requireRole(caller, "operate", wake.target.machineId);
    wakes(hub).cancel(input.wakeId);
    return { ok: true };
  });
}
