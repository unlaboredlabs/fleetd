// The claude runner's spawn side (guide.rs, conformance.rs): the tools
// fleetd keeps from agents, claude's argv for a session, the environment it starts with (./claude_spec.ts, box side),
// and on this machine the installed claude, its config dir and the zero-cost probe of it. The stream-json mapping itself
// runs in each session's host (./host/mapper.ts).
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDir, type Env } from "../util.ts";
import { SUPPORTED, TESTED } from "./claude_pins.ts";
import { AUTO_MEMORY_OFF_ENV, AUTO_MEMORY_OFF_SETTINGS, FLEETD_ENV_SOURCE } from "./claude_spec.ts";
import { autoupdaterOff } from "./install.ts";
import { accountOverrides, loginLabel, proxyOf } from "./claude/setup.ts";
import type { RunnerInfo } from "../sessions/types.ts";

export { RECORDED, SUPPORTED, TESTED } from "./claude_pins.ts";
export {
  MODEL, profileModel, profileOf, ALWAYS_DISALLOWED, roleDisallowed, roleAllowed, roleAsk, SUBAGENTS_OFF_ENV, subagentsOffSettingsEnv, ORDER_ENV_FILE_ENV, AUTO_MEMORY_OFF_ENV, AUTO_MEMORY_OFF_SETTINGS, HEAVY_LSP_PLUGINS, heavyLspOn, DEFAULT_ENV, WORKER_ENV, roleEnv, PROMPT_CACHE_TTL_VARS, defaultCacheTtl, HELPER_MODEL_ENV, SESSION_ENV, FLEETD_ENV_SOURCE, SESSION_MARKER, runtimeTools, disallowedTools, args, spawnEnv,
  type SessionSpec,
} from "./claude_spec.ts";

const INSTALL_FIX = "curl -fsSL https://claude.ai/install.sh | bash";

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
