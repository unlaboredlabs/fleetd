// What an agent's claude gets to drive its browser session (crates/fleetd/src/node/browser/agent_browser.rs): the
// node's agent-browser first on its PATH, pointed at the session's CDP proxy with a daemon and an action policy of its
// own, and agent-browser's skill as a plugin. The broker hands these to the node core's launch of the agent's claude
// (`node.area("launch")`, Rust's `SessionHooks::env` and `plugin_dirs`).
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The pinned agent-browser. */
export const VERSION = "0.39.4";

export const installDir = (home: string) => join(home, "browser", "agent-browser");
export const binDir = (home: string) => join(installDir(home), "bin");
export const pluginDir = (home: string) => join(installDir(home), "plugin");

/** The actions every session denies: connecting to a browser other than the session's. */
export const ALWAYS_DENIED = ["connect"];
/** And those a session that filled a credential denies too: anything that reads a value back. */
export const CREDENTIAL_DENIED = ["evaluate", "inputvalue", "addinitscript", "addscript"];

/** The policy file's text for a session, with credentials filled or not. */
export const policy = (credentials: boolean) =>
  `${JSON.stringify({ default: "allow", deny: credentials ? [...ALWAYS_DENIED, ...CREDENTIAL_DENIED] : ALWAYS_DENIED })}\n`;

/** Where a session's policy file is. */
export const policyPath = (home: string, thread: string) => join(home, "sessions", thread, "agent-browser-policy.json");

export function writePolicy(home: string, thread: string, credentials: boolean): void {
  const path = policyPath(home, thread);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.next`;
  writeFileSync(next, policy(credentials), { mode: 0o600 });
  renameSync(next, path);
}

/** A session's claude's environment for its browser: agent-browser first on PATH, at the session's proxy. */
export function env(home: string, thread: string, cdp: string, path: string | undefined): [string, string][] {
  const bin = binDir(home);
  return [
    ["PATH", path ? `${bin}:${path}` : bin],
    ["AGENT_BROWSER_CDP", cdp],
    ["AGENT_BROWSER_SESSION", `fleetd-${thread}`],
    ["AGENT_BROWSER_ACTION_POLICY", policyPath(home, thread)],
  ];
}

/** agent-browser's skill as a plugin, where its install made one. */
export const pluginDirs = (home: string) => (existsSync(join(pluginDir(home), ".claude-plugin")) ? [pluginDir(home)] : []);
