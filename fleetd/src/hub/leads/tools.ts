// lead_start, project_set (the profiles a bot's agents may run on, and its lead's own) and workstream_list.
import { allows } from "../auth/index.ts";
import { requireRole } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { profiles } from "../projects/profiles.ts";
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

  tools.add("project_set", async (hub, caller, input) => {
    requireRole(caller, "operate", input.machineId);
    const r = { machineId: input.machineId, projectId: input.projectId };
    const project = store(hub).projectGet(r);
    if (!project) throw unknownProject(r);
    const area = leads(hub);
    const said: string[] = [];
    let allowed = area.allowedProfiles(r);
    if (input.profiles !== undefined) {
      allowed = area.setAllowedProfiles(r, project.title, input.profiles);
      said.push(`Its lead may run new tasks on ${allowed.join(", ")}; ${allowed[0]} is the default. Running tasks keep their profile.`);
    }
    if (input.leadProfile !== undefined || input.leadDefault === true) {
      const lead = area.setLeadProfile(r, project.title, input.leadDefault === true ? undefined : input.leadProfile);
      said.push(`Its lead starts on ${lead.name} from its next start${input.leadRestart === true ? "" : "; leadRestart: true starts it on it now"}.`);
    }
    if (input.leadRestart === true) {
      const due = area.records.leadGet(r) !== undefined && (await area.switchSoon(r));
      said.push(due ? "Its lead starts again on it now, or once its turn ends; it keeps its chat, memory and orders." : "Its lead already runs on its lead profile: nothing to restart.");
    }
    const pick = profiles(hub).leadPick(r);
    return { profiles: allowed, ...(pick ? { leadProfile: pick.name } : {}), next: said.join(" ") || "Nothing changed." };
  });

  tools.add("workstream_list", (hub, caller, input) => {
    if (input.machineId !== undefined) requireRole(caller, "read", input.machineId);
    const limit = input.limit ?? 50;
    const r = input.machineId !== undefined && input.projectId !== undefined ? { machineId: input.machineId, projectId: input.projectId } : undefined;
    const all = leads(hub)
      .records.workstreamsList({ limit: r ? limit + 1 : 1000, ...(r ? { projectRef: r } : {}), ...(input.state ? { state: input.state } : {}) })
      .filter(
        (w) =>
          allows(caller, "read", w.projectRef.machineId) &&
          (input.machineId === undefined || input.machineId === w.projectRef.machineId) &&
          (input.projectId === undefined || input.projectId === w.projectRef.projectId),
      );
    const truncated = all.length > limit;
    return { workstreams: all.slice(0, limit), ...(truncated ? { next: "Narrow the list with machineId, projectId or state.", truncated: true } : {}) };
  });
}
