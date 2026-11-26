// Share links' loop: ended links' rows go a week after they end. Also registers the agents' `share_port` lead call.
import type { Hub } from "../api/hub.ts";
import { shareLinks } from "./store.ts";
import { registerLeadCalls } from "./tools.ts";

const PRUNE_EVERY_MS = 3600_000;

export function start(hub: Hub): void {
  registerLeadCalls(hub);
  const timer = setInterval(() => {
    try {
      shareLinks(hub).prune();
    } catch (error) {
      console.warn("share links not pruned:", error);
    }
  }, PRUNE_EVERY_MS);
  hub.shutdown.signal.addEventListener("abort", () => clearInterval(timer));
}
