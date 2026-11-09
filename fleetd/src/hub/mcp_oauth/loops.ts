import type { Hub } from "../api/hub.ts";
import { every } from "../cloud/every.ts";
import { RENEW_TICK_MS, renewDue } from "./index.ts";

/** Starts this module's loop (Rust: mcp_oauth::run_renew): `renewDue` every 30 s, until the hub stops. */
export function start(hub: Hub): void {
  every(hub, "mcp_oauth: renewal", RENEW_TICK_MS, () => renewDue(hub));
}
