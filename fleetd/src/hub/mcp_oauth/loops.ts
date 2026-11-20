import type { Hub } from "../api/hub.ts";
import { every } from "../serve/every.ts";
import { registerLeadCalls } from "./calls.ts";
import { RENEW_TICK_MS, renewDue } from "./index.ts";

/** Starts this module's loop (Rust: mcp_oauth::run_renew): `renewDue` every 30 s, until the hub stops; and takes an
 * agent's relay's `mcp_oauth_renew`. */
export function start(hub: Hub): void {
  registerLeadCalls(hub);
  every(hub, "mcp_oauth: renewal", RENEW_TICK_MS, () => renewDue(hub));
}
