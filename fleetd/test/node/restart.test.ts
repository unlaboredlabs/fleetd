// A node restart with a session whose Monitor was lost ahead of one whose host ran on: the lost one is woken only once
// the start's sweep of hosts is done, so the sweep never stops the host its wake starts.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionService, type SessionConfig } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

const until = async <T>(what: string, fn: () => T | undefined | false, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

test("a session whose Monitor died with the last node is woken after the restart, and its wake runs", async () => {
  const home = tempHome();
  const repo = join(home.dir, "repo");
  mkdirSync(repo);
  spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  const config: SessionConfig = {
    home: join(home.dir, "node"),
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    fleetd: [join(import.meta.dir, "fake-host.sh")],
    retryScheduleMs: [50, 50, 50],
    idleReapMs: 60_000,
  };
  let service = await SessionService.start(config);
  try {
    let n = 0;
    const ok = async (op: string, args: Record<string, unknown>) => {
      const reply = await service.handle({ id: `c${++n}`, call: { op, ...args } as never });
      if (!("ok" in reply.result)) throw new Error(JSON.stringify(reply.result));
    };
    const launch = (sessionId: string, prompt: string) =>
      ok("launch", { sessionId, projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt, runId: `${sessionId}-r1` });
    await ok("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
    // The lost one is stored first, so the start reaches it before the one it re-adopts.
    await launch("a-lost", "monitor: wait for ci");
    const kept = ["b-kept", "c-kept", "d-kept"];
    for (const id of kept) await launch(id, "hello");
    const done = (id: string) => service.store.session(id)?.summary.latestRun?.status === "completed";
    await until("the first runs", () => done("a-lost") && kept.every(done) && service.store.session("a-lost")?.local.monitors?.length === 1);
    const lostPid = service.store.session("a-lost")!.local.pid!;
    // The node stops (its hosts run on), then the lost session's claude dies with no node to see it.
    await service.shutdown();
    process.kill(lostPid, "SIGKILL");
    // Gone before the node starts again, reaped: a kill lands a moment after it is sent, and a many-threaded host's
    // first thread shows as a zombie while the rest still hold its socket. A host still dying takes the new node's
    // connection, is re-adopted, and its exit then reads as claude's own.
    const reaped = () => {
      try {
        process.kill(lostPid, 0);
        return false;
      } catch {
        return true;
      }
    };
    await until("the lost session's host to be reaped", reaped);
    service = await SessionService.start(config);
    // The hub subscribes: the wakes the node held for it go.
    await service.handle({ id: "sub", call: { op: "subscribe" } as never });
    const woken = await until("the wake to complete", () =>
      service.store.runs("a-lost").find((r) => r.id.startsWith("a-lost-monitor-lost-") && r.status === "completed"),
    );
    expect(service.store.message("a-lost", woken.id)?.text).toBe(
      "Your Monitor \"ci\" was lost when this machine's fleetd node restarted. Check what you were waiting for again, and arm a new Monitor if you still need to wait.",
    );
    for (const id of kept) expect(service.store.runs(id).every((r) => r.status === "completed")).toBe(true);
  } finally {
    await service.stopAll();
    home.done();
  }
}, 20_000);

test("a Monitor whose time ran out while the node was away, with its claude gone, still wakes the session", async () => {
  const home = tempHome();
  const repo = join(home.dir, "repo");
  mkdirSync(repo);
  spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  const config: SessionConfig = {
    home: join(home.dir, "node"),
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    fleetd: [join(import.meta.dir, "fake-host.sh")],
    retryScheduleMs: [50, 50, 50],
    idleReapMs: 60_000,
  };
  let service = await SessionService.start(config);
  try {
    let n = 0;
    const ok = async (op: string, args: Record<string, unknown>) => {
      const reply = await service.handle({ id: `c${++n}`, call: { op, ...args } as never });
      if (!("ok" in reply.result)) throw new Error(JSON.stringify(reply.result));
    };
    await ok("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
    await ok("launch", { sessionId: "a-lost", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "monitor: wait for ci", runId: "a-lost-r1" });
    await until(
      "the first run",
      () => service.store.session("a-lost")?.summary.latestRun?.status === "completed" && service.store.session("a-lost")?.local.monitors?.length === 1,
    );
    const pid = service.store.session("a-lost")!.local.pid!;
    // The node goes away and stays away past the Monitor's deadline; its claude dies meanwhile, so no notice of it
    // ever reached the agent (an OOM, a machine down for an hour).
    service.update("a-lost", (c) => {
      for (const m of c.row.local.monitors ?? []) m.untilMs = Date.now() - 1;
    });
    await service.shutdown();
    process.kill(pid, "SIGKILL");
    await until("the host to be reaped", () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    service = await SessionService.start(config);
    // The hub subscribes: the wakes the node held for it go.
    await service.handle({ id: "sub", call: { op: "subscribe" } as never });
    const woken = await until("the wake to complete", () =>
      service.store.runs("a-lost").find((r) => r.id.startsWith("a-lost-monitor-lost-") && r.status === "completed"),
    );
    expect(service.store.message("a-lost", woken.id)?.text).toBe(
      "Your Monitor \"ci\" was lost when this machine's fleetd node restarted. Check what you were waiting for again, and arm a new Monitor if you still need to wait.",
    );
  } finally {
    await service.stopAll();
    home.done();
  }
}, 20_000);
