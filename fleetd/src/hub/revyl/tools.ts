// `revyl_get`, `revyl_connect`, `revyl_test`, `revyl_disconnect` and `revyl_route_set`: Settings › Hub › Machines'
// Revyl row and each phone kind's route. Reading is any person's (no secret is in it); the rest is a hub admin's
// (api/tool_roles.ts).
import type { RevylKind } from "../../shared/contracts.ts";
import type { Registry } from "../api/registry.ts";
import { connect, disconnect, setRoute, state, test } from "./index.ts";

export function register(tools: Registry): void {
  tools.add("revyl_get", (hub) => state(hub));
  tools.add("revyl_connect", (hub, _caller, input: { sealed: string }) => connect(hub, input.sealed));
  tools.add("revyl_test", (hub) => test(hub));
  tools.add("revyl_disconnect", (hub) => disconnect(hub));
  tools.add("revyl_route_set", (hub, _caller, input: { kind: RevylKind; route: string }) => setRoute(hub, input.kind, input.route));
}
