// A task restarted fresh goes on with its scratch dir: the files it kept in $TMPDIR (clones, worktrees, drafts) are
// still there in its new session, and through a node restart. They go only when the task can't come back: with its
// worktree, or, with none, a while after its last turn.
import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH_KEEP_MS, scratchKept, SessionService, type SessionConfig } from "../../src/node/sessions/index.ts";
import type { SessionRow } from "../../src/node/sessions/store.ts";
import { tempHome } from "../helpers.ts";

// The session host starts twice (sh, then bun), and the repo takes a git process a step: a loaded machine (CI, or a
// busy devbox) takes longer than bun's 5 s default.
setDefaultTimeout(30_000);

const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
const until = async <T>(what: string, fn: () => T | undefined | false, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};
const scratchName = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);

/** A node over a repo with an origin, its project p1 upserted. */
async function nodeKit() {
  const home = tempHome();
  const origin = join(home.dir, "origin.git");
  const repo = join(home.dir, "repo");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  const node = join(home.dir, "node");
  const config: SessionConfig = {
    home: node,
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    fleetd: [join(import.meta.dir, "fake-host.sh")],
  };
  const k = {
    home,
    node,
    service: await SessionService.start(config),
    scratch: (id: string) => join(node, "tmp", scratchName(id)),
    call: (op: string, args: Record<string, unknown>) => k.service.handle({ id: `c${++n}`, call: { op, ...args } as never }),
    done: (id: string, run: string) => () => k.service.store.session(id)?.summary.latestRun?.id === run && k.service.store.session(id)?.summary.latestRun?.status === "completed",
    launch: (sessionId: string, runId: string, workspace: Record<string, unknown> = { type: "worktree", baseRef: "main", branch: "fleetd/T1-feature" }) =>
      k.call("launch", { sessionId, projectId: "p1", runtimeMode: "full-access", workspace, prompt: "write it", runId, role: "worker" }),
    /** The node killed and started again: its sessions' processes go with it, as an automatic update's restart can. */
    restart: async (id: string) => {
      const pid = k.service.store.session(id)!.local.pid!;
      await k.service.shutdown();
      process.kill(pid, "SIGKILL");
      k.service = await SessionService.start(config);
    },
  };
  let n = 0;
  await k.call("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
  return k;
}

test("a task keeps its scratch dir across its sessions and a node restart, until its worktree goes", async () => {
  const k = await nodeKit();
  const { scratch, call, done, launch } = k;
  try {
    const launched = await launch("t1", "r1");
    const path = (launched.result as { ok: { summary: { worktreePath: string } } }).ok.summary.worktreePath;
    await until("the first run", done("t1", "r1"));
    mkdirSync(join(scratch("t1"), "clone"), { recursive: true });
    writeFileSync(join(scratch("t1"), "clone", "edit.txt"), "not committed\n");
    await call("stop", { sessionId: "t1", removeWorktree: false });
    expect(existsSync(join(scratch("t1"), "clone", "edit.txt"))).toBe(true);

    // Restarted fresh: the new session takes over the worktree, and the scratch dir with it.
    await launch("t2", "q1", { type: "worktree", baseRef: "main", branch: "fleetd/T1-feature", fromSession: "t1" });
    await until("the fresh session's run", done("t2", "q1"));
    expect(k.service.store.session("t2")?.summary.worktreePath).toBe(path);
    expect(k.service.store.session("t2")?.local.scratchOf).toBe("t1");
    expect(readFileSync(join(scratch("t1"), "clone", "edit.txt"), "utf8")).toBe("not committed\n");
    expect(existsSync(scratch("t2"))).toBe(false);

    // A node restart keeps it, and sweeps a dir no session uses.
    mkdirSync(join(k.node, "tmp", "left-behind"));
    await k.restart("t2");
    expect(existsSync(join(scratch("t1"), "clone", "edit.txt"))).toBe(true);
    expect(existsSync(join(k.node, "tmp", "left-behind"))).toBe(false);
    await call("send", { sessionId: "t2", runId: "q2", text: "go on" });
    await until("the resumed run", done("t2", "q2"));
    expect(existsSync(join(scratch("t1"), "clone", "edit.txt"))).toBe(true);

    // Its end removes its worktree, and the scratch dir with it.
    await call("stop", { sessionId: "t2", removeWorktree: true });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(scratch("t1"))).toBe(false);
  } finally {
    await k.service.stopAll();
    k.home.done();
  }
});

// Nov 12: T3085's PR merged while it waited to open its next one; the hub's removal of its worktree was refused (a
// commit not pushed), but its scratch dir, and the Postgres it ran there, went anyway, 22 s before it was continued.
test("a worktree kept for its work keeps its scratch dir; the removal that takes the worktree takes the scratch", async () => {
  const k = await nodeKit();
  const { scratch, call, done, launch } = k;
  try {
    const launched = await launch("t1", "r1");
    const path = (launched.result as { ok: { summary: { worktreePath: string } } }).ok.summary.worktreePath;
    await until("the run", done("t1", "r1"));
    writeFileSync(join(scratch("t1"), "pg.pid"), "4242\n");
    git(path, "commit", "-q", "--allow-empty", "-m", "the next PR");

    const refused = await call("stop", { sessionId: "t1", removeWorktree: true });
    expect((refused.result as { err?: { message: string } }).err?.message).toContain("1 commit(s) not pushed");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(join(scratch("t1"), "pg.pid"), "utf8")).toBe("4242\n");
    // Continued, it finds both as it left them.
    await call("send", { sessionId: "t1", runId: "r2", text: "the PR merged" });
    await until("the continued run", done("t1", "r2"));
    expect(readFileSync(join(scratch("t1"), "pg.pid"), "utf8")).toBe("4242\n");

    git(path, "push", "-q", "origin", "HEAD:fleetd/T1-feature");
    expect((await call("stop", { sessionId: "t1", removeWorktree: true })).result).toEqual({ ok: { kind: "done" } });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(scratch("t1"))).toBe(false);
  } finally {
    await k.service.stopAll();
    k.home.done();
  }
});

test("a session with no worktree keeps its scratch dir through a node restart while its process is gone", async () => {
  const k = await nodeKit();
  const { scratch, done, launch } = k;
  try {
    await launch("s1", "r1", { type: "root" });
    await until("the run", done("s1", "r1"));
    writeFileSync(join(scratch("s1"), "build.out"), "kept\n");
    await k.restart("s1");
    expect(k.service.store.session("s1")?.local.pid).toBeUndefined();
    expect(readFileSync(join(scratch("s1"), "build.out"), "utf8")).toBe("kept\n");
    // Its stop is its end: the scratch goes with its process, as before.
    await k.call("stop", { sessionId: "s1", removeWorktree: false });
    expect(existsSync(scratch("s1"))).toBe(false);
  } finally {
    await k.service.stopAll();
    k.home.done();
  }
});

test("the node's start keeps the scratch of every session that may come back, and only those", () => {
  const now = Date.parse("2026-11-12T07:20:00Z");
  const at = (ms: number) => new Date(ms).toISOString();
  const row = (sessionId: string, local: Record<string, unknown>, summary: Record<string, unknown> = {}): SessionRow =>
    ({ summary: { sessionId, updatedAt: at(now - 60_000), ...summary }, local }) as unknown as SessionRow;
  const rows = [
    // Between turns, its worktree there, however long ago its last turn.
    row("waiting", { baseRef: "main" }, { worktreePath: "/w/waiting", updatedAt: at(now - 30 * 86_400_000) }),
    // Restarted fresh: the dir of the session it took over.
    row("fresh", { baseRef: "main", scratchOf: "waiting" }, { worktreePath: "/w/waiting" }),
    // Its worktree removed: its task can't come back.
    row("removed", { baseRef: "main" }),
    // No worktree: kept SCRATCH_KEEP_MS after its last change, unless its process ran on through the restart.
    row("lead", {}, { updatedAt: at(now - SCRATCH_KEEP_MS + 60_000) }),
    row("idle", {}, { updatedAt: at(now - SCRATCH_KEEP_MS - 60_000) }),
    row("live", {}, { updatedAt: at(now - SCRATCH_KEEP_MS - 60_000) }),
  ];
  expect(scratchKept(rows, new Set(["live"]), now)).toEqual(new Set(["waiting", "lead", "live"].map(scratchName)));
});
