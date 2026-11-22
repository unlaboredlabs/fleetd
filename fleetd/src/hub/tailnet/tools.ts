// `tailnet_get`, `tailnet_connect` and `tailnet_disconnect`: Tailscale's row in Connections. Reading is any person's;
// the rest is a hub admin's (api/tool_roles.ts).
import type { Registry } from "../api/registry.ts";
import { connect, disconnect, state } from "./index.ts";

export function register(tools: Registry): void {
  tools.add("tailnet_get", (hub) => state(hub));
  tools.add("tailnet_connect", (hub) => connect(hub));
  tools.add("tailnet_disconnect", (hub) => disconnect(hub));
}
