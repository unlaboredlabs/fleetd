// A writer's worktree hooks: its pushes wait for its repo's pre-push check, and its commits name its task.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchTask, gate, trailerHooks } from "../../src/node/worktree/hooks.ts";
import { tempHome } from "../helpers.ts";

const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("a writer's push goes only once the repo's pre-push check passed on its tree", async () => {
  const home = tempHome();
  try {
    const remote = join(home.dir, "remote.git");
    const repo = join(home.dir, "repo");
    spawnSync("git", ["init", "-q", "--bare", remote]);
    mkdirSync(join(repo, ".fleetd"), { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, ".fleetd/pre-push.json"), '{"check": "scripts/check.sh", "background": "scripts/check.sh --background", "wait": "scripts/check.sh --wait"}\n');
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "declare the check"]);
    git(repo, ["remote", "add", "origin", remote]);
    const env: Record<string, string> = {};
    await gate(repo, env);
    const refused = git(repo, ["push", "-q", "origin", "main"], env);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("fleetd: push refused: scripts/check.sh hasn't passed on main's tree at");
    expect(refused.stderr).toContain("Start `scripts/check.sh --background`, then wait for it with the Monitor tool running `scripts/check.sh --wait`");
    // The check passed on this tree: it goes.
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    appendFileSync(join(repo, ".git", "fleetd-checked"), `${tree}\n`);
    expect(git(repo, ["push", "-q", "origin", "main"], env).status).toBe(0);
    // Without the session's environment (a person's push) the gate isn't there.
    git(repo, ["commit", "-q", "--allow-empty", "-m", "unchecked"]);
    expect(git(repo, ["push", "-q", "origin", "main"]).status).toBe(0);
  } finally {
    home.done();
  }
});

test("a writer's commits name its task where the repo keeps per-worktree config", async () => {
  const home = tempHome();
  try {
    const repo = join(home.dir, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
    const wt = join(home.dir, "wt");
    git(repo, ["worktree", "add", "-q", "-b", "fleetd/T42-x", wt]);
    expect(await trailerHooks(wt, "T42")).toBe(false);
    git(repo, ["config", "extensions.worktreeConfig", "true"]);
    expect(await trailerHooks(wt, branchTask("fleetd/T42-x")!)).toBe(true);
    git(wt, ["commit", "-q", "--allow-empty", "-m", "work"]);
    expect(git(wt, ["log", "-1", "--format=%B"]).stdout).toContain("Fleetd-Task: T42");
    // The person's checkout keeps its hooks.
    git(repo, ["commit", "-q", "--allow-empty", "-m", "mine"]);
    expect(git(repo, ["log", "-1", "--format=%B"]).stdout).not.toContain("Fleetd-Task");
    expect(branchTask("fleetd/T0-x")).toBeUndefined();
    expect(branchTask("main")).toBeUndefined();
  } finally {
    home.done();
  }
});
