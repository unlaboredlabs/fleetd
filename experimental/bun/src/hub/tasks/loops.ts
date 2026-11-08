import type { Hub } from "../api/hub.ts";

/** Starts this module's loops (Rust: tasks.run, tasks::ci_wait::run, tasks::worktrees::run); each stops on `hub.shutdown`. Not ported yet. */
export function start(_hub: Hub): void {}
