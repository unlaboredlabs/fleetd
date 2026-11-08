// Which Claude Code setup fleetd's sessions use, in words a person recognises (crates/fleetd/src/node/runner/claude/
// setup.rs `describe`): its version, its login, the proxy it goes through and the config dir. Everything comes from
// the zero-cost probe (`claude --version` and one stream-json `initialize`, which checks the protocol fleetd speaks)
// and from reading files: nothing calls the proxy or the Anthropic API. `fleetd init`'s Logins step and
// `update-claude` show it.
import type { RunnerInfo } from "../../sessions/types.ts";
import { sessionEnv } from "../../sessions/index.ts";
import type { Env } from "../../util.ts";
import { claudeBinary, probe } from "../claude.ts";
import { configDir, isDefaultDir, tilde } from "./setup.ts";

export type ClaudeSetup = {
  /** `2.1.302`: the first word of `claude --version`; undefined when claude is missing or didn't answer. */
  version?: string;
  /** "Max", "Pro", "API key", "gateway token", "Bedrock", …; undefined when logged out or unknown. */
  loginKind?: string;
  /** The `ANTHROPIC_BASE_URL` claude would use, when it isn't Anthropic's own. */
  proxy?: string;
  /** Where `proxy` is set: a file (`~/.claude/settings.json`, `~/.fleetd/claude.env`) or "environment". */
  proxySource?: string;
  /** The config dir sessions use: the user's `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
  configDir: string;
  /** Why sessions can't run here, with the fix. */
  problem?: string;
};

/** From a probe's RunnerInfo, e.g. one a node sent the hub: only what the probe reported. */
export function fromInfo(info: RunnerInfo): ClaudeSetup {
  return {
    ...(info.version ? { version: info.version.split(/\s+/)[0] } : {}),
    ...(info.login === "logged_in" ? { loginKind: info.loginLabel ?? info.loginKind ?? "unknown kind" } : {}),
    ...(info.proxy ? { proxy: info.proxy } : {}),
    ...(info.proxySource ? { proxySource: info.proxySource } : {}),
    // A node from before these fields reports none; it ran its sessions in fleetd's old profile.
    configDir: info.configDir ?? "~/.fleetd/claude",
    ...(info.problem ? { problem: info.problem } : {}),
  };
}

/** The setup in one line: "claude 2.1.302, logged in (Max), via proxy http://… from ~/.claude/settings.json". */
export function setupLine(s: ClaudeSetup): string {
  if (!s.version) return "claude is not usable";
  let line = `claude ${s.version}, ${s.loginKind ? `logged in (${s.loginKind})` : s.problem ? "not logged in" : "login unknown"}`;
  if (s.proxy) line += `, via proxy ${s.proxy}${s.proxySource ? ` from ${s.proxySource}` : ""}`;
  if (!isDefaultDir(s.configDir)) line += `, config ${tilde(s.configDir)}`;
  return line;
}

/** Probes `binary` (default: claude on PATH) with `env` (default: what a session here would get) and describes it. */
export async function describe(binary: string = claudeBinary(), env?: Env): Promise<ClaudeSetup> {
  const e = env ?? { ...sessionEnv(), ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}) };
  const setup = fromInfo(await probe(binary, e));
  return { ...setup, configDir: setup.configDir ?? configDir(e) };
}
