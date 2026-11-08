import type { Hub } from "../api/hub.ts";
import { status } from "./index.ts";

/** Starts the status follower (Rust: status.run): freshness flips at their deadlines, until the hub stops. */
export function start(hub: Hub): void {
  status(hub).run();
}
