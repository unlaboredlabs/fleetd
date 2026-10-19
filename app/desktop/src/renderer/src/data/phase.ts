// An order's phase, recomputed in the app from live state: the hub's rules (crates/fleetd/src/hub/orders/phase.rs),
// fed with the asks open NOW and the lanes' live statuses instead of the counts the board cached when it was
// fetched. A cached `needsYou` once kept a card on "needs you" after its question was answered.
import type { AgentRole, ChangeState, LaneStatus, OrderPhase, WorkstreamState } from "../../../shared/contracts";

export interface PhaseLane {
  readonly role: AgentRole;
  readonly status: LaneStatus;
  readonly statusReason?: string | undefined;
}

export interface PhaseInput {
  readonly state: WorkstreamState;
  readonly headline?: string | undefined;
  readonly openAsks: number;
  /** Every lane of the order, finished ones included (they only count as "has tasks"). */
  readonly lanes: readonly PhaseLane[];
  readonly hasTasks: boolean;
  readonly prs: readonly { readonly state: ChangeState; readonly number: number }[];
  readonly leadWorking: boolean;
}

export interface Phase {
  readonly phase: OrderPhase;
  readonly detail?: string | undefined;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const implementing = (role: AgentRole): boolean => role === "implementer" || role === "reader";
const active = (status: LaneStatus): boolean => status === "starting" || status === "working";
export const settled = (status: LaneStatus): boolean =>
  status === "done" || status === "failed" || status === "cancelled";

export const orderPhase = (i: PhaseInput): Phase => {
  const waiting = i.lanes.filter((l) => l.status === "waiting").length;
  if (i.openAsks > 0 || waiting > 0) {
    const detail = i.openAsks > 0 ? plural(i.openAsks, "question", "questions") : plural(waiting, "approval", "approvals");
    return { phase: "waiting_on_you", detail };
  }
  switch (i.state) {
    case "failed":
      return { phase: "failed", detail: i.headline };
    case "stopped":
      return { phase: "stopped" };
    case "done": {
      const merged = i.prs.filter((p) => p.state === "merged").length;
      return { phase: "done", detail: merged > 0 ? plural(merged, "PR merged", "PRs merged") : undefined };
    }
    default:
      break;
  }
  const working = i.lanes.filter((l) => implementing(l.role) && active(l.status)).length;
  if (working > 0) return { phase: "working", detail: `${working} working` };
  const reviewingPr = i.prs.find((p) => p.state === "reviewing");
  const reviewingLanes = i.lanes.filter((l) => !implementing(l.role) && l.role !== "lead" && active(l.status)).length;
  if (reviewingPr !== undefined || reviewingLanes > 0) {
    const detail = reviewingPr === undefined ? `${reviewingLanes} reviewing` : `reviewing #${reviewingPr.number}`;
    return { phase: "reviewing", detail };
  }
  const merging = i.prs.find((p) => ["ready", "rebasing", "ci", "merging"].includes(p.state));
  if (merging !== undefined) {
    const n = merging.number;
    const detail =
      merging.state === "ready"
        ? `#${n} ready to merge`
        : merging.state === "rebasing"
          ? `rebasing #${n}`
          : merging.state === "ci"
            ? `#${n} in CI`
            : `merging #${n}`;
    return { phase: "merging", detail };
  }
  if (i.state === "verifying") return { phase: "verifying", detail: "checking done-when" };
  const live = i.lanes.filter((l) => !settled(l.status) && l.status !== "idle");
  if (live.length > 0 && live.every((l) => l.status === "queued")) {
    const why = live.find((l) => l.statusReason !== undefined)?.statusReason;
    return { phase: "queued", detail: why === undefined ? "queued" : `queued: ${why}` };
  }
  if (i.state === "draft" || (!i.hasTasks && i.leadWorking)) return { phase: "planning" };
  return { phase: "idle", detail: "waiting for the lead" };
};

/** The board's order: phase first (in OrderPhase's declared order), then the most recently updated. */
export const PHASE_RANK: Readonly<Record<OrderPhase, number>> = {
  waiting_on_you: 0,
  failed: 1,
  stopped: 2,
  working: 3,
  reviewing: 4,
  merging: 5,
  verifying: 6,
  queued: 7,
  planning: 8,
  idle: 9,
  done: 10,
};
