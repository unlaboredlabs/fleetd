import type { Hub } from "../api/hub.ts";
import { every } from "../cloud/every.ts";
import { forgetQueued } from "./tools.ts";

/** Starts this module's loop (Rust: mcp_servers::tools::run_forget): `forgetQueued` each minute, until the hub stops. */
export function start(hub: Hub): void {
  every(hub, "mcp_servers: forgets", 60_000, () => forgetQueued(hub));
}
