import type { Hub } from "../api/hub.ts";
import { statusInputs } from "../status/rows.ts";
import { every } from "../sweep/index.ts";
import { systemGh } from "../train/gh.ts";
import { GitHubSource } from "./github.ts";
import { weeks } from "./index.ts";
import { catchUp, run } from "./project.ts";
import type { HostSources } from "./source.ts";
import { prune } from "./store.ts";
import { run as runSweep, sweepArea } from "./sweep.ts";

const PRUNE_EVERY_MS = 3_600_000;

/** The shipped hub's sources: GitHub through the hub's `gh`, under its login (source/mod.rs `HostSources::real`). */
export const realSources = (): HostSources => ({ github: new GitHubSource(systemGh) });

/**
 * Starts this module's loops (Rust: metrics::start): the projector, the host sweep over `sources` (the hub's `gh` on a
 * shipped hub; a test passes none or fakes), and the hourly prune of landed changes and touches past the retention, in
 * batches. Each stops on `hub.shutdown`. It also gives the status rows their 7-day merges, caught up first so they
 * count the merge whose event the read may be answering (rows.rs).
 */
export function start(hub: Hub, sources: HostSources = realSources()): void {
  run(hub);
  statusInputs(hub).weeks = (now, tz) => {
    try {
      catchUp(hub);
    } catch (error) {
      console.warn("status: metrics not caught up:", error);
    }
    return weeks(hub.db.conn, now, tz);
  };
  sweepArea(hub).sources = sources;
  void runSweep(hub);
  every(hub, PRUNE_EVERY_MS, async () => {
    while (hub.db.transaction((c) => prune(c, hub.clock.now()))) await Bun.sleep(0);
  });
}
