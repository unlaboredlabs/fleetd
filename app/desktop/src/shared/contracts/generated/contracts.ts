// Generated from crates/fleetd-contracts by `cargo run -p fleetd-contracts --bin fleetd-schema`.
// Do not edit: CI regenerates it and fails on any difference.
/* eslint-disable -- generated; the schemas are what they are (a machine id or "browser" is just a string). */

/** The /app protocol this build speaks. */
export const PROTOCOL_VERSION = 1;

/** Seconds per sparkline bucket. */
export const SPARK_BUCKET_SECS = 2;

/** Buckets in a sparkline: the last minute. */
export const SPARK_BUCKETS = 30;

/** Lanes in one live frame. */
export const LIVE_MAX_LANES = 64;

/** Streamed texts in one live frame. */
export const LIVE_MAX_TEXTS = 4;

/** Machines in one live frame. */
export const LIVE_MAX_MACHINES = 20;

/** Largest secret a secret ask takes. */
export const SECRET_MAX_BYTES = 8192;

/** Largest attachment attachment_put takes. */
export const ATTACHMENT_MAX_BYTES = 5242880;

/** How long a machine's sleep stays shown. */
export const SLEPT_SHOWN_MS = 3600000;

export type ActionItem = {
  at: Timestamp;
  /** Only when the runner reports one or the output says "Exit code N". */
  exitCode?: number;
  failed: boolean;
  kind: ActionKind;
  outputTail?: string;
  status: ActionStatus;
  /** The command, path or tool. */
  summary: string;
};

export type ActionKind = "command" | "file_change" | "tool_call" | "other";

export type ActionStatus = "completed" | "failed" | "running";

export type ActionsListInput = {
  failedOnly?: boolean;
  limit?: number;
  machineId: MachineId;
  threadId: ThreadId;
};

export type ActionsListOutput = {
  /** Newest first. */
  actions: ActionItem[];
  next?: string;
  truncated?: boolean;
};

/** What a lane is doing now, literally. */
export type Activity = {
  kind: "command";
  text: string;
} | {
  kind: "edit";
  path: string;
} | {
  kind: "read";
  path?: string;
  pattern?: string;
} | {
  detail?: string;
  kind: "tool";
  name: string;
} | {
  kind: "writing";
} | {
  kind: "thinking";
} | {
  kind: "compacting";
} | {
  attempt: number;
  kind: "retrying";
  of: number;
  reason: string;
};

export type ActivityNow = {
  activity: Activity;
  since: Timestamp;
};

/** One agent of an order: a task, or the project's lead. */
export type AgentLane = {
  branch?: string;
  effort?: Effort;
  endedAt?: Timestamp;
  laneId: string;
  /** Live values at snapshot time. */
  live?: LiveLane;
  model?: string;
  pr?: PrRef;
  /** Counted from the thread's items when it ended. */
  receipts?: Receipts;
  role: AgentRole;
  startedAt?: Timestamp;
  status: LaneStatus;
  /** Queued, parked or failed: why, e.g. "slots: 40/40 in use", "usage limit: resumes 14:05". */
  statusReason?: string;
  taskId?: TaskId;
  threadRef?: ThreadRef;
  title: string;
};

export type AgentRole = "lead" | "implementer" | "reader" | "reviewer" | "verifier" | "qa";

export type AppClientMessage = {
  key: string;
  t: "auth";
} | {
  t: "snapshot";
} | {
  cursor: EventSeq;
  t: "events";
} | {
  id: string;
  input: unknown;
  t: "call";
  tool: string;
} | {
  board: boolean;
  focus?: WorkstreamId;
  t: "live";
} | {
  project?: ProjectRef;
  t: "chat";
};

/** A `call` failed, or (without `id`) the session did. */
export type AppError = {
  code: ErrorCode;
  fix?: string;
  /** Present when this answers a `call`. */
  id?: string;
  message: string;
};

export type AppServerMessage = {
  protocol: number;
  t: "ready";
} | FleetStatus & {
  t: "snapshot";
} | HubEvent & {
  t: "event";
} | {
  id: string;
  output: unknown;
  t: "result";
} | AppError & {
  t: "error";
} | LiveFrame & {
  t: "live";
} | ChatDelta & {
  t: "chat_delta";
};

export type ApprovalAnswerInput = {
  decision: ApprovalDecision;
  /** A denial's reason, passed to the lead. */
  message?: string;
  requestId: ChatRequestId;
};

export type ApprovalAnswerOutput = {
  next?: string;
  request: HumanRequest;
  truncated?: boolean;
};

/** The human's answer to a `command_approval`. */
export type ApprovalDecision = "approve" | "deny";

/** Lowercase slug, [a-z0-9][a-z0-9_-]*, at most 40 */
export type AreaName = string;

export type AttachmentGetInput = {
  attachmentId: AttachmentId;
  projectRef: ProjectRef;
};

export type AttachmentGetOutput = {
  attachmentId: AttachmentId;
  bytes: number;
  /** Standard base64. */
  dataB64: string;
  mime: AttachmentMime;
  name: string;
  next?: string;
  truncated?: boolean;
};

export type AttachmentId = string;

export type AttachmentMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "text/plain" | "application/pdf";

export type AttachmentPutInput = {
  /** Standard base64; at most 5 MiB decoded. */
  dataB64: string;
  mime: AttachmentMime;
  name: string;
};

export type AttachmentPutOutput = {
  attachmentId: AttachmentId;
  bytes: number;
  next?: string;
  sha256: string;
  truncated?: boolean;
};

/** A file on a message: what the app shows without fetching it. Its bytes come from `attachment_get`. */
export type AttachmentRef = {
  attachmentId: AttachmentId;
  bytes: number;
  mime: AttachmentMime;
  name: string;
};

/**
 * Whether an event needs the human now, set by the hub when it emits the event. "loud": notify, but hold it through
 * quiet hours; "urgent": notify even during quiet hours (money and irreversible). Absent: the inbox and the digest
 * are enough.
 */
export type Attention = "loud" | "urgent";

export type AttentionPolicyInput = { [key: string]: unknown };

export type AttentionPolicyOutput = {
  /** At most one notification per this many seconds; what arrives meanwhile is folded into the next. */
  coalesceSec: number;
  next?: string;
  /** Only "urgent" events notify inside these; empty when quiet hours are off. Ask again after the last one ends. */
  quiet: QuietWindow[];
  truncated?: boolean;
};

export type BoxPublicKey = string;

export type BreakerState = "closed" | "open";

export type Brief = {
  /** Research: what the candidate is compared against, and how both are measured. */
  baseline?: string;
  budget?: BriefBudget;
  constraints: string[];
  /** Research: frozen with the brief, so the verdict can't move the goalposts. */
  decisionRule?: DecisionRule;
  /** At least one; frozen with the brief. */
  doneWhen: CheckSpec[];
  estimate?: Estimate;
  goal: string;
  /** Research: the one number the judge reports for baseline and candidate, e.g. "p50 cold start in ms". */
  metric?: string;
  pointers: string[];
  tier: Tier;
  why: string;
};

export type BriefBudget = {
  /** Older briefs only; a lead now gives `size`. */
  agentHours?: number;
  /** How big a research spend the lead allows, relative like plan sizes; never a time guess. */
  size?: Tier;
};

export type BriefHash = string;

export type CapSetInput = {
  cap?: number;
  share?: CapSetShare;
};

export type CapSetOutput = {
  next?: string;
  slots: SlotState;
  truncated?: boolean;
};

export type CapSetShare = {
  projectRef: ProjectRef;
  share: number;
};

/** Which color a span gets in every view, and which breakdown row it adds to. */
export type Category = "model" | "tools" | "queue" | "machine" | "human" | "pipeline" | "idle";

export type CategoryMs = {
  cat: Category;
  /** The same total by kind, e.g. `change.ci`, `change.review` and `change.queue` within pipeline. */
  kinds?: KindTotal[];
  ms: number;
};

export type CategoryTotal = {
  cat: Category;
  kinds: KindTotal[];
  /** Exclusive agent time. */
  ms: number;
  n: number;
};

export type Change = {
  /** The PR's head branch. */
  branch: string;
  changeId: ChangeId;
  createdAt: Timestamp;
  headSha: CommitSha;
  /** The refusal fix, conflicting paths, or failing check names. */
  lastError?: string;
  /** The squash commit on the base; set on merge. */
  mergedSha?: CommitSha;
  patchId?: PatchId;
  /** 0-based index into its train's queue; absent when not queued. */
  position?: number;
  prNumber: number;
  prUrl: GitHubPrUrl;
  projectRef: ProjectRef;
  repo: GitHubRepo;
  reviews: ChangeReview[];
  serves: Serves;
  state: ChangeState;
  /** The write task that opened it; absent when the lead enqueued a PR no task wrote. */
  taskId?: TaskId;
  /** From the workstream's brief; may be raised, never lowered. */
  tier: Tier;
  updatedAt: Timestamp;
  workstreamId: WorkstreamId;
};

export type ChangeId = string;

/** One review verdict, valid for exactly this patch. A clean rebase that keeps the patch id keeps it valid. */
export type ChangeReview = {
  blocking: number;
  nonBlocking: number;
  patchId: PatchId;
  prHeadSha: CommitSha;
  taskId: TaskId;
};

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

/** `change.state`: every train state change. */
export type ChangeStateData = {
  changeId: ChangeId;
  from: ChangeState;
  prNumber: number;
  repo: GitHubRepo;
  to: ChangeState;
  workstreamId?: WorkstreamId;
};

export type ChangesListInput = {
  limit?: number;
  projectRef?: ProjectRef;
  repo?: GitHubRepo;
  state?: ChangeState;
};

export type ChangesListOutput = {
  /** Newest first. */
  changes: Change[];
  next?: string;
  truncated?: boolean;
};

export type KnownChatAuthor = "human" | "lead" | "system";
/** KnownChatAuthor, or a value from a newer hub. */
export type ChatAuthor = KnownChatAuthor | (string & {});

/** How a human message reached the lead. */
export type KnownChatDelivery = "turn" | "steer" | "queued";
/** KnownChatDelivery, or a value from a newer hub. */
export type ChatDelivery = KnownChatDelivery | (string & {});

/**
 * Streamed text of the subscribed chat's lead message `messageId`. `offset` is the message's text length before
 * `append`, in UTF-16 units: append when it equals the length the app holds, skip the frame when
 * `offset + append.length` is within it (already applied, e.g. after a `chat_history` read), and read the message
 * again otherwise (a gap). The `chat.message` event with `state: final` carries the full text.
 */
export type ChatDelta = {
  append: string;
  messageId: ChatMessageId;
  offset: number;
  projectRef: ProjectRef;
  seq: number;
};

export type ChatHistoryInput = {
  after?: number;
  before?: number;
  limit?: number;
  projectRef: ProjectRef;
};

export type ChatHistoryOutput = {
  messages: ChatMessage[];
  /** More messages after the last one of this page. */
  moreAfter: boolean;
  /** More messages before the first one of this page. */
  moreBefore: boolean;
  next?: string;
  state: ProjectChatState;
  truncated?: boolean;
};

/**
 * Where a history message came from, for messages from before the chat existed (a read model; nothing is moved or
 * destroyed). Absent on messages written in the chat.
 */
export type KnownChatHistorySource = "order" | "note" | "steer" | "lead_message" | "order_outcome" | "question";
/** KnownChatHistorySource, or a value from a newer hub. */
export type ChatHistorySource = KnownChatHistorySource | (string & {});

/** The two things a chat can't carry as plain text, shown inline in place of the message text. */
export type ChatItem = SecretRequestItem & {
  kind: "secret_request";
} | CommandApprovalItem & {
  kind: "command_approval";
};

export type ChatMessage = {
  attachments?: AttachmentRef[];
  author: ChatAuthor;
  /** A human message: the key name of the person who wrote it. */
  by?: string;
  /** A human message: the `clientRequestId` its `chat_send` carried, for the app's optimistic copy. */
  clientRequestId?: string;
  createdAt: Timestamp;
  /** A human message: how it reached the lead. */
  delivery?: ChatDelivery;
  /** From before the chat: where this history message came from. */
  history?: ChatHistorySource;
  item?: ChatItem;
  messageId: ChatMessageId;
  projectRef: ProjectRef;
  seq: number;
  state: ChatMessageState;
  /** Markdown. Empty while a streamed message has no text yet, and for an inline `item`. */
  text: string;
  /** Set when the text was last appended to, or an item's state changed. */
  updatedAt?: Timestamp;
};

/**
 * `chat.message` data: on each new message, and again when a streamed message is final or an inline item changes
 * state. `message` is the whole message when it fits the event's 2 KB; otherwise read it with `chat_history`
 * (`after: seq - 1`, `limit: 1`).
 */
export type ChatMessageEventData = {
  author: ChatAuthor;
  message?: ChatMessage;
  messageId: ChatMessageId;
  projectRef: ProjectRef;
  seq: number;
  state: ChatMessageState;
};

export type ChatMessageId = string;

export type KnownChatMessageState = "final" | "streaming";
/** KnownChatMessageState, or a value from a newer hub. */
export type ChatMessageState = KnownChatMessageState | (string & {});

export type ChatRequestId = string;

export type ChatSendInput = {
  /** From attachment_put. */
  attachments?: AttachmentId[];
  clientRequestId: string;
  projectRef: ProjectRef;
  text: string;
};

export type ChatSendOutput = {
  /** Why the lead doesn't have it yet, with the fix; absent when it does or is starting. */
  leadWaiting?: string;
  message: ChatMessage;
  next?: string;
  truncated?: boolean;
};

/** `error` (the check could not run) counts as not passing. */
export type CheckOutcome = "pass" | "fail" | "error";

export type CheckResult = {
  at: Timestamp;
  /** 0-based index into the brief's doneWhen. */
  checkIndex: number;
  /** Output tail, HTTP status and body excerpt, verdict summary, or the fix when `error`. */
  evidence: string;
  /** Only for `cmd` checks, which the node runs. */
  exitCode?: number;
  ranBy: CheckResultRanBy;
  result: CheckOutcome;
  spec: CheckSpec;
};

export type CheckResultRanBy = "hub" | "node" | "judge" | "human";

export type CheckSpec = {
  pr?: number;
  repo: string;
  type: "pr_merged";
} | {
  ref?: string;
  repo: string;
  type: "ci_green";
} | {
  contains?: string;
  status: number;
  type: "http";
  url: string;
} | {
  argv: string[];
  expectExit: number;
  machineId: MachineId;
  type: "cmd";
} | {
  repo: string;
  testId: string;
  type: "test";
} | {
  criteria: string;
  type: "judge";
} | {
  question: string;
  type: "human";
};

export type Checkout = {
  machineId: MachineId;
  path: string;
  projectId?: ProjectId;
};

export type CiCheckStat = {
  /** Time this check added on critical paths past the second-latest check. */
  criticalExcessMs: number;
  maxMs: number;
  n: number;
  name: string;
  p50Ms: number;
  totalMs: number;
};

/** CI the repository runs. */
export type CiInfo = {
  /** Status checks the default branch requires, from branch protection and rulesets. */
  requiredChecks: string[];
  /** Active GitHub Actions workflows by name (from `.github/workflows` on a checkout without GitHub access). */
  workflows: string[];
};

/** `ci.main`: main-branch CI of a train repo changed state. */
export type CiMainData = {
  failing: string[];
  repo: GitHubRepo;
  sha: string;
  state: CiState;
};

export type KnownCiState = "green" | "red" | "pending" | "unknown";
/** KnownCiState, or a value from a newer hub. */
export type CiState = KnownCiState | (string & {});

export type Claim = {
  at: Timestamp;
  /** "lead:<machineId>/<projectId>", an agent keyId or "human". */
  by: string;
  claimId: ClaimId;
  /** `pass` only when every check passed. */
  outcome: ClaimOutcome;
  /** In check index order. */
  results: CheckResult[];
  workstreamId: WorkstreamId;
};

/** `claim.passed`, `claim.failed`. */
export type ClaimEventData = {
  claimId: ClaimId;
  /** claim.failed: the done-when indexes that did not pass. */
  failing?: number[];
  workstreamId: WorkstreamId;
};

export type ClaimId = string;

export type ClaimOutcome = "pass" | "fail";

export type ClaimsListInput = {
  limit?: number;
  outcome?: ClaimOutcome;
  projectRef?: ProjectRef;
  workstreamId?: WorkstreamId;
};

export type ClaimsListOutput = {
  /** Newest first. */
  claims: Claim[];
  next?: string;
  truncated?: boolean;
};

export type ClonePhase = "starting" | "receiving" | "resolving" | "checking_out" | "inspecting";

/**
 * `HubEvent.data` on `project.clone_progress`: on each phase change and its 100 %, else every 5 percent at most once
 * a second.
 */
export type CloneProgressData = {
  addId: string;
  /** As git prints it, e.g. "12.40 MiB | 3.10 MiB/s". */
  detail?: string;
  /** Absolute, on the event's machine. */
  path: string;
  /** Of this phase. */
  percent?: number;
  phase: ClonePhase;
  repo?: GitHubRepo;
};

/** Where a clone would go on a machine, and what is there now. */
export type CloneTarget = {
  exists: boolean;
  machineId: MachineId;
  /** Absolute. */
  path: string;
  /** The existing directory is already this project. */
  projectId?: ProjectId;
  /** The existing directory is a checkout of the same repository: `project_add` with `useExisting` adds it. */
  sameRemote: boolean;
};

/**
 * A risky command (prod write, spend, delete, credential use) or a session's permission prompt waits for the
 * human: the exact command, then Approve or Deny. Answered with `approval_answer`, naming `requestId`. Exactly one of
 * `gated` and `permission`.
 */
export type CommandApprovalItem = {
  answeredAt?: Timestamp;
  /** The key name of the person who answered. */
  by?: string;
  exitCode?: number;
  /** A gated command: exactly what runs once approved. */
  gated?: GatedRunSpec;
  /** Where it runs, or the machine of the session that asks. */
  machineId: MachineId;
  /** Why it is open again ("not run: the node was offline when approved"), or why it failed without running. */
  note?: string;
  /** The end of the output, once it ran. */
  outputTail?: string;
  /** A session's permission prompt: the tool and what it would do. */
  permission?: ToolPermission;
  requestId: ChatRequestId;
  state: CommandApprovalState;
};

export type KnownCommandApprovalState = "open" | "approved" | "denied" | "ran" | "failed";
/** KnownCommandApprovalState, or a value from a newer hub. */
export type CommandApprovalState = KnownCommandApprovalState | (string & {});

export type CommandStat = {
  failed: number;
  family: string;
  label: string;
  maxMs: number;
  n: number;
  p50Ms: number;
  /** Per call: each call's own interval, which may overlap others. */
  totalMs: number;
};

/** Full lowercase hex commit SHA, 40 or 64 characters */
export type CommitSha = string;

export type Coverage = {
  /** The read hit its span cap and kept the newest spans. */
  capped?: boolean;
  complete: boolean;
  /**
   * Spans are kept only from here (retention): span lists, commands, CI checks and insights start here, while
   * category totals before it come from the daily roll-ups.
   */
  detailSince?: Timestamp;
  gaps: Gap[];
};

export type CriticalPath = {
  endMs: number;
  /** Time with nothing running, which points at missing data. */
  nothingRunningMs: number;
  /** Agent time minus the path. */
  offPathMs: number;
  /** Oldest first; they add up to `end_ms - start_ms`. */
  segments: PathSegment[];
  /** True when the order had more segments than fit; the totals still cover them all. */
  segmentsTruncated: boolean;
  startMs: number;
  totals: CategoryMs[];
};

/** Who answered a permission prompt. */
export type DecidedBy = "lead" | "human" | "policy" | "hub_rule";

export type Decision = {
  at: Timestamp;
  /** Who recorded it: the agent key name, "lead:<machineId>/<projectId>" or "human:<device>". */
  by?: string;
  decisionId: DecisionId;
  key: DecisionKey;
  scope: DecisionScope;
  source: DecisionSource;
  state: DecisionState;
  /** The earlier active decision on the same key and scope that this one replaced. */
  supersedes?: DecisionId;
  value: string;
  why?: string;
};

export type DecisionId = string;

/** Lowercase dotted slug, [a-z0-9]+(.[a-z0-9_-]+)*, at most 80 */
export type DecisionKey = string;

/**
 * Applied to the improvement: candidate − baseline, negated when lower is better. GO when it is at least
 * `goAtLeast`, STOP when it is below `stopBelow`, INCONCLUSIVE in between.
 */
export type DecisionRule = {
  better: DecisionRuleBetter;
  goAtLeast: number;
  stopBelow: number;
};

export type DecisionRuleBetter = "higher" | "lower";

export type DecisionScope = {
  kind: "global";
} | {
  kind: "project";
  projectRef: ProjectRef;
} | {
  kind: "workstream";
  workstreamId: WorkstreamId;
};

/** Filled by the hub from the caller: a human device, an agent key, or a lead-side call. */
export type DecisionSource = "human" | "lead" | "agent";

export type DecisionState = "active" | "superseded" | "retired";

export type DecisionsRecordInput = {
  key: DecisionKey;
  scope: DecisionScope;
  value: string;
  why?: string;
};

export type DecisionsRecordOutput = {
  decision: Decision;
  next?: string;
  truncated?: boolean;
};

export type DecisionsSearchInput = {
  limit?: number;
  query: string;
  /** Absent: every scope. */
  scope?: DecisionScope;
};

export type DecisionsSearchOutput = {
  /** Best match first; active decisions only. */
  decisions: Decision[];
  next?: string;
  truncated?: boolean;
};

/** The only metric direction. */
export type Decrease = "decrease";

/** How a delivered steer was taken in. */
export type DeliveredHow = "turn" | "boundary" | "stopped" | "joined";

export type DigestGetInput = { [key: string]: unknown };

export type DigestGetOutput = {
  at: Timestamp;
  next?: string;
  text: string;
  truncated?: boolean;
};

export type DoctorCheck = {
  /** Absent when there is nothing to do. */
  fix?: DoctorFix;
  id: DoctorCheckId;
  /** Set when scope is machine. */
  machineId?: MachineId;
  /** Plain language. */
  message: string;
  scope: DoctorScope;
  status: DoctorStatus;
};

export type DoctorCheckId = string;

/** `auto`: doctor_fix runs it. `manual`: a person runs `command` (where the label says). */
export type DoctorFix = {
  command?: string;
  kind: DoctorFixKind;
  label: string;
};

export type DoctorFixInput = {
  checkId: DoctorCheckId;
};

export type DoctorFixKind = "auto" | "manual";

export type DoctorFixOutput = {
  /** The check, run again after the fix. */
  check: DoctorCheck;
  next?: string;
  /** What the fix did, in plain words. */
  ran: string;
  truncated?: boolean;
};

export type DoctorListInput = {
  machineId?: MachineId;
  rerun?: boolean;
};

export type DoctorListOutput = {
  /** When these results were taken. */
  checkedAt: Timestamp;
  /** Hub checks first, then each machine's, in a fixed order. */
  checks: DoctorCheck[];
  next?: string;
  truncated?: boolean;
};

export type DoctorScope = "hub" | "machine";

/** `unknown`: the hub could not look (machine offline, nothing to read). */
export type DoctorStatus = "ok" | "warn" | "fail" | "unknown";

export type DoneRow = {
  doneAt: Timestamp;
  /** "#208 merged by the train 13:12 · check 2 passed C7". */
  evidence: string;
  /** Absent for an order with no plan items, which counts as one item. */
  itemId?: PlanItemId;
  title: string;
  workstreamId?: WorkstreamId;
};

export type DriftKind = "outside_fleetd" | "missed_webhook";

export type KnownDropReason = "scope_change" | "review_failed" | "ci_failed" | "reopened";
/** KnownDropReason, or a value from a newer hub. */
export type DropReason = KnownDropReason | (string & {});

export type Effort = "low" | "medium" | "high" | "max";

/** Who keeps a safety rule when the prompt no longer says it. */
export type Enforcement = "code" | "prompt";

export type EnvName = string;

export type ErrorCode = "machine_offline" | "not_found" | "forbidden" | "invalid" | "failed";

export type Estimate = {
  gates: string[];
  rawMinutes: number;
};

/** The brief's raw estimate corrected by the tier's measured actual/raw ratio. */
export type Eta = {
  calibratedMinutes: number;
  /** From 10 samples on. */
  p80Minutes?: number;
  /** Median actual/raw over the tier's last 20 done workstreams; the 5.0 prior below 5 samples. */
  ratio: number;
  rawMinutes: number;
  samples: number;
};

export type KnownEtaBasis = "fleet" | "order" | "project" | "none";
/** KnownEtaBasis, or a value from a newer hub. */
export type EtaBasis = KnownEtaBasis | (string & {});

/** `current − original`, split into what scope added and what speed lost. */
export type EtaSlip = {
  scopeMinutes: number;
  speedMinutes: number;
};

export type EventSeq = number;

export type EventsWaitInput = {
  /** Absent means start at the current end. */
  cursor?: EventSeq;
  machineId?: MachineId;
  timeoutSec?: number;
  types?: HubEventType[];
};

export type EventsWaitOutput = {
  cursor: EventSeq;
  events: HubEvent[];
  more: boolean;
  next?: string;
  truncated?: boolean;
};

export type FiredIn = "current" | "compare" | "both";

export type FleetStatus = {
  /** Latest failed, waiting and usage-limited events, and PRs the merge train sent back to their authors. */
  attention: HubEvent[];
  /** Each project's chat: whether its lead waits on you, whether it works. Absent from hubs without chat. */
  chats?: ProjectChatState[];
  cursor: EventSeq;
  machines: Machine[];
  projects: ProjectSummary[];
  /** Absent until the hub runs the slot board (M5). */
  slots?: SlotState;
};

export type FleetdStatusInput = { [key: string]: unknown };

export type FleetdStatusOutput = {
  /** Latest failed, waiting and usage-limited events, and PRs the merge train sent back to their authors. */
  attention: HubEvent[];
  /** Each project's chat: whether its lead waits on you, whether it works. Absent from hubs without chat. */
  chats?: ProjectChatState[];
  cursor: EventSeq;
  machines: Machine[];
  next?: string;
  projects: ProjectSummary[];
  /** Absent until the hub runs the slot board (M5). */
  slots?: SlotState;
  truncated?: boolean;
};

/** A git checkout found on a machine (under ~/src, ~/code, ~/projects, ~/dev and similar, at most two levels down). */
export type FoundRepo = {
  /** The directory's name. */
  name: string;
  /** Absolute. */
  path: string;
  /** Set when the checkout is already a project. */
  projectId?: ProjectId;
  /** The origin remote, shortened: "github.com/acme/storefront". */
  remote?: string;
  /** When the remote is on GitHub. */
  repo?: GitHubRepo;
};

export type Gap = {
  count?: number;
  fromMs: number;
  lane?: string;
  machineId?: MachineId;
  toMs: number;
  why: GapWhy;
};

export type GapWhy = "node_older" | "node_dropped" | "hub_dropped" | "no_node_spans" | "nothing_running";

/** What the scope is waiting on. */
export type Gate = {
  itemId?: PlanItemId;
  kind: GateKind;
  /** "P12 full lab run", "CI on #212", "your answer on `api.path`". */
  label: string;
  /** It blocks every in-progress item of its order. */
  serial: boolean;
  since?: Timestamp;
  workstreamId?: WorkstreamId;
};

export type KnownGateKind = "plan" | "live" | "phase";
/** KnownGateKind, or a value from a newer hub. */
export type GateKind = KnownGateKind | (string & {});

export type GatedClass = "irreversible" | "money" | "credential";

/** Stored with the approval and never changed: the human approves exactly these bytes. */
export type GatedRunSpec = {
  argv: string[];
  class: GatedClass;
  cwd?: string;
  reason: string;
  secretEnv?: SecretEnvEntry[];
  timeoutSec: number;
};

/** A repository `gh repo list` returned, for the user or one of their orgs. */
export type GitHubCandidate = {
  /** Machines that already have a checkout of it. */
  checkouts: Checkout[];
  description?: string;
  private: boolean;
  pushedAt?: string;
  repo: GitHubRepo;
  url: string;
};

/** https://github.com/<owner>/<name>/pull/<n> */
export type GitHubPrUrl = string;

/** GitHub repository as owner/name */
export type GitHubRepo = string;

/** The `gh repo list` part of `project_discover`. */
export type GitHubRepos = {
  /** Where gh ran: "hub" (the hub machine) or a machine id. Absent when gh is logged in nowhere. */
  ghOn?: string;
  /** The login and the orgs listed, in order. */
  owners: string[];
  problem?: ProjectProblem;
  repos: GitHubCandidate[];
};

/** `github.drift`. */
export type GithubDriftData = {
  kind: DriftKind;
  lagMs?: number;
  repo: GitHubRepo;
  what: string;
};

export type GithubHook = {
  hookId: number;
  repo: GitHubRepo;
};

export type GithubWebhookSetInput = {
  /** A public URL GitHub can reach, ending in /github; fleetd never creates one. */
  url?: WebhookUrl;
};

export type GithubWebhookSetOutput = {
  next?: string;
  /** The hooks now in place; empty when turned off. */
  repos: GithubHook[];
  truncated?: boolean;
};

export type Headline = {
  at: Timestamp;
  /** The prompt version that wrote a generated line, `status.headline@<sha10>`. */
  promptRef?: PromptRef;
  /** Why the template shows: "facts changed, rewriting", "claude unavailable: …", "daily limit". */
  reason?: string;
  source: HeadlineSource;
  /** Starts with "Not live: …" when a source the scope depends on is stale; the hub writes that clause. */
  text: string;
};

export type KnownHeadlineSource = "generated" | "template";
/** KnownHeadlineSource, or a value from a newer hub. */
export type HeadlineSource = KnownHeadlineSource | (string & {});

export type Health = {
  ci: HealthCi[];
  machines: HealthMachine[];
  slots: HealthSlots;
  usage: HealthUsage[];
};

/** Main-branch CI of one repo. */
export type HealthCi = {
  /** The last GitHub answer for the repo. */
  asOf?: Timestamp;
  failing: string[];
  repo: GitHubRepo;
  sha?: string;
  /** When the state last changed. */
  since?: Timestamp;
  stale?: StaleMark;
  state: CiState;
};

export type HealthMachine = {
  /** Times it went offline or slept in the last 24 h. */
  dropsToday: number;
  lastSeenAt?: Timestamp;
  machineId: MachineId;
  /** Its latest sleep, for 24 h after it woke. */
  slept?: SleptAt;
  stale?: StaleMark;
  status: MachineStatus;
};

/** "8 running · slots 8/40 · 1 queued". Hub-local, never stale. */
export type HealthSlots = {
  cap: number;
  queued: number;
  running: number;
  used: number;
  /** How much of the cap was held recently. */
  utilization?: SlotUtilization;
};

/** One claude usage window: the highest utilization of that type across machines. */
export type HealthUsage = {
  /** claude's name, e.g. "five_hour", "seven_day". */
  limitType: string;
  machineId: MachineId;
  observedAt?: Timestamp;
  resetsAt?: Timestamp;
  stale?: StaleMark;
  status: string;
  /** 0 to 1. */
  utilization?: number;
};

export type HubEvent = {
  at: Timestamp;
  attention?: Attention;
  /** At most 2 KB of JSON; the hub trims before emitting. */
  data?: unknown;
  machineId?: MachineId;
  projectId?: ProjectId;
  /** Hub-global and monotonic. */
  seq: EventSeq;
  /** Plain language. */
  summary: string;
  threadId?: ThreadId;
  type: HubEventType;
};

export type KnownHubEventType =
  | "machine.online"
  | "machine.offline"
  | "machine.degraded"
  | "thread.started"
  | "thread.completed"
  | "thread.failed"
  | "thread.interrupted"
  | "thread.usage_limited"
  | "wake.fired"
  | "workstream.created"
  | "workstream.state"
  | "decision.recorded"
  | "lead.started"
  | "lead.woken"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "claim.passed"
  | "steer.withdrawn"
  | "machine.slept"
  | "project.removed"
  | "project.added"
  | "project.clone_progress"
  | "project.add_failed"
  | "thread.waiting"
  | "thread.stalled"
  | "wake.missed"
  | "write.delivered"
  | "write.expired"
  | "webhook.failing"
  | "workstream.running"
  | "request.opened"
  | "request.updated"
  | "digest.ready"
  | "task.queued"
  | "task.out_of_area"
  | "lease.stale"
  | "claim.failed"
  | "workstream.done"
  | "review.verdict"
  | "incident.recorded"
  | "change.queued"
  | "change.ready"
  | "change.needs_rebase"
  | "change.ci_failed"
  | "pr.merged"
  | "train.frozen"
  | "train.resumed"
  | "train.blocked"
  | "change.refused"
  | "intake.routed"
  | "research.verdict"
  | "usage.breaker"
  | "usage.resumed"
  | "doctor.changed"
  | "retro.ran"
  | "playbook.changed"
  | "playbook.reverted"
  | "playbook.kept"
  | "key.paired"
  | "workstream.note"
  | "prompt.changed"
  | "prompt.default_changed"
  | "steer.queued"
  | "steer.delivered"
  | "steer.acknowledged"
  | "steer.unacknowledged"
  | "steer.failed"
  | "plan.changed"
  | "plan.verified"
  | "change.state"
  | "ci.main"
  | "github.drift"
  | "source.stale"
  | "source.fresh"
  | "chat.message"
  | "chat.waiting";
/** KnownHubEventType, or a value from a newer hub. */
export type HubEventType = KnownHubEventType | (string & {});

/** One human request, as stored and as every client shows it. */
export type HumanRequest = {
  answeredAt?: Timestamp;
  /** "human:<device>". */
  answeredBy?: string;
  createdAt: Timestamp;
  /** What happened: "fingerprint ab12cd34", "exit 0" and the output tail, or why it did not run. */
  evidence?: string;
  /** approval of a gated run: exactly the bytes the node runs. */
  gated?: GatedRunSpec;
  kind: RequestKind;
  /** approval of a session's tool prompt, instead of a gated run. */
  permission?: ToolPermission;
  projectRef: ProjectRef;
  requestId: ChatRequestId;
  /** secret only. */
  secret?: SecretRequest;
  state: RequestState;
  /** One line on why the lead needs it. */
  text: string;
  workstreamId?: WorkstreamId;
};

export type HumanWait = {
  longest?: LongestWait;
  n: number;
  totalMs: number;
};

export type InProgressRow = {
  /** Open items that wait on it. */
  blocking?: PlanItemId[];
  changeIds: ChangeId[];
  /** Share of the item's size credited to the estimate. */
  creditPct?: number;
  /** It is the scope's critical path: the most unfinished work (its own and what waits on it) runs through it. */
  critical?: boolean;
  /** Retired with the ETA: always absent. */
  eta?: Timestamp;
  gate?: string;
  itemId?: PlanItemId;
  /** Retired with the ETA: always absent. */
  overdueMinutes?: number;
  /** Past 1.5× the usual time for its current stage: flagged in Risks, never credited past 90% of the stage. */
  slowerThanUsual?: boolean;
  /** The furthest stage fleetd observed for the item. */
  stage?: ItemStage;
  stale?: StaleMark;
  /** The order's latest steers, newest first, on its first in-progress row only. */
  steers?: StatusSteer[];
  /** Join to the live feed's lanes for what each agent is doing now. */
  taskIds: TaskId[];
  title: string;
  /**
   * What it still waits on, in order: open items it is `after`, then its remaining stages, e.g.
   * ["review of #12", "CI on #12", "merge", "done-when checks"].
   */
  waitingOn?: string[];
  workstreamId: WorkstreamId;
};

/** Recorded by the hub, never by an agent. */
export type Incident = {
  at: Timestamp;
  class: IncidentClass;
  /** Plain-language lines: claim ids with their failing checks, ratios, SHAs. */
  evidence: string[];
  incidentId: IncidentId;
  projectRef: ProjectRef;
  taskId?: TaskId;
  workstreamId?: WorkstreamId;
};

/**
 * `policy_bypass`: a PR on a watched repo was merged by something other than the train. M12: `override`, a human
 * replaced a lead's Decision with another value; `playbook_reverted`, a retro wording change missed its metric and was
 * rolled back.
 */
export type IncidentClass =
  | "false_claim"
  | "polish_loop"
  | "out_of_area"
  | "stall"
  | "policy_bypass"
  | "override"
  | "playbook_reverted"
  | "estimate_miss"
  | "misfiled_ask"
  | "re_ask";

export type IncidentCount = {
  class: IncidentClass;
  count: number;
};

export type IncidentId = string;

export type IncidentsListInput = {
  class?: IncidentClass;
  limit?: number;
  projectRef?: ProjectRef;
  /** M12: the span `counts` covers, ending now. */
  windowDays?: number;
  workstreamId?: WorkstreamId;
};

export type IncidentsListOutput = {
  /**
   * M12: incidents per class since `counts_since`, under the same filters; classes with none are left out. Most
   * first.
   */
  counts: IncidentCount[];
  countsSince: Timestamp;
  /** Newest first. */
  incidents: Incident[];
  next?: string;
  truncated?: boolean;
};

export type Insight = {
  /**
   * The same numbers for the compare period. Present on every insight when a compare period was asked for,
   * also when the rule fired in only one of the two.
   */
  compare?: InsightNumber[];
  /** Which periods the rule fired in, with a compare period. */
  firedIn?: FiredIn;
  message: string;
  /** The numbers the message was built from (durations in ms). */
  numbers: InsightNumber[];
  rule: InsightRule;
  /** At most 200; `time_spans { rule }` lists them all. */
  spanIds: number[];
};

export type InsightNumber = {
  name: string;
  value: number;
};

export type KnownInsightRule =
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
  | "coverage"
  | "queue_wait"
  | "contention"
  | "idle_lead"
  | "slots_underused";
/** KnownInsightRule, or a value from a newer hub. */
export type InsightRule = KnownInsightRule | (string & {});

export type IntakeChannel = "app" | "mcp" | "lead";

/** Where an intent went and why, whether the router, a prefix, `@<project>` or the caller decided it. */
export type IntakeEcho = {
  projectRef: ProjectRef;
  reason: string;
  template: PlaybookName;
};

export type IntakePreviewInput = {
  text: string;
};

export type IntakePreviewOutput = {
  /** Absent: the router could not place it (intake_submit refuses it: name the project). */
  echo?: IntakeEcho;
  next?: string;
  truncated?: boolean;
};

/**
 * Something an order or note points at: a file of the project, another order, or a PR. The hub renders these into
 * the lead's wake as a "References:" block.
 */
export type IntakeRef = {
  kind: "file";
  path: string;
} | {
  kind: "order";
  workstreamId: WorkstreamId;
} | {
  kind: "pr";
  url: GitHubPrUrl;
};

export type IntakeSubmitInput = {
  /** From attachment_put; delivered to the project under `.fleetd/attachments/<W>/` when the order is placed. */
  attachments?: AttachmentId[];
  clientRequestId: string;
  /** With projectId, or neither: then the router picks the project unless the text starts with `@<project>`. */
  machineId?: MachineId;
  projectId?: ProjectId;
  refs?: IntakeRef[];
  /** Skips the router for the template, like a `fix:` or `research:` prefix. */
  template?: PlaybookName;
  text: string;
};

export type IntakeSubmitOutput = {
  echo?: IntakeEcho;
  /** Why no lead has the order yet, with the fix; absent when the project's lead has it or is starting. */
  leadWaiting?: string;
  next?: string;
  truncated?: boolean;
  workstreamId: WorkstreamId;
};

export type InventoryInput = {
  machineId: MachineId;
  projectId: ProjectId;
};

export type InventoryOutput = {
  /** The project's finish-all workstream went (or stayed) idle: nothing left with a value source. */
  idle: boolean;
  next?: string;
  /** Items with a value source that no open child serves yet. */
  spawnable: number;
  /** The ranked list, one item per line. */
  text: string;
  truncated?: boolean;
};

/** The observable stages an item passes on its way to verified, in order. Each is credited only once fleetd saw it. */
export type KnownItemStage =
  | "planned"
  | "brief_frozen"
  | "task_started"
  | "first_push"
  | "pr_open"
  | "review_passed"
  | "ci_green"
  | "merged"
  | "verified";
/** KnownItemStage, or a value from a newer hub. */
export type ItemStage = KnownItemStage | (string & {});

export type KindTotal = {
  kind: SpanKind;
  ms: number;
  n: number;
};

export type LaneStatus =
  | "queued"
  | "starting"
  | "working"
  | "stalled"
  | "idle"
  | "done"
  | "failed"
  | "cancelled"
  | "waiting"
  | "parked";

export type Lead = {
  lastWakeAt?: Timestamp;
  /** M4: the lead thread hit a usage limit; derived from the usage layer when read. */
  parked?: UsageParked;
  projectRef: ProjectRef;
  /** Bumped by each lead_restart. */
  sessionGeneration: number;
  startedAt: Timestamp;
  state: LeadState;
  /** The current lead thread on the project's machine; earlier ones stay on the node as history. */
  threadId: ThreadId;
};

export type LeadStartInput = {
  effort?: Effort;
  machineId: MachineId;
  /**
   * Saved as the project's lead model and effort for this and later (re)starts; absent keeps the saved or hub
   * default.
   */
  model?: string;
  projectId: ProjectId;
};

export type LeadStartOutput = {
  lastWakeAt?: Timestamp;
  next?: string;
  /** M4: the lead thread hit a usage limit; derived from the usage layer when read. */
  parked?: UsageParked;
  projectRef: ProjectRef;
  /** Bumped by each lead_restart. */
  sessionGeneration: number;
  startedAt: Timestamp;
  state: LeadState;
  /** The current lead thread on the project's machine; earlier ones stay on the node as history. */
  threadId: ThreadId;
  truncated?: boolean;
};

export type LeadState = "starting" | "idle" | "working" | "stalled" | "stopped";

/**
 * Hub -> app on the live subscription. Board lanes at most 1/s, focus lanes and text at most 4/s; machines at most
 * every 5 s and slots at most 1/s, each only when changed. A slow link skips frames (latest wins), never queues them.
 */
export type LiveFrame = {
  /** The hub's clock; the app derives its skew from it. */
  at: Timestamp;
  /** The first frame after a (re)subscribe: every lane in scope. Lanes not in a full frame are gone. */
  full: boolean;
  lanes: LiveLane[];
  /** Present when any machine changed (always in a full frame). */
  machines?: MachineLive[];
  /** Present when the slot board changed (always in a full frame, once the hub runs slots). */
  slots?: SlotState;
  /** Focus only. */
  text?: LiveText[];
};

/** One lane's live values. In a frame that is not `full`, only lanes that changed are sent. */
export type LiveLane = {
  /** Absent: nothing to say (no run active, or no recent model output; the UI says no more than the status). */
  activity?: ActivityNow;
  laneId: string;
  /** Absent: unchanged since the last frame (always present in a `full` frame for lanes that have one). */
  spark?: Spark;
  status: LaneStatus;
  tokens?: Tokens;
};

/**
 * Streamed assistant text of the focused order's lanes and lead: append to `message_id`'s text. The complete
 * message replaces it when the thread tail is refetched.
 */
export type LiveText = {
  append: string;
  laneId: string;
  messageId: string;
};

/** Read from the runner's login kind, never from credentials. */
export type LoginKind = "subscription" | "api_key" | "custom_base_url" | "unknown";

/** One claude.ai usage window, as claude's `rate_limit_event` last reported it. */
export type LoginLimit = {
  /** claude's own name for the window, e.g. "five_hour", "seven_day". */
  limitType: string;
  /** When claude reported it; absent from older nodes. Without it a reading's age is unknown. */
  observedAt?: Timestamp;
  resetsAt?: Timestamp;
  /** allowed, allowed_warning or rejected. */
  status: string;
  /** 0 to 1 as claude sends it; absent when it sent none. */
  utilization?: number;
};

export type LongestWait = {
  /** The ask's key, or the tool for a permission prompt. */
  label?: string;
  ms: number;
  spanId: number;
};

export type Machine = {
  /**
   * M8: the node's X25519 key from its hello; clients seal this machine's secrets to it. Absent: it takes no
   * secrets.
   */
  boxPubKey?: BoxPublicKey;
  /** Plain language, set while status is "degraded". */
  degradedReason?: string;
  lastSeenAt: Timestamp;
  /** The machine's latest sleep its node reported on waking. */
  lastSlept?: SleptSpan;
  machineId: MachineId;
  name: string;
  nodeVersion: string;
  status: MachineStatus;
  tags: string[];
};

/** Machine slug, [a-z0-9-]{1,32} */
export type MachineId = string;

/** A machine's load and running agents, from its heartbeat (every 15 s) and the hub's executors. */
export type MachineLive = {
  asOf: Timestamp;
  /** Absent: the node does not report load (older node, or the read failed). Show no load then. */
  load?: NodeLoad;
  machineId: MachineId;
  name: string;
  /** Agent turns running there now. */
  running: number;
  /** Its latest sleep; show it while recent ([`crate::model::SleptSpan::recent_text`]). */
  slept?: SleptSpan;
  status: MachineStatus;
};

/** One machine's part of `project_discover`. */
export type MachineRepos = {
  /**
   * Where a clone onto this machine goes by default: the first of ~/src, ~/code, ~/projects that exists, else
   * ~/src. Absolute.
   */
  cloneRoot?: string;
  machineId: MachineId;
  online: boolean;
  /** Why this machine could not be scanned (offline, an older node), with its fix. */
  problem?: ProjectProblem;
  repos: FoundRepo[];
};

/** `machine.slept`: epoch milliseconds. */
export type MachineSleptData = {
  fromMs: number;
  toMs: number;
};

export type MachineStatus = "online" | "offline" | "degraded";

/** A change to a figure's denominator, shown next to it. */
export type Marker = {
  at: Timestamp;
  deltaItems: number;
  pctAfter?: number;
  pctBefore?: number;
  /** "+3 items: time inspector added". */
  text: string;
};

/** How the default branch may be merged into. */
export type MergeRules = {
  /** Branch protection or an active ruleset applies to the default branch. */
  protected: boolean;
  /** Approving reviews a pull request needs. */
  requiredReviews?: number;
  /** Active rulesets that apply to the default branch, by name. */
  rulesets: string[];
  /** Absent when gh could not read the repository settings. */
  squashAllowed?: boolean;
  /** Pull requests must be up to date with the base before merging. */
  strict?: boolean;
};

/** The judge's reported numbers for the brief's metric. */
export type MetricValues = {
  baseline: number;
  candidate: number;
};

export type MilestoneId = string;

export type MilestoneState = "open" | "done";

/** A milestone with its derived figure. */
export type MilestoneView = {
  createdAt: Timestamp;
  doneAt?: Timestamp;
  /** Retired with the ETA: always absent. */
  eta?: StatusEta;
  /** The first item's time; scope changes within 10 minutes of it carry no marker. */
  firstItemAt?: Timestamp;
  milestoneId: MilestoneId;
  position: number;
  progress: Progress;
  projectRef: ProjectRef;
  state: MilestoneState;
  title: string;
};

/** How many rows each capped list left out. */
export type MoreCounts = {
  done: number;
  inProgress: number;
  next: number;
  parts: number;
  risks: number;
  stale: number;
};

export type NeedsYou = {
  count: number;
  /** Open secret and approval requests, shown inline in the project's chat. */
  requestIds: ChatRequestId[];
};

export type NextRow = {
  /** Open items it waits on. */
  after: PlanItemId[];
  itemId: PlanItemId;
  title: string;
  workstreamId?: WorkstreamId;
};

/** What a machine reports about itself with each heartbeat. */
export type NodeLoad = {
  /** Logical CPUs. */
  cpus: number;
  /**
   * The latest claude.ai subscription limit of each type claude reported. Empty behind API keys and gateways,
   * which send none.
   */
  limits?: LoginLimit[];
  /** The 1-minute load average. */
  load1: number;
  /** Memory in use (total minus available), percent. */
  memUsedPct?: number;
};

export type OrchestratorKind = "orchestrator";

/** A `claude -p` one-shot the hub ran for itself, counted as orchestrator usage. */
export type OrchestratorRun = {
  durationMs: number;
  error?: string;
  inputTokens?: number;
  kind: OrchestratorKind;
  model: string;
  ok: boolean;
  outputTokens?: number;
};

/** One order (workstream) as the board shows it. */
export type OrderCard = {
  createdAt: Timestamp;
  /** Active first, then newest; finished lanes are left out on the board. */
  lanes: AgentLane[];
  /** Open asks for it. */
  needsYou: number;
  /** The lead's headline. */
  next?: string;
  phase: OrderPhase;
  /** "3 working", "#212 in CI", "1 question". */
  phaseDetail?: string;
  projectRef: ProjectRef;
  prs: PrRef[];
  /** Agents done, failed or cancelled, of `total`. */
  settled: number;
  state: WorkstreamState;
  template?: PlaybookName;
  title: string;
  total: number;
  updatedAt: Timestamp;
  workstreamId: WorkstreamId;
};

export type OrderGetInput = {
  workstreamId: WorkstreamId;
};

export type OrderGetOutput = {
  /** Newest first. */
  claims?: Claim[];
  /** Newest first. */
  doneLanes: AgentLane[];
  /** Its project's lead (shared by every order of the project); absent when the project has none. */
  lead?: AgentLane;
  next?: string;
  order: OrderCard;
  /** Its open secret and approval requests. */
  requests: HumanRequest[];
  truncated?: boolean;
};

export type OrderNoteInput = {
  attachments?: AttachmentId[];
  clientRequestId: string;
  refs?: IntakeRef[];
  text: string;
  urgent?: boolean;
  workstreamId: WorkstreamId;
};

export type OrderNoteOutput = {
  next?: string;
  /** "N" plus a number; the workstream.note event carries it. */
  noteId: string;
  /** The steer the note was sent as; its receipts arrive as `steer.*` events. */
  steerId?: SteerId;
  truncated?: boolean;
  /** The lead's wake that will carry it: now for urgent notes, else after the wake debounce. */
  wakesAt: Timestamp;
};

/** An order's phase: the first match in this order wins, and the board sorts by it. */
export type OrderPhase =
  | "failed"
  | "stopped"
  | "done"
  | "waiting_on_you"
  | "working"
  | "reviewing"
  | "merging"
  | "verifying"
  | "queued"
  | "planning"
  | "idle";

export type OrderStopInput = {
  reason?: string;
  workstreamId: WorkstreamId;
};

export type OrderStopOutput = {
  /** Tasks this call cancelled (0 when it was already stopped). */
  cancelled: number;
  next?: string;
  state: WorkstreamState;
  truncated?: boolean;
};

export type OrdersBoardInput = {
  includeDoneSince?: Timestamp;
  projectRef?: ProjectRef;
};

export type OrdersBoardOutput = {
  at: Timestamp;
  next?: string;
  /** By phase, then most recently updated. */
  orders: OrderCard[];
  trains: TrainLive[];
  truncated?: boolean;
};

export type ParkedCounts = {
  leads: number;
  tasks: number;
};

/** Full lowercase hex patch id, 40 or 64 characters */
export type PatchId = string;

export type PathSegment = {
  cat: Category;
  endMs: number;
  kind: SpanKind;
  label?: string;
  lane: string;
  /** Absent on a "nothing running" gap. */
  spanId?: number;
  startMs: number;
};

export type Period = {
  since: Timestamp;
  until: Timestamp;
};

/** The numbers of one period, for a comparison. */
export type PeriodBreakdown = {
  agentMs: number;
  byCategory: CategoryTotal[];
  since: Timestamp;
  until: Timestamp;
  wallMs: number;
};

export type PermissionAnswer = "allow" | "deny";

/** A `{{name}}` the code fills in. A required one missing from an edit gets a warning. */
export type Placeholder = {
  description: string;
  name: string;
  required: boolean;
};

/** One marker: a recorded change to a figure's denominator, never a silent jump. */
export type PlanChange = {
  at: Timestamp;
  /** `lead:<projectRef>`, a key id, or `hub`. */
  by: string;
  deltaItems: number;
  /** In points. */
  deltaSize: number;
  kind: PlanChangeKind;
  milestoneId: MilestoneId;
  /** "+3 items: time inspector added". */
  note: string;
  pctAfter?: number;
  pctBefore?: number;
  workstreamId?: WorkstreamId;
};

export type PlanChangeKind = "scope" | "reopened" | "closed" | "milestone_done" | "milestone_reopened";

/** `plan.changed`: a marker was written. */
export type PlanChangedData = {
  at: Timestamp;
  /** `lead:<projectRef>`, a key id, or `hub`. */
  by: string;
  deltaItems: number;
  /** In points. */
  deltaSize: number;
  kind: PlanChangeKind;
  milestoneId: MilestoneId;
  /** "+3 items: time inspector added". */
  note: string;
  pctAfter?: number;
  pctBefore?: number;
  workstreamId?: WorkstreamId;
};

export type PlanGetInput = {
  projectRef?: ProjectRef;
  workstreamId?: WorkstreamId;
};

/** A plan as `plan show` and `plan_get` return it: derived state, figures and markers. */
export type PlanGetOutput = {
  /** Retired with the ETA: always absent. */
  eta?: StatusEta;
  items: PlanItem[];
  /** Newest first. */
  markers: PlanChange[];
  milestones: MilestoneView[];
  next?: string;
  progress: Progress;
  projectRef: ProjectRef;
  truncated?: boolean;
  /** Set when the view is one order's items. */
  workstreamId?: WorkstreamId;
};

export type PlanItem = {
  /** Items that must be done before this one starts: serial gates. */
  after?: PlanItemId[];
  doneAt?: Timestamp;
  /** Why it was dropped. */
  dropReason?: string;
  /** What verified it, e.g. "#212 merged by the train · check 2 passed C9". */
  evidence?: string;
  itemId: PlanItemId;
  links?: PlanLinks;
  milestoneId: MilestoneId;
  position: number;
  projectRef: ProjectRef;
  size: Size;
  /** The first linked `task.started`. */
  startedAt?: Timestamp;
  state: PlanItemState;
  title: string;
  weight: Weight;
  workstreamId?: WorkstreamId;
};

export type PlanItemId = string;

export type PlanItemState = "open" | "dropped" | "done";

/** What ties work to an item. An item with no links never counts done. */
export type PlanLinks = {
  /** Done-when indices of the item's order that must pass in its latest claim. */
  checks?: number[];
  /** PRs listed on the item (`--pr`, or `change enqueue --item`). */
  prs?: GitHubPrUrl[];
  /** Tasks spawned with `--item`; their Changes count through `Change.task_id`. */
  tasks?: TaskId[];
};

/** `plan.verified`: the hub marked an item done. */
export type PlanVerifiedData = {
  evidence: string;
  itemId: PlanItemId;
  milestoneId: MilestoneId;
  workstreamId?: WorkstreamId;
};

/** Planning counts: while the lead plans (no plan items yet) it has its own small bar, not 0%. */
export type PlanningState = {
  /** The lead is still planning: the order has no plan items yet. */
  active: boolean;
  /** The planning bar: elapsed over the usual planning time, at most 90 while active, 100 once the plan exists. */
  pct: number;
  /** Planning's share of the order's work, fixed when the plan appears. */
  sharePct: number;
  since: Timestamp;
};

export type PlaybookChangeKind = "wording" | "gate";

/** The prefixes `bug:`/`fix:`, `research:` and `finish:` pick bugfix, research and finish-all. */
export type PlaybookName = "bugfix" | "feature" | "research" | "finish-all";

/** <playbook name>@<full lowercase hex git blob SHA> */
export type PlaybookRef = string;

/** One PR on a train strip. */
export type PrChip = {
  changeId: ChangeId;
  number: number;
  /** 0-based; absent for the head (being rebased, checked or merged) and for PRs merged today. */
  position?: number;
  state: ChangeState;
  url: GitHubPrUrl;
  workstreamId: WorkstreamId;
};

/** One PR of an order. */
export type PrRef = {
  changeId: ChangeId;
  number: number;
  /** 0-based place in its train's queue; absent when not queued. */
  position?: number;
  repo: GitHubRepo;
  /** Clean reviews of the current patch. */
  reviewsDone: number;
  /** What the tier asks for. */
  reviewsNeeded: number;
  state: ChangeState;
  /** The task that opened it (its writer), when the hub knows: the board groups the PR's checkers under it. */
  taskId?: TaskId;
  url: GitHubPrUrl;
};

/** A figure. `pct` counts verified must items by size only; polish shows beside it. */
export type Progress = {
  asOf: Timestamp;
  /** Must items done and in the figure. */
  done: number;
  /** The estimate the headline shows: verified work plus credit for the observed stages of work in flight. */
  estimate?: ProgressEstimate;
  /** The latest scope change, e.g. "↓ from 80% · +3 items: time inspector added". */
  marker?: Marker;
  /** floor(100 · must points done / must points open or done); the polish figure when there are no must items. */
  pct: number;
  /** Polish items done and in the figure ("polish 2/5"). */
  polishDone: number;
  polishPct?: number;
  polishTotal: number;
  stale?: StaleMark;
  total: number;
};

/** Why the estimate fell, shown as a marker on the sparkline. */
export type ProgressDrop = {
  fromPct: number;
  reason: DropReason;
  /** "CI failed on #212", "+2 items: time inspector added". */
  text: string;
};

/**
 * The headline estimate and its two-tone bar: solid is what fleetd verified, lighter is in-flight credit. Every
 * stage it credits is one fleetd observed (an event, a PR or a CI state), never an agent's word.
 */
export type ProgressEstimate = {
  /** The lighter part: credit for open items' reached stages, smoothed within the current stage. */
  inFlightPct: number;
  /** verified + in flight, floored; 100 only when everything is verified. */
  pct: number;
  /** Present for an order while its lead plans, and after (with its fixed share). */
  planning?: PlanningState;
  /** The doc's own scope only: the estimate over time, oldest first. A drop carries its reason. */
  series?: ProgressPoint[];
  /** The solid part: must points verified over must points (planning share included once fixed). */
  verifiedPct: number;
  /** Where the stage weights came from. */
  weights: WeightsBasis;
};

/** One point of the progress series. */
export type ProgressPoint = {
  at: Timestamp;
  /** Set when the estimate fell at this point; it never falls without one. */
  drop?: ProgressDrop;
  pct: number;
  verifiedPct: number;
};

/** `HubEvent.data` on `project.add_failed`: a clone that was accepted, then failed. */
export type ProjectAddFailedData = {
  addId: string;
  code: ProjectProblemCode;
  fix?: string;
  message: string;
  path: string;
  repo?: GitHubRepo;
};

export type ProjectAddInput = {
  /** With `url`: clone here instead of `<cloneRoot>/<name>`. */
  dest?: string;
  /** Absent: the best worker (see `project_discover.best`). */
  machineId?: MachineId;
  path?: string;
  /** Absent means the directory's name. */
  title?: string;
  /** A GitHub URL, `git@github.com:o/r.git`, or `owner/repo`. */
  url?: string;
  /** With `url`: when the destination is already a checkout of the same repository, add it instead of failing. */
  useExisting?: boolean;
};

export type ProjectAddOutput = {
  /** A clone was started: its `project.clone_progress`, `project.added` and `project.add_failed` events carry it. */
  addId?: string;
  /** False when the directory was already a project (it is renamed when a title is given). */
  created: boolean;
  /** For a path, at once; for a clone, on `project.added`. */
  inspect?: ProjectInspect;
  machineId: MachineId;
  next?: string;
  /** The project's directory (the clone's destination for a url). */
  path: string;
  /** Absent while a clone runs: `project.added` carries it. */
  projectId?: ProjectId;
  truncated?: boolean;
};

/** `HubEvent.data` on `project.added`, for every add (a path or a clone). */
export type ProjectAddedData = {
  /** Absent when the add registered an existing directory. */
  addId?: string;
  /** False when the directory was already a project. */
  created: boolean;
  /** Long lists are cut so the event fits the log's 2 KB of data; `project_inspect` returns them whole. */
  inspect: ProjectInspect;
  path: string;
  title: string;
};

/** One chat's state, for the sidebar and the status row. */
export type ProjectChatState = {
  lastMessageAt?: Timestamp;
  /** The newest message's `seq`; 0 for an empty chat. */
  lastSeq: number;
  /** The lead is mid-turn. */
  leadWorking: boolean;
  /** The lead's last message waits for a human reply, or an inline item is open. */
  needsYou: boolean;
  projectRef: ProjectRef;
};

export type ProjectDiscoverInput = {
  /** Include `gh repo list` (default true). */
  github?: boolean;
  /** Scan only this machine; absent: every machine. */
  machineId?: MachineId;
};

export type ProjectDiscoverOutput = {
  /** The machine a clone goes to by default: online, runner ready, fewest running threads. Absent: none is. */
  best?: MachineId;
  github: GitHubRepos;
  machines: MachineRepos[];
  next?: string;
  truncated?: boolean;
};

export type ProjectFilesInput = {
  limit?: number;
  machineId: MachineId;
  projectId: ProjectId;
  query?: string;
};

export type ProjectFilesOutput = {
  next?: string;
  /** Repo-relative. */
  paths: string[];
  truncated?: boolean;
};

export type ProjectGetInput = {
  machineId: MachineId;
  projectId: ProjectId;
};

export type ProjectId = string;

/** What `project_inspect` found: the default branch, CI and merge rules, and one line on what the lead will need. */
export type ProjectInspect = {
  ci: CiInfo;
  defaultBranch?: string;
  /** One line for a person, e.g. "no CI found: the merge train will only use local checks". */
  leadNeeds: string;
  merge: MergeRules;
  /** What could not be read, e.g. "branch rules need admin access on acme/storefront". */
  notes: string[];
  /** Absent for a checkout without a GitHub remote. */
  repo?: GitHubRepo;
};

export type ProjectInspectInput = {
  machineId?: MachineId;
  path?: string;
  /** A GitHub URL, `git@github.com:o/r.git`, or `owner/repo`. */
  url?: string;
};

/** What `project_inspect` found: the default branch, CI and merge rules, and one line on what the lead will need. */
export type ProjectInspectOutput = {
  ci: CiInfo;
  /** With `url` and a machine (given, or the best one): where `project_add` would clone it. */
  clone?: CloneTarget;
  defaultBranch?: string;
  /** One line for a person, e.g. "no CI found: the merge train will only use local checks". */
  leadNeeds: string;
  merge: MergeRules;
  next?: string;
  /** What could not be read, e.g. "branch rules need admin access on acme/storefront". */
  notes: string[];
  /** Absent for a checkout without a GitHub remote. */
  repo?: GitHubRepo;
  truncated?: boolean;
};

/** The one-call project outcome, returned as-is by project_get. */
export type ProjectOutcome = {
  asOf: Timestamp;
  /** Absent until lead_start. */
  lead?: Lead;
  /** Hint for the next call. */
  next?: string;
  project: ProjectSummary;
  stale: boolean;
  /** Absent until the project has a task. */
  taskCounts?: TaskCounts;
  /** Newest first. */
  tasks?: Task[];
  /** Newest activity first. Task threads are left out; they show under `tasks`. */
  threads: ThreadSummary[];
  /** The merge trains of the project's repos; absent until one of its PRs was enqueued. */
  trains?: TrainState[];
  /** True when `threads`, `workstreams` or `tasks` was trimmed to its limit. */
  truncated?: boolean;
  /** Open workstreams (not done, stopped or failed), newest first. */
  workstreams?: Workstream[];
};

/** Why something could not be done, and the one step that fixes it. */
export type ProjectProblem = {
  code: ProjectProblemCode;
  fix?: string;
  message: string;
};

export type ProjectProblemCode =
  | "other"
  | "machine_offline"
  | "no_worker"
  | "gh_unavailable"
  | "gh_no_access"
  | "path_missing"
  | "not_a_git_repo"
  | "dest_exists"
  | "clone_failed"
  | "node_too_old";

export type ProjectRef = {
  machineId: MachineId;
  projectId: ProjectId;
};

export type ProjectRemoveInput = {
  machineId: MachineId;
  projectId: ProjectId;
};

export type ProjectRemoveOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

export type ProjectStopInput = {
  projectRef: ProjectRef;
  reason?: string;
};

export type ProjectStopOutput = {
  /** Tasks this call cancelled. */
  cancelled: number;
  /** The system line it wrote into the chat. */
  message: ChatMessage;
  next?: string;
  /** Orders this call stopped. */
  stopped: number;
  truncated?: boolean;
};

export type ProjectSummary = {
  lastActivityAt: Timestamp;
  machineId: MachineId;
  projectId: ProjectId;
  threads: ThreadCounts;
  title: string;
  workspaceRoot: string;
};

export type ProjectsListInput = {
  machineId?: MachineId;
  query?: string;
};

export type ProjectsListOutput = {
  next?: string;
  projects: ProjectSummary[];
  truncated?: boolean;
};

/** `prompt.changed`. */
export type PromptChangedData = {
  id: string;
  projectRef?: ProjectRef;
  /** Absent on a reset. */
  ref?: string;
  scope: PromptScope;
  /** The warnings' codes. */
  warnings?: string[];
};

export type PromptGetInput = {
  id: PromptId;
  projectRef?: ProjectRef;
};

/** `prompt_get`: every level of one prompt for the asked project (or hub-wide). */
export type PromptGetOutput = {
  default: PromptVersion;
  effective: PromptVersion;
  global?: PromptOverride;
  group: PromptGroup;
  id: PromptId;
  kind: PromptKind;
  next?: string;
  /** False for playbooks, router and retro: they have the hub-wide level only. */
  perProject: boolean;
  placeholders: Placeholder[];
  project?: PromptOverride;
  /** The default's rules, with `present` for `effective`. */
  safetyRules: SafetyRule[];
  /** The scope of `effective`. */
  scope: PromptScope;
  sentWhen: string;
  stale?: StalePrompt;
  title: string;
  truncated?: boolean;
  warnings: PromptWarning[];
};

/** Where the app lists it. */
export type PromptGroup =
  | "lead"
  | "tasks"
  | "reviews_and_checks"
  | "wakes_and_messages"
  | "one_shots"
  | "playbooks"
  | "instructions";

/** Prompt registry id, dotted lowercase words */
export type PromptId = string;

/** How the text reaches the model. */
export type PromptKind = "start" | "wake" | "msg" | "oneshot" | "playbook" | "instructions";

/** A human's override: its text and the default it was edited from (absent for a hand-made file). */
export type PromptOverride = {
  base?: PromptRef;
  ref: PromptRef;
  text: string;
};

/** <prompt id>@<10 lowercase hex of the text's git blob SHA> */
export type PromptRef = string;

export type PromptResetInput = {
  id: PromptId;
  projectRef?: ProjectRef;
  scope: PromptScope;
};

export type PromptResetOutput = {
  effective: PromptVersion;
  next?: string;
  scope: PromptScope;
  truncated?: boolean;
};

/** Which text is meant: the one shipped in the binary, the hub-wide override, or one project's override. */
export type PromptScope = "default" | "global" | "project";

export type PromptSetInput = {
  /** The default ref the text was edited from (`prompt_get` default.ref); absent: the one shipped now. */
  base?: PromptRef;
  /** Return the warnings without saving. */
  dryRun?: boolean;
  id: PromptId;
  /** Required with scope project. */
  projectRef?: ProjectRef;
  scope: PromptScope;
  /** May be empty only for `instructions`. */
  text: string;
};

export type PromptSetOutput = {
  next?: string;
  ref: PromptRef;
  truncated?: boolean;
  /** What the edit may break; it is saved anyway. */
  warnings: PromptWarning[];
};

/** A row of `prompts_list`. */
export type PromptSummary = {
  defaultRef: PromptRef;
  group: PromptGroup;
  id: PromptId;
  kind: PromptKind;
  /** The override in effect, when `scope` is not `default`. */
  overrideRef?: PromptRef;
  /** Which text is in effect for the asked project (or hub-wide). */
  scope: PromptScope;
  sentWhen: string;
  stale: boolean;
  title: string;
};

/** One exact text. */
export type PromptVersion = {
  ref: PromptRef;
  text: string;
};

/** What an edit may break. Never a refusal: the text is saved anyway. */
export type PromptWarning = {
  code: PromptWarningCode;
  enforced?: Enforcement;
  message: string;
  /** `placeholder_*`: its name. */
  placeholder?: string;
  /** `safety_rule_missing`: the rule's id and who still enforces it. */
  rule?: string;
};

export type PromptWarningCode = "placeholder_missing" | "placeholder_unknown" | "safety_rule_missing" | "too_long";

export type PromptsListInput = {
  /** The texts in effect for this project; absent: hub-wide. */
  projectRef?: ProjectRef;
};

export type PromptsListOutput = {
  next?: string;
  prompts: PromptSummary[];
  truncated?: boolean;
};

export type QuietWindow = {
  from: Timestamp;
  to: Timestamp;
};

/** Counted by the hub from the task's thread items, never from its prose. */
export type Receipts = {
  commands: number;
  commandsFailed: number;
  filesChanged: number;
  toolCalls: number;
};

export type RepeatStat = {
  label: string;
  /** Runs in a row with no edit between them. */
  n: number;
  taskId?: TaskId;
  threadId: ThreadId;
  totalMs: number;
};

/** `request.opened`, `request.updated`. */
export type RequestEventData = {
  /** Who answered it ("human:<device>"), once someone did. */
  by?: string;
  kind: RequestKind;
  requestId: ChatRequestId;
  state: RequestState;
  /** The order it is about, when it is about one. */
  workstreamId?: WorkstreamId;
};

/**
 * What a lead needs a person for that chat can't carry safely: a secret value (entered in a masked field and sealed to
 * the sink's node, never in a transcript), or an approval of a risky command (a gated run, or a session's tool
 * prompt). The lead asks everything else in chat.
 */
export type RequestKind = "secret" | "approval";

/**
 * The state names of the chat items that show it (`SecretRequestState`, `CommandApprovalState`). secret: open →
 * stored | withdrawn. approval: open → approved → ran | failed, or open → denied; an approval the node could not run
 * goes back to open with the reason in `evidence`.
 */
export type RequestState = "open" | "stored" | "withdrawn" | "approved" | "denied" | "ran" | "failed";

export type RequestsListInput = {
  limit?: number;
  projectRef?: ProjectRef;
  /** Absent: every state. */
  state?: RequestState;
};

export type RequestsListOutput = {
  next?: string;
  requests: HumanRequest[];
  truncated?: boolean;
};

/** STOP is a success: the question was answered. */
export type ResearchOutcome = "go" | "stop" | "inconclusive";

/** Computed by the hub, never reported by an agent; `outcome` always follows from `rule` and `metricValues`. */
export type ResearchVerdict = {
  computedAt: Timestamp;
  metricValues: MetricValues;
  outcome: ResearchOutcome;
  /** The brief's frozen rule. */
  rule: DecisionRule;
};

export type RetroMetric = {
  class: RetroMetricClass;
  op: Decrease;
  /** Measured over this many days after the change, against the same span before it. */
  windowDays: number;
};

/**
 * The fixed metric list, defined in code: incident counts per class, and agent-minutes per done workstream. A
 * proposal names one; the retro cannot add or change them.
 */
export type RetroMetricClass =
  | "false_claim"
  | "polish_loop"
  | "misfiled_ask"
  | "out_of_area"
  | "stall"
  | "policy_bypass"
  | "re_ask"
  | "override"
  | "agent_minutes_per_done"
  | "estimate_miss";

export type RetroProposal = {
  appliedAt?: Timestamp;
  at: Timestamp;
  /** The window before it applied; `measured` is the window after. */
  baseline?: RetroSnapshot;
  /** What the model said it was. */
  claimedKind: PlaybookChangeKind;
  /** A gate change: the global decision a person records to settle it, `playbook.<name>.<hash>` = apply | reject. */
  decisionKey?: DecisionKey;
  diff: string;
  /** When a wording change's window ends and its metric is computed. */
  dueAt?: Timestamp;
  expected: string;
  /** Frontmatter fields the diff changes, plus "body". */
  fields: string[];
  fixesIncidents: IncidentId[];
  /** Decided by the hub from the fields the diff touches. */
  kind: PlaybookChangeKind;
  measured?: RetroSnapshot;
  metric: RetroMetric;
  note?: string;
  playbook: PlaybookName;
  previousRef?: PlaybookRef;
  proposalId: RetroProposalId;
  /** The version it applied and the one it replaced. */
  ref?: PlaybookRef;
  /** The retro run that proposed it. */
  run: number;
  state: RetroProposalState;
};

export type RetroProposalId = string;

/**
 * suggested: advise-only, nothing applies. pending: a gate change waiting for a person to record its decision.
 * measuring: a wording change applied, its window running; then kept or reverted. applied: a gate change a person
 * approved. rejected: a person said no. stale: the playbook changed under it, so its diff no longer applies.
 */
export type RetroProposalState = "suggested" | "measuring" | "kept" | "reverted" | "applied" | "rejected" | "stale" | "pending";

export type RetroProposalsInput = {
  limit?: number;
  state?: RetroProposalState;
};

export type RetroProposalsOutput = {
  /** The global Decision policy.retro.apply is true: wording changes apply on their own and gate changes wait for a person's decision. */
  apply: boolean;
  lastRun?: RetroRun;
  next?: string;
  /** Newest first. */
  proposals: RetroProposal[];
  truncated?: boolean;
};

export type RetroRun = {
  /** Nothing it proposed applies: `--advise`, or `policy.retro.apply` is not true. */
  advise: boolean;
  at: Timestamp;
  dropped: RetroRunDropped[];
  /** Incidents in the window it was given. */
  incidents: number;
  proposals: RetroProposalId[];
  run: number;
  trigger: RetroTrigger;
  /** Absent when there was nothing to look at and no turn ran. */
  usage?: OrchestratorRun;
  windowDays: number;
};

/** A change the hub refused, with why. */
export type RetroRunDropped = {
  index: number;
  playbook?: string;
  reason: string;
};

export type RetroRunInput = {
  /** Propose only, even when policy.retro.apply is true. */
  advise?: boolean;
  windowDays?: number;
};

export type RetroRunOutput = {
  next?: string;
  proposals: RetroProposal[];
  run: RetroRun;
  truncated?: boolean;
};

/**
 * A metric's values over one window; agent-minutes is null when no workstream finished in it. Its keys are
 * snake_case on the wire.
 */
export type RetroSnapshot = {
  agent_minutes_per_done: number | null;
  false_claim: number;
  polish_loop: number;
  target: number | null;
};

export type RetroTrigger = "weekly" | "threshold" | "manual";

export type Risk = {
  level: RiskLevel;
  message: string;
  rule: RiskRule;
};

export type KnownRiskLevel = "danger" | "warning";
/** KnownRiskLevel, or a value from a newer hub. */
export type RiskLevel = KnownRiskLevel | (string & {});

export type KnownRiskRule =
  | "ci_red_main"
  | "machine_offline"
  | "blocked_on_you"
  | "riskiest_item"
  | "ci_red_repeat"
  | "machine_flaky"
  | "usage_high"
  | "slots_full"
  | "github_drift"
  | "no_plan"
  | "slipping"
  | "estimate_drift"
  | "steer_unacknowledged"
  | "slower_than_usual"
  | "train_stuck";
/** KnownRiskRule, or a value from a newer hub. */
export type RiskRule = KnownRiskRule | (string & {});

export type RuntimeMode = "full-access" | "approval-required";

/** A rule the default text carries, found in a text by `needle` (a case-insensitive regex). */
export type SafetyRule = {
  enforced: Enforcement;
  /** Stable, e.g. `secrets-via-ask`. */
  id: string;
  label: string;
  needle: string;
  /** In `PromptDetail`: whether the effective text still matches `needle`. */
  present?: boolean;
};

/** A child figure: the fleet's projects, a project's milestones, an order's milestones. */
export type ScopePart = {
  /** Retired with the ETA: always absent. */
  eta?: Timestamp;
  milestoneId?: MilestoneId;
  progress: Progress;
  /** Open it as its own scope (projects and orders). */
  scope?: StatusScope;
  title: string;
};

export type SealedSecret = string;

export type SecretEnvEntry = {
  name: EnvName;
  secretKey: DecisionKey;
};

/** 8 lowercase hex characters: the sha256 prefix of the plaintext */
export type SecretFingerprint = string;

/** A secret request: the secret's name and where the node writes it. */
export type SecretRequest = {
  /** An env: sink's variable, when not the one the key names (`secret_env_name`). */
  envName?: EnvName;
  /** Set once the node has written the sink; the value itself never reaches the hub in plain text. */
  fingerprint?: SecretFingerprint;
  /** The secret's name, a dotted slug such as "stripe.test_key". */
  key: DecisionKey;
  sink: SecretSink;
};

/**
 * The lead needs a secret. The app shows a masked field; the value never enters the transcript: it is sealed to the
 * sink's machine and answered with `secret_submit`, naming `requestId`. Only its fingerprint comes back.
 */
export type SecretRequestItem = {
  answeredAt?: Timestamp;
  /** The key name of the person who answered. */
  by?: string;
  /** An `env:` sink: the variable it writes, when not the one `name` gives (`secrets::secret_env_name`). */
  envName?: EnvName;
  /** Once stored. */
  fingerprint?: SecretFingerprint;
  /** The secret's key, e.g. `stripe.test_key`. */
  name: string;
  /** Why it is open again, or why it could not be stored. */
  note?: string;
  requestId: ChatRequestId;
  sink: SecretSink;
  state: SecretRequestState;
  /** One line: why the lead needs it. */
  text: string;
};

export type KnownSecretRequestState = "open" | "stored" | "withdrawn";
/** KnownSecretRequestState, or a value from a newer hub. */
export type SecretRequestState = KnownSecretRequestState | (string & {});

export type SecretSink = string;

export type SecretSubmitInput = {
  requestId: ChatRequestId;
  /** Sealed in the desktop app to the sink machine's `box_pub_key` (see Machine). */
  sealed: SealedSecret;
};

export type SecretSubmitOutput = {
  fingerprint: SecretFingerprint;
  next?: string;
  requestId: ChatRequestId;
  truncated?: boolean;
};

export type Serves = string;

/** `session_prompt_get`: exactly what a session was told at its start. */
export type SessionPrompt = {
  /** Tools the claude runner never offers a fleetd session. */
  disallowedTools: string[];
  machineId: MachineId;
  projectRef?: ProjectRef;
  refs: SessionPromptRef[];
  startedAt: Timestamp;
  /** The exact first message. */
  text: string;
  /** The text's full git blob SHA. */
  textSha: string;
  threadId: ThreadId;
};

export type SessionPromptGetInput = {
  machineId: MachineId;
  threadId: ThreadId;
};

export type SessionPromptGetOutput = {
  next?: string;
  session: SessionPrompt;
  truncated?: boolean;
};

/** One prompt a session pinned at its start; every later message to it renders from this text. */
export type SessionPromptRef = {
  id: PromptId;
  ref: PromptRef;
  scope: PromptScope;
};

/** Counts since the reading key last looked at this scope. Zero counts are hidden by clients. */
export type Since = {
  failed: number;
  merged: number;
  /** The mark is older than the event log keeps ("since more than 30 days"). */
  pruned?: boolean;
  /** Net items added (negative: dropped) by scope changes. */
  scopeItems: number;
  /** Absent: never looked (or not a human key). */
  seenAt?: Timestamp;
  seenSeq?: EventSeq;
  started: number;
  verified: number;
};

export type Size = "s" | "m" | "l";

/** A sleep a machine's node reported on waking, epoch milliseconds (the same fields as `machine.slept`). */
export type SleptAt = {
  fromMs: number;
  toMs: number;
};

/** A span a machine spent asleep, epoch milliseconds; `machine.slept` carries the same fields as its data. */
export type SleptSpan = {
  fromMs: number;
  toMs: number;
};

export type SlotState = {
  /** Global cap on running turns. */
  cap: number;
  perProject: SlotStatePerProject[];
  queued: number;
  /** Slots of the cap only lead turns may take. */
  reservedBand: number;
  used: number;
};

export type SlotStatePerProject = {
  projectRef: ProjectRef;
  share: number;
  used: number;
};

/**
 * Slot use the board measured over the last hour (or since the hub started, when that is later): held slot time,
 * never a projection. Serial waits behind free slots are `time_insights` findings.
 */
export type SlotUtilization = {
  /** floor(100 · slot time held / slot time the cap offered) over the window. */
  pct: number;
  /** The most slots held at once in the window. */
  peak: number;
  /** The window measured, at most an hour. */
  windowMs: number;
};

/** `source.fresh`. */
export type SourceFreshData = {
  source: string;
  /** How long it was stale. */
  staleMs: number;
};

/** `source.stale`. */
export type SourceStaleData = {
  reason: string;
  sinceMs: number;
  source: string;
};

/** A stored span, as the tools return it. */
export type Span = {
  cat: Category;
  /** Absent while open. */
  endMs?: number;
  /** Exclusive time: the part no child covers. Absent while open and on envelopes. */
  exclMs?: number;
  exitCode?: number;
  extra?: SpanExtra;
  /** The program, e.g. "cargo test", "git push", "Read", "mcp__x__y". */
  family?: string;
  id: number;
  /** The item id in the thread (claude's tool_use or message id), for `thread_window`. */
  itemId?: string;
  kind: SpanKind;
  label?: string;
  /** `thread:<machine>/<thread>`, `change:<id>`, `asks:<order>`, `train:<repo>`, `fleet`, `order:<id>`. */
  lane: string;
  machineId?: MachineId;
  outBytes?: number;
  parent?: number;
  projectId?: ProjectId;
  runId?: string;
  startMs: number;
  status: SpanStatus;
  taskId?: TaskId;
  threadId?: ThreadId;
  workstreamId?: WorkstreamId;
};

/** Small per-kind facts. Every field is optional and bounded. */
export type SpanExtra = {
  /** Who answered, e.g. a key's label. Never a secret. */
  answeredBy?: string;
  attempt?: number;
  cap?: number;
  /** `ci.check`: the check name and its page. */
  check?: string;
  /** `tool.*`: claude's own figure for the call, when the result carries one. */
  claudeMs?: number;
  /** `gap`: how many spans were lost. */
  count?: number;
  decidedBy?: DecidedBy;
  durationApiMs?: number;
  /** `run`: the result line's `duration_ms` and `duration_api_ms`. */
  durationMs?: number;
  /** `wait.retry.api`: the HTTP status claude retried on. */
  httpStatus?: number;
  /** `wait.ask`: the ask's decision key. */
  key?: string;
  /** The node's own start stamp, kept when the clock offset was above 100 ms. */
  nodeStartMs?: number;
  outputTokens?: number;
  /** `slots.full`: the peak count of tasks queued for a slot, and the cap. */
  peakQueued?: number;
  /** Free text from the source, e.g. a queue reason or a stop reason. */
  reason?: string;
  /** `wait.permission`: the node's request id, joined to the hub ask. */
  requestId?: string;
  /** `wait.retry.*`: the delay claude or the node announced. The span is the real wait. */
  statedDelayMs?: number;
  /** `model.message`. */
  stopReason?: string;
  thinkingTokens?: number;
  /** The tool's name, for tool and permission spans. */
  tool?: string;
  url?: string;
};

/**
 * What a span measures. Each kind belongs to exactly one [`Category`]. The code is the stored integer and
 * never changes; new kinds take new codes.
 */
export type SpanKind =
  | "model.thinking"
  | "model.output"
  | "tool.bash"
  | "tool.web"
  | "tool.mcp"
  | "tool.other"
  | "check.claim"
  | "wait.retry.api"
  | "wait.retry.node"
  | "run.startup"
  | "compaction"
  | "queue.slot"
  | "queue.lease"
  | "queue.usage"
  | "queue.offline"
  | "wake.debounce"
  | "park.usage"
  | "change.review"
  | "change.rebase"
  | "change.ci"
  | "change.merge"
  | "idle"
  | "run"
  | "model.message"
  | "model.first_token"
  | "tool.read"
  | "tool.edit"
  | "tools.parallel"
  | "git"
  | "claude.other"
  | "wait.offline"
  | "run.queued"
  | "slots.full"
  | "wait.permission"
  | "wait.ask"
  | "ask.batching"
  | "ask.info"
  | "change.queue"
  | "ci.check"
  | "ci.queue"
  | "change.blocked"
  | "intake.route"
  | "gap";

export type SpanStatus = "ok" | "failed" | "cancelled" | "incomplete";

/**
 * Work per 2 s bucket, oldest first, ending with the bucket that ends at `end_at`. A sample is
 * `min(255, 16 × items started + streamed chars / 32 + output tokens not streamed as text / 8)`; a bucket with
 * no frames is 0.
 */
export type Spark = {
  endAt: Timestamp;
  samples: number[];
};

/** Why a part is not live: its source went quiet past its cadence. */
export type StaleMark = {
  /** "no heartbeat from devbox for 4m", "GitHub not reached for 4m: …". */
  reason: string;
  /** The source's last good signal (a heartbeat, a GitHub answer, a train pass). */
  since: Timestamp;
};

/**
 * An override edited from an older default than the one this release ships. It stays in effect until the human
 * saves it again with `base` = `current.ref`, or resets it.
 */
export type StalePrompt = {
  /** The default it was edited from; absent when the file has no `base` or that text is unknown to this hub. */
  base?: PromptVersion;
  conflicts: boolean;
  current: PromptVersion;
  /** A line 3-way merge of base → current into yours; with `<<<<<<<` markers where they conflict. */
  merged: string;
  scope: PromptScope;
  yours: PromptVersion;
};

/**
 * A source that is stale now, `since` its last good signal. `source` is `machine:<m>`, `usage:<m>`, `ci:<repo>`,
 * `github:<repo>`, `train:<repo>` or
 * `webhook:<repo>`.
 */
export type StaleSource = {
  reason: string;
  since: Timestamp;
  source: string;
};

/** `"*"`: every event type or machine. */
export type Star = "*";

export type StatusDoc = {
  done: DoneRow[];
  eta: StatusEta;
  gates: Gate[];
  headline: Headline;
  health: Health;
  inProgress: InProgressRow[];
  /** Newest first. */
  markers: Marker[];
  more: MoreCounts;
  needsYou: NeedsYou;
  next: NextRow[];
  /** The hub clock when the doc was rendered. */
  now: Timestamp;
  parts: ScopePart[];
  progress: Progress;
  risks: Risk[];
  scope: StatusScope;
  /** The event log's head the doc reflects; `status_seen` records it. */
  seq: EventSeq;
  since: Since;
  stale: StaleSource[];
  /** "Fleet", the project's title or the order's. */
  title: string;
  /** Bumps whenever the doc's content changes; `status_wait` waits past it. */
  version: number;
  /** The order's tier when the scope is an order with no plan items. */
  virtualTier?: Tier;
};

/**
 * Retired: fleetd shows no time estimates (progress, the critical path and "slower than usual" instead). The hub
 * sends `{ samples: 0, basis: "none" }` so apps from before the change still decode the doc; every other field is
 * absent.
 */
export type StatusEta = {
  basis: EtaBasis;
  /** The serial chain that sets `current` when it is later than throughput says, e.g. "P12 full lab run". */
  chain?: string;
  /** max(throughput ETA, chain ETA). */
  current?: Timestamp;
  /** The lead's calibrated estimate, present when it differs from `current` by more than max(1 h, 50%). */
  lead?: Timestamp;
  /** The first ETA with enough samples, stored once (orders and milestones only). */
  original?: Timestamp;
  /** Points verified per busy hour. */
  rate?: number;
  /** Items verified in the 7-day window behind `rate`. */
  samples: number;
  slip?: EtaSlip;
};

export type StatusGetInput = {
  scope: StatusScope;
  /** Count "since" from this seq instead of the key's status_seen mark (a client that keeps its own mark). */
  sinceSeq?: EventSeq;
};

export type StatusGetOutput = {
  doc: StatusDoc;
  next?: string;
  truncated?: boolean;
};

/** What a status doc covers. `key()` is the form stored per human key ("fleet", "project:devbox/p1", "order:W41"). */
export type StatusScope = {
  kind: "fleet";
} | {
  kind: "project";
  projectRef: ProjectRef;
} | {
  kind: "order";
  workstreamId: WorkstreamId;
};

export type StatusSeenInput = {
  scope: StatusScope;
  seq: EventSeq;
};

export type StatusSeenOutput = {
  next?: string;
  /** False for agent keys: only a person's look moves the mark. */
  recorded: boolean;
  truncated?: boolean;
};

/** A steer as the status doc shows it: "↳ you steered S12 14:02 · acknowledged · −1 item". */
export type StatusSteer = {
  at: Timestamp;
  id: SteerId;
  /** The plan change it made, e.g. "−1 item". */
  planChange?: string;
  stage: SteerStage;
  text: string;
};

export type StatusWaitInput = {
  /** The version the caller has; absent waits for none (answers at once). */
  after?: number;
  scope: StatusScope;
  /** As in status_get. */
  sinceSeq?: EventSeq;
  timeoutSec?: number;
};

export type StatusWaitOutput = {
  doc?: StatusDoc;
  next?: string;
  truncated?: boolean;
  unchanged?: boolean;
  version: number;
};

/** One steer and its receipt. */
export type Steer = {
  /** Acknowledged: the reply naming it; unacknowledged: the first reply. First 200 characters. */
  ackExcerpt?: string;
  ackedAt?: Timestamp;
  by: SteerBy;
  deliveredAt?: Timestamp;
  /**
   * Plain words on the stage: "waiting for lab-b (until 14:30)", "held: usage resets 14:00", the failure, or
   * "sent (node older than 0.9)" when the node cannot report receipts.
   */
  detail?: string;
  how?: DeliveredHow;
  id: SteerId;
  mode: SteerMode;
  /** A plan change the steer made, e.g. "−1 item". */
  planChange?: string;
  queuedAt: Timestamp;
  /** The node run id it was sent as; also the user message id in the thread. */
  runId: string;
  /** The first model request that carried it. */
  seenAt?: Timestamp;
  stage: SteerStage;
  /** `how = stopped`: one line on the step it stopped. */
  stoppedTool?: string;
  target: SteerTarget;
  text: string;
  thread: ThreadRef;
  /** The order it belongs to (a task's own order for a task steer). */
  workstreamId: WorkstreamId;
};

/** Who sent a steer. */
export type SteerBy = {
  keyName: string;
  kind: "human";
} | {
  kind: "lead";
};

/** Fields `HubEvent.data` carries on `steer.*` events. */
export type SteerEventData = {
  by?: SteerBy;
  excerpt?: string;
  how?: DeliveredHow;
  mode?: SteerMode;
  /** steer.failed: why. */
  reason?: string;
  stage: SteerStage;
  steerId: SteerId;
  taskId?: TaskId;
  /** steer.queued: the first 120 characters, the mode and who sent it. */
  text?: string;
  workstreamId: WorkstreamId;
};

export type SteerId = string;

/** How a steer reaches a running agent. */
export type SteerMode = "queue" | "now";

export type SteerSendInput = {
  attachments?: AttachmentId[];
  clientRequestId: string;
  mode?: SteerMode;
  refs?: IntakeRef[];
  target: SteerTarget;
  text: string;
};

/** One steer and its receipt. */
export type SteerSendOutput = {
  /** Acknowledged: the reply naming it; unacknowledged: the first reply. First 200 characters. */
  ackExcerpt?: string;
  ackedAt?: Timestamp;
  by: SteerBy;
  deliveredAt?: Timestamp;
  /**
   * Plain words on the stage: "waiting for lab-b (until 14:30)", "held: usage resets 14:00", the failure, or
   * "sent (node older than 0.9)" when the node cannot report receipts.
   */
  detail?: string;
  how?: DeliveredHow;
  id: SteerId;
  mode: SteerMode;
  next?: string;
  /** A plan change the steer made, e.g. "−1 item". */
  planChange?: string;
  queuedAt: Timestamp;
  /** The node run id it was sent as; also the user message id in the thread. */
  runId: string;
  /** The first model request that carried it. */
  seenAt?: Timestamp;
  stage: SteerStage;
  /** `how = stopped`: one line on the step it stopped. */
  stoppedTool?: string;
  target: SteerTarget;
  text: string;
  thread: ThreadRef;
  truncated?: boolean;
  /** The order it belongs to (a task's own order for a task steer). */
  workstreamId: WorkstreamId;
};

export type SteerStage = "failed" | "queued" | "delivered" | "acknowledged" | "unacknowledged" | "withdrawn" | "expired";

/** Who a steer is for: an order's lead, or one task (writer, reviewer, verifier, …). */
export type SteerTarget = {
  workstreamId: WorkstreamId;
} | {
  taskId: TaskId;
};

export type SteerWithdrawInput = {
  steerId: SteerId;
};

/** One steer and its receipt. */
export type SteerWithdrawOutput = {
  /** Acknowledged: the reply naming it; unacknowledged: the first reply. First 200 characters. */
  ackExcerpt?: string;
  ackedAt?: Timestamp;
  by: SteerBy;
  deliveredAt?: Timestamp;
  /**
   * Plain words on the stage: "waiting for lab-b (until 14:30)", "held: usage resets 14:00", the failure, or
   * "sent (node older than 0.9)" when the node cannot report receipts.
   */
  detail?: string;
  how?: DeliveredHow;
  id: SteerId;
  mode: SteerMode;
  next?: string;
  /** A plan change the steer made, e.g. "−1 item". */
  planChange?: string;
  queuedAt: Timestamp;
  /** The node run id it was sent as; also the user message id in the thread. */
  runId: string;
  /** The first model request that carried it. */
  seenAt?: Timestamp;
  stage: SteerStage;
  /** `how = stopped`: one line on the step it stopped. */
  stoppedTool?: string;
  target: SteerTarget;
  text: string;
  thread: ThreadRef;
  truncated?: boolean;
  /** The order it belongs to (a task's own order for a task steer). */
  workstreamId: WorkstreamId;
};

export type SteersListInput = {
  /** Only steers after this number (the n of `S<n>`). */
  afterN?: number;
  limit?: number;
  taskId?: TaskId;
  workstreamId?: WorkstreamId;
};

export type SteersListOutput = {
  next?: string;
  steers: Steer[];
  truncated?: boolean;
};

/** A webhook push target. Its signing secret is shown once by subscription_set and never returned again. */
export type Subscription = {
  /** keyId of the agent key that created it. */
  createdBy: string;
  /** When deliveries started failing; absent while healthy. */
  failingSince?: Timestamp;
  kind: WebhookKind;
  lastDeliveredSeq?: EventSeq;
  machines: SubscriptionMachines;
  state: SubscriptionState;
  subscriptionId: string;
  types: SubscriptionTypes;
  url: WebhookUrl;
};

export type SubscriptionDeleteInput = {
  subscriptionId: string;
};

export type SubscriptionDeleteOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

export type SubscriptionListInput = { [key: string]: unknown };

export type SubscriptionListOutput = {
  next?: string;
  subscriptions: Subscription[];
  truncated?: boolean;
};

export type SubscriptionMachines = Star | MachineId[];

export type SubscriptionSetInput = {
  clientRequestId: string;
  machines?: SubscriptionMachines;
  types?: SubscriptionTypes;
  url: WebhookUrl;
};

export type SubscriptionSetOutput = {
  next?: string;
  /** The webhook signing secret. Shown only here; store it now. */
  secret: string;
  subscriptionId: string;
  truncated?: boolean;
};

export type SubscriptionState = "active" | "disabled";

export type SubscriptionTypes = Star | HubEventType[];

export type TailAction = {
  action: ActionItem;
  at: Timestamp;
};

export type TailItem = TailMessage & {
  kind: "message";
} | TailAction & {
  kind: "action";
};

export type TailKind = "message" | "action";

export type TailMessage = {
  at: Timestamp;
  role: TailRole;
  text: string;
};

export type TailRole = "user" | "assistant" | "system";

export type Task = {
  areas: AreaName[];
  /** 1 for the first launch. */
  attempt: number;
  /** `fleetd/<taskId>-<slug>`; write tasks only. */
  branch?: string;
  createdAt: Timestamp;
  /** Always explicit; resolved at spawn. */
  effort: Effort;
  endedAt?: Timestamp;
  estimateMinutes?: number;
  /** The plan item it was spawned for (`--item`). */
  itemId?: PlanItemId;
  kind: TaskKind;
  model: string;
  /** M4: its thread hit a usage limit; the task is idle until fleetd sends "continue" at `resumeAt`. */
  parked?: UsageParked;
  /** The PR a review task reviews. Required at spawn for review; absent on hub-spawned judge tasks and older rows. */
  pr?: string;
  projectRef: ProjectRef;
  prompt: string;
  /** A review task spawned with `--qa`. */
  qa?: boolean;
  /** Why it is queued, e.g. "lease: docs held by T1" or "slots: 40/40 in use". */
  queuedReason?: string;
  result?: TaskResult;
  /** Required at spawn for write tasks; optional here for tasks stored before M6. */
  serves?: Serves;
  startedAt?: Timestamp;
  state: TaskState;
  taskId: TaskId;
  threadRef?: ThreadRef;
  tier?: Tier;
  title: string;
  workstreamId: WorkstreamId;
  worktreePath?: string;
};

/** A project's tasks by state, all time. */
export type TaskCounts = {
  cancelled: number;
  done: number;
  failed: number;
  idle: number;
  queued: number;
  running: number;
};

/** Fields `HubEvent.data` carries on `task.*` events. */
export type TaskEventData = {
  branch?: string;
  /** task.out_of_area: the first 20 paths outside the leased globs. */
  paths?: string[];
  queuedReason?: string;
  taskId: TaskId;
  workstreamId?: WorkstreamId;
};

export type TaskGetInput = {
  taskId: TaskId;
};

export type TaskGetOutput = {
  next?: string;
  task: Task;
  truncated?: boolean;
};

export type TaskId = string;

/** Only write tasks get a worktree and leases. */
export type TaskKind = "write" | "read" | "review";

export type TaskResult = {
  at: Timestamp;
  branch?: string;
  /** The tail claims success ("tests pass", "fixed", ...) while `receipts.commands` is 0. Absent before M6. */
  claimsUnverified?: boolean;
  prUrl?: string;
  /** Absent on results stored before M6. */
  receipts?: Receipts;
  status: TaskResultStatus;
  /** The latest assistant message, trimmed to its last 2000 characters. */
  tail: string;
};

export type TaskResultStatus = "done" | "failed" | "cancelled";

export type TaskState = "queued" | "running" | "idle" | "done" | "failed" | "cancelled";

export type TasksListInput = {
  limit?: number;
  projectRef?: ProjectRef;
  state?: TaskState;
};

export type TasksListOutput = {
  next?: string;
  /** Newest first. */
  tasks: Task[];
  truncated?: boolean;
};

export type ThreadAnswerInput = {
  decision: PermissionAnswer;
  machineId: MachineId;
  /** Deny only: what claude is told instead of running the tool. */
  message?: string;
  /** The prompt answered, from the thread.waiting event; absent means the one open now. */
  requestId?: string;
  threadId: ThreadId;
};

export type ThreadAnswerOutput = {
  decision: PermissionAnswer;
  /** The approval request this answer closed, if one was open. */
  humanRequestId?: ChatRequestId;
  next?: string;
  requestId: string;
  truncated?: boolean;
};

export type ThreadCounts = {
  failed: number;
  idle: number;
  running: number;
  waiting: number;
};

export type ThreadError = {
  class: string;
  message: string;
};

/** Fields `HubEvent.data` may carry on `thread.*` events, alongside whatever else the hub adds. */
export type ThreadEventData = {
  /** The run ended while the hub was down and this event was emitted on its return. */
  late?: boolean;
  reason?: ThreadEventReason;
  runId?: string;
};

export type ThreadEventReason = "stalled" | "usage_limit" | "interrupted";

export type ThreadId = string;

export type ThreadInterruptInput = {
  clientRequestId: string;
  machineId: MachineId;
  threadId: ThreadId;
};

export type ThreadInterruptOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

export type ThreadLaunchInput = {
  clientRequestId: string;
  effort: Effort;
  machineId: MachineId;
  model: string;
  projectId: ProjectId;
  prompt: string;
  runtimeMode?: RuntimeMode;
  title?: string;
};

export type ThreadLaunchOutput = {
  next?: string;
  threadId: ThreadId;
  truncated?: boolean;
};

export type ThreadRef = {
  machineId: MachineId;
  threadId: ThreadId;
};

export type ThreadSendInput = {
  clientRequestId: string;
  machineId: MachineId;
  message: string;
  threadId: ThreadId;
};

export type ThreadSendOutput = {
  next?: string;
  /** True when the machine is offline and the message waits in the hub's queue. */
  queued: boolean;
  /** When a queued message expires undelivered. */
  queuedUntil?: Timestamp;
  runId?: string;
  truncated?: boolean;
};

export type ThreadStatus = "running" | "waiting" | "idle" | "completed" | "failed" | "interrupted" | "cancelled";

export type ThreadSummary = {
  asOf: Timestamp;
  /** As reported by the runner; not narrowed to Effort because it may report other levels. */
  effort?: string;
  /** First line of the latest visible assistant text. */
  headline: string;
  lastError?: ThreadError;
  lastProgressAt: Timestamp;
  latestMessageTail: string;
  machineId: MachineId;
  model?: string;
  projectId: ProjectId;
  stale: boolean;
  status: ThreadStatus;
  threadId: ThreadId;
  title: string;
  usageLimitResetAt?: Timestamp;
};

export type ThreadTailInput = {
  kinds?: TailKind[];
  machineId: MachineId;
  n?: number;
  threadId: ThreadId;
};

export type ThreadTailOutput = {
  /** Newest first. */
  items: TailItem[];
  next?: string;
  thread: ThreadSummary;
  truncated?: boolean;
};

export type ThreadWindowInput = {
  after?: number;
  before?: number;
  /** A span's `itemId`. */
  itemId: string;
  machineId: MachineId;
  threadId: ThreadId;
};

export type ThreadWindowOutput = {
  /** The index of `itemId` in `items`; absent when the node no longer has it. */
  focus?: number;
  items: TailItem[];
  next?: string;
  truncated?: boolean;
};

export type Tier = "S" | "M" | "L";

export type TimeBreakdownInput = {
  compare?: Period;
  filters?: TimeFilters;
  scope: TimeScope;
  since: Timestamp;
  until?: Timestamp;
};

export type TimeBreakdownOutput = {
  agentMs: number;
  byCategory: CategoryTotal[];
  ciChecks: CiCheckStat[];
  compare?: PeriodBreakdown;
  coverage: Coverage;
  /** Order scope only. */
  criticalPath?: CriticalPath;
  humanWait: HumanWait;
  next?: string;
  repeated: RepeatStat[];
  retentionDays: number;
  /** The hub's span tables on disk. */
  storedBytes: number;
  topCommands: CommandStat[];
  truncated?: boolean;
  wallMs: number;
};

export type TimeFilters = {
  machineId?: MachineId;
  projectRef?: ProjectRef;
  role?: AgentRole;
};

export type TimeInsightsInput = {
  compare?: Period;
  scope: TimeScope;
  since: Timestamp;
  until?: Timestamp;
};

export type TimeInsightsOutput = {
  insights: Insight[];
  next?: string;
  truncated?: boolean;
};

export type TimeRetentionSetInput = {
  retentionDays: number;
};

export type TimeRetentionSetOutput = {
  next?: string;
  retentionDays: number;
  truncated?: boolean;
};

/** What the numbers cover. */
export type TimeScope = {
  kind: "fleet";
} | {
  kind: "machine";
  machineId: MachineId;
} | {
  kind: "project";
  projectRef: ProjectRef;
} | {
  kind: "lead";
  projectRef: ProjectRef;
} | {
  kind: "order";
  workstreamId: WorkstreamId;
} | {
  kind: "task";
  taskId: TaskId;
} | {
  kind: "thread";
  machineId: MachineId;
  threadId: ThreadId;
};

export type TimeSpansInput = {
  afterId?: number;
  kinds?: SpanKind[];
  limit?: number;
  rule?: InsightRule;
  scope: TimeScope;
  since: Timestamp;
  until?: Timestamp;
};

export type TimeSpansOutput = {
  coverage: Coverage;
  next?: string;
  /** Absent when there are no more. */
  nextAfterId?: number;
  spans: Span[];
  truncated?: boolean;
};

export type TimeZone = string;

export type Timestamp = string;

/** Summed over the lane's runs. `live`: the running run's usage is streaming in (else it updates at each run's end). */
export type Tokens = {
  cacheRead: number;
  input: number;
  live: boolean;
  output: number;
};

/**
 * An approval raised by a session's tool permission prompt instead of a gated command: answering it answers the prompt
 * on the project's node. Its machine is the request's project's.
 */
export type ToolPermission = {
  requestId: string;
  /** The command, the path, or the tool's own description. */
  summary: string;
  threadId: ThreadId;
  toolName: string;
};

/**
 * The merge train's events: `change.queued`, `change.ready`, `change.needs_rebase`, `change.ci_failed`,
 * `change.refused`, `pr.merged`, `train.frozen`, `train.resumed`, `train.blocked`. Which fields each carries is in
 * `HubEventType`'s docs.
 */
export type TrainEventData = {
  changeId?: ChangeId;
  /** change.ci_failed: the failing check names. */
  checks?: string[];
  /** pr.merged on a repo with no CI: what fleetd checked instead. */
  ci?: string;
  /** train.blocked: what a person has to move. */
  error?: string;
  fix?: string;
  logUrl?: string;
  mergedSha?: string;
  /** change.needs_rebase: the conflicting paths. */
  paths?: string[];
  prNumber?: number;
  prUrl?: string;
  reason?: string;
  repo?: GitHubRepo;
  workstreamId?: WorkstreamId;
};

export type TrainFreezeInput = {
  frozen: boolean;
  reason?: string;
  repo: GitHubRepo;
};

export type TrainFreezeOutput = {
  next?: string;
  train: TrainState;
  truncated?: boolean;
};

export type TrainGetInput = {
  repo: GitHubRepo;
};

export type TrainGetOutput = {
  next?: string;
  train: TrainState;
  truncated?: boolean;
};

/** One repo's merge train, resolved for the strip: head first, then the queue in order, then today's merges. */
export type TrainLive = {
  chips: PrChip[];
  frozen: boolean;
  frozenReason?: string;
  /** Merged since 00:00 UTC. */
  mergedToday: number;
  repo: GitHubRepo;
};

/** One serial train per repo. */
export type TrainState = {
  /** Held by a `policy.freeze.<repo>` decision. */
  frozen: boolean;
  /** The Change being rebased, checked or merged now. */
  head?: ChangeId;
  /** Waiting Changes in train order. */
  queue: ChangeId[];
  repo: GitHubRepo;
};

/** Open: no new turns start on the machine's login until `until` or usage_resume. */
export type UsageBreaker = {
  class?: UsageClass;
  /** The plain notice, as the usage.breaker event said it. */
  message?: string;
  since?: Timestamp;
  state: BreakerState;
  /** Absent while open means until usage_resume. */
  until?: Timestamp;
};

/**
 * What stopped a turn. `usage_limit`: the plan's usage limit or a proxy cooldown, with a reset. `rate_limit`: a 429.
 * `pool_exhausted`: the user's proxy has no account for the model; it waits for usage_resume.
 */
export type UsageClass = "usage_limit" | "rate_limit" | "pool_exhausted";

/** Fields `HubEvent.data` carries on usage.breaker and usage.resumed. */
export type UsageEventData = {
  /** usage.resumed: the breaker was open and is now closed. */
  breakerCleared?: boolean;
  /** usage.resumed: "reset", or who ran usage_resume. */
  by?: string;
  class?: UsageClass;
  model?: string;
  parked?: ParkedCounts;
  /** usage.resumed: the threads sent "continue", in the order they were sent. */
  threads?: UsageEventThread[];
  until?: Timestamp;
};

export type UsageEventThread = {
  kind: string;
  taskId?: string;
  threadId: string;
};

/** A task or lead whose thread hit a limit; fleetd sends it one "continue" at `resume_at`. */
export type UsageParked = {
  class: UsageClass;
  /** Absent for pool_exhausted: it resumes on usage_resume. */
  resumeAt?: Timestamp;
  since: Timestamp;
};

export type UsageResumeInput = {
  machineId: MachineId;
};

export type UsageResumeOutput = {
  next?: string;
  /** Parked threads sent "continue". */
  resumed: number;
  status: UsageStatus;
  truncated?: boolean;
};

export type UsageStatus = {
  breaker: UsageBreaker;
  /** The latest thread.usage_limited, usage.breaker and usage.resumed events for the machine, oldest first. */
  lastEvents: HubEvent[];
  login: LoginKind;
  machineId: MachineId;
  parked: ParkedCounts;
};

export type UsageStatusInput = {
  machineId?: MachineId;
};

export type UsageStatusOutput = {
  machines: UsageStatus[];
  next?: string;
  truncated?: boolean;
};

export type Wake = {
  /** What to do with a firing missed while the hub was down. */
  catchUp: WakeCatchUp;
  /** keyId of the agent key that set it. */
  createdBy: string;
  lastFiredAt?: Timestamp;
  message: string;
  /** Absent once the wake is done or cancelled. */
  nextRunAt?: Timestamp;
  once: boolean;
  schedule: WakeSchedule;
  state: WakeState;
  target: WakeTarget;
  wakeId: string;
};

export type WakeAt = {
  at: Timestamp;
  tz: TimeZone;
};

export type WakeCancelInput = {
  wakeId: string;
};

export type WakeCancelOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

export type WakeCatchUp = "fire_once" | "skip";

/** Standard 5-field cron; the hub parses it. */
export type WakeCron = {
  cron: string;
  tz: TimeZone;
};

export type WakeEvery = {
  everySec: number;
};

export type WakeListInput = {
  machineId?: MachineId;
  state?: WakeState;
  threadId?: ThreadId;
};

export type WakeListOutput = {
  next?: string;
  truncated?: boolean;
  wakes: Wake[];
};

export type WakeSchedule = WakeAt & {
  kind: "at";
} | WakeEvery & {
  kind: "every";
} | WakeCron & {
  kind: "cron";
};

export type WakeSetInput = {
  catchUp?: WakeCatchUp;
  clientRequestId: string;
  message: string;
  once?: boolean;
  schedule: WakeSchedule;
  target: WakeTarget;
};

export type WakeSetOutput = {
  next?: string;
  nextRunAt: Timestamp;
  truncated?: boolean;
  wakeId: string;
};

export type WakeState = "active" | "done" | "cancelled";

export type WakeTarget = {
  machineId: MachineId;
  threadId: ThreadId;
};

export type WebhookKind = "webhook";

export type WebhookUrl = string;

export type Weight = "must" | "polish";

export type KnownWeightsBasis = "project" | "fleet" | "default";
/** KnownWeightsBasis, or a value from a newer hub. */
export type WeightsBasis = KnownWeightsBasis | (string & {});

export type Workstream = {
  /** Absent while draft. */
  brief?: Brief;
  briefHash?: BriefHash;
  createdAt: Timestamp;
  /** Hub-filled, outside the frozen brief. Set when it starts running with a raw estimate. */
  estimateActual?: WorkstreamEstimateActual;
  headline?: string;
  headlineAt?: Timestamp;
  /** Research workstreams, once the verdict is computed; set together with `verdict`. A STOP is done, not failed. */
  outcome?: ResearchOutcome;
  /** M9 finish-all: the finish-all workstream that spawned this one, and the value source it was spawned for. */
  parent?: WorkstreamParent;
  /** Pinned at creation; the brief freeze validates against this version. Absent on workstreams from before M9. */
  playbook?: PlaybookRef;
  projectRef: ProjectRef;
  source: WorkstreamSource;
  state: WorkstreamState;
  title: string;
  updatedAt: Timestamp;
  verdict?: ResearchVerdict;
  workstreamId: WorkstreamId;
};

export type WorkstreamEstimateActual = {
  /** Wall-clock minutes from running to done; set on done. */
  actualMinutes?: number;
  /** The tier's calibration ratio when it started running. */
  ratioAtStart: number;
};

/** `workstream.created`, `workstream.running`, `workstream.state`, `workstream.done`. */
export type WorkstreamEventData = {
  /** workstream.running: the frozen brief. */
  briefHash?: BriefHash;
  by?: string;
  /** workstream.state (verifying) and workstream.done: the claim that moved it. */
  claimId?: ClaimId;
  /** workstream.state (stopped): why, and who. */
  reason?: string;
  /** workstream.state: the new state. */
  state?: WorkstreamState;
  workstreamId: WorkstreamId;
};

export type WorkstreamGetInput = {
  workstreamId: WorkstreamId;
};

export type WorkstreamGetOutput = {
  /** Its claims, newest first. */
  claims?: Claim[];
  /** Active decisions scoped to it. */
  decisions: Decision[];
  /** Absent without a raw estimate in the brief. */
  eta?: Eta;
  next?: string;
  /** Its open secret and approval requests. */
  requests: HumanRequest[];
  truncated?: boolean;
  workstream: Workstream;
};

export type WorkstreamId = string;

export type WorkstreamListInput = {
  limit?: number;
  machineId?: MachineId;
  projectId?: ProjectId;
  state?: WorkstreamState;
};

export type WorkstreamListOutput = {
  next?: string;
  truncated?: boolean;
  /** Newest first. */
  workstreams: Workstream[];
};

/** `workstream.note`. */
export type WorkstreamNoteData = {
  clientRequestId?: string;
  /** The steer the note became. */
  steerId?: SteerId;
  /** The first 200 characters. */
  text?: string;
  urgent?: boolean;
  workstreamId: WorkstreamId;
};

export type WorkstreamParent = {
  serves: Serves;
  workstreamId: WorkstreamId;
};

export type WorkstreamSource = {
  at: Timestamp;
  /** Who submitted it: an agent keyId, "human" or "lead:<machineId>/<projectId>". */
  by: string;
  channel: IntakeChannel;
  text: string;
};

export type WorkstreamSpawnInput = {
  machineId: MachineId;
  projectId: ProjectId;
  serves: Serves;
  template?: PlaybookName;
  text: string;
};

export type WorkstreamSpawnOutput = {
  next?: string;
  /** The project's open finish-all workstream it is a child of. */
  parent: WorkstreamId;
  playbook?: PlaybookRef;
  truncated?: boolean;
  workstreamId: WorkstreamId;
};

export type WorkstreamState = "draft" | "running" | "converging" | "verifying" | "done" | "idle" | "stopped" | "failed";

/** Every tool the app can `call`: its input and its output. */
export interface ToolMap {
  actions_list: { input: ActionsListInput; output: ActionsListOutput };
  approval_answer: { input: ApprovalAnswerInput; output: ApprovalAnswerOutput };
  attachment_get: { input: AttachmentGetInput; output: AttachmentGetOutput };
  attachment_put: { input: AttachmentPutInput; output: AttachmentPutOutput };
  attention_policy: { input: AttentionPolicyInput; output: AttentionPolicyOutput };
  cap_set: { input: CapSetInput; output: CapSetOutput };
  changes_list: { input: ChangesListInput; output: ChangesListOutput };
  chat_history: { input: ChatHistoryInput; output: ChatHistoryOutput };
  chat_send: { input: ChatSendInput; output: ChatSendOutput };
  claims_list: { input: ClaimsListInput; output: ClaimsListOutput };
  decisions_record: { input: DecisionsRecordInput; output: DecisionsRecordOutput };
  decisions_search: { input: DecisionsSearchInput; output: DecisionsSearchOutput };
  digest_get: { input: DigestGetInput; output: DigestGetOutput };
  doctor_fix: { input: DoctorFixInput; output: DoctorFixOutput };
  doctor_list: { input: DoctorListInput; output: DoctorListOutput };
  events_wait: { input: EventsWaitInput; output: EventsWaitOutput };
  fleetd_status: { input: FleetdStatusInput; output: FleetdStatusOutput };
  github_webhook_set: { input: GithubWebhookSetInput; output: GithubWebhookSetOutput };
  incidents_list: { input: IncidentsListInput; output: IncidentsListOutput };
  intake_preview: { input: IntakePreviewInput; output: IntakePreviewOutput };
  intake_submit: { input: IntakeSubmitInput; output: IntakeSubmitOutput };
  inventory: { input: InventoryInput; output: InventoryOutput };
  lead_restart: { input: LeadStartInput; output: LeadStartOutput };
  lead_start: { input: LeadStartInput; output: LeadStartOutput };
  order_get: { input: OrderGetInput; output: OrderGetOutput };
  order_note: { input: OrderNoteInput; output: OrderNoteOutput };
  order_stop: { input: OrderStopInput; output: OrderStopOutput };
  orders_board: { input: OrdersBoardInput; output: OrdersBoardOutput };
  plan_get: { input: PlanGetInput; output: PlanGetOutput };
  project_add: { input: ProjectAddInput; output: ProjectAddOutput };
  project_discover: { input: ProjectDiscoverInput; output: ProjectDiscoverOutput };
  project_files: { input: ProjectFilesInput; output: ProjectFilesOutput };
  project_get: { input: ProjectGetInput; output: ProjectOutcome };
  project_inspect: { input: ProjectInspectInput; output: ProjectInspectOutput };
  project_remove: { input: ProjectRemoveInput; output: ProjectRemoveOutput };
  project_stop: { input: ProjectStopInput; output: ProjectStopOutput };
  projects_list: { input: ProjectsListInput; output: ProjectsListOutput };
  prompt_get: { input: PromptGetInput; output: PromptGetOutput };
  prompt_reset: { input: PromptResetInput; output: PromptResetOutput };
  prompt_set: { input: PromptSetInput; output: PromptSetOutput };
  prompts_list: { input: PromptsListInput; output: PromptsListOutput };
  requests_list: { input: RequestsListInput; output: RequestsListOutput };
  retro_proposals: { input: RetroProposalsInput; output: RetroProposalsOutput };
  retro_run: { input: RetroRunInput; output: RetroRunOutput };
  secret_submit: { input: SecretSubmitInput; output: SecretSubmitOutput };
  session_prompt_get: { input: SessionPromptGetInput; output: SessionPromptGetOutput };
  status_get: { input: StatusGetInput; output: StatusGetOutput };
  status_seen: { input: StatusSeenInput; output: StatusSeenOutput };
  status_wait: { input: StatusWaitInput; output: StatusWaitOutput };
  steer_send: { input: SteerSendInput; output: SteerSendOutput };
  steer_withdraw: { input: SteerWithdrawInput; output: SteerWithdrawOutput };
  steers_list: { input: SteersListInput; output: SteersListOutput };
  subscription_delete: { input: SubscriptionDeleteInput; output: SubscriptionDeleteOutput };
  subscription_list: { input: SubscriptionListInput; output: SubscriptionListOutput };
  subscription_set: { input: SubscriptionSetInput; output: SubscriptionSetOutput };
  task_get: { input: TaskGetInput; output: TaskGetOutput };
  tasks_list: { input: TasksListInput; output: TasksListOutput };
  thread_answer: { input: ThreadAnswerInput; output: ThreadAnswerOutput };
  thread_interrupt: { input: ThreadInterruptInput; output: ThreadInterruptOutput };
  thread_launch: { input: ThreadLaunchInput; output: ThreadLaunchOutput };
  thread_send: { input: ThreadSendInput; output: ThreadSendOutput };
  thread_tail: { input: ThreadTailInput; output: ThreadTailOutput };
  thread_window: { input: ThreadWindowInput; output: ThreadWindowOutput };
  time_breakdown: { input: TimeBreakdownInput; output: TimeBreakdownOutput };
  time_insights: { input: TimeInsightsInput; output: TimeInsightsOutput };
  time_retention_set: { input: TimeRetentionSetInput; output: TimeRetentionSetOutput };
  time_spans: { input: TimeSpansInput; output: TimeSpansOutput };
  train_freeze: { input: TrainFreezeInput; output: TrainFreezeOutput };
  train_get: { input: TrainGetInput; output: TrainGetOutput };
  usage_resume: { input: UsageResumeInput; output: UsageResumeOutput };
  usage_status: { input: UsageStatusInput; output: UsageStatusOutput };
  wake_cancel: { input: WakeCancelInput; output: WakeCancelOutput };
  wake_list: { input: WakeListInput; output: WakeListOutput };
  wake_set: { input: WakeSetInput; output: WakeSetOutput };
  workstream_get: { input: WorkstreamGetInput; output: WorkstreamGetOutput };
  workstream_list: { input: WorkstreamListInput; output: WorkstreamListOutput };
  workstream_spawn: { input: WorkstreamSpawnInput; output: WorkstreamSpawnOutput };
}

/** `HubEvent.data` by event type, for the types whose data has a declared shape. */
export interface HubEventDataMap {
  "change.ci_failed": TrainEventData;
  "change.needs_rebase": TrainEventData;
  "change.queued": TrainEventData;
  "change.ready": TrainEventData;
  "change.refused": TrainEventData;
  "change.state": ChangeStateData;
  "chat.message": ChatMessageEventData;
  "chat.waiting": ProjectChatState;
  "ci.main": CiMainData;
  "claim.failed": ClaimEventData;
  "claim.passed": ClaimEventData;
  "github.drift": GithubDriftData;
  "machine.slept": MachineSleptData;
  "plan.changed": PlanChangedData;
  "plan.verified": PlanVerifiedData;
  "pr.merged": TrainEventData;
  "project.add_failed": ProjectAddFailedData;
  "project.added": ProjectAddedData;
  "project.clone_progress": CloneProgressData;
  "prompt.changed": PromptChangedData;
  "request.opened": RequestEventData;
  "request.updated": RequestEventData;
  "source.fresh": SourceFreshData;
  "source.stale": SourceStaleData;
  "steer.acknowledged": SteerEventData;
  "steer.delivered": SteerEventData;
  "steer.failed": SteerEventData;
  "steer.queued": SteerEventData;
  "steer.unacknowledged": SteerEventData;
  "steer.withdrawn": SteerEventData;
  "task.cancelled": TaskEventData;
  "task.completed": TaskEventData;
  "task.failed": TaskEventData;
  "task.out_of_area": TaskEventData;
  "task.queued": TaskEventData;
  "task.started": TaskEventData;
  "thread.completed": ThreadEventData;
  "thread.failed": ThreadEventData;
  "thread.interrupted": ThreadEventData;
  "thread.stalled": ThreadEventData;
  "thread.started": ThreadEventData;
  "thread.usage_limited": UsageEventData;
  "thread.waiting": ThreadEventData;
  "train.blocked": TrainEventData;
  "train.frozen": TrainEventData;
  "train.resumed": TrainEventData;
  "usage.breaker": UsageEventData;
  "usage.resumed": UsageEventData;
  "workstream.created": WorkstreamEventData;
  "workstream.done": WorkstreamEventData;
  "workstream.note": WorkstreamNoteData;
  "workstream.running": WorkstreamEventData;
  "workstream.state": WorkstreamEventData;
}
