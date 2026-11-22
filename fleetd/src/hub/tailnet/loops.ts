// The machines hear whether the hub's Tailscale route is on as they link, and again whenever the hub computer's own
// Tailscale goes up or down or the tailnet's suffix changes (read each minute).
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import { every } from "../serve/every.ts";
import { read, routeOn, sendState, wire } from "./index.ts";

export function start(hub: Hub): void {
  let said = JSON.stringify(wire(hub));
  const check = async () => {
    if (routeOn(hub)) await read(hub);
    const now = JSON.stringify(wire(hub));
    if (now === said) return;
    said = now;
    sendState(hub);
  };
  link(hub).onLinked(({ machineId }) => {
    void (routeOn(hub) ? read(hub) : Promise.resolve())
      .then(() => sendState(hub, [machineId]))
      .catch(() => {});
  });
  every(hub, "tailnet: the hub's Tailscale", 60_000, check);
}
