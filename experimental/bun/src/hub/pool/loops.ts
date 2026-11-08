import type { Hub } from "../api/hub.ts";
import { pool } from "./tools.ts";

/** Starts this module's loop (Rust: pool::run): the sweep at start and every 10 minutes, the life loop every 30 s. */
export function start(hub: Hub): void {
  void pool(hub)
    .run(hub.shutdown.signal)
    .catch((e) => console.error("pool: its loop stopped:", e));
}
