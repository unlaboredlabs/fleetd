// Each session's share of the machine (crates/fleetd/src/node/sessions/share.rs): build tools and test runners held to
// its part of the CPUs, and one compile cache for every session. With 20 agents building at once and no limit, every
// `cargo`, `make` and `go build` sized itself to all the machine's cores, and every `pnpm test` started a vitest worker
// per core (31 forks, 11 GB at peak).
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../util.ts";

/** The test runner's variable: vitest's worker count, the desktop's and the phone's suites alike. */
const TEST_WORKERS_VAR = "VITEST_MAX_WORKERS";

/** Test workers for an agent whose builds get `n` jobs: its share, but at least 4, since a suite of many small files
 * run on 2 workers takes minutes. */
export const testWorkers = (n: number) => Math.max(n, 4);

/** The parallelism variables of the common build tools and the test runner, each with its value for `n` jobs. */
const jobsVars = (n: number): [string, string][] => [
  ["CARGO_BUILD_JOBS", String(n)],
  ["MAKEFLAGS", `-j${n}`],
  ["CMAKE_BUILD_PARALLEL_LEVEL", String(n)],
  ["GOFLAGS", `-p=${n}`],
  [TEST_WORKERS_VAR, String(testWorkers(n))],
];

/** The build and test parallelism variables for `n` jobs that `env` (the user's own setup, `claude.env` included)
 * doesn't already set: a person's own choice stands. */
export const jobsEnv = (env: Env, n: number): [string, string][] => jobsVars(n).filter(([k]) => !(k in env));

/** What a worker's brief says about its share of the machine. Names only the variables fleetd set. */
export function briefNote(set: [string, string][], n: number): string {
  let note = "## This machine\n";
  const names = set.map(([k]) => k).filter((k) => k !== TEST_WORKERS_VAR);
  if (names.length)
    note += `- Builds get ${n} parallel jobs per agent, your share of this machine's CPUs: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} set to it. Keep any other build to ${n} jobs too.\n`;
  if (set.some(([k]) => k === TEST_WORKERS_VAR)) {
    const w = testWorkers(n);
    note += `- Test runners get ${w} workers: ${TEST_WORKERS_VAR} is set to it. Keep any other test runner to ${w} workers too.\n`;
  }
  return `${note}- Scratch files go in $TMPDIR, a directory of your own on disk; never in /tmp, which may be held in memory.\n`;
}

/** One compile cache for every session on the machine, when sccache is installed and the environment names no
 * wrapper (sessions/mod.rs `compile_cache_env`): dependencies compile once, not once per worktree. Target dirs stay in
 * each worktree, since cargo checks a workspace's own crates by path and mtime. */
export function compileCacheEnv(env: Env): [string, string][] {
  if (env.RUSTC_WRAPPER !== undefined) return [];
  const sccache = (env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((dir) => join(dir, "sccache"))
    .find((bin) => {
      try {
        return statSync(bin).isFile();
      } catch {
        return false;
      }
    });
  // A cache server that fails compiles locally instead of failing the build.
  return sccache ? [["RUSTC_WRAPPER", sccache], ["SCCACHE_IGNORE_SERVER_IO_ERROR", "1"]] : [];
}
