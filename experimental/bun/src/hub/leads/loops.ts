// The leads area's start (crates/fleetd/src/hub/serve: the areas' lead calls, `wakes.start`, `prompts::start`).
import type { Hub } from "../api/hub.ts";
import { registerLeadCalls as artifactCalls } from "../artifacts/calls.ts";
import { registerLeadCalls as checklistCalls } from "../checklist/calls.ts";
import { registerLeadCalls as skillCalls } from "../skills/calls.ts";
import { ran } from "../skills/versions.ts";
import { executors } from "../executor/index.ts";
import { start as promptsStart } from "../prompts/tools.ts";
import { wakes } from "../wakes/index.ts";

/**
 * Registers the lead calls of this area's modules that have no loops of their own (checklist, artifacts, skills), keeps the skills' uses, starts the
 * hub's wake scheduler, and keeps this release's prompt texts (raising `prompt.default_changed` where an edit is
 * behind). The leads' own loops (Rust: leads.run) are not ported yet.
 */
export function start(hub: Hub): void {
  checklistCalls(hub);
  artifactCalls(hub);
  skillCalls(hub);
  // Every Skill call a session the hub follows finishes counts as its project's last use of it.
  executors(hub).sinks.skill = (thread, skill) => {
    try {
      ran(hub.db, thread, skill, hub.clock.now());
    } catch (error) {
      console.warn("skills: a use not kept:", error);
    }
  };
  try {
    promptsStart(hub);
  } catch (error) {
    console.warn("prompts: start failed:", error);
  }
  wakes(hub).start();
}
