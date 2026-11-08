// The leads area's start (crates/fleetd/src/hub/serve: the areas' lead calls, `wakes.start`, `prompts::start`).
import type { Hub } from "../api/hub.ts";
import { registerLeadCalls as artifactCalls } from "../artifacts/calls.ts";
import { registerLeadCalls as checklistCalls } from "../checklist/calls.ts";
import { start as promptsStart } from "../prompts/tools.ts";
import { wakes } from "../wakes/index.ts";

/**
 * Registers the lead calls of this area's modules that have no loops of their own (checklist, artifacts), starts the
 * hub's wake scheduler, and keeps this release's prompt texts (raising `prompt.default_changed` where an edit is
 * behind). The leads' own loops (Rust: leads.run) are not ported yet.
 */
export function start(hub: Hub): void {
  checklistCalls(hub);
  artifactCalls(hub);
  try {
    promptsStart(hub);
  } catch (error) {
    console.warn("prompts: start failed:", error);
  }
  wakes(hub).start();
}
