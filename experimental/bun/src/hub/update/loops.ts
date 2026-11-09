import type { Hub } from "../api/hub.ts";
import { updates } from "./tools.ts";

/**
 * Starts this module's loops (Rust: updates.resume, updates.prefetch_loop): the unfinished update a previous hub
 * process left, then the look at the channel every 2 minutes, each until the hub stops.
 */
export function start(hub: Hub): void {
  const u = updates(hub);
  void u.resume().catch((e) => console.error("update: resume failed:", e));
  void u.prefetchLoop().catch((e) => console.error("update: the prefetch loop stopped:", e));
}
