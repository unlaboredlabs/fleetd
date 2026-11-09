// What an agent's claude gets to drive its browser session: the
// node's agent-browser first on its PATH, pointed at the session's CDP proxy with a daemon and an action policy of its
// own, and agent-browser's skill as a plugin. The broker hands these to the node core's launch of the agent's claude
// (`node.area("launch")`, Rust's `SessionHooks::env` and `plugin_dirs`). The node installs the pinned release from npm
// where it is missing (`install`).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The pinned agent-browser. */
export const VERSION = "0.39.4";

export const installDir = (home: string) => join(home, "browser", "agent-browser");
export const binDir = (home: string) => join(installDir(home), "bin");
export const pluginDir = (home: string) => join(installDir(home), "plugin");

/** The package's native binary for this machine. */
function platformBinary(): string | undefined {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined;
  return (os === "linux" || os === "darwin") && arch ? `agent-browser-${os}-${arch}` : undefined;
}

/** Sets the native binary's exec bits: npm unpacks the package's binaries without them, and its postinstall, which
 * sets them, doesn't run (`--ignore-scripts`). */
function makeExecutable(native: string): void {
  const mode = statSync(native).mode;
  if ((mode & 0o111) !== 0o111) chmodSync(native, mode | 0o111);
}

/** The installed binary, when it is the pinned version (and executable, or made so). */
export function find(home: string): string | undefined {
  const bin = join(binDir(home), "agent-browser");
  try {
    if (readFileSync(join(installDir(home), "VERSION"), "utf8").trim() !== VERSION || !statSync(bin).isFile()) return undefined;
    makeExecutable(bin);
    return bin;
  } catch {
    return undefined;
  }
}

/** Installs the pinned release from npm, without running its install scripts, and links this machine's native binary
 * as the session's `agent-browser`, with its skill as a plugin. Throws why it failed. */
export async function install(home: string): Promise<string> {
  const dir = installDir(home);
  const name = platformBinary();
  if (!name) throw new Error(`agent-browser has no build for ${process.platform} ${process.arch}`);
  mkdirSync(dir, { recursive: true });
  let child: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    child = Bun.spawn(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", dir, `agent-browser@${VERSION}`], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
  } catch (e) {
    throw new Error(`cannot run npm (Node.js) to install agent-browser: ${(e as Error).message}`);
  }
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`installing agent-browser failed: ${[...err].slice(-400).join("")}`);
  const native = join(dir, "node_modules/agent-browser/bin", name);
  if (!existsSync(native)) throw new Error(`the agent-browser package has no ${name}`);
  makeExecutable(native);
  mkdirSync(binDir(home), { recursive: true });
  const link = join(binDir(home), "agent-browser");
  rmSync(link, { force: true });
  symlinkSync(native, link);
  makePlugin(join(dir, "node_modules/agent-browser/skills/agent-browser"), pluginDir(home));
  writeFileSync(join(dir, "VERSION"), VERSION);
  return link;
}

/** The plugin that gives sessions agent-browser's own skill (`--plugin-dir`). */
function makePlugin(skill: string, plugin: string): void {
  let text: string;
  try {
    text = readFileSync(join(skill, "SKILL.md"), "utf8");
  } catch (e) {
    throw new Error(`the agent-browser package has no skill: ${(e as Error).message}`);
  }
  rmSync(plugin, { recursive: true, force: true });
  mkdirSync(join(plugin, "skills", "agent-browser"), { recursive: true });
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  const manifest = { name: "agent-browser", description: "agent-browser's skill, for the browser session fleetd opens with session_start." };
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(join(plugin, "skills", "agent-browser", "SKILL.md"), text);
}

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
