// automation_list, automation_create, automation_update, automation_pause, automation_rotate, automation_delete,
// automation_run and automation_runs: Settings > Automations, and any MCP client with the grant.
// Reads need read on the project's machine, writes operate there.
// automation_list also gives the nightly memory refresh's row (src/hub/memory/refresh.ts).
import type { Automation, Role } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { job } from "../memory/refresh.ts";
import { store } from "../store/hub_store.ts";
import { automations, type Edit, RUNS_KEPT, webhookUrl } from "./index.ts";

/** Who a call is by, as the automation and its runs record it. */
const by = (caller: Caller) => (isHuman(caller) ? "human" : caller.keyId);

/**
 * The automation, once the caller holds `role` on its machine. An automation on a machine the key can't read is as
 * unknown as one that doesn't exist.
 */
function granted(hub: Hub, caller: Caller, id: string, role: Role): Automation {
  const unknown = () => new ToolError("not_found", `There is no automation ${id}.`, "automation_list with the project's projectRef shows its automations.");
  const a = automations(hub).get(id);
  if (!a) throw unknown();
  try {
    requireRole(caller, "read", a.projectRef.machineId);
  } catch {
    throw unknown();
  }
  requireRole(caller, role, a.projectRef.machineId);
  return a;
}

const url = (hub: Hub, a: Automation, secret: string | undefined) => (secret === undefined ? undefined : webhookUrl(hub.url(), a.automationId, secret));

const URL_ONCE = "The webhook URL holds its secret and is shown only now: copy it. automation_rotate makes a new one.";

export function register(tools: Registry): void {
  tools.add("automation_list", (hub, caller, input) => {
    requireRole(caller, "read", input.projectRef.machineId);
    const list = automations(hub).list(input.projectRef);
    // A project the hub doesn't know has no refresh to list.
    const refresh = store(hub).projectGet(input.projectRef) ? job(hub, input.projectRef) : undefined;
    return {
      automations: list,
      ...(refresh === undefined ? {} : { memoryRefresh: refresh }),
      ...(list.length === 0 ? { next: "No automations yet; automation_create makes one." } : {}),
    };
  });

  tools.add("automation_create", (hub, caller, input) => {
    requireRole(caller, "operate", input.projectRef.machineId);
    const [automation, secret] = automations(hub).create({
      projectRef: input.projectRef,
      name: input.name,
      prompt: input.prompt,
      ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
      webhook: input.webhook === true,
      by: by(caller),
      // Made in the app, the person wrote it.
      confirmed: isHuman(caller),
      clientRequestId: input.clientRequestId,
    });
    const webhook = url(hub, automation, secret);
    const next =
      webhook !== undefined
        ? URL_ONCE
        : automation.webhook
          ? "Already made by this request; automation_rotate shows a new webhook URL."
          : "Its runs open orders for the project's lead; automation_run runs it now.";
    return { automation, ...(webhook === undefined ? {} : { webhookUrl: webhook }), next };
  });

  tools.add("automation_update", (hub, caller, input) => {
    const a = granted(hub, caller, input.automationId, "operate");
    const schedule: Edit["schedule"] = input.removeSchedule === true ? null : input.schedule;
    // Edited in the app, the person stands behind what they saw; another key's change to what it runs or when unsets it.
    const confirmed = isHuman(caller) ? true : input.prompt !== undefined || schedule !== undefined ? false : undefined;
    const [automation, secret] = automations(hub).update(
      a.automationId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(schedule === undefined ? {} : { schedule }),
        ...(input.webhook === undefined ? {} : { webhook: input.webhook }),
        ...(confirmed === undefined ? {} : { confirmed }),
      },
      by(caller),
    );
    const webhook = url(hub, automation, secret);
    return { ...(webhook === undefined ? {} : { next: URL_ONCE }), automation, ...(webhook === undefined ? {} : { webhookUrl: webhook }) };
  });

  tools.add("automation_pause", (hub, caller, input) => {
    const a = granted(hub, caller, input.automationId, "operate");
    const automation = automations(hub).pause(a.automationId, input.paused, by(caller));
    const next = input.paused ? "Paused: its schedule and webhook start nothing; Run now still runs it." : "Resumed: its schedule goes on from now.";
    return { automation, next };
  });

  tools.add("automation_rotate", (hub, caller, input) => {
    const a = granted(hub, caller, input.automationId, "operate");
    const [automation, secret] = automations(hub).rotate(a.automationId, by(caller));
    return { webhookUrl: webhookUrl(hub.url(), automation.automationId, secret), automation, next: `${URL_ONCE} The old URL no longer works.` };
  });

  tools.add("automation_delete", (hub, caller, input) => {
    const a = granted(hub, caller, input.automationId, "operate");
    automations(hub).delete(a.automationId, by(caller));
    return { ok: true, next: "Deleted with its run history; orders its runs opened stay." };
  });

  tools.add("automation_run", async (hub, caller, input) => {
    const a = granted(hub, caller, input.automationId, "operate");
    const run = await automations(hub).run(a.automationId, { kind: "manual", by: by(caller) });
    const next =
      run.workstreamId !== undefined
        ? `It opened ${run.workstreamId} for the lead; watch it with order_get.`
        : run.why !== undefined
          ? `Not run: ${run.why}.`
          : "";
    return { run, next };
  });

  tools.add("automation_runs", (hub, caller, input) => {
    const a = granted(hub, caller, input.automationId, "read");
    const limit = Math.min(input.limit, RUNS_KEPT);
    return { runs: automations(hub).runs(a.automationId, limit) };
  });
}
