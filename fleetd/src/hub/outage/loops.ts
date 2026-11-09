import type { Hub } from "../api/hub.ts";
import { run } from "./index.ts";

/** Starts this module's loop (Rust: outage::run): every 30 s, until the hub stops. */
export function start(hub: Hub): void {
  run(hub);
}
