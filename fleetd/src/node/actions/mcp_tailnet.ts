// A tailnet MCP server (`McpSessionServer.tailnet`) from a machine that isn't on the tailnet: its session reaches it
// through `fleetd mcp-relay`, whose requests the node sends on through the hub's Tailscale route (../sandbox/tailnet.ts
// `dial`, shared/tailnet.ts DIAL_PATH). A machine on the tailnet (its own Tailscale running) reaches the server
// directly, as claude would any URL, and never uses the route. Whether this machine is on the tailnet is read at the
// node's start and every half minute.
import { type LocalTailscale, localTailscale } from "../../shared/tailnet_local.ts";
import { nodeTailnet } from "../sandbox/tailnet.ts";
import { dialFetch, type Fetcher } from "../sandbox/tailnet_fetch.ts";

let here: LocalTailscale = { running: true };
let read: () => Promise<LocalTailscale> = localTailscale;

/** A test's own reading of this machine's Tailscale. */
export function setLocalTailscale(f: () => Promise<LocalTailscale>): void {
  read = f;
}

export async function refresh(): Promise<LocalTailscale> {
  try {
    here = await read();
  } catch {
    here = { running: false };
  }
  return here;
}

/** Whether a tailnet server goes through the hub now: this machine isn't on the tailnet, and the hub's route is on. */
export const viaHub = () => !here.running && nodeTailnet()?.on === true;

/** A `fetch` through the hub's route. */
export function routeFetch(): Fetcher {
  const t = nodeTailnet();
  if (!t) throw new Error("this node has no route to the team's tailnet");
  return dialFetch((host, port) => t.dial(host, port));
}

export function start(signal?: AbortSignal): Promise<void> {
  const timer = setInterval(() => void refresh(), 30_000);
  timer.unref?.();
  signal?.addEventListener("abort", () => clearInterval(timer));
  return refresh().then(() => {});
}
