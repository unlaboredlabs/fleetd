// A start's stages (stages.rs): a slow one says where its time went at info, and the node's launch and spawn time the
// same stages as the Rust node's, so a slow start on either reads the same in node.log.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionService } from "../../src/node/sessions/index.ts";
import { SLOW_MS, Stages } from "../../src/shared/stages.ts";
import { tempHome } from "../helpers.ts";

const until = async (what: string, fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

const logLevel = process.env.FLEETD_LOG;
afterEach(() => {
  if (logLevel === undefined) delete process.env.FLEETD_LOG;
  else process.env.FLEETD_LOG = logLevel;
});

test("a slow start logs each stage's time in order at info; a quick one logs nothing", () => {
  delete process.env.FLEETD_LOG;
  let at = 0;
  const lines: string[] = [];
  const slow = new Stages("node launch", "s1", () => at, (l) => lines.push(l));
  at += 1200;
  slow.done("fetch");
  at += SLOW_MS;
  slow.done("worktree");
  slow.end();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(" INFO slow start ");
  expect(JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{")))).toEqual({ start: "node launch", id: "s1", totalMs: 1200 + SLOW_MS, stages: `fetch 1200 ms, worktree ${SLOW_MS} ms` });

  const quick = new Stages("node launch", "s2", () => at, (l) => lines.push(l));
  at += SLOW_MS - 1;
  quick.done("fetch");
  quick.end();
  expect(lines).toHaveLength(1);
});

test("a worker's launch and its claude's spawn time the Rust node's stages", async () => {
  process.env.FLEETD_LOG = "debug";
  const home = tempHome();
  const repo = join(home.dir, "repo");
  mkdirSync(repo);
  const service = await SessionService.start({
    home: join(home.dir, "node"),
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    fleetd: [join(import.meta.dir, "fake-host.sh")],
  });
  const stages: Record<string, string[]> = {};
  const log = console.log;
  console.log = (...args: unknown[]) => {
    const line = String(args[0]);
    if (line.includes(" DEBUG start stage ")) {
      const s = JSON.parse(line.slice(line.indexOf("{"))) as { start: string; id: string; stage: string };
      if (s.id === "w1") (stages[s.start] ??= []).push(s.stage);
    }
    log(...args);
  };
  let n = 0;
  const call = (op: string, args: Record<string, unknown>) => service.handle({ id: `c${++n}`, call: { op, ...args } as never });
  try {
    await call("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
    await call("launch", { sessionId: "w1", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hi", runId: "r1", role: "worker" });
    await until("w1's run", () => service.store.session("w1")?.summary.latestRun?.status === "completed");
  } finally {
    console.log = log;
    await service.stopAll();
    home.done();
  }
  expect(stages["node launch"]).toEqual(["checks", "fetch", "worktree", "store", "record", "run"]);
  expect(stages["node spawn"]?.slice(0, 4)).toEqual(["spawn lock", "worktree", "spec", "session host"]);
  // The host starts as sh, then bun: a loaded machine takes longer than bun's 5 s default.
}, 30_000);
