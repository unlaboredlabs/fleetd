import type { Hub } from "../api/hub.ts";
import { start as startVault } from "../vault/loops.ts";
import { executors } from "../executor/index.ts";
import * as lifecycle from "./lifecycle.ts";
import { imageChanged } from "./settings.ts";

/** Starts this module's loops (Rust: projects::order_env::run), and the vault's, whose variables are the projects'. */
export function start(hub: Hub): void {
  lifecycle.start(hub);
  executors(hub).sinks.image = (m, projectId) => imageChanged(hub, m, projectId);
  startVault(hub);
}
