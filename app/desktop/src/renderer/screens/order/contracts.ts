// STOPGAP until E1's generated contract types land (src/shared/contracts/): the shapes the order view reads,
// copied field for field from crates/fleetd-contracts (serde camelCase). Swap the imports for the generated types and
// delete this file; nothing here may hold a field the Rust side doesn't have.

export type Timestamp = string;

export interface ThreadRef {
  readonly machineId: string;
  readonly threadId: string;
}

// steer.rs
export type SteerMode = "queue" | "now";
export type SteerTarget = { readonly workstreamId: string } | { readonly taskId: string };
export type SteerStage = "queued" | "delivered" | "acknowledged" | "unacknowledged" | "withdrawn" | "failed" | "expired";
export type DeliveredHow = "turn" | "boundary" | "stopped" | "joined";
export type SteerBy = { readonly kind: "human"; readonly keyName: string } | { readonly kind: "lead" };

export interface Steer {
  readonly id: string;
  readonly target: SteerTarget;
  readonly workstreamId: string;
  readonly thread: ThreadRef;
  readonly runId: string;
  readonly by: SteerBy;
  readonly mode: SteerMode;
  readonly text: string;
  readonly stage: SteerStage;
  readonly queuedAt: Timestamp;
  readonly deliveredAt?: Timestamp;
  readonly how?: DeliveredHow;
  readonly stoppedTool?: string;
  readonly seenAt?: Timestamp;
  readonly ackedAt?: Timestamp;
  readonly ackExcerpt?: string;
  readonly planChange?: string;
  readonly detail?: string;
}

// mcp.rs (thread_tail) and model.rs (ActionItem)
export type TailRole = "user" | "assistant" | "system";
export type ActionKind = "command" | "file_change" | "tool_call" | "other";
export interface ActionItem {
  readonly at: Timestamp;
  readonly kind: ActionKind;
  readonly status: "completed" | "failed" | "running";
  readonly summary: string;
  readonly outputTail?: string;
  readonly exitCode?: number;
  readonly failed: boolean;
}
export type TailItem =
  | { readonly kind: "message"; readonly at: Timestamp; readonly role: TailRole; readonly text: string }
  | { readonly kind: "action"; readonly at: Timestamp; readonly action: ActionItem };

// live.rs
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
export interface LiveLane {
  readonly laneId: string;
  readonly status: LaneStatus;
  readonly activity?: { readonly activity: Activity; readonly since: Timestamp };
}
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
export interface AgentLane {
  readonly laneId: string;
  readonly role: AgentRole;
  readonly taskId?: string;
  readonly threadRef?: ThreadRef;
  readonly title: string;
  readonly model?: string;
  readonly effort?: string;
  readonly status: LaneStatus;
  readonly statusReason?: string;
  readonly startedAt?: Timestamp;
  readonly endedAt?: Timestamp;
  readonly branch?: string;
  readonly pr?: PrRef;
  readonly live?: LiveLane;
}
export interface LiveText {
  readonly laneId: string;
  readonly messageId: string;
  readonly append: string;
}

// ledger.rs CheckSpec, verification.rs CheckResult / Claim
export type CheckSpec =
  | { readonly type: "pr_merged"; readonly repo: string; readonly pr?: number }
  | { readonly type: "ci_green"; readonly repo: string; readonly ref?: string }
  | { readonly type: "http"; readonly url: string; readonly status: number; readonly contains?: string }
  | { readonly type: "cmd"; readonly machineId: string; readonly argv: readonly string[]; readonly expectExit: number }
  | { readonly type: "test"; readonly repo: string; readonly testId: string }
  | { readonly type: "judge"; readonly criteria: string }
  | { readonly type: "human"; readonly question: string };
export type CheckOutcome = "pass" | "fail" | "error";
export interface CheckResult {
  readonly checkIndex: number;
  readonly spec: CheckSpec;
  readonly result: CheckOutcome;
  readonly evidence: string;
  readonly exitCode?: number;
  readonly ranBy: "hub" | "node" | "judge" | "human";
  readonly at: Timestamp;
}
export interface Claim {
  readonly claimId: string;
  readonly workstreamId: string;
  readonly by: string;
  readonly at: Timestamp;
  readonly results: readonly CheckResult[];
  readonly outcome: "pass" | "fail";
}

// events.rs
export interface HubEvent {
  readonly seq: number;
  readonly at: Timestamp;
  readonly type: string;
  readonly summary: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

// prompts.rs
export type PromptScope = "default" | "global" | "project";
export type PromptGroup =
  | "lead"
  | "tasks"
  | "reviews_and_checks"
  | "wakes_and_messages"
  | "one_shots"
  | "playbooks"
  | "instructions";
export interface SessionPromptRef {
  readonly id: string;
  readonly ref: string;
  readonly scope: PromptScope;
}
export interface SessionPrompt {
  readonly machineId: string;
  readonly threadId: string;
  readonly projectRef?: { readonly machineId: string; readonly projectId: string };
  readonly startedAt: Timestamp;
  readonly text: string;
  readonly textSha: string;
  readonly refs: readonly SessionPromptRef[];
  readonly disallowedTools: readonly string[];
}
export interface PromptSummary {
  readonly id: string;
  readonly title: string;
  readonly group: PromptGroup;
  readonly sentWhen: string;
  readonly scope: PromptScope;
  readonly defaultRef: string;
  readonly overrideRef?: string;
  readonly stale: boolean;
}
