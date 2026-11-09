import type { Hub } from "../api/hub.ts";
import { trainArea } from "../train/index.ts";

/** Starts this module's loops (Rust: reviews.start): the gate follows verdicts and review tasks ending. */
export function start(hub: Hub): void {
  trainArea(hub).reviews.start();
}
