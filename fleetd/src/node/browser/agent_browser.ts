// What an agent's claude gets to drive its browser session: the
// node's agent-browser first on its PATH, pointed at the session's CDP proxy with a daemon and an action policy of its
// own, and agent-browser's skill as a plugin. The broker hands these to the node core's launch of the agent's claude
// (`node.area("launch")`, Rust's `SessionHooks::env` and `plugin_dirs`). The node installs the pinned release from npm
// where it is missing (`install`).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pluginFiles } from "./agent_browser_plugin.ts";
import { policy, sessionEnv, VERSION } from "./agent_browser_policy.ts";

export { PLUGIN_MANIFEST, pluginFiles } from "./agent_browser_plugin.ts";
export { ALWAYS_DENIED, CREDENTIAL_DENIED, policy, sessionEnv, VERSION } from "./agent_browser_policy.ts";

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
  for (const file of pluginFiles(text)) {
    mkdirSync(dirname(join(plugin, file.path)), { recursive: true });
    writeFileSync(join(plugin, file.path), file.text);
  }
}

/** Where a session's policy file is. */
export const policyPath = (home: string, thread: string) => join(home, "sessions", thread, "agent-browser-policy.json");

export const writePolicy = (home: string, thread: string, credentials: boolean): void => writePolicyText(home, thread, policy(credentials));

/** Writes a session's policy file with `text` (`policy`'s). */
export function writePolicyText(home: string, thread: string, text: string): void {
  const path = policyPath(home, thread);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.next`;
  writeFileSync(next, text, { mode: 0o600 });
  renameSync(next, path);
}

/** A session's claude's environment for its browser: agent-browser first on PATH, at the session's proxy. */
export const env = (home: string, thread: string, cdp: string, path: string | undefined): [string, string][] =>
  sessionEnv({ thread, cdp, policyPath: policyPath(home, thread), bin: binDir(home), path });

/** agent-browser's skill as a plugin, where its install made one. */
export const pluginDirs = (home: string) => (existsSync(join(pluginDir(home), ".claude-plugin")) ? [pluginDir(home)] : []);
