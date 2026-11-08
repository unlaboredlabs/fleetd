import type { Hub } from "../api/hub.ts";
import { activity } from "../executor/activity.ts";
import { link } from "./server.ts";

/**
 * Starts this module's loops (Rust: link.start): the silence timers of machines the store says are not offline. The
 * threads' activity tracker is made here too, before any node links: the executor feeds it through `hub.peek`, which
 * never makes it (D354), so thread events that came before the first /app live client would be dropped.
 */
export function start(hub: Hub): void {
  activity(hub);
  link(hub).start();
}
