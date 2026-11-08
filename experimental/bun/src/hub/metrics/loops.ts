import type { Hub } from "../api/hub.ts";
import { every } from "../sweep/index.ts";
import { run } from "./project.ts";
import { prune } from "./store.ts";

const PRUNE_EVERY_MS = 3_600_000;

/**
 * Starts this module's loops (Rust: metrics::start): the projector, and the hourly prune of landed changes and touches
 * past the retention, in batches. The host sweep is not ported yet. Each stops on `hub.shutdown`.
 */
export function start(hub: Hub): void {
  run(hub);
  every(hub, PRUNE_EVERY_MS, async () => {
    while (hub.db.transaction((c) => prune(c, hub.clock.now()))) await Bun.sleep(0);
  });
}
