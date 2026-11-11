// hub_restart: the hub restarts in place (Settings › Hubs & devices › Restart hub). The service manager restarts its service, the
// way an update's watcher does, asked from outside the service so the restart outlives the process that asked. Agents
// carry on on their machines, as across an update. On its way down the hub marks the leads whose profile changed since
// their session started; the hub that comes up starts each again on its current profile (leads/loops.ts).
import type { HubRestartOutput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { installedExe } from "../../update/index.ts";
import { isHubService, restartCommand, restartOutside, type Service, services } from "../../update/service.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { leads } from "../leads/index.ts";

/** What the restart does to the hub's machine; tests stand in fakes. */
export type RestartPorts = {
  /** The service `fleetd init` set up for this hub's binary; undefined for a hub run by hand. */
  service(): Service | undefined;
  /** Hands the service's restart to its manager and returns; throws one plain reason. */
  restart(service: Service): void;
};

export const restartPorts = (hub: Hub) =>
  hub.area<RestartPorts>("hub_restart", () => ({ service: () => services(installedExe()).find(isHubService), restart: restartOutside }));

const count = (n: number) => (n === 1 ? "1 lead starts" : `${n} leads start`);

export function restartHub(hub: Hub, caller: Caller): HubRestartOutput {
  const ports = restartPorts(hub);
  const service = ports.service();
  if (!service) {
    throw new ToolError(
      "failed",
      "The hub doesn't run as the service `fleetd init` sets up, so it can't restart itself.",
      "Restart it on its machine: stop `fleetd hub start` there and start it again.",
    );
  }
  try {
    ports.restart(service);
  } catch (e) {
    const [cmd, args] = restartCommand(service);
    throw new ToolError(
      "failed",
      `The hub couldn't restart itself: ${e instanceof Error ? e.message : String(e)}.`,
      `Run \`${cmd} ${args.join(" ")}\` on the hub's machine.`,
    );
  }
  // Marked only once the restart is on its way, and before this process can be told to stop.
  const switching = leads(hub).markProfileSwitches();
  console.info(`hub: restarting, asked by ${caller.name}; ${count(switching)} again on the current lead profile`);
  return {
    next:
      switching === 0
        ? "The hub restarts now: the connection drops for about a second. Agents carry on."
        : `The hub restarts now: the connection drops for about a second. Agents carry on, and ${count(switching)} again on the current lead profile, each once it is idle.`,
    leads: switching,
  };
}
