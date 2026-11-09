// A node's part in scope-restart.test.ts, run as a systemd user service the way fleetd-node runs (KillMode=mixed):
// `bun scope-node.ts <dir> <scoped|unscoped> <host exe>`. It starts one session's host with the node's own launch
// (src/node/runner/host.ts, its scope from src/node/runner/scope.ts, or none), or re-adopts the host a previous run
// left, as the node's sessions do at start, writes which in <dir>, then idles until its service stops.
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostLink, launch, readRegistration } from "../../src/node/runner/host.ts";
import { current } from "../../src/node/runner/scope.ts";

const [dir = "", mode = "", exe = ""] = process.argv.slice(2);
const hostDir = join(dir, "host");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Writes <dir>/<name> whole: the test reads it as soon as it exists. */
const note = (name: string, pid: number) => {
  writeFileSync(join(dir, `${name}.tmp`), String(pid));
  renameSync(join(dir, `${name}.tmp`), join(dir, name));
};
const left = readRegistration(hostDir);
if (left && alive(left.hostPid)) {
  await HostLink.connect(hostDir);
  note("adopted", left.hostPid);
} else {
  const scope = mode === "scoped" ? await current() : undefined;
  if (mode === "scoped" && !scope) throw new Error("no systemd scope here");
  await launch({ fleetd: [exe], dir: hostDir, sessionId: "s1", program: "claude", args: [], cwd: dir, env: { PATH: process.env.PATH ?? "" }, ...(scope ? { scope } : {}) });
  const pid = readRegistration(hostDir)?.hostPid;
  if (!pid) throw new Error("the host came up without a registration");
  note("launched", pid);
}
setInterval(() => {}, 60_000);
