// A lead's state, read off its thread (crates/fleetd/src/hub/leads/lead.rs `lead_state`).
import type { LeadState, ThreadSummary } from "../../shared/contracts.ts";

/** The lead's state as the shell stream last reported its thread; stopped once the project was removed. */
export function leadState(thread: ThreadSummary | undefined, projectGone: boolean): LeadState {
  if (projectGone) return "stopped";
  if (!thread) return "starting";
  switch (thread.status) {
    case "running":
      return "working";
    case "waiting":
    case "failed":
      return "stalled";
    default:
      return "idle";
  }
}
