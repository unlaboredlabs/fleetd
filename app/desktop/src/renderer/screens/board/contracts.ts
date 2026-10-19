// The hub shapes the board reads, field for field as fleetd-contracts serialises them (live.rs, mcp.rs, train.rs,
// ledger.rs, node_link.rs, tasks.rs, playbooks.rs). A stand-in until E1's generated types land in
// src/shared/contracts: then this file becomes re-exports of those, with the same names.

export type Timestamp = string;

export interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

export interface ThreadRef {
  readonly machineId: string;
  readonly threadId: string;
}

export type AgentRole = "lead" | "implementer" | "reader" | "reviewer" | "verifier" | "qa";

export type LaneStatus =
  | "queued"
  | "starting"
  | "working"
  | "waiting"
  | "parked"
  | "stalled"
  | "idle"
  | "done"
  | "failed"
  | "cancelled";

export type Activity =
  | { readonly kind: "command"; readonly text: string }
  | { readonly kind: "edit"; readonly path: string }
  | { readonly kind: "read"; readonly path?: string; readonly pattern?: string }
  | { readonly kind: "tool"; readonly name: string; readonly detail?: string }
  | { readonly kind: "writing" }
  | { readonly kind: "thinking" }
  | { readonly kind: "compacting" }
  | { readonly kind: "retrying"; readonly attempt: number; readonly of: number; readonly reason: string };

export interface ActivityNow {
  readonly activity: Activity;
  readonly since: Timestamp;
}

export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly live: boolean;
}

/** fleetd_contracts::live::SPARK_BUCKET_SECS / SPARK_BUCKETS. */
export const SPARK_BUCKET_SECS = 2;
export const SPARK_BUCKETS = 30;

export interface Spark {
  readonly endAt: Timestamp;
  /** Work per bucket, oldest first, 0..=255. */
  readonly samples: readonly number[];
}

export interface LiveLane {
  readonly laneId: string;
  readonly status: LaneStatus;
  readonly activity?: ActivityNow;
  readonly tokens?: Tokens;
  readonly spark?: Spark;
}

export interface LiveText {
  readonly laneId: string;
  readonly messageId: string;
  readonly append: string;
}

export type MachineStatus = "online" | "offline" | "degraded";

export interface LoginLimit {
  readonly limitType: string;
  readonly utilization?: number;
  readonly resetsAt?: Timestamp;
  readonly status: string;
  readonly observedAt?: Timestamp;
}

export interface NodeLoad {
  readonly cpus: number;
  readonly load1: number;
  readonly memUsedPct?: number;
  readonly limits: readonly LoginLimit[];
}

export interface SleptSpan {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface MachineLive {
  readonly machineId: string;
  readonly name: string;
  readonly status: MachineStatus;
  readonly load?: NodeLoad;
  readonly running: number;
  readonly asOf: Timestamp;
  readonly slept?: SleptSpan;
}

export interface SlotState {
  readonly cap: number;
  readonly used: number;
  readonly queued: number;
  readonly reservedBand: number;
  readonly perProject: readonly { readonly projectRef: ProjectRef; readonly share: number; readonly used: number }[];
}

export interface LiveFrame {
  readonly at: Timestamp;
  readonly full: boolean;
  readonly lanes: readonly LiveLane[];
  readonly text?: readonly LiveText[];
  readonly machines?: readonly MachineLive[];
  readonly slots?: SlotState;
}

export type OrderPhase =
  | "waiting_on_you"
  | "failed"
  | "stopped"
  | "working"
  | "reviewing"
  | "merging"
  | "verifying"
  | "queued"
  | "planning"
  | "idle"
  | "done";

/** The board's sort order: the first match wins on the hub, and the board sorts by it. */
export const PHASE_ORDER: readonly OrderPhase[] = [
  "waiting_on_you",
  "failed",
  "stopped",
  "working",
  "reviewing",
  "merging",
  "verifying",
  "queued",
  "planning",
  "idle",
  "done",
];

export type ChangeState =
  | "queued"
  | "reviewing"
  | "ready"
  | "rebasing"
  | "ci"
  | "merging"
  | "merged"
  | "needs_rebase"
  | "ci_failed"
  | "refused"
  | "abandoned";

export interface PrRef {
  readonly changeId: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly state: ChangeState;
  readonly position?: number;
  readonly reviewsDone: number;
  readonly reviewsNeeded: number;
  readonly taskId?: string;
}

export interface Receipts {
  readonly commands: number;
  readonly commandsFailed: number;
  readonly filesChanged: number;
}

export type Effort = "low" | "medium" | "high" | "max";

export interface AgentLane {
  readonly laneId: string;
  readonly role: AgentRole;
  readonly taskId?: string;
  readonly threadRef?: ThreadRef;
  readonly title: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly status: LaneStatus;
  readonly statusReason?: string;
  readonly startedAt?: Timestamp;
  readonly endedAt?: Timestamp;
  readonly branch?: string;
  readonly pr?: PrRef;
  readonly receipts?: Receipts;
  readonly live?: LiveLane;
}

export type PlaybookName = "bugfix" | "feature" | "research" | "finish-all";

export interface OrderCard {
  readonly workstreamId: string;
  readonly projectRef: ProjectRef;
  readonly title: string;
  readonly state: string;
  readonly template?: PlaybookName;
  readonly phase: OrderPhase;
  readonly phaseDetail?: string;
  readonly next?: string;
  readonly needsYou: number;
  readonly settled: number;
  readonly total: number;
  readonly lanes: readonly AgentLane[];
  readonly prs: readonly PrRef[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface PrChip {
  readonly changeId: string;
  readonly number: number;
  readonly url: string;
  readonly workstreamId: string;
  readonly state: ChangeState;
  readonly position?: number;
}

export interface TrainLive {
  readonly repo: string;
  readonly frozen: boolean;
  readonly frozenReason?: string;
  readonly chips: readonly PrChip[];
  readonly mergedToday: number;
}

export interface OrdersBoardOutput {
  readonly orders: readonly OrderCard[];
  readonly trains: readonly TrainLive[];
  readonly at: Timestamp;
}

/** The fields of a ledger Ask the board reads. */
export interface AskSummary {
  readonly askId: string;
  readonly projectRef?: ProjectRef;
  readonly workstreamId?: string;
  readonly state: "open" | "auto" | "answered" | "defaulted" | "withdrawn";
  readonly text: string;
}

export type IntakeRef =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "order"; readonly workstreamId: string }
  | { readonly kind: "pr"; readonly url: string };

export interface IntakeEcho {
  readonly projectRef: ProjectRef;
  readonly template: PlaybookName;
  readonly reason: string;
}

export interface IntakeSubmitInput {
  readonly machineId?: string;
  readonly projectId?: string;
  readonly text: string;
  readonly template?: PlaybookName;
  readonly attachments?: readonly string[];
  readonly refs?: readonly IntakeRef[];
  readonly clientRequestId: string;
}

export interface IntakeSubmitOutput {
  readonly workstreamId?: string;
  readonly askId?: string;
  readonly echo?: IntakeEcho;
  readonly leadWaiting?: string;
}
