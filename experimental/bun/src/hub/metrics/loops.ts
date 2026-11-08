import type { Hub } from "../api/hub.ts";
import { every } from "../sweep/index.ts";
import { realSources } from "./github.ts";
import { run } from "./project.ts";
import type { HostSources } from "./source.ts";
import { prune } from "./store.ts";
import { run as runSweep, sweepArea } from "./sweep.ts";

const PRUNE_EVERY_MS = 3_600_000;

/**
 * Starts this module's loops (Rust: metrics::start): the projector, the host sweep over `sources` (the hub's `gh` on a
 * shipped hub; a test passes none or fakes), and the hourly prune of landed changes and touches past the retention, in
 * batches. Each stops on `hub.shutdown`.
 */
export function start(hub: Hub, sources: HostSources = realSources()): void {
  run(hub);
  sweepArea(hub).sources = sources;
  void runSweep(hub);
  every(hub, PRUNE_EVERY_MS, async () => {
    while (hub.db.transaction((c) => prune(c, hub.clock.now()))) await Bun.sleep(0);
  });
}
