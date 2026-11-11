import type { Hub } from "../api/hub.ts";
import { every } from "../serve/every.ts";
import { found } from "../executor/sessions.ts";
import { policy, toolRules } from "../policy/index.ts";
import { forgetQueued } from "./tools.ts";

/** Starts this module's loop (Rust: mcp_servers::tools::run_forget): `forgetQueued` each minute, until the hub stops. */
export function start(hub: Hub): void {
  // The repo policy file's cache, `hub.area("policy")`, made at start so the train finds it (hub.peek).
  policy(hub);
  // Each launch's tool rules from that file (Rust: executor.set_tool_policy).
  found.toolRules = (h, r) => toolRules(policy(h), r);
  every(hub, "mcp_servers: forgets", 60_000, () => forgetQueued(hub));
}
