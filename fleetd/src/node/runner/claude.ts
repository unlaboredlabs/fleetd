// The claude runner's spawn side (crates/fleetd/src/node/runner/claude/mod.rs, guide.rs, conformance.rs): the tools
// fleetd keeps from agents, claude's argv for a session, the environment it starts with, and the zero-cost probe of
// the installed claude. The stream-json mapping itself runs in each session's host (./host/mapper.ts).
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDir, type Env } from "../util.ts";
import type { Effort } from "../../shared/contracts.ts";
import { autoupdaterOff } from "./install.ts";
import { accountOverrides, loginLabel, proxyOf } from "./claude/setup.ts";
import {
  AGENT_DISALLOWED_WHY, DEFAULT_ENV_WHY, DISALLOWED_WHY, items, LEAD_ALLOWED_WHY, LEAD_ASK_WHY, LEAD_DISALLOWED_WHY,
  NESTING_VARS_WHY, pairs, PROMPT_CACHE_TTL_WHY, SESSION_ENV_WHY, SUBAGENTS_OFF_ENV_WHY, SUBAGENTS_ON_ENV_WHY, TASK_DISALLOWED_WHY,
  WORKER_ENV_WHY,
} from "./claude/explained.ts";
import type { RunnerInfo, RuntimeMode, SessionRole } from "../sessions/types.ts";

/** Every profile's own model (guide.rs MODEL). */
export const MODEL = "claude-opus-5-5";
export const SUPPORTED = ">=2.1.300, <2.2.0";
export const TESTED = "2.1.314";
/** The claude the runner's recorded fixtures came from. */
export const RECORDED = "2.1.302";
const INSTALL_FIX = "curl -fsSL https://claude.ai/install.sh | bash";

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
export const roleEnv = (role: SessionRole, env: Env): Env =>
  role === "worker" ? Object.fromEntries(WORKER_ENV.filter(([k]) => !(k in env))) : {};
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

/** Where claude files a session (`--resume` needs it): JS-replace naming, on the resolved cwd. */
export function sessionFile(configDir: string, cwd: string, id: string): string | undefined {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {}
  // A character outside the BMP becomes two dashes, as JavaScript's replace works on UTF-16 units.
  const name = real.replace(/[^A-Za-z0-9]/g, "-");
  return name.length <= 200 ? join(configDir, "projects", name, `${id}.jsonl`) : undefined;
}

/** `CLAUDE_CONFIG_DIR`, else `<HOME>/.claude` (setup.rs `config_dir`). */
export const configDir = (env: Env) => env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homeDir(), ".claude");

/** FLEETD_CLAUDE_BIN (a stand-in for tests), else `claude` from PATH, else the native installer's
 * `~/.local/bin/claude`. */
export function claudeBinary(): string {
  if (process.env.FLEETD_CLAUDE_BIN) return process.env.FLEETD_CLAUDE_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "claude"))) return join(dir, "claude");
  }
  const local = join(homeDir(), ".local/bin/claude");
  return existsSync(local) ? local : "claude";
}

export const sessionInUse = (text: string) => text.includes("is already in use");
export const promptFileUnknown = (text: string) => text.includes("unknown option") && text.includes("--append-system-prompt-file");

const PROBE_ARGS = ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--strict-mcp-config", "--setting-sources", "user", "--settings", AUTO_MEMORY_OFF_SETTINGS];
const PROBE_TIMEOUT_MS = 30_000;
const REQUEST_ID = "fleetd-probe-1";

type Account = { tokenSource?: string; apiKeySource?: string; apiProvider?: string; subscriptionType?: string };

/** Which credential claude would use (conformance.rs `login_of`). */
export function loginOf(account: Account): [RunnerInfo["login"], string] {
  const set = (v?: string) => (v && v !== "none" ? v : undefined);
  if (account.apiProvider && account.apiProvider !== "firstParty") return ["logged_in", "token"];
  const token = set(account.tokenSource);
  if (account.subscriptionType || token === "claude.ai" || token === "CLAUDE_CODE_OAUTH_TOKEN") return ["logged_in", "subscription"];
  if (token) return ["logged_in", "token"];
  if (set(account.apiKeySource)) return ["logged_in", "api_key"];
  return ["logged_out", "none"];
}

/** `x.y.z (Claude Code)` inside SUPPORTED. */
function versionOk(printed: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(printed.trim());
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  const cmp = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  return cmp(v, [2, 1, 300]) >= 0 && cmp(v, [2, 2, 0]) < 0;
}

const probeEnv = (env: Env): Env => {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (k !== FLEETD_ENV_SOURCE) out[k] = v;
  out[AUTO_MEMORY_OFF_ENV[0]] = AUTO_MEMORY_OFF_ENV[1];
  return out;
};

/** The zero-cost probe: `claude --version`, then one stream-json `initialize`, stdin closed after the answer. */
export async function probe(binary: string, env: Env): Promise<RunnerInfo> {
  const info: RunnerInfo = {
    runner: "claude",
    supported: SUPPORTED,
    versionOk: false,
    login: "unknown",
    configDir: configDir(env),
    selfUpdate: !autoupdaterOff(join(configDir(env), "settings.json")),
    accountOverrides: accountOverrides(env),
  };
  const proxy = proxyOf(env);
  if (proxy) [info.proxy, info.proxySource] = [proxy.url, proxy.source];
  let version: string;
  try {
    const proc = Bun.spawn([binary, "--version"], { env: probeEnv(env), cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    version = out.split("\n")[0]?.trim() ?? "";
    if (code !== 0 || !version) {
      info.problem = `\`${binary} --version\` failed (exit status: ${code}): ${err.trim()}. Fix: ${INSTALL_FIX}`;
      return info;
    }
  } catch {
    info.problem = `claude is not installed (${binary} not found). Fix: ${INSTALL_FIX}`;
    return info;
  }
  info.version = version;
  info.versionOk = versionOk(version);
  const problems: string[] = [];
  try {
    const answer = await initialize(binary, env);
    info.conformanceOk = true;
    const reported = answer.claudeCodeVersion as string | undefined;
    if (reported && version.split(/\s+/)[0] !== reported) {
      info.conformanceOk = false;
      problems.push(`\`claude --version\` and the running claude disagree (${version} vs ${reported}): two installs on PATH? Fix: ${INSTALL_FIX}`);
    }
    const account = (answer.account ?? {}) as Account;
    const [login, kind] = loginOf(account);
    info.login = login;
    info.loginKind = kind;
    const label = loginLabel(account);
    if (label) info.loginLabel = label;
    if (login === "logged_out")
      problems.push(`claude is not logged in. Fix: ${info.proxy ? "log in with your proxy as you normally do" : "run `claude` on this machine and log in"}`);
  } catch (error) {
    info.conformanceOk = false;
    problems.push(`${(error as Error).message} This claude's stream-json differs from the one fleetd was tested with. Fix: claude install ${TESTED}`);
  }
  if (problems.length) info.problem = problems.join(" ");
  return info;
}

async function initialize(binary: string, env: Env): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([binary, ...PROBE_ARGS], { env: probeEnv(env), cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), PROBE_TIMEOUT_MS);
  try {
    proc.stdin.write(`${JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "initialize" } })}\n`);
    proc.stdin.flush();
    const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("claude did not answer the initialize probe: it exited first.");
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type !== "control_response") continue;
        const body = msg.response ?? {};
        if (body.request_id !== REQUEST_ID) throw new Error(`claude answered request "${body.request_id}", not fleetd's initialize.`);
        if (body.subtype !== "success") throw new Error(`claude refused the initialize probe: ${body.error ?? body.subtype}.`);
        const answer = body.response ?? {};
        if (typeof answer.account !== "object") throw new Error("claude's initialize answer has no `account`.");
        return answer;
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      proc.stdin.end();
    } catch {}
    proc.kill();
  }
}
