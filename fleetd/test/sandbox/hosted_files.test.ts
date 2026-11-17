// A hosted box's files (src/node/sandbox/remote/files.ts) with a stand-in box on this machine whose paths sit under a
// dir of its own: the worktree goes in as it is here (commits not on origin, uncommitted and untracked work, not
// what's ignored), at the same path and git dir, with fleetd's own files of its git dir; the box's work comes back
// as commits and uncommitted changes; a launch's named files are mirrored; a chat file is read under the machine's
// rules.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunOutcome } from "../../src/node/cmd/index.ts";
import { mirror, named, readChatFile, syncIn, syncOut, type BoxFs } from "../../src/node/sandbox/remote/files.ts";

const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-hosted-files-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HOME = join(tmp, "box-home");
mkdirSync(HOME, { recursive: true });
const ENV = { HOME, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1" };

function sh(cwd: string, cmd: string): string {
  const r = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`);
  return r.stdout.toString().replace(/\n+$/, "");
}

/** A box on this machine: its commands run here, its files are this machine's (paths already under its root). */
const local: BoxFs = {
  async run(r): Promise<RunOutcome> {
    const p = Bun.spawnSync(r.argv, { cwd: r.cwd, env: { ...(r.env as Record<string, string>), GIT_AUTHOR_NAME: "box", GIT_AUTHOR_EMAIL: "box@x", GIT_COMMITTER_NAME: "box", GIT_COMMITTER_EMAIL: "box@x" } });
    return { exitCode: p.exitCode, outputTail: p.stdout.toString() + p.stderr.toString(), timedOut: false };
  },
  async write(path, bytes) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  },
  async read(path, max) {
    const b = readFileSync(path);
    if (b.length > max) throw new Error(`${path} in the box is larger than ${max} bytes`);
    return new Uint8Array(b);
  },
};

test("the worktree goes into the box as it is here, and the box's work comes back", async () => {
  const origin = join(tmp, "origin.git");
  sh(tmp, `git init -q --bare -b main ${origin}`);
  const seed = join(tmp, "seed");
  sh(tmp, `git clone -q ${origin} ${seed}`);
  writeFileSync(join(seed, "a.txt"), "a\n");
  writeFileSync(join(seed, "gone.txt"), "x\n");
  writeFileSync(join(seed, ".gitignore"), "node_modules/\n");
  sh(seed, "git add -A && git commit -qm one && git push -q origin HEAD:main");
  const repo = join(tmp, "checkout");
  sh(tmp, `git clone -q ${origin} ${repo}`);
  sh(repo, "git config extensions.worktreeConfig true");
  const cwd = join(tmp, "worktrees", "T1-thing");
  sh(repo, `git worktree add -q -b fleetd/T1-thing ${cwd} origin/main`);
  // Work here: a commit origin hasn't, a staged change, an untracked file, a deleted one, an ignored dir.
  writeFileSync(join(cwd, "b.txt"), "b\n");
  sh(cwd, "git add b.txt && git commit -qm two");
  writeFileSync(join(cwd, "a.txt"), "a changed\n");
  sh(cwd, "git add a.txt");
  writeFileSync(join(cwd, "new.txt"), "untracked\n");
  rmSync(join(cwd, "gone.txt"));
  mkdirSync(join(cwd, "node_modules"));
  writeFileSync(join(cwd, "node_modules", "big.js"), "ignored\n");
  const gitDir = sh(cwd, "git rev-parse --absolute-git-dir");
  mkdirSync(join(gitDir, "fleetd-hooks"));
  writeFileSync(join(gitDir, "fleetd-hooks", "prepare-commit-msg"), "#!/bin/sh\n");
  const head = sh(cwd, "git rev-parse HEAD");

  const root = join(tmp, "box");
  const base = await syncIn(local, { cwd, session: "s1", env: ENV, root });
  expect(base).toBe(head);
  const there = root + cwd;
  expect(sh(there, "git rev-parse HEAD")).toBe(head);
  expect(sh(there, "git symbolic-ref --short HEAD")).toBe("fleetd/T1-thing");
  expect(readFileSync(join(there, "a.txt"), "utf8")).toBe("a changed\n");
  expect(readFileSync(join(there, "new.txt"), "utf8")).toBe("untracked\n");
  expect(existsSync(join(there, "gone.txt"))).toBe(false);
  expect(existsSync(join(there, "node_modules"))).toBe(false);
  expect(sh(there, "git status --porcelain").split("\n").sort()).toEqual([" D gone.txt", " M a.txt", "?? new.txt"]);
  // The same git dir as here, with fleetd's own files in it; its origin is the checkout's.
  expect(sh(there, "git rev-parse --absolute-git-dir")).toBe(root + gitDir);
  expect(existsSync(join(root + gitDir, "fleetd-hooks", "prepare-commit-msg"))).toBe(true);
  expect(sh(there, "git remote get-url origin")).toBe(origin);
  // No sync ref is left behind here.
  expect(sh(repo, "git for-each-ref refs/fleetd")).toBe("");

  // The agent works in the box.
  writeFileSync(join(there, "c.txt"), "c\n");
  sh(there, "git add -A && git commit -qm three");
  writeFileSync(join(there, "b.txt"), "b changed in the box\n");
  writeFileSync(join(there, "loose.txt"), "loose\n");
  const boxHead = sh(there, "git rev-parse HEAD");

  await syncOut(local, { cwd, session: "s1", base, env: ENV, root });
  expect(sh(cwd, "git rev-parse HEAD")).toBe(boxHead);
  expect(sh(cwd, "git log --format=%s -3").split("\n")).toEqual(["three", "two", "one"]);
  expect(sh(cwd, "git status --porcelain").split("\n").sort()).toEqual([" M b.txt", "?? loose.txt"]);
  expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("b changed in the box\n");
  // What the box committed (its `git add -A` took the untracked file and the deletion) is committed here.
  expect(readFileSync(join(cwd, "new.txt"), "utf8")).toBe("untracked\n");
  expect(existsSync(join(cwd, "gone.txt"))).toBe(false);
  // What's ignored stays as it was here.
  expect(existsSync(join(cwd, "node_modules", "big.js"))).toBe(true);
  expect(sh(repo, "git for-each-ref refs/fleetd")).toBe("");
});

test("a launch's files under the node's home are mirrored, but what has its own way in", async () => {
  const home = join(tmp, "node-home");
  for (const d of ["sessions/s1/skills", "browser/agent-browser/bin", "tmp/abc", "hosts/s1", "build-slots/bin", "orders/p"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "sessions/s1/mcp.json"), "{}");
  writeFileSync(join(home, "sessions/s1/settings.json"), "{}");
  writeFileSync(join(home, "browser/agent-browser/bin/agent-browser"), "#!/bin/sh\n");
  writeFileSync(join(home, "orders/p/o.sh"), "export GH_TOKEN=x\n");
  writeFileSync(join(home, "sessions/s1/order-env.sh"), `if [ -r '${join(home, "orders/p/o.sh")}' ]; then . '${join(home, "orders/p/o.sh")}'; fi\n`);
  const argv = ["--mcp-config", join(home, "sessions/s1/mcp.json"), `--settings=${join(home, "sessions/s1/settings.json")}`, "--plugin-dir", join(home, "sessions/s1/skills")];
  const env = {
    PATH: `${join(home, "build-slots/bin")}:${join(home, "browser/agent-browser/bin")}:/usr/bin`,
    TMPDIR: join(home, "tmp/abc"),
    CLAUDE_ENV_FILE: join(home, "sessions/s1/order-env.sh"),
    FLEETD_NODE_SOCK: join(home, "node.sock"),
  };
  const skip = [join(home, "hosts"), join(home, "tmp"), join(home, "build-slots")];
  const paths = named(argv, env, [home], skip).sort();
  expect(paths).toEqual(
    [
      join(home, "browser/agent-browser/bin"),
      join(home, "orders/p/o.sh"),
      join(home, "sessions/s1/mcp.json"),
      join(home, "sessions/s1/order-env.sh"),
      join(home, "sessions/s1/settings.json"),
      join(home, "sessions/s1/skills"),
    ].sort(),
  );
  const root = join(tmp, "box2");
  await mirror(local, paths, root);
  expect(readFileSync(root + join(home, "orders/p/o.sh"), "utf8")).toBe("export GH_TOKEN=x\n");
  expect(existsSync(root + join(home, "browser/agent-browser/bin/agent-browser"))).toBe(true);
  expect(existsSync(root + join(home, "build-slots"))).toBe(false);
});

test("a chat file comes from the box under the machine's rules: inside the working directory, a plain file", async () => {
  const wd = join(tmp, "wd");
  mkdirSync(join(wd, "out"), { recursive: true });
  writeFileSync(join(wd, "out", "shot.png"), Buffer.from("89504e470d0a1a0a0000", "hex"));
  writeFileSync(join(tmp, "secret.png"), "x");
  const img = await readChatFile(local, wd, "out/shot.png", 0, false);
  expect(img).toMatchObject({ name: "shot.png", mime: "image/png" });
  await expect(readChatFile(local, wd, "../secret.png", 0, false)).rejects.toThrow("outside your working directory");
  await expect(readChatFile(local, wd, "nope.png", 0, false)).rejects.toThrow("not readable here");
});
