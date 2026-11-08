// Node sessions: how the hub drives the agent sessions `fleetd node` runs, over the node link. A typed mirror of
// crates/fleetd-contracts/src/sessions.rs and the session-side frames of node_link.rs (D346), with the same names
// and the same serde shapes: internally tagged enums are unions on their tag (`op`, `type`, `kind`), a newtype
// variant's fields sit beside its tag, `Option` fields are optional, and `#[serde(default)]` fields may be absent.
// Those Rust types aren't rendered to the TypeScript contracts, so this file is kept by hand: change it with
// sessions.rs, never apart from it. The hub's executor, the link and the node all import from here.
import type {
  AttachmentMime,
  BoxPublicKey,
  ClaudeAccount,
  ClaudeEndpoint,
  ClonePhase,
  DecidedBy,
  DeliveredHow,
  Effort,
  EnvValue,
  EnvVarName,
  EnvVarSet,
  McpRoles,
  McpServerName,
  McpTestResult,
  McpTransport,
  McpValueName,
  OnePasswordCard,
  PersonId,
  ProfileName,
  ProjectId,
  ProjectWorktrees,
  SealedSecret,
  SecretFingerprint,
  SkillName,
  SkillOrigin,
  SteerId,
  SteerStage,
  ThreadId,
  Timestamp,
  WorkstreamId,
  WorktreeSetup,
} from "./contracts.ts";

// ---- Types sessions.rs uses from other contract modules that the rendered contracts don't carry. ----

/** model.rs `RuntimeMode`, kebab-case. */
export type RuntimeMode = "full-access" | "approval-required";

/** steer.rs `SteerTag`: the steer a send carries, and the ones riding along with it. */
export type SteerTag = { id: SteerId; riders?: SteerId[] };

/** steer.rs `SteerReceipt`: a steer's receipt moved. */
export type SteerReceipt = {
  sessionId: ThreadId;
  runId: string;
  steerId: SteerId;
  stage: SteerStage;
  at: Timestamp;
  how?: DeliveredHow;
  stoppedTool?: string;
  seenAt?: Timestamp;
  messageId?: string;
  excerpt?: string;
  reason?: string;
};

/** mcp_servers.rs `McpAgentRole`. */
export type McpAgentRole = "lead" | "writer" | "reviewer";

/** mcp_servers.rs `McpField`. */
export type McpField = "env" | "header";

/** mcp_servers.rs `McpSecretScope`. */
export type McpSecretScope = { kind: "global" } | { kind: "project"; projectId: ProjectId };

/** mcp_servers.rs `McpSecretSet`. */
export type McpSecretSet = { field: McpField; name: McpValueName; sealed: SealedSecret };

/** mcp_servers.rs `McpSecretKey`. */
export type McpSecretKey = { field: McpField; name: McpValueName };

/** mcp_servers.rs `McpSecretSaved`. */
export type McpSecretSaved = { field: McpField; name: McpValueName; fingerprint: SecretFingerprint };

/** mcp_servers.rs `McpSessionValue`. */
export type McpSessionValue = { kind: "plain"; name: McpValueName; value: EnvValue } | { kind: "secret"; name: McpValueName };

/** mcp_servers.rs `McpSessionServer`. */
export type McpSessionServer = {
  name: McpServerName;
  secrets: McpSecretScope;
  roles: McpRoles;
  transport: McpTransport;
  env?: McpSessionValue[];
  headers?: McpSessionValue[];
};

/** mcp_servers.rs `McpSessionConfig`. */
export type McpSessionConfig = { userServers: boolean; servers?: McpSessionServer[] };

/** skills.rs `SkillFile`. */
export type SkillFile = { path: string; text: string };

/** skills.rs `SkillBundle`. */
export type SkillBundle = { name: SkillName; origin: SkillOrigin; files: SkillFile[] };

/** skills.rs `RepoSkill`. */
export type RepoSkill = { name: SkillName; origin: SkillOrigin; description: string; path: string };

/** claude_accounts.rs `ClaudeSecretSet`. */
export type ClaudeSecretSet = { sealed?: SealedSecret; endpoint?: ClaudeEndpoint };

/** project_settings.rs `EnvSecretSaved`. */
export type EnvSecretSaved = { name: EnvVarName; fingerprint: SecretFingerprint };

// ---- sessions.rs ----

/** Which agent runtime runs a session. */
export type RunnerKind = "claude";

/** Where a session works. */
export type SessionWorkspace =
  /** The project's workspace root (leads). */
  | { type: "root" }
  /** A new git worktree on a new branch, one per writer. `fromSession`: a session of the same branch this one takes over. */
  | { type: "worktree"; baseRef: string; branch: string; fromSession?: ThreadId }
  /** A detached worktree of its own, for a read or review task: at a fresh fetch of `baseRef`, or `pr`'s head. */
  | { type: "detached"; baseRef: string; pr?: string; head?: string };

/** A session's place among fleetd's agents, which decides the MCP tools it gets. */
export type SessionRole = "plain" | "lead" | "worker" | "assistant";

/** Hub -> node: start a session and its first run. Idempotent on `sessionId`. */
export type SessionLaunch = {
  sessionId: ThreadId;
  projectId: ProjectId;
  title?: string;
  runner?: RunnerKind;
  profile?: ProfileName;
  model?: string;
  effort?: Effort;
  fast?: boolean;
  helperModel?: string;
  runtimeMode: RuntimeMode;
  workspace: SessionWorkspace;
  /** The first user message. */
  prompt: string;
  /** The session's standing rules; only nodes listing CAP_SYSTEM_PROMPT get it. */
  systemPrompt?: string;
  /** The first run's id. */
  runId: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  allowedOnly?: boolean;
  role?: SessionRole;
  mcpRole?: McpAgentRole;
  mcp?: McpSessionConfig;
  skills?: SkillBundle[];
  orderId?: WorkstreamId;
  setup?: WorktreeSetup;
  claudeAccount?: ClaudeAccount;
  onepassword?: PersonId;
  isolated?: boolean;
};

/** A person's or policy's answer to a tool permission prompt. */
export type PermissionDecision = { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string };

/** How a send reaches a session whose turn is running. */
export type SendMode = "plain" | "boundary" | "now";

/** Hub -> node operations (sessions.rs `SessionCall`), tagged by `op`. */
export type SessionCall =
  | { op: "project_upsert"; projectId: ProjectId; title: string; workspaceRoot: string }
  | { op: "project_remove"; projectId: ProjectId; removeWorktrees?: boolean; erase?: boolean; removeFolder?: boolean }
  | { op: "project_env"; projectId: ProjectId; set: EnvVarSet[]; remove: EnvVarName[] }
  | { op: "project_env_copy"; from: ProjectId; to: ProjectId }
  | { op: "mcp_secrets"; scope: McpSecretScope; server: McpServerName; set?: McpSecretSet[]; keep?: McpSecretKey[] }
  | { op: "mcp_test"; projectId?: ProjectId; server: McpSessionServer }
  | { op: "navi_signins_forget"; projectId: ProjectId }
  | { op: "order_env_drop"; projectId: ProjectId; orderId: WorkstreamId; name?: EnvVarName; fingerprint?: SecretFingerprint }
  | { op: "claude_account_secret"; account: ClaudeAccount; set?: ClaudeSecretSet }
  | { op: "claude_account_reseal"; account: ClaudeAccount; to: BoxPublicKey }
  | { op: "claude_account_test"; account: ClaudeAccount }
  | { op: "onepassword_token"; personId: PersonId; sealed?: SealedSecret }
  | { op: "onepassword_test"; personId: PersonId }
  | { op: "onepassword_cards"; personId: PersonId; projectId?: ProjectId }
  | { op: "claude_models" }
  | { op: "project_worktrees"; projectId: ProjectId }
  | ({ op: "launch" } & SessionLaunch)
  | {
      op: "send";
      sessionId: ThreadId;
      runId: string;
      text: string;
      mode?: SendMode;
      steer?: SteerTag;
      mcp?: McpSessionConfig;
      skills?: SkillBundle[];
    }
  | { op: "withdraw"; sessionId: ThreadId; runId: string }
  | { op: "interrupt"; sessionId: ThreadId; runId?: string; reason?: string }
  | { op: "stop"; sessionId: ThreadId; removeWorktree?: boolean }
  | { op: "answer"; sessionId: ThreadId; requestId: string; decision: PermissionDecision; by?: DecidedBy }
  | { op: "subscribe"; after?: number; spansAfter?: number; caughtUp?: boolean }
  | { op: "follow"; sessionId: ThreadId }
  | { op: "release"; sessionId: ThreadId }
  | { op: "window"; sessionId: ThreadId; itemId: string; before: number; after: number }
  | { op: "read_item"; sessionId: ThreadId; itemId: string }
  | { op: "read_file"; projectId: ProjectId; path: string }
  | { op: "default_branch"; projectId: ProjectId }
  | { op: "changes"; sessionId: ThreadId }
  | { op: "runner_info" }
  | { op: "list_files"; projectId: ProjectId; query?: string; limit: number }
  | { op: "repo_scan" }
  | { op: "repo_inspect"; path: string }
  | { op: "repo_clone"; addId: string; url: string; dest: string; token?: SealedSecret }
  | { op: "folder_make"; path: string; gitInit?: boolean; dryRun?: boolean }
  | { op: "gh_repo_list" }
  | { op: "landed_log"; projectId: ProjectId; branch: string; sinceMs: number; stopAt?: string }
  | { op: "skills_list"; projectId: ProjectId }
  | { op: "put_file"; projectId: ProjectId; relPath: string; dataB64: string }
  | { op: "has_file"; projectId: ProjectId; relPath: string; sha256: string }
  | { op: "read_image"; sessionId: ThreadId; path: string; offset?: number; file?: boolean };

export type SessionCallOp = SessionCall["op"];

/** The most of an image one `read_image` reply carries, decoded. */
export const IMAGE_PIECE_BYTES = 8 * 1024 * 1024;

/** node_link.rs `HubToNode::SessionCall`'s body. */
export type SessionCallFrame = { id: string; call: SessionCall };

/** How a SessionError's message starts when the node won't resume the session. */
export const RESUME_REFUSED = "the session can't resume: ";
/** How a relative `project_upsert`'s refusal starts when the folder is another project's. */
export const FOLDER_TAKEN = "folder taken: ";
/** How a `folder_make`'s refusal starts when the folder holds something. */
export const FOLDER_NOT_EMPTY = "folder not empty: ";

/** Why a call failed. */
export type SessionErrorCode = "not_found" | "invalid" | "runner_unavailable" | "git" | "internal";

export type SessionError = { code: SessionErrorCode; message: string; fix?: string };

/** claude's answer to a `send_now` interrupt. */
export type SendNow = "stopped" | "delivering" | "nothing_waiting";

export type SendAccepted = { runId: string; queued: boolean; sendNow?: SendNow };

export type SessionChanges = { branch?: string; worktreePath?: string; paths: string[] };

/** One session's bounded window: what `thread_tail` and `actions_list` read. */
export type ThreadSnapshot = {
  summary: SessionSummary;
  messages: ThreadMessage[];
  items: ThreadItem[];
  runs: RunInfo[];
  truncated: boolean;
};

export type LoginStatus = "logged_in" | "logged_out" | "unknown";

/** What a Navi's OS sandbox is on a machine, in a person's words. */
export type SandboxStatus = "ready" | "gap" | "missing";
export type NaviSandbox = { status: SandboxStatus; line: string; fix?: string };

export type RunnerInfo = {
  runner: RunnerKind;
  version?: string;
  supported: string;
  versionOk: boolean;
  login: LoginStatus;
  loginKind?: string;
  conformanceOk?: boolean;
  problem?: string;
  loginLabel?: string;
  proxy?: string;
  proxySource?: string;
  configDir?: string;
  selfUpdate?: boolean;
  sandbox?: NaviSandbox;
  accountOverrides?: string[];
};

export type BaseErrorKind = "offline" | "auth" | "no_access" | "no_ssh" | "no_default_branch" | "no_remote" | "failed";
export type BaseError = { kind: BaseErrorKind; message: string };

/** Where a writer's worktree branch started. `ref` is Rust's `base_ref`. */
export type WorktreeBase = { ref: string; sha: string; fetchedAt?: Timestamp; error?: BaseError; forkBehind?: number };

export type ApiModel = { id: string; displayName?: string };

/** One commit on the default branch's own line. */
export type GitCommit = {
  sha: string;
  parents: string[];
  atMs: number;
  authorName: string;
  subject: string;
  changes?: string[];
  tasks?: string[];
  mergedTasks?: string[];
};

/** The default branch's first-parent line, newest first, at most LANDED_LOG_MAX commits. */
export type LandedLog = { read: string; fetchFailed?: string; commits: GitCommit[] };
export const LANDED_LOG_MAX = 5000;

export type ScannedRepo = { path: string; remote?: string };
export type RepoFacts = { exists: boolean; isGit: boolean; remote?: string; defaultBranch?: string; workflowFiles?: string[] };
export type GhRepo = { nameWithOwner: string; url: string; isPrivate?: boolean; description?: string; pushedAt?: string };
export type GhRepos = { owners: string[]; repos: GhRepo[]; problem?: string };

/** What a call answers (sessions.rs `SessionOutput`), tagged by `kind`. */
export type SessionOutput =
  | { kind: "done" }
  | { kind: "folder"; path: string }
  | { kind: "launched"; summary: SessionSummary; base?: WorktreeBase }
  | ({ kind: "sent" } & SendAccepted)
  | ({ kind: "snapshot" } & ThreadSnapshot)
  | { kind: "item"; item: ThreadItem }
  | { kind: "file"; contents?: string }
  | { kind: "default_branch"; branch?: string }
  | ({ kind: "changes" } & SessionChanges)
  | ({ kind: "runner_info" } & RunnerInfo)
  | { kind: "window"; entries: WindowEntry[]; focus?: number }
  | { kind: "withdrawn"; cancelled: boolean }
  | { kind: "has_file"; has: boolean }
  | { kind: "files"; paths: string[]; truncated: boolean }
  | { kind: "repos"; cloneRoot: string; repos: ScannedRepo[]; projectsRoot?: string }
  | ({ kind: "repo_facts" } & RepoFacts)
  | ({ kind: "gh_repos" } & GhRepos)
  | ({ kind: "landed_log" } & LandedLog)
  | { kind: "project_env"; secrets: EnvSecretSaved[] }
  | ({ kind: "project_worktrees" } & ProjectWorktrees)
  | { kind: "mcp_secrets"; secrets: McpSecretSaved[] }
  | ({ kind: "mcp_tested" } & McpTestResult)
  | { kind: "claude_account_saved"; fingerprint?: SecretFingerprint }
  | { kind: "claude_account_resealed"; sealed?: SealedSecret }
  | { kind: "claude_account_tested"; ok: boolean; error?: string }
  | { kind: "onepassword_saved"; fingerprint?: SecretFingerprint }
  | { kind: "onepassword_tested"; vaults?: string[]; error?: string }
  | { kind: "onepassword_carded"; cards?: OnePasswordCard[]; error?: string }
  | { kind: "claude_models"; models: ApiModel[]; error?: string }
  | { kind: "skills"; skills: RepoSkill[] }
  | { kind: "image"; name: string; mime: AttachmentMime; bytes: number; dataB64: string };

export type SessionOutputKind = SessionOutput["kind"];

/** Node -> hub while a `repo_clone` runs: git's progress for one clone. */
export type CloneProgressFrame = { addId: string; phase: ClonePhase; percent?: number; detail?: string };

/**
 * `window`'s entries. Rust's `WindowEntry` is tagged by `kind`, and `WindowEntry::Item(ThreadItem)` puts that tag
 * beside the item's own `kind` field, so serde writes both: `{"kind":"item",…,"kind":{"type":"command",…}}`.
 * `JSON.parse` keeps the last, so an item entry arrives as a plain ThreadItem whose `kind` is its ItemKind object;
 * a message entry's `kind` is the string "message". Tell them apart with `isWindowItem`.
 */
export type WindowEntry = ThreadItem | ({ kind: "message" } & ThreadMessage);

export const isWindowItem = (entry: WindowEntry): entry is ThreadItem => typeof entry.kind === "object";

/** sessions.rs `SessionResult`, externally tagged. */
export type SessionResult = { ok: SessionOutput } | { err: SessionError };

/** node_link.rs `NodeToHub::SessionReply`'s body: the answer to the call with the same `id`. */
export type SessionReplyFrame = { id: string; result: SessionResult };

/** fleetd's failure taxonomy for a run. */
export type FailureClass =
  | "usage_limit"
  | "rate_limit"
  | "pool_exhausted"
  | "auth"
  | "overloaded"
  | "network"
  | "invalid_request"
  | "process_exited"
  | "other";

export type RunFailure = {
  class: FailureClass;
  message: string;
  apiStatus?: number;
  resetAt?: Timestamp;
  retries?: number;
  model?: string;
};

export type RunStatus = "queued" | "starting" | "running" | "waiting" | "completed" | "failed" | "interrupted";

/** `RunStatus::is_active`. */
export const runActive = (s: RunStatus) => s === "queued" || s === "starting" || s === "running" || s === "waiting";

/** Why a run ended; a cause this build doesn't know reads as any other string (Rust's `Unknown`). */
export type RunEnd =
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
  | "stalled"
  | (string & {});

/** A run's tokens; the cache fields keep the first runner's wire names. */
export type RunUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd?: number;
};

export type RunInfo = {
  id: string;
  status: RunStatus;
  /** 1-based position in the session. */
  ordinal: number;
  queuedAt?: Timestamp;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
  failure?: RunFailure;
  usage?: RunUsage;
  supersededBy?: string;
  end?: RunEnd;
  endedBy?: string;
};

export type SessionStatus = "idle" | "running" | "waiting" | "failed" | "interrupted";

export type PendingPermission = { requestId: string; toolName: string; summary: string; input?: unknown };

/** The most a PendingPermission's input carries, in bytes of JSON. */
export const PENDING_INPUT_MAX = 64 * 1024;

/** Where a lost worktree came back from; one this build doesn't know reads as any other string. */
export type WorktreeSource = "local" | "remote" | "base" | (string & {});

/** One session's row on the machine stream: what the hub's shell mapper turns into a ThreadSummary. */
export type SessionSummary = {
  sessionId: ThreadId;
  projectId: ProjectId;
  title: string;
  status: SessionStatus;
  model: string;
  effort: Effort;
  modelRefused?: string;
  runtimeMode: RuntimeMode;
  latestRun?: RunInfo;
  activeRunId?: string;
  pendingPermission?: PendingPermission;
  /** The last assistant text, cut to its last 2000 characters. */
  latestAssistantTail?: string;
  branch?: string;
  worktreePath?: string;
  recreatedFrom?: WorktreeSource;
  recreatedAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ProjectInfo = { projectId: ProjectId; title: string; workspaceRoot: string; updatedAt: Timestamp };

/** The machine stream (sessions.rs `MachineEvent`), tagged by `type`. */
export type MachineEvent =
  /** Everything current: replaces the hub's view of this machine. */
  | { type: "snapshot"; projects: ProjectInfo[]; sessions: SessionSummary[] }
  | ({ type: "project_upserted" } & ProjectInfo)
  | { type: "project_removed"; projectId: ProjectId }
  | ({ type: "session_updated" } & SessionSummary)
  | ({ type: "runner_info" } & RunnerInfo)
  | ({ type: "steer" } & SteerReceipt)
  /** Everything before it on this subscription is out. */
  | { type: "caught_up" };

export type MachineEventFrame = { seq: number; at: Timestamp; event: MachineEvent };

export type MessageRole = "user" | "assistant";

export type ThreadMessage = { id: string; runId?: string; role: MessageRole; text: string; createdAt: Timestamp };

export type ItemStatus = "running" | "completed" | "failed" | "cancelled";

/** What a tool call does, in fleetd's words, tagged by `type`. */
export type ToolClass =
  | { type: "read"; path?: string }
  | { type: "search"; pattern?: string }
  | { type: "web"; url?: string; query?: string }
  | { type: "plan" }
  | { type: "mcp"; server: string; tool: string };

/** What a run did, one tool call or event per item, tagged by `type`. */
export type ItemKind =
  | { type: "command"; command: string; timeoutMs?: number; output?: string; outputOmitted?: boolean; exitCode?: number }
  | { type: "file_change"; toolName: string; path: string }
  | { type: "tool"; toolName: string; input: unknown; output?: string; outputOmitted?: boolean; class?: ToolClass }
  | { type: "permission"; requestId: string; toolName: string; summary: string; decision?: PermissionDecision }
  | { type: "compaction"; trigger: string; preTokens?: number; postTokens?: number }
  | { type: "api_retry"; attempt: number; maxRetries: number; errorStatus?: number; error: string; retryDelayMs?: number }
  | { type: "node_retry"; attempt: number; of: number; delayMs: number; reason: RunFailure }
  | { type: "error"; failure: RunFailure };

export type ThreadItem = {
  /** The tool_use id, or a node-minted id for non-tool items. */
  id: string;
  runId?: string;
  status: ItemStatus;
  title: string;
  startedAt: Timestamp;
  completedAt?: Timestamp;
  updatedAt: Timestamp;
  kind: ItemKind;
};

/** One followed session's stream (sessions.rs `ThreadEvent`), tagged by `type`. */
export type ThreadEvent =
  | ({ type: "snapshot" } & ThreadSnapshot)
  | ({ type: "message" } & ThreadMessage)
  | ({ type: "item" } & ThreadItem)
  | ({ type: "run" } & RunInfo)
  /** Live assistant text, coalesced; not stored, not replayed. */
  | { type: "delta"; messageId: string; runId?: string; append: string }
  /** The active run's usage so far, cumulative; not stored, not replayed. */
  | { type: "usage"; runId: string; usage: RunUsage };

export type ThreadEventFrame = { sessionId: ThreadId; at: Timestamp; event: ThreadEvent };
