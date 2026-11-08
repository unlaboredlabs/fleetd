import type { Hub } from "../api/hub.ts";
import { link } from "./server.ts";

/** Starts this module's loops (Rust: link.start): the silence timers of machines the store says are not offline. */
export function start(hub: Hub): void {
  link(hub).start();
}
