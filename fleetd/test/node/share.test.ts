// Each session's share of the machine (sessions/share.rs, load.rs and build_slots.rs's own cases): its build and test
// parallelism, the brief's "## This machine" note, the cargo wrapper first on its PATH, and sccache when installed.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addToPath, binDir, briefLine } from "../../src/node/build_slots.ts";
import { agentsFit, buildJobs } from "../../src/node/load/index.ts";
import { briefNote, compileCacheEnv, jobsEnv } from "../../src/node/sessions/share.ts";
import { tempHome } from "../helpers.ts";

test("every build tool gets the share unless the user set its own", () => {
  expect(jobsEnv({ PATH: "/usr/bin" }, 3)).toEqual([
    ["CARGO_BUILD_JOBS", "3"],
    ["MAKEFLAGS", "-j3"],
    ["CMAKE_BUILD_PARALLEL_LEVEL", "3"],
    ["GOFLAGS", "-p=3"],
    ["VITEST_MAX_WORKERS", "4"],
  ]);
  // Set, even to something other than a job count: theirs stands.
  expect(jobsEnv({ MAKEFLAGS: "--no-print-directory", GOFLAGS: "-mod=vendor", VITEST_MAX_WORKERS: "1" }, 2)).toEqual([
    ["CARGO_BUILD_JOBS", "2"],
    ["CMAKE_BUILD_PARALLEL_LEVEL", "2"],
  ]);
});

test("the test runner gets the agent's share of the cores, never fewer than 4 workers", () => {
  const workers = (n: number) => jobsEnv({}, n).find(([k]) => k === "VITEST_MAX_WORKERS")?.[1];
  expect([workers(2), workers(4), workers(8)]).toEqual(["4", "4", "8"]);
});

test("the brief says how many jobs and which variables", () => {
  expect(briefNote(jobsEnv({}, 2), 2)).toBe(
    "## This machine\n" +
      "- Builds get 2 parallel jobs per agent, your share of this machine's CPUs: CARGO_BUILD_JOBS, MAKEFLAGS, CMAKE_BUILD_PARALLEL_LEVEL, GOFLAGS are set to it. Keep any other build to 2 jobs too.\n" +
      "- Test runners get 4 workers: VITEST_MAX_WORKERS is set to it. Keep any other test runner to 4 workers too.\n" +
      "- Scratch files go in $TMPDIR, a directory of your own on disk; never in /tmp, which may be held in memory.\n",
  );
  const one = briefNote([["GOFLAGS", "-p=2"]], 2);
  expect(one).toContain(": GOFLAGS is set to it.");
  expect(one).not.toContain("Test runners");
  const testsOnly = briefNote([["VITEST_MAX_WORKERS", "6"]], 6);
  expect(testsOnly).not.toContain("Builds get");
  expect(testsOnly).toContain("Test runners get 6 workers");
  // Nothing fleetd set: no jobs line.
  expect(briefNote([], 2)).not.toContain("jobs");
  expect(briefLine(3)).toStartWith("- Cargo builds, tests, checks and clippy runs take turns for this machine's 3 build slots, one each;");
});

/** The design's example machines, and the one of 08:39: 20 agents at once on 32 cores and 59 GB. */
test("each agent builds with its share of the cpus and never fewer than 2 jobs", () => {
  const GB = 2 ** 30;
  const jobs = (cpus: number, gb?: number) => buildJobs(cpus, agentsFit(cpus, gb === undefined ? undefined : gb * GB, 2e9));
  expect(agentsFit(32, 59 * GB, 2e9)).toBe(22);
  expect(jobs(32, 59)).toBe(2);
  expect(agentsFit(8, 8 * GB, 2e9)).toBe(2);
  expect(jobs(8, 8)).toBe(4);
  expect(agentsFit(32, 128 * GB, 2e9)).toBe(28);
  expect(agentsFit(128, 512 * GB, 2e9)).toBe(64);
  expect(jobs(128, 512)).toBe(2);
  expect(jobs(64, 16)).toBe(10);
  expect(jobs(2, 4)).toBe(2);
  expect(jobs(16)).toBe(4);
  expect(buildJobs(16, agentsFit(16, 32 * GB, 4e9))).toBe(2);
  expect(buildJobs(16, agentsFit(16, 16 * GB, 4e9))).toBe(5);
});

test("an agent's PATH starts with the cargo wrapper, which runs fleetd's build-slot", () => {
  const home = tempHome();
  try {
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    addToPath(home.dir, ["/opt/bun", "/src/main.ts"], env);
    expect(env.PATH).toBe(`${binDir(home.dir)}:/usr/bin:/bin`);
    expect(readFileSync(join(binDir(home.dir), "cargo"), "utf8")).toBe(
      `#!/bin/sh\n# fleetd's: an agent's cargo build waits its turn for one of the machine's build slots.\nexec '/opt/bun' '/src/main.ts' build-slot '${home.dir}' "$@"\n`,
    );
  } finally {
    home.done();
  }
});

test("sccache is every session's compile cache when installed and no wrapper is set", () => {
  const home = tempHome();
  try {
    const bin = join(home.dir, "bin");
    mkdirSync(bin);
    expect(compileCacheEnv({ PATH: bin })).toEqual([]);
    writeFileSync(join(bin, "sccache"), "#!/bin/sh\n");
    chmodSync(join(bin, "sccache"), 0o755);
    expect(compileCacheEnv({ PATH: `/nowhere:${bin}` })).toEqual([
      ["RUSTC_WRAPPER", join(bin, "sccache")],
      ["SCCACHE_IGNORE_SERVER_IO_ERROR", "1"],
    ]);
    expect(compileCacheEnv({ PATH: bin, RUSTC_WRAPPER: "mine" })).toEqual([]);
  } finally {
    home.done();
  }
});
