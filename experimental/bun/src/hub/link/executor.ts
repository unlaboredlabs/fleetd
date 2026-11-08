// The link's seam with the hub's executor (crates/fleetd/src/hub/executor `attach`, `detach_link`, `handle_frame`):
// each welcomed link's sessions go to it, and the session-side frames a node sends.
import type { Hub } from "../api/hub.ts";
import type { HubFrame, NodeFrame } from "../../shared/node_link.ts";

/** What the executor holds of one link: its id, and how to send on it. */
export type NodeSessions = { linkId: number; send: (frame: HubFrame) => boolean };

export type Executors = {
  attach(machineId: string, sessions: NodeSessions): unknown;
  detachLink(machineId: string, linkId: number): unknown;
  handleFrame(machineId: string, frame: NodeFrame): unknown;
};

/** The frames the executor reads: replies to its session calls, and each machine's and thread's stream. */
export const SESSION_FRAMES: ReadonlySet<string> = new Set(["session_reply", "machine_event", "thread_event", "clone_progress"]);

// TODO(hub-core): import `executors` from "../executor/index.ts" once hub-work's executor is on main; until then it
// is resolved at runtime, so the link runs (and its tests pass) without it.
const EXECUTOR_MODULE = "../executor/index.ts";
let resolved: ((hub: Hub) => Executors) | null | undefined;
const loading = import(EXECUTOR_MODULE).then(
  (m: { executors?: (hub: Hub) => Executors }) => {
    resolved = m.executors ?? null;
  },
  () => {
    resolved = null;
  },
);

/** The hub's executor, once its module loaded; undefined without one. */
export function executorsOf(hub: Hub): Executors | undefined {
  return resolved ? resolved(hub) : undefined;
}

/** Resolves once the executor's module was looked for. */
export const executorReady = () => loading;
