// agent-device for iOS simulators (crates/fleetd/src/node/device/ios/wrapper.rs): the same pinned package as android
// sessions (../agent_device.ts), run by a wrapper of its own at `<node home>/device/ios/bin/agent-device`, which names
// the node's simulator set and the runner the golden built. Those are set in the wrapper only: an agent's own
// `xcrun simctl` and Xcode stay as they were. Each agent keeps its own agent-device home and state, and its config
// names its simulator by udid.
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkdirPrivate } from "../../config.ts";
import { writeAtomic } from "../../secrets/files.ts";
import { agentEnv, binDir as androidBin, entry, LENT, packageDir, PAUSED, sessionDir, VERSION } from "../agent_device.ts";
import { deviceDir } from "../sdk.ts";

export const iosDir = (home: string) => join(deviceDir(home), "ios");
/** The node's own simulator set. */
export const setDir = (home: string) => join(iosDir(home), "set");
/** The directory put first on an agent's PATH: it holds only the `agent-device` wrapper. */
export const binDir = (home: string) => join(iosDir(home), "bin");

/**
 * Where agent-device's XCTest runner is built, once, by the golden's prepare: in the package's own `.tmp`, named by
 * the package's real path (agent-device cleans a runner only there).
 */
export function runnerDir(home: string): string {
  let pkg = packageDir(home);
  try {
    pkg = realpathSync(pkg);
  } catch {
    // Not installed yet.
  }
  return join(pkg, ".tmp/fleetd-runner");
}

/**
 * While an agent's own agent-device starts its XCTest runner, this file holds the pid of the `prepare` doing it, and
 * the wrapper waits for it to end before it runs anything.
 */
export const startingPath = (home: string, thread: string) => join(home, "sessions", thread, "runner-starting");

/**
 * The wrapper: refuses while the control file says a person has the simulator, waits while the runner starts,
 * switches to the clone's own agent-device home when the agent's names one (LENT), else runs agent-device on the
 * node's simulator set with the runner the golden built, given as an external one (`xctestrun`) so a slow first start
 * is started again rather than rebuilt. A daemon that stops stops its runner (`AGENT_DEVICE_IOS_RUNNER_DETACH=0`).
 */
export function wrapperScript(entryPath: string, home: string, xctestrun?: string): string {
  const quote = (p: string) => p.replaceAll("'", "'\\''");
  const runner = quote(runnerDir(home));
  const external = xctestrun
    ? `AGENT_DEVICE_IOS_XCTESTRUN_FILE='${quote(xctestrun)}'\n` +
      `AGENT_DEVICE_IOS_XCTEST_DERIVED_DATA_PATH='${runner}'\n` +
      "export AGENT_DEVICE_IOS_XCTESTRUN_FILE AGENT_DEVICE_IOS_XCTEST_DERIVED_DATA_PATH\n"
    : "";
  return (
    "#!/bin/sh\n" +
    `# fleetd's: agent-device ${VERSION}, pointed at this session's iOS simulator.\n` +
    'if [ -n "$FLEETD_DEVICE_CONTROL" ] && [ -e "$FLEETD_DEVICE_CONTROL" ]; then\n' +
    `  echo '${quote(PAUSED)}' >&2\n  exit 75\nfi\n` +
    'if [ -n "$FLEETD_RUNNER_STARTING" ]; then\n' +
    '  while pid=$(cat "$FLEETD_RUNNER_STARTING" 2>/dev/null) && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; do sleep 0.2; done\n' +
    "fi\n" +
    `if [ -n "$AGENT_DEVICE_HOME" ] && lent=$(cat "$AGENT_DEVICE_HOME/${LENT}" 2>/dev/null) && [ -n "$lent" ]; then\n` +
    '  AGENT_DEVICE_HOME="$lent"\n  AGENT_DEVICE_STATE_DIR="$lent/state"\n  export AGENT_DEVICE_HOME AGENT_DEVICE_STATE_DIR\n' +
    "fi\n" +
    `AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET='${quote(setDir(home))}'\n` +
    `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH='${runner}'\n` +
    "AGENT_DEVICE_IOS_RUNNER_DETACH=0\n" +
    "AGENT_DEVICE_NO_UPDATE_NOTIFIER=1\n" +
    "export AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH AGENT_DEVICE_IOS_RUNNER_DETACH AGENT_DEVICE_NO_UPDATE_NOTIFIER\n" +
    external +
    `exec node '${quote(entryPath)}' "$@"\n`
  );
}

/** The wrapper, when it wraps the pinned package and starts the runner `xctestrun`. */
export function findWrapper(home: string, xctestrun: string): string | undefined {
  const bin = join(binDir(home), "agent-device");
  try {
    return readFileSync(bin, "utf8") === wrapperScript(entry(home), home, xctestrun) ? bin : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the wrapper for the installed package: without a runner while the golden's prepare builds one, then with it. */
export function installWrapper(home: string, xctestrun?: string): string {
  const bin = binDir(home);
  mkdirSync(bin, { recursive: true });
  const wrapper = join(bin, "agent-device");
  writeAtomic(wrapper, wrapperScript(entry(home), home, xctestrun));
  chmodSync(wrapper, 0o755);
  // Where an older node built the runner, before it moved into the package.
  rmSync(join(iosDir(home), "runner"), { recursive: true, force: true });
  return wrapper;
}

/**
 * The runner agent-device built in runnerDir for the simulator: its newest `.xctestrun`, not the copies it writes
 * beside it with one start's port (`AgentDeviceRunner.env.*`).
 */
export function builtXctestrun(home: string): string {
  const root = runnerDir(home);
  let best: { at: number; path: string } | undefined;
  const dirs = [root];
  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      const lower = name.toLowerCase();
      if (st.isDirectory()) dirs.push(path);
      else if (lower.endsWith(".xctestrun") && lower.includes("iphonesimulator") && !lower.startsWith("agentdevicerunner.env.")) {
        if (!best || st.mtimeMs > best.at || (st.mtimeMs === best.at && path > best.path)) best = { at: st.mtimeMs, path };
      }
    }
  }
  if (!best) throw new Error(`agent-device built no simulator runner in ${root}`);
  return best.path;
}

/** Writes the config of the agent-device home `dir`, naming the simulator `udid`. */
export function writeDevice(dir: string, udid: string): void {
  mkdirPrivate(dir);
  writeAtomic(join(dir, "config.json"), `${JSON.stringify({ platform: "ios", udid })}\n`);
}

/**
 * Points `thread`'s agent-device at its simulator, and its commands at the clone's own agent-device home (`lent`),
 * where the pool started the clone's runner, when it has one.
 */
export function writeConfig(home: string, thread: string, udid: string, lent?: string): void {
  const dir = sessionDir(home, thread);
  writeDevice(dir, udid);
  if (lent) writeAtomic(join(dir, LENT), lent);
  else rmSync(join(dir, LENT), { force: true });
}

/**
 * What an agent's commands get in their environment: the iOS wrapper first on PATH (it alone), its own agent-device
 * home and state, and the control and runner-starting files the wrapper checks.
 */
export function iosEnv(home: string, thread: string, path?: string): [string, string][] {
  const android = androidBin(home);
  const ios = binDir(home);
  const env: [string, string][] = [...agentEnv(home, thread, path), ["FLEETD_RUNNER_STARTING", startingPath(home, thread)]];
  return env.map(([k, v]): [string, string] => (k === "PATH" && v.startsWith(android) ? [k, `${ios}${v.slice(android.length)}`] : [k, v]));
}
