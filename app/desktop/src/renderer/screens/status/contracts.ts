// The status doc as the hub sends it (crates/fleetd-contracts/src/status.rs, mcp.rs status_*). These mirror the Rust
// serde shapes field for field until E1's generated types land; then this file re-exports those under the same names.
//
// The progress-model fields (PR #169, feat/progress-model) are optional: a hub without them renders as before.
// No time estimates in the product (notes/no-time-product-brief.md): the hub's ETA fields (`eta`, part and row
// ETAs, overdue minutes) are deliberately absent here, so nothing in the view can read them. Measured ages are fine.
// Wire enums are open (`Open<…>`): a value this build doesn't know renders a generic fallback, never breaks.

export type Timestamp = string;
/** A known wire enum, plus any value a newer hub may send. */
export type Open<T extends string> = T | (string & Record<never, never>);

export type StatusScope =
  | { readonly kind: "fleet" }
  | { readonly kind: "project"; readonly projectRef: { readonly machineId: string; readonly projectId: string } }
  | { readonly kind: "order"; readonly workstreamId: string };

export interface StaleMark {
  readonly since: Timestamp;
  readonly reason: string;
}

export interface StaleSource extends StaleMark {
  /** `machine:<m>`, `usage:<m>`, `ci:<repo>`, `github:<repo>`, `train:<repo>`, `webhook:<repo>`. */
  readonly source: string;
}

export interface Marker {
  readonly at: Timestamp;
  readonly text: string;
  readonly pctBefore?: number;
  readonly pctAfter?: number;
  readonly deltaItems: number;
}

export type DropReason = Open<"scope_change" | "review_failed" | "ci_failed" | "reopened">;

export interface ProgressPoint {
  readonly at: Timestamp;
  readonly pct: number;
  readonly verifiedPct: number;
  /** Set where the estimate fell; it never falls without one. */
  readonly drop?: { readonly reason: DropReason; readonly fromPct: number; readonly text: string };
}

export interface PlanningState {
  /** The lead is still planning: no plan items yet. */
  readonly active: boolean;
  /** Elapsed over the usual planning time, ≤90 while active, 100 once the plan exists. */
  readonly pct: number;
  /** Planning's share of the order's work, fixed when the plan appears. */
  readonly sharePct: number;
  readonly since: Timestamp;
}

/** The headline estimate: solid = verified, lighter = credit for observed stages of work in flight. */
export interface ProgressEstimate {
  readonly pct: number;
  readonly verifiedPct: number;
  readonly inFlightPct: number;
  readonly planning?: PlanningState;
  readonly weights: Open<"project" | "fleet" | "default">;
  /** The doc's own scope only, oldest first, ≤96 points. */
  readonly series?: readonly ProgressPoint[];
}

export interface Progress {
  readonly pct: number;
  readonly polishPct?: number;
  readonly done: number;
  readonly total: number;
  readonly polishDone: number;
  readonly polishTotal: number;
  readonly asOf: Timestamp;
  readonly marker?: Marker;
  readonly stale?: StaleMark;
  readonly estimate?: ProgressEstimate;
}

export interface Gate {
  readonly kind: Open<"plan" | "live" | "phase">;
  readonly label: string;
  readonly serial: boolean;
  readonly since?: Timestamp;
  readonly itemId?: string;
  readonly workstreamId?: string;
}

export interface Headline {
  readonly text: string;
  readonly source: Open<"generated" | "template">;
  readonly reason?: string;
  readonly promptRef?: string;
  readonly at: Timestamp;
}

export interface Since {
  readonly seenAt?: Timestamp;
  readonly seenSeq?: number;
  readonly pruned?: boolean;
  readonly merged: number;
  readonly verified: number;
  readonly started: number;
  readonly failed: number;
  readonly asked: number;
  readonly scopeItems: number;
}

export interface DoneRow {
  readonly itemId?: string;
  readonly workstreamId?: string;
  readonly title: string;
  readonly doneAt: Timestamp;
  readonly evidence: string;
}

export interface StatusSteer {
  readonly id: string;
  readonly text: string;
  readonly stage: Open<"queued" | "delivered" | "acknowledged" | "unacknowledged" | "withdrawn" | "failed" | "expired">;
  readonly at: Timestamp;
  readonly planChange?: string;
}

export interface InProgressRow {
  readonly itemId?: string;
  readonly workstreamId: string;
  readonly title: string;
  readonly taskIds: readonly string[];
  readonly changeIds: readonly string[];
  readonly gate?: string;
  readonly stale?: StaleMark;
  readonly steers?: readonly StatusSteer[];
  readonly stage?: ItemStage;
  readonly creditPct?: number;
  /** Past 1.5× the usual time for its stage (also a Risk). */
  readonly slowerThanUsual?: boolean;
  /** What it still waits on, in order: "review of #12", "CI on #12", "merge", "done-when checks". */
  readonly waitingOn?: readonly string[];
  /** Open plan items that wait on it. */
  readonly blocking?: readonly string[];
  /** The scope's critical path runs through it. */
  readonly critical?: boolean;
}

export type ItemStage = Open<
  | "planned"
  | "brief_frozen"
  | "task_started"
  | "first_push"
  | "pr_open"
  | "review_passed"
  | "ci_green"
  | "merged"
  | "verified"
>;

export interface NextRow {
  readonly itemId: string;
  readonly workstreamId?: string;
  readonly title: string;
  readonly after: readonly string[];
}

export type RiskRule = Open<
  | "ci_red_main"
  | "machine_offline"
  | "blocked_on_you"
  | "slipping"
  | "estimate_drift"
  | "riskiest_item"
  | "ci_red_repeat"
  | "machine_flaky"
  | "usage_high"
  | "slots_full"
  | "github_drift"
  | "no_plan"
  | "steer_unacknowledged"
  | "slower_than_usual"
>;

export interface Risk {
  readonly rule: RiskRule;
  readonly level: Open<"warning" | "danger">;
  readonly message: string;
}

export type CiState = Open<"green" | "red" | "pending" | "unknown">;

export interface HealthCi {
  readonly repo: string;
  readonly state: CiState;
  readonly sha?: string;
  readonly failing: readonly string[];
  readonly since?: Timestamp;
  readonly asOf?: Timestamp;
  readonly stale?: StaleMark;
}

export interface HealthMachine {
  readonly machineId: string;
  readonly status: Open<"online" | "offline" | "degraded">;
  readonly lastSeenAt?: Timestamp;
  readonly slept?: { readonly fromMs: number; readonly toMs: number };
  readonly dropsToday: number;
  readonly stale?: StaleMark;
}

export interface HealthUsage {
  readonly limitType: string;
  readonly machineId: string;
  readonly utilization?: number;
  readonly resetsAt?: Timestamp;
  readonly status: string;
  readonly observedAt?: Timestamp;
  readonly stale?: StaleMark;
}

export interface Health {
  readonly ci: readonly HealthCi[];
  readonly machines: readonly HealthMachine[];
  readonly usage: readonly HealthUsage[];
  readonly slots: { readonly running: number; readonly used: number; readonly cap: number; readonly queued: number };
}

export interface ScopePart {
  readonly title: string;
  readonly scope?: StatusScope;
  readonly milestoneId?: string;
  readonly progress: Progress;
}

export interface MoreCounts {
  readonly done: number;
  readonly inProgress: number;
  readonly next: number;
  readonly risks: number;
  readonly parts: number;
  readonly stale: number;
}

export interface StatusDoc {
  readonly scope: StatusScope;
  readonly title: string;
  readonly version: number;
  readonly seq: number;
  readonly now: Timestamp;
  readonly progress: Progress;
  readonly markers: readonly Marker[];
  readonly gates: readonly Gate[];
  readonly headline: Headline;
  readonly since: Since;
  readonly parts: readonly ScopePart[];
  readonly done: readonly DoneRow[];
  readonly inProgress: readonly InProgressRow[];
  readonly next: readonly NextRow[];
  readonly needsYou: { readonly count: number; readonly askIds: readonly string[] };
  readonly risks: readonly Risk[];
  readonly health: Health;
  readonly stale: readonly StaleSource[];
  readonly more: MoreCounts;
  readonly virtualTier?: Open<"S" | "M" | "L">;

}

export interface StatusGetOutput {
  readonly doc: StatusDoc;
}

/** `doc` once its version passed `after`; otherwise `unchanged` with the current version. */
export interface StatusWaitOutput {
  readonly doc?: StatusDoc;
  readonly unchanged?: boolean;
  readonly version: number;
}

export const scopeKey = (scope: StatusScope): string => {
  switch (scope.kind) {
    case "fleet":
      return "fleet";
    case "project":
      return `project:${scope.projectRef.machineId}/${scope.projectRef.projectId}`;
    case "order":
      return `order:${scope.workstreamId}`;
  }
};

// The renderer never trusts a call's output blindly: these check the few fields the view's logic branches on, so a
// shape mismatch shows as a failed answer (with Retry) rather than a crash mid-render.
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export const asDoc = (v: unknown): StatusDoc | undefined =>
  isRecord(v) &&
  isRecord(v.scope) &&
  typeof v.version === "number" &&
  typeof v.seq === "number" &&
  typeof v.now === "string" &&
  isRecord(v.progress) &&
  isRecord(v.headline) &&
  isRecord(v.health) &&
  Array.isArray(v.stale)
    ? (v as unknown as StatusDoc)
    : undefined;

export const asGetOutput = (v: unknown): StatusGetOutput | undefined => {
  const doc = isRecord(v) ? asDoc(v.doc) : undefined;
  return doc ? { doc } : undefined;
};

export const asWaitOutput = (v: unknown): StatusWaitOutput | undefined => {
  if (!isRecord(v) || typeof v.version !== "number") return undefined;
  if (v.doc === undefined || v.doc === null) return { unchanged: true, version: v.version };
  const doc = asDoc(v.doc);
  return doc ? { doc, version: v.version } : undefined;
};
