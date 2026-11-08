// The tool agents drive their emulator with (crates/fleetd/src/node/device/agent_device.rs): Callstack's agent-device,
// as a CLI with its skill (its MCP mode costs ~64k tokens of tool definitions). The node installs it at a pinned
// version under `<node home>/device/agent-device` and puts a wrapper of its own first on each session's PATH, with
// Google's adb beside it. Each agent session gets its own agent-device home and state directory (so its own daemon),
// and the config there names the session's emulator by serial once `session_start` lent it one.
//
// The wrapper refuses while a person has control of the device (the node keeps a file saying so): adb is the agent's
// to reach, so this keeps an honest agent from fighting the person, as the browser's proxy does.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirPrivate } from "../config.ts";
import { writeAtomic } from "../secrets/files.ts";
import { ADB_SERVER_PORT, deviceDir, type Sdk, sdkAt } from "./sdk.ts";

/** The agent-device release the node installs. */
export const VERSION = "0.21.31";

/** Its npm package, checked against npm's own integrity digest for it. */
const TARBALL_URL = "https://registry.npmjs.org/agent-device/-/agent-device-0.21.31.tgz";
const TARBALL_INTEGRITY =
  "sha512-541X/tXHqQS3Xg5PutPSek1nQFLgEJEXFdLPiZ9jTvSb+SMHr/Z4kzVCnBkGza59R+EHO1atLWx0ZAW5vK84IQ==";

/** Its skill, from the same tag (the npm package leaves it out), checked by digest. */
const SKILL_URL = "https://raw.githubusercontent.com/callstack/agent-device/v0.21.31/skills/agent-device/SKILL.md";
const SKILL_SHA256 = "ad3b4ccbd2d43c3baae80a5b0d5aaad14becffb49fabccb6c93d61d44dcd6698";

/** What the wrapper says while a person has control. */
export const PAUSED =
  "A person has control of the device now. Wait for them to hand it back (carry on with other work meanwhile); your next agent-device command after that sees the screen as they left it.";

export const installDir = (home: string) => join(deviceDir(home), "agent-device");
/** The directory put first on a session's PATH: it holds only the `agent-device` wrapper. */
export const binDir = (home: string) => join(installDir(home), "bin");
/** The unpacked package. */
export const packageDir = (home: string) => join(installDir(home), "node_modules/agent-device");
/** The pinned package's CLI, which the wrappers run. */
export const entry = (home: string) => join(packageDir(home), "bin/agent-device.mjs");
/** The plugin that gives sessions agent-device's own skill (`--plugin-dir`). */
export const pluginDir = (home: string) => join(installDir(home), "plugin");

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The wrapper, when it wraps the pinned version. */
export function findAgentDevice(home: string): string | undefined {
  const bin = join(binDir(home), "agent-device");
  let version: string;
  try {
    version = readFileSync(join(installDir(home), "VERSION"), "utf8");
  } catch {
    return undefined;
  }
  return version.trim() === VERSION && isFile(bin) && isFile(entry(home)) ? bin : undefined;
}

async function fetchBytes(url: string, what: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new Error(`cannot download ${what}: ${(e as Error).message}`);
  }
  if (!response.ok) throw new Error(`cannot download ${what}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Installs the pinned release (its npm tarball, checked against npm's integrity digest: the package has no
 * dependencies and its Android helpers ship built, so nothing else comes down and no install script runs), its skill
 * as a plugin, and the wrapper. Running it needs Node.js 22.12 or later, as agent-device does.
 */
export async function install(home: string): Promise<string> {
  const dir = installDir(home);
  const pkg = packageDir(home);
  rmSync(pkg, { recursive: true, force: true });
  mkdirSync(pkg, { recursive: true });
  const tarball = await fetchBytes(TARBALL_URL, "agent-device");
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (integrity !== TARBALL_INTEGRITY) throw new Error(`agent-device's package is not the pinned one (integrity ${integrity})`);
  const file = join(dir, "agent-device.tgz");
  writeFileSync(file, tarball);
  const tar = Bun.spawn(["tar", "-xzf", file, "-C", pkg, "--strip-components=1"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [said, code] = await Promise.all([new Response(tar.stderr).text(), tar.exited]);
  rmSync(file, { force: true });
  if (code !== 0) throw new Error(`unpacking agent-device failed: ${said.trim()}`);
  if (!isFile(entry(home))) throw new Error("the agent-device package has no bin/agent-device.mjs");
  const skill = await fetchBytes(SKILL_URL, "agent-device's skill");
  const digest = createHash("sha256").update(skill).digest("hex");
  if (digest !== SKILL_SHA256) throw new Error(`agent-device's skill is not the pinned one (digest ${digest})`);
  makePlugin(new TextDecoder().decode(skill), pluginDir(home));
  const bin = binDir(home);
  mkdirSync(bin, { recursive: true });
  const wrapper = join(bin, "agent-device");
  writeAtomic(wrapper, wrapperScript(entry(home), sdkAt(home)));
  chmodSync(wrapper, 0o755);
  writeFileSync(join(dir, "VERSION"), VERSION);
  return wrapper;
}

/**
 * The wrapper: refuses while the session's control file says a person has the device, else runs agent-device with the
 * node's SDK and adb (on the node's own adb server port). Those are set here only, for agent-device: an agent's own
 * `ANDROID_HOME`, `PATH` and adb stay as they were for its own Android work.
 */
export function wrapperScript(entryPath: string, sdk: Sdk): string {
  const quote = (p: string) => p.replaceAll("'", "'\\''");
  return (
    "#!/bin/sh\n" +
    `# fleetd's: agent-device ${VERSION}, pointed at this session's emulator.\n` +
    'if [ -n "$FLEETD_DEVICE_CONTROL" ] && [ -e "$FLEETD_DEVICE_CONTROL" ]; then\n' +
    `  echo '${quote(PAUSED)}' >&2\n  exit 75\nfi\n` +
    `ANDROID_HOME='${quote(sdk.root)}'\nANDROID_SDK_ROOT='${quote(sdk.root)}'\nPATH='${quote(dirname(sdk.adb))}':"$PATH"\n` +
    `ANDROID_ADB_SERVER_PORT=${ADB_SERVER_PORT}\n` +
    "export ANDROID_HOME ANDROID_SDK_ROOT PATH ANDROID_ADB_SERVER_PORT\n" +
    `exec node '${quote(entryPath)}' "$@"\n`
  );
}

export function makePlugin(skill: string, plugin: string): void {
  rmSync(plugin, { recursive: true, force: true });
  const skills = join(plugin, "skills", "agent-device");
  mkdirSync(skills, { recursive: true });
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  const manifest = {
    name: "agent-device",
    description: "agent-device's skill, for the Android session fleetd opens with session_start kind android.",
  };
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(join(skills, "SKILL.md"), skill);
}

/** An agent session's own agent-device home: its config, and its state (daemon, logs) below it. */
export const sessionDir = (home: string, thread: string) => join(home, "sessions", thread, "agent-device");

/**
 * In a session's agent-device home, the file naming the home its commands use instead: an iOS clone's own, whose
 * daemon the pool started the XCTest runner in before it lent the clone (ios/pool.ts). The iOS wrapper switches to it.
 */
export const LENT = "lent";

/** The agent-device home a session's commands use: the one LENT names, or its own. */
export function homeOf(home: string, thread: string): string {
  const dir = sessionDir(home, thread);
  try {
    const lent = readFileSync(join(dir, LENT), "utf8").trim();
    if (lent) return lent;
  } catch {
    // Nothing lent.
  }
  return dir;
}

/** The pid of the agent-device daemon whose state directory is `state`, while one is registered there. */
export function daemonPid(state: string): number | undefined {
  try {
    const daemon = JSON.parse(readFileSync(join(state, "daemon.json"), "utf8")) as { stateDir?: unknown; pid?: unknown };
    return daemon.stateDir === state && typeof daemon.pid === "number" ? daemon.pid : undefined;
  } catch {
    return undefined;
  }
}

/** The file whose presence tells the wrapper a person has control. */
export const controlPath = (home: string, thread: string) => join(home, "sessions", thread, "device-control");

/** Points the session's agent-device at its emulator. */
export function writeConfig(home: string, thread: string, serial: string): void {
  const dir = sessionDir(home, thread);
  mkdirPrivate(dir);
  writeAtomic(join(dir, "config.json"), `${JSON.stringify({ platform: "android", serial })}\n`);
}

/**
 * Ends the session's agent-device daemon, if one runs (in the home LENT names, when it names one), and drops the
 * config naming its device.
 */
export function release(home: string, thread: string): void {
  const dir = sessionDir(home, thread);
  const pid = daemonPid(join(homeOf(home, thread), "state"));
  if (pid !== undefined) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Gone already.
    }
  }
  for (const file of [join(dir, LENT), join(dir, "config.json"), controlPath(home, thread)]) rmSync(file, { force: true });
}

/**
 * What a session's claude gets in its environment: the wrapper first on PATH (it alone, not adb), its own
 * agent-device home and state, and the control file the wrapper checks. The SDK's variables stay in the wrapper.
 */
export function agentEnv(home: string, thread: string, path?: string): [string, string][] {
  const bin = binDir(home);
  const dir = sessionDir(home, thread);
  return [
    ["PATH", path ? `${bin}:${path}` : bin],
    ["AGENT_DEVICE_HOME", dir],
    ["AGENT_DEVICE_STATE_DIR", join(dir, "state")],
    ["FLEETD_DEVICE_CONTROL", controlPath(home, thread)],
  ];
}
