// claude's launch for a session, wherever it runs (this machine, or a box: ../place/hosted.ts): the tools fleetd keeps
// from each role, the argv and the environment it starts with. Box side (docs/CONTRIBUTING.md "The package"): what reads
// this machine (the installed claude, its config dir, the probe) is ./claude.ts, so a service with no node launches a
// box's claude exactly as the node does.
import type { Effort } from "../../shared/contracts.ts";
import {
  AGENT_DISALLOWED_WHY, DEFAULT_ENV_WHY, DISALLOWED_WHY, items, LEAD_ALLOWED_WHY, LEAD_ASK_WHY, LEAD_DISALLOWED_WHY, LEAD_ENV_WHY,
  NESTING_VARS_WHY, pairs, PROMPT_CACHE_TTL_WHY, SESSION_ENV_WHY, SUBAGENTS_OFF_ENV_WHY, SUBAGENTS_ON_ENV_WHY, TASK_DISALLOWED_WHY,
  WORKER_ENV_WHY,
} from "./claude/explained.ts";
import type { RuntimeMode, SessionRole } from "../sessions/types.ts";

type Env = Record<string, string>;

/** Every profile's own model (guide.rs MODEL). */
export const MODEL = "claude-opus-5-5";

/** A profile's own model and effort: `medium` at effort medium and any other at high. */
export const profileModel = (profile: string): { model: string; effort: Effort } => ({ model: MODEL, effort: profile === "medium" ? "medium" : "high" });
/** The profile of a model and effort stored before profiles. */
export const profileOf = (model: string, effort: Effort) => (model === MODEL && effort === "medium" ? "medium" : "high");

/** Tools no fleetd session gets, then the Bash rules against a nested claude. */
export const ALWAYS_DISALLOWED = items(DISALLOWED_WHY);
const AGENT_DISALLOWED = items(AGENT_DISALLOWED_WHY);
const TASK_DISALLOWED = items(TASK_DISALLOWED_WHY);
const LEAD_DISALLOWED = items(LEAD_DISALLOWED_WHY);

export function roleDisallowed(role: SessionRole): string[] {
  switch (role) {
    case "plain":
      return [];
    case "worker":
      return [...AGENT_DISALLOWED, ...TASK_DISALLOWED];
    case "assistant":
      return AGENT_DISALLOWED;
    case "lead":
      return [...AGENT_DISALLOWED, ...LEAD_DISALLOWED];
  }
}

const LEAD_ALLOWED = items(LEAD_ALLOWED_WHY);
const LEAD_ASK = items(LEAD_ASK_WHY);
const manualLead = (role: SessionRole, mode: RuntimeMode) => (role === "lead" || role === "assistant") && mode === "approval-required";
export const roleAllowed = (role: SessionRole, mode: RuntimeMode) => (manualLead(role, mode) ? LEAD_ALLOWED : []);
export const roleAsk = (role: SessionRole, mode: RuntimeMode) => (manualLead(role, mode) ? LEAD_ASK : []);

export const SUBAGENTS_OFF_ENV = pairs(SUBAGENTS_OFF_ENV_WHY);
const SUBAGENTS_ON_ENV = items(SUBAGENTS_ON_ENV_WHY);
export const subagentsOffSettingsEnv = (): Record<string, string> => ({
  ...Object.fromEntries(SUBAGENTS_OFF_ENV),
  ...Object.fromEntries(SUBAGENTS_ON_ENV.map((k) => [k, ""])),
});

export const ORDER_ENV_FILE_ENV = "CLAUDE_ENV_FILE";
export const AUTO_MEMORY_OFF_ENV: [string, string] = ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"];
export const AUTO_MEMORY_OFF_SETTINGS = '{"autoMemoryEnabled":false}';
export const HEAVY_LSP_PLUGINS = [
  "rust-analyzer-lsp@claude-plugins-official",
  "clangd-lsp@claude-plugins-official",
  "jdtls-lsp@claude-plugins-official",
  "kotlin-lsp@claude-plugins-official",
];
export const heavyLspOn = (env: Env) => env.HEAVY_LANGUAGE_SERVERS?.trim() === "1";
export const DEFAULT_ENV = pairs(DEFAULT_ENV_WHY);
export const WORKER_ENV = pairs(WORKER_ENV_WHY);
export const LEAD_ENV = pairs(LEAD_ENV_WHY);
export const roleEnv = (role: SessionRole, env: Env): Env =>
  role === "worker"
    ? Object.fromEntries(WORKER_ENV.filter(([k]) => !(k in env)))
    : role === "lead" || role === "assistant"
      ? Object.fromEntries(LEAD_ENV)
      : {};
export const PROMPT_CACHE_TTL_VARS = ["CLAUDE_CODE_PROMPT_CACHE_TTL", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL"];
export const defaultCacheTtl = (role: SessionRole) => PROMPT_CACHE_TTL_WHY.find(([[r]]) => r === role)?.[0][1] ?? "1h";
const NESTING_VARS = items(NESTING_VARS_WHY);
export const HELPER_MODEL_ENV = "ANTHROPIC_DEFAULT_HAIKU_MODEL";
export const SESSION_ENV = pairs(SESSION_ENV_WHY);
export const FLEETD_ENV_SOURCE = "FLEETD_ENV_SOURCE";
export const SESSION_MARKER = "FLEETD_RUNNER_SESSION";

/** Everything a start (or resume) of one session's claude needs (runner/mod.rs `SessionSpec`). */
export type SessionSpec = {
  sessionId: string;
  resume: boolean;
  mustResume: boolean;
  cwd: string;
  addDirs: string[];
  model: string;
  effort: Effort;
  helperModel: string;
  runtimeMode: RuntimeMode;
  allowedTools: string[];
  allowedOnly: boolean;
  systemPrompt?: string;
  disallowedTools: string[];
  mcpConfig?: string;
  strictMcp: boolean;
  settings?: string;
  pluginDirs: string[];
  env: Env;
  hostDir?: string;
  isolated: boolean;
};

/** The runtime tools `--tools` names: the tool of each rule, MCP tools excepted. */
export function runtimeTools(rules: string[]): string[] {
  const tools: string[] = [];
  for (const rule of rules) {
    const name = (rule.split("(")[0] ?? "").trim();
    if (name && !name.startsWith("mcp__") && !tools.includes(name)) tools.push(name);
  }
  return tools;
}

export function disallowedTools(extra: string[]): string[] {
  const tools = [...ALWAYS_DISALLOWED];
  for (const t of extra) if (!tools.includes(t)) tools.push(t);
  return tools;
}

/** claude's argv for a session (ClaudeRunner::args). */
export function args(spec: SessionSpec): string[] {
  const a = [
    "-p", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json", "--include-partial-messages",
    "--model", spec.model, "--effort", spec.effort, "--thinking", "adaptive", "--thinking-display", "summarized",
    spec.resume ? "--resume" : "--session-id", spec.sessionId,
    "--permission-prompt-tool", "stdio",
    "--permission-mode", spec.allowedOnly || spec.runtimeMode === "approval-required" ? "manual" : "bypassPermissions",
  ];
  if (spec.allowedOnly) a.push("--tools", runtimeTools(spec.allowedTools).join(","));
  if (spec.allowedTools.length) a.push("--allowedTools", ...spec.allowedTools);
  a.push("--disallowedTools", ...disallowedTools(spec.disallowedTools));
  if (spec.mcpConfig) {
    a.push("--mcp-config", spec.mcpConfig);
    if (spec.strictMcp) a.push("--strict-mcp-config");
  }
  if (spec.settings) a.push("--settings", spec.settings);
  if (spec.systemPrompt) a.push("--append-system-prompt-file", spec.systemPrompt);
  a.push("--setting-sources", spec.isolated ? "user" : "user,project,local");
  for (const dir of spec.addDirs) a.push("--add-dir", dir);
  for (const dir of spec.pluginDirs) a.push("--plugin-dir", dir);
  return a;
}

/** The environment claude starts with: `env` without the variables fleetd sets or keeps from it, then fleetd's. */
export function spawnEnv(spec: SessionSpec, marker: string): Env {
  const set = new Set([...NESTING_VARS, ...SUBAGENTS_ON_ENV, SESSION_MARKER, FLEETD_ENV_SOURCE, HELPER_MODEL_ENV, ...SESSION_ENV.map(([k]) => k)]);
  const env: Env = {};
  for (const [k, v] of Object.entries(spec.env)) if (!set.has(k)) env[k] = v;
  for (const [k, v] of SUBAGENTS_OFF_ENV) env[k] = v;
  env[HELPER_MODEL_ENV] = spec.helperModel;
  for (const [k, v] of SESSION_ENV) env[k] = v;
  env[SESSION_MARKER] = marker;
  return env;
}
