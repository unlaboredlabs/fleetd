import type { Hub } from "../api/hub.ts";
import { watchdog } from "./index.ts";

/** Starts the stall watchdog (Rust: watchdog.start): a check every 30 s, until the hub stops. */
export function start(hub: Hub): void {
  watchdog(hub).start(hub);
}
