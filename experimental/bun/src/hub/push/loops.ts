import type { Hub } from "../api/hub.ts";
import { run } from "./index.ts";

/** Starts this module's loop (Rust: push::run): it follows the event log from its head until the hub stops. */
export function start(hub: Hub): void {
  run(hub);
}
