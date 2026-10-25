// Generated from crates/fleetd-contracts by `cargo run -p fleetd-contracts --bin fleetd-schema`.
// Do not edit: CI regenerates it and fails on any difference.

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
  /** What it runs on: a task's own profile; a lead is always high. Absent from older hubs. */
  profile?: TaskProfile;
  role: AgentRole;
  startedAt?: Timestamp;
  status: LaneStatus;
  /** Queued, parked or failed: why, e.g. "fleet cap: 40 of 40 running", "usage limit: resumes 14:05". */
  statusReason?: string;
  taskId?: TaskId;
  threadRef?: ThreadRef;
  title: string;
};

export type AgentRole = "lead" | "implementer" | "reader" | "reviewer" | "verifier" | "qa";

/** One agent: a task, or a project's lead, with its project. */
export type AgentRow = {
  branch?: string;
  effort?: Effort;
  endedAt?: Timestamp;
  laneId: string;
  /** Live values at snapshot time. */
  live?: LiveLane;
  model?: string;
  pr?: PrRef;
  /** What it runs on: a task's own profile; a lead is always high. Absent from older hubs. */
  profile?: TaskProfile;
  projectRef: ProjectRef;
  projectTitle: string;
  role: AgentRole;
  startedAt?: Timestamp;
  status: LaneStatus;
  /** Queued, parked or failed: why, e.g. "fleet cap: 40 of 40 running", "usage limit: resumes 14:05". */
  statusReason?: string;
  taskId?: TaskId;
  threadRef?: ThreadRef;
  title: string;
  /** The work it belongs to; `live { focus }` with it streams this agent's text too. Absent for a lead. */
  workstreamId?: WorkstreamId;
};

export type AgentWorkInput = {
  before?: string;
  limit?: number;
  machineId: MachineId;
  threadId: ThreadId;
};

export type AgentWorkOutput = {
  /** Pass back as `before` for the page before this one; absent when there is nothing older. */
  before?: string;
  next?: string;
  /** A run of it is active now. */
  running: boolean;
  steps: WorkStep[];
  truncated?: boolean;
};

/**
 * `agents.cap` data: a project's max agents or the fleet cap changed. The event's summary is the one quiet line its
 * chat shows.
 */
export type AgentsCapData = {
  from: number;
  /** Agents told to push their work and wait (`pauseExtras`). */
  paused?: TaskId[];
  /** Absent for the fleet cap. */
  projectRef?: ProjectRef;
  queued: number;
  /** The project's agents (or, for the fleet cap, every slot) running and queued just after the change. */
  running: number;
  to: number;
};

export type AgentsListInput = {
  endedSince?: Timestamp;
  projectRef?: ProjectRef;
};

export type AgentsListOutput = {
  agents: AgentRow[];
  at: Timestamp;
  next?: string;
  truncated?: boolean;
};

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
  agent?: string;
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
  /** The hub's fleetd version, as hub_info reports it. Absent from older hubs. */
  version?: string;
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

export type BoxPublicKey = string;

export type BreakerState = "closed" | "open";

export type Brief = {
  constraints: string[];
  /** At least one. */
  doneWhen: string[];
  goal: string;
  pointers: string[];
  why: string;
};

export type CapSetInput = {
  /** The fleet cap: agents running at once across every project. Needs an admin key. */
  cap?: number;
  project?: CapSetProject;
};

export type CapSetOutput = {
  next?: string;
  /** The agents `pauseExtras` paused. */
  paused?: TaskId[];
  slots: SlotState;
  truncated?: boolean;
};

export type CapSetProject = {
  /** 1 up to the fleet cap. */
  maxAgents: number;
  /**
   * Lowering: tell the agents above the new max to push their work in progress and wait; they resume when a slot
   * frees. Without it they finish their current work.
   */
  pauseExtras?: boolean;
  projectRef: ProjectRef;
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
  state: ChangeState;
  /** The write task that opened it; absent when the lead enqueued a PR no task wrote. */
  taskId?: TaskId;
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
  /** Why it moved, when the train says: always set when a pass hands it back to `ready` (a bounce). */
  reason?: string;
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

export type KnownChatAuthor = "human" | "lead" | "agent" | "system";
/** KnownChatAuthor, or a value from a newer hub. */
export type ChatAuthor = KnownChatAuthor | (string & {});

/** Where a human message was written. */
export type KnownChatClient = "app" | "cli";
/** KnownChatClient, or a value from a newer hub. */
export type ChatClient = KnownChatClient | (string & {});

/** How a human message reached the lead. */
export type KnownChatDelivery = "turn" | "steer" | "now" | "queued";
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
  /** The name of the key that wrote it: a person's device for a human message, the agent for an agent's. */
  by?: string;
  /** A human message: where it was written. */
  client?: ChatClient;
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
  /** A human key: where it is written. Absent means the app. */
  client?: ChatClient;
  clientRequestId: string;
  /**
   * A human key only: while the lead works, stop its running step and deliver at once (steer_send's `now`). An
   * idle lead takes it as any message.
   */
  now?: boolean;
  projectRef: ProjectRef;
  /**
   * Sent from inside a fleetd session: its thread id (FLEETD_THREAD_ID), as the caller reports it. The project's own
   * lead and tasks are refused (they use their fleetd tools), and so is a human key. It catches mistakes; the key,
   * not this field, carries authority.
   */
  session?: ThreadId;
  text: string;
};

export type ChatSendOutput = {
  /** Why the lead doesn't have it yet, with the fix; absent when it does or is starting. */
  leadWaiting?: string;
  message: ChatMessage;
  next?: string;
  truncated?: boolean;
};

export type ChatStopInput = {
  clientRequestId: string;
  projectRef: ProjectRef;
};

export type ChatStopOutput = {
  /** The system line it wrote into the chat. */
  message: ChatMessage;
  next?: string;
  /** Something was running and stopped: the lead's turn or an agent. */
  stopped: boolean;
  truncated?: boolean;
};

export type Checkout = {
  machineId: MachineId;
  path: string;
  projectId?: ProjectId;
};

/** The checks on the PR's head, rolled up: any failed is `failing`, else any running is `pending`. */
export type KnownChecksState = "pending" | "passing" | "failing" | "none";
/** KnownChecksState, or a value from a newer hub. */
export type ChecksState = KnownChecksState | (string & {});

export type ChecksSummary = {
  failed: number;
  passed: number;
  pending: number;
  state: ChecksState;
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
  /** Once it ran or failed: when the result came back. */
  finishedAt?: Timestamp;
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

/** How a delivered steer was taken in. */
export type DeliveredHow = "turn" | "boundary" | "stopped" | "joined";

/** One line of a file's diff. Secrets are replaced by `[secret]`. */
export type DiffLine = {
  /** The line was longer than `PR_DIFF_LINE_MAX` and is cut. */
  cut?: boolean;
  kind: DiffLineKind;
  /** Line number in the new file (context and added lines; a hunk's start). */
  new?: number;
  /** Line number in the old file (context and deleted lines; a hunk's start). */
  old?: number;
  /** Without the leading "+", "-" or " ". */
  text: string;
};

export type KnownDiffLineKind = "context" | "add" | "del" | "hunk";
/** KnownDiffLineKind, or a value from a newer hub. */
export type DiffLineKind = KnownDiffLineKind | (string & {});

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

export type KnownDropReason = "scope_change" | "review_failed" | "ci_failed" | "reopened" | "work_stopped";
/** KnownDropReason, or a value from a newer hub. */
export type DropReason = KnownDropReason | (string & {});

/** The `--effort` claude runs at. Only [`TaskProfile`] picks one; nothing takes an effort as input. */
export type Effort = "low" | "medium" | "high" | "max";

/** Who keeps a safety rule when the prompt no longer says it. */
export type Enforcement = "code" | "prompt";

export type EnvName = string;

export type ErrorCode = "machine_offline" | "not_found" | "forbidden" | "invalid" | "failed";

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
  /** When to notify the human; absent from older hubs. */
  notify?: NotifyPolicy;
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
  /** When to notify the human; absent from older hubs. */
  notify?: NotifyPolicy;
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

/** One thing in flight on the hub. */
export type HubBusyItem = {
  kind: HubBusyKind;
  /** Where it runs, when on one machine. */
  machineId?: MachineId;
  projectRef?: ProjectRef;
  /** When it started. */
  since?: Timestamp;
  /** What it is, for a person: "T19 writing app-main in fleetd (12 m)". */
  text: string;
};

export type KnownHubBusyKind = "agent" | "lead" | "train" | "approval" | "clone";
/** KnownHubBusyKind, or a value from a newer hub. */
export type HubBusyKind = KnownHubBusyKind | (string & {});

/** The release channel a hub's build follows: nightly when its version contains "-nightly.", stable otherwise. */
export type KnownHubChannel = "nightly" | "stable";
/** KnownHubChannel, or a value from a newer hub. */
export type HubChannel = KnownHubChannel | (string & {});

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
  | "steer.withdrawn"
  | "machine.slept"
  | "machine.guard"
  | "project.removed"
  | "project.added"
  | "project.clone_progress"
  | "project.add_failed"
  | "project.settings"
  | "thread.waiting"
  | "wake.missed"
  | "write.delivered"
  | "write.expired"
  | "workstream.running"
  | "request.opened"
  | "request.updated"
  | "task.queued"
  | "agents.cap"
  | "workstream.done"
  | "review.verdict"
  | "change.queued"
  | "change.ready"
  | "change.needs_rebase"
  | "change.ci_failed"
  | "pr.merged"
  | "pr.merged_outside"
  | "change.refused"
  | "usage.breaker"
  | "usage.resumed"
  | "doctor.changed"
  | "key.paired"
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
  | "source.stale"
  | "source.fresh"
  | "chat.message"
  | "chat.waiting";
/** KnownHubEventType, or a value from a newer hub. */
export type HubEventType = KnownHubEventType | (string & {});

export type HubInfoInput = {
  /** Only what runs on this machine (before restarting its node); absent: everything. */
  machineId?: MachineId;
};

export type HubInfoOutput = {
  /** Empty when nothing is in flight. A restart interrupts each item. */
  busy: HubBusyItem[];
  /** Absent for a local build. */
  channel?: HubChannel;
  next?: string;
  protocol: number;
  startedAt?: Timestamp;
  truncated?: boolean;
  /** The hub's fleetd version, as `fleetd --version` prints it. "0.0.0" for a local build. */
  version: string;
};

/** One human request, as stored and as every client shows it. */
export type HumanRequest = {
  answeredAt?: Timestamp;
  /** "human:<device>". */
  answeredBy?: string;
  createdAt: Timestamp;
  /**
   * What happened, in one line: "fingerprint ab12cd34", "exit 0 on devbox, approved by human:desk", or why it did
   * not run (and so is open again).
   */
  evidence?: string;
  /**
   * An approval that ran: its exit code (absent when a signal or the timeout ended it) and the end of its output,
   * with every injected secret value scrubbed.
   */
  exitCode?: number;
  /** An approved command: when its result came back (ran or failed), so a client can say how long it took. */
  finishedAt?: Timestamp;
  /** approval of a gated run: exactly the bytes the node runs. */
  gated?: GatedRunSpec;
  kind: RequestKind;
  outputTail?: string;
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

export type KnownInsightRule = "full_suite_repeat" | "repeat_no_change" | "slow_commands";
/** KnownInsightRule, or a value from a newer hub. */
export type InsightRule = KnownInsightRule | (string & {});

export type IntakeChannel = "app" | "mcp" | "lead";

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

/** The project's latest merge, as the train recorded it. */
export type LastMerged = {
  /** When the train merged it. */
  at: Timestamp;
  prNumber?: number;
  prUrl?: string;
  /** The work's own title (its writer task's), not the PR's branch. */
  title: string;
};

export type Lead = {
  lastWakeAt?: Timestamp;
  /** M4: the lead thread hit a usage limit; derived from the usage layer when read. */
  parked?: UsageParked;
  projectRef: ProjectRef;
  /** Bumped by each `lead_start {fresh}`. */
  sessionGeneration: number;
  startedAt: Timestamp;
  state: LeadState;
  /** The current lead thread on the project's machine; earlier ones stay on the node as history. */
  threadId: ThreadId;
};

export type LeadStartInput = {
  /** Start a fresh lead thread from the current digest (sessionGeneration goes up); the old one stays as history. */
  fresh?: boolean;
  machineId: MachineId;
  projectId: ProjectId;
};

export type LeadStartOutput = {
  lastWakeAt?: Timestamp;
  next?: string;
  /** M4: the lead thread hit a usage limit; derived from the usage layer when read. */
  parked?: UsageParked;
  projectRef: ProjectRef;
  /** Bumped by each `lead_start {fresh}`. */
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
  /** The secret's key, or the tool for a permission prompt. */
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

/** `machine.guard`. */
export type MachineGuardData = {
  /** true: new agents wait; false: they start again. */
  paused: boolean;
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

export type MilestoneId = string;

export type MilestoneState = "open" | "done";

/** A milestone with its derived figure. */
export type MilestoneView = {
  createdAt: Timestamp;
  doneAt?: Timestamp;
  /** The first item's time. */
  firstItemAt?: Timestamp;
  milestoneId: MilestoneId;
  position: number;
  progress: Progress;
  projectRef: ProjectRef;
  state: MilestoneState;
  title: string;
};

/** Space on the volume holding a node's worktrees and build cache. */
export type NodeDisk = {
  /** Free for the node's user. */
  freeBytes: number;
  /**
   * Below this the hub starts no new agents there: node.json's `minFreeGb`, else 10% of the volume or 20 GB,
   * whichever is larger.
   */
  minFreeBytes: number;
  totalBytes: number;
};

/** What a machine reports about itself with each heartbeat. */
export type NodeLoad = {
  /** Logical CPUs. */
  cpus: number;
  /** The volume holding the node's worktrees and build cache; absent from older nodes and when it can't be read. */
  disk?: NodeDisk;
  /** Disk to allow per new agent's worktree: node.json's `diskPerAgentGb`, else 5 GB. Absent from older nodes. */
  diskPerAgentBytes?: number;
  /**
   * The latest claude.ai subscription limit of each type claude reported. Empty behind API keys and gateways,
   * which send none.
   */
  limits?: LoginLimit[];
  /** The 1-minute load average. */
  load1: number;
  /**
   * Memory to allow per agent when sizing the machine's cap: node.json's `memPerAgentGb`, else 2 GB. Absent from
   * older nodes.
   */
  memPerAgentBytes?: number;
  /** Physical memory; absent from older nodes and when it can't be read. */
  memTotalBytes?: number;
  /** Memory in use (total minus available), percent. */
  memUsedPct?: number;
};

/**
 * When a client may interrupt the human with an event marked `attention`. Quiet windows are absolute times the
 * hub computes from `policy.quiet_hours` in `policy.tz`: the one under way (if any) and the next.
 */
export type NotifyPolicy = {
  /** At most one notification per this many seconds; what arrives meanwhile is folded into the next. */
  coalesceSec: number;
  /**
   * Only "urgent" events notify inside these; empty when quiet hours are off. Ask again after the last one ends
   * or on decision.recorded.
   */
  quiet: QuietWindow[];
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
  title: string;
  total: number;
  updatedAt: Timestamp;
  workstreamId: WorkstreamId;
};

export type OrderGetInput = {
  workstreamId: WorkstreamId;
};

export type OrderGetOutput = {
  /** Active decisions scoped to it. Absent from older hubs. */
  decisions?: Decision[];
  /** Newest first. */
  doneLanes: AgentLane[];
  /** Its project's lead (shared by every order of the project); absent when the project has none. */
  lead?: AgentLane;
  next?: string;
  order: OrderCard;
  /** Its open secret and approval requests. */
  requests: HumanRequest[];
  /** Its steers (to the lead or one of its tasks) with their receipts, newest first. Absent from older hubs. */
  steers?: Steer[];
  truncated?: boolean;
  /** Its record: the brief and its done-when. Absent from older hubs. */
  workstream?: Workstream;
};

/** An order's phase: the first match in this order wins, and the board sorts by it. */
export type OrderPhase =
  | "stopped"
  | "done"
  | "waiting_on_you"
  | "working"
  | "reviewing"
  | "merging"
  | "queued"
  | "planning"
  | "idle";

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
  /** What verified it, e.g. "#212 merged by the train". */
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

/** Who wrote the PR: fleetd's agent when one did, and the GitHub account it was opened from. */
export type PrAuthor = {
  effort?: Effort;
  /** The writing agent's lane in the agents view. */
  laneId?: string;
  /** GitHub login; absent when GitHub wasn't reached. */
  login?: string;
  model?: string;
  role?: AgentRole;
  taskId?: TaskId;
  /** Its session, for `agent_work`. */
  threadRef?: ThreadRef;
  /** The agent's task title. */
  title?: string;
};

/** One check run or commit status on the head. fleetd's own merge statuses are left out: `queue` says the same. */
export type PrCheck = {
  completedAt?: Timestamp;
  /** GitHub's conclusion as given, lowercased ("success", "failure", "skipped", "timed_out"…). */
  conclusion?: string;
  name: string;
  startedAt?: Timestamp;
  state: ChecksState;
  url?: string;
};

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

export type PrDiffInput = {
  limit?: number;
  number: number;
  offset?: number;
  path: string;
  repo: GitHubRepo;
};

export type PrDiffOutput = {
  headSha?: CommitSha;
  lines: DiffLine[];
  next?: string;
  /** Pass back as `offset` for the next page; absent on the last. */
  nextOffset?: number;
  /** GitHub shows no diff for this file (binary, or too large). */
  noDiff?: boolean;
  /** Lines in the file's diff. */
  total: number;
  truncated?: boolean;
};

/** One changed file. */
export type PrFile = {
  additions: number;
  deletions: number;
  /** Lines `pr_diff` pages through; absent when GitHub shows no diff for it (binary, or too large). */
  diffLines?: number;
  /** Repo-relative; the new path of a rename. */
  path: string;
  /** A rename's old path. */
  previousPath?: string;
  status: PrFileStatus;
};

export type KnownPrFileStatus = "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
/** KnownPrFileStatus, or a value from a newer hub. */
export type PrFileStatus = KnownPrFileStatus | (string & {});

export type PrFilesInput = {
  number: number;
  offset?: number;
  repo: GitHubRepo;
};

export type PrFilesOutput = {
  files: PrFile[];
  /** The head these files are of. */
  headSha?: CommitSha;
  next?: string;
  /** Pass back as `offset` for the next page; absent on the last. */
  nextOffset?: number;
  /** Changed files in the PR. */
  total: number;
  truncated?: boolean;
};

export type PrGetInput = {
  number: number;
  repo: GitHubRepo;
};

export type PrGetOutput = {
  additions?: number;
  baseBranch?: string;
  /** The PR's description, at most 8000 characters. Secrets are replaced by `[secret]`. */
  body: string;
  changedFiles?: number;
  checks: PrCheck[];
  deletions?: number;
  githubError?: string;
  headSha?: CommitSha;
  /** Its moves through the merge queue, newest first. */
  history: PrQueueStep[];
  links: PrLinks;
  next?: string;
  pr: PrRow;
  /** Newest first: agent verdicts and people's reviews. */
  reviews: PrReviewEntry[];
  truncated?: boolean;
};

export type PrLinks = {
  checks: string;
  files: string;
  /** The squash commit on the base, once merged. */
  mergeCommit?: string;
  pr: GitHubPrUrl;
};

export type PrListInput = {
  closedSince?: Timestamp;
  projectRef: ProjectRef;
};

export type PrListOutput = {
  at: Timestamp;
  /** GitHub couldn't be reached: the list holds only the PRs fleetd records, without checks. Why, and what to do. */
  githubError?: string;
  next?: string;
  prs: PrRow[];
  truncated?: boolean;
};

/** Where the PR stands in fleetd's merge queue. Absent from a PR fleetd doesn't land. */
export type PrQueue = {
  changeId: ChangeId;
  /** PRs waiting in the same queue. */
  length: number;
  /** 0-based place in the queue; absent when not waiting in it. */
  position?: number;
  /** Why it is held or was sent back: a conflict, failing check names, or the refusal's fix. */
  reason?: string;
  state: ChangeState;
};

/** One move of the PR through the merge queue. */
export type PrQueueStep = {
  at: Timestamp;
  from: ChangeState;
  to: ChangeState;
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
  /** One for every PR the train lands. */
  reviewsNeeded: number;
  state: ChangeState;
  /** The task that opened it (its writer), when the hub knows: the board groups the PR's checkers under it. */
  taskId?: TaskId;
  url: GitHubPrUrl;
};

/** One review: an agent's verdict with its findings, or a person's review on GitHub. */
export type PrReviewEntry = {
  /** The reviewing agent (reviewer or QA); absent for a person's review. */
  agent?: PrAuthor;
  at: Timestamp;
  /** Findings that must be fixed before merging; agent reviews only. */
  blocking?: number;
  /** It reviewed the PR's current change (an agent review stays current across a rebase that changes nothing). */
  current: boolean;
  /** GitHub login of a person's review. */
  login?: string;
  nonBlocking?: number;
  /** The agent's findings, or the person's review text. Secrets are replaced by `[secret]`. */
  text: string;
  verdict: ReviewVerdictKind;
};

/** One PR as the list shows it. */
export type PrRow = {
  author: PrAuthor;
  /** Its head branch. */
  branch?: string;
  /** Absent when GitHub wasn't reached. */
  checks?: ChecksSummary;
  createdAt: Timestamp;
  mergedAt?: Timestamp;
  number: number;
  queue?: PrQueue;
  repo: GitHubRepo;
  review: ReviewSummary;
  state: PrState;
  /** GitHub's title; the writing agent's task title when GitHub wasn't reached. */
  title: string;
  updatedAt: Timestamp;
  url: GitHubPrUrl;
  /** The work it belongs to, when fleetd's agents wrote it. */
  workstreamId?: WorkstreamId;
};

/** The PR on GitHub. */
export type KnownPrState = "open" | "draft" | "merged" | "closed";
/** KnownPrState, or a value from a newer hub. */
export type PrState = KnownPrState | (string & {});

/**
 * One task profile's part of a scope's agent time and usage, from the spans kept (`coverage.detailSince` on): the
 * tasks that ran on it, and the lead's spans under high.
 */
export type ProfileTotal = {
  /** Exclusive agent time. */
  agentMs: number;
  /** The model's part of it. */
  modelMs: number;
  /** What claude reported for its messages. */
  outputTokens: number;
  profile: TaskProfile;
};

/** A figure. `pct` counts verified must items by size only; polish shows beside it. */
export type Progress = {
  asOf: Timestamp;
  /** Must items done and in the figure. */
  done: number;
  /** The latest scope change, e.g. "↓ from 80% · +3 items: time inspector added". */
  marker?: Marker;
  /** floor(100 · must points done / must points open or done); the polish figure when there are no must items. */
  pct: number;
  /** Polish items done and in the figure ("polish 2/5"). */
  polishDone: number;
  polishPct?: number;
  polishTotal: number;
  total: number;
};

/** Why the figure fell. */
export type ProgressDrop = {
  fromPct: number;
  reason: DropReason;
  /** "CI failed on #212", "+2 items: time inspector added". */
  text: string;
};

/**
 * A project's two-tone bar: solid is what fleetd verified, lighter is credit for work in flight. Every stage it
 * credits is one fleetd observed (an event, a PR or a CI state), never an agent's word, and nothing in it is a time.
 */
export type ProgressEstimate = {
  /** The lighter part: credit for open units' reached stages, plus in-stage credit for the time work on them ran. */
  inFlightPct: number;
  /** verified + in flight, floored; 100 only when everything is verified. */
  pct: number;
  /** The solid part: points verified over points counted. */
  verifiedPct: number;
};

/** One point of a project's series: its bar over time, oldest first. */
export type ProgressPoint = {
  at: Timestamp;
  /** Set when the figure fell at this point; it never falls without one. */
  drop?: ProgressDrop;
  /**
   * Set while the figure holds because the work in flight paused, waiting for an answer or for a usage limit to
   * reset ("paused: an agent hit a usage limit"). A marker, not a drop: what was earned stays.
   */
  paused?: string;
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
  dryRun?: boolean;
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
  /** A dry run with url: where it would clone, and whether that folder already holds a checkout. */
  clone?: CloneTarget;
  /** False when the directory was already a project (it is renamed when a title is given), and in a dry run. */
  created: boolean;
  /** For a path, at once; for a clone, on `project.added`; for a dry run, the repository's facts. */
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
  /** Long lists are cut so the event fits the log's 2 KB of data; `project_add` with `dryRun` returns them whole. */
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
  machineId?: MachineId;
  projectId?: ProjectId;
  /** Without projectId: only projects whose title or path contains it. */
  query?: string;
};

/** The projects, or one project's outcome (its fields at the top level). */
export type ProjectGetOutput = {
  asOf?: Timestamp;
  /** Absent until lead_start. */
  lead?: Lead;
  /** Whether the lead may run a task on the medium profile (`project_set`); absent from older hubs, where it is on. */
  mediumAllowed?: boolean;
  /** Hint for the next call. */
  next?: string;
  project?: ProjectSummary;
  /** Without projectId: the projects. */
  projects?: ProjectSummary[];
  stale?: boolean;
  /** Absent until the project has a task. */
  taskCounts?: TaskCounts;
  /** Newest first. */
  tasks?: Task[];
  /** Newest activity first. Task threads are left out; they show under `tasks`. */
  threads?: ThreadSummary[];
  /** The merge trains of the project's repos; absent until one of its PRs was enqueued. */
  trains?: TrainState[];
  /** True when `threads`, `workstreams` or `tasks` was trimmed to its limit. */
  truncated?: boolean;
  /** Open workstreams (not done, stopped or failed), newest first. */
  workstreams?: Workstream[];
};

export type ProjectId = string;

/** What a project's checkout or repository says: the default branch, CI and merge rules, and one line on what the lead will need. */
export type ProjectInspect = {
  ci: CiInfo;
  defaultBranch?: string;
  /** One line for a person, e.g. "no CI found: the merge train holds its PRs until the repo has CI". */
  leadNeeds: string;
  merge: MergeRules;
  /** What could not be read, e.g. "branch rules need admin access on acme/storefront". */
  notes: string[];
  /** Absent for a checkout without a GitHub remote. */
  repo?: GitHubRepo;
};

/** The one-call project outcome, returned as-is by project_get. */
export type ProjectOutcome = {
  asOf: Timestamp;
  /** Absent until lead_start. */
  lead?: Lead;
  /** Whether the lead may run a task on the medium profile (`project_set`); absent from older hubs, where it is on. */
  mediumAllowed?: boolean;
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

/** What a project is doing, in one word. */
export type KnownProjectRowState = "working" | "waiting_on_you" | "blocked" | "idle";
/** KnownProjectRowState, or a value from a newer hub. */
export type ProjectRowState = KnownProjectRowState | (string & {});

export type ProjectSetInput = {
  machineId: MachineId;
  mediumAllowed: boolean;
  projectId: ProjectId;
};

export type ProjectSetOutput = {
  mediumAllowed: boolean;
  next?: string;
  truncated?: boolean;
};

/** One project on the Status screen: a state word, the two-tone bar, agents running and the last merge. */
export type ProjectStatusRow = {
  /** Its task agents holding a slot now (the lead's own turn is not one). */
  agentsRunning: number;
  asOf: Timestamp;
  /** Blocked only: why, in one line, for the expanded row. */
  blockedReason?: string;
  lastMerged?: LastMerged;
  /** The project's bar, under the drop rule of its series (status_get). Absent when it has nothing to count. */
  progress?: ProgressEstimate;
  projectRef: ProjectRef;
  /** Set when a source the row reads (its machine, its repos on GitHub, their merge train) went quiet. */
  stale?: StaleMark;
  state: ProjectRowState;
  title: string;
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

/** `prompt_get`: every level of one prompt for the asked project (or hub-wide). */
export type PromptDetail = {
  default: PromptVersion;
  effective: PromptVersion;
  global?: PromptOverride;
  group: PromptGroup;
  id: PromptId;
  kind: PromptKind;
  /** False for a one-shot: it has the hub-wide level only. */
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
  warnings: PromptWarning[];
};

export type PromptGetInput = {
  /** Absent: list every prompt. */
  id?: PromptId;
  /** The texts in effect for this project; absent: hub-wide. */
  projectRef?: ProjectRef;
};

export type PromptGetOutput = {
  next?: string;
  /** Without an id: your edits to prompts a release retired, hub-wide ones and the asked project's. */
  orphans?: RetiredPromptOverride[];
  /** With an id: that prompt. */
  prompt?: PromptDetail;
  /** Without an id: every prompt. */
  prompts?: PromptSummary[];
  truncated?: boolean;
};

/** Where the app lists it. */
export type PromptGroup = "lead" | "tasks" | "reviews_and_checks" | "messages" | "one_shots" | "instructions";

/** Prompt registry id, dotted lowercase words */
export type PromptId = string;

/** How the text reaches the model. */
export type PromptKind = "start" | "msg" | "oneshot" | "instructions";

/** A human's override: its text and the default it was edited from (absent for a hand-made file). */
export type PromptOverride = {
  base?: PromptRef;
  ref: PromptRef;
  text: string;
};

/** <prompt id>@<10 lowercase hex of the text's git blob SHA> */
export type PromptRef = string;

/** Which text is meant: the one shipped in the binary, the hub-wide override, or one project's override. */
export type PromptScope = "default" | "global" | "project";

export type PromptSetInput = {
  /** The default ref the text was edited from (`prompt_get` default.ref); absent: the one shipped now. */
  base?: PromptRef;
  /** Return the warnings without saving; with reset, the ref that would be in effect, without resetting. */
  dryRun?: boolean;
  id: PromptId;
  /** Required with scope project. */
  projectRef?: ProjectRef;
  /**
   * True deletes your text at this scope (or your edit to a prompt fleetd retired), so the next level applies.
   * Only an explicit reset does that: a missing text is an error, never a reset.
   */
  reset?: boolean;
  scope: PromptScope;
  /** The text to save. May be empty only for `instructions`. Required unless `reset` is true. */
  text?: string;
};

export type PromptSetOutput = {
  next?: string;
  ref: PromptRef;
  truncated?: boolean;
  /** What the edit may break; it is saved anyway. */
  warnings: PromptWarning[];
};

/** A row of `prompt_get`'s list. */
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

export type QuietWindow = {
  from: Timestamp;
  to: Timestamp;
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

/**
 * An override of a prompt a release retired (merged into another, or replaced by fixed text), kept so the human can
 * carry what they wrote into a prompt that still exists. Its file stays until `prompt_set` with `reset: true` on its id.
 */
export type RetiredPromptOverride = {
  /** The retired id. */
  id: PromptId;
  projectRef?: ProjectRef;
  /** `global` or `project`. */
  scope: PromptScope;
  /** The prompt that now covers what this one said, when one does. fleetd never copies the text over itself. */
  suggestedTarget?: PromptId;
  text: string;
  title: string;
  /** What replaced it, in one line. */
  why: string;
};

/** Its reviews, rolled up. */
export type KnownReviewState = "approved" | "changes_requested" | "none" | "pending";
/** KnownReviewState, or a value from a newer hub. */
export type ReviewState = KnownReviewState | (string & {});

export type ReviewSummary = {
  /** Clean agent reviews of the current change. */
  done: number;
  /** Agent reviews it needs before it can merge: 1 for a PR fleetd lands, else 0. */
  needed: number;
  state: ReviewState;
};

export type KnownReviewVerdictKind = "approved" | "changes_requested" | "commented" | "dismissed";
/** KnownReviewVerdictKind, or a value from a newer hub. */
export type ReviewVerdictKind = KnownReviewVerdictKind | (string & {});

/** Why a run ended, so a node going away reads apart from a person stopping it. Set once the run is no longer active. */
export type KnownRunEnd =
  | "completed"
  | "requested"
  | "superseded"
  | "node_stopping"
  | "node_restarted"
  | "machine_slept"
  | "exited"
  | "limited"
  | "context_full"
  | "failed"
  | "stalled";
/** KnownRunEnd, or a value from a newer hub. */
export type RunEnd = KnownRunEnd | (string & {});

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

export type Size = "s" | "m" | "l";

/** A span a machine spent asleep, epoch milliseconds; `machine.slept` carries the same fields as its data. */
export type SleptSpan = {
  fromMs: number;
  toMs: number;
};

export type SlotState = {
  /** The fleet cap: agents running at once across every project. */
  cap: number;
  perProject: SlotStatePerProject[];
  queued: number;
  used: number;
};

export type SlotStatePerProject = {
  /**
   * The most of the project's agents (its tasks: writers, readers, reviewers) that run at once; its lead is not
   * one. The fleet `cap` until set.
   */
  maxAgents: number;
  projectRef: ProjectRef;
  /** Its agents waiting for a slot, paused ones included. */
  queued: number;
  /** Its agents running now. Above `maxAgents` right after the cap was lowered: nothing is stopped for it. */
  running: number;
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
  /** `thread:<machine>/<thread>`, `change:<id>`, `requests:<order>`, `train:<repo>`, `fleet`, `order:<id>`. */
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
  /** `wait.request`: the secret's key. */
  key?: string;
  /** The node's own start stamp, kept when the clock offset was above 100 ms. */
  nodeStartMs?: number;
  outputTokens?: number;
  /** Free text from the source, e.g. a queue reason or a stop reason. */
  reason?: string;
  /** `wait.permission`: the node's request id, joined to the hub's approval request. */
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
  | "wait.retry.api"
  | "wait.retry.node"
  | "run.startup"
  | "compaction"
  | "queue.slot"
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
  | "queue.lease"
  | "run.queued"
  | "wait.permission"
  | "wait.request"
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

export type StatusGetInput = {
  projectRef?: ProjectRef;
};

export type StatusGetOutput = {
  next?: string;
  /** With projectRef. */
  row?: ProjectStatusRow;
  /** Without projectRef: by title. */
  rows?: ProjectStatusRow[];
  /**
   * With projectRef: the bar over time, oldest first: why it fell (`drop`) and when it held on paused work
   * (`paused`).
   */
  series?: ProgressPoint[];
  truncated?: boolean;
};

/** One steer and its receipt. */
export type Steer = {
  /** Acknowledged: the agent's reply, first 200 characters. */
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
  /** Acknowledged: the agent's reply, first 200 characters. */
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

/** Who a steer is for: an order's lead, or one task (writer, reviewer, …). */
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
  /** Acknowledged: the agent's reply, first 200 characters. */
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
  /** 1 for the first launch. */
  attempt: number;
  /** `fleetd/<taskId>-<slug>`; write tasks only. */
  branch?: string;
  createdAt: Timestamp;
  endedAt?: Timestamp;
  /** The plan item it was spawned for (`--item`). */
  itemId?: PlanItemId;
  kind: TaskKind;
  /** M4: its thread hit a usage limit; the task is idle until fleetd sends "continue" at `resumeAt`. */
  parked?: UsageParked;
  /** The PR a review task reviews. Required at spawn for review; absent on older rows (hub-spawned judges). */
  pr?: string;
  /** Resolved at spawn. Rows stored with a model and effort read as `high` (the hub migrates its own). */
  profile?: TaskProfile;
  projectRef: ProjectRef;
  prompt: string;
  /** A review task spawned with `--qa`. */
  qa?: boolean;
  /** Why it is queued, e.g. "fleet cap: 40 of 40 running". */
  queuedReason?: string;
  result?: TaskResult;
  startedAt?: Timestamp;
  state: TaskState;
  taskId: TaskId;
  threadRef?: ThreadRef;
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
  /** When the task was spawned: a `task.started` for a task spawned before a turn is not that turn's start. */
  createdAt?: Timestamp;
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

/** Only write tasks get a worktree. */
export type TaskKind = "write" | "read" | "review";

/**
 * What an agent runs on. There are exactly two, both claude-opus-5-5: `high` (effort high) is the default and what
 * the lead, every reviewer and every helper call run; `medium` (effort medium) is for mechanical tasks the lead picks.
 */
export type TaskProfile = "high" | "medium";

export type TaskResult = {
  at: Timestamp;
  branch?: string;
  /**
   * Why its last run ended (the node stopped, claude exited, a limit, context full, …); absent on results an
   * older hub recorded, and when it never ran.
   */
  endCause?: RunEnd;
  prUrl?: string;
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
  /**
   * Why the run ended: on `thread.completed`, `.failed`, `.interrupted` and `.usage_limited` from a node that
   * records it.
   */
  endCause?: RunEnd;
  /** The run ended while the hub was down and this event was emitted on its return. */
  late?: boolean;
  reason?: ThreadEventReason;
  runId?: string;
};

export type ThreadEventReason = "stalled" | "usage_limit" | "interrupted";

export type ThreadId = string;

export type ThreadRef = {
  machineId: MachineId;
  threadId: ThreadId;
};

export type ThreadStatus = "running" | "waiting" | "idle" | "completed" | "failed" | "interrupted" | "cancelled";

export type ThreadSummary = {
  asOf: Timestamp;
  /** As reported by the runner; not narrowed to Effort because it may report other levels. */
  effort?: string;
  /** Why its latest run ended; absent while it runs and from older nodes. */
  endCause?: RunEnd;
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
  /** High first; absent when no task or lead span is in the period. */
  byProfile?: ProfileTotal[];
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
 * `change.refused`, `pr.merged`, `pr.merged_outside`. Which fields each carries is in
 * `HubEventType`'s docs.
 */
export type TrainEventData = {
  changeId?: ChangeId;
  /** change.ci_failed: the failing check names. */
  checks?: string[];
  /** pr.merged on a repo with no CI: what fleetd checked instead. */
  ci?: string;
  fix?: string;
  logUrl?: string;
  mergedSha?: string;
  prNumber?: number;
  prUrl?: string;
  reason?: string;
  repo?: GitHubRepo;
  /** pr.merged: the writer task whose PR it was, when a task wrote it. */
  taskId?: TaskId;
  workstreamId?: WorkstreamId;
};

/** One repo's merge train, resolved for the strip: head first, then the queue in order, then today's merges. */
export type TrainLive = {
  chips: PrChip[];
  /** Merged since 00:00 UTC. */
  mergedToday: number;
  repo: GitHubRepo;
};

/** One serial train per repo. */
export type TrainState = {
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

export type Weight = "must" | "polish";

/** A command, file edit or tool call. Secrets in its summary and output are replaced by `[secret]`. */
export type WorkAction = {
  action: ActionItem;
  at: Timestamp;
  id: string;
};

/** A message the agent or its person wrote. Secrets are replaced by `[secret]`. */
export type WorkMessage = {
  at: Timestamp;
  id: string;
  role: TailRole;
  /** The last 2000 characters of a longer message. */
  text: string;
};

/** One step of an agent's work. */
export type WorkStep = WorkMessage & {
  kind: "message";
} | WorkAction & {
  kind: "action";
};

export type Workstream = {
  /** Absent while draft. */
  brief?: Brief;
  createdAt: Timestamp;
  headline?: string;
  headlineAt?: Timestamp;
  projectRef: ProjectRef;
  source: WorkstreamSource;
  state: WorkstreamState;
  title: string;
  updatedAt: Timestamp;
  workstreamId: WorkstreamId;
};

/** `workstream.created`, `workstream.running`, `workstream.state`, `workstream.done`. */
export type WorkstreamEventData = {
  /** workstream.state: the brief was set or edited. */
  briefEdited?: boolean;
  by?: string;
  /** workstream.state (stopped) and workstream.done: why, and who. */
  reason?: string;
  /** workstream.state: the new state. */
  state?: WorkstreamState;
  workstreamId: WorkstreamId;
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

export type WorkstreamSource = {
  at: Timestamp;
  /** Who submitted it: an agent keyId, "human" or "lead:<machineId>/<projectId>". */
  by: string;
  channel: IntakeChannel;
  text: string;
};

export type WorkstreamState = "done" | "stopped" | "open";

/** Every tool the app can `call`: its input and its output. */
export interface ToolMap {
  actions_list: { input: ActionsListInput; output: ActionsListOutput };
  agent_work: { input: AgentWorkInput; output: AgentWorkOutput };
  agents_list: { input: AgentsListInput; output: AgentsListOutput };
  approval_answer: { input: ApprovalAnswerInput; output: ApprovalAnswerOutput };
  attachment_get: { input: AttachmentGetInput; output: AttachmentGetOutput };
  attachment_put: { input: AttachmentPutInput; output: AttachmentPutOutput };
  cap_set: { input: CapSetInput; output: CapSetOutput };
  changes_list: { input: ChangesListInput; output: ChangesListOutput };
  chat_history: { input: ChatHistoryInput; output: ChatHistoryOutput };
  chat_send: { input: ChatSendInput; output: ChatSendOutput };
  chat_stop: { input: ChatStopInput; output: ChatStopOutput };
  decisions_record: { input: DecisionsRecordInput; output: DecisionsRecordOutput };
  decisions_search: { input: DecisionsSearchInput; output: DecisionsSearchOutput };
  doctor_fix: { input: DoctorFixInput; output: DoctorFixOutput };
  doctor_list: { input: DoctorListInput; output: DoctorListOutput };
  events_wait: { input: EventsWaitInput; output: EventsWaitOutput };
  fleetd_status: { input: FleetdStatusInput; output: FleetdStatusOutput };
  hub_info: { input: HubInfoInput; output: HubInfoOutput };
  lead_start: { input: LeadStartInput; output: LeadStartOutput };
  order_get: { input: OrderGetInput; output: OrderGetOutput };
  orders_board: { input: OrdersBoardInput; output: OrdersBoardOutput };
  plan_get: { input: PlanGetInput; output: PlanGetOutput };
  pr_diff: { input: PrDiffInput; output: PrDiffOutput };
  pr_files: { input: PrFilesInput; output: PrFilesOutput };
  pr_get: { input: PrGetInput; output: PrGetOutput };
  pr_list: { input: PrListInput; output: PrListOutput };
  project_add: { input: ProjectAddInput; output: ProjectAddOutput };
  project_discover: { input: ProjectDiscoverInput; output: ProjectDiscoverOutput };
  project_files: { input: ProjectFilesInput; output: ProjectFilesOutput };
  project_get: { input: ProjectGetInput; output: ProjectGetOutput };
  project_remove: { input: ProjectRemoveInput; output: ProjectRemoveOutput };
  project_set: { input: ProjectSetInput; output: ProjectSetOutput };
  project_stop: { input: ProjectStopInput; output: ProjectStopOutput };
  prompt_get: { input: PromptGetInput; output: PromptGetOutput };
  prompt_set: { input: PromptSetInput; output: PromptSetOutput };
  requests_list: { input: RequestsListInput; output: RequestsListOutput };
  secret_submit: { input: SecretSubmitInput; output: SecretSubmitOutput };
  session_prompt_get: { input: SessionPromptGetInput; output: SessionPromptGetOutput };
  status_get: { input: StatusGetInput; output: StatusGetOutput };
  steer_send: { input: SteerSendInput; output: SteerSendOutput };
  steer_withdraw: { input: SteerWithdrawInput; output: SteerWithdrawOutput };
  task_get: { input: TaskGetInput; output: TaskGetOutput };
  tasks_list: { input: TasksListInput; output: TasksListOutput };
  thread_tail: { input: ThreadTailInput; output: ThreadTailOutput };
  thread_window: { input: ThreadWindowInput; output: ThreadWindowOutput };
  time_breakdown: { input: TimeBreakdownInput; output: TimeBreakdownOutput };
  time_insights: { input: TimeInsightsInput; output: TimeInsightsOutput };
  time_retention_set: { input: TimeRetentionSetInput; output: TimeRetentionSetOutput };
  time_spans: { input: TimeSpansInput; output: TimeSpansOutput };
  usage_resume: { input: UsageResumeInput; output: UsageResumeOutput };
  usage_status: { input: UsageStatusInput; output: UsageStatusOutput };
  wake_cancel: { input: WakeCancelInput; output: WakeCancelOutput };
  wake_list: { input: WakeListInput; output: WakeListOutput };
  wake_set: { input: WakeSetInput; output: WakeSetOutput };
  workstream_list: { input: WorkstreamListInput; output: WorkstreamListOutput };
}

/** `HubEvent.data` by event type, for the types whose data has a declared shape. */
export interface HubEventDataMap {
  "agents.cap": AgentsCapData;
  "change.ci_failed": TrainEventData;
  "change.needs_rebase": TrainEventData;
  "change.queued": TrainEventData;
  "change.ready": TrainEventData;
  "change.refused": TrainEventData;
  "change.state": ChangeStateData;
  "chat.message": ChatMessageEventData;
  "chat.waiting": ProjectChatState;
  "ci.main": CiMainData;
  "machine.guard": MachineGuardData;
  "machine.slept": MachineSleptData;
  "plan.changed": PlanChangedData;
  "plan.verified": PlanVerifiedData;
  "pr.merged": TrainEventData;
  "pr.merged_outside": TrainEventData;
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
  "task.queued": TaskEventData;
  "task.started": TaskEventData;
  "thread.completed": ThreadEventData;
  "thread.failed": ThreadEventData;
  "thread.interrupted": ThreadEventData;
  "thread.started": ThreadEventData;
  "thread.usage_limited": UsageEventData;
  "thread.waiting": ThreadEventData;
  "usage.breaker": UsageEventData;
  "usage.resumed": UsageEventData;
  "workstream.created": WorkstreamEventData;
  "workstream.done": WorkstreamEventData;
  "workstream.running": WorkstreamEventData;
  "workstream.state": WorkstreamEventData;
}
