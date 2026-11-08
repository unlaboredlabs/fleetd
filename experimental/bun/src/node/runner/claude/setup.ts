// What the probe reads of a machine's Claude Code setup from its files (crates/fleetd/src/node/runner/claude/setup.rs):
// the proxy it goes through and where that is set, a person's name for its login, and the account variables its user
// settings override. Nothing here calls the proxy or the Anthropic API.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "../../util.ts";

/** The Claude credential and gateway variables (fleetd-contracts claude_accounts.rs `ACCOUNT_CLEARS`), as
 * actions/accounts.ts has them: kept here too, as that module imports the probe this one feeds. */
const ACCOUNT_CLEARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

/** The base URL claude talks to when nothing overrides it; not a proxy. */
const DEFAULT_BASE_URL = "https://api.anthropic.com";
/** Not passed to claude: the node marks the env file a variable came from, so a proxy can name its source. */
export const FLEETD_ENV_SOURCE = "FLEETD_ENV_SOURCE";

const get = (env: Env, key: string) => (env[key] ? env[key] : undefined);
const home = (env: Env) => get(env, "HOME") ?? process.env.HOME ?? homedir();

/** The config dir a claude started with `env` reads and writes: `CLAUDE_CONFIG_DIR`, else `$HOME/.claude`. */
export const configDir = (env: Env) => get(env, "CLAUDE_CONFIG_DIR") ?? join(home(env), ".claude");

/** `<home>/.claude`, whatever the home: a hub describes machines whose home is not its own. */
export const isDefaultDir = (dir: string) => dir.replace(/\/+$/, "").endsWith("/.claude") || dir === ".claude";

/** `~/…` for paths under the home directory, for messages. */
export function tilde(path: string): string {
  const h = process.env.HOME ?? homedir();
  if (path === h) return "~";
  return path.startsWith(`${h}/`) ? `~/${path.slice(h.length + 1)}` : path;
}

/** `settings.json`'s `env` object. */
function settingsEnv(file: string): Record<string, unknown> | undefined {
  try {
    const env = (JSON.parse(readFileSync(file, "utf8")) as { env?: unknown }).env;
    return env && typeof env === "object" && !Array.isArray(env) ? (env as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The proxy claude would use with `env`, and where it is set; its user settings' `env` wins over the process's. */
export function proxyOf(env: Env): { url: string; source: string } | undefined {
  const file = join(configDir(env), "settings.json");
  const fromSettings = settingsEnv(file)?.ANTHROPIC_BASE_URL;
  let url: string;
  let source: string;
  if (typeof fromSettings === "string" && fromSettings.trim()) [url, source] = [fromSettings, tilde(file)];
  else {
    const fromEnv = get(env, "ANTHROPIC_BASE_URL");
    if (!fromEnv) return undefined;
    [url, source] = [fromEnv, get(env, FLEETD_ENV_SOURCE) ?? "environment"];
  }
  url = url.trim().replace(/\/+$/, "");
  return url === DEFAULT_BASE_URL ? undefined : { url, source };
}

/** The account variables (ACCOUNT_CLEARS) the user settings' `env` sets, by name, in that list's order. */
export function accountOverrides(env: Env): string[] {
  const set = settingsEnv(join(configDir(env), "settings.json"));
  if (!set) return [];
  return ACCOUNT_CLEARS.filter((name) => {
    const v = set[name];
    return v !== undefined && v !== null && (typeof v !== "string" || v.trim() !== "");
  });
}

export type Account = { tokenSource?: string; apiKeySource?: string; apiProvider?: string; subscriptionType?: string };

/** A person's name for the credential: the plan for a subscription, else how the key or token is supplied. */
export function loginLabel(account: Account): string | undefined {
  const set = (v?: string) => (v && v !== "none" ? v : undefined);
  const provider = set(account.apiProvider);
  if (provider && provider !== "firstParty") return { bedrock: "Bedrock", vertex: "Vertex", foundry: "Foundry" }[provider] ?? provider;
  const plan = set(account.subscriptionType);
  if (plan) return plan[0]!.toUpperCase() + plan.slice(1);
  const token = set(account.tokenSource);
  if (token) return token === "claude.ai" || token === "CLAUDE_CODE_OAUTH_TOKEN" ? "subscription" : "gateway token";
  const key = set(account.apiKeySource);
  return key === undefined ? undefined : key === "apiKeyHelper" ? "API key from apiKeyHelper" : "API key";
}
