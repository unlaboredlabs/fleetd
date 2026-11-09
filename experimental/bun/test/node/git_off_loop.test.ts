// A worktree's git runs off the node's event loop: under load the Rust node's `git worktree add` took up to 52 s, and
// on Bun's one thread a git run in step would freeze the hub link and every session with it. A git that sleeps in its
// `worktree add` here must leave the node's timers on schedule and its heartbeats going out.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../../src/node/identity.ts";
import { runNode } from "../../src/node/link/index.ts";
import { SessionService } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

setDefaultTimeout(30_000);

/** How long the fake git's `worktree add` sleeps. */
const SLOW_MS = 1500;
const TICK_MS = 50;
const HEARTBEAT_MS = 100;

const realGit = Bun.which("git")!;
const path = process.env.PATH;
afterEach(() => {
  process.env.PATH = path;
});

const git = (cwd: string, ...args: string[]) => spawnSync(realGit, ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });

/** A hub that welcomes the node and notes when each heartbeat came. */
function hub() {
  const beats: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: (ws) => void ws.send(JSON.stringify({ t: "challenge", nonce: "nonce-1" })),
      message(ws, data) {
        const frame = JSON.parse(String(data));
        if (frame.t === "hello") ws.send(JSON.stringify({ t: "welcome", hubId: "fleetd-devbox", protocol: 1, capabilities: [] }));
        if (frame.t === "hb") beats.push(Date.now());
      },
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, beats, server };
}

test("a writer's launch whose git worktree add is slow leaves the node's timers and heartbeats on schedule", async () => {
  const home = tempHome();
  const repo = join(home.dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  // The git every node git finds first: as slow as a loaded machine's in its worktree add.
  const bin = join(home.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" worktree add "*) sleep ${SLOW_MS / 1000} ;; esac\nexec ${realGit} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${path}`;

  const fake = hub();
  const stop = new AbortController();
  void runNode({
    settings: { hub: fake.url, machineId: "devbox", name: "devbox", nodeVersion: "0.0.0" },
    identity: loadOrCreateIdentity(join(home.dir, "id")),
    boxPubKey: "M42kv2b+sf2LEsH+jqb0tkIekEvQajFZWTr1hqHYoRU=",
    capabilities: () => [],
    heartbeat: async () => ({}),
    heartbeatMs: HEARTBEAT_MS,
    attach: () => () => {},
    handle: () => {},
    log: () => {},
    signal: stop.signal,
  });
  const service = await SessionService.start({
    home: join(home.dir, "node"),
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    nativeBin: join(import.meta.dir, "fake-host.sh"),
  });
  let n = 0;
  const call = (op: string, args: Record<string, unknown>) => service.handle({ id: `c${++n}`, call: { op, ...args } as never });
  let last = performance.now();
  let worstGap = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
  }, TICK_MS);
  try {
    await call("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
    const launch = { sessionId: "w1", projectId: "p1", runtimeMode: "full-access", workspace: { type: "worktree", baseRef: "main", branch: "fleetd/T1-slow" }, prompt: "write it", runId: "r1", role: "worker" };
    const start = Date.now();
    last = performance.now();
    worstGap = 0;
    // A retry while the first makes its worktree shares its outcome: one session, one worktree.
    const [first, retry] = await Promise.all([call("launch", launch), call("launch", launch)]);
    const took = Date.now() - start;
    expect(took).toBeGreaterThanOrEqual(SLOW_MS);
    const summary = (first.result as { ok: { summary: { worktreePath: string; branch: string } } }).ok.summary;
    expect(summary.branch).toBe("fleetd/T1-slow");
    expect((retry.result as { ok: { summary: { worktreePath: string } } }).ok.summary.worktreePath).toBe(summary.worktreePath);
    // The timer fired on schedule throughout, and the hub heard the node all along.
    expect(worstGap).toBeLessThan(SLOW_MS / 3);
    const during = fake.beats.filter((at) => at >= start && at <= start + took);
    expect(during.length).toBeGreaterThanOrEqual(Math.floor(SLOW_MS / HEARTBEAT_MS / 2));
    expect(git(repo, "worktree", "list", "--porcelain").stdout.split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(2);
  } finally {
    clearInterval(ticker);
    await service.shutdown();
    stop.abort();
    fake.server.stop(true);
    home.done();
  }
});
