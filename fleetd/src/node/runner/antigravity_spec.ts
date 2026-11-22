// Antigravity's launch for a session, wherever it runs (this machine, or a box: fleetd hosted imports it as
// `fleetd/box/antigravity`): which profiles run on it, agy's argv and environment, the ACP spec the session's host drives
// it with (./host/acp.ts), and the sign-in's command. Box side (docs/CONTRIBUTING.md "The package"): what reads this
// machine (the installed agy, its install, whether it is signed in) is ./antigravity.ts.
import type { Effort } from "../../shared/contracts.ts";
import type { AcpSpec } from "./host/acp.ts";

export { signInUrl } from "./login.ts";

type Env = Record<string, string>;

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
    stateFile: o.stateFile,
  };
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
