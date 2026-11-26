// `machine_roles` and `machine_roles_set`: Settings › Hub › Machines and `fleetd machine set <id> --roles`. A machine
// has no switch per kind of screen: it hosts every kind it can run, as its node reports. `screen_open` and
// `screen_end` are screens.ts's.
import type { MachineRole, MachineRolesEntry } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { readable, requireRole } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { bestWorker } from "../projects/discover.ts";
import { store } from "../store/hub_store.ts";
import { retentionOn } from "../browser/store.ts";
import { isAgentsMac, tool } from "./mac.ts";
import { entry, rolesOn, runners, setRoles, setToolOn } from "./places.ts";
import { register as registerScreens } from "./screens.ts";
import { settingsPath } from "../../shared/settings_path.ts";
import { SIMS_MAX } from "../../node/mac_tool/protocol.ts";
import { tellSims } from "../mac_tool/index.ts";

export function register(tools: Registry): void {
  tools.add("machine_roles", machineRoles);
  tools.add("machine_roles_set", machineRolesSet);
  registerScreens(tools);
}

/** What the app's machine settings read besides roles: the agents' Mac's tool, and whether the caller works there. */
function forCaller(hub: Hub, caller: Caller, e: MachineRolesEntry): MachineRolesEntry {
  const m = e.machineId;
  const mac = tool(hub, m);
  return { ...e, ...(mac ? { mac } : {}), operates: allows(caller, "operate", m) };
}

function machineRoles(hub: Hub, caller: Caller) {
  const machines = runners(hub)
    .filter((r) => readable(caller, r.runner.machineId))
    .map((r) => forCaller(hub, caller, entry(r)));
  const best = bestWorker(hub);
  return {
    machines,
    ...(best ? { best } : {}),
    retention: retentionOn(hub.db.conn),
    ...(machines.length === 0 ? { next: "No computer has joined yet: add one with fleetd machine add, or run agents in hosted sandboxes by connecting a provider (sandbox_connect)." } : {}),
  };
}

function machineRolesSet(
  hub: Hub,
  caller: Caller,
  input: {
    machineId: string;
    roles?: MachineRole[];
    maxSessions?: number;
    autoSessions?: boolean;
    macTool?: boolean;
    maxSims?: number;
    autoSims?: boolean;
  },
) {
  const m = input.machineId;
  requireRole(caller, "admin", m);
  if (!store(hub).machineGet(m)) throw new ToolError("not_found", `No machine ${m}.`, "machine_roles lists the machines.");
  const agentsMac = isAgentsMac(hub, m);
  if (input.macTool !== undefined && !agentsMac) {
    throw new ToolError(
      "invalid",
      `${m} isn't the agents' Mac, so it has no Mac tool to turn on or off.`,
      `${settingsPath()} › Setup › A Mac for agents joins one.`,
    );
  }
  if (agentsMac && input.roles?.includes("agents")) {
    throw new ToolError(
      "invalid",
      `${m} is the agents' Mac: a tool for agents on other machines, so it never runs agents or leads itself.`,
      "Run agents on another machine; they use this Mac with `mac run` and `mac sim`.",
    );
  }
  if (input.maxSessions !== undefined && (!Number.isInteger(input.maxSessions) || input.maxSessions < 1 || input.maxSessions > 64)) {
    throw new ToolError("invalid", "maxSessions: 1 to 64.");
  }
  if (input.maxSims !== undefined && (!Number.isInteger(input.maxSims) || input.maxSims < 1 || input.maxSims > SIMS_MAX)) {
    throw new ToolError("invalid", `maxSims: 1 to ${SIMS_MAX}.`);
  }
  const [before, after] = hub.db.transaction((c) => {
    if (input.macTool !== undefined) setToolOn(c, input.macTool);
    const was = rolesOn(c, m);
    const next = { ...was };
    if (input.roles) {
      next.agents = input.roles.includes("agents");
      next.sessions = input.roles.includes("sessions");
    }
    if (input.maxSessions !== undefined) next.maxSessions = input.maxSessions;
    if (input.autoSessions === true) next.maxSessions = undefined;
    if (input.maxSims !== undefined) next.maxSims = input.maxSims;
    if (input.autoSims === true) delete next.maxSims;
    setRoles(c, m, next);
    return [was, next] as const;
  });
  // The Mac hears a new number of simulators at once now, not at its next `mac` call.
  if (input.maxSims !== undefined || input.autoSims === true) tellSims(hub, m);
  // TODO(bun): hub/slots `set_runs_agents` once the slots area has it; it reads machine_roles itself meanwhile.
  const row = runners(hub).find((r) => r.runner.machineId === m);
  if (!row) throw new ToolError("not_found", `No machine ${m}.`);
  let next: string | undefined;
  if (before.agents && !after.agents) {
    next = `${m} takes no new agents: those running finish their work, and its bots' agents wait.`;
  } else if (!before.agents && after.agents) {
    next = `${m} runs agents again: queued ones start as slots free.`;
  } else if (input.macTool !== undefined) {
    next = input.macTool
      ? `Agents may use ${m} again: their mac commands run there.`
      : `Agents' mac commands now answer that ${m} is turned off.`;
  }
  return { machine: forCaller(hub, caller, entry(row)), ...(next === undefined ? {} : { next }) };
}
