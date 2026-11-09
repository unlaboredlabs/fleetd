import type { Hub } from "../api/hub.ts";
import { SWEEP_EVERY_MS, sweep } from "./index.ts";

/** Starts the sweep (Rust: sweep.start): every 5 min, until the hub stops. */
export function start(hub: Hub): void {
  sweep(hub).start(SWEEP_EVERY_MS);
}
