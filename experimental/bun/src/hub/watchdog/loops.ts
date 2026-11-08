import type { Hub } from "../api/hub.ts";

/** Starts this module's loops (Rust: watchdog.start); each stops on `hub.shutdown`. Not ported yet. */
export function start(_hub: Hub): void {}
