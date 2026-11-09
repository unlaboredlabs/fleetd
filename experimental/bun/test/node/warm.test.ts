// Warm builds: a reader's `target/` is handed on to the next reader of the same checkout, whole and by a rename, the
// pool kept to its size; and a reader's setup installs for the apps its commits touch.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { give, pool, prunePool, readerSetup, take } from "../../src/node/worktree/warm.ts";
import { tempHome } from "../helpers.ts";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).stdout;

test("a reader's build goes to its checkout's pool and the next reader takes the newest, its sources touched", async () => {
  const home = tempHome();
  try {
    const root = join(home.dir, "repo");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "Cargo.lock"), "lock\n");
    writeFileSync(join(root, "lib.rs"), "fn x() {}\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "init");
    const first = join(home.dir, "w1");
    const second = join(home.dir, "w2");
    for (const w of [first, second]) git(root, "worktree", "add", "-q", "--detach", w, "HEAD");
    mkdirSync(join(first, "target/debug"), { recursive: true });
    writeFileSync(join(first, "target/debug/built"), "yes");
    await give(join(home.dir, "node"), root, first, 2);
    expect(existsSync(join(first, "target"))).toBe(false);
    expect(readdirSync(pool(join(home.dir, "node"), root))).toHaveLength(1);
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(second, "lib.rs"), old, old);
    expect(await take(join(home.dir, "node"), root, second)).toBe(true);
    expect(readFileSync(join(second, "target/debug/built"), "utf8")).toBe("yes");
    expect(statSync(join(second, "lib.rs")).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    // Nothing left to take; a worktree with a target already takes none.
    expect(await take(join(home.dir, "node"), root, first)).toBe(false);
  } finally {
    home.done();
  }
});

test("a pool keeps its newest few, and none older than a week", async () => {
  const home = tempHome();
  try {
    const dir = join(home.dir, "pool");
    const nanos = (ms: number) => `${(BigInt(ms) * 1_000_000n).toString().padStart(24, "0")}-1`;
    const now = Date.now();
    const [newest, next] = [now - 1000, now - 2000];
    for (const ms of [newest, next, now - 3000, now - 8 * 24 * 3600_000]) mkdirSync(join(dir, nanos(ms)), { recursive: true });
    mkdirSync(join(dir, ".gone-left"));
    expect(await prunePool(dir, 2, now)).toBe(3);
    expect(readdirSync(dir).sort()).toEqual([nanos(next), nanos(newest)].sort());
  } finally {
    home.done();
  }
});

test("a reader installs for each lockfile whose app its commits touch, time-boxed and starting anyway", async () => {
  const home = tempHome();
  try {
    const root = join(home.dir, "repo");
    mkdirSync(join(root, "app/web"), { recursive: true });
    mkdirSync(join(root, "tools"), { recursive: true });
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "app/web/pnpm-lock.yaml"), "x");
    writeFileSync(join(root, "tools/package-lock.json"), "x");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "init");
    const base = git(root, "rev-parse", "HEAD").trim();
    writeFileSync(join(root, "app/web/index.ts"), "x");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "touch web");
    expect(await readerSetup(undefined, root, base)).toEqual({
      commands: ["cd 'app/web' && pnpm install --frozen-lockfile --prefer-offline"],
      inputs: ["app/web/pnpm-lock.yaml"],
      runAnyway: true,
      timeoutSec: 300,
    });
    expect(await readerSetup({ commands: ["make deps"], timeoutSec: 900 }, root, base)).toEqual({ commands: ["make deps"], runAnyway: true, timeoutSec: 300 });
    expect(await readerSetup(undefined, root, "HEAD")).toBeUndefined();
  } finally {
    home.done();
  }
});
