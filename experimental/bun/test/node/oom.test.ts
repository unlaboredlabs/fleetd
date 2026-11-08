// The node outlives memory pressure (Rust's oom.rs, #1293): it lowers its own OOM score as far as it may, every
// session's host (and so its claude and all it starts) starts at the agent score, a killed node's scratch dirs go at
// the next start, and a node service with no config yet waits for one rather than exiting.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT, SERVICE, agentScoreLine, agentSpawn, lowest, score } from "../../src/node/oom.ts";
import { enrolled, enrolledRetry } from "../../src/node/index.ts";
import { SessionService } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

const linux = process.platform === "linux" && existsSync("/proc/self/oom_score_adj");

test("a service goes as low as it may and never up", () => {
  // Under systemd's user manager: nothing below 100.
  expect(lowest(200, (adj) => adj >= 100)).toBe(100);
  expect(lowest(200, () => true)).toBe(SERVICE);
  // No manager: the 0 every process starts with is the floor.
  expect(lowest(0, (adj) => adj >= 0)).toBe(0);
  // Already lower: nothing is written.
  expect(lowest(-1000, () => { throw new Error("wrote a score"); })).toBe(-1000);
  expect(lowest(300, () => false)).toBe(300);
});

test.if(linux)("an agent's process starts at the agent score, with its own pid, and one that isn't there fails as it would", () => {
  const [exe, args] = agentSpawn("/bin/cat", ["/proc/self/oom_score_adj"]);
  expect(spawnSync(exe, args, { encoding: "utf8" }).stdout.trim()).toBe(String(AGENT));
  expect(agentSpawn("/no/such/host", ["x"])).toEqual(["/no/such/host", ["x"]]);
  // What the node starts through a shell anyway (Chrome, a desktop's apps) takes the score from its line.
  expect(spawnSync("/bin/sh", ["-c", `${agentScoreLine()}exec cat /proc/self/oom_score_adj`], { encoding: "utf8" }).stdout.trim()).toBe(String(AGENT));
});

test.if(linux)("a session's host starts at the agent score; a killed node's scratch dirs go at the next start", async () => {
  const home = tempHome();
  const repo = join(home.dir, "repo");
  mkdirSync(repo);
  const nodeHome = join(home.dir, "node");
  const stale = join(nodeHome, "tmp", "0123456789abcdef");
  mkdirSync(join(stale, "playwright-download"), { recursive: true });
  const service = await SessionService.start({
    home: nodeHome,
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    nativeBin: join(import.meta.dir, "fake-host.sh"),
  });
  try {
    expect(existsSync(stale)).toBe(false);
    await service.handle({ id: "c1", call: { op: "project_upsert", projectId: "p1", title: "demo", workspaceRoot: repo } as never });
    await service.handle({
      id: "c2",
      call: { op: "launch", sessionId: "s1", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hi", runId: "r1", role: "worker" } as never,
    });
    const until = Date.now() + 10_000;
    while (service.store.session("s1")?.summary.latestRun?.status !== "completed" && Date.now() < until) await Bun.sleep(20);
    const { hostPid } = JSON.parse(readFileSync(join(nodeHome, "hosts", "s1", "host.json"), "utf8"));
    expect([hostPid, score(hostPid)]).toEqual([hostPid, AGENT]);
  } finally {
    await service.stopAll();
    home.done();
  }
}, 20_000);

test("a node service with no config waits for one, doubling to five minutes; run by hand it says so at once", async () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(enrolledRetry)).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300].map((s) => s * 1000));
  const home = tempHome();
  try {
    expect(await enrolled(home.dir, false)).toBe(1);
    const stop = new AbortController();
    const waiting = enrolled(home.dir, true, stop.signal);
    await Bun.sleep(50);
    stop.abort();
    expect(await waiting).toBe(0);
    writeFileSync(join(home.dir, "node.json"), JSON.stringify({ hub: "http://devbox:4790", machineId: "devbox", name: "devbox", enrolled: true }));
    expect(await enrolled(home.dir, true)).toMatchObject({ machineId: "devbox" });
  } finally {
    home.done();
  }
});
