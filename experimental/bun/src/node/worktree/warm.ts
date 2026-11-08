// A read or review session's worktree starts ready to test (crates/fleetd/src/node/warm.rs): the dependencies of the
// apps its commits touch installed, and a warm cargo build. The build is handed on, not shared: a reader's `target/`
// goes to its checkout's pool when its worktree goes, and the next reader's new worktree takes the newest one by a
// rename, so nothing is copied and no two worktrees build into one directory. The taker's tracked files are touched so
// its own crates rebuild from its sources. A pool keeps at most `warmBuilds` (node.json, 2 by default); one that goes
// is renamed out first (`.gone-…`), so a reader taking it at the same moment gets it whole or not at all.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readConfig } from "../config.ts";
import type { WorktreeSetup } from "../../shared/contracts.ts";
import { git } from "./index.ts";

export const KEEP = 2;
/** A warm target older than this is pruned: its dependencies are likely stale by then. */
export const MAX_AGE_MS = 7 * 24 * 3600_000;
export const PRUNE_EVERY_MS = 24 * 3600_000;
const GONE = ".gone-";
/** Each of a reader's setup commands' time limit, at most. */
export const SETUP_LIMIT_SEC = 300;
const SETUP_COMMANDS_MAX = 20;
export const WARM_NOTE =
  "This worktree's `target/` is a warm build an earlier reader of this checkout left: dependencies are built, and only what changed rebuilds.";
/** Lockfiles a reader's setup installs from, each with its install command. */
const INSTALLS: [string, string][] = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile --prefer-offline"],
  ["package-lock.json", "npm ci --prefer-offline --no-audit --no-fund"],
  ["yarn.lock", "yarn install --frozen-lockfile --prefer-offline"],
  ["bun.lock", "bun install --frozen-lockfile"],
];

/** How many warm targets each pool keeps here: node.json's `warmBuilds`, else KEEP. 0 keeps none. */
export function keep(home: string): number {
  try {
    return readConfig(home)?.warmBuilds ?? KEEP;
  } catch {
    return KEEP;
  }
}

const pools = (home: string) => join(home, "cache", "targets");
/** `<node home>/cache/targets/<16 hex of the checkout path's SHA-256>`. */
export const pool = (home: string, root: string) => join(pools(home), createHash("sha256").update(root).digest("hex").slice(0, 16));

/** The pool's targets, newest first; none leaving it. */
function waiting(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith("."))
      .sort()
      .reverse()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** When a target entered its pool, from its name (nanoseconds, then the pid). */
const givenAt = (target: string) => {
  const nanos = Number(basename(target).split("-")[0]);
  return Number.isFinite(nanos) ? nanos / 1e6 : undefined;
};

/** Takes `target` out of its pool and removes it; whether it went (a reader that took it first wins). */
function evict(target: string): boolean {
  const gone = join(dirname(target), `${GONE}${basename(target)}`);
  try {
    renameSync(target, gone);
  } catch {
    return false;
  }
  try {
    rmSync(gone, { recursive: true, force: true });
  } catch (error) {
    console.warn(`old warm build not removed: ${gone}: ${String(error)}`);
  }
  return true;
}

/** Prunes a pool to its newest `n`, dropping those older than MAX_AGE_MS and what an interrupted removal left. */
export function prunePool(dir: string, n: number, now = Date.now()): number {
  let gone = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(GONE)) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
      gone++;
    }
  } catch {}
  waiting(dir).forEach((target, i) => {
    const at = givenAt(target);
    const old = at !== undefined && now - at > MAX_AGE_MS;
    if ((i >= n || old) && evict(target)) gone++;
  });
  return gone;
}

/** The node's daily cleanup: every checkout's pool pruned to `n`. */
export function prune(home: string, n: number): number {
  try {
    return readdirSync(pools(home)).reduce((sum, p) => sum + prunePool(join(pools(home), p), n), 0);
  } catch {
    return 0;
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Hands the `target/` of a reader's worktree, about to go, to its checkout's pool, dropping the oldest past `n`. */
export function give(home: string, root: string, worktree: string, n: number): void {
  const target = join(worktree, "target");
  if (n === 0 || !isDir(target) || !isFile(join(worktree, "Cargo.lock"))) return;
  const dir = pool(home, root);
  try {
    mkdirSync(dir, { recursive: true });
    const nanos = (BigInt(Date.now()) * 1_000_000n + process.hrtime.bigint() % 1_000_000n).toString().padStart(24, "0");
    renameSync(target, join(dir, `${nanos}-${process.pid}`));
  } catch (error) {
    console.warn(`warm build not handed on: ${target}: ${String(error)}`);
    return;
  }
  for (const old of waiting(dir).slice(n)) evict(old);
}

/** Gives a reader's new worktree without a `target/` the newest of its pool, and touches its tracked files so cargo
 * rebuilds its own crates from them. Whether it got one. */
export function take(home: string, root: string, worktree: string): boolean {
  const target = join(worktree, "target");
  if (existsSync(target) || !isFile(join(worktree, "Cargo.lock"))) return false;
  // Another reader starting at the same time may take one first: the next is tried.
  const got = waiting(pool(home, root)).some((warm) => {
    try {
      renameSync(warm, target);
      return true;
    } catch {
      return false;
    }
  });
  if (got) touch(worktree);
  return got;
}

function touch(worktree: string): void {
  let files: string;
  try {
    files = git(worktree, ["ls-files", "-z"]);
  } catch {
    return;
  }
  const now = new Date();
  for (const file of files.split("\0").filter(Boolean)) {
    const path = join(worktree, file);
    try {
      if (lstatSync(path).isFile()) utimesSync(path, now, now);
    } catch {}
  }
}

/** Drops the warm targets of a checkout that is going. */
export function dropPool(home: string, root: string): void {
  rmSync(pool(home, root), { recursive: true, force: true });
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** What a reader's worktree at `cwd` is set up with: the project's commands when it has some, else an install for each
 * tracked lockfile in a directory the commits since `base` touched; time-boxed, and a failure starts it anyway. */
export function readerSetup(project: WorktreeSetup | undefined, cwd: string, base: string): WorktreeSetup | undefined {
  const own = project && (project.commands ?? []).length ? project : installs(cwd, base);
  if (!own) return undefined;
  return { ...own, runAnyway: true, timeoutSec: Math.min(own.timeoutSec ?? 600, SETUP_LIMIT_SEC) };
}

function installs(cwd: string, base: string): WorktreeSetup | undefined {
  let changed: string[];
  let tracked: string[];
  try {
    changed = git(cwd, ["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
    tracked = git(cwd, ["ls-files", "-z"]).split("\0");
  } catch {
    return undefined;
  }
  if (!changed.length) return undefined;
  const commands: string[] = [];
  const inputs: string[] = [];
  for (const lockfile of tracked) {
    const slash = lockfile.lastIndexOf("/");
    const [dir, name] = slash < 0 ? ["", lockfile] : [lockfile.slice(0, slash), lockfile.slice(slash + 1)];
    const install = INSTALLS.find(([l]) => l === name)?.[1];
    if (!install) continue;
    const touched = dir === "" || changed.some((f) => f.startsWith(`${dir}/`));
    if (!touched || commands.length === SETUP_COMMANDS_MAX) continue;
    commands.push(dir === "" ? install : `cd ${quote(dir)} && ${install}`);
    inputs.push(lockfile);
  }
  return commands.length ? { commands, inputs } : undefined;
}
