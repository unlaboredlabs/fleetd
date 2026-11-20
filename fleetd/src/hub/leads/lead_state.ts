// A lead's state, read off its thread.
import type { LeadState, ThreadSummary } from "../../shared/contracts.ts";

/**
 * The lead's state as the shell stream last reported its thread; stopped once the project was removed, or once its
 * node no longer has the thread (stale: the node lost it, as when its host was rebuilt).
 */
export function leadState(thread: ThreadSummary | undefined, projectGone: boolean): LeadState {
  if (projectGone) return "stopped";
  if (!thread) return "starting";
  if (thread.stale) return "stopped";
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
