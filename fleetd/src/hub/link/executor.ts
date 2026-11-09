// The link's seam with the hub's executor (`detach_link`, `handle_frame`):
// each welcomed link's sessions go to it, and the session-side frames a node sends.
import type { Hub } from "../api/hub.ts";
import { type Executors, executors } from "../executor/index.ts";

/** The frames the executor reads: replies to its session calls, and each machine's and thread's stream. */
export const SESSION_FRAMES: ReadonlySet<string> = new Set(["session_reply", "machine_event", "thread_event", "clone_progress"]);

/** The hub's executor. */
export const executorsOf = (hub: Hub): Executors => executors(hub);
