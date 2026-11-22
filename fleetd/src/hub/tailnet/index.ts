// The team's Tailscale connection on a self-hosted hub (W807, D653): the hub's computer is on the person's tailnet with
// its own Tailscale, and Connect lets the team's machines that aren't reach a tailnet MCP server through it. A machine
// on the tailnet reaches one directly and never uses this route. The state is read from the hub computer's own
// tailscaled (shared/tailnet_local.ts); Connect and Disconnect only turn the route on and off (`mcp_settings`
// tailnet_route): fleetd never logs the hub's computer in or out of its tailnet. fleetd's cloud runs a gateway of its
// own instead (its src/tailnet), behind the same tools and node routes.
//
// The machines hear whether the route is on, with the tailnet's MagicDNS suffix (`node_action` tailnet), as they link
// and on every change; a node relays its tailnet servers through ./route.ts then.
import type { TailnetState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_MCP_TAILNET } from "../../shared/node_link.ts";
import { CAP_SANDBOX } from "../../shared/sandbox.ts";
import { type LocalTailscale, localTailscale } from "../../shared/tailnet_local.ts";
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import { store } from "../store/hub_store.ts";

/** Why the row is off and the one fix, when the hub's computer has no Tailscale running. */
export const NOT_RUNNING =
  "Tailscale isn't running on the hub's computer. Install Tailscale there and sign in to your tailnet, then Connect";

/** How the hub reads its computer's Tailscale; a test sets its own (`hub.area("tailnet.host", …)` first). */
export type HostTailscale = () => Promise<LocalTailscale>;
const host = (hub: Hub) => hub.area<HostTailscale>("tailnet.host", () => localTailscale);

/** The route's switch: off until a person connects it. */
export function routeOn(hub: Hub): boolean {
  const row = hub.db.conn.query<{ value: number }, []>("SELECT value FROM mcp_settings WHERE key = 'tailnet_route'").get();
  return row !== null && row.value !== 0;
}

function setRoute(hub: Hub, on: boolean): void {
  hub.db.conn
    .query("INSERT INTO mcp_settings (key, value) VALUES ('tailnet_route', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(on ? 1 : 0);
}

/** The hub computer's Tailscale as last read: the route's suffix comes from it. */
const last = new WeakMap<Hub, LocalTailscale>();

export async function read(hub: Hub): Promise<LocalTailscale> {
  const now = await host(hub)();
  last.set(hub, now);
  return now;
}

export function stateOf(on: boolean, t: LocalTailscale): TailnetState {
  if (!t.running) return { status: "failed", problem: NOT_RUNNING };
  const named = { ...(t.tailnet ? { tailnet: t.tailnet } : {}), ...(t.device ? { device: t.device } : {}) };
  return on ? { status: "connected", ...named } : { status: "off", ...named };
}

export const state = async (hub: Hub): Promise<TailnetState> => stateOf(routeOn(hub), await read(hub));

export async function connect(hub: Hub): Promise<TailnetState> {
  const t = await read(hub);
  if (!t.running) throw new ToolError("failed", `${NOT_RUNNING.split(". ")[0]}.`, "Install Tailscale on the hub's computer and sign in to your tailnet, then Connect again.");
  setRoute(hub, true);
  sendState(hub);
  return stateOf(true, t);
}

export async function disconnect(hub: Hub): Promise<TailnetState> {
  setRoute(hub, false);
  sendState(hub);
  return stateOf(false, await read(hub));
}

/** Whether the route takes a dial now: on, and the hub's computer on its tailnet when last read. */
export const routing = (hub: Hub) => routeOn(hub) && last.get(hub)?.running === true;

/** The tailnet's MagicDNS suffix, while the route is on. */
export const suffix = (hub: Hub) => (routing(hub) ? last.get(hub)?.suffix : undefined);

/** What the machines hear: the suffix while the route is on, null while not. */
export const wire = (hub: Hub) => (routing(hub) ? { suffix: suffix(hub) ?? "" } : null);

/** Tells `machineIds` (every machine, by default) that relays tailnet servers or makes hosted boxes whether it is on. */
export function sendState(hub: Hub, machineIds?: string[]): void {
  const to = machineIds ?? store(hub).machinesList().map((m) => m.machineId);
  const t = wire(hub);
  for (const m of to) {
    if (!link(hub).can(m, CAP_MCP_TAILNET) && !link(hub).can(m, CAP_SANDBOX)) continue;
    void link(hub)
      .request(m, { t: "node_action", id: "", action: "tailnet", tailnet: t }, { waitSec: 15 })
      .catch((e: unknown) => console.warn(`tailnet: not told to ${m}: ${(e as Error).message}`));
  }
}
