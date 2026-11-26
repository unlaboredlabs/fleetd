// The Usage page's loops: the counts table folded each minute (a year of history in batches at the first start), and
// pruned past KEEP_DAYS each hour. Each stops on `hub.shutdown`.
import type { Hub } from "../api/hub.ts";
import { every } from "../sweep/index.ts";
import { fold, prune } from "./fold.ts";

const FOLD_EVERY_MS = 60_000;
const PRUNE_EVERY_MS = 3_600_000;

export function start(hub: Hub): void {
  // What came before this start folds at once, a batch at a time between the hub's other work.
  setTimeout(() => {
    void (async () => {
      try {
        while (!hub.shutdown.signal.aborted && hub.db.transaction((c) => fold(c))) await Bun.sleep(0);
      } catch (error) {
        console.warn("usage: fold failed:", error);
      }
    })();
  }, 0);
  every(hub, FOLD_EVERY_MS, async () => {
    while (hub.db.transaction((c) => fold(c))) await Bun.sleep(0);
  });
  every(hub, PRUNE_EVERY_MS, () => {
    hub.db.transaction((c) => prune(c, hub.clock.now()));
  });
}
