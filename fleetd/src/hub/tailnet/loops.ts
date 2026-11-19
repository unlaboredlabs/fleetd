// The team's Tailscale gateway starts with the hub from its sealed state, if it has one (serve/index.ts stops it with
// the hub); the machines that make hosted boxes hear whether it is on as they link and on every change.
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import { sendState, tailnet, wire } from "./index.ts";

export function start(hub: Hub): void {
  const g = tailnet(hub);
  void g.start?.().catch((e: unknown) => console.warn(`tailnet: the gateway didn't start: ${(e as Error).message}`));
  // Only what the machines hear: on with its suffix, or off.
  let last = JSON.stringify(wire(g));
  g.onChange(() => {
    const now = JSON.stringify(wire(g));
    if (now === last) return;
    last = now;
    sendState(hub);
  });
  link(hub).onLinked(({ machineId }) => sendState(hub, [machineId]));
}
