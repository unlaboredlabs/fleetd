import type { Hub } from "../api/hub.ts";
import { found } from "../navi/bridge.ts";
import { status, statusRows } from "./index.ts";

/**
 * Starts the status follower (Rust: status.run): freshness flips at their deadlines, until the hub stops. And hands
 * the ask bridge the rows its `factory_status` reads.
 */
export function start(hub: Hub): void {
  found.statusRows = statusRows;
  status(hub).run();
}
