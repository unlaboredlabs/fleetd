import type { Hub } from "../api/hub.ts";

/** Starts this module's loops (Rust: github_app::sessions::run); each stops on `hub.shutdown`. Not ported yet. */
export function start(_hub: Hub): void {}
