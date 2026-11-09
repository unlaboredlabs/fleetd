// The executor's session calls (`send`, `send_with`, `withdraw`,
// `answer`, `interrupt`, `interrupt_now`, `runner_info`, `runner_refusal`, and the run reads the tasks area uses).
import type { ClaudeAccount, DecidedBy, Effort, MachineId, PersonId, ProjectRef, ThreadRef, WorktreeSetup } from "../../shared/contracts.ts";
import { CAP_PROFILE_NAMES, CAP_SYSTEM_PROMPT } from "../../shared/node_link.ts";
import type {
  McpAgentRole,
  McpSessionConfig,
  PermissionDecision,
  RunnerInfo,
  RuntimeMode,
  SendMode,
  SessionLaunch,
  SessionRole,
  SessionWorkspace,
  SkillBundle,
  WorktreeBase,
} from "../../shared/sessions.ts";
import { jsPrefix } from "../../shared/text.ts";
import type { Hub } from "../api/hub.ts";
import { accounts } from "../claude_accounts/tools.ts";
import { launchRules } from "../integrations/policy.ts";
import { link } from "../link/server.ts";
import { mcpServers } from "../mcp_servers/index.ts";
import { type Chosen, profiles } from "../projects/profiles.ts";
import * as repos from "../repos/store.ts";
import { Skills } from "../skills/index.ts";
import { ExecutorError, executors, LAUNCH_TIMEOUT_MS, READ_TIMEOUT_MS, uuidFrom } from "./index.ts";
import { fromThread } from "./shell_mapper.ts";

export type LaunchInput = {
  projectId: string;
  prompt: string;
  /** The session's standing rules, kept out of `prompt` so a compaction never summarizes them. */
  systemPrompt?: string;
  /** The profile's name; one gone since runs on the default. */
  profile: string;
  runtimeMode: RuntimeMode;
  title?: string;
  /** The session and run ids derive from it, so a retried launch returns the same thread. */
  clientRequestId: string;
};

export type LaunchOptions = {
  /** Default: the project root. */
  workspace?: SessionWorkspace;
  role?: SessionRole;
  mcpRole?: McpAgentRole;
  orderId?: string;
  setup?: WorktreeSetup;
  /** These tools and no other, in place of the project's own allow rules. */
  onlyTools?: string[];
  /** These MCP servers instead of `mcpRole`'s, kept for the thread's life. */
  mcp?: McpSessionConfig;
  claudeAccount?: ClaudeAccount;
  onepassword?: PersonId;
  isolated?: boolean;
  /** This model and effort in place of the profile's. */
  model?: [string, Effort];
};

export type SendOpts = { mode?: SendMode; steer?: string; riders?: string[] };
export type SendOutcome = { runId?: string; queued: boolean };

/** What a project's policy file says about its sessions' claude: `tools.allow` and `tools.deny`. */
export type SessionRules = { allow: string[]; deny: string[] };

/**
 * The project policy file's tool rules (hub/policy `Policies::get(r).tools`), set by the policy area when it starts;
 * until then a launch carries no project rules (D355: no import names a module not written yet).
 */
export const found: {
  toolRules?: (hub: Hub, r: ProjectRef) => Promise<SessionRules>;
  /** The vault's variables brought up to date on the machine before a launch (src/hub/vault/loops.ts sets it). */
  beforeLaunch?: (r: ProjectRef, order: string | undefined) => Promise<void>;
  /** The vault's `inject` audit row for a launch (src/hub/vault/loops.ts sets it). */
  injected?: (r: ProjectRef, order: string | undefined, threadId: string) => void;
} = {};

/** Per thread (`machine/thread`): its project and a digest of what it last got, so a send carries only changes. */
type Sent = { mcp: Map<string, [string, string]>; mcpFixed: Set<string>; skills: Map<string, [string, string]> };
const sent = (hub: Hub): Sent => hub.area("executor_sent", () => ({ mcp: new Map(), mcpFixed: new Set(), skills: new Map() }));
const digest = (v: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(v) ?? "").digest("hex");
const threadKey = (r: ThreadRef) => `${r.machineId}/${r.threadId}`;

/** Whether the machine's node lists a capability, unless it is known to lack it. */
const nodeCan = (hub: Hub, m: MachineId, cap: string) => !link(hub).lacks(m, cap);

/** Why the machine's runner can't take sessions, or undefined when it can (logged in). */
export function runnerProblem(info: RunnerInfo): string | undefined {
  if (info.login === "logged_in") return undefined;
  return info.problem ?? "Claude Code is not logged in on this machine";
}

/** What to run on the machine for a runner problem: a login, or the tested runner. */
export function runnerFix(info: RunnerInfo, machineId: string): string {
  return info.login === "logged_out"
    ? `On ${machineId}: ${info.proxy !== undefined ? "set the gateway's token claude uses" : "run claude and /login"}.`
    : `On ${machineId}: install the tested Claude Code (fleetd doctor says which).`;
}

/** The node's runner: version, login and conformance. */
export async function runnerInfo(hub: Hub, m: MachineId): Promise<RunnerInfo> {
  const out = await executors(hub).call(m, "read", { op: "runner_info" }, READ_TIMEOUT_MS);
  if (out.kind !== "runner_info") throw ExecutorError.failed(m, "read", "the node sent no runner info");
  const { kind: _kind, ...info } = out;
  executors(hub).rememberRunner(m, info);
  return info;
}

/** The runner's last reported problem as a refusal, with the fix to run on the machine. */
export function runnerRefusal(hub: Hub, m: MachineId, operation: "launch" | "send"): ExecutorError | undefined {
  const info = executors(hub).cachedRunner(m);
  if (!info) return undefined;
  const problem = runnerProblem(info);
  return problem === undefined ? undefined : ExecutorError.failed(m, operation, problem, runnerFix(info, m));
}

/** What a node from before named profiles reads: `high` or `medium`, an effort it knows, no fast mode. */
const oldNodeLaunch = (c: Chosen): Chosen => ({
  ...c,
  profile: c.profile === "medium" ? "medium" : "high",
  effort: c.effort === "xhigh" ? "high" : c.effort,
  fast: false,
});

function mcpConfig(hub: Hub, r: ProjectRef): McpSessionConfig | undefined {
  try {
    return mcpServers(hub).sessionConfig(r) as McpSessionConfig;
  } catch (error) {
    console.warn(`MCP servers of ${r.projectId} not read: ${(error as Error).message}`);
    return undefined;
  }
}

/** The hub skills a launch in the node project carries: the checkout's holders' first (W79), then its own. */
export function skillBundles(hub: Hub, r: ProjectRef): SkillBundle[] {
  const holders = repos.holders(hub.db.conn, r).map((h) => h.project);
  try {
    return Skills.of(hub).bundlesIn([...holders, r]) as SkillBundle[];
  } catch (error) {
    console.warn(`skills of ${r.projectId} not read: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Launches a session and its first run. No new session goes to a runner the node says can't run it; on a Claude
 * account, only a runner that can't run at all refuses.
 */
export async function launch(hub: Hub, m: MachineId, input: LaunchInput, options: LaunchOptions = {}): Promise<{ threadId: string; base?: WorktreeBase }> {
  const ex = executors(hub);
  if (!ex.cachedRunner(m)) {
    try {
      await runnerInfo(hub, m);
    } catch {}
  }
  const refused = runnerRefusal(hub, m, "launch");
  const cached = ex.cachedRunner(m);
  if (refused && (options.claudeAccount === undefined || !cached || cached.login !== "logged_out" || cached.conformanceOk !== true)) throw refused;
  const runner = cached?.runner ?? "claude";
  const title = input.title?.trim() ? input.title.trim() : jsPrefix(input.prompt.trim().split("\n")[0] ?? "", 80);
  const r = { machineId: m, projectId: input.projectId };
  let rules: SessionRules = { allow: [], deny: [] };
  if (found.toolRules) {
    try {
      rules = await found.toolRules(hub, r);
    } catch (error) {
      throw ExecutorError.failed(m, "launch", `the project's policy file was not read: ${(error as Error).message}`);
    }
  }
  let chosen: Chosen | undefined;
  try {
    chosen = profiles(hub).chosen(input.profile);
  } catch {
    console.warn(`the profiles were not read; the runner's own runs (${input.profile})`);
  }
  // A lead never asks for its integrations' reads, and never gets a tool the blocked list refuses.
  if (options.role === "lead" || options.role === "assistant") {
    try {
      const integrations = launchRules(mcpServers(hub).serversFor(r));
      rules = { allow: [...rules.allow, ...integrations.allowed], deny: [...rules.deny, ...integrations.disallowed] };
    } catch (error) {
      console.warn(`a lead's integration rules not read: ${(error as Error).message}`);
    }
  }
  const skills = skillBundles(hub, r);
  if (chosen && !nodeCan(hub, m, CAP_PROFILE_NAMES)) chosen = oldNodeLaunch(chosen);
  const system = input.systemPrompt?.trimEnd();
  let systemPrompt: string | undefined;
  let prompt = input.prompt;
  if (system) {
    if (nodeCan(hub, m, CAP_SYSTEM_PROMPT)) systemPrompt = system;
    else prompt = `${system}\n\n${input.prompt}`;
  }
  if (prompt === "") throw ExecutorError.failed(m, "launch", "the prompt is empty");
  const seed = `${m}\n${input.clientRequestId}`;
  const sessionId = uuidFrom(`session\n${seed}`);
  const mcp = options.mcp ?? (options.mcpRole !== undefined ? mcpConfig(hub, r) : undefined);
  const model = options.model?.[0] ?? chosen?.model;
  const effort = options.model?.[1] ?? chosen?.effort;
  const call: SessionLaunch = {
    sessionId,
    projectId: input.projectId,
    title,
    runner,
    profile: chosen?.profile ?? input.profile,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(chosen?.fast ? { fast: true } : {}),
    ...(chosen?.helperModel !== undefined ? { helperModel: chosen.helperModel } : {}),
    runtimeMode: input.runtimeMode,
    workspace: options.workspace ?? { type: "root" },
    prompt,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    runId: uuidFrom(`run\n${seed}`),
    allowedTools: options.onlyTools ?? rules.allow,
    disallowedTools: rules.deny,
    ...(options.onlyTools !== undefined ? { allowedOnly: true } : {}),
    role: options.role ?? "plain",
    ...(options.mcpRole !== undefined ? { mcpRole: options.mcpRole } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(options.orderId !== undefined ? { orderId: options.orderId } : {}),
    ...(options.setup !== undefined ? { setup: options.setup } : {}),
    ...(options.claudeAccount !== undefined ? { claudeAccount: options.claudeAccount } : {}),
    ...(options.onepassword !== undefined ? { onepassword: options.onepassword } : {}),
    ...(options.isolated ? { isolated: true } : {}),
  };
  // Recorded before the session runs, so its first limit already counts against its account.
  if (options.claudeAccount !== undefined) {
    try {
      accounts(hub).setThreadAccount(m, sessionId, options.claudeAccount);
    } catch (error) {
      throw ExecutorError.failed(m, "launch", `the thread's Claude account was not recorded: ${(error as Error).message}`);
    }
  }
  // A new order's first sessions start with its person's variables: delivered now, not at the next sweep.
  try {
    await found.beforeLaunch?.(r, options.orderId);
  } catch (error) {
    console.warn(`vault: variables not brought up to date before a launch: ${(error as Error).message}`);
  }
  const out = await ex.callPatient(m, "launch", { op: "launch", ...call }, LAUNCH_TIMEOUT_MS);
  const key = `${m}/${sessionId}`;
  const s = sent(hub);
  if (mcp !== undefined) s.mcp.set(key, [input.projectId, digest(mcp)]);
  if (options.mcp !== undefined) s.mcpFixed.add(key);
  s.skills.set(key, [input.projectId, digest(skills)]);
  try {
    found.injected?.(r, options.orderId, sessionId);
  } catch (error) {
    console.warn(`vault: a launch's inject row not written: ${(error as Error).message}`);
  }
  return { threadId: sessionId, ...(out.kind === "launched" && out.base ? { base: out.base } : {}) };
}

/** The node run id a send with this request id gets. */
export const sendRunId = (r: ThreadRef, clientRequestId: string) => uuidFrom(`send\n${r.machineId}\n${r.threadId}\n${clientRequestId}`);

/** The thread's project, from what it last got or its summary. */
function projectOfThread(hub: Hub, r: ThreadRef, last: [string, string] | undefined): string | undefined {
  if (last) return last[0];
  const tracked = executors(hub).tracked(r);
  if (tracked) return tracked.summary.projectId;
  const stored = hub.db.conn.query<{ data: string }, [string, string]>("SELECT data FROM threads WHERE machine_id = ? AND thread_id = ?").get(r.machineId, r.threadId);
  return stored ? fromThread(JSON.parse(stored.data)).projectId : undefined;
}

/** The thread's MCP servers when they differ from what it last got, and what to record once the send went. */
function changedMcp(hub: Hub, r: ThreadRef): [McpSessionConfig | undefined, [string, string] | undefined] {
  const key = threadKey(r);
  const s = sent(hub);
  if (s.mcpFixed.has(key)) return [undefined, undefined];
  const last = s.mcp.get(key);
  const project = projectOfThread(hub, r, last);
  if (project === undefined) return [undefined, undefined];
  const config = mcpConfig(hub, { machineId: r.machineId, projectId: project });
  if (!config) return [undefined, undefined];
  const d = digest(config);
  return last?.[1] === d ? [undefined, undefined] : [config, [project, d]];
}

/** The thread's hub skills when they differ from what it last got. */
function changedSkills(hub: Hub, r: ThreadRef): [SkillBundle[] | undefined, [string, string] | undefined] {
  const s = sent(hub);
  const last = s.skills.get(threadKey(r));
  const project = projectOfThread(hub, r, last);
  if (project === undefined) return [undefined, undefined];
  const bundles = skillBundles(hub, { machineId: r.machineId, projectId: project });
  const d = digest(bundles);
  return last?.[1] === d ? [undefined, undefined] : [bundles, [project, d]];
}

/** Why the lead of an archived project takes no turn (repos/mod.rs `archived_lead`, `archived_note`). */
function archivedLead(hub: Hub, r: ThreadRef): [string, string] | undefined {
  const lead = hub.db.conn.query<{ project_id: string }, [string, string]>("SELECT project_id FROM leads WHERE machine_id = ? AND thread_id = ?").get(r.machineId, r.threadId);
  if (!lead) return undefined;
  const held = repos.holders(hub.db.conn, { machineId: r.machineId, projectId: lead.project_id })[0];
  if (!held) return undefined;
  return [
    `This project is archived: its directory is repo ${held.repo.name} of project ${held.project.projectId} on ${held.project.machineId}.`,
    "Write to that project's lead instead; project_repo_remove takes the repo out of it and brings this project back.",
  ];
}

export function sendWith(hub: Hub, r: ThreadRef, message: string, clientRequestId: string, opts: SendOpts = {}): Promise<SendOutcome> {
  return sendWithin(hub, r, message, clientRequestId, opts, true);
}

/**
 * A plain send that waits at most READ_TIMEOUT_MS for the node, never PATIENCE_MS (executor `send_brief`): for a caller
 * that holds a lock others wait on.
 */
export const sendBrief = (hub: Hub, r: ThreadRef, message: string, clientRequestId: string) =>
  sendWithin(hub, r, message, clientRequestId, {}, false);

/** A send, `patient`: again and again while a busy node doesn't answer (`callPatient`); else once, as `call`. */
async function sendWithin(
  hub: Hub,
  r: ThreadRef,
  message: string,
  clientRequestId: string,
  opts: SendOpts,
  patient: boolean,
): Promise<SendOutcome> {
  // Every turn of every lead goes through here: an archived project's lead takes none (W79).
  const archived = archivedLead(hub, r);
  if (archived) throw ExecutorError.failed(r.machineId, "send", archived[0], archived[1]);
  const runId = sendRunId(r, clientRequestId);
  if (message === "") throw ExecutorError.failed(r.machineId, "send", "the message is empty");
  const [mcp, mcpSent] = changedMcp(hub, r);
  const [skills, skillsNow] = changedSkills(hub, r);
  // A busy node may take a while to take it: a patient send goes again until it answers (the node dedupes on runId).
  const ex = executors(hub);
  const out = await (patient ? ex.callPatient.bind(ex) : ex.call.bind(ex))(
    r.machineId,
    "send",
    {
      op: "send",
      sessionId: r.threadId,
      runId,
      text: message,
      ...(opts.mode !== undefined && opts.mode !== "plain" ? { mode: opts.mode } : {}),
      ...(opts.steer !== undefined ? { steer: { id: opts.steer, ...(opts.riders?.length ? { riders: opts.riders } : {}) } } : {}),
      ...(mcp ? { mcp } : {}),
      ...(skills ? { skills } : {}),
    },
    READ_TIMEOUT_MS,
  );
  const s = sent(hub);
  if (mcpSent) s.mcp.set(threadKey(r), mcpSent);
  if (skillsNow) s.skills.set(threadKey(r), skillsNow);
  return out.kind === "sent" ? { runId: out.runId, queued: out.queued } : { runId, queued: false };
}

export const send = (hub: Hub, r: ThreadRef, message: string, clientRequestId: string) => sendWith(hub, r, message, clientRequestId);

/** Withdraws a send the thread's claude still holds queued; false once it was taken in. */
export async function withdraw(hub: Hub, r: ThreadRef, runId: string): Promise<boolean> {
  const out = await executors(hub).call(r.machineId, "send", { op: "withdraw", sessionId: r.threadId, runId }, READ_TIMEOUT_MS);
  return out.kind === "withdrawn" && out.cancelled;
}

/** Answers the permission prompt the thread's run waits on. */
export async function answer(hub: Hub, r: ThreadRef, requestId: string, decision: PermissionDecision, by?: DecidedBy): Promise<void> {
  if (requestId === "") throw ExecutorError.failed(r.machineId, "answer", "the request id is empty");
  await executors(hub).call(
    r.machineId,
    "answer",
    { op: "answer", sessionId: r.threadId, requestId, decision, ...(by !== undefined ? { by } : {}) },
    READ_TIMEOUT_MS,
  );
}

/** The prompt the thread's run waits on now, from the machine stream. */
export const pendingPermission = (hub: Hub, r: ThreadRef) => executors(hub).tracked(r)?.pending;

/** Interrupts the thread's active run; known idle is nothing to interrupt, unknown is the node's to decide. */
export async function interrupt(hub: Hub, r: ThreadRef): Promise<void> {
  const tracked = executors(hub).tracked(r);
  if (tracked && tracked.activeRunId === undefined) return;
  await executors(hub).call(
    r.machineId,
    "interrupt",
    { op: "interrupt", sessionId: r.threadId, ...(tracked?.activeRunId !== undefined ? { runId: tracked.activeRunId } : {}), reason: "interrupted through fleetd" },
    READ_TIMEOUT_MS,
  );
}

/** The session's latest run as last seen; undefined for an unknown thread. */
export function latestRun(hub: Hub, r: ThreadRef): { runId?: string; running: boolean } | undefined {
  const t = executors(hub).tracked(r);
  if (!t) return undefined;
  const runId = t.activeRunId ?? t.runId ?? undefined;
  return { ...(runId ? { runId } : {}), running: t.summary.status === "running" };
}

/**
 * The run the session is on as last seen: its active run once it has started, else its latest run. Undefined while
 * the active run is still queued or starting, or for an unknown thread.
 */
export function startedRun(hub: Hub, r: ThreadRef): string | undefined {
  const t = executors(hub).tracked(r);
  if (!t) return undefined;
  if (t.activeRunId !== undefined) return t.activeRunStarting ? undefined : t.activeRunId;
  return t.runId ?? undefined;
}
