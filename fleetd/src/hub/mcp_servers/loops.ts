import type { Hub } from "../api/hub.ts";
import { every } from "../serve/every.ts";
import { found } from "../executor/sessions.ts";
import { policy, toolRules } from "../policy/index.ts";
import { forgetQueued, plainKeyless } from "./tools.ts";
import { syncAllVault } from "./vault_sync.ts";

/** Starts this module's loop (Rust: mcp_servers::tools::run_forget): `forgetQueued` and `syncAllVault` each minute, until the hub stops. */
export function start(hub: Hub): void {
  // The repo policy file's cache, `hub.area("policy")`, made at start so the train finds it (hub.peek).
  policy(hub);
  // Each launch's tool rules from that file (Rust: executor.set_tool_policy).
  found.toolRules = (h, r) => toolRules(policy(h), r);
  every(hub, "mcp_servers: forgets", 60_000, () => forgetQueued(hub));
  // A keyless team server an owner or admin added as a sign-in before fleetd asked whether it signs in: once, as no
  // save makes one now.
  try {
    plainKeyless(hub);
  } catch (e) {
    console.warn("keyless team MCP servers not made plain:", e);
  }
  // Vault values: a changed or deleted item, and a machine that was offline at the save.
  every(hub, "mcp_servers: vault values", 60_000, () => syncAllVault(hub));
}
