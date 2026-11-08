import type { Hub } from "../api/hub.ts";

/** Starts this module's loops (Rust: browser::run_end_outlived, browser::run_prune, browser::thumbs::run); each stops on `hub.shutdown`. Not ported yet. */
export function start(_hub: Hub): void {}
