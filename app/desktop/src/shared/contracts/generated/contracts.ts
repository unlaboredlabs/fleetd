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

/** The info string of a block's code fence in a lead message. */
export const BLOCK_FENCE = "fleetd-block";

/** The block schema this build speaks: every block's `v`. */
export const BLOCK_VERSION = 1;

/** Largest secret a secret ask takes. */
export const SECRET_MAX_BYTES = 65536;

/** Largest value of one project variable, plain or secret. */
export const ENV_VALUE_MAX_BYTES = 65536;

/** All of one project's variable values together. */
export const ENV_TOTAL_MAX_BYTES = 524288;

/** Largest attachment attachment_put takes. */
export const ATTACHMENT_MAX_BYTES = 26214400;

/** Largest piece of a file attachment_part and attachment_put take in one call. */
export const ATTACHMENT_PART_BYTES = 524288;

/** Most attachments one message or steer carries. */
export const ATTACHMENTS_MAX = 20;

/** Longest chat message, in UTF-16 units. */
export const CHAT_TEXT_MAX = 100000;

/** Longest steer, in UTF-16 units. */
export const STEER_TEXT_MAX = 20000;

/** Highest cap memory_caps_set gives one memory file. */
export const MEMORY_FILE_CAP_MAX = 100000;

/** Highest cap memory_caps_set gives one project's memory together. */
export const MEMORY_PROJECT_CAP_MAX = 400000;

/** Lowest cap memory_caps_set gives a memory file or a project. */
export const MEMORY_CAP_MIN = 1000;

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
  server?: string;
} | {
  detail?: string;
  kind: "web";
} | {
  kind: "planning";
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

/**
 * Who a PR's author or merger was, by the git host's account type: git authorship can't tell, because agents commit
 * under the person's own identity.
 */
export type ActorKind = "human" | "bot" | "train" | "unknown";

/** An agent at work: the client fills in its live state. Exactly one of `taskId` and `threadRef`. */
export type AgentBlock = {
  taskId?: TaskId;
  threadRef?: ThreadRef;
};

export type AgentKeyInfo = {
  createdAt: Timestamp;
  grants: Grant[];
  keyId: string;
  /** Absent means "agent". */
  kind?: KeyKind;
  lastUsedAt?: Timestamp;
  name: string;
  /** The person a human key belongs to. Absent for an agent key, and from a hub before people. */
  person?: PersonRef;
  prefix: string;
  revokedAt?: Timestamp;
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
  /** What it runs on: a task's own profile; a lead the default's. Absent from older hubs. */
  profile?: ProfileName;
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
  /** What it runs on: a task's own profile; a lead the default's. Absent from older hubs. */
  profile?: ProfileName;
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

export type AndroidHealth = {
  /** The command a person runs to fix it, when there is one. */
  fix?: string;
  /** Plain words: what is installed, or what is wrong. */
  message: string;
  state: AndroidState;
};

/** Where a node's android sessions stand, for the doctor. */
export type KnownAndroidState = "installing" | "ready" | "wanted" | "unavailable";
/** KnownAndroidState, or a value from a newer hub. */
export type AndroidState = KnownAndroidState | (string & {});

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
} | {
  focused: boolean;
  /** Chosen by the client; the hub echoes it only on the error for a frame it can't read. */
  id?: string;
  input: boolean;
  project?: ProjectRef;
  t: "presence";
} | {
  session?: BrowserSessionId;
  t: "browser_watch";
} | {
  input: BrowserInput;
  session: BrowserSessionId;
  t: "browser_input";
};

/** A `call` failed, or (without `id`) the session did. */
export type AppError = {
  code: ErrorCode;
  fix?: string;
  /** Present when this answers a `call`. */
  id?: string;
  message: string;
};

/**
 * `app.presence`: the app was focused on a project's screen (the event's machine and project) with input in the
 * last 60 s, for one interval. Only that: never keystrokes or content. At most one per minute per key.
 */
export type AppPresenceData = {
  /** The human key's name. */
  by?: string;
  /** Epoch milliseconds on the hub clock. */
  fromMs: number;
  toMs: number;
};

export type AppServerMessage = {
  /** The newer client messages it reads ([`APP_FEATURES`]). Absent from older hubs: send them none. */
  features?: string[];
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
} | BrowserFrame & {
  t: "browser_frame";
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

/**
 * A question for the human, as buttons: Approve and Deny without `options`, one of `options` with them. The
 * answer is the human's chat reply (`chat_send` with the button's label as its text), so only the human answers
 * it; an agent's message never does. A command that needs approval still goes through `gated_run`.
 */
export type AskBlock = {
  options?: string[];
  question: string;
};

export type AskHandle = string;

/** An image or clip already uploaded to the hub: its bytes come from `attachment_get`. */
export type AttachmentBlock = {
  attachmentId: AttachmentId;
  caption?: string;
};

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

export type AttachmentPartInput = {
  /** Standard base64. */
  dataB64: string;
  /** With uploadId: the bytes sent so far, which must match the hub's count. */
  offset?: number;
  uploadId?: UploadId;
};

export type AttachmentPartOutput = {
  /** Received so far. */
  bytes: number;
  next?: string;
  truncated?: boolean;
  uploadId: UploadId;
};

export type AttachmentPutInput = {
  /** Standard base64: the whole file, or with uploadId its last piece. At most 25 MiB decoded, all pieces together. */
  dataB64: string;
  mime: AttachmentMime;
  name: string;
  /** The pieces sent with attachment_part, which come before dataB64. */
  uploadId?: UploadId;
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

export type Automation = {
  automationId: AutomationId;
  createdAt: Timestamp;
  /** Who made it: a keyId, "human" or "lead:<machineId>/<projectId>". */
  createdBy: string;
  lastRun?: AutomationRun;
  name: string;
  /** The schedule's next run; absent while paused or without a schedule. */
  nextRunAt?: Timestamp;
  /** A paused automation's schedule and webhook start nothing; Run now still runs it. */
  paused: boolean;
  projectRef: ProjectRef;
  prompt: string;
  /** Absent: no schedule. */
  schedule?: AutomationSchedule;
  updatedAt: Timestamp;
  /** Whether it has a webhook URL. The URL holds a secret, shown once when it is made or rotated. */
  webhook: boolean;
};

export type AutomationCreateInput = {
  clientRequestId: string;
  name: string;
  projectRef: ProjectRef;
  prompt: string;
  schedule?: AutomationSchedule;
  /** Give it a webhook URL. */
  webhook?: boolean;
};

export type AutomationCreateOutput = {
  automation: Automation;
  next?: string;
  truncated?: boolean;
  /** Shown once: POST to it to start a run with the body as context. */
  webhookUrl?: string;
};

export type AutomationDeleteInput = {
  automationId: AutomationId;
};

export type AutomationDeleteOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

export type AutomationId = string;

export type AutomationListInput = {
  projectRef: ProjectRef;
};

export type AutomationListOutput = {
  automations: Automation[];
  /** The nightly memory refresh, listed with them as a built-in row; absent from older hubs. */
  memoryRefresh?: MemoryRefreshJob;
  next?: string;
  truncated?: boolean;
};

export type AutomationPauseInput = {
  automationId: AutomationId;
  paused: boolean;
};

export type AutomationPauseOutput = {
  automation: Automation;
  next?: string;
  truncated?: boolean;
};

export type AutomationRotateInput = {
  automationId: AutomationId;
};

export type AutomationRotateOutput = {
  automation: Automation;
  next?: string;
  truncated?: boolean;
  webhookUrl: string;
};

export type AutomationRun = {
  at: Timestamp;
  automationId: AutomationId;
  /** Who pressed Run now: a keyId, "human" or "lead:<machineId>/<projectId>". */
  by?: string;
  endedAt?: Timestamp;
  /** A scheduled run the hub was down for, run once on its return: by how many minutes. */
  lateMin?: number;
  /** A webhook run: the size of the body it carried. The body itself is in automation_runs only. */
  payloadBytes?: number;
  runId: AutomationRunId;
  /** A scheduled run: the time it was due. */
  scheduledAt?: Timestamp;
  state: AutomationRunState;
  trigger: AutomationTrigger;
  /** Why it was skipped or failed. */
  why?: string;
  /** The order it opened. */
  workstreamId?: WorkstreamId;
};

export type AutomationRunId = string;

export type AutomationRunInput = {
  automationId: AutomationId;
};

export type AutomationRunOutput = {
  next?: string;
  run: AutomationRun;
  truncated?: boolean;
};

export type KnownAutomationRunState = "running" | "done" | "stopped" | "skipped" | "failed";
/** KnownAutomationRunState, or a value from a newer hub. */
export type AutomationRunState = KnownAutomationRunState | (string & {});

export type AutomationRunsInput = {
  automationId: AutomationId;
  limit: number;
};

export type AutomationRunsOutput = {
  next?: string;
  runs: AutomationRun[];
  truncated?: boolean;
};

/** Standard 5-field cron (or @daily, @hourly…) read in `tz`; the hub parses it. */
export type AutomationSchedule = {
  cron: string;
  tz: TimeZone;
};

/** What started a run. */
export type KnownAutomationTrigger = "schedule" | "webhook" | "manual";
/** KnownAutomationTrigger, or a value from a newer hub. */
export type AutomationTrigger = KnownAutomationTrigger | (string & {});

export type AutomationUpdateInput = {
  automationId: AutomationId;
  name?: string;
  prompt?: string;
  /** true: take its schedule off. */
  removeSchedule?: boolean;
  schedule?: AutomationSchedule;
  /** true adds a webhook URL (kept if it has one); false removes it. */
  webhook?: boolean;
};

export type AutomationUpdateOutput = {
  automation: Automation;
  next?: string;
  truncated?: boolean;
  /** Only when this update made its webhook URL. */
  webhookUrl?: string;
};

/** The square of a picture to keep, in its pixels as it shows (EXIF orientation applied): its top-left corner and side. */
export type AvatarCrop = {
  size: number;
  x: number;
  y: number;
};

export type BaseError = {
  kind: BaseErrorKind;
  /** git's first line, e.g. "fatal: Authentication failed for 'https://github.com/a/b.git/'"; "offline". */
  message: string;
};

/** Why a worktree's base may be behind its remote's default branch. */
export type BaseErrorKind = "offline" | "auth" | "no_access" | "no_ssh" | "no_default_branch" | "no_remote" | "failed";

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

/**
 * Who drives a live session's browser. A person takes it over (human) and hands it back (handing_back, until the
 * agent's next tool call sees the page as the person left it, then agent). While it isn't the agent's, the agent's
 * browser tools answer that a person has control.
 */
export type KnownBrowserControl = "agent" | "human" | "handing_back";
/** KnownBrowserControl, or a value from a newer hub. */
export type BrowserControl = KnownBrowserControl | (string & {});

export type BrowserControlInput = {
  control: BrowserControlTo;
  sessionId: BrowserSessionId;
};

export type BrowserControlOutput = {
  next?: string;
  session: BrowserSession;
  truncated?: boolean;
};

/**
 * Who should drive a live session: `human` takes it over from the agent; `agent` hands it back, and the session is
 * `handing_back` until the agent's next command, which sees the page as the person left it.
 */
export type BrowserControlTo = "human" | "agent";

/**
 * One screencast frame of a live session, for the person watching. Ephemeral: the hub keeps only the newest per
 * session, and a slow link skips frames rather than queueing them.
 */
export type BrowserFrame = {
  control: BrowserControl;
  height: number;
  /** A JPEG, base64. */
  jpegB64: string;
  /** 1, 2, ... per watch; a frame older than one already shown is dropped. */
  seq: number;
  sessionId: BrowserSessionId;
  /** The page the frame shows, when the node knows it. */
  url?: string;
  /** The image's size in pixels: `browser_input` coordinates are in it. */
  width: number;
};

/**
 * A person's input to a session they have control of (`control` human). Coordinates are in the last frame's pixels;
 * the node scales them to the page.
 */
export type BrowserInput = {
  action: MouseAction;
  button?: MouseButton;
  /** 1 for a click, 2 for a double click. */
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  kind: "mouse";
  modifiers?: number;
  x: number;
  y: number;
} | {
  action: KeyAction;
  code?: string;
  key: string;
  kind: "key";
  modifiers?: number;
  text?: string;
} | {
  kind: "text";
  text: string;
};

/** A stored file of a recording. */
export type BrowserRecordingEntry = {
  bytes: number;
  file: RecordingFile;
};

export type BrowserRecordingGetInput = {
  file: RecordingFile;
  offset?: number;
  sessionId: BrowserSessionId;
};

export type BrowserRecordingGetOutput = {
  /** The whole file's size. */
  bytes: number;
  /** At most RECORDING_PART_BYTES decoded; empty at the end. */
  dataB64: string;
  done: boolean;
  file: RecordingFile;
  mime: string;
  next?: string;
  offset: number;
  sessionId: BrowserSessionId;
  truncated?: boolean;
};

/**
 * How long the hub keeps recordings: each for `retentionDays`, and a project's together up to `maxGbPerProject`
 * (its oldest go first).
 */
export type BrowserRetention = {
  maxGbPerProject: number;
  retentionDays: number;
};

/**
 * How long the hub keeps recordings: each for `retentionDays`, and a project's together up to `maxGbPerProject`
 * (its oldest go first).
 */
export type BrowserRetentionSetInput = {
  maxGbPerProject: number;
  retentionDays: number;
};

export type BrowserRetentionSetOutput = {
  next?: string;
  retention: BrowserRetention;
  truncated?: boolean;
};

/** One session as the hub keeps it. */
export type BrowserSession = {
  control: BrowserControl;
  /** How many logins the node filled from 1Password; never their values. */
  credentialsFilled?: number;
  endedAt?: Timestamp;
  /** The recording's files on the hub; empty until it is recorded, and again once it expired. */
  files?: BrowserRecordingEntry[];
  kind?: SessionKind;
  /** Why a session is lost, or what its recording lacks ("no video: this machine has no ffmpeg"). */
  note?: string;
  projectRef: ProjectRef;
  purpose: string;
  sessionId: BrowserSessionId;
  startedAt: Timestamp;
  state: BrowserSessionState;
  /** What the agent said it needs a person for, while it waits for one (`request_takeover`). */
  takeoverReason?: string;
  /** The task whose agent opened it; absent for the project's lead. */
  taskId?: TaskId;
  /** The agent's session (its thread on the project's machine). */
  threadId: ThreadId;
};

/**
 * `browser.session`: a session started, changed hands, ended or its recording landed. The rest comes from
 * `browser_sessions`.
 */
export type BrowserSessionEventData = {
  control: BrowserControl;
  projectRef: ProjectRef;
  sessionId: BrowserSessionId;
  state: BrowserSessionState;
  taskId?: TaskId;
};

export type BrowserSessionId = string;

/**
 * Where a session is. live → uploading → recorded; lost when the node could not record or upload it; expired once
 * retention deleted its recording (its row stays).
 */
export type KnownBrowserSessionState = "live" | "uploading" | "recorded" | "lost" | "expired";
/** KnownBrowserSessionState, or a value from a newer hub. */
export type BrowserSessionState = KnownBrowserSessionState | (string & {});

export type BrowserSessionsInput = {
  limit?: number;
  projectRef: ProjectRef;
  sessionId?: BrowserSessionId;
};

export type BrowserSessionsOutput = {
  next?: string;
  retention: BrowserRetention;
  sessions: BrowserSession[];
  truncated?: boolean;
};

export type CapSetInput = {
  /** The fleet cap: agents running at once across every project. Needs an admin key. */
  cap?: number;
  /** A machine's max agents. Needs an admin key. */
  machine?: CapSetMachine;
  project?: CapSetProject;
};

export type CapSetMachine = {
  /** Drop the setting: the machine runs what it is measured to fit again. */
  auto?: boolean;
  machineId: MachineId;
  /** 1 up to the fleet cap: the most agents that run on the machine at once, in place of what it is measured to fit. */
  maxAgents?: number;
};

export type CapSetOutput = {
  next?: string;
  /** The agents `pauseExtras` paused. */
  paused?: TaskId[];
  slots: SlotState;
  truncated?: boolean;
};

export type CapSetProject = {
  /** Drop the project's own max: it follows the default again, its machine's cap within the fleet cap. */
  followDefault?: boolean;
  /** 1 up to the fleet cap: the project's own max, which no later fleet or machine cap changes. */
  maxAgents?: number;
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
  /** The PRs that merge before it (`change_enqueue`'s `after`): it waits in line until each has merged. */
  after?: GitHubPrUrl[];
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

/** A line, bar or area chart: `x` labels along the bottom, one value per label in each series. */
export type ChartBlock = {
  chart: ChartType;
  series: ChartSeries[];
  title: string;
  /** The values' unit, e.g. "min", "%", "PRs". */
  unit?: string;
  x: string[];
};

export type ChartSeries = {
  name: string;
  /** One per `x` label, in order. */
  values: number[];
};

export type ChartType = "line" | "bar" | "area";

export type KnownChatAuthor = "human" | "lead" | "agent" | "system";
/** KnownChatAuthor, or a value from a newer hub. */
export type ChatAuthor = KnownChatAuthor | (string & {});

/**
 * One block: `v`, the block schema's version (`BLOCK_VERSION`), and its kind's fields. A kind or version a client
 * doesn't know shows as the part's text.
 */
export type ChatBlock = (ChartBlock & {
  kind: "chart";
} | TableBlock & {
  kind: "table";
} | DiffBlock & {
  kind: "diff";
} | PrBlock & {
  kind: "pr";
} | AgentBlock & {
  kind: "agent";
} | ChecklistBlock & {
  kind: "checklist";
} | AttachmentBlock & {
  kind: "image";
} | AttachmentBlock & {
  kind: "clip";
} | AskBlock & {
  kind: "ask";
}) & {
  v: number;
};

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
  /**
   * A system line "Memory refreshed: +a ~b −c": what the nightly memory refresh changed, each change undone on its
   * own or all together with `memory_undo`.
   */
  memoryRefreshed?: MemoryRefreshed;
  messageId: ChatMessageId;
  /** The lead flagged it for the person's look (`nudge`), or it is an agent's Try it suggestion. */
  nudge?: ChatNudge;
  /**
   * A final lead message of more than one bubble, or with a block: its bubbles in order. Absent: `text` is one
   * bubble (and while a message streams).
   */
  parts?: ChatPart[];
  /** A human message: the person who wrote it. Absent from a hub before people. */
  person?: PersonRef;
  /**
   * An agent's suggestion to try a PR (preview_suggest), posted once per PR with `text` in its words: the app
   * shows it as one line with Try it. Nothing runs from it.
   */
  previewSuggestion?: PreviewSuggestion;
  projectRef: ProjectRef;
  /** A system line "Remembered: …" or "Forgot: …": what the lead's `remember` or `forget` wrote, which `memory_undo` takes back. */
  remembered?: RememberedItem;
  /** A human message: the bubble it answers. */
  replyTo?: ChatReplyTo;
  seq: number;
  /** A human message: the skills it named with `$name`, which the lead's copy lists. */
  skills?: SkillName[];
  state: ChatMessageState;
  /** Markdown. Empty while a streamed message has no text yet, and for an inline `item`. */
  text: string;
  /** Set when the text was last appended to, or an item's state changed. */
  updatedAt?: Timestamp;
  /**
   * A system line "Cleanup kept 6 worktrees with unsaved work": the worktrees one nightly cleanup kept for work only
   * they hold.
   */
  worktreesKept?: WorktreesKept;
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

/**
 * A message worth the person's look: a showcase, something to try, a risk. It waits, below what the lead waits on
 * you for, until the person has seen the message or dismissed it, and for a day at most. In the app only: it sends
 * no notification.
 */
export type ChatNudge = {
  at: Timestamp;
  /** Why it no longer waits; absent while it does (or once a day has passed). */
  cleared?: ChatNudgeCleared;
  /** What to look at, in a few words: "the Machines page redesign". */
  reason: string;
};

export type ChatNudgeClearInput = {
  /** True: dismissed. Absent: seen. */
  dismissed?: boolean;
  messageId: ChatMessageId;
  projectRef: ProjectRef;
};

export type ChatNudgeClearOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

export type KnownChatNudgeCleared = "dismissed" | "seen" | "replaced" | "expired";
/** KnownChatNudgeCleared, or a value from a newer hub. */
export type ChatNudgeCleared = KnownChatNudgeCleared | (string & {});

/** An inline item that waits on the human: which message, and what it asks for. */
export type ChatOpenItem = {
  kind: ChatOpenItemKind;
  messageId: ChatMessageId;
};

/** `ChatItem`'s kind. */
export type KnownChatOpenItemKind = "secret_request" | "command_approval";
/** KnownChatOpenItemKind, or a value from a newer hub. */
export type ChatOpenItemKind = KnownChatOpenItemKind | (string & {});

/** A nudge still waiting, in a chat state: its message, and what to look at. */
export type ChatOpenNudge = {
  at: Timestamp;
  messageId: ChatMessageId;
  reason: string;
};

/**
 * One bubble of a lead message: `text.slice(start, end)` (UTF-16 offsets, like `ChatDelta.offset`), shown as
 * markdown, or as `block` when it has one (the slice is then the block's fence, its readable fallback).
 */
export type ChatPart = {
  block?: ChatBlock;
  end: number;
  start: number;
};

/**
 * The bubble a human message answers: a lead message and the bubble's place in it, as `parts` counts (0 for a
 * message of one bubble). The lead reads that bubble whole over the reply, and when it was written.
 */
export type ChatReplyTo = {
  messageId: ChatMessageId;
  part: number;
};

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
   * The lead's bubble this answers. `text` still opens with its one-line quote, for clients that show text as it
   * is; the lead reads the whole bubble in its place.
   */
  replyTo?: ChatReplyTo;
  /**
   * Sent from inside a fleetd session: its thread id (FLEETD_THREAD_ID), as the caller reports it. The project's own
   * lead and tasks are refused (they use their fleetd tools), and so is a human key. It catches mistakes; the key,
   * not this field, carries authority.
   */
  session?: ThreadId;
  /** Skills the person named with `$name`: the lead's message lists them, so it uses them. */
  skills?: SkillName[];
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

export type ChecklistBlock = {
  items: ChecklistItem[];
  title?: string;
};

/** `checklist.changed`. The items are not in the event; checklist_get reads them. */
export type ChecklistChangedData = {
  /** The lead (`lead:<machine>/<project>`) or a person (`human:<key name>`). */
  by: string;
  done: number;
  /** The person who changed it (`checklist_edit`), removals included; absent when the lead did. */
  person?: PersonRef;
  projectRef: ProjectRef;
  total: number;
};

export type ChecklistEditInput = {
  items: TodoEdit[];
  projectRef: ProjectRef;
};

export type ChecklistEditOutput = {
  items: TodoItem[];
  next?: string;
  projectRef: ProjectRef;
  truncated?: boolean;
  updatedAt?: Timestamp;
};

export type ChecklistGetInput = {
  projectRef: ProjectRef;
};

export type ChecklistGetOutput = {
  /** In the lead's order. */
  items: TodoItem[];
  next?: string;
  projectRef: ProjectRef;
  truncated?: boolean;
  /** The last change; absent while the lead has never set one. */
  updatedAt?: Timestamp;
};

export type ChecklistItem = {
  done: boolean;
  text: string;
};

export type ChecklistRemoveInput = {
  /** The items to take off; one already gone is skipped. */
  ids: number[];
  projectRef: ProjectRef;
};

export type ChecklistRemoveOutput = {
  /** The list after it, in the lead's order. */
  items: TodoItem[];
  next?: string;
  projectRef: ProjectRef;
  truncated?: boolean;
  updatedAt?: Timestamp;
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

/** Intent fleetd can't otherwise see: a free-text title plus optional exact keys and paths. */
export type Claim = {
  /** `git config user.email` of whoever does the work, for matching their direct pushes. */
  authorEmail?: string;
  base: string;
  /** The branch the work is on; its key too. */
  branch?: string;
  claimId: ClaimId;
  createdAt: Timestamp;
  /** Set once it is no longer active. */
  end?: ClaimEnd;
  expiresAt: Timestamp;
  keys: WorkKey[];
  observed?: ClaimObserved;
  owner: ClaimOwner;
  /** Declared. */
  paths: string[];
  /** When the repo is a project's. */
  projectRef?: ProjectRef;
  renewedAt: Timestamp;
  repoKey: RepoKey;
  state: ClaimState;
  /** "dark mode toggle in settings". */
  title: string;
};

export type ClaimEnd = {
  at: Timestamp;
  /** The commit on the base it landed as. */
  landing?: CommitSha;
  reason: string;
};

export type ClaimId = string;

/** What the claim's branch actually changed, refreshed from the remote branch or the CLI. */
export type ClaimObserved = {
  at: Timestamp;
  headSha?: CommitSha;
  paths: string[];
};

export type ClaimOwner = {
  /** The key it called with; a lead's is its project, as `<machineId>/<projectId>`. */
  keyId: string;
  kind: ClaimOwnerKind;
  /** Who it is to a person: "laptop", a git user.email. */
  label?: string;
};

export type ClaimOwnerKind = "human_session" | "agent_key" | "lead";

export type ClaimState = "active" | "landed" | "released" | "expired";

/**
 * The account a session runs on, as a launch names it. The node resolves it from the secrets it holds: `hub` is
 * the hub's API key (`ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL` with an endpoint), `person` that person's
 * subscription (`CLAUDE_CODE_OAUTH_TOKEN`).
 */
export type ClaudeAccount = {
  kind: "hub";
} | {
  kind: "person";
  personId: PersonId;
};

export type ClaudeAccountTestInput = {
  account: ClaudeTestTarget;
  /** Where to try it; default: the first machine online that holds it. */
  machineId?: MachineId;
};

export type ClaudeAccountTestOutput = {
  next?: string;
  test: ClaudeTest;
  truncated?: boolean;
};

export type ClaudeAccountsGetInput = { [key: string]: unknown };

export type ClaudeAccountsGetOutput = {
  /** The hub's API configuration, once an admin set one up. */
  hubApi?: ClaudeHubApi;
  /** What projects' leads and work nobody started (automations, train fixes) run on. */
  leadsRunOn: ClaudeRunsOn;
  /** The caller's own setup; absent for a key with no person. */
  me?: PersonClaude;
  next?: string;
  /** Everyone's, for an owner's or admin's device; empty otherwise. */
  people?: PersonClaude[];
  settings: ClaudeSettings;
  truncated?: boolean;
};

/** What a person picked in their own settings. Unset: their subscription once they connect one, else the hub's API. */
export type ClaudeChoice = "subscription" | "hub_api";

export type ClaudeChoiceSetInput = {
  /** Absent: their subscription once connected, else the hub's API. */
  choice?: ClaudeChoice;
};

export type ClaudeChoiceSetOutput = {
  me: PersonClaude;
  next?: string;
  truncated?: boolean;
};

/** an http:// or https:// URL of at most 500 characters, no spaces */
export type ClaudeEndpoint = string;

/** The hub's API configuration as the hub keeps it: never the key, only where it is. */
export type ClaudeHubApi = {
  endpoint?: ClaudeEndpoint;
  lastTest?: ClaudeTest;
  /** Each machine whose node holds the key. A machine missing here runs nothing on it. */
  sealedOn: ClaudeSealedOn[];
  updatedAt: Timestamp;
  updatedBy?: PersonRef;
};

export type ClaudeHubApiRemoveInput = { [key: string]: unknown };

export type ClaudeHubApiRemoveOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

export type ClaudeHubApiSetInput = {
  /** A custom endpoint (ANTHROPIC_BASE_URL); absent: Anthropic's own. */
  endpoint?: ClaudeEndpoint;
  /** The API key sealed to each machine agents run on; empty keeps the saved key, for an endpoint change alone. */
  sealed?: ClaudeSeal[];
};

export type ClaudeHubApiSetOutput = {
  hubApi: ClaudeHubApi;
  /** Machines whose node doesn't hold the key (offline when it was saved): save it again while they are online. */
  missingOn?: MachineId[];
  next?: string;
  truncated?: boolean;
};

/** What some work runs on now: an account, the machines' own login, or a refusal. */
export type ClaudeRunsOn = {
  kind: "machine_login";
} | {
  account: ClaudeAccount;
  kind: "account";
} | {
  fix: string;
  kind: "refused";
  message: string;
};

/** One machine's box of an account's secret. */
export type ClaudeSeal = {
  machineId: MachineId;
  /** `crypto_box_seal` of the key or token to that machine's `boxPubKey`. */
  sealed: SealedSecret;
};

/** A machine whose node holds an account's secret, with the fingerprint it computed. */
export type ClaudeSealedOn = {
  fingerprint: SecretFingerprint;
  machineId: MachineId;
};

/** Hub-wide Claude settings (Settings › Hub accounts). */
export type ClaudeSettings = {
  /**
   * Members may run their work on the hub's API configuration (on by default). Off, each member connects their
   * own subscription; it never affects owners and admins, projects' leads or work nobody started.
   */
  membersUseHubApi: boolean;
};

export type ClaudeSettingsSetInput = {
  /** Members may run their work on the hub's API configuration. */
  membersUseHubApi: boolean;
};

export type ClaudeSettingsSetOutput = {
  next?: string;
  settings: ClaudeSettings;
  truncated?: boolean;
};

/** A person's connected subscription: never the token, only where it is. */
export type ClaudeSubscription = {
  connectedAt: Timestamp;
  lastTest?: ClaudeTest;
  sealedOn: ClaudeSealedOn[];
};

export type ClaudeSubscriptionRemoveInput = { [key: string]: unknown };

export type ClaudeSubscriptionRemoveOutput = {
  me: PersonClaude;
  next?: string;
  truncated?: boolean;
};

export type ClaudeSubscriptionSetInput = {
  /** The caller's long-lived token (`claude setup-token`) sealed to each machine agents run on. */
  sealed: ClaudeSeal[];
};

export type ClaudeSubscriptionSetOutput = {
  me: PersonClaude;
  missingOn?: MachineId[];
  next?: string;
  truncated?: boolean;
};

/** The last Test of an account: one tiny `claude -p` call made with it on one machine. */
export type ClaudeTest = {
  at: Timestamp;
  /** What went wrong, in claude's words with the secret masked; absent when it worked. */
  error?: string;
  machineId: MachineId;
  ok: boolean;
};

/** Which account `claude_account_test` tries: the hub's API key (admins), or the caller's own subscription. */
export type ClaudeTestTarget = "hub_api" | "mine";

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
 * A risky command (prod write, spend, delete, credential use), a session's permission prompt or an agent's proposed
 * preview setting waits for the human: exactly what it would do, then Approve or Deny. Answered with
 * `approval_answer`, naming `requestId`. Exactly one of `gated`, `permission` and `previewConfig`.
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
  /**
   * A session's permission prompt: the tool and what it would do. Boxed, as `previewConfig` is: with its input it
   * is large beside the item's other fields.
   */
  permission?: ToolPermission;
  /**
   * An agent's proposed preview setting (preview_config_propose): approved, it becomes the project's `preview`.
   * Older apps show it as an approval with neither command nor permission.
   * Boxed: the setting is large beside the item's other fields, and every chat item would carry its size.
   */
  previewConfig?: PreviewConfigProposeCall;
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
  /** The person who recorded it, for a human key's decision. Absent from a hub before people. */
  person?: PersonRef;
  /** Who took it back, when a person revoked it (`decisions_overturn` without a value). */
  retired?: DecisionRetired;
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

export type DecisionOrder = {
  title: string;
  workstreamId: WorkstreamId;
};

/** A revoke: by "human:<device>", at, and the person's why. */
export type DecisionRetired = {
  at: Timestamp;
  by: string;
  /** The person who took it back. Absent from a hub before people. */
  person?: PersonRef;
  why?: string;
};

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

export type DecisionsListInput = {
  limit?: number;
  projectRef: ProjectRef;
};

export type DecisionsListOutput = {
  /** Every state: active, superseded and retired. */
  decisions: Decision[];
  next?: string;
  /** The order each workstream-scoped decision belongs to, by its title. */
  orders: DecisionOrder[];
  truncated?: boolean;
};

export type DecisionsOverturnInput = {
  decisionId: DecisionId;
  /** Absent: revoke, and the key goes unanswered again. Present: a new decision on the same key and scope. */
  value?: string;
  why: string;
};

export type DecisionsOverturnOutput = {
  /** The replacement, when a value was given. */
  decision?: Decision;
  next?: string;
  /** The decision overturned: retired, or superseded by `decision`. */
  overturned: Decision;
  truncated?: boolean;
};

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

/**
 * Where a desktop session's apps run: in a fresh container of the node's pinned image (docker or podman), or as the
 * node's user on an Xvfb display of their own with a fresh home directory.
 */
export type KnownDesktopBackend = "container" | "xvfb";
/** KnownDesktopBackend, or a value from a newer hub. */
export type DesktopBackend = KnownDesktopBackend | (string & {});

export type DesktopHealth = {
  /** What sessions run in: a container where the node has docker or podman, else Xvfb. */
  backend?: DesktopBackend;
  /** The command a person runs to fix it, when there is one. */
  fix?: string;
  /** Plain words: what sessions use, or what is missing. */
  message: string;
  state: DesktopState;
};

/** Where a node's Linux desktop sessions stand, for the doctor. */
export type KnownDesktopState = "ready" | "preparing" | "unavailable";
/** KnownDesktopState, or a value from a newer hub. */
export type DesktopState = KnownDesktopState | (string & {});

export type DeviceRevokeInput = {
  keyId: string;
};

export type DeviceRevokeOutput = {
  device: AgentKeyInfo;
  next?: string;
  truncated?: boolean;
};

/** Changes to show: the files with their hunks, or a PR whose diff the client reads. Exactly one of the two. */
export type DiffBlock = {
  files?: DiffFile[];
  pr?: PrBlock;
  title?: string;
};

export type DiffFile = {
  /** Unified-diff hunks, each from its `@@` line. */
  hunks: string[];
  path: string;
};

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

/**
 * How hard a model thinks: what a profile runs at, as Claude Code's `--effort` takes it, or a node reports a
 * session's.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Who keeps a safety rule when the prompt no longer says it. */
export type Enforcement = "code" | "prompt";

export type EnvName = string;

export type EnvValue = string;

export type EnvVarKind = "plain" | "secret";

export type EnvVarName = string;

/** One variable to add or replace. */
export type EnvVarSet = {
  kind: "plain";
  name: EnvVarName;
  value: EnvValue;
} | {
  kind: "secret";
  name: EnvVarName;
  sealed: SealedSecret;
};

export type ErrorCode = "machine_offline" | "not_found" | "forbidden" | "invalid" | "failed";

export type EventSeq = number;

export type EventsListInput = {
  before?: EventSeq;
  /** Also the hub's own events, which name no machine or project (a device paired). */
  hubWide?: boolean;
  limit?: number;
  projectRef: ProjectRef;
  /** Only these types; absent: every type. */
  types?: HubEventType[];
};

export type EventsListOutput = {
  /** Newest first. */
  events: HubEvent[];
  /** More events before the last one of this page. */
  more: boolean;
  next?: string;
  truncated?: boolean;
};

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

/** `project.fetch_failed` data: the start that found the remote unfetchable. */
export type FetchFailedData = {
  base: WorktreeBase;
  /** A command for a person to run, e.g. "gh auth login". */
  fix?: string;
  /** The whole line, which the summary may cut: what failed, the fix, and where agents start from meanwhile. */
  message: string;
  projectRef: ProjectRef;
  taskId: TaskId;
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

/** Where a repo's merges are read from. */
export type KnownGitHost = "github" | "gitlab" | "gitea" | "bitbucket" | "azure_devops" | "git";
/** KnownGitHost, or a value from a newer hub. */
export type GitHost = KnownGitHost | (string & {});

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

/** A person's own GitHub account, as the hub keeps it: no token. */
export type GithubAccount = {
  connectedAt: Timestamp;
  /** GitHub no longer takes its refresh token (revoked, or six months unused): Connect again. */
  lapsed?: boolean;
  login: string;
  userId: number;
};

/** The hub's App, as the hub keeps it: no key and no secret. */
export type GithubApp = {
  appId: number;
  /** What people sign in through it with (not a secret). */
  clientId: string;
  createdAt: Timestamp;
  /** Its public page on GitHub. */
  htmlUrl: string;
  /** Where it is installed, as the last Test (or token) read them. */
  installations?: GithubInstallation[];
  lastTest?: GithubAppTest;
  name: string;
  /** The account or organization that owns it. */
  owner: string;
  /** Its settings on GitHub, under its owner's: where it is changed or deleted. */
  settingsUrl: string;
  /** From GitHub's answer, never from the name proposed: the admin may rename it on GitHub's form. */
  slug: string;
};

export type GithubAppCreateInput = {
  /** From GitHub's redirect. */
  code: GithubManifestCode;
};

export type GithubAppCreateOutput = {
  app: GithubApp;
  next?: string;
  truncated?: boolean;
};

export type GithubAppGetInput = { [key: string]: unknown };

export type GithubAppGetOutput = {
  /** None until an admin creates one. */
  app?: GithubApp;
  /** GitHub's sign-in page, which `github_connect`'s code comes from (with the App's clientId). */
  authorizeUrl: string;
  /**
   * The caller's own GitHub account, connected through the App; absent until they connect, or for a key with no
   * person.
   */
  me?: GithubAccount;
  next?: string;
  /** Everyone's connection, for an owner's or admin's device; empty otherwise. */
  people?: PersonGithub[];
  /** What it asks for on each repository, as the manifest has it: `[name, read|write]`. */
  permissions: [string, string][];
  truncated?: boolean;
};

export type GithubAppManifestInput = {
  /** What the admin's GitHub shows it as: `fleetd on <host>`. GitHub may ask for another when it is taken. */
  name: GithubAppName;
  /** Make it in this organization; absent: in the admin's own account. */
  organization?: GithubLogin;
  /** Where GitHub sends the admin back with the code: the loopback page that posted the manifest. */
  redirect: LoopbackUri;
};

export type GithubAppManifestOutput = {
  /** The manifest, JSON. */
  manifest: string;
  next?: string;
  /** GitHub's page to post the manifest to, as a form field `manifest`, with a `state` of the caller's own. */
  postTo: string;
  truncated?: boolean;
};

export type GithubAppName = string;

export type GithubAppRemoveInput = { [key: string]: unknown };

export type GithubAppRemoveOutput = {
  next?: string;
  /** Its settings on GitHub, where it is deleted too. */
  settingsUrl: string;
  truncated?: boolean;
};

/** What the last Test said. */
export type GithubAppTest = {
  at: Timestamp;
  ok: boolean;
  /** In a line a person can act on. */
  said: string;
};

export type GithubAppTestInput = { [key: string]: unknown };

export type GithubAppTestOutput = {
  app: GithubApp;
  next?: string;
  truncated?: boolean;
};

export type GithubCode = string;

export type GithubConnectInput = {
  /** From GitHub's redirect. */
  code: GithubCode;
  /** The PKCE verifier whose challenge the sign-in was opened with. */
  codeVerifier: PkceVerifier;
  /** The loopback address the code was sent to. */
  redirectUri: GithubLoopback;
};

export type GithubConnectOutput = {
  me: GithubAccount;
  next?: string;
  truncated?: boolean;
};

export type GithubDisconnectInput = { [key: string]: unknown };

export type GithubDisconnectOutput = {
  next?: string;
  /** GitHub confirmed the token is revoked. */
  revoked: boolean;
  truncated?: boolean;
};

/** One installation of the App: an account or organization, and the repositories it reaches there. */
export type GithubInstallation = {
  account: string;
  /** Every repository of the account, now and later. */
  allRepositories: boolean;
  installationId: number;
  /** With chosen repositories: their `owner/name`, the first 100. */
  repositories?: string[];
  /** How many it reaches. */
  repositoryCount: number;
};

export type GithubLogin = string;

export type GithubLoopback = string;

export type GithubManifestCode = string;

export type Grant = {
  machines: GrantMachines;
  role: Role;
};

export type GrantMachines = Star | MachineId[];

/**
 * Whether a machine can host one kind of session, and why, in plain words: "Chrome 131 at /usr/bin/google-chrome",
 * "Android SDK at ~/Android/Sdk, but no /dev/kvm".
 */
export type HostCheck = {
  detail: string;
  host: SessionHost;
  ready: boolean;
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

/**
 * The release channel a hub's build follows: edge when its version contains "-edge." (or "-nightly.", edge's name
 * until D203), stable otherwise.
 */
export type KnownHubChannel = "stable" | "edge";
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
  | "machine.recovery_paused"
  | "thread.orphaned"
  | "project.removed"
  | "project.added"
  | "project.clone_progress"
  | "project.add_failed"
  | "project.fetch_failed"
  | "project.settings"
  | "thread.waiting"
  | "wake.missed"
  | "write.delivered"
  | "write.expired"
  | "workstream.running"
  | "request.opened"
  | "request.updated"
  | "decision.retired"
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
  | "chat.waiting"
  | "app.presence"
  | "repo.advanced"
  | "work.claimed"
  | "work.ended"
  | "work.landed"
  | "memory.changed"
  | "memory.refresh"
  | "automation.changed"
  | "automation.run"
  | "checklist.changed"
  | "skills.changed"
  | "browser.session"
  | "preview.state"
  | "people.changed"
  | "machine_add.step";
/** KnownHubEventType, or a value from a newer hub. */
export type HubEventType = KnownHubEventType | (string & {});

export type HubInfoInput = {
  /** Only what runs on this machine (before restarting its node); absent: everything. */
  machineId?: MachineId;
};

export type HubInfoOutput = {
  /**
   * The caller's key holds Admin on every machine, so it may change the fleet and machine caps. Absent from a hub
   * before this, which leaves an app to try.
   */
  admin?: boolean;
  /** Empty when nothing is in flight. A restart interrupts each item. */
  busy: HubBusyItem[];
  /** Absent for a local build. */
  channel?: HubChannel;
  /**
   * A hash of the OS's id for the hub's computer, as nodes give theirs: the app on that computer knows it runs the
   * hub. Absent where the OS gives none, and from older hubs.
   */
  machineFingerprint?: string;
  /** The person the caller's human key belongs to. Absent for an agent key, and from a hub before people. */
  me?: Person;
  next?: string;
  /** How many people the hub has, removed ones left out. Absent from a hub before people. */
  people?: number;
  protocol: number;
  startedAt?: Timestamp;
  truncated?: boolean;
  /**
   * The address another hub reaches this one at, for a hub link: its URL when that is https, or http over a
   * tailnet, and not this machine's loopback. Absent when it has no such address, and from older hubs.
   */
  url?: string;
  /** The hub's fleetd version, as `fleetd --version` prints it. "0.0.0" for a local build. */
  version: string;
};

/** A link this hub keeps for one of its Navis. The key stays sealed in the hub; nothing returns it. */
export type HubLink = {
  checkedAt?: Timestamp;
  createdAt: Timestamp;
  /** Why it is unreachable or revoked, in the words the person reads. */
  error?: string;
  label: string;
  linkId: HubLinkId;
  navi: ProjectRef;
  /** The projects it is limited to there, as the other hub last said; absent: every project its person reaches. */
  projects?: LinkProject[];
  state: HubLinkState;
  /** The other hub's URL: https, or http over a tailnet or this machine. */
  url: string;
  /** The person it acts as there, as the other hub last said; absent until a hub that says has answered. */
  who?: string;
};

export type HubLinkAddInput = {
  label: string;
  navi: ProjectRef;
  /** The link key sealed to this hub's boxPubKey. */
  sealed: SealedSecret;
  /** The other hub's URL, as the app pairs with it: https, or http over a tailnet. */
  url: string;
};

export type HubLinkAddOutput = {
  link: HubLink;
  next?: string;
  /** What the Navi reaches there. */
  projects: LinkProject[];
  truncated?: boolean;
};

export type HubLinkId = string;

export type HubLinkMintInput = {
  /** What the person calls the hub the link is for. */
  label: string;
  /** The projects it reaches, each one the caller may operate; absent: every project the caller reaches. */
  projects?: ProjectRef[];
};

export type HubLinkMintOutput = {
  /** "flk_…": shown once, never stored; paste it into the other hub's Navi, which seals it. */
  key: string;
  link: IssuedLink;
  next?: string;
  truncated?: boolean;
};

export type HubLinkRemoveInput = {
  linkId: HubLinkId;
};

export type HubLinkRemoveOutput = {
  next?: string;
  /** Whether the other hub revoked the key too; false when it couldn't be reached (the key is gone here anyway). */
  revokedThere: boolean;
  truncated?: boolean;
};

export type HubLinkRevokeInput = {
  linkId: HubLinkId;
};

export type HubLinkRevokeOutput = {
  link: IssuedLink;
  next?: string;
  truncated?: boolean;
};

export type KnownHubLinkState = "ok" | "unreachable" | "revoked";
/** KnownHubLinkState, or a value from a newer hub. */
export type HubLinkState = KnownHubLinkState | (string & {});

export type HubLinksGetInput = {
  /** A Navi: the links this hub keeps for it. Absent: none. */
  navi?: ProjectRef;
};

export type HubLinksGetOutput = {
  /** This hub's X25519 key, standard base64: what a link key is sealed to (`crypto_box_seal`) for hub_link_add. */
  boxPubKey: string;
  /** Links minted on this hub: the caller's own, or every one for an admin. */
  issued: IssuedLink[];
  /** The navi's links to other hubs. */
  links: HubLink[];
  next?: string;
  truncated?: boolean;
};

/**
 * What a person may do on the hub. Owners and admins invite people, change roles and change hub-wide settings;
 * members work in projects. Each device is still capped by its own grants.
 */
export type KnownHubRole = "owner" | "admin" | "member";
/** KnownHubRole, or a value from a newer hub. */
export type HubRole = KnownHubRole | (string & {});

export type HubSetupStep = {
  /** The deciding check fails, rather than warns: with `look`, something can't work until it's fixed. */
  failing?: boolean;
  /** What comes back from the provider, entered where the step says (`place`). */
  fields?: SetupField[];
  /** What happens after the fields are saved. */
  fieldsNote?: string;
  /** The deciding check's fix, when a command fixes it. */
  fix?: DoctorFix;
  group: SetupGroup;
  id: SetupStepId;
  need: SetupNeed;
  parts: SetupPart[];
  /**
   * Where in the app the fields are saved, a Hub page of the app's Settings ("github"), where the terminal can't seal
   * them.
   */
  place?: string;
  /** What its checks say now: the deciding one's message. */
  said?: string;
  status: SetupStatus;
  /** What Test does, in a few words. */
  test?: string;
  title: string;
  /** The way in use, where a step has several: the one done, else the one that wants a look. */
  way?: string;
  /** The ways to complete it; one is enough. */
  ways: SetupWay[];
  /** Why it matters, in one line. */
  why: string;
};

export type HubUpdateInput = {
  /** Absent: the channel the hub's build came from. */
  channel?: HubChannel;
  /** Retry this machine of the last run, whose hub updated: its node, then its Claude Code. */
  machine?: MachineId;
  /**
   * Start over: ends the run going on, once the hub has its result (never while the hub restarts), with every part
   * left skipped, and starts a new one.
   */
  startOver?: boolean;
};

export type HubUpdateOutput = {
  /**
   * True when the run isn't finished but nothing in the hub drives it any more: it won't change again, and Update
   * starts a new one. Absent otherwise.
   */
  leftOver?: boolean;
  next?: string;
  /**
   * The channel's newest build, already downloaded and checked on the hub (and fetched by its nodes), so an update
   * only swaps and restarts: what "fleetd <version> is ready" names. Absent when there is none newer.
   */
  ready?: string;
  /** The update going now or the last one; absent when the hub never updated itself. */
  run?: UpdateRun;
  truncated?: boolean;
};

export type HubUpdateStatusInput = { [key: string]: unknown };

/** One human request, as stored and as every client shows it. */
export type HumanRequest = {
  answeredAt?: Timestamp;
  /** "human:<device>". */
  answeredBy?: string;
  /** The person who answered it: approved or denied it, or entered the secret. Absent from a hub before people. */
  answeredByPerson?: PersonRef;
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
  /**
   * approval of an agent's proposed preview setting (preview_config_propose), instead of a gated run: approving it
   * saves it as the project's `preview`.
   */
  previewConfig?: PreviewConfigProposeCall;
  projectRef: ProjectRef;
  requestId: ChatRequestId;
  /** secret only. */
  secret?: SecretRequest;
  state: RequestState;
  /** One line on why the lead needs it. */
  text: string;
  workstreamId?: WorkstreamId;
};

/** The minutes chart's series, at most five, in this fixed order bottom up. */
export type HumanSource = "app" | "chat" | "reviews" | "sessions" | "other";

/** The person's minutes per merged PR: a ratio of period totals, from what fleetd sees. */
export type HumanTile = {
  /** The low bound: the union of the credits alone, with no bridging. */
  lowMs: number;
  /**
   * Visible minutes on outside work over `outside` + `direct` landed changes. Always a bare minimum: fleetd
   * sees almost none of that work.
   */
  outsidePerPrMs?: number;
  outsidePrs: number;
  outsideTotalMs: number;
  /** Minutes on fleetd work over its landed changes (`train` + `fleetd_by_hand`); absent when there are none. */
  perPrMs?: number;
  previousPerPrMs?: number;
  prs: number;
  spark: SparkPoint[];
  /** The estimate: touches' credits, bridged into sessions where under 5 minutes apart, as a union. */
  totalMs: number;
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

export type KnownIntakeChannel = "app" | "mcp" | "lead" | "automation" | "train";
/** KnownIntakeChannel, or a value from a newer hub. */
export type IntakeChannel = KnownIntakeChannel | (string & {});

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

/** A single-use pairing code bound to a person, valid for 7 days. The code itself is shown once, at creation. */
export type Invite = {
  createdAt: Timestamp;
  /** Who created it; absent for `fleetd invite` on the hub machine. */
  createdBy?: PersonRef;
  expiresAt: Timestamp;
  inviteId: InviteId;
  /** Whom the device that redeems it belongs to. */
  person: PersonRef;
  revokedAt?: Timestamp;
  state: InviteState;
  usedAt?: Timestamp;
};

export type InviteCreateInput = {
  name?: string;
  personId?: PersonId;
  role?: HubRole;
};

export type InviteCreateOutput = {
  /** `XXXX-XXXX`: entered in the app's pairing screen with the hub address. */
  code: string;
  hubUrl: string;
  invite: Invite;
  /** `fleetd://pair?hub=…&code=…`. */
  link: string;
  next?: string;
  truncated?: boolean;
};

export type InviteId = string;

export type InviteRevokeInput = {
  inviteId: InviteId;
};

export type InviteRevokeOutput = {
  invite: Invite;
  next?: string;
  truncated?: boolean;
};

export type KnownInviteState = "expired" | "revoked" | "open" | "used";
/** KnownInviteState, or a value from a newer hub. */
export type InviteState = KnownInviteState | (string & {});

export type IosHealth = {
  /** The command a person runs to fix it, when there is one. */
  fix?: string;
  /** Plain words: the runtime and device sessions use, or what is wrong. */
  message: string;
  state: IosState;
};

/** Where a node's iOS sessions stand, for the doctor. */
export type KnownIosState = "ready" | "wanted" | "preparing" | "unavailable";
/** KnownIosState, or a value from a newer hub. */
export type IosState = KnownIosState | (string & {});

/** A link minted on this hub, as its person and the hub's admins see it. The key itself is shown once, at minting. */
export type IssuedLink = {
  createdAt: Timestamp;
  device: string;
  /**
   * The device that minted it. The link acts as its person, at the lesser of their role and this device's grants
   * when it was minted, never above operate, and stops when they leave the hub; a link from before people acts at
   * this device's grants and dies with it.
   */
  keyId: string;
  /** What the person called the hub it is for; requests through it read "asked via <label> Navi". */
  label: string;
  lastUsedAt?: Timestamp;
  linkId: HubLinkId;
  /** Its person, on a hub with people. */
  person?: PersonRef;
  /** "flk_" plus the first 6 characters of the key's body. */
  prefix: string;
  /** The projects it reaches; absent: every project its person reaches. */
  projects?: ProjectRef[];
  revokedAt?: Timestamp;
};

export type KeptWorktree = {
  /** The machine it is on. */
  machineId: MachineId;
  /** Where it is on that machine. */
  path: string;
  /** Its task's title. */
  title: string;
  /** What only it holds: "uncommitted changes", "2 unpushed commits". */
  unsaved: string;
};

export type KeyAction = "down" | "up";

/** "human": a person's device, such as the desktop app. What it answers is recorded as the human's. */
export type KeyKind = "agent" | "human";

export type KindTotal = {
  kind: SpanKind;
  ms: number;
  n: number;
};

/** How a commit reached a base branch. */
export type LandingRoute = "train" | "pr_outside" | "direct_push";

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

/** One project a link reaches. */
export type LinkProject = {
  projectRef: ProjectRef;
  title: string;
};

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

export type LocalDate = string;

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

export type LoopbackUri = string;

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

export type MachineAddInput = {
  host?: SshHost;
  local?: boolean;
  machineId?: MachineId;
};

export type MachineAddOutput = {
  next?: string;
  run: MachineAddRun;
  truncated?: boolean;
};

export type MachineAddPlanInput = {
  /** The machine to add, over SSH from the hub. */
  host?: SshHost;
  /** The hub's own machine, without SSH. */
  local?: boolean;
  /** Defaults to the host's first label (the hub's host name for local). */
  machineId?: MachineId;
};

export type MachineAddPlanOutput = {
  host?: SshHost;
  /** Already a machine of this hub: adding it again repairs it. */
  joined: boolean;
  machineId: MachineId;
  next?: string;
  notes: string[];
  /** The machine's OS and CPU as its read found them: "linux-x64", "darwin-arm64". */
  platform: string;
  /** What machine_add would run there now, each planned; a machine already set up runs fewer. */
  steps: SetupStep[];
  truncated?: boolean;
};

/** A machine_add, as far as it got. */
export type MachineAddRun = {
  finishedAt?: Timestamp;
  /** Failed: what to do, then Retry. */
  fix?: string;
  /** The SSH host; absent for the hub's own machine. */
  host?: string;
  /** Done: claude on the machine is logged in. */
  loggedIn?: boolean;
  machineId: MachineId;
  /** Failed: what went wrong. */
  message?: string;
  /** What to know or do by hand: linger, an untested claude, claude not logged in. */
  notes: string[];
  runId: MachineAddRunId;
  startedAt: Timestamp;
  state: MachineAddState;
  /** Every step: first reading the machine, then the plan's (planned until they start), then the wait for the node. */
  steps: SetupStep[];
};

export type MachineAddRunId = string;

export type MachineAddState = "running" | "done" | "failed";

export type MachineAddStatusInput = {
  /** One run; absent: the recent runs, newest first. */
  runId?: MachineAddRunId;
};

export type MachineAddStatusOutput = {
  next?: string;
  runs: MachineAddRun[];
  truncated?: boolean;
};

/** `machine_add.step`'s data: a run started, moved a step or ended. machine_add_status reads the rest. */
export type MachineAddStepData = {
  machineId: MachineId;
  runId: MachineAddRunId;
  state: MachineAddState;
};

export type MachineClaudeLoginInput = {
  /** Absent: start the login, which answers its sign-in URL. The code the sign-in page showed: finish it. */
  code?: string;
  machineId: MachineId;
};

export type MachineClaudeLoginOutput = {
  /** A login that finished: claude on the machine is logged in now. */
  loggedIn?: boolean;
  /** A login that started: where to sign in. */
  loginUrl?: string;
  machineId: MachineId;
  /** The node's words: what happened, or why not. */
  message: string;
  next?: string;
  truncated?: boolean;
};

/** `machine.guard`. */
export type MachineGuardData = {
  /** true: new agents wait; false: they start again. */
  paused: boolean;
};

/** A host the hub can reach to add as a machine. */
export type MachineHost = {
  /** The SSH host; absent for the hub's own machine. */
  host?: SshHost;
  /** Already a machine of this hub (it may be offline). */
  joined: boolean;
  /** The machine id it gets. */
  machineId: MachineId;
  /** Where the hub found it. */
  source: MachineHostSource;
};

export type KnownMachineHostSource = "hub" | "set_up" | "ssh_config" | "tailnet";
/** KnownMachineHostSource, or a value from a newer hub. */
export type MachineHostSource = KnownMachineHostSource | (string & {});

export type MachineHostsInput = { [key: string]: unknown };

export type MachineHostsOutput = {
  hosts: MachineHost[];
  next?: string;
  truncated?: boolean;
};

/** Machine slug, [a-z0-9-]{1,32} */
export type MachineId = string;

export type MachineJoinInput = {
  machineId: MachineId;
  /** A machine that joined before: the line enrolls it again (`--rejoin`), which repairs it. */
  rejoin?: boolean;
};

export type MachineJoinOutput = {
  /** Single use; it enrolls only this machine id. */
  code: string;
  expiresAt: Timestamp;
  /** `Name <email>`, the hub's commit identity for its nodes. */
  gitIdentity?: string;
  /** Where the machine reaches the hub. */
  hubUrl: string;
  /** The one line to run on the machine: it installs fleetd and joins. */
  line: string;
  machineId: MachineId;
  next?: string;
  truncated?: boolean;
};

/** A machine's load and running agents, from its heartbeat (every 15 s) and the hub's executors. */
export type MachineLive = {
  asOf: Timestamp;
  /**
   * When the hub's link to its node last came up: each new link (a restart, a rejoin) moves it, though a quick
   * restart never shows the machine offline. Absent while it has none, and from older hubs.
   */
  linkedSince?: Timestamp;
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

export type MachineRemoveInput = {
  machineId: MachineId;
  /** Also delete the node's files and fleetd's claude.env on the machine. */
  purge?: boolean;
};

export type MachineRemoveOutput = {
  machineId: MachineId;
  next?: string;
  /** The hub held its node key and revoked it. */
  revoked: boolean;
  /** What ran on the machine; none for one the hub didn't set up (joined by itself). */
  steps: SetupStep[];
  truncated?: boolean;
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
  /**
   * Where a new, empty project's folder goes by default (`project_add` with `create`), as `<this>/<name>`. Absolute;
   * absent when the machine's node can't make one.
   */
  projectsRoot?: string;
  repos: FoundRepo[];
};

/** What a machine is for. */
export type MachineRole = "agents" | "sessions";

/** A machine as Settings › Hub › Machines shows it: its roles, its session slots and what it can host. */
export type MachineRolesEntry = {
  /** What it can host, as its node last reported; empty until it reports. */
  hosts?: HostCheck[];
  /** Its node hosts sessions for agents on other machines (newer nodes). */
  hostsOthers: boolean;
  /** Why it doesn't, in plain words, while it hosts sessions and doesn't. */
  hostsOthersNote?: string;
  machineId: MachineId;
  /** The sessions it hosts at once: a person's setting, else what it fits. */
  maxSessions: number;
  /** A person's setting; absent: auto. */
  maxSessionsSet?: number;
  /** Where `maxSessions` comes from: "set", "auto: 8 CPUs, 16 GB". */
  maxSessionsWhy: string;
  name: string;
  /**
   * The OS sandbox a Navi runs in there, as its node last reported it (`RunnerInfo.sandbox`). Absent until it
   * reports, from a node before it, and on a system fleetd has no sandbox for.
   */
  naviSandbox?: NaviSandbox;
  /** Its node is linked to the hub now. */
  online: boolean;
  /** The caller may work there (operate): make a Navi, start agents. Absent from a hub before it. */
  operates?: boolean;
  roles: MachineRole[];
  /** Its sessions live now, its own agents' and other machines'. */
  sessionsLive: number;
};

export type MachineRolesInput = { [key: string]: unknown };

export type MachineRolesOutput = {
  /** Where a new Navi or project goes when none is named (`project_discover.best`). Absent: no machine is. */
  best?: MachineId;
  machines: MachineRolesEntry[];
  next?: string;
  truncated?: boolean;
};

export type MachineRolesSetInput = {
  /** Drop the session cap: it hosts what it fits again. */
  autoSessions?: boolean;
  machineId: MachineId;
  /** The most sessions it hosts at once, in place of what it fits. */
  maxSessions?: number;
  roles?: MachineRole[];
};

export type MachineRolesSetOutput = {
  machine: MachineRolesEntry;
  next?: string;
  truncated?: boolean;
};

/** `machine.slept`: epoch milliseconds. */
export type MachineSleptData = {
  fromMs: number;
  toMs: number;
};

export type MachineStatus = "online" | "offline" | "degraded";

/** How sure the matcher is that new work repeats a piece in flight. */
export type MatchStrength = "weak" | "strong" | "exact";

export type McpArg = string;

/**
 * What the person marked a server's tools as, on its row (`McpServer.integration`). A server without one has no tool
 * marked as reading.
 */
export type McpIntegration = {
  /**
   * The server's tools that only read, as the person marked them when connecting it. A tool the policy blocks stays
   * blocked even when listed here.
   */
  readTools?: McpToolName[];
};

/** Which of fleetd's agents get a server. A plain thread a person starts gets none. */
export type McpRoles = {
  /** The project's lead. */
  lead: boolean;
  /** Review and read tasks' agents: the ones that only read. */
  reviewers: boolean;
  /** Write tasks' agents. */
  writers: boolean;
};

/** Where a server is configured. */
export type McpScope = {
  kind: "global";
} | {
  kind: "project";
  machineId: MachineId;
  projectId: ProjectId;
};

/** One machine's box of a secret value. */
export type McpSeal = {
  machineId: MachineId;
  /** `crypto_box_seal` of the value to that machine's `boxPubKey`: up to 64 KiB, no NUL. */
  sealed: SealedSecret;
};

/** The machine a secret value was sealed to, with the fingerprint its node computed. */
export type McpSealedOn = {
  fingerprint: SecretFingerprint;
  machineId: MachineId;
};

/** One configured server as the hub keeps it. A secret has no value here. */
export type McpServer = {
  enabled: boolean;
  /** A stdio server's env. */
  env?: McpValue[];
  /** An HTTP or SSE server's headers. */
  headers?: McpValue[];
  /** The tools the person marked as only reading, for the hub's tool policy; none marks none. */
  integration?: McpIntegration;
  name: McpServerName;
  roles: McpRoles;
  scope: McpScope;
  transport: McpTransport;
  updatedAt: Timestamp;
};

export type McpServerName = string;

export type McpServerRemoveInput = {
  name: McpServerName;
  scope: McpScope;
};

export type McpServerRemoveOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

export type McpServerSetInput = {
  enabled: boolean;
  /** A stdio server's env, the whole list: a value saved before and not here is removed. */
  env?: McpValueSet[];
  /** An HTTP or SSE server's headers, the whole list. */
  headers?: McpValueSet[];
  /** The tools the person marked as only reading, for the hub's tool policy. */
  integration?: McpIntegration;
  name: McpServerName;
  roles: McpRoles;
  scope: McpScope;
  transport: McpTransport;
};

export type McpServerSetOutput = {
  /**
   * Machines whose node doesn't hold all of its secrets (offline when it was saved): their agents go without it
   * until it is saved again while they are online.
   */
  missingOn?: MachineId[];
  next?: string;
  server: McpServer;
  truncated?: boolean;
};

export type McpServerTestInput = {
  /** Where to test a global server; default: the first machine online. A project server is tested on its machine. */
  machineId?: MachineId;
  name: McpServerName;
  scope: McpScope;
};

export type McpServerTestOutput = {
  machineId: MachineId;
  next?: string;
  result: McpTestResult;
  truncated?: boolean;
};

export type McpServersGetInput = {
  /** Also this project's own servers. */
  project?: ProjectRef;
};

export type McpServersGetOutput = {
  /** Every project's, by name. */
  global: McpServer[];
  next?: string;
  /** The asked project's own, by name; each replaces a global one of the same name there. */
  project?: McpServer[];
  truncated?: boolean;
  /** Agents also get the person's own MCP servers from their claude setup (on by default). */
  userServers: boolean;
};

export type McpSettingsSetInput = {
  /** Agents also get the person's own MCP servers from their claude setup. */
  userServers: boolean;
};

export type McpSettingsSetOutput = {
  next?: string;
  truncated?: boolean;
  userServers: boolean;
};

/** What a connection test found: the tools a server lists, or why it couldn't be reached. */
export type McpTestResult = {
  /** Why the test failed: what went wrong, the server's stderr tail for a command. */
  error?: string;
  /** The name and version the server gave, e.g. `github-mcp 1.2.0`. */
  server?: string;
  tools?: McpToolInfo[];
};

/** One tool a server lists. */
export type McpToolInfo = {
  description?: string;
  name: string;
  /** What the hub's tool policy does with it (`hub/integrations`), filled in by the hub. */
  policy?: ToolPolicy;
  /** The server says the tool only reads (MCP's `readOnlyHint`): the connect screen offers it as one to run unasked. */
  readOnly?: boolean;
};

export type McpToolName = string;

/** How claude reaches a server. */
export type McpTransport = {
  args?: McpArg[];
  command: McpArg;
  type: "stdio";
} | {
  type: "http";
  url: McpUrl;
} | {
  type: "sse";
  url: McpUrl;
};

export type McpUrl = string;

/** One env variable or header as the hub keeps it: a plain one's value, or the machines a secret's node holds it on. */
export type McpValue = {
  kind: EnvVarKind;
  name: McpValueName;
  /** A secret's: each machine whose node holds it. A project server's, its machine. */
  sealedOn?: McpSealedOn[];
  /** A plain value. */
  value?: EnvValue;
};

export type McpValueName = string;

/** One env variable or header of a server being saved. */
export type McpValueSet = {
  kind: "plain";
  name: McpValueName;
  value: EnvValue;
} | {
  kind: "secret";
  name: McpValueName;
  sealed: McpSeal[];
} | {
  kind: "keep";
  name: McpValueName;
};

/**
 * What memory writes are held to, in characters. A write past a cap is refused; a file already past a lowered cap
 * stays as it is until it is next written.
 */
export type MemoryCaps = {
  /** Each project's `MEMORY.md`. */
  index: number;
  /** A project's files together, `MEMORY.md` included. */
  project: number;
  /** Each topic file. */
  topic: number;
  /** Each person's own memory (the shared `user.md` too). */
  user: number;
};

/**
 * What memory writes are held to, in characters. A write past a cap is refused; a file already past a lowered cap
 * stays as it is until it is next written.
 */
export type MemoryCapsSetInput = {
  /** Each project's `MEMORY.md`. */
  index: number;
  /** A project's files together, `MEMORY.md` included. */
  project: number;
  /** Each topic file. */
  topic: number;
  /** Each person's own memory (the shared `user.md` too). */
  user: number;
};

/**
 * What memory writes are held to, in characters. A write past a cap is refused; a file already past a lowered cap
 * stays as it is until it is next written.
 */
export type MemoryCapsSetOutput = {
  /** Each project's `MEMORY.md`. */
  index: number;
  next?: string;
  /** A project's files together, `MEMORY.md` included. */
  project: number;
  /** Each topic file. */
  topic: number;
  truncated?: boolean;
  /** Each person's own memory (the shared `user.md` too). */
  user: number;
};

export type MemoryFile = {
  cap: number;
  chars: number;
  /** Newest first. */
  notes: MemoryNote[];
  scope: MemoryScope;
  text: string;
  /** A project's topic file; absent for `user.md` and `MEMORY.md`. */
  topic?: MemoryTopic;
  updatedAt?: Timestamp;
};

export type MemoryGetInput = {
  /** Also that project's MEMORY.md and topic files; absent: your own memory only. */
  projectRef?: ProjectRef;
};

export type MemoryGetOutput = {
  /** The hub's caps. Absent from older hubs. */
  caps?: MemoryCaps;
  /** With projectRef: MEMORY.md first, then the topic files by name. */
  files?: MemoryFile[];
  next?: string;
  projectCap?: number;
  /** With projectRef: the project's files together, and their cap. */
  projectChars?: number;
  truncated?: boolean;
  /**
   * Your own memory: how you work, read by the agents of work you start and by your Navi. Empty for a key with no
   * person. The one shared user.md on a hub from before people.
   */
  user: MemoryFile;
};

/** An entry `remember` wrote that is still in its file: when, and the chat line that said so. */
export type MemoryNote = {
  at: Timestamp;
  messageId: ChatMessageId;
  projectRef: ProjectRef;
  text: string;
};

/**
 * The nightly memory refresh (hub/memory/refresh), listed with a project's automations as a built-in row: a hub job,
 * not an automation. Its hour is the hub's (`policy.memory_refresh_at` in `policy.tz`, set by an admin), its switch
 * the project's `memory_refresh` setting; it has no prompt to edit, no webhook and no delete.
 */
export type MemoryRefreshJob = {
  /** Its hour, "HH:MM" in `tz`. */
  at: string;
  /** The run going now, else the last one. */
  lastRun?: MemoryRefreshRun;
  /** Absent while off. */
  nextRunAt?: Timestamp;
  /** The project's `memory_refresh` setting. */
  on: boolean;
  tz: TimeZone;
};

/** One refresh: when it started (or was skipped), how it went, and what it changed in memory. */
export type MemoryRefreshRun = {
  /** Entries added, put in place of another, and removed: the "+a ~b −c" of its chat line. */
  added: number;
  at: Timestamp;
  removed: number;
  replaced: number;
  /** running, done (it completed), failed (it didn't start, failed or ran past its hour) or skipped. */
  state: AutomationRunState;
  trigger: AutomationTrigger;
  /** Why it was skipped or failed. */
  why?: string;
};

export type MemoryRefreshRunInput = {
  projectRef: ProjectRef;
};

export type MemoryRefreshRunOutput = {
  memoryRefresh: MemoryRefreshJob;
  next?: string;
  truncated?: boolean;
  /** Why it didn't start; absent when it did. */
  why?: string;
};

/**
 * What a nightly memory refresh changed, as one line in the project's chat: each change with its own Undo, and Undo
 * all. Posted only when something changed.
 */
export type MemoryRefreshed = {
  /** In the order the refresh made them; the first [`REFRESHED_LISTED`] when it made more. */
  items: RememberedItem[];
  /** Every change it made, when that is more than `items` lists. Undo all takes them all back. */
  total?: number;
  /** How many of all its changes are undone, when any is: those past `items` too, which the line doesn't show. */
  undone?: number;
};

export type MemoryScope = "user" | "project";

export type MemorySetInput = {
  /**
   * User scope: another person's memory, only to delete it (empty text) once they are removed from the hub,
   * by an owner's or admin's device. Absent: your own; nobody else edits it.
   */
  personId?: PersonId;
  /** Required with scope project. */
  projectRef?: ProjectRef;
  scope: MemoryScope;
  /** The whole file. Empty deletes it (a topic's index line too). */
  text: string;
  /** Project scope: a topic file; absent, MEMORY.md. */
  topic?: MemoryTopic;
};

export type MemorySetOutput = {
  file: MemoryFile;
  next?: string;
  truncated?: boolean;
};

export type MemorySharedGetInput = { [key: string]: unknown };

export type MemorySharedGetOutput = {
  /** Empty once retired. */
  file: MemoryFile;
  next?: string;
  truncated?: boolean;
};

export type MemorySharedSetInput = {
  /** The whole file. Empty retires it. */
  text: string;
};

export type MemorySharedSetOutput = {
  file: MemoryFile;
  next?: string;
  truncated?: boolean;
};

/** Lowercase slug, [a-z0-9][a-z0-9-]{0,47}, other than memory */
export type MemoryTopic = string;

export type MemoryUndoInput = {
  /**
   * A "Memory refreshed" line's listed change, by its place in the line (0 first); absent, every change not yet
   * undone, listed or not.
   */
  item?: number;
  /** The chat line that said "Remembered: …", "Forgot: …" or "Memory refreshed: …". */
  messageId: ChatMessageId;
  projectRef: ProjectRef;
};

export type MemoryUndoOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

/** How a landed change reached the default branch. The fixed order, bottom up on every chart, is the order here. */
export type KnownMergeRoute = "train" | "fleetd_by_hand" | "outside" | "direct";
/** KnownMergeRoute, or a value from a newer hub. */
export type MergeRoute = KnownMergeRoute | (string & {});

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

/**
 * Pull requests merged per day: landed changes of all four routes over the range's calendar days (today as a
 * fraction, at least an hour).
 */
export type MergedTile = {
  byRoute: RouteCounts;
  n: number;
  perDay: number;
  /** The previous period of the same length; absent when nothing was read that far back. */
  previousPerDay?: number;
  spark: SparkPoint[];
};

/** The previous period of the same length, for the compare toggle. */
export type MetricsComparePeriod = {
  days: MetricsDay[];
  since: Timestamp;
  until: Timestamp;
};

/** What the numbers cover and what they can't. */
export type MetricsCoverage = {
  /** What fleetd can't see of the person's time, one plain line each, for the info sheet. */
  invisible: string[];
  repos: RepoCoverage[];
  stale: RepoStale[];
};

/** One calendar day in the viewer's zone; days with nothing are present too. */
export type MetricsDay = {
  day: LocalDate;
  human: SourceMs[];
  merged: RouteCounts;
  /** Bots and other merges not counted that day. */
  notCounted: SkipCount[];
};

export type MetricsGetInput = {
  /** Add the previous period of the same length's days (the tiles always carry its figures). */
  compare?: boolean;
  /** Absent: every project you can read, each repo counted once. */
  projectRef?: ProjectRef;
  since: Timestamp;
  tz: TimeZone;
  /** Absent: now. */
  until?: Timestamp;
};

export type MetricsGetOutput = {
  compare?: MetricsComparePeriod;
  coverage: MetricsCoverage;
  /** Every calendar day of the range in `tz`, oldest first, empty days included. */
  days: MetricsDay[];
  /** Landed changes in the range, newest first; `truncated` when there were more than fit. */
  merges: MetricsMerge[];
  mergesTotal: number;
  next?: string;
  /** Without projectRef: one row per repo. */
  repos?: MetricsRepoRow[];
  since: Timestamp;
  tiles: MetricsTiles;
  truncated?: boolean;
  until: Timestamp;
};

/** One landed change, for the list and the hovers. */
export type MetricsMerge = {
  additions?: number;
  author?: ActorKind;
  /** The train's batch PR it landed in. */
  batchPr?: number;
  changeId?: ChangeId;
  deletions?: number;
  /** The stages between requested and merged: its first PR opened, its review passed. */
  firstPrAt?: Timestamp;
  mergedAt: Timestamp;
  mergedBy?: ActorKind;
  orderToMergedMs?: number;
  prCreatedAt?: Timestamp;
  /** Absent on a direct push. */
  prNumber?: number;
  prOpenToMergedMs?: number;
  /** The project that owns it on this hub; the same repo may be checked out by others (`MetricsRepoRow`). */
  projectRef?: ProjectRef;
  repo: RemoteRepo;
  requestedAt?: Timestamp;
  requestedBasis?: RequestedBasis;
  reviewPassedAt?: Timestamp;
  route: MergeRoute;
  /** The ledger claim of a human session that saw this work before it landed. */
  seenClaim?: string;
  /** The merge, squash or pushed commit on the default branch. */
  sha?: CommitSha;
  taskId?: TaskId;
  title?: string;
  /** The person's touches that belong to this PR: reviews on it, its merge by hand. */
  touches: number;
  url?: string;
  workstreamId?: WorkstreamId;
};

/** One repo's four numbers, for the cross-fleet table under "All projects". */
export type MetricsRepoRow = {
  humanPerPrMs?: number;
  mergedPerDay: number;
  n: number;
  orderToMergedMedianMs?: number;
  /** Every project on this hub with it checked out, so the same merges show under each. */
  projects: ProjectRef[];
  repo: RemoteRepo;
  /** Merged per day over slices of the range. */
  spark: SparkPoint[];
  throughFleetdPct?: number;
};

export type MetricsRetentionSetInput = {
  retentionDays: number;
};

export type MetricsRetentionSetOutput = {
  next?: string;
  retentionDays: number;
  truncated?: boolean;
};

/** The KPI row: all four, equal. */
export type MetricsTiles = {
  human: HumanTile;
  merged: MergedTile;
  orderToMerged: OrderToMergedTile;
  throughFleetd: ThroughFleetdTile;
};

export type ModelName = string;

/**
 * Where the model list came from: the Models API on the hub's API key, or fleetd's own list of current Claude
 * models.
 */
export type ModelSource = "api" | "builtin";

export type MouseAction = "pressed" | "released" | "moved" | "wheel";

/** A mouse button, as CDP names it. */
export type MouseButton = "none" | "left" | "middle" | "right";

export type NaviArchiveInput = {
  /** False brings an archived Navi back. Default true. */
  archived?: boolean;
  machineId: MachineId;
  projectId: ProjectId;
};

export type NaviArchiveOutput = {
  navi: ProjectSummary;
  next?: string;
  truncated?: boolean;
};

/**
 * One ask in `navi_asks` (the app's read of a Navi's asked work): where it went, its words, and the orders opened
 * for it.
 */
export type NaviAsk = {
  at: Timestamp;
  handle: AskHandle;
  orders: NaviAskOrder[];
  /** The Navi's words, without the line telling the lead about the handle. */
  text: string;
  to: ProjectRef;
  toTitle: string;
};

/** An order opened for an ask, as it stands now. */
export type NaviAskOrder = {
  /** The lead's latest one-line headline for it. */
  headline?: string;
  state: WorkstreamState;
  title: string;
  workstreamId: WorkstreamId;
};

export type NaviAsksInput = {
  navi: ProjectRef;
};

export type NaviAsksOutput = {
  asks: NaviAsk[];
  navi: ProjectRef;
  next?: string;
  truncated?: boolean;
};

export type NaviCreateInput = {
  /** Where it lives; absent: the best worker (see `project_discover.best`). */
  machineId?: MachineId;
  /** What the person calls it ("Ada", "Home", "Taxes"). Its folder is named after it and keeps that name. */
  name: string;
};

export type NaviCreateOutput = {
  /** The new Navi: `kind` is `assistant`. */
  navi: ProjectSummary;
  next?: string;
  truncated?: boolean;
};

export type NaviListInput = {
  /** Include archived ones (default false). */
  archived?: boolean;
  /** Only those on this machine; absent: every machine. */
  machineId?: MachineId;
};

export type NaviListOutput = {
  /** Oldest first. */
  navis: ProjectSummary[];
  next?: string;
  truncated?: boolean;
};

export type NaviRenameInput = {
  machineId: MachineId;
  /** Its new name; its folder keeps the old one. */
  name: string;
  projectId: ProjectId;
};

export type NaviRenameOutput = {
  navi: ProjectSummary;
  next?: string;
  truncated?: boolean;
};

/** What a Navi's OS sandbox is on a machine, in a person's words. */
export type NaviSandbox = {
  /** What to run to close a gap or make Navis run here. */
  fix?: string;
  /** "Navis run in bubblewrap, with abstract sockets scoped (Landlock)." */
  line: string;
  status: SandboxStatus;
};

export type NaviSigninsForgetInput = {
  machineId: MachineId;
  projectId: ProjectId;
};

export type NaviSigninsForgetOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

/** A site a Navi fetches and opens without asking: a person approved its first visit. */
export type NaviSite = {
  allowedAt: Timestamp;
  /** Who approved it: `human:<their device's name>`. */
  allowedBy: string;
  /** Its host, without a leading `www.`: `example.com`. Its subdomains are sites of their own. */
  site: string;
};

export type NaviSiteRevokeInput = {
  machineId: MachineId;
  projectId: ProjectId;
  site: string;
};

export type NaviSiteRevokeOutput = {
  next?: string;
  /** What it may still fetch and open unasked. */
  sites: NaviSite[];
  truncated?: boolean;
};

export type NaviSitesInput = {
  machineId: MachineId;
  projectId: ProjectId;
};

export type NaviSitesOutput = {
  next?: string;
  /** By site. */
  sites: NaviSite[];
  truncated?: boolean;
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
  /** Whether the machine can host android sessions; absent where node.json turns them off and from older nodes. */
  android?: AndroidHealth;
  /** Logical CPUs. */
  cpus: number;
  /**
   * Whether the machine can host Linux desktop sessions, and in what; absent where node.json turns them off and
   * from older nodes.
   */
  desktop?: DesktopHealth;
  /** The volume holding the node's worktrees and build cache; absent from older nodes and when it can't be read. */
  disk?: NodeDisk;
  /** Disk to allow per new agent's worktree: node.json's `diskPerAgentGb`, else 5 GB. Absent from older nodes. */
  diskPerAgentBytes?: number;
  /**
   * What the machine can host for sessions (a browser, an Android emulator, an iOS simulator, a desktop); absent
   * from older nodes.
   */
  hosts?: HostCheck[];
  /**
   * Whether the machine can host iOS sessions; absent off macOS, where node.json turns them off, on a Mac without
   * Xcode that didn't opt in, and from older nodes.
   */
  ios?: IosHealth;
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
  /**
   * Memory pressure: the share of the last 10 s in which some task stalled waiting for memory (PSI `some avg10`),
   * percent. Linux only; absent on kernels without PSI and from older nodes.
   */
  memPressurePct?: number;
  /** Physical memory; absent from older nodes and when it can't be read. */
  memTotalBytes?: number;
  /** Memory in use (total minus available), percent. */
  memUsedPct?: number;
  /** Swap in use, percent. Linux only; absent without swap and from older nodes. */
  swapUsedPct?: number;
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

export type OnePasswordGetInput = { [key: string]: unknown };

export type OnePasswordGetOutput = {
  next?: string;
  /** The caller's saved token; absent until they save one. */
  token?: OnePasswordToken;
  truncated?: boolean;
};

export type OnePasswordRemoveInput = { [key: string]: unknown };

export type OnePasswordRemoveOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

export type OnePasswordSetInput = {
  /** The caller's service account token sealed to each machine agents run on. */
  sealed: ClaudeSeal[];
};

export type OnePasswordSetOutput = {
  /** Machines whose node doesn't hold it (offline when it was saved): save it again while they are online. */
  missingOn?: MachineId[];
  next?: string;
  token: OnePasswordToken;
  truncated?: boolean;
};

/** The last Test of a token: the vaults it reads, listed with the 1Password SDK on one machine. */
export type OnePasswordTest = {
  at: Timestamp;
  /** What went wrong, in plain words with the token masked; absent when it worked. */
  error?: string;
  machineId: MachineId;
  ok: boolean;
  /** The names of the vaults it can read. */
  vaults?: string[];
};

export type OnePasswordTestInput = {
  /** Where to try it; default: the first machine online that holds it. */
  machineId?: MachineId;
};

export type OnePasswordTestOutput = {
  next?: string;
  test: OnePasswordTest;
  truncated?: boolean;
};

/** A person's saved token: never the token, only where it is. */
export type OnePasswordToken = {
  lastTest?: OnePasswordTest;
  savedAt: Timestamp;
  /** Each machine whose node holds it. Work on a machine missing here has no token from the person. */
  sealedOn: ClaudeSealedOn[];
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

/** Time from order to merged, over the landed changes that belong to an order (`train` and `fleetd_by_hand`). */
export type OrderToMergedTile = {
  /** Of `n`, those timed from when the lead opened the order rather than when the person asked. */
  fromOpened: number;
  /** Absent when `n` is 0. */
  medianMs?: number;
  n: number;
  /** Landed changes with no order (`outside`, `direct`), shown as "n merged with no order". */
  noOrder: number;
  p90Ms?: number;
  /** PR opened to merged over every PR of every route, for a like-for-like comparison. */
  prOpenMedianMs?: number;
  previousMedianMs?: number;
  spark: SparkPoint[];
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

export type PairCodeCreateInput = {
  hubUrl?: string;
};

export type PairCodeCreateOutput = {
  /** `XXXX-XXXX`, single use: entered in the phone's pairing screen with `hubUrl`. */
  code: string;
  expiresAt: Timestamp;
  /** Where the phone reaches the hub: never a loopback address. */
  hubUrl: string;
  /** `fleetd://pair?hub=<hubUrl, URL-encoded>&code=<code>`, shown as the QR. */
  link: string;
  next?: string;
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

export type KnownPeopleChange = "invited" | "joined" | "invite_revoked" | "renamed" | "role_changed" | "removed" | "device_revoked";
/** KnownPeopleChange, or a value from a newer hub. */
export type PeopleChange = KnownPeopleChange | (string & {});

/** `people.changed`. */
export type PeopleChangedData = {
  /** Who made the change; absent for the hub machine's own CLI and for a device joining. */
  by?: PersonRef;
  change: PeopleChange;
  inviteId?: InviteId;
  keyId?: string;
  /** Whom it is about. */
  person: PersonRef;
};

export type PeopleListInput = {
  /** Removed people too. */
  includeRemoved?: boolean;
};

export type PeopleListOutput = {
  /** Human keys, each with its person, oldest first; revoked ones left out. */
  devices: AgentKeyInfo[];
  /** Open invites, newest first. */
  invites: Invite[];
  /** The caller's person; absent for an agent key. */
  me?: PersonId;
  next?: string;
  people: Person[];
  truncated?: boolean;
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

export type Person = {
  createdAt: Timestamp;
  name: string;
  personId: PersonId;
  /** Removed people keep their id and name, so what they did still names them; their devices are revoked. */
  removedAt?: Timestamp;
  role: HubRole;
};

/** One person's Claude setup. */
export type PersonClaude = {
  /** Absent: their subscription once connected, else the hub's API. */
  choice?: ClaudeChoice;
  /** Whether the hub's API is theirs to use: it is set up, and they administer the hub or members may use it. */
  mayUseHubApi: boolean;
  person: PersonRef;
  /** What the orders they start, and their Navi, run on now. */
  runsOn: ClaudeRunsOn;
  subscription?: ClaudeSubscription;
};

/** One person's GitHub, as an owner or admin sees it on People: absent `account` until they connect. */
export type PersonGithub = {
  account?: GithubAccount;
  person: PersonRef;
};

export type PersonId = string;

/**
 * Who did something, with their name at the time: on chat messages, approvals, secrets, decisions and checklist
 * changes.
 */
export type PersonRef = {
  name: string;
  personId: PersonId;
};

export type PersonRemoveInput = {
  personId: PersonId;
};

export type PersonRemoveOutput = {
  next?: string;
  person: Person;
  /** Devices revoked. */
  revoked: number;
  truncated?: boolean;
};

export type PersonSetInput = {
  name?: string;
  personId: PersonId;
  role?: HubRole;
};

export type PersonSetOutput = {
  next?: string;
  person: Person;
  truncated?: boolean;
};

export type PkceVerifier = string;

/** A `{{name}}` the code fills in. A required one missing from an edit gets a warning. */
export type Placeholder = {
  description: string;
  name: string;
  required: boolean;
};

/** Who wrote the PR: fleetd's agent when one did, and the GitHub account it was opened from. */
export type PrAuthor = {
  /** The writing agent's lane in the agents view. */
  laneId?: string;
  /** GitHub login; absent when GitHub wasn't reached. */
  login?: string;
  profile?: ProfileName;
  role?: AgentRole;
  taskId?: TaskId;
  /** Its session, for `agent_work`. */
  threadRef?: ThreadRef;
  /** The agent's task title. */
  title?: string;
};

/** A pull request: the client fills in its live state (title, checks, review, merged) from the hub. */
export type PrBlock = {
  number: number;
  repo: GitHubRepo;
  /** Shown until the live title is known. */
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
  cursor?: string;
  projectRef: ProjectRef;
};

export type PrListOutput = {
  at: Timestamp;
  /** GitHub couldn't be reached: the list holds only the PRs fleetd records, without checks. Why, and what to do. */
  githubError?: string;
  next?: string;
  /** There are more rows: pass it as cursor for the next page. */
  nextCursor?: string;
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

/** One preview as the hub keeps it. */
export type Preview = {
  askedBy: PreviewAsker;
  endReason?: PreviewEndReason;
  endedAt?: Timestamp;
  /** The commit it runs: the PR's head, or the order's merge, once checked out. */
  head?: string;
  /** When it ends if no one uses it, while it runs. */
  idleUntil?: Timestamp;
  /** Where it runs. */
  machineId: MachineId;
  /** One plain line when something needs saying: why it failed, that a newer commit is on the PR. */
  note?: string;
  of: PreviewOf;
  previewId: PreviewId;
  projectRef: ProjectRef;
  readyAt?: Timestamp;
  /** The browser session the app shows it in, held by the person from the start. */
  sessionId?: BrowserSessionId;
  startedAt: Timestamp;
  state: PreviewState;
  steps?: PreviewStep[];
  target: PreviewTarget;
  /** Where the person's own devices open it on the tailnet, once ready: `http://devbox:8414`. */
  url?: string;
};

/** Who asked for a preview, in the words the app shows ("you", "the lead, because you asked at 09:02"). */
export type PreviewAsker = {
  /** The person's chat message a lead started it for. */
  messageId?: ChatMessageId;
  words: string;
};

/**
 * A project's preview setting (Settings › Projects › Try it, or `project_settings_set {preview}`). Nothing runs
 * because of it: it says how to run a preview someone asks for.
 */
export type PreviewConfig = {
  /** A preview no one used for this many minutes ends. */
  idleMinutes?: number;
  web?: WebPreview;
};

/**
 * `preview_config_propose`: how to run the project's preview, for the person to approve as a card in the chat.
 * Nothing is saved until they do. Answered with the request, as `gated_run` is.
 */
export type PreviewConfigProposeCall = {
  config: PreviewConfig;
  why: string;
};

export type PreviewEndInput = {
  previewId: PreviewId;
};

export type PreviewEndOutput = {
  next?: string;
  preview: Preview;
  truncated?: boolean;
};

/** Why a preview ended. */
export type KnownPreviewEndReason = "ended" | "idle" | "cap" | "done" | "lost";
/** KnownPreviewEndReason, or a value from a newer hub. */
export type PreviewEndReason = KnownPreviewEndReason | (string & {});

/** `preview.state`: a preview started, moved a step, became ready, ended or failed. previews_list reads the rest. */
export type PreviewEventData = {
  of: PreviewOf;
  previewId: PreviewId;
  projectRef: ProjectRef;
  state: PreviewState;
};

export type PreviewFeedbackInput = {
  /** Add the last this-many seconds of the preview's session recording; absent or 0: none. */
  clipSeconds?: number;
  /** The screenshot with its pins drawn, and any other file, from attachment_put. */
  files?: AttachmentId[];
  pins: PreviewPin[];
  previewId: PreviewId;
};

export type PreviewFeedbackOutput = {
  /** Where it went, in words: "#14's writer, at its next step", "the lead, who decides how it's fixed". */
  deliveredTo: string;
  next?: string;
  truncated?: boolean;
};

export type PreviewId = string;

/** What a preview is of: one PR, or an order's PRs merged together onto their base on a scratch branch (D162). */
export type PreviewOf = {
  kind: "pr";
  number: number;
  repo: GitHubRepo;
} | {
  kind: "order";
  workstreamId: WorkstreamId;
};

/**
 * A point the person marked on a preview's screen, and what they said about it. `x` and `y` are where across and
 * down, in ten-thousandths of the screen.
 */
export type PreviewPin = {
  /** The page's address or screen when it was marked. */
  at?: string;
  /** The person's words; none: see the screenshot. */
  note?: string;
  /** What is under the pin, as the page names it: `the button "Pay"`. */
  what?: string;
  x: number;
  y: number;
};

export type PreviewStartInput = {
  of: PreviewOf;
  projectRef: ProjectRef;
  target?: PreviewTarget;
};

export type PreviewStartOutput = {
  next?: string;
  preview: Preview;
  truncated?: boolean;
};

export type KnownPreviewState = "starting" | "ready" | "ended" | "failed";
/** KnownPreviewState, or a value from a newer hub. */
export type PreviewState = KnownPreviewState | (string & {});

/**
 * One step of a preview's start, in the words the app shows: "Build: pnpm build", "reused: pnpm-lock.yaml hasn't
 * changed".
 */
export type PreviewStep = {
  detail?: string;
  /** A failed step's output, its end, masked. */
  outputTail?: string;
  state: PreviewStepState;
  /** How long it took, once over. */
  tookMs?: number;
  words: string;
};

export type PreviewStepState = "queued" | "running" | "done" | "failed" | "reused";

/** An agent's suggestion to try a PR: one line with a Try it button, once per PR. Nothing runs from it. */
export type PreviewSuggestion = {
  at: Timestamp;
  /** Who suggests it: "#14's writer". */
  by: string;
  of: PreviewOf;
  projectRef: ProjectRef;
  /** Why a person should try it, in a line. */
  why: string;
};

/** What a preview runs: phase 1 is the web; Android, iOS and the desktop follow (docs/design/try-it.md, Phases). */
export type KnownPreviewTarget = "web";
/** KnownPreviewTarget, or a value from a newer hub. */
export type PreviewTarget = KnownPreviewTarget | (string & {});

export type PreviewsListInput = {
  /** Only those of this PR or order. */
  of?: PreviewOf;
  projectRef: ProjectRef;
};

export type PreviewsListOutput = {
  /**
   * The caller's key may start previews on this project: a human key with admin or operate on its machine (D162).
   * False: it only opens running ones. Absent from older hubs: the app offers Try it and shows a refusal.
   */
  canStart?: boolean;
  next?: string;
  /** Running ones first, then the newest that ended. */
  previews: Preview[];
  /** Agents' suggestions to try a PR, for those with no preview yet. */
  suggestions: PreviewSuggestion[];
  truncated?: boolean;
};

/**
 * One task profile (Settings › Hub › Every project › Profiles): what an agent on it runs on. Exactly one is the hub's default, which
 * every project allows and the lead, every review and claude's helper calls run on.
 */
export type Profile = {
  default: boolean;
  effort: Effort;
  /** Claude Code's fast mode (`fastMode`), only on a model that has it. */
  fast: boolean;
  id: number;
  model: ModelName;
  name: ProfileName;
  /** What it is for, in one line; the lead reads it to pick one. */
  note: string;
  /**
   * Set by the hub: claude refused `model`, so its agents run on the runner's own model until a person sets the
   * model again. What claude said, and where.
   */
  refused?: string;
  updatedAt: Timestamp;
};

export type ProfileCreateInput = {
  /** Makes it the hub's default. */
  default?: boolean;
  effort: Effort;
  fast?: boolean;
  model: ModelName;
  name: ProfileName;
  note: string;
};

export type ProfileCreateOutput = {
  next?: string;
  profile: Profile;
  truncated?: boolean;
};

export type ProfileDeleteInput = {
  id: number;
};

export type ProfileDeleteOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

/** A model a profile may pick (`profiles_list`). */
export type ProfileModel = {
  displayName?: string;
  /** Claude Code offers fast mode on it. */
  fast: boolean;
  id: ModelName;
};

export type ProfileName = string;

/**
 * One task profile's part of a scope's agent time and usage, from the spans kept (`coverage.detailSince` on): the
 * tasks that ran on it, and the lead's spans under the default profile they ran on.
 */
export type ProfileTotal = {
  /** Exclusive agent time. */
  agentMs: number;
  /** The model's part of it. */
  modelMs: number;
  /** What the runner reported for its messages. */
  outputTokens: number;
  profile: ProfileName;
};

export type ProfileUpdateInput = {
  /** True makes it the hub's default; the default can't be unset, only replaced. */
  default?: boolean;
  effort?: Effort;
  fast?: boolean;
  id: number;
  /** Setting the model again clears a refusal. */
  model?: ModelName;
  /** A rename: the tasks not yet ended move to the new name; ended ones keep the old in their history. */
  name?: ProfileName;
  note?: string;
};

export type ProfileUpdateOutput = {
  next?: string;
  profile: Profile;
  truncated?: boolean;
};

export type ProfilesListInput = {
  /** A project: also which profiles it allows. */
  projectRef?: ProjectRef;
};

export type ProfilesListOutput = {
  /** With projectRef: the profiles it allows, the default first. */
  allowed?: ProfileName[];
  /** Every level Claude Code's `--effort` takes; a model without one runs the nearest below. */
  efforts: Effort[];
  /** The models a profile may pick. */
  models: ProfileModel[];
  modelsFrom: ModelSource;
  next?: string;
  /** The default first, then by name. */
  profiles: Profile[];
  truncated?: boolean;
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
  /**
   * Make a new folder for the project first: at `path`, else `<projectsRoot>/<name from title>`. An empty folder
   * already there is taken; one holding anything is refused.
   */
  create?: boolean;
  /** With `url`: clone here instead of `<cloneRoot>/<name>`. */
  dest?: string;
  dryRun?: boolean;
  /** With `create`: `git init` the new folder. Absent: a plain folder with no git. */
  gitInit?: boolean;
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

export type ProjectAvatarGetInput = {
  machineId: MachineId;
  projectId: ProjectId;
};

export type ProjectAvatarGetOutput = {
  /** The picture's id, as the project's summary names it in `avatar`. */
  avatar: string;
  /** Standard base64. */
  dataB64: string;
  /** Always image/jpeg. */
  mime: AttachmentMime;
  next?: string;
  truncated?: boolean;
};

export type ProjectAvatarSetInput = {
  /** The picture, uploaded with attachment_put (png, jpeg or webp). Absent removes the picture: the letters again. */
  attachmentId?: AttachmentId;
  /** The square of it to keep; absent: the largest square in its middle. Clamped to the picture. */
  crop?: AvatarCrop;
  machineId: MachineId;
  projectId: ProjectId;
};

export type ProjectAvatarSetOutput = {
  next?: string;
  project: ProjectSummary;
  truncated?: boolean;
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
  /** The nudges still waiting to be seen, oldest first: what the app shows as "N to look at". Absent when none is. */
  nudges?: ChatOpenNudge[];
  /**
   * The inline items still open, oldest first, however far back: the chat may not have their page loaded. Absent
   * when none is (and from older hubs).
   */
  openItems?: ChatOpenItem[];
  projectRef: ProjectRef;
};

/** The key a project was created with: its id, and the person's or device's name the key carries. */
export type ProjectCreator = {
  keyId: string;
  name: string;
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

export type ProjectEnvSetInput = {
  machineId: MachineId;
  projectId: ProjectId;
  remove?: EnvVarName[];
  /** Variables to add or replace; a secret replaces a plain one of the same name and the other way round. */
  set?: EnvVarSet[];
};

export type ProjectEnvSetOutput = {
  env: ProjectEnvVar[];
  next?: string;
  truncated?: boolean;
};

/** One of a project's variables as the hub keeps it. A secret has no value here, only its fingerprint. */
export type ProjectEnvVar = {
  /** The value's size in bytes, a secret's too, for the project's total ([`ENV_TOTAL_MAX_BYTES`]). */
  bytes: number;
  /** A secret's: the first 8 hex characters of sha256 over its value, as the node computed it. */
  fingerprint?: SecretFingerprint;
  kind: EnvVarKind;
  name: EnvVarName;
  updatedAt: Timestamp;
  /** A plain variable's value. */
  value?: EnvValue;
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
  /** Hint for the next call. */
  next?: string;
  /** The profiles its agents may run on (`project_set`), the hub's default first; absent from older hubs. */
  profiles?: ProfileName[];
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

/** What a project is. Absent on a project: one of code, a lead with its repos and folders. */
export type KnownProjectKind = "assistant";
/** KnownProjectKind, or a value from a newer hub. */
export type ProjectKind = KnownProjectKind | (string & {});

/** The one-call project outcome, returned as-is by project_get. */
export type ProjectOutcome = {
  asOf: Timestamp;
  /** Absent until lead_start. */
  lead?: Lead;
  /** Hint for the next call. */
  next?: string;
  /** The profiles its agents may run on (`project_set`), the hub's default first; absent from older hubs. */
  profiles?: ProfileName[];
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

/**
 * A project: a workspace with a lead and its own directory, on its home machine, where the lead runs. Its
 * `projectId` is the node's id for that directory, so the ref also addresses the files; the directory may be a git
 * repo or a plain folder. A project holds zero or more repos (`ProjectRepo`), each in a node directory of its
 * own or in the project's.
 */
export type ProjectRef = {
  machineId: MachineId;
  projectId: ProjectId;
};

export type ProjectRemoveInput = {
  machineId: MachineId;
  projectId: ProjectId;
  /**
   * Also force-remove the fleetd worktrees its agents worked in, uncommitted changes and all, once its agents have
   * stopped. Their branches and the checkout stay as they are.
   */
  removeWorktrees?: boolean;
};

export type ProjectRemoveOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

export type ProjectRepo = {
  /** The branch its work lands on; absent until fleetd knows it. */
  base?: string;
  /**
   * The node's directory holding its files: the project's own `ProjectRef` when the project's directory is this
   * repo.
   */
  checkout: ProjectRef;
  name: RepoName;
  /** The checkout's directory on its machine; absent before its node reported it. */
  path?: string;
  repoId: RepoId;
  /** Its origin remote, shortened; absent for a repo with no remote, or before fleetd has read it. */
  repoKey?: RepoKey;
};

export type ProjectRepoAddInput = {
  /** With `url`: clone here instead of `<cloneRoot>/<name>`. */
  dest?: string;
  machineId: MachineId;
  /** Absent: from its remote or folder, e.g. `api`, made unique in the project. */
  name?: RepoName;
  /** A git checkout on the project's machine. */
  path?: string;
  projectId: ProjectId;
  /** A GitHub URL, `git@github.com:o/r.git`, or `owner/repo`, cloned onto the project's machine. */
  url?: string;
  /** With `url`: when the destination is already a checkout of the same repository, add it instead of failing. */
  useExisting?: boolean;
};

export type ProjectRepoAddOutput = {
  /** A clone was started: its `project.clone_progress`, `project.added` and `project.add_failed` events carry it. */
  addId?: string;
  /** The project the checkout was until now, archived read-only. */
  archived?: ProjectRef;
  next?: string;
  /** The checkout's directory (the clone's destination for a url). */
  path: string;
  /** The repo, once added; absent while a clone runs. */
  repo?: ProjectRepo;
  truncated?: boolean;
};

export type ProjectRepoListInput = {
  machineId: MachineId;
  projectId: ProjectId;
};

export type ProjectRepoListOutput = {
  next?: string;
  /** Oldest first, its own repo first; none for a plain folder. */
  repos: ProjectRepo[];
  truncated?: boolean;
};

export type ProjectRepoRemoveInput = {
  machineId: MachineId;
  name: RepoName;
  projectId: ProjectId;
};

export type ProjectRepoRemoveOutput = {
  /** The repo's live tasks, cancelled. */
  cancelled: TaskId[];
  next?: string;
  removed: ProjectRepo;
  truncated?: boolean;
};

/** What a project is doing, in one word. */
export type KnownProjectRowState = "working" | "waiting_on_you" | "blocked" | "idle";
/** KnownProjectRowState, or a value from a newer hub. */
export type ProjectRowState = KnownProjectRowState | (string & {});

export type ProjectSetInput = {
  machineId: MachineId;
  profiles: ProfileName[];
  projectId: ProjectId;
};

export type ProjectSetOutput = {
  next?: string;
  /** The profiles it allows now, the default first. */
  profiles: ProfileName[];
  truncated?: boolean;
};

export type ProjectSettings = {
  /** Its agents' variables, by name. A secret's value is never here. */
  env: ProjectEnvVar[];
  /**
   * True: a finished task's worktree stays on the machine. False (the default): a reader's goes when it finishes
   * and a writer's once its PR merges.
   */
  keepWorktrees: boolean;
  machineId: MachineId;
  /**
   * True (the default): each night the lead tidies the project's memory, with a line in the chat to undo it.
   * Absent from older hubs.
   */
  memoryRefresh?: boolean;
  /** How to run a preview someone asks for (Try it); absent when none is set, and from older hubs. */
  preview?: PreviewConfig;
  projectId: ProjectId;
  /** The repo `setup` and `preview` are for; absent when they are the project's, and from older hubs. */
  repo?: RepoName;
  /** What runs in each new worktree before its agent starts; no commands when none are set. */
  setup: WorktreeSetup;
  title: string;
  /** How the merge train treats the checks of the project's repo; none set by default. */
  train?: TrainSettings;
  workspaceRoot: string;
  /** From the node, now: absent while it is offline or too old to say. */
  worktrees?: ProjectWorktrees;
  /** Why `worktrees` is absent. */
  worktreesUnknown?: string;
};

export type ProjectSettingsGetInput = {
  machineId: MachineId;
  projectId: ProjectId;
  /** The repo whose setup and preview to read (its own, else the project's); absent: the project's. */
  repo?: RepoName;
};

export type ProjectSettingsGetOutput = {
  next?: string;
  settings: ProjectSettings;
  truncated?: boolean;
};

export type ProjectSettingsSetInput = {
  keepWorktrees?: boolean;
  machineId: MachineId;
  /** Turns the nightly memory refresh on or off for the project. */
  memoryRefresh?: boolean;
  /** Replaces how a preview runs; one with no target turns Try it off for the project. */
  preview?: PreviewConfig;
  projectId: ProjectId;
  /**
   * The repo whose own setup and preview to set, an empty one giving it the project's; absent: the
   * project's. Title, keepWorktrees and train are the project's either way.
   */
  repo?: RepoName;
  /** Replaces the project's setup commands and their settings; no commands turns setup off. */
  setup?: WorktreeSetup;
  /** The project's name in fleetd; its folder keeps its own. */
  title?: string;
  /**
   * Replaces how the merge train treats the repo's checks: the checks it also waits for, and those left for
   * after the merge.
   */
  train?: TrainSettings;
};

export type ProjectSettingsSetOutput = {
  next?: string;
  settings: ProjectSettings;
  truncated?: boolean;
};

/** One project on the Status screen: a state word, its work in groups, agents running and the last merge. */
export type ProjectStatusRow = {
  /** Its task agents holding a slot now (the lead's own turn is not one). */
  agentsRunning: number;
  asOf: Timestamp;
  /** Blocked only: why, in one line, for the expanded row. */
  blockedReason?: string;
  counts: StatusCounts;
  /** Group by group in `StatusGroup` order, newest first in each, at most `STATUS_ITEMS_PER_GROUP` per group. */
  items: StatusItem[];
  lastMerged?: LastMerged;
  /**
   * Landed changes on its repos over the last 7 calendar days in the hub's zone, today included, by every route
   * (metrics_get's count). Absent when the metrics know none of its repos, so nothing is read as zero.
   */
  merged7d?: number;
  projectRef: ProjectRef;
  /** Set when a source the row reads (its machine, its repos on GitHub, their merge train) went quiet. */
  stale?: StaleMark;
  state: ProjectRowState;
  /** Of `merged_7d`, the share the merge train landed, in percent. Absent when nothing landed. */
  throughFleetdPct7d?: number;
  title: string;
  /** Blocked by a usage pause on this machine's login: the app offers Resume (usage_resume) for it. */
  usagePausedOn?: MachineId;
  /**
   * With `usage_paused_on`: the pause in its own words ("paused until Sun 23:40 UTC (usage limit on devbox's
   * login)"), which `blocked_reason` may not be when the machine is also degraded.
   */
  usagePausedReason?: string;
  /**
   * Worth knowing, but it stops nothing: a check red on main, and whether a fix is under way ("`ios sessions` is
   * red on main, fix in progress"). Any state.
   */
  warning?: string;
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
  /**
   * A Navi's: when it was archived. An archived Navi keeps its chat, memory and folder, and its lead doesn't
   * start until it is brought back (`navi_archive` with `archived: false`).
   */
  archivedAt?: Timestamp;
  /**
   * Its picture's id, from the hub, once a person gave it one (`project_avatar_set`): it changes with each new
   * picture, whose bytes come from `project_avatar_get`. Absent: its letters show.
   */
  avatar?: string;
  /**
   * A Navi's: the key that created it, from the hub. Absent for other projects, and for a Navi made before it was
   * recorded.
   */
  createdBy?: ProjectCreator;
  /**
   * What the project is, from the hub: `assistant` for a Navi. Absent for a project of code, from a node, and
   * from an older hub.
   */
  kind?: ProjectKind;
  lastActivityAt: Timestamp;
  machineId: MachineId;
  /**
   * A Navi's: the person it belongs to (D215), from the hub, which shows it and lets it be used by them alone.
   * Absent for other projects, on a hub without people, and from an older hub.
   */
  owner?: PersonId;
  projectId: ProjectId;
  /** The git repos it holds, from the hub; none for a plain directory, from a node, and from an older hub. */
  repos?: ProjectRepo[];
  threads: ThreadCounts;
  title: string;
  workspaceRoot: string;
};

/** One fleetd worktree of the project on its node, under `<node home>/worktrees/<project>/`. */
export type ProjectWorktree = {
  /** A writer's branch; absent for a read or review task's detached worktree. */
  branch?: string;
  path: string;
  /** The session that works in it. */
  sessionId: ThreadId;
  /** It has changes git hasn't committed (gitignored files don't count): deleting the project loses them. */
  uncommitted: boolean;
};

/** Where the project's worktrees live on its node and what is there now. */
export type ProjectWorktrees = {
  /**
   * The branch new worktrees start from, freshly fetched from the remote: the repo's default branch. Absent for a
   * repo with no commit yet.
   */
  baseBranch?: string;
  /** `<node home>/worktrees/<project>`: every new worktree of the project goes here, one per session. */
  dir: string;
  worktrees: ProjectWorktree[];
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

export type PushBadgeInput = { [key: string]: unknown };

export type PushBadgeOutput = {
  badge: number;
  next?: string;
  truncated?: boolean;
};

/** A phone that gets its person's notifications. Its token and key stay on the hub. */
export type PushDevice = {
  createdAt: Timestamp;
  deviceId: PushDeviceId;
  /** The last notification the relay took for it. */
  lastSentAt?: Timestamp;
  name: string;
  platform: PushPlatform;
};

export type PushDeviceId = string;

export type PushDeviceRegisterInput = {
  name: string;
  platform: PushPlatform;
  /** The device's X25519 public key: 32 bytes, standard base64. */
  publicKey: string;
  /** The APNs device token (hex) or the FCM registration token. */
  token: string;
};

export type PushDeviceRegisterOutput = {
  device: PushDevice;
  next?: string;
  /**
   * The hub sends phone notifications: through its relay, push.fleetd.sh unless one is set. False when an admin
   * turned them off.
   */
  relay: boolean;
  truncated?: boolean;
};

export type PushDeviceRemoveInput = {
  deviceId: PushDeviceId;
};

export type PushDeviceRemoveOutput = {
  device: PushDevice;
  next?: string;
  truncated?: boolean;
};

export type PushDevicesListInput = { [key: string]: unknown };

export type PushDevicesListOutput = {
  devices: PushDevice[];
  next?: string;
  relay: boolean;
  truncated?: boolean;
};

export type PushPlatform = "ios" | "android";

export type PushRelaySetInput = {
  /**
   * The relay's key (its FLEETD_PUSH_RELAY_KEY_FILE), sealed to this hub's boxPubKey (hub_links_get); the hub sends
   * it as a bearer token. Absent: the relay takes no key.
   */
  key?: SealedSecret;
  url: string;
};

export type PushRelaySetOutput = {
  /** The hub uses the default relay, https://push.fleetd.sh. */
  default: boolean;
  /** The hub keeps a key for the relay. */
  key: boolean;
  next?: string;
  truncated?: boolean;
  /** Absent: no relay, no notifications. */
  url?: string;
};

export type QuietWindow = {
  from: Timestamp;
  to: Timestamp;
};

export type ReadyPath = string;

/** A commit that reached the base outside the train, as `work_list` shows it: what the hub's `Landings` reads back. */
export type RecentLanding = {
  /** The commit's committer time. */
  at: Timestamp;
  authorEmail?: string;
  /** The work it matched exactly: "P5", "T12", "C7". */
  covers: string[];
  /** The PR it merged as, when its message or the host names one: "#57", or its URL. */
  pr?: string;
  route: LandingRoute;
  sha: CommitSha;
  subject: string;
};

/** The files of a recording, each scrubbed on the node before upload. */
export type RecordingFile = "actions" | "dom" | "video" | "video_mp4";

/** How a recovering task goes on. */
export type RecoveryMode = "resume" | "compact" | "fresh";

/** `machine.recovery_paused`. */
export type RecoveryPausedData = {
  /** true: dead agents there wait instead of resuming; false: they resume again. */
  paused: boolean;
  /** The agents whose deaths opened it, oldest first. */
  taskIds?: TaskId[];
  /** When it closes if nothing else dies there; an agent there completing closes it sooner. */
  until?: Timestamp;
};

/** What a `remember` or `forget` call wrote, as a line in the project's chat. Undone with `memory_undo`. */
export type RememberedItem = {
  /** `forget` removed `text`; Undo puts it back. */
  forgotten?: boolean;
  /** User scope: whose memory it is in. Absent for the shared `user.md` of a hub from before people. */
  person?: PersonId;
  /** Why it was forgotten. */
  reason?: string;
  /** The whole entry it replaced, which Undo puts back. */
  replaced?: string;
  scope: MemoryScope;
  /** The entry written; with `forgotten`, the whole entry removed. */
  text: string;
  topic?: MemoryTopic;
  undone?: boolean;
};

export type RemoteRepo = string;

export type RepeatStat = {
  label: string;
  /** Runs in a row with no edit between them. */
  n: number;
  taskId?: TaskId;
  threadId: ThreadId;
  totalMs: number;
};

/** `repo.advanced`: a node's fetch saw the remote's default branch move, so the hub reads the repo's merges now. */
export type RepoAdvancedData = {
  branch: string;
  /** Absent on the first fetch the node saw. */
  from?: CommitSha;
  repo: RemoteRepo;
  to: CommitSha;
};

/** What a repo's figures were read from. */
export type RepoCoverage = {
  defaultBranch?: string;
  host: GitHost;
  /** Merges are known from here on (the first read backfills 90 days). */
  knownSince?: Timestamp;
  /** The last good read of its host's API or its git log. */
  lastRead?: Timestamp;
  /**
   * The host's merged PRs are still being read back to the backfill's start: a busy repo's first read is bounded,
   * and the next reads go on from where it stopped. `known_since` is as far as they have reached.
   */
  partlyRead?: boolean;
  repo: RemoteRepo;
  /**
   * What can't be known of this repo's changes from what it is read from, one plain line each: on a repo read
   * from git alone, who merged, reviews and bots. Absent when its host is read through its API.
   */
  unknown?: string[];
};

export type RepoId = string;

export type RepoKey = string;

/** Repo name, [a-z0-9-]{1,32} */
export type RepoName = string;

/** A repo whose reads are failing: its figures stop at `since`, never a silent zero. */
export type RepoStale = {
  /** "GitHub not read since 14:02: `gh` is signed out". */
  reason: string;
  repo: RemoteRepo;
  since: Timestamp;
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

/** Where an order's `requested_at` came from. */
export type RequestedBasis = "source" | "chat" | "opened";

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

export type Role = "read" | "operate" | "admin";

/** Landed changes per route. */
export type RouteCounts = {
  direct: number;
  fleetdByHand: number;
  outside: number;
  train: number;
};

/** Lines changed by one route's landed changes, for the share's tooltip (the share itself is by count). */
export type RouteLines = {
  additions: number;
  deletions: number;
  route: MergeRoute;
};

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

export type KnownSandboxStatus = "ready" | "gap" | "missing";
/** KnownSandboxStatus, or a value from a newer hub. */
export type SandboxStatus = KnownSandboxStatus | (string & {});

export type SealedSecret = string;

export type SecretEnvEntry = {
  name: EnvName;
  secretKey: DecisionKey;
};

/** 8 lowercase hex characters: the sha256 prefix of the plaintext */
export type SecretFingerprint = string;

/** A secret request: the secret's name and where the node writes it. */
export type SecretRequest = {
  /** An env: or order: sink's variable, when not the one the key names (`secret_env_name`). */
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

/** A kind of session a machine can host. */
export type KnownSessionHost = "browser" | "android" | "ios" | "desktop";
/** KnownSessionHost, or a value from a newer hub. */
export type SessionHost = KnownSessionHost | (string & {});

/**
 * What a session drives: a fresh Chrome with an empty profile (`browser`, driven with agent-browser), or a fresh
 * `-read-only` copy of an Android emulator booted from its Quick Boot snapshot (`android`, driven with agent-device at
 * the copy's serial), a fresh clone of an iOS simulator from the node's settled golden device (`ios`, driven with
 * agent-device at the clone's udid), or an X display of its own with a window manager (`linux_desktop`, driven with
 * the agent's `desktop` tool), in a fresh container or else beside a fresh home directory. Every kind shares the
 * session tools, the action log, the video and the hub's storage; only a browser recording has a `dom` file, and an
 * iOS one's video is `video_mp4`. A node hosts android sessions when it lists the `session_android` capability, iOS
 * ones when it lists `session_ios`, and desktop ones when it lists `session_linux_desktop`.
 */
export type KnownSessionKind = "browser" | "android" | "ios" | "linux_desktop";
/** KnownSessionKind, or a value from a newer hub. */
export type SessionKind = KnownSessionKind | (string & {});

/** `session_prompt_get`: exactly what a session was told at its start. */
export type SessionPrompt = {
  /** Tools the node's runner never offers a fleetd session. */
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

/**
 * A field for what the provider gives back. A secret one is sealed on the admin's device, never sent in the clear and
 * never shown again.
 */
export type SetupField = {
  label: string;
  /** A pasted file (a JSON key): several lines. */
  multiline?: boolean;
  name: string;
  /** Where a secret is sealed to, when not every machine. */
  note?: string;
  optional?: boolean;
  placeholder?: string;
  secret?: boolean;
};

/** Where a step sits in the list. */
export type KnownSetupGroup = "accounts" | "people" | "hub";
/** KnownSetupGroup, or a value from a newer hub. */
export type SetupGroup = KnownSetupGroup | (string & {});

export type SetupInput = string;

/** A provider's page, opened in the browser. */
export type SetupLink = {
  label: string;
  url: string;
};

export type SetupListInput = { [key: string]: unknown };

export type SetupListOutput = {
  next?: string;
  /** Required steps not done: agents can't run until none is left. */
  requiredLeft: number;
  steps: HubSetupStep[];
  truncated?: boolean;
};

/** When a step must be done. Nothing blocks using fleetd before then. */
export type SetupNeed = {
  kind: "required";
} | {
  kind: "before";
  what: string;
} | {
  kind: "optional";
};

/** One numbered part of a step: what to open, then what to fill in there. */
export type SetupPart = {
  links?: SetupLink[];
  note?: string;
  /** The step works without it. */
  optional?: boolean;
  title: string;
  values?: SetupValue[];
};

export type SetupSkipInput = {
  /** False: back on the list as to do. */
  skipped: boolean;
  step: SetupStepId;
};

export type SetupSkipOutput = {
  next?: string;
  step: HubSetupStep;
  truncated?: boolean;
};

/** Read from the step's checks, never from how far a wizard got. */
export type KnownSetupStatus = "done" | "todo" | "look" | "skipped";
/** KnownSetupStatus, or a value from a newer hub. */
export type SetupStatus = KnownSetupStatus | (string & {});

/** One step of adding or removing a machine. */
export type SetupStep = {
  /** The command as you would run it yourself (over ssh for another machine); absent for the hub's own wait. */
  command?: string;
  /** The last lines it printed: a short answer when done, its output and the fix when failed. */
  output?: string;
  state: SetupStepState;
  /** What goes to the command's stdin, described: "the fleetd binary (31 MB)", never the one-time token. */
  stdin?: string;
  /** "install fleetd 0.4.0", "wait until builder-1 is online". */
  title: string;
};

/** The steps, in the order they are listed. */
export type KnownSetupStepId = "address" | "machines" | "claude" | "github" | "people";
/** KnownSetupStepId, or a value from a newer hub. */
export type SetupStepId = KnownSetupStepId | (string & {});

export type SetupStepState = "running" | "done" | "failed" | "planned";

export type SetupTestInput = {
  step: SetupStepId;
};

export type SetupTestOutput = {
  next?: string;
  /** The step, read from its checks as they are now. */
  step: HubSetupStep;
  truncated?: boolean;
};

/** A value for the provider's form, computed for this hub. */
export type SetupValue = {
  /** A command to run, rather than a value to paste. */
  command?: boolean;
  /** Filled in by fleetd (a manifest, a link): shown to read, never copied. */
  filled?: boolean;
  label: string;
  /** How to paste it, or where. */
  note?: string;
  /** Words, not a value: what to pick, tick or leave alone. */
  plain?: boolean;
  value: string;
};

/**
 * One way to complete a step: its doctor checks, `hub/<name>`, or `*\/<name>` for every machine's. Its status is the
 * worst of them.
 */
export type SetupWay = {
  checks: string[];
  /** Names the way where a step has several: "the hub's API key". */
  label?: string;
};

export type SkillDeleteInput = {
  name: SkillName;
  /** Required with scope project. */
  projectRef?: ProjectRef;
  scope: SkillScope;
};

export type SkillDeleteOutput = {
  next?: string;
  ok: true;
  truncated?: boolean;
};

export type SkillGetInput = {
  name: SkillName;
  origin: SkillOrigin;
  /** Required for every origin but global. */
  projectRef?: ProjectRef;
};

export type SkillGetOutput = {
  next?: string;
  skill: SkillSummary;
  text: string;
  truncated?: boolean;
};

/**
 * Where an installed skill came from, pinned: Update fetches the same source again and moves the pin. Nothing
 * updates on its own.
 */
export type SkillInstall = {
  /** The commit the files are from. */
  commit: string;
  installedAt: Timestamp;
  /** The skill's folder in the repo; empty for a repo that is one skill. */
  path: string;
  /** The branch or tag followed; `HEAD` for the default branch. */
  ref: string;
  /** As given: `owner/repo`, `owner/repo@skill`, a GitHub URL (`/tree/<ref>/<path>` too) or any git URL. */
  source: string;
  /** What was cloned. */
  url: string;
};

export type SkillInstallInput = {
  /** Required with scope project. */
  projectRef?: ProjectRef;
  scope: SkillScope;
  /** Only this skill of the source; absent, every skill it has. */
  skill?: SkillName;
  source: string;
};

export type SkillInstallOutput = {
  installed: SkillSummary[];
  next?: string;
  truncated?: boolean;
};

/** Lowercase letters, digits and single hyphens, at most 64 characters */
export type SkillName = string;

/** Where a skill comes from, in precedence order: on a name clash the first wins. */
export type SkillOrigin = "repo_agents" | "repo_claude" | "project" | "global";

/** The hub's two scopes, which a person (and a lead's `skill_install`) writes. */
export type SkillScope = "project" | "global";

export type SkillSetInput = {
  /** Refuse when a skill of that name is already in the scope (New). */
  create?: boolean;
  name: SkillName;
  /** Required with scope project. */
  projectRef?: ProjectRef;
  scope: SkillScope;
  text: string;
};

export type SkillSetOutput = {
  next?: string;
  skill: SkillSummary;
  truncated?: boolean;
};

/** One skill as Settings → Skills and the composer list it. */
export type SkillSummary = {
  /** From the frontmatter; empty when it has none. */
  description: string;
  /** The folder's other files, folder-relative. */
  files?: string[];
  /** Installed from a source. */
  install?: SkillInstall;
  name: SkillName;
  origin: SkillOrigin;
  /** A repo skill: its `SKILL.md`, repo-relative. */
  path?: string;
  /** The origin whose skill of the same name sessions get instead. */
  shadowedBy?: SkillOrigin;
  updatedAt?: Timestamp;
};

export type SkillUpdateInput = {
  name: SkillName;
  /** Required with scope project. */
  projectRef?: ProjectRef;
  scope: SkillScope;
};

export type SkillUpdateOutput = {
  next?: string;
  skill: SkillSummary;
  truncated?: boolean;
  /** The pin moved: the source had a newer commit. */
  updated: boolean;
};

export type SkillsListInput = {
  projectRef?: ProjectRef;
};

export type SkillsListOutput = {
  next?: string;
  /** Why the repo's skills are missing from the list (the machine is offline, or its node can't list them). */
  repoUnavailable?: string;
  /** In precedence order, then by name. */
  skills: SkillSummary[];
  truncated?: boolean;
};

/** Merges that are not landed changes, by why. */
export type SkipCount = {
  n: number;
  why: SkipWhy;
};

/** Why a merge into the repo is not a landed change. These are counted in the tooltips, never silently dropped. */
export type KnownSkipWhy = "bot" | "other_base" | "merge_back";
/** KnownSkipWhy, or a value from a newer hub. */
export type SkipWhy = KnownSkipWhy | (string & {});

/** A span a machine spent asleep, epoch milliseconds; `machine.slept` carries the same fields as its data. */
export type SleptSpan = {
  fromMs: number;
  toMs: number;
};

export type SlotState = {
  /** Agents running at once across every project: `fleetCap` when set, else the sum of the machines' caps. */
  cap: number;
  /** The fleet cap a person (or an older hub) saved; absent: none beyond the machines' own caps. */
  fleetCap?: number;
  perMachine?: SlotStatePerMachine[];
  perProject: SlotStatePerProject[];
  queued: number;
  used: number;
};

/** One machine's share of the board: what it fits, and what runs there. */
export type SlotStatePerMachine = {
  /**
   * What the machine fits: one agent per CPU less a reserve, and 2 GB of memory each after the OS's share, at
   * most 64.
   */
  auto: number;
  /** The most agents that run on it at once: a person's setting for the machine, else `auto`. */
  cap: number;
  /** New agents its free disk has room for now, above the guard's floor; absent while the node reports no disk. */
  diskRoom?: number;
  machineId: MachineId;
  /** A person's setting for the machine (`cap_set`); absent: it runs `auto`. */
  maxAgents?: number;
  /** Agents running there now. */
  running: number;
  /** The term that sets `auto`, e.g. "memory 18 GB, about 2 GB an agent" or "14 of 16 CPUs". */
  why: string;
};

export type SlotStatePerProject = {
  /**
   * The most of the project's agents (its tasks: writers, readers, reviewers) that run at once; its lead is not
   * one. Until set, the default: its machine's `cap`, within the fleet cap.
   */
  maxAgents: number;
  /**
   * A person set the project's own max; false: it follows the default. Absent from a hub before this, which
   * listed a project only once set or busy.
   */
  own?: boolean;
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

/** The person's minutes from one source on one day. */
export type SourceMs = {
  ms: number;
  source: HumanSource;
  touches: number;
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
  /** The item id in the thread (the runner's tool call or message id), for `thread_window`. */
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
  /** `gap`: how many spans were lost. */
  count?: number;
  decidedBy?: DecidedBy;
  durationApiMs?: number;
  /** `run`: the result line's `duration_ms` and `duration_api_ms`. */
  durationMs?: number;
  /** `wait.retry.api`: the HTTP status the runner retried on. */
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
  /** `tool.*`: the runner's own figure for the call, when the result carries one. */
  runnerMs?: number;
  /** `wait.retry.*`: the delay the runner or the node announced. The span is the real wait. */
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
  | "runner.other"
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

/** One point of a tile's sparkline: the figure over one slice of the range. */
export type SparkPoint = {
  since: Timestamp;
  /** In the tile's unit. Absent when the slice has nothing to measure (no merges for a median). */
  value?: number;
};

export type SshHost = string;

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

/** `"*"`: every machine. */
export type Star = "*";

/** A project's items per group. Complete: the rows' `items` may stop at a cap; these never do. */
export type StatusCounts = {
  done: number;
  idle: number;
  inReview: number;
  landing: number;
  waitingOnYou: number;
  working: number;
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
  truncated?: boolean;
};

/**
 * Which group a piece of work is in. Each follows from state the hub observed (a task's run, its thread, its PR on
 * the train, an open request), never from an agent's word.
 */
export type KnownStatusGroup = "waiting_on_you" | "in_review" | "working" | "landing" | "idle" | "done";
/** KnownStatusGroup, or a value from a newer hub. */
export type StatusGroup = KnownStatusGroup | (string & {});

/** One piece of a project's work: an agent and its PR, a PR no listed agent wrote, or something waiting on you. */
export type StatusItem = {
  /** When it last moved: its PR's or its agent's latest change, a request's creation. */
  at: Timestamp;
  group: StatusGroup;
  /** Its PR, when it has one: the app opens it in the project's panel when there is no agent. */
  pr?: StatusPr;
  /** The agent that does it: the app opens it in the project's panel. */
  taskId?: TaskId;
  title: string;
  /** What the group alone doesn't say: "CI failed", "usage limit: resumes 14:05", a request's text. */
  why?: string;
};

/** An item's PR. */
export type StatusPr = {
  number: number;
  repo: GitHubRepo;
  url: string;
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

/** Rows of plain-text cells, one per column. */
export type TableBlock = {
  columns: string[];
  rows: string[][];
  title?: string;
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
  /**
   * Where its worktree's branch started, as the node reported at launch; write tasks only, absent before a launch
   * or from an older node.
   */
  base?: WorktreeBase;
  /** `fleetd/<taskId>-<slug>`; write tasks only. */
  branch?: string;
  createdAt: Timestamp;
  endedAt?: Timestamp;
  kind: TaskKind;
  /** M4: its thread hit a usage limit; the task is idle until fleetd sends "continue" at `resumeAt`. */
  parked?: UsageParked;
  /** The files the lead said a writer will change (`spawn_agent` `paths`), matched against later work. */
  paths?: string[];
  /** The PR a review task reviews. Required at spawn for review; absent on older rows (hub-spawned judges). */
  pr?: string;
  /**
   * The threads it ran in before `threadRef`, oldest first: fleetd restarted it fresh (its context filled up, or its
   * thread could not resume), on the same branch and worktree.
   */
  previousThreads?: ThreadRef[];
  /**
   * The profile's name, resolved at spawn: the spawn's, else the hub's default. It keeps the name it ran on through
   * a rename. Rows stored with a model and effort read as `high` (the hub migrates its own).
   */
  profile?: ProfileName;
  projectRef: ProjectRef;
  prompt: string;
  /** A review task spawned with `--qa`. */
  qa?: boolean;
  /** Why it is queued, e.g. "fleet cap: 40 of 40 running". */
  queuedReason?: string;
  /** Set once a run of it died (its node stopped, its process was killed, a stall) and fleetd resumed it or will. */
  recovery?: TaskRecovery;
  /** The project's repo it works in; absent for the project's own directory, and on rows an older hub stored. */
  repoId?: RepoId;
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
  /** On `task.started` for a new worktree: where its branch started. */
  base?: WorktreeBase;
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

/** Every task gets its own worktree: a writer on its own branch, a reader or reviewer detached. */
export type TaskKind = "write" | "read" | "review";

/** A task fleetd resumes on its own after its run died: in the same thread and worktree, with a note to continue. */
export type TaskRecovery = {
  /**
   * Automatic recoveries used of `max`; a resumed run that died again before doing anything counts twice. A node
   * going away never counts here.
   */
  count: number;
  /** How its last run ended. */
  lastCause: RunEnd;
  /** The same, in plain words: "the node on devbox stopped", "the agent was killed by signal 9". */
  lastCauseText: string;
  max: number;
  /** How it goes on. */
  mode?: RecoveryMode;
  /** When the resume goes out; absent once it has. */
  nextAt?: Timestamp;
  /**
   * Resumes after its node went away (stopped, upgraded, crashed, powered off): not the task's doing, so outside
   * `count`, with a high ceiling of its own only so a node that keeps dying can't loop it forever.
   */
  nodeLost?: number;
  /** When the last resume went out. */
  resumedAt?: Timestamp;
  /**
   * What tells one death from another (its cause, exit and last tool); the same one twice is not resumed again.
   * Cleared when the lead continues the task itself.
   */
  signature?: string;
  /** Deaths in a row with this signature, the latest one included. */
  streak: number;
};

export type TaskResult = {
  at: Timestamp;
  branch?: string;
  /**
   * Why its last run ended (the node stopped, the agent exited, a limit, context full, …); absent on results an
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
  /** The model the failure names, when the runner read one off it (a gateway with no account for it). */
  model?: string;
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

/** `thread.orphaned`. */
export type ThreadOrphanedData = {
  /** When the hub first saw it without an owner. */
  since: Timestamp;
  /** The session's title on its node. */
  title: string;
};

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

/** Share of merged work through fleetd, by count. */
export type ThroughFleetdTile = {
  lines: RouteLines[];
  /** `train` + `fleetd_by_hand` over all landed changes. */
  madeByFleetdPct?: number;
  n: number;
  /** `train` over all landed changes; absent when there are none. */
  pct?: number;
  previousPct?: number;
  spark: SparkPoint[];
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
  /** Most agent time first; absent when no task or lead span is in the period. */
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

/**
 * One change to the list: without `id` it adds an item (text required, state todo unless given); with `id` it sets
 * that item's text, state or link, or with `remove` takes it off.
 */
export type TodoEdit = {
  id?: number;
  /** Replaces the item's link; `{}` clears it. */
  link?: TodoLink;
  remove?: boolean;
  state?: TodoState;
  text?: string;
};

export type TodoItem = {
  /** Unique in its project, never reused. */
  id: number;
  link?: TodoLink;
  /** The person who last ticked or changed it (`checklist_edit`); absent when the lead did. */
  person?: PersonRef;
  state: TodoState;
  text: string;
  updatedAt: Timestamp;
};

/** What an item is about, any of: its PR, the agent on it (its task), its workstream. */
export type TodoLink = {
  pr?: GitHubPrUrl;
  taskId?: TaskId;
  workstreamId?: WorkstreamId;
};

export type TodoState = "todo" | "doing" | "done";

/** Summed over the lane's runs. `live`: the running run's usage is streaming in (else it updates at each run's end). */
export type Tokens = {
  cacheRead: number;
  input: number;
  live: boolean;
  output: number;
};

/** What an asking tool would do, for the card's heading and its urgency. */
export type ToolAction = "send" | "write" | "delete" | "share" | "spend";

/**
 * An approval raised by a session's tool permission prompt instead of a gated command: answering it answers the prompt
 * on the project's node. Its machine is the request's project's.
 */
export type ToolPermission = {
  /**
   * The tool's input exactly as the session asked (at most 64 KiB of JSON): approved, the tool runs with exactly
   * this. Absent when the node didn't send it; the tool then runs with what the session asked.
   */
  input?: unknown;
  /**
   * An integration's asking tool (`hub/integrations`): exactly who it reaches and what it says, or what it changes,
   * read from the input it runs with once approved. Boxed: it is large beside the prompt's other fields.
   */
  preview?: ToolPreview;
  requestId: string;
  /**
   * A Navi's first fetch or browser visit to this site (its host, such as `example.com`): approved, the Navi may
   * fetch and open it without asking from then on, until a person revokes it (`navi_site_revoke`).
   */
  site?: string;
  /** The command, the path, or the tool's own description. */
  summary: string;
  threadId: ThreadId;
  toolName: string;
};

/** The hub's policy for one tool. */
export type ToolPolicy = "read" | "ask" | "blocked";

/**
 * What an approval card shows for an asking tool: what it does and everything it gets. The input is the exact one
 * the tool runs with once approved; nothing is a summary the agent wrote.
 */
export type ToolPreview = {
  action: ToolAction;
  /** Everything the tool gets, as JSON. */
  input: string;
  /** The configured server's name, as claude prefixes its tools (`mcp__<server>__<tool>`). */
  server: McpServerName;
  /** What it does, as a verb phrase the app puts after "<the Navi> wants to": "Use create_page on docs". */
  title: string;
  tool: McpToolName;
};

/**
 * The merge train's events: `change.queued`, `change.ready`, `change.needs_rebase`, `change.ci_failed`,
 * `change.refused`, `pr.merged`, `pr.merged_outside`. Which fields each carries is in
 * `HubEventType`'s docs.
 */
export type TrainEventData = {
  /** pr.merged_outside: who opened and who merged it, by the git host's account type. */
  authorKind?: ActorKind;
  /** pr.merged, pr.merged_outside: the branch it merged into. */
  base?: string;
  /** pr.merged: the train's batch PR it landed in. */
  batchPr?: number;
  changeId?: ChangeId;
  /** change.ci_failed: the failing check names. */
  checks?: string[];
  /** pr.merged on a repo with no CI: what fleetd checked instead. */
  ci?: string;
  fix?: string;
  /** pr.merged_outside: the PR's head branch and when it was opened. */
  head?: string;
  logUrl?: string;
  /** pr.merged, pr.merged_outside: when it landed on the git host. */
  mergedAt?: Timestamp;
  /** pr.merged_outside: the merger's login on the git host, so a merge by the person's own account is their touch. */
  mergedBy?: string;
  mergedByKind?: ActorKind;
  mergedSha?: string;
  prCreatedAt?: Timestamp;
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

/**
 * How the merge train treats the checks of the project's repo. It waits only for its fast set: the checks the base
 * branch requires, read from its ruleset or branch protection, plus `fastChecks`, each until it reports, however late
 * it starts. It never waits for any other check; one of those that has already failed when the fast set is green
 * still stops the merge, unless it is in `afterMerge`. A check the base requires is always in the fast set: GitHub
 * won't merge without it. With no required check and none added, it waits for every check. After a merge it watches
 * every check outside the fast set on the merged commit; one that fails there opens a fix order for the project,
 * once per failure.
 */
export type TrainSettings = {
  /** Checks that never stop a merge, even once failed: they only run after it. */
  afterMerge?: string[];
  /** Checks the train waits for besides the required ones. */
  fastChecks?: string[];
};

/** One serial train per repo. */
export type TrainState = {
  /** The Change being rebased, checked or merged now. */
  head?: ChangeId;
  /** Waiting Changes in train order. */
  queue: ChangeId[];
  repo: GitHubRepo;
};

/** The hub, or one machine's node or Claude Code, in an update. */
export type UpdatePart = {
  /** The version it ran when the update started. */
  from: string;
  /** A node's machine. */
  machineId?: MachineId;
  /** One plain sentence: what happened, or why not, with what to do. */
  message?: string;
  /** For a person: "the hub", or the machine's name. */
  name: string;
  part: UpdatePartKind;
  /** Where it failed or was put back. */
  stage?: UpdateStage;
  state: UpdateState;
  /** The version it goes to when not the run's `to`: Claude Code's, the one the new fleetd was tested with. */
  to?: string;
};

export type KnownUpdatePartKind = "hub" | "node" | "claude";
/** KnownUpdatePartKind, or a value from a newer hub. */
export type UpdatePartKind = KnownUpdatePartKind | (string & {});

/** One hub update, from its start to the last node's result. */
export type UpdateRun = {
  channel: HubChannel;
  /** Set once every part has its result. */
  finishedAt?: Timestamp;
  id: string;
  /** The hub first, then per machine, by name, its node and its Claude Code. */
  parts: UpdatePart[];
  startedAt: Timestamp;
  /** The build it updates to: the channel's newest fleetd. Absent until the hub read the channel. */
  to?: string;
};

export type KnownUpdateStage = "download" | "checksum" | "install" | "restart" | "health";
/** KnownUpdateStage, or a value from a newer hub. */
export type UpdateStage = KnownUpdateStage | (string & {});

export type KnownUpdateState = "waiting" | "downloading" | "restarting" | "done" | "current" | "failed" | "rolled_back" | "skipped";
/** KnownUpdateState, or a value from a newer hub. */
export type UpdateState = KnownUpdateState | (string & {});

export type UploadId = string;

/**
 * One Claude account's usage on a machine (teams step 8): a limit on it pauses only the work on it, never the
 * machine's own login or another account's.
 */
export type UsageAccount = {
  account: ClaudeAccount;
  breaker: UsageBreaker;
  parked: ParkedCounts;
};

/**
 * Open: no new turns start on the login (the machine's own, or one account's there) until `until`, or (no reset named) a check or another turn on the
 * login succeeds, or usage_resume.
 */
export type UsageBreaker = {
  /** No reset named: when fleetd next sends one parked thread "continue" to see whether the login has capacity. */
  checkAt?: Timestamp;
  class?: UsageClass;
  /** The plain notice, as the usage.breaker event said it. */
  message?: string;
  /** A proxy in front of the login decided the limit. */
  proxy?: boolean;
  since?: Timestamp;
  state: BreakerState;
  /** The reset the limits named. Absent while open: `check_at`, else until usage_resume (pool_exhausted). */
  until?: Timestamp;
};

/**
 * What stopped a turn. `usage_limit`: the plan's usage limit or a proxy's quota cooldown. `rate_limit`: a 429, or a
 * proxy resting its credentials after one.
 * `pool_exhausted`: the user's proxy has no account for the model; it waits for usage_resume.
 */
export type UsageClass = "usage_limit" | "rate_limit" | "pool_exhausted";

/** Fields `HubEvent.data` carries on usage.breaker and usage.resumed. */
export type UsageEventData = {
  /** The Claude account the pause or resume is about; absent: the machine's own login. */
  account?: ClaudeAccount;
  /** usage.resumed: the breaker was open and is now closed. */
  breakerCleared?: boolean;
  /**
   * usage.resumed: "reset", "check" (fleetd tried one parked thread, or the one it tried completed a turn),
   * "unchecked" (nothing was left parked to try, so the pause lifted for the next turn to try the login), "turn" (a
   * turn on the login succeeded), or who ran usage_resume.
   */
  by?: string;
  /**
   * usage.resumed: a check of an open breaker; the one thread listed is the one tried, and the breaker stays open
   * until its turn completes.
   */
  check?: boolean;
  /** usage.breaker: no reset named, so fleetd checks the login at this time. */
  checkAt?: Timestamp;
  class?: UsageClass;
  model?: string;
  parked?: ParkedCounts;
  /** usage.breaker: a proxy in front of the login decided the limit. */
  proxy?: boolean;
  /** usage.resumed: the threads sent "continue", in the order they were sent. */
  threads?: UsageEventThread[];
  until?: Timestamp;
};

export type UsageEventThread = {
  kind: string;
  taskId?: string;
  threadId: string;
};

/**
 * A task or lead whose thread hit a limit; fleetd sends it one "continue" at `resume_at`, or at `check_at` to see
 * whether the login has capacity again, or (no reset named) as soon as another turn on the login succeeds.
 */
export type UsageParked = {
  /** A limit that named no reset: when fleetd next tries the thread, 1, 2, 5, 10 and then every 15 minutes. */
  checkAt?: Timestamp;
  class: UsageClass;
  /** A proxy in front of the login decided the limit (its credentials for the model are cooling down). */
  proxy?: boolean;
  /**
   * The reset the limit's message named. Absent when it named none (see `check_at`), and for pool_exhausted,
   * which resumes on usage_resume.
   */
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
  /** Each Claude account fleetd has seen work on here, with its own breaker and parked work. */
  accounts?: UsageAccount[];
  breaker: UsageBreaker;
  /** The latest thread.usage_limited, usage.breaker and usage.resumed events for the machine, oldest first. */
  lastEvents: HubEvent[];
  /** The machine's own login; `breaker` and `parked` are its. Work on a Claude account is in `accounts`. */
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

/**
 * How a project's web app is built and run for a preview, each command with `sh -c` in the preview's worktree and
 * the project's variables, as setup commands run (#501).
 */
export type WebPreview = {
  /** Builds the app; none for an app the start command builds itself. */
  build?: string;
  /** Files whose contents decide what setup makes, such as lockfiles. */
  inputs?: SetupInput[];
  /** Asked until it answers, for at most 2 minutes after the start. */
  ready?: ReadyPath;
  /**
   * Run first, in order: install dependencies, generate code. Skipped when `inputs` haven't changed since a
   * preview of this project last ran them on this machine.
   */
  setup?: string[];
  /** Serves the app on `127.0.0.1:$PORT`; it runs until the preview ends. */
  start: string;
};

/** A command, file edit or tool call. Secrets in its summary and output are replaced by `[secret]`. */
export type WorkAction = {
  action: ActionItem;
  at: Timestamp;
  id: string;
};

export type WorkClaimInput = {
  /** A human key only: claim it even though it is taken, with a link to what holds it. */
  anyway?: boolean;
  /** `git config user.email`, for knowing its pushes. */
  authorEmail?: string;
  /** The branch the work lands on. Absent: the project's, else that of a project on the repo, else "main". */
  base?: string;
  /** The branch the work is on. */
  branch?: string;
  /** What the branch has changed so far, against the base and uncommitted. */
  changed?: string[];
  headSha?: CommitSha;
  keys?: WorkKey[];
  /** Ids from a possible_duplicate answer that this work is not. */
  notDuplicateOf?: string[];
  /** Why not: needed with notDuplicateOf, and logged. */
  notDuplicateWhy?: string;
  /** Files or globs it will touch. */
  paths?: string[];
  projectRef?: ProjectRef;
  /**
   * The repo's origin remote, in any form: "git@github.com:acme/shop.git", "https://gitlab.example.com/g/shop",
   * "/srv/git/shop.git". Give it or projectRef.
   */
  repo?: string;
  /** One line: what the change does. */
  title: string;
};

export type WorkClaimOutput = {
  /** Claimed or renewed. */
  claim?: Claim;
  /** Work in flight it may repeat, strongest first. */
  matches: WorkMatch[];
  /** "claimed C7", "taken by T12 (an agent of devbox/shop): dark mode toggle". */
  message: string;
  next?: string;
  status: WorkClaimStatus;
  truncated?: boolean;
  /** No project is bound to the repo yet, so fleetd's agents' work on it may be missing from the matches. */
  warning?: string;
};

export type WorkClaimStatus = "claimed" | "renewed" | "taken" | "possible_duplicate" | "yours";

export type WorkDoneInput = {
  claimId: ClaimId;
  /** Landed: the commit on the base. */
  landing?: CommitSha;
  outcome: WorkDoneOutcome;
  reason?: string;
};

export type WorkDoneOutcome = "landed" | "dropped";

export type WorkDoneOutput = {
  claim: Claim;
  next?: string;
  truncated?: boolean;
};

/** `HubEvent.data` on `work.claimed` and `work.ended`. */
export type WorkEventData = {
  base: string;
  claimId: ClaimId;
  landing?: CommitSha;
  ownerKind: ClaimOwnerKind;
  projectRef?: ProjectRef;
  /** work.ended: why. */
  reason?: string;
  repoKey: RepoKey;
  state: ClaimState;
};

/** One piece of work in flight, from whichever source holds it. */
export type WorkItem = {
  changeId?: ChangeId;
  claimId?: ClaimId;
  /** A claim's: when it expires, or expired. */
  expiresAt?: Timestamp;
  /** "T12", "X4", "C7", "acme/shop#57". */
  id: string;
  keys: WorkKey[];
  kind: WorkItemKind;
  /** A claim's owner. */
  owner?: ClaimOwner;
  /** Declared and observed, deduplicated. */
  paths: string[];
  /** The project whose lead runs it; absent for a claim not tied to one, and for outside PRs. */
  projectRef?: ProjectRef;
  /** When it was made, or a claim last renewed. */
  since: Timestamp;
  /** Its source's own state: a task's ("running"), a Change's ("ci"), a claim's ("active", "expired"). */
  state: string;
  taskId?: TaskId;
  title: string;
};

export type WorkItemKind = "claim" | "task" | "change" | "pr";

/** An id someone chose on purpose; the same key on two pieces of work means the same work. */
export type WorkKey = {
  issue: string;
} | {
  pr: string;
} | {
  branch: string;
};

/**
 * `HubEvent.data` on `work.landed`: a commit that reached a watched base, however it got there, and the fleetd work
 * it was.
 */
export type WorkLandedData = {
  base: string;
  /** The Change it is, or merged. */
  changeId?: ChangeId;
  /** The claims it ended. */
  claimIds: ClaimId[];
  /** The branch it came from, when the merge message or the host names one. */
  headBranch?: string;
  /** The PR or merge request it came from, when the merge message or the host names one. */
  prNumber?: number;
  repoKey: RepoKey;
  route: LandingRoute;
  sha: CommitSha;
  subject: string;
  /** The write task whose work it is: its Change's, or the one whose branch it came from. */
  taskId?: TaskId;
};

export type WorkListInput = {
  base?: string;
  /**
   * false: leave out what each writer has changed so far, which asks its machine; a claim keeps its paths.
   * Default true.
   */
  paths?: boolean;
  projectRef?: ProjectRef;
  /** The repo's origin remote, in any form. Give it or projectRef. */
  repo?: string;
};

export type WorkListOutput = {
  items: WorkItem[];
  next?: string;
  /**
   * Commits that reached the base outside the train (a PR merged by hand, a direct push) in the last 24 h, newest
   * first.
   */
  recentLandings: RecentLanding[];
  scope: WorkScope;
  truncated?: boolean;
  /** No project is bound to the repo yet, so fleetd's agents' work on it may be missing from the items. */
  warning?: string;
};

/** A piece of work in flight that new work may repeat, and why the matcher thinks so. */
export type WorkMatch = {
  item: WorkItem;
  strength: MatchStrength;
  /** "same #42", "3 shared words: dark, mode, toggle; same file app/theme.ts". */
  why: string;
};

/** A message the agent or its person wrote. Secrets are replaced by `[secret]`. */
export type WorkMessage = {
  at: Timestamp;
  id: string;
  role: TailRole;
  /** The last 2000 characters of a longer message. */
  text: string;
};

/** The repo and base branch work lands on: what the in-flight view is read for. */
export type WorkScope = {
  base: string;
  repoKey: RepoKey;
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
  /**
   * The person whose message started it: the writer of the first human message in the lead's turn that opened the
   * order. Absent for an order the lead opened with no person's message in its turn (an automation's, a train fix's,
   * an agent's), and from a hub before people.
   */
  startedBy?: PersonRef;
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

/** Where a writer's worktree branch started: the remote's default branch, freshly fetched unless `error` says why not. */
export type WorktreeBase = {
  error?: BaseError;
  /**
   * When `ref` was last fetched: by this start, else by the one whose copy it fell back to. Absent for a local
   * branch, or when git can't tell.
   */
  fetchedAt?: Timestamp;
  /**
   * A fork (an `upstream` remote beside it) only: the commits upstream's default branch has that `ref` lacks, as
   * last fetched.
   */
  forkBehind?: number;
  /** "origin/main"; a local branch when there is no remote, or no copy of the remote's. */
  ref: string;
  sha: string;
};

/** What runs in each new worktree of a project before its agent starts: install dependencies, generate code. */
export type WorktreeSetup = {
  /**
   * In order, each with `sh -c` in the worktree and the project's variables (the order's too); the first that
   * fails or passes its time limit stops the rest.
   */
  commands?: string[];
  /**
   * Files whose contents decide what setup makes, such as lockfiles. A worktree an earlier agent set up with the
   * same commands, while these held the same contents, is not set up again. None listed: setup always runs.
   */
  inputs?: SetupInput[];
  /**
   * True: a failed setup still starts the agent, which is told what failed. False (the default): the start fails,
   * naming the command and the end of its output.
   */
  runAnyway?: boolean;
  /** Each command's time limit, in seconds. */
  timeoutSec?: number;
};

/**
 * The worktrees one nightly cleanup kept in a project because they hold work that exists nowhere else, as one line
 * that opens to each: what frees it is pushing or deleting that work.
 */
export type WorktreesKept = {
  items: KeptWorktree[];
};

/** Every tool the app can `call`: its input and its output. */
export interface ToolMap {
  actions_list: { input: ActionsListInput; output: ActionsListOutput };
  agent_work: { input: AgentWorkInput; output: AgentWorkOutput };
  agents_list: { input: AgentsListInput; output: AgentsListOutput };
  approval_answer: { input: ApprovalAnswerInput; output: ApprovalAnswerOutput };
  attachment_get: { input: AttachmentGetInput; output: AttachmentGetOutput };
  attachment_part: { input: AttachmentPartInput; output: AttachmentPartOutput };
  attachment_put: { input: AttachmentPutInput; output: AttachmentPutOutput };
  automation_create: { input: AutomationCreateInput; output: AutomationCreateOutput };
  automation_delete: { input: AutomationDeleteInput; output: AutomationDeleteOutput };
  automation_list: { input: AutomationListInput; output: AutomationListOutput };
  automation_pause: { input: AutomationPauseInput; output: AutomationPauseOutput };
  automation_rotate: { input: AutomationRotateInput; output: AutomationRotateOutput };
  automation_run: { input: AutomationRunInput; output: AutomationRunOutput };
  automation_runs: { input: AutomationRunsInput; output: AutomationRunsOutput };
  automation_update: { input: AutomationUpdateInput; output: AutomationUpdateOutput };
  browser_control: { input: BrowserControlInput; output: BrowserControlOutput };
  browser_recording_get: { input: BrowserRecordingGetInput; output: BrowserRecordingGetOutput };
  browser_retention_set: { input: BrowserRetentionSetInput; output: BrowserRetentionSetOutput };
  browser_sessions: { input: BrowserSessionsInput; output: BrowserSessionsOutput };
  cap_set: { input: CapSetInput; output: CapSetOutput };
  changes_list: { input: ChangesListInput; output: ChangesListOutput };
  chat_history: { input: ChatHistoryInput; output: ChatHistoryOutput };
  chat_nudge_clear: { input: ChatNudgeClearInput; output: ChatNudgeClearOutput };
  chat_send: { input: ChatSendInput; output: ChatSendOutput };
  chat_stop: { input: ChatStopInput; output: ChatStopOutput };
  checklist_edit: { input: ChecklistEditInput; output: ChecklistEditOutput };
  checklist_get: { input: ChecklistGetInput; output: ChecklistGetOutput };
  checklist_remove: { input: ChecklistRemoveInput; output: ChecklistRemoveOutput };
  claude_account_test: { input: ClaudeAccountTestInput; output: ClaudeAccountTestOutput };
  claude_accounts_get: { input: ClaudeAccountsGetInput; output: ClaudeAccountsGetOutput };
  claude_choice_set: { input: ClaudeChoiceSetInput; output: ClaudeChoiceSetOutput };
  claude_hub_api_remove: { input: ClaudeHubApiRemoveInput; output: ClaudeHubApiRemoveOutput };
  claude_hub_api_set: { input: ClaudeHubApiSetInput; output: ClaudeHubApiSetOutput };
  claude_settings_set: { input: ClaudeSettingsSetInput; output: ClaudeSettingsSetOutput };
  claude_subscription_remove: { input: ClaudeSubscriptionRemoveInput; output: ClaudeSubscriptionRemoveOutput };
  claude_subscription_set: { input: ClaudeSubscriptionSetInput; output: ClaudeSubscriptionSetOutput };
  decisions_list: { input: DecisionsListInput; output: DecisionsListOutput };
  decisions_overturn: { input: DecisionsOverturnInput; output: DecisionsOverturnOutput };
  decisions_record: { input: DecisionsRecordInput; output: DecisionsRecordOutput };
  decisions_search: { input: DecisionsSearchInput; output: DecisionsSearchOutput };
  device_revoke: { input: DeviceRevokeInput; output: DeviceRevokeOutput };
  doctor_fix: { input: DoctorFixInput; output: DoctorFixOutput };
  doctor_list: { input: DoctorListInput; output: DoctorListOutput };
  events_list: { input: EventsListInput; output: EventsListOutput };
  events_wait: { input: EventsWaitInput; output: EventsWaitOutput };
  fleetd_status: { input: FleetdStatusInput; output: FleetdStatusOutput };
  github_app_create: { input: GithubAppCreateInput; output: GithubAppCreateOutput };
  github_app_get: { input: GithubAppGetInput; output: GithubAppGetOutput };
  github_app_manifest: { input: GithubAppManifestInput; output: GithubAppManifestOutput };
  github_app_remove: { input: GithubAppRemoveInput; output: GithubAppRemoveOutput };
  github_app_test: { input: GithubAppTestInput; output: GithubAppTestOutput };
  github_connect: { input: GithubConnectInput; output: GithubConnectOutput };
  github_disconnect: { input: GithubDisconnectInput; output: GithubDisconnectOutput };
  hub_info: { input: HubInfoInput; output: HubInfoOutput };
  hub_link_add: { input: HubLinkAddInput; output: HubLinkAddOutput };
  hub_link_mint: { input: HubLinkMintInput; output: HubLinkMintOutput };
  hub_link_remove: { input: HubLinkRemoveInput; output: HubLinkRemoveOutput };
  hub_link_revoke: { input: HubLinkRevokeInput; output: HubLinkRevokeOutput };
  hub_links_get: { input: HubLinksGetInput; output: HubLinksGetOutput };
  hub_update: { input: HubUpdateInput; output: HubUpdateOutput };
  hub_update_status: { input: HubUpdateStatusInput; output: HubUpdateOutput };
  invite_create: { input: InviteCreateInput; output: InviteCreateOutput };
  invite_revoke: { input: InviteRevokeInput; output: InviteRevokeOutput };
  lead_start: { input: LeadStartInput; output: LeadStartOutput };
  machine_add: { input: MachineAddInput; output: MachineAddOutput };
  machine_add_plan: { input: MachineAddPlanInput; output: MachineAddPlanOutput };
  machine_add_status: { input: MachineAddStatusInput; output: MachineAddStatusOutput };
  machine_claude_login: { input: MachineClaudeLoginInput; output: MachineClaudeLoginOutput };
  machine_hosts: { input: MachineHostsInput; output: MachineHostsOutput };
  machine_join: { input: MachineJoinInput; output: MachineJoinOutput };
  machine_remove: { input: MachineRemoveInput; output: MachineRemoveOutput };
  machine_roles: { input: MachineRolesInput; output: MachineRolesOutput };
  machine_roles_set: { input: MachineRolesSetInput; output: MachineRolesSetOutput };
  mcp_server_remove: { input: McpServerRemoveInput; output: McpServerRemoveOutput };
  mcp_server_set: { input: McpServerSetInput; output: McpServerSetOutput };
  mcp_server_test: { input: McpServerTestInput; output: McpServerTestOutput };
  mcp_servers_get: { input: McpServersGetInput; output: McpServersGetOutput };
  mcp_settings_set: { input: McpSettingsSetInput; output: McpSettingsSetOutput };
  memory_caps_set: { input: MemoryCapsSetInput; output: MemoryCapsSetOutput };
  memory_get: { input: MemoryGetInput; output: MemoryGetOutput };
  memory_refresh_run: { input: MemoryRefreshRunInput; output: MemoryRefreshRunOutput };
  memory_set: { input: MemorySetInput; output: MemorySetOutput };
  memory_shared_get: { input: MemorySharedGetInput; output: MemorySharedGetOutput };
  memory_shared_set: { input: MemorySharedSetInput; output: MemorySharedSetOutput };
  memory_undo: { input: MemoryUndoInput; output: MemoryUndoOutput };
  metrics_get: { input: MetricsGetInput; output: MetricsGetOutput };
  metrics_retention_set: { input: MetricsRetentionSetInput; output: MetricsRetentionSetOutput };
  navi_archive: { input: NaviArchiveInput; output: NaviArchiveOutput };
  navi_asks: { input: NaviAsksInput; output: NaviAsksOutput };
  navi_create: { input: NaviCreateInput; output: NaviCreateOutput };
  navi_list: { input: NaviListInput; output: NaviListOutput };
  navi_rename: { input: NaviRenameInput; output: NaviRenameOutput };
  navi_signins_forget: { input: NaviSigninsForgetInput; output: NaviSigninsForgetOutput };
  navi_site_revoke: { input: NaviSiteRevokeInput; output: NaviSiteRevokeOutput };
  navi_sites: { input: NaviSitesInput; output: NaviSitesOutput };
  onepassword_get: { input: OnePasswordGetInput; output: OnePasswordGetOutput };
  onepassword_remove: { input: OnePasswordRemoveInput; output: OnePasswordRemoveOutput };
  onepassword_set: { input: OnePasswordSetInput; output: OnePasswordSetOutput };
  onepassword_test: { input: OnePasswordTestInput; output: OnePasswordTestOutput };
  order_get: { input: OrderGetInput; output: OrderGetOutput };
  orders_board: { input: OrdersBoardInput; output: OrdersBoardOutput };
  pair_code_create: { input: PairCodeCreateInput; output: PairCodeCreateOutput };
  people_list: { input: PeopleListInput; output: PeopleListOutput };
  person_remove: { input: PersonRemoveInput; output: PersonRemoveOutput };
  person_set: { input: PersonSetInput; output: PersonSetOutput };
  pr_diff: { input: PrDiffInput; output: PrDiffOutput };
  pr_files: { input: PrFilesInput; output: PrFilesOutput };
  pr_get: { input: PrGetInput; output: PrGetOutput };
  pr_list: { input: PrListInput; output: PrListOutput };
  preview_end: { input: PreviewEndInput; output: PreviewEndOutput };
  preview_feedback: { input: PreviewFeedbackInput; output: PreviewFeedbackOutput };
  preview_start: { input: PreviewStartInput; output: PreviewStartOutput };
  previews_list: { input: PreviewsListInput; output: PreviewsListOutput };
  profile_create: { input: ProfileCreateInput; output: ProfileCreateOutput };
  profile_delete: { input: ProfileDeleteInput; output: ProfileDeleteOutput };
  profile_update: { input: ProfileUpdateInput; output: ProfileUpdateOutput };
  profiles_list: { input: ProfilesListInput; output: ProfilesListOutput };
  project_add: { input: ProjectAddInput; output: ProjectAddOutput };
  project_avatar_get: { input: ProjectAvatarGetInput; output: ProjectAvatarGetOutput };
  project_avatar_set: { input: ProjectAvatarSetInput; output: ProjectAvatarSetOutput };
  project_discover: { input: ProjectDiscoverInput; output: ProjectDiscoverOutput };
  project_env_set: { input: ProjectEnvSetInput; output: ProjectEnvSetOutput };
  project_files: { input: ProjectFilesInput; output: ProjectFilesOutput };
  project_get: { input: ProjectGetInput; output: ProjectGetOutput };
  project_remove: { input: ProjectRemoveInput; output: ProjectRemoveOutput };
  project_repo_add: { input: ProjectRepoAddInput; output: ProjectRepoAddOutput };
  project_repo_list: { input: ProjectRepoListInput; output: ProjectRepoListOutput };
  project_repo_remove: { input: ProjectRepoRemoveInput; output: ProjectRepoRemoveOutput };
  project_set: { input: ProjectSetInput; output: ProjectSetOutput };
  project_settings_get: { input: ProjectSettingsGetInput; output: ProjectSettingsGetOutput };
  project_settings_set: { input: ProjectSettingsSetInput; output: ProjectSettingsSetOutput };
  project_stop: { input: ProjectStopInput; output: ProjectStopOutput };
  prompt_get: { input: PromptGetInput; output: PromptGetOutput };
  prompt_set: { input: PromptSetInput; output: PromptSetOutput };
  push_badge: { input: PushBadgeInput; output: PushBadgeOutput };
  push_device_register: { input: PushDeviceRegisterInput; output: PushDeviceRegisterOutput };
  push_device_remove: { input: PushDeviceRemoveInput; output: PushDeviceRemoveOutput };
  push_devices_list: { input: PushDevicesListInput; output: PushDevicesListOutput };
  push_relay_set: { input: PushRelaySetInput; output: PushRelaySetOutput };
  requests_list: { input: RequestsListInput; output: RequestsListOutput };
  secret_submit: { input: SecretSubmitInput; output: SecretSubmitOutput };
  session_prompt_get: { input: SessionPromptGetInput; output: SessionPromptGetOutput };
  setup_list: { input: SetupListInput; output: SetupListOutput };
  setup_skip: { input: SetupSkipInput; output: SetupSkipOutput };
  setup_test: { input: SetupTestInput; output: SetupTestOutput };
  skill_delete: { input: SkillDeleteInput; output: SkillDeleteOutput };
  skill_get: { input: SkillGetInput; output: SkillGetOutput };
  skill_install: { input: SkillInstallInput; output: SkillInstallOutput };
  skill_set: { input: SkillSetInput; output: SkillSetOutput };
  skill_update: { input: SkillUpdateInput; output: SkillUpdateOutput };
  skills_list: { input: SkillsListInput; output: SkillsListOutput };
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
  work_claim: { input: WorkClaimInput; output: WorkClaimOutput };
  work_done: { input: WorkDoneInput; output: WorkDoneOutput };
  work_list: { input: WorkListInput; output: WorkListOutput };
  workstream_list: { input: WorkstreamListInput; output: WorkstreamListOutput };
}

/** `HubEvent.data` by event type, for the types whose data has a declared shape. */
export interface HubEventDataMap {
  "agents.cap": AgentsCapData;
  "app.presence": AppPresenceData;
  "browser.session": BrowserSessionEventData;
  "change.ci_failed": TrainEventData;
  "change.needs_rebase": TrainEventData;
  "change.queued": TrainEventData;
  "change.ready": TrainEventData;
  "change.refused": TrainEventData;
  "change.state": ChangeStateData;
  "chat.message": ChatMessageEventData;
  "chat.waiting": ProjectChatState;
  "checklist.changed": ChecklistChangedData;
  "ci.main": CiMainData;
  "machine.guard": MachineGuardData;
  "machine.recovery_paused": RecoveryPausedData;
  "machine.slept": MachineSleptData;
  "machine_add.step": MachineAddStepData;
  "people.changed": PeopleChangedData;
  "pr.merged": TrainEventData;
  "pr.merged_outside": TrainEventData;
  "preview.state": PreviewEventData;
  "project.add_failed": ProjectAddFailedData;
  "project.added": ProjectAddedData;
  "project.clone_progress": CloneProgressData;
  "project.fetch_failed": FetchFailedData;
  "prompt.changed": PromptChangedData;
  "repo.advanced": RepoAdvancedData;
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
  "thread.orphaned": ThreadOrphanedData;
  "thread.started": ThreadEventData;
  "thread.usage_limited": UsageEventData;
  "thread.waiting": ThreadEventData;
  "usage.breaker": UsageEventData;
  "usage.resumed": UsageEventData;
  "work.claimed": WorkEventData;
  "work.ended": WorkEventData;
  "work.landed": WorkLandedData;
  "workstream.created": WorkstreamEventData;
  "workstream.done": WorkstreamEventData;
  "workstream.running": WorkstreamEventData;
  "workstream.state": WorkstreamEventData;
}
