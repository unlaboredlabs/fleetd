// What approvals reaches outside its own table (crates/fleetd/src/hub/approvals/mod.rs `ApprovalNodes`,
// `ApprovalHub`; the real hub's side is usage/wire_approvals.rs). Nodes go over the node link; the rest is the hub's
// store, or a hook (D348) the area that owns it sets: project leads', orders' and intake's are T2246's, automations' T2255's.
import type { Clock } from "../../shared/clock.ts";
import type {
  Automation,
  CheckerNote,
  HubEvent,
  HumanRequest,
  McpServer,
  ProjectApprovals,
  PersonRef,
  ProjectRef,
  RequestState,
  ToolPreview,
} from "../../shared/contracts.ts";
import type { NewRequest, RequestFilter } from "./request.ts";

/** A node command's failure: "offline", "lost", "no_reply", "invalid", "not_found", "old" or "failed". */
export class NodeCommandError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "NodeCommandError";
  }
}

export type SecretOutcome = { fingerprint?: string; error?: string };

export type GatedOutcome = {
  exitCode?: number;
  outputTail: string;
  timedOut: boolean;
  error?: string;
  /** Only from `resumeGated`: why the node has no result for it either. The command may have run. */
  unknown?: string;
};

/** A session's answer to a tool prompt (fleetd-contracts sessions.rs `PermissionDecision`, tagged by `behavior`). */
export type PermissionDecision = { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string };
export type DecidedBy = "lead" | "human" | "policy" | "hub_rule";

/** The prompt a thread's run waits on (sessions.rs `PendingPermission`); `input` absent when over 64 KiB. */
export type PendingPermission = { requestId: string; toolName: string; summary: string; input?: unknown };

/** The node link's request/reply commands approvals sends. Every failure is a `NodeCommandError`. */
export interface ApprovalNodes {
  /** `secret_deliver`: `{ sink, sealed, secretKey, envName?, projectId?, requestId? }`. */
  deliverSecret(machineId: string, input: Record<string, unknown>): Promise<SecretOutcome>;
  /** `gated_run`: `{ argv, cwd, timeoutSec, secretEnv?, requestId }`. */
  runGated(machineId: string, input: Record<string, unknown>): Promise<GatedOutcome>;
  /** `gated_resume`: the result of the approved command the node ran, whose `gated_run` answer was lost. */
  resumeGated(machineId: string, requestId: string, timeoutSec: number): Promise<GatedOutcome>;
  /** The machine's node is linked and its session stream subscribed. */
  isLinked(machineId: string): Promise<boolean>;
  /** `session_call answer`: the decision for the prompt `requestId` the thread's run waits on. */
  answerPermission(
    machineId: string,
    threadId: string,
    requestId: string,
    decision: PermissionDecision,
    by?: DecidedBy,
  ): Promise<void>;
  /** The prompt the thread's run waits on now, with its input. */
  pendingPermission(machineId: string, threadId: string): Promise<PendingPermission | undefined>;
}

/** A variable a node saved for one order's agents. */
export type OrderEnvSaved = {
  project: ProjectRef;
  orderId: string;
  name: string;
  fingerprint: string;
  bytes: number;
  requestId: string;
};

/** One of a lead's actions the approval step judges (hub/project_lead/checker.rs `Action`). */
export type Action = { tool: string; summary: string; input: unknown; preview?: ToolPreview; site?: string };

/** The checker's answer: a plain public read passes on its rule; anything else is its note. */
export type Checked = { publicRead: true } | { note: CheckerNote };

/** The person who approved a proposed project, whose it becomes: their key's name and person. */
export type ProposalApprover = { name: string; person?: PersonRef };

/** The hub policy's first word on a prompt (integrations policy, a project's confirm step, its bridge, automation confirm). */
export type PromptVerdict = { allow: true } | { deny: string } | { ask: ToolPreview };

/**
 * The hooks other areas fill (D348), each with a safe default until they do: order checks refuse, and every
 * prompt files a card for the person.
 */
export type ApprovalHooks = {
  /** Why the project's order can't take a variable now; undefined when it can (projects/order_env.rs `refusal`). */
  orderRefusal(project: ProjectRef, orderId: string): Promise<string | undefined>;
  /** Records a variable a node saved for an order; a string is why it could not (order_env.rs `saved`). */
  orderEnvSaved(saved: OrderEnvSaved, at: string): Promise<string | undefined>;
  /** Whether the thread is the project's lead, the one session the tool prompt relay answers. */
  isLead(project: ProjectRef, threadId: string): Promise<boolean>;
  /** Whether the project's lead may open `site` without asking (false with no site); undefined when unread. */
  siteAllowed(project: ProjectRef, site: string | undefined): Promise<boolean | undefined>;
  /** A person approved a first visit to `site`: from now on it opens without asking. */
  allowSite(project: ProjectRef, site: string, by: string): Promise<void>;
  /** The project's own automation `id`, for `automation_confirm`'s card. */
  ownAutomation(project: ProjectRef, id: string): Promise<Automation | undefined>;
  /** The person approved `automation_confirm`'s card showing `shown`: whether the automation is marked confirmed. */
  automationConfirm(project: ProjectRef, shown: unknown, by: string): Promise<boolean>;
  /** The card for a lead's `project_propose`: exactly what approving it makes, or why the proposal is refused. */
  projectProposal(project: ProjectRef, input: unknown): Promise<PromptVerdict>;
  /**
   * A person approved `project_propose`'s card showing `shown`: the project is made here, as theirs. A string is why
   * it was not made; `requestId` keeps a card approved twice (its answer undelivered) from making two.
   */
  projectProposed(project: ProjectRef, shown: unknown, by: ProposalApprover, requestId: string): Promise<string | undefined>;
  /** Whether `id` is an image of the project's own (`chat_file`); if so it becomes the project's, for its card. */
  ownImage(project: ProjectRef, id: string): Promise<boolean>;
  /** How the project's risky actions are approved; undefined when unread. */
  approvalSettings(project: ProjectRef): Promise<ProjectApprovals | undefined>;
  /** The checker's verdict on one of the lead's actions (project_lead/checker.rs `judge`). */
  checkAction(project: ProjectRef, threadId: string, action: Action, settings: ProjectApprovals): Promise<Checked>;
  /** An action ran without asking: an entry in the project's auto-approved log (checker.rs `auto_approved`). */
  autoApproved(project: ProjectRef, action: Action, by: "checker" | "yolo", reason?: string): Promise<void>;
  /**
   * The project's rules on a prompt the integrations policy had no word on (project_lead confirm.rs `refused`/`preview`,
   * automations calls.rs `confirm_preview`, project_lead bridge.rs `preview`); undefined: no rule, so the approval mode decides.
   */
  promptVerdict(
    project: ProjectRef,
    tool: string,
    input: unknown,
    servers: McpServer[],
    automation: Automation | undefined,
  ): PromptVerdict | undefined;
  /** A fetch or browser visit (project_lead/sites.rs `visit`): its host, `null` for one it can't tell; undefined: no visit. */
  siteVisit(tool: string, input: unknown): string | null | undefined;
  /** The floors every mode keeps (project_lead/review.rs `floor`): why `shown` (the input with its `tool`) is refused. */
  floor(shown: Record<string, unknown>): string | undefined;
  /** A visit whose link carries data (project_lead/review.rs `visit_url` + `carries_data`). */
  visitCarriesData(input: unknown): boolean;
  /** A shell command YOLO still refuses (project_lead/shell_guard.rs `refused`). */
  shellRefused(command: string): string | undefined;
  /** An action the checker never judges (project_lead/checker.rs `always_asks`). */
  alwaysAsks(action: Action): boolean;
  /** The key a new secret request's value is sealed to (the vault's: the hub's own); undefined: the sink machine's. */
  vaultSealTo(): string | undefined;
  /**
   * A secret sealed to the hub's key, kept in the vault and delivered from there: the node's fingerprint and the size.
   * Undefined for one sealed to the sink machine's key, which goes the old way.
   */
  vaultSecret(request: HumanRequest, sealed: string, by: { name: string; person?: PersonRef; machines: string[] }): Promise<{ fingerprint: string; bytes: number } | undefined>;
};

export const NOT_PORTED_ORDERS = "The Bun hub can't set an order's variable yet (src/hub/projects: order_env).";

/** The hooks before their areas set them: order variables refused, project reads unknown, every prompt asks. */
export const defaultHooks = (): ApprovalHooks => ({
  orderRefusal: async () => NOT_PORTED_ORDERS,
  orderEnvSaved: async () => NOT_PORTED_ORDERS,
  isLead: async () => false,
  siteAllowed: async () => undefined,
  allowSite: async () => {},
  ownAutomation: async () => undefined,
  automationConfirm: async () => false,
  projectProposal: async () => ({ deny: "Blocked by fleetd: this hub can't put a new project on a card yet." }),
  projectProposed: async () => "this hub can't create a project from a card yet",
  ownImage: async () => false,
  approvalSettings: async () => undefined,
  checkAction: async () => ({ note: { verdict: "ask", reason: "the approval checker isn't ported to the Bun hub yet" } }),
  autoApproved: async () => {},
  promptVerdict: () => undefined,
  siteVisit: () => undefined,
  floor: () => undefined,
  visitCarriesData: () => false,
  shellRefused: () => undefined,
  alwaysAsks: () => false,
  vaultSealTo: () => undefined,
  vaultSecret: async () => undefined,
});

/** The rest of the hub approvals reads or wakes, over the hub's own store. */
export interface ApprovalHub {
  /** The machine's `boxPubKey`: undefined for no machine, null for one that takes no secrets. */
  boxKey(machineId: string): Promise<string | null | undefined>;
  /** The project's workspace root; undefined when the hub has no record of it. */
  workspaceRoot(project: ProjectRef): Promise<string | undefined>;
  /** Wakes the project's lead with a request's outcome (one event line). */
  wakeRequest(request: HumanRequest): Promise<void>;
  /** The MCP servers the project's sessions are configured from, for the integrations policy. */
  mcpServers(project: ProjectRef): Promise<McpServer[]>;
}

/** The event log approvals appends to and follows (src/hub/store/events.ts). */
export interface ApprovalEvents {
  append(event: Omit<HubEvent, "seq">): unknown;
  head(): number;
  wait(
    input: { cursor?: number; types?: string[]; timeoutSec: number },
    signal?: AbortSignal,
  ): Promise<{ events: HubEvent[]; cursor: number }>;
}

/**
 * What the tool prompt relay (permissions.ts) reaches of approvals: the hub's `Approvals` is one, and another server
 * may hold its own over its store. Every request read and write is synchronous.
 */
export interface PromptApprovals {
  readonly deps: {
    hooks: ApprovalHooks;
    hub: Pick<ApprovalHub, "mcpServers" | "wakeRequest">;
    nodes: Pick<ApprovalNodes, "answerPermission" | "pendingPermission">;
    clock: Clock;
    events: ApprovalEvents;
    signal?: AbortSignal;
  };
  /** The prompts a project's checker is judging now (machine, thread, prompt): each is judged once. */
  readonly checking: Set<string>;
  /** Called whenever a checker's verdict landed. */
  readonly idle: Set<() => void>;
  now(): string;
  /** Every request in `states` of `kind`, or none when the store fails. */
  listQuiet(filter: Omit<RequestFilter, "limit">): HumanRequest[];
  /** Opens a request and announces it. */
  create(add: NewRequest): HumanRequest;
  /** Saves a change to a request while it is still `from`, and announces it; a request no longer `from` throws. */
  changeFrom(id: string, from: RequestState, f: (r: HumanRequest) => void): HumanRequest;
  /** An approved request back to open, with why. */
  reopen(id: string, why: string): HumanRequest;
  /** Records `evidence` on a request. */
  note(id: string, evidence: string): HumanRequest;
  /** Runs `f`, logging instead of throwing: a background step's write that may lose to another. */
  quietly<T>(f: () => T): T | undefined;
}
