// Antigravity's launch for a session, wherever it runs (this machine, or a box: fleetd hosted imports it as
// `fleetd/box/antigravity`): which profiles run on it, agy's argv and environment, the ACP spec the session's host drives
// it with (./host/acp.ts), and the sign-in's command. Box side (docs/CONTRIBUTING.md "The package"): what reads this
// machine (the installed agy, its install, whether it is signed in) is ./antigravity.ts.
import type { Effort } from "../../shared/contracts.ts";
export { signInUrl } from "./sign_in_url.ts";

type Env = Record<string, string>;

/** What the node gives an ACP session's host, as JSON in the file `FLEETD_ACP` names (`spec` writes it). */
export type AcpSpec = {
  cwd: string;
  addDirs: string[];
  /** ACP `mcpServers`: fleetd's own server and the project's of the session's role. */
  mcpServers: unknown[];
  /** Appended to the agent's own system prompt. */
  systemPrompt?: string;
  model: string;
  /** The thinking level option's value (`low` … `max`). */
  effort: string;
  /** The `authenticate` method (`gemini-api-key`); none runs on the sign-in agy already has. */
  authMethod?: string;
  /** Every permission request goes to the hub (a lead in approval mode); else fleetd allows what isn't fenced. */
  approval: boolean;
  /** The role's fenced tools, in Claude's rule words (`Bash(git push *--no-verify*)`, `mcp__fleetd__x`, `Edit`). */
  deny: string[];
  /** What runs unasked in approval mode too, in the same words: a lead's own tools (`mcp__fleetd`, `Read`, …). */
  allow: string[];
  /** What always goes to the hub, above `allow`, as Claude ranks its ask rules: a lead's final Confirm on a site
   * (`mcp__fleetd__confirm_step`), a bot's proposal, an automation's, a fetch of a site the person didn't give. */
  ask: string[];
  /** Where the agent's own session id is kept, for the next start's resume. */
  stateFile: string;
};


/** The variable naming a session's ACP spec file (host/acp.ts `AcpSpec`): set, the session's host speaks ACP to its
 * agent instead of Claude's stream-json. */
export const ACP_ENV = "FLEETD_ACP";
/** Where agy keeps its sign-in: a file in its home, never the OS keyring. agy on a machine with no keyring (a box, a
 * host with no D-Bus session) does so anyway; this asks it outright. */
export const FILE_STORAGE: [string, string] = ["AGY_ACP_FORCE_FILE_STORAGE", "1"];

export const RUNNER = "antigravity";
/** The agy fleetd was tested with (what a box pins). */
export const TESTED = "1.5.14";

/** A profile's model that runs any model Antigravity offers (hub/projects/profiles.ts ANTIGRAVITY_MODELS lists the
 * Gemini ones): `antigravity/claude-opus-5-5`. */
export const PREFIX = "antigravity/";

/** The model `agy` takes for a profile's model; undefined when it runs on Claude. */
export function agyModel(model: string): string | undefined {
  if (model.startsWith(PREFIX)) return model.slice(PREFIX.length) || undefined;
  return model.startsWith("gemini-") ? model : undefined;
}

/** The thinking level of a profile's effort: Antigravity's highest is `xhigh`. */
export const thinking = (effort: Effort) => (effort === "max" ? "xhigh" : effort);

export const KEY_ENV = "GEMINI_API_KEY";
export const ENDPOINT_ENV = "GOOGLE_GEMINI_BASE_URL";
/** Google credentials a session never takes from the machine's environment: the sign-in mode runs on agy's own sign-in,
 * the key mode on the project's key alone. */
const GOOGLE_VARS = [KEY_ENV, ENDPOINT_ENV, "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "AGY_ADC_AUTH", "GEMINI_HOME"];
/** Updates come from fleetd (`install`), never under a running agent. */
export const AUTOUPDATE_OFF: [string, string] = ["AGY_CLI_DISABLE_AUTO_UPDATE", "1"];

/** How a session signs in: the project's key when it has one, else the machine's own Antigravity sign-in. */
export type Auth = { kind: "signin" } | { kind: "key"; key: string; endpoint?: string };
export const authOf = (vars: Env): Auth =>
  vars[KEY_ENV] ? { kind: "key", key: vars[KEY_ENV]!, ...(vars[ENDPOINT_ENV] ? { endpoint: vars[ENDPOINT_ENV] } : {}) } : { kind: "signin" };

/** agy's argv: a key session keeps its conversations in an Antigravity home of its own (`home`), so the person's own
 * agy keeps its sign-in and settings. */
export const args = (auth: Auth, home: string): string[] => (auth.kind === "key" ? ["acp", "--gemini-dir", home] : ["acp"]);

/** The environment agy starts with: `env` without Google credentials, then the key's and fleetd's own. */
export function spawnEnv(env: Env, auth: Auth): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (!GOOGLE_VARS.includes(k)) out[k] = v;
  if (auth.kind === "key") {
    out[KEY_ENV] = auth.key;
    if (auth.endpoint) out[ENDPOINT_ENV] = auth.endpoint;
  }
  out[AUTOUPDATE_OFF[0]] = AUTOUPDATE_OFF[1];
  return out;
}

/** Claude's `--mcp-config` servers as ACP's `mcpServers`: stdio ones with `env`, http ones with `headers`, each a list. */
export function mcpServers(config: string): unknown[] {
  const servers = (JSON.parse(config) as { mcpServers?: Record<string, Record<string, any>> }).mcpServers ?? {};
  const pairs = (o: unknown) => Object.entries((o ?? {}) as Record<string, string>).map(([name, value]) => ({ name, value: String(value) }));
  return Object.entries(servers).map(([name, s]) =>
    s.type === "http" || s.type === "sse"
      ? { type: s.type, name, url: s.url, headers: pairs(s.headers) }
      : { name, command: s.command, args: s.args ?? [], env: pairs(s.env) },
  );
}

/** What the host's ACP driver runs the session with (./host/acp.ts). */
export function spec(o: {
  cwd: string;
  addDirs: string[];
  mcpConfig: string;
  systemPrompt?: string;
  model: string;
  effort: Effort;
  auth: Auth;
  approval: boolean;
  deny: string[];
  allow: string[];
  ask: string[];
  stateFile: string;
}): AcpSpec {
  return {
    cwd: o.cwd,
    addDirs: o.addDirs,
    mcpServers: mcpServers(o.mcpConfig),
    ...(o.systemPrompt ? { systemPrompt: o.systemPrompt } : {}),
    model: agyModel(o.model) ?? o.model,
    effort: thinking(o.effort),
    ...(o.auth.kind === "key" ? { authMethod: "gemini-api-key" } : {}),
    approval: o.approval,
    deny: o.deny,
    allow: o.allow,
    ask: o.ask,
    stateFile: o.stateFile,
  };
}

/** How much MCP tool schema agy 1.5.14 shows its model in one session, all servers together, in `toolBytes`: past it,
 * agy hides the largest tools, biggest first, until the rest fits, and the model never learns of them (no name in its
 * `<mcp_servers>` block, no call that reaches them). Measured with a stand-in server through `agy acp` (W844): tools
 * kept up to 59,744 bytes, hidden from 60,000. */
export const TOOL_BUDGET = 60_000;
/** What fleetd's own tools may take of it, per role (cli/agent_mcp/tools.json; agent_mcp_size.test.ts holds them to
 * it): the rest is room for the bot's own servers. */
export const FLEETD_TOOL_SHARE = 45_000;
/** The most one fleetd tool may take: over the budget agy hides the biggest first, so fleetd's stay small. */
export const TOOL_MAX = 2_000;

/** One MCP tool as tools/list gives it. */
export type ListedTool = { name: string; description?: string; inputSchema?: unknown };

/** A tool's size as agy counts it: the JSON it keeps of the tool (`{"name","description","parameters"}`, compact,
 * `<`, `>` and `&` escaped as Go escapes them). */
export function toolBytes(tool: ListedTool): number {
  const json = JSON.stringify({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? {} });
  return Buffer.byteLength(json.replace(/[<>&]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`));
}

/** What breaks the limits in a set of fleetd's tools: each tool past TOOL_MAX, and the set past FLEETD_TOOL_SHARE,
 * named with their sizes; empty when it fits. */
export function overLimits(tools: ListedTool[]): string[] {
  const out = tools.filter((t) => toolBytes(t) > TOOL_MAX).map((t) => `${t.name} is ${toolBytes(t)} bytes (at most ${TOOL_MAX})`);
  const total = tools.reduce((sum, t) => sum + toolBytes(t), 0);
  if (total > FLEETD_TOOL_SHARE) out.push(`the set is ${total} bytes (at most ${FLEETD_TOOL_SHARE})`);
  return out;
}

/** The servers an Antigravity lead's session goes without so that fleetd's own tools (`fleetdBytes`) all fit the budget:
 * the biggest first, as few as it takes. A server whose tools couldn't be listed counts nothing. */
export function leftOut(fleetdBytes: number, servers: { name: string; bytes: number }[]): string[] {
  let total = fleetdBytes + servers.reduce((sum, s) => sum + s.bytes, 0);
  const out: string[] = [];
  for (const s of [...servers].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))) {
    if (total <= TOOL_BUDGET) break;
    out.push(s.name);
    total -= s.bytes;
  }
  return out;
}

/** The sign-in from the app (`antigravity_login`): `agy acp --login`, which prints a Google link and reads the code the
 * page shows. Told it runs over SSH, it never tries to open a browser on the machine and keeps the sign-in where every
 * `agy acp` finds it. */
export const loginArgv = (binary: string) => [binary, "acp", "--login"];
export function loginEnv(env: Env): Env {
  const out = spawnEnv(env, { kind: "signin" });
  delete out.DISPLAY;
  delete out.WAYLAND_DISPLAY;
  out.SSH_CONNECTION ||= "127.0.0.1 0 127.0.0.1 0";
  out.BROWSER = "true";
  return out;
}

/** The sign-in check's lines to `agy acp`'s stdin: ACP's `initialize`, then `authenticate` on the stored Google sign-in,
 * which reads it and calls no model. */
export const SIGNED_IN_ASK = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "fleetd", version: "1" }, clientCapabilities: {} } }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "oauth-personal" } }),
];

/** What one stdout line says of the check: the plan's name ("Google AI Pro") when signed in, null when not, and
 * undefined for any other line (keep reading). */
export function planOf(line: string): string | null | undefined {
  let m: Record<string, any>;
  try {
    m = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (m?.id !== 2) return undefined;
  if (m.error) return null;
  const tier = m.result?._meta?.antigravity?.tier?.name;
  return typeof tier === "string" && tier ? tier : "Google";
}
