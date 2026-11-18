// A session's worktree is locked for its life, so a `git worktree prune` run where its folder isn't seen leaves its
// record in the repo's git dir. An agent's VM sees only the shared git dir and its own worktree: on 2026-11-18 one
// agent's `git worktree prune` in its VM dropped every other running agent's record, and their git stopped working.
// Here the folder is moved aside while the prune runs, which is what git sees from such a VM.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ensure, ensureDetached, lock, LOCK_REASON, remove, removeDetached, restore } from "../../src/node/worktree/index.ts";
import { tempHome } from "../helpers.ts";

const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
const repo = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
};
/** `git worktree prune` from a view where `path` isn't there. */
const pruneUnseen = (root: string, path: string) => {
  renameSync(path, `${path}.away`);
  git(root, "worktree", "prune");
  renameSync(`${path}.away`, path);
};
const works = (path: string) => git(path, "status", "--porcelain").status === 0;

test("a writer's and a reader's worktrees keep their records through a prune that can't see them", async () => {
  const home = tempHome();
  try {
    const root = repo(join(home.dir, "repo"));
    const writer = join(home.dir, "worktrees", "w");
    const reader = join(home.dir, "worktrees", "r");
    await ensure(root, writer, "fleetd/T1-x", "main");
    await ensureDetached(root, reader, "main");
    expect(git(root, "worktree", "list", "--porcelain").stdout.split(`locked ${LOCK_REASON}`).length - 1).toBe(2);
    pruneUnseen(root, writer);
    pruneUnseen(root, reader);
    expect(works(writer)).toBe(true);
    expect(works(reader)).toBe(true);
    // The node still removes them at their session's end.
    expect(await remove(root, writer, "fleetd/T1-x", "main")).toBe(true);
    await removeDetached(root, reader);
    expect(existsSync(writer) || existsSync(reader)).toBe(false);
    expect(git(root, "worktree", "list", "--porcelain").stdout).not.toContain("worktrees/");
  } finally {
    home.done();
  }
});

test("a worktree made before locks is locked at its session's next start, and a locked one whose folder is gone comes back", async () => {
  const home = tempHome();
  try {
    const root = repo(join(home.dir, "repo"));
    const path = join(home.dir, "worktrees", "w");
    mkdirSync(join(home.dir, "worktrees"));
    git(root, "worktree", "add", "-q", "-b", "fleetd/T2-y", path);
    await lock(root, path);
    await lock(root, path);
    await lock(root, root);
    pruneUnseen(root, path);
    expect(works(path)).toBe(true);
    // Its folder deleted, its record kept by the lock: restore takes the record and makes the worktree again.
    renameSync(path, `${path}.gone`);
    await restore(root, path, "fleetd/T2-y", { kind: "local" });
    expect(works(path)).toBe(true);
    expect(git(root, "worktree", "list", "--porcelain").stdout).toContain(`locked ${LOCK_REASON}`);
  } finally {
    home.done();
  }
});
