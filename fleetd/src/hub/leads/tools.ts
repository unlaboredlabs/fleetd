// lead_start, project_set and workstream_list.
import { allows } from "../auth/index.ts";
import { requireRole } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { others } from "../navi/owner.ts";
import { store } from "../store/hub_store.ts";
import { leads } from "./index.ts";
import { unknownProject } from "./seams.ts";

export function register(tools: Registry): void {
  tools.add("lead_start", async (hub, caller, input) => {
    const restart = input.fresh === true;
    requireRole(caller, "operate", input.machineId);
    const r = { machineId: input.machineId, projectId: input.projectId };
    const lead = restart ? await leads(hub).restart(r) : await leads(hub).start(r);
    const next = restart
      ? `Fresh lead thread ${lead.threadId} (session ${lead.sessionGeneration}) started from the current digest; the old thread stays on the node as history.`
      : `Lead thread ${lead.threadId} is ${lead.state}. Write to it with chat_send; watch it with project_get or events_wait (lead.woken, request.opened).`;
    return { ...lead, next };
  });

  tools.add("project_set", (hub, caller, input) => {
    requireRole(caller, "operate", input.machineId);
    const r = { machineId: input.machineId, projectId: input.projectId };
    const project = store(hub).projectGet(r);
    if (!project) throw unknownProject(r);
    const allowed = leads(hub).setAllowedProfiles(r, project.title, input.profiles);
    return {
      profiles: allowed,
      next: `Its lead may run new tasks on ${allowed.join(", ")}; ${allowed[0]} is the default. Running tasks keep their profile.`,
    };
  });

  tools.add("workstream_list", (hub, caller, input) => {
    if (input.machineId !== undefined) requireRole(caller, "read", input.machineId);
    const limit = input.limit ?? 50;
    const r = input.machineId !== undefined && input.projectId !== undefined ? { machineId: input.machineId, projectId: input.projectId } : undefined;
    // Another person's Only me project's orders are theirs alone.
    const navis = others(hub.db, caller);
    const all = leads(hub)
      .records.workstreamsList({ limit: r ? limit + 1 : 1000, ...(r ? { projectRef: r } : {}), ...(input.state ? { state: input.state } : {}) })
      .filter(
        (w) =>
          allows(caller, "read", w.projectRef.machineId) &&
          !navis.has(w.projectRef) &&
          (input.machineId === undefined || input.machineId === w.projectRef.machineId) &&
          (input.projectId === undefined || input.projectId === w.projectRef.projectId),
      );
    const truncated = all.length > limit;
    return { workstreams: all.slice(0, limit), ...(truncated ? { next: "Narrow the list with machineId, projectId or state.", truncated: true } : {}) };
  });
}
