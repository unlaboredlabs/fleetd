// A task restarted fresh goes on with its scratch dir: the files it kept in $TMPDIR (clones, worktrees, drafts) are
// still there in its new session, and through a node restart. They go only when the task ends, with its worktree.
import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionService, type SessionConfig } from "../../src/node/sessions/index.ts";
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

test("a task keeps its scratch dir across its sessions and a node restart, until its worktree goes", async () => {
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
  const scratch = (id: string) => join(node, "tmp", createHash("sha256").update(id).digest("hex").slice(0, 16));
  let service = await SessionService.start(config);
  let n = 0;
  const call = (op: string, args: Record<string, unknown>) => service.handle({ id: `c${++n}`, call: { op, ...args } as never });
  const done = (id: string, run: string) => () => service.store.session(id)?.summary.latestRun?.id === run && service.store.session(id)?.summary.latestRun?.status === "completed";
  const launch = (sessionId: string, runId: string, fromSession?: string) =>
    call("launch", {
      sessionId,
      projectId: "p1",
      runtimeMode: "full-access",
      workspace: { type: "worktree", baseRef: "main", branch: "fleetd/T1-feature", ...(fromSession ? { fromSession } : {}) },
      prompt: "write it",
      runId,
      role: "worker",
    });
  try {
    await call("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
    const launched = await launch("t1", "r1");
    const path = (launched.result as { ok: { summary: { worktreePath: string } } }).ok.summary.worktreePath;
    await until("the first run", done("t1", "r1"));
    mkdirSync(join(scratch("t1"), "clone"), { recursive: true });
    writeFileSync(join(scratch("t1"), "clone", "edit.txt"), "not committed\n");
    await call("stop", { sessionId: "t1", removeWorktree: false });
    expect(existsSync(join(scratch("t1"), "clone", "edit.txt"))).toBe(true);

    // Restarted fresh: the new session takes over the worktree, and the scratch dir with it.
    await launch("t2", "q1", "t1");
    await until("the fresh session's run", done("t2", "q1"));
    expect(service.store.session("t2")?.summary.worktreePath).toBe(path);
    expect(service.store.session("t2")?.local.scratchOf).toBe("t1");
    expect(readFileSync(join(scratch("t1"), "clone", "edit.txt"), "utf8")).toBe("not committed\n");
    expect(existsSync(scratch("t2"))).toBe(false);

    // A node restart keeps it, and sweeps a dir no session uses.
    mkdirSync(join(node, "tmp", "left-behind"));
    const pid = service.store.session("t2")!.local.pid!;
    await service.shutdown();
    process.kill(pid, "SIGKILL");
    service = await SessionService.start(config);
    expect(existsSync(join(scratch("t1"), "clone", "edit.txt"))).toBe(true);
    expect(existsSync(join(node, "tmp", "left-behind"))).toBe(false);
    await call("send", { sessionId: "t2", runId: "q2", text: "go on" });
    await until("the resumed run", done("t2", "q2"));
    expect(existsSync(join(scratch("t1"), "clone", "edit.txt"))).toBe(true);

    // Its end removes its worktree, and the scratch dir with it.
    await call("stop", { sessionId: "t2", removeWorktree: true });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(scratch("t1"))).toBe(false);
  } finally {
    await service.stopAll();
    home.done();
  }
});
