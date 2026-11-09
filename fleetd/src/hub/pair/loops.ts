import type { Hub } from "../api/hub.ts";
import { sweep } from "../sweep/index.ts";
import { pairCodes } from "./codes.ts";

/**
 * Rust: pair::prune_on_sweep. On every sweep, drops spent device pairing codes and invites and spent worker enroll
 * codes, so neither table keeps every code ever minted.
 */
export function start(hub: Hub): void {
  sweep(hub).register({
    name: "spent-codes",
    run: () => {
      pairCodes(hub).prune();
      hub.auth.nodes.pruneEnrollTokens();
    },
  });
}
