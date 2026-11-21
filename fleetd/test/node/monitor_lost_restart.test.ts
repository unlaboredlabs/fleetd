// The devbox on 2026-11-21: the user's service manager stopped every agent's scope and the node at once. An idle
// agent's Monitor script died first, claude queued its notice and was killed before any turn took it, and the node
// went before it could wake the agent. The next node, hours later, must still wake that agent, once, and say its
// Monitor was lost in the restart; one whose Monitor ran on through the restart is left alone.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const LOST = `Your Monitor "ci" was lost when this machine's fleetd node restarted. Check what you were waiting for again, and arm a new Monitor if you still need to wait.`;

function fleet(heldWakeMs?: number) {
  const home = tempHome();
  const repo = join(home.dir, "repo");
  mkdirSync(repo);
  spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  // What starting a session does while the machine's service manager is going down: nothing starts.
  const refused = join(home.dir, "refused-host.sh");
  writeFileSync(refused, "#!/bin/sh\nexit 1\n");
  chmodSync(refused, 0o755);
  const host = join(import.meta.dir, "fake-host.sh");
  const config: SessionConfig = {
    home: join(home.dir, "node"),
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    fleetd: [host],
    retryScheduleMs: [50, 50, 50],
    idleReapMs: 60_000,
    ...(heldWakeMs !== undefined ? { heldWakeMs } : {}),
  };
  return { home, repo, config, host, refused };
}

async function client(service: () => SessionService) {
  let n = 0;
  return async (op: string, args: Record<string, unknown> = {}) => {
    const reply = await service().handle({ id: `c${++n}`, call: { op, ...args } as never });
    if (!("ok" in reply.result)) throw new Error(JSON.stringify(reply.result));
  };
}

const wakes = (service: SessionService, id: string) => service.store.runs(id).filter((r) => r.id.startsWith(`${id}-monitor-lost-`));

/** The 18:01:58 stop: the idle agent's scope is stopped while the node still runs, but nothing can start any more,
 * so the wake the node tries never reaches claude; then the node goes too. */
async function machineSessionStops(service: SessionService, f: ReturnType<typeof fleet>, id: string) {
  const pid = service.store.session(id)!.local.pid!;
  f.config.fleetd = [f.refused];
  process.kill(pid, "SIGTERM");
  await until("the stopped claude's exit", () => !service.store.session(id)?.local.pid && gone(pid));
  await Bun.sleep(100);
  expect(wakes(service, id).some((r) => r.status === "completed")).toBe(false);
  await service.shutdown();
  f.config.fleetd = [f.host];
}

test("an agent whose Monitor died as the machine's session stopped is woken once the node is back and its hub subscribes", async () => {
  const f = fleet(60_000);
  let service = await SessionService.start(f.config);
  const ok = await client(() => service);
  try {
    await ok("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: f.repo });
    await ok("launch", { sessionId: "a-lost", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "monitor: wait for ci", runId: "a-lost-r1" });
    await until("the turn that armed it", () => service.store.session("a-lost")?.summary.latestRun?.status === "completed" && service.store.session("a-lost")?.local.monitors?.length === 1);
    await machineSessionStops(service, f, "a-lost");

    service = await SessionService.start(f.config);
    // Held for the hub: it hands out fresh GitHub tokens before it subscribes.
    await Bun.sleep(200);
    expect(wakes(service, "a-lost").filter((r) => r.status !== "failed")).toEqual([]);
    await ok("subscribe", {});
    const woken = await until("the wake to complete", () => wakes(service, "a-lost").find((r) => r.status === "completed"));
    expect(service.store.message("a-lost", woken.id)?.text).toBe(LOST);
    expect(service.store.session("a-lost")?.local.monitors).toBeUndefined();

    // Told once: the next restart, and the next subscription, wake nobody.
    await service.shutdown();
    service = await SessionService.start(f.config);
    await ok("subscribe", {});
    await Bun.sleep(300);
    expect(wakes(service, "a-lost").filter((r) => r.status === "completed").length).toBe(1);
    expect(service.store.runs("a-lost").filter((r) => r.status !== "failed").length).toBe(2);
  } finally {
    await service.stopAll();
    f.home.done();
  }
}, 30_000);

test("with the hub away too, the restarted node wakes it by itself after its wait; one whose Monitor ran on is not woken", async () => {
  const f = fleet(600);
  let service = await SessionService.start(f.config);
  const ok = await client(() => service);
  try {
    await ok("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: f.repo });
    for (const id of ["a-lost", "b-alive"])
      await ok("launch", { sessionId: id, projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "monitor: wait for ci", runId: `${id}-r1` });
    const armed = (id: string) => service.store.session(id)?.summary.latestRun?.status === "completed" && service.store.session(id)?.local.monitors?.length === 1;
    await until("the turns that armed them", () => armed("a-lost") && armed("b-alive"));
    await machineSessionStops(service, f, "a-lost");

    // The node comes back with no hub to subscribe: b-alive's host ran on, and is re-adopted with its Monitor.
    service = await SessionService.start(f.config);
    expect(service.store.session("b-alive")?.local.monitors?.length).toBe(1);
    await Bun.sleep(200);
    expect(wakes(service, "a-lost").filter((r) => r.status !== "failed")).toEqual([]);
    const woken = await until("the wake to complete", () => wakes(service, "a-lost").find((r) => r.status === "completed"));
    expect(service.store.message("a-lost", woken.id)?.text).toBe(LOST);
    // The hub back later subscribes: nobody is woken again.
    await ok("subscribe", {});
    await Bun.sleep(300);
    expect(wakes(service, "a-lost").filter((r) => r.status === "completed").length).toBe(1);
    expect(wakes(service, "b-alive")).toEqual([]);
    expect(service.store.session("b-alive")?.local.monitors?.length).toBe(1);
  } finally {
    await service.stopAll();
    f.home.done();
  }
}, 30_000);
