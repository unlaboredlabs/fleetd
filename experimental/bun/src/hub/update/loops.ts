import type { Hub } from "../api/hub.ts";

/** Starts this module's loops (Rust: updates.prefetch_loop, updates.resume); each stops on `hub.shutdown`. Not ported yet. */
export function start(_hub: Hub): void {}
