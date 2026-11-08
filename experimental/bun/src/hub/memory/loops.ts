import type { Hub } from "../api/hub.ts";
import { registerLeadCalls } from "./calls.ts";

/**
 * Registers the memory lead calls (`remember`, `forget`, `memory_read`). The nightly refresh (Rust:
 * memory::refresh::run) is not ported yet.
 */
export function start(hub: Hub): void {
  registerLeadCalls(hub);
}
