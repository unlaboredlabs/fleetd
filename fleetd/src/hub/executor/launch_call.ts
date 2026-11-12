// A session's launch as the node gets it, without the hub (sessions.ts reads what goes in it and sends it): the
// launch's input and options, a project's tool rules, a profile as an older node reads it, and the call itself.
import type { ClaudeAccount, Effort, MachineId, PersonId, WorktreeSetup } from "../../shared/contracts.ts";
import type {
  McpAgentRole,
  McpSessionConfig,
  RuntimeMode,
  SessionLaunch,
  SessionRole,
  SessionWorkspace,
  SkillBundle,
} from "../../shared/sessions.ts";
import type { Chosen } from "../projects/chosen.ts";
import { uuidFrom } from "./ids.ts";

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

/** What a project's policy file says about its sessions' claude: `tools.allow` and `tools.deny`. */
export type SessionRules = { allow: string[]; deny: string[] };

/** What a node from before named profiles reads: `high` or `medium`, an effort it knows, no fast mode. */
export const oldNodeLaunch = (c: Chosen): Chosen => ({
  ...c,
  profile: c.profile === "medium" ? "medium" : "high",
  effort: c.effort === "xhigh" ? "high" : c.effort,
  fast: false,
});

/** What a launch read before it builds its call: the title, runner, profile, tool rules, skills, MCP servers and prompts. */
export type LaunchGot = {
  title: string;
  runner: SessionLaunch["runner"];
  chosen?: Chosen;
  rules: SessionRules;
  skills: SkillBundle[];
  mcp?: McpSessionConfig;
  prompt: string;
  systemPrompt?: string;
};

/** The node's `launch` call (`session_start`) for `input` on `m`, from what the launch read (`got`). */
export function launchCall(m: MachineId, input: LaunchInput, options: LaunchOptions, got: LaunchGot): SessionLaunch {
  const { title, runner, chosen, rules, skills, mcp, prompt, systemPrompt } = got;
  const seed = `${m}\n${input.clientRequestId}`;
  const sessionId = uuidFrom(`session\n${seed}`);
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
  return call;
}
