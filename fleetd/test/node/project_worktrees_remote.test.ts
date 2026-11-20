// project_worktrees (what Settings › Bots waits on before it paints) answers from the checkout alone: a remote that
// takes seconds to say its default branch never holds it. Its first read after a node start asked GitHub with
// ls-remote, 0.5-3.6 s.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionService } from "../../src/node/sessions/index.ts";
import { tempHome } from "../helpers.ts";

const home = tempHome();
const repo = join(home.dir, "repo");
let service: SessionService;
setDefaultTimeout(30_000);

const git = (...args: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });

beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "work");
  git("commit", "-q", "--allow-empty", "-m", "init");
  // The remote answers only after 8 s: its ssh is a stand-in that waits, then fails.
  const ssh = join(home.dir, "slow-ssh");
  writeFileSync(ssh, "#!/bin/sh\nsleep 8\nexit 1\n", { mode: 0o755 });
  git("remote", "add", "origin", "ssh://git@devbox.invalid/acme/app.git");
  git("config", "core.sshCommand", ssh);
  // What git recorded of the remote's HEAD when it was cloned.
  git("update-ref", "refs/remotes/origin/trunk", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  service = await SessionService.start({
    home: join(home.dir, "node"),
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath },
    claudeBin: "/bin/true",
    fleetd: [join(import.meta.dir, "fake-host.sh")],
    retryScheduleMs: [50, 50, 50],
    idleReapMs: 60_000,
  });
});

afterAll(async () => {
  await service.stopAll();
  home.done();
});

test("a bot's worktrees answer with its recorded default branch at once, not after asking its remote", async () => {
  await service.handle({ id: "c1", call: { op: "project_upsert", projectId: "p1", title: "app", workspaceRoot: repo } as never });
  const t = performance.now();
  const reply = await service.handle({ id: "c2", call: { op: "project_worktrees", projectId: "p1" } as never });
  const ms = performance.now() - t;
  expect(reply.result).toMatchObject({ ok: { kind: "project_worktrees", baseBranch: "trunk", worktrees: [] } });
  expect(ms).toBeLessThan(3_000);
});
