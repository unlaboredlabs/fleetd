// usage_status and usage_resume (crates/fleetd/src/hub/usage/tools.rs).
import type { UsageStatus } from "../../shared/contracts.ts";
import { readable, requireRole } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { unknownMachine } from "../api/refusals.ts";
import { store } from "../store/hub_store.ts";
import { readLogin, usage } from "./wire.ts";

export function register(tools: Registry): void {
  tools.add("usage_status", async (hub, caller, input) => {
    if (input.machineId !== undefined) {
      requireRole(caller, "read", input.machineId);
      if (!store(hub).machineGet(input.machineId)) throw unknownMachine(input.machineId);
    }
    const machines = store(hub)
      .machinesList()
      .filter((m) => readable(caller, m.machineId) && (input.machineId === undefined || input.machineId === m.machineId));
    const statuses: UsageStatus[] = [];
    for (const m of machines) statuses.push(await usage(hub).status(m.machineId, await readLogin(hub, m.machineId)));
    const open = statuses.filter((s) => s.breaker.state === "open").map((s) => s.machineId);
    const next =
      open.length === 0
        ? "No login is paused."
        : `Paused: ${open.join(", ")}. It lifts at the reset, or press Resume in the app (or run fleetd usage resume <machine>) once the login has capacity.`;
    return { machines: statuses, next };
  });

  tools.add("usage_resume", async (hub, caller, input) => {
    const m = input.machineId;
    requireRole(caller, "operate", m);
    if (!store(hub).machineGet(m)) throw unknownMachine(m);
    const resumed = await usage(hub).resume(m, caller.name);
    const status = await usage(hub).status(m, await readLogin(hub, m));
    return {
      resumed,
      status,
      next: "Queued tasks start as slots allow. If the limit is still there, the breaker trips again on the next failures.",
    };
  });
}
