// node.area("launch"): what the screens' areas add to an agent's claude launch (Rust's browser SessionHooks env and
// plugin_dirs), for a lead's or a worker's session and never a plain one.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LaunchArea } from "../../src/node/api.ts";
import { SessionService } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

const until = async (what: string, fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

test("the parts' variables merge in order, each given the PATH so far, and their plugin folders once each", () => {
  const launch = new LaunchArea();
  const paths: (string | undefined)[] = [];
  launch.contribute({ env: (thread, path) => (paths.push(path), [["PATH", `/browser:${path}`], ["AGENT_BROWSER_SESSION", thread]]) });
  launch.contribute({ env: (_thread, path) => (paths.push(path), [["PATH", `/device:${path}`]]), pluginDirs: () => ["/plugins/device", "/plugins/browser"] });
  launch.contribute({ pluginDirs: () => ["/plugins/browser"] });
  launch.contribute({ env: () => { throw new Error("broken part"); } });
  expect(launch.env("t1", "/usr/bin")).toEqual([["PATH", "/device:/browser:/usr/bin"], ["AGENT_BROWSER_SESSION", "t1"]]);
  expect(paths).toEqual(["/usr/bin", "/browser:/usr/bin"]);
  expect(launch.pluginDirs()).toEqual(["/plugins/device", "/plugins/browser"]);
});

test("a worker's launch gets the areas' variables and plugin folders; a plain session's gets neither", async () => {
  const home = tempHome();
  const repo = join(home.dir, "repo");
  mkdirSync(repo);
  const nodeHome = join(home.dir, "node");
  // The host as the node launches it, its arguments and environment kept beside its dir.
  const host = join(home.dir, "recording-host");
  writeFileSync(host, `#!/bin/sh\nprintf '%s\\n' "$@" > "$2.argv"\nenv > "$2.env"\nexec "${join(import.meta.dir, "fake-host.sh")}" "$@"\n`);
  chmodSync(host, 0o755);
  const service = await SessionService.start({
    home: nodeHome,
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    fleetd: [host],
  });
  const launch = new LaunchArea();
  launch.contribute({ env: (thread, path) => [["PATH", `/screens/bin:${path}`], ["ANDROID_SERIAL", `emulator-${thread}`]], pluginDirs: () => ["/screens/agent-device"] });
  service.launch = launch;
  let n = 0;
  const call = (op: string, args: Record<string, unknown>) => service.handle({ id: `c${++n}`, call: { op, ...args } as never });
  try {
    await call("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
    for (const [sessionId, role] of [["w1", "worker"], ["s1", undefined]] as const) {
      await call("launch", { sessionId, projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hi", runId: `r-${sessionId}`, ...(role ? { role } : {}) });
      await until(`${sessionId}'s run`, () => service.store.session(sessionId)?.summary.latestRun?.status === "completed");
    }
    const read = (id: string, what: string) => readFileSync(join(nodeHome, "hosts", `${id}.${what}`), "utf8").split("\n");
    const pluginDirs = (argv: string[]) => argv.flatMap((a, i) => (a === "--plugin-dir" ? [argv[i + 1]] : []));
    const worker = read("w1", "env");
    expect(worker).toContain("ANDROID_SERIAL=emulator-w1");
    expect(worker.find((l) => l.startsWith("PATH="))).toStartWith("PATH=/screens/bin:");
    expect(pluginDirs(read("w1", "argv"))).toContain("/screens/agent-device");
    const plain = read("s1", "env");
    expect(plain.some((l) => l.startsWith("ANDROID_SERIAL="))).toBe(false);
    expect(plain.find((l) => l.startsWith("PATH="))).not.toContain("/screens/bin");
    expect(pluginDirs(read("s1", "argv"))).not.toContain("/screens/agent-device");
  } finally {
    await service.stopAll();
    home.done();
  }
  // Each launch starts a host process (sh, then bun): a loaded machine takes longer than bun's 5 s default.
}, 30_000);
