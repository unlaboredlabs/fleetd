// The time_* tools' shapes, field for field from crates/fleetd-contracts/src/time.rs and mcp.rs (serde camelCase).
// A stand-in until E1's generated contract types land; then this file re-exports those under the same names.

export const CATEGORIES = ["model", "tools", "machine", "queue", "human", "pipeline", "idle"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Every span kind and its category (contracts `span_kinds!`). */
export const KIND_CATEGORY = {
  run: "machine",
  "model.message": "model",
  "model.first_token": "model",
  "model.thinking": "model",
  "model.output": "model",
  "tool.bash": "tools",
  "tool.read": "tools",
  "tool.edit": "tools",
  "tool.web": "tools",
  "tool.mcp": "tools",
  "tool.other": "tools",
  "tools.parallel": "tools",
  git: "tools",
  "check.claim": "tools",
  "wait.retry.api": "machine",
  "wait.retry.node": "machine",
  "run.startup": "machine",
  compaction: "machine",
  "claude.other": "machine",
  "wait.offline": "machine",
  "queue.slot": "queue",
  "queue.lease": "queue",
  "queue.usage": "queue",
  "queue.offline": "queue",
  "run.queued": "queue",
  "wake.debounce": "queue",
  "park.usage": "queue",
  "slots.full": "queue",
  "wait.permission": "human",
  "wait.ask": "human",
  "ask.batching": "human",
  "ask.info": "human",
  "change.review": "pipeline",
  "change.queue": "pipeline",
  "change.rebase": "pipeline",
  "change.ci": "pipeline",
  "ci.check": "pipeline",
  "ci.queue": "pipeline",
  "change.merge": "pipeline",
  "change.blocked": "pipeline",
  "intake.route": "pipeline",
  idle: "idle",
  gap: "idle",
} as const satisfies Record<string, Category>;
export type SpanKind = keyof typeof KIND_CATEGORY;
export const SPAN_KINDS = Object.keys(KIND_CATEGORY) as SpanKind[];

export type SpanStatus = "ok" | "failed" | "cancelled" | "incomplete";
export type DecidedBy = "policy" | "hub_rule" | "lead" | "human";
export type AgentRole = "lead" | "implementer" | "reader" | "reviewer" | "verifier" | "qa";

export interface SpanExtra {
  readonly check?: string;
  readonly url?: string;
  readonly decidedBy?: DecidedBy;
  readonly answeredBy?: string;
  readonly reason?: string;
  readonly attempt?: number;
  readonly statedDelayMs?: number;
  readonly httpStatus?: number;
  readonly stopReason?: string;
  readonly outputTokens?: number;
  readonly thinkingTokens?: number;
  readonly claudeMs?: number;
  readonly durationMs?: number;
  readonly durationApiMs?: number;
  readonly nodeStartMs?: number;
  readonly peakQueued?: number;
  readonly cap?: number;
  readonly count?: number;
  readonly requestId?: string;
  readonly key?: string;
  readonly tool?: string;
}

export interface Span {
  readonly id: number;
  readonly kind: SpanKind;
  readonly cat: Category;
  /** `thread:<machine>/<thread>`, `change:<id>`, `asks:<order>`, `train:<repo>`, `fleet`, `order:<id>`. */
  readonly lane: string;
  readonly startMs: number;
  /** Absent while open. */
  readonly endMs?: number;
  readonly exclMs?: number;
  readonly machineId?: string;
  readonly projectId?: string;
  readonly workstreamId?: string;
  readonly taskId?: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly parent?: number;
  readonly label?: string;
  readonly family?: string;
  readonly exitCode?: number;
  readonly outBytes?: number;
  readonly status: SpanStatus;
  readonly itemId?: string;
  readonly extra?: SpanExtra;
}

export interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

export type TimeScope =
  | { readonly kind: "fleet" }
  | { readonly kind: "machine"; readonly machineId: string }
  | { readonly kind: "project"; readonly projectRef: ProjectRef }
  | { readonly kind: "lead"; readonly projectRef: ProjectRef }
  | { readonly kind: "order"; readonly workstreamId: string }
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "thread"; readonly machineId: string; readonly threadId: string };

export interface Period {
  readonly since: string;
  readonly until: string;
}

export interface TimeFilters {
  readonly projectRef?: ProjectRef;
  readonly machineId?: string;
  readonly role?: AgentRole;
}

export type GapWhy = "node_older" | "node_dropped" | "hub_dropped" | "no_node_spans" | "nothing_running";

export interface Gap {
  readonly why: GapWhy;
  readonly lane?: string;
  readonly machineId?: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly count?: number;
}

export interface Coverage {
  readonly complete: boolean;
  readonly gaps: readonly Gap[];
  /** Spans are kept only from here (retention); category totals before it come from the daily roll-ups. */
  readonly detailSince?: string;
  /** The read hit its span cap and kept the newest spans. */
  readonly capped?: boolean;
}

export interface KindTotal {
  readonly kind: SpanKind;
  readonly ms: number;
  readonly n: number;
}

export interface CategoryTotal {
  readonly cat: Category;
  readonly ms: number;
  readonly n: number;
  readonly kinds: readonly KindTotal[];
}

export interface CommandStat {
  readonly label: string;
  readonly family: string;
  readonly n: number;
  readonly totalMs: number;
  readonly p50Ms: number;
  readonly maxMs: number;
  readonly failed: number;
}

export interface RepeatStat {
  readonly label: string;
  readonly threadId: string;
  readonly taskId?: string;
  readonly n: number;
  readonly totalMs: number;
}

export interface CiCheckStat {
  readonly name: string;
  readonly n: number;
  readonly totalMs: number;
  readonly p50Ms: number;
  readonly maxMs: number;
  readonly criticalExcessMs: number;
}

export interface HumanWait {
  readonly totalMs: number;
  readonly n: number;
  readonly longest?: { readonly spanId: number; readonly ms: number; readonly label?: string };
}

export interface PathSegment {
  /** Absent on a "nothing running" gap. */
  readonly spanId?: number;
  readonly lane: string;
  readonly kind: SpanKind;
  readonly cat: Category;
  readonly startMs: number;
  readonly endMs: number;
  readonly label?: string;
}

export interface CategoryMs {
  readonly cat: Category;
  readonly ms: number;
  readonly kinds?: readonly KindTotal[];
}

export interface CriticalPath {
  readonly startMs: number;
  readonly endMs: number;
  readonly segments: readonly PathSegment[];
  readonly segmentsTruncated: boolean;
  readonly totals: readonly CategoryMs[];
  readonly nothingRunningMs: number;
  readonly offPathMs: number;
}

export interface PeriodBreakdown {
  readonly since: string;
  readonly until: string;
  readonly wallMs: number;
  readonly agentMs: number;
  readonly byCategory: readonly CategoryTotal[];
}

export type InsightRule =
  | "full_suite_repeat"
  | "repeat_no_change"
  | "failing_repeat"
  | "slow_commands"
  | "ci_check_critical"
  | "ci_reaction"
  | "slots_full"
  | "human_wait"
  | "batching_delay"
  | "approval_rule"
  | "usage_parks"
  | "retries"
  | "review_share"
  | "train_line"
  | "rebase_loops"
  | "first_token"
  | "startup"
  | "offline"
  | "coverage";

export interface InsightNumber {
  readonly name: string;
  readonly value: number;
}

export type FiredIn = "current" | "compare" | "both";

export interface Insight {
  readonly rule: InsightRule;
  readonly message: string;
  readonly numbers: readonly InsightNumber[];
  readonly spanIds: readonly number[];
  readonly compare?: readonly InsightNumber[];
  readonly firedIn?: FiredIn;
}

export interface TimeSpansInput {
  readonly scope: TimeScope;
  readonly since: string;
  readonly until?: string;
  readonly kinds?: readonly SpanKind[];
  readonly rule?: InsightRule;
  readonly afterId?: number;
  readonly limit?: number;
}

export interface TimeSpansOutput {
  readonly spans: readonly Span[];
  readonly nextAfterId?: number;
  readonly coverage: Coverage;
}

export interface TimeBreakdownInput {
  readonly scope: TimeScope;
  readonly since: string;
  readonly until?: string;
  readonly compare?: Period;
  readonly filters: TimeFilters;
}

export interface TimeBreakdownOutput {
  readonly wallMs: number;
  readonly agentMs: number;
  readonly byCategory: readonly CategoryTotal[];
  readonly topCommands: readonly CommandStat[];
  readonly repeated: readonly RepeatStat[];
  readonly ciChecks: readonly CiCheckStat[];
  readonly humanWait: HumanWait;
  readonly criticalPath?: CriticalPath;
  readonly retentionDays: number;
  readonly storedBytes: number;
  readonly coverage: Coverage;
  readonly compare?: PeriodBreakdown;
}

export interface TimeInsightsInput {
  readonly scope: TimeScope;
  readonly since: string;
  readonly until?: string;
  readonly compare?: Period;
}

export interface TimeInsightsOutput {
  readonly insights: readonly Insight[];
}

export interface ThreadWindowInput {
  readonly machineId: string;
  readonly threadId: string;
  readonly itemId: string;
  readonly before?: number;
  readonly after?: number;
}

export interface ActionItem {
  readonly at: string;
  readonly kind: "command" | "file_change" | "tool_call" | "other";
  readonly status: "completed" | "failed" | "running";
  readonly summary: string;
  readonly outputTail?: string;
  readonly exitCode?: number;
  readonly failed: boolean;
}

export type TailItem =
  | { readonly kind: "message"; readonly at: string; readonly role: "user" | "assistant" | "system"; readonly text: string }
  | { readonly kind: "action"; readonly at: string; readonly action: ActionItem };

export interface ThreadWindowOutput {
  readonly items: readonly TailItem[];
  /** The index of `itemId` in `items`; absent when the node no longer has it. */
  readonly focus?: number;
}
