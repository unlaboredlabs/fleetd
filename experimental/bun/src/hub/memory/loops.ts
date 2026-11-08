import type { Hub } from "../api/hub.ts";
import { registerLeadCalls } from "./calls.ts";
import { run as refreshLoop } from "./refresh.ts";

/**
 * Registers the memory lead calls (`remember`, `forget`, `memory_read`) and starts the nightly refresh (Rust:
 * memory::refresh::run, src/hub/memory/refresh.ts).
 */
export function start(hub: Hub): void {
  registerLeadCalls(hub);
  refreshLoop(hub);
}
