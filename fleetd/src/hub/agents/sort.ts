// agents_list's order and its rows, with no stores behind them (index.ts reads the agents).
import type { AgentLane, AgentRow, LaneStatus, ProjectRef, Task } from "../../shared/contracts.ts";
import { jsPrefix } from "../../shared/text.ts";

/** Tasks read per state: far above what a fleet runs at once. */
export const TASK_SCAN = 500;
/** Finished tasks read per end state for `endedSince`. */
export const ENDED_SCAN = 100;
export const AGENTS_MAX = 100;

/** Where a status sits in the list: agents doing something first, then those waiting their turn, then the rest. */
function rank(status: LaneStatus): number {
  switch (status) {
    case "waiting":
      return 0;
    case "working":
    case "starting":
      return 1;
    case "stalled":
      return 2;
    case "queued":
    case "parked":
      return 3;
    case "idle":
      return 4;
    case "failed":
      return 5;
    default:
      return 6;
  }
}

/** Options compare as Rust's: absent before present. */
const cmpOpt = (a: string | undefined, b: string | undefined) =>
  a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;

/** Waiting on a person first, then working, then by most recent start; finished agents by most recent end. */
export function sortRows(rows: AgentRow[]): void {
  rows.sort((a, b) => rank(a.status) - rank(b.status) || cmpOpt(b.endedAt, a.endedAt) || cmpOpt(b.startedAt, a.startedAt) || (a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0));
}

export const row = (lane: AgentLane, project: ProjectRef, title: string, task: Task | undefined): AgentRow =>
  ({ ...lane, projectRef: project, projectTitle: jsPrefix(title, 200), ...(task ? { workstreamId: task.workstreamId } : {}) }) as AgentRow;
