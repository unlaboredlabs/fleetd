// Stop being the agents' Mac (`fleetd node leave`, the app's status window): the Mac tells its hub it leaves, over a
// link of its own with the node's key, once the node's service is stopped. The hub removes the machine as
// machine_remove does and closes the link as removed (hub/link/server.ts `leave`). A hub that isn't reached in time,
// or too old to take a `leave`, keeps the machine, which it then shows offline until an admin removes it there.
import { CAP_AGENTS_MAC } from "../../shared/node_link.ts";
import { VERSION } from "../../shared/version.ts";
import type { NodeConfig } from "../config.ts";
import type { NodeIdentity } from "../identity.ts";
import { runNode } from "../link/index.ts";
import { HUB_CAP } from "../wire.ts";

/** How long the Mac tries to reach its hub before it leaves without telling it. */
export const LEAVE_WAIT_MS = 8_000;

/** What the hub made of it: removed the machine; not reached in time; or too old to take a `leave`. */
export type Told = "removed" | "unreached" | "old";

export async function tellHub(
  config: Pick<NodeConfig, "hub" | "machineId" | "name">,
  identity: NodeIdentity,
  waitMs = LEAVE_WAIT_MS,
  run: typeof runNode = runNode,
): Promise<Told> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), waitMs);
  let old = false;
  try {
    const fatal = await run({
      settings: { hub: config.hub, machineId: config.machineId, name: config.name, nodeVersion: VERSION },
      identity,
      capabilities: () => [CAP_AGENTS_MAC],
      heartbeat: async () => ({}),
      attach: (link) => {
        if (link.hubCaps.includes(HUB_CAP.MACHINE_LEAVE)) link.send({ t: "leave" });
        else {
          old = true;
          stop.abort();
        }
        return () => {};
      },
      handle: () => {},
      log: () => {},
      signal: stop.signal,
    });
    // Refused as removed: the hub let it go, or had already.
    if (fatal?.removed === true || fatal?.unknown === true) return "removed";
    return old ? "old" : "unreached";
  } finally {
    clearTimeout(timer);
  }
}
