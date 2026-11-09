// A machine that lost its IPv4 network (crates/fleetd/src/hub/link/network.rs). Its node says with each heartbeat
// whether its own network hardware holds a routable IPv4 address, and the landing scanner finds whether git there
// reaches GitHub. Both at once, no IPv4 and GitHub not answering, degrade the machine with the fix only the person can
// run; either one back clears it. Agents keep running there: claude may still reach its API over IPv6.
import type { NodeNetwork } from "../../shared/node_link.ts";

/**
 * Why the machine is degraded for its network, with the fix, or undefined while it has IPv4 or GitHub answers it. A
 * node that says nothing of its network (an older one, a Mac, a container) is never degraded for it.
 */
export function problem(network: NodeNetwork | undefined, githubDown: boolean): string | undefined {
  if (!network || network.ipv4 || !githubDown) return undefined;
  return network.iface !== undefined
    ? `no IPv4 network on ${network.iface}, so GitHub can't be reached. Fix: run \`sudo networkctl reconfigure ${network.iface}\` or \`sudo netplan apply\``
    : "no IPv4 network, so GitHub can't be reached. Fix: run `sudo netplan apply`";
}
