// agents_list (crates/fleetd/src/hub/agents/tools.rs). agent_work comes with the executor's thread views.
import { requireRole } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { isoMs } from "../store/time.ts";
import { AGENTS_MAX, rows } from "./index.ts";

export function register(tools: Registry): void {
  tools.add("agents_list", (hub, caller, input) => {
    if (input.projectRef) requireRole(caller, "read", input.projectRef.machineId);
    const [agents, truncated] = rows(hub, caller, input.projectRef, input.endedSince, AGENTS_MAX);
    return {
      agents,
      at: isoMs(hub.clock.now()),
      next: "agent_work with a row's threadRef reads what it did; live { agent: laneId } streams its text.",
      ...(truncated ? { truncated: true } : {}),
    };
  });
}
