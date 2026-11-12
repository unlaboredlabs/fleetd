// `machine_roles`, `machine_roles_set` and `machine_screens_set`:
// Settings › Hub › Machines and `fleetd machine set <id> --roles`, and its Screens: a kind of screen turned on or off
// on a machine, or its idle timeout, which the machine's node writes into its node.json. `screen_open` and
// `screen_end` are screens.ts's.
import type { HostCheck, MachineRole, MachineRolesEntry, SessionHost } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_SCREEN_SETTINGS, type ScreenSettings } from "../../shared/screens_wire.ts";
import { macRefuses } from "../../node/screens/settings.ts";
import type { Hub } from "../api/hub.ts";
import { readable, requireRole } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { link } from "../link/index.ts";
import { bestWorker } from "../projects/discover.ts";
import { store } from "../store/hub_store.ts";
import { retentionOn } from "../browser/store.ts";
import { request } from "./calls.ts";
import { isAgentsMac, tool } from "./mac.ts";
import { entry, rolesOn, runners, setRoles, setToolOn } from "./places.ts";
import { register as registerScreens } from "./screens.ts";

/** How long a node takes to write its screens settings and answer. */
const SCREENS_WAIT = 30_000;

export function register(tools: Registry): void {
  tools.add("machine_roles", machineRoles);
  tools.add("machine_roles_set", machineRolesSet);
  tools.add("machine_screens_set", machineScreensSet);
  registerScreens(tools);
}

/** The command that restarts a machine's node, run there, on either system. */
const NODE_RESTART =
  "launchctl kickstart -k gui/$(id -u)/sh.fleetd.node 2>/dev/null || systemctl --user restart fleetd-node.service";

/**
 * What the app's machine settings read besides roles: whether its node takes screen settings. A node between two links
 * says nothing either way: only a linked node that doesn't list them is too old, and then the command that restarts
 * it goes with it.
 */
function forCaller(hub: Hub, caller: Caller, e: MachineRolesEntry): MachineRolesEntry {
  const m = e.machineId;
  const nodes = link(hub);
  const can = nodes.can(m, CAP_SCREEN_SETTINGS);
  const old = nodes.lacks(m, CAP_SCREEN_SETTINGS);
  const mac = tool(hub, m);
  return {
    ...e,
    ...(mac ? { mac } : {}),
    ...(can || old ? { screenSettings: can } : {}),
    // TODO(bun): the restart command `fleetd machine add` set up (hub/doctor/config.rs), once the doctor area has it.
    ...(old ? { nodeRestart: NODE_RESTART } : {}),
    operates: allows(caller, "operate", m),
  };
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
    ...(machines.length === 0 ? { next: "No machine has joined yet: add one with fleetd machine add." } : {}),
  };
}

function machineRolesSet(
  hub: Hub,
  caller: Caller,
  input: { machineId: string; roles?: MachineRole[]; maxSessions?: number; autoSessions?: boolean; macTool?: boolean },
) {
  const m = input.machineId;
  requireRole(caller, "admin", m);
  if (!store(hub).machineGet(m)) throw new ToolError("not_found", `No machine ${m}.`, "machine_roles lists the machines.");
  const agentsMac = isAgentsMac(hub, m);
  if (input.macTool !== undefined && !agentsMac) {
    throw new ToolError(
      "invalid",
      `${m} isn't the agents' Mac, so it has no Mac tool to turn on or off.`,
      "Settings › Hub › Setup › A Mac for agents joins one.",
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
    setRoles(c, m, next);
    return [was, next] as const;
  });
  // TODO(bun): hub/slots `set_runs_agents` once the slots area has it; it reads machine_roles itself meanwhile.
  const row = runners(hub).find((r) => r.runner.machineId === m);
  if (!row) throw new ToolError("not_found", `No machine ${m}.`);
  let next: string | undefined;
  if (before.agents && !after.agents) {
    next = `${m} takes no new agents: those running finish their work, and its projects' agents wait.`;
  } else if (!before.agents && after.agents) {
    next = `${m} runs agents again: queued ones start as slots free.`;
  } else if (input.macTool !== undefined) {
    next = input.macTool
      ? `Agents may use ${m} again: their mac commands run there.`
      : `Agents' mac commands now answer that ${m} is turned off.`;
  }
  return { machine: forCaller(hub, caller, entry(row)), ...(next === undefined ? {} : { next }) };
}

async function machineScreensSet(
  hub: Hub,
  caller: Caller,
  input: { machineId: string; host?: SessionHost; on?: boolean },
) {
  const m = input.machineId;
  requireRole(caller, "admin", m);
  const machine = store(hub).machineGet(m);
  if (!machine) throw new ToolError("not_found", `No machine ${m}.`, "machine_roles lists the machines.");
  const name = machine.name;
  const settings: ScreenSettings = {
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(input.on === undefined ? {} : { on: input.on }),
  };
  // The agents' Mac offers only its own screen, whatever an older node of it still lists.
  const refuses = machine.agentsMac === true ? macRefuses(settings) : undefined;
  if (refuses) throw new ToolError("invalid", `${name} didn't change: ${refuses}.`);
  const nodes = link(hub);
  if (!nodes.can(m, CAP_SCREEN_SETTINGS)) {
    if (nodes.linkId(m) === undefined) {
      throw new ToolError("machine_offline", `${name} is offline.`, `Start ${name}'s node, then try again.`);
    }
    throw new ToolError(
      "failed",
      `${name}'s fleetd is too old to take screen settings from the hub.`,
      `Update it from Settings › Hub › Machines › Updates, or set it in ${name}'s node.json by hand.`,
    );
  }
  let answer: { ok: boolean; message: string; hosts?: HostCheck[] };
  try {
    answer = await request(hub, m, { t: "node_action", action: "screens", screens: settings }, SCREENS_WAIT);
  } catch (e) {
    throw new ToolError("failed", (e as Error).message);
  }
  if (answer.hosts) nodes.setHosts(m, answer.hosts);
  if (!answer.ok) throw new ToolError("failed", `${name} didn't change: ${answer.message}`);
  const row = runners(hub).find((r) => r.runner.machineId === m);
  if (!row) throw new ToolError("not_found", `No machine ${m}.`);
  return { machine: forCaller(hub, caller, entry(row)), next: answer.message };
}
