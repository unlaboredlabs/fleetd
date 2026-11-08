// A writer's worktree that is gone after a crash comes back at the same path when its session next starts: from what
// it pushed when its local branch is gone too, and the agent hears so first.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionService, type SessionConfig } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

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

test("a task whose worktree and branch were lost in a crash resumes from origin/fleetd/T1-…, in a worktree at the same path", async () => {
  const home = tempHome();
  const origin = join(home.dir, "origin.git");
  const repo = join(home.dir, "repo");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  const config: SessionConfig = {
    home: join(home.dir, "node"),
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    nativeBin: join(import.meta.dir, "fake-host.sh"),
  };
  let service = await SessionService.start(config);
  let n = 0;
  const call = (op: string, args: Record<string, unknown>) => service.handle({ id: `c${++n}`, call: { op, ...args } as never });
  try {
    await call("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
    const launched = await call("launch", {
      sessionId: "t1",
      projectId: "p1",
      runtimeMode: "full-access",
      workspace: { type: "worktree", baseRef: "main", branch: "fleetd/T1-feature" },
      prompt: "write it",
      runId: "r1",
      role: "worker",
    });
    const path = (launched.result as { ok: { summary: { worktreePath: string } } }).ok.summary.worktreePath;
    await until("the first run", () => service.store.session("t1")?.summary.latestRun?.status === "completed");
    // The writer's work, pushed.
    writeFileSync(join(path, "work.txt"), "pushed work\n");
    git(path, "add", "work.txt");
    git(path, "commit", "-q", "-m", "work");
    git(path, "push", "-q", "origin", "fleetd/T1-feature");
    // The crash: the node goes with its session's claude, and the worktree and its branch are lost.
    const pid = service.store.session("t1")!.local.pid!;
    await service.shutdown();
    process.kill(pid, "SIGKILL");
    rmSync(path, { recursive: true, force: true });
    git(repo, "worktree", "prune");
    git(repo, "branch", "-D", "fleetd/T1-feature");
    git(repo, "update-ref", "-d", "refs/remotes/origin/fleetd/T1-feature");
    service = await SessionService.start(config);
    const sent = await call("send", { sessionId: "t1", runId: "r2", text: "go on" });
    expect(sent.result).toMatchObject({ ok: { kind: "sent" } });
    await until("the resumed run", () => service.store.session("t1")?.summary.latestRun?.id === "r2" && service.store.session("t1")?.summary.latestRun?.status === "completed");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(join(path, "work.txt"), "utf8")).toBe("pushed work\n");
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim()).toBe("fleetd/T1-feature");
    expect(service.store.session("t1")?.summary).toMatchObject({ recreatedFrom: "remote", worktreePath: path, branch: "fleetd/T1-feature" });
    // The agent heard first that its worktree came back from what it pushed.
    const [messages] = service.store.newestMessages("t1", 10);
    expect(messages.at(-1)?.text).toStartWith("ok: fleetd: your worktree and its local branch were gone, so the worktree was recreated at the same path from origin/fleetd/T1-feature");
  } finally {
    await service.stopAll();
    home.done();
  }
});
