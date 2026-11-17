// `sandbox_get`, `sandbox_connect`, `sandbox_set`, `sandbox_test` and `sandbox_disconnect`: Settings › Hub › Machines'
// Sandboxes section, one row per hosted provider. Reading is any person's (no secret is in it); the rest is a hub
// admin's (api/tool_roles.ts).
import type { Registry } from "../api/registry.ts";
import { connect, disconnect, setLimit, state, test } from "./index.ts";

export function register(tools: Registry): void {
  tools.add("sandbox_get", (hub) => state(hub));
  tools.add("sandbox_connect", (hub, _caller, input: { provider: string; sealed: string; domain?: string; limit?: number }) => connect(hub, input));
  tools.add("sandbox_set", (hub, _caller, input: { provider: string; limit: number }) => setLimit(hub, input));
  tools.add("sandbox_test", (hub, _caller, input: { provider: string }) => test(hub, input.provider));
  tools.add("sandbox_disconnect", (hub, _caller, input: { provider: string }) => disconnect(hub, input));
}
