// Pure rules of the orders board (crates/fleetd/src/hub/orders/phase.rs): an order's phase (first match wins, worst
// child rolls up), a lane's status and role, and the board's order.
import type { AgentRole, ChangeState, LaneStatus, LeadState, OrderCard, OrderPhase, Task, TaskKind, WorkstreamState } from "../../shared/contracts.ts";

/** One PR of the order, as the phase reads it. */
export type PrState = { state: ChangeState; number: number };

export type PhaseInput = {
  state: WorkstreamState;
  /** Open with no brief yet. */
  draft: boolean;
  openRequests: number;
  lanes: [AgentRole, LaneStatus, string | undefined][];
  prs: PrState[];
  leadWorking: boolean;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const implementing = (role: AgentRole) => role === "implementer" || role === "reader";
const active = (status: LaneStatus) => status === "starting" || status === "working";

export const settled = (status: LaneStatus) => status === "done" || status === "failed" || status === "cancelled";

/** The order's phase and its chip detail ("3 working", "#212 in CI", "1 request"). */
export function phase(i: PhaseInput): [OrderPhase, string | undefined] {
  const waiting = i.lanes.filter(([, s]) => s === "waiting").length;
  if (i.openRequests > 0 || waiting > 0) {
    return ["waiting_on_you", i.openRequests > 0 ? plural(i.openRequests, "request", "requests") : plural(waiting, "approval", "approvals")];
  }
  if (i.state === "stopped") return ["stopped", undefined];
  if (i.state === "done") {
    const merged = i.prs.filter((p) => p.state === "merged").length;
    return ["done", merged > 0 ? plural(merged, "PR merged", "PRs merged") : undefined];
  }
  const working = i.lanes.filter(([r, s]) => implementing(r) && active(s)).length;
  if (working > 0) return ["working", `${working} working`];
  const reviewingPr = i.prs.find((p) => p.state === "reviewing");
  const reviewingLanes = i.lanes.filter(([r, s]) => !implementing(r) && r !== "lead" && active(s)).length;
  if (reviewingPr || reviewingLanes > 0) {
    return ["reviewing", reviewingPr ? `reviewing #${reviewingPr.number}` : `${reviewingLanes} reviewing`];
  }
  const merging = i.prs.find((p) => p.state === "ready" || p.state === "rebasing" || p.state === "ci" || p.state === "merging");
  if (merging) {
    const detail =
      merging.state === "ready"
        ? `#${merging.number} ready to merge`
        : merging.state === "rebasing"
          ? `rebasing #${merging.number}`
          : merging.state === "ci"
            ? `#${merging.number} in CI`
            : `merging #${merging.number}`;
    return ["merging", detail];
  }
  const live = i.lanes.filter(([, s]) => !settled(s) && s !== "idle");
  if (live.length > 0 && live.every(([, s]) => s === "queued")) {
    const why = live.find(([, , w]) => w !== undefined)?.[2];
    return ["queued", why !== undefined ? `queued: ${why}` : "queued"];
  }
  const tasks = i.lanes.some(([r]) => r !== "lead");
  if (i.draft || (!tasks && i.leadWorking)) return ["planning", undefined];
  return ["idle", "waiting for the lead"];
}

/** A task's lane status from its record and its thread's status as the hub last saw it. */
export function taskLaneStatus(task: Task, threadStatus: string | undefined): LaneStatus {
  switch (task.state) {
    case "queued":
      return "queued";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "idle":
      return task.parked ? "parked" : "idle";
    case "running":
      if (task.parked) return "parked";
      if (!task.threadRef) return "starting";
      switch (threadStatus) {
        case "waiting":
          return "waiting";
        case "running":
          return "working";
        case "idle":
        case "completed":
          return "idle";
        case "failed":
        case "interrupted":
          return "stalled";
        default:
          return "starting";
      }
  }
  return "starting";
}

export function leadLaneStatus(state: LeadState, parked: boolean, threadStatus: string | undefined): LaneStatus {
  if (parked) return "parked";
  switch (state) {
    case "starting":
      return "starting";
    case "stalled":
      return "stalled";
    case "stopped":
      return "cancelled";
    default:
      if (threadStatus === "waiting") return "waiting";
      if (threadStatus === "running" || state === "working") return "working";
      return "idle";
  }
}

/** A task's role: write tasks implement, read tasks read; review tasks are QA runs when spawned with `--qa`. */
export function role(kind: TaskKind, qa: boolean): AgentRole {
  if (kind === "write") return "implementer";
  if (kind === "read") return "reader";
  return qa ? "qa" : "reviewer";
}

/** OrderPhase's order in the Rust enum, which the board sorts by. */
const PHASE_RANK: Record<string, number> = {
  waiting_on_you: 0,
  stopped: 1,
  working: 2,
  reviewing: 3,
  merging: 4,
  queued: 5,
  planning: 6,
  idle: 7,
  done: 8,
};

/**
 * Board order: phase first, then by update time. Rust's comparator says "most recently updated" but compares
 * `(a.phase, Reverse(b.updated))` with `(b.phase, Reverse(a.updated))`, two reversals, so within a phase the oldest
 * update comes first; this keeps what it does, so both hubs answer alike.
 */
export function sortCards(cards: OrderCard[]): void {
  cards.sort(
    (a, b) =>
      (PHASE_RANK[a.phase] ?? 99) - (PHASE_RANK[b.phase] ?? 99) ||
      (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) ||
      (a.workstreamId < b.workstreamId ? -1 : a.workstreamId > b.workstreamId ? 1 : 0),
  );
}
