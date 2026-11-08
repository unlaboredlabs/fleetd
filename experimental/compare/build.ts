// `node build.ts --impl <rust|bun> [--jobs N] [--steps build,check,testBuild,test] [--bin-out <path>] [--keep]`: build
// and check times for one implementation, from impls.json, so both run the same script. Every command runs on the same
// N CPUs (taskset -c 0-<N-1>; --jobs or COMPARE_JOBS, default 2, this devbox's per-agent build share), with cargo's,
// make's and the Rust test harness's parallelism set to N whatever the caller's environment says, so the two sides
// always build on equal CPUs and every row says how many. Each step builds clean in a fresh
// $SCRATCH (no cache shared with another step), then again after a one-file edit (a comment appended to the impl's
// `touch` file, restored afterwards); a step with `after` runs once, warm, on that step's build (the test suite).
// Writes results/<impl>/build-j<N>.json. Cargo waits for a build slot through the machine's wrapper: the time cargo itself
// reports ("Finished … in") leaves the wait out, and is the number the report uses when there is one.
import fs from "node:fs";
import path from "node:path";
import { arg, has, impls, REPO, round, scratch, timed, writeResult } from "./lib.ts";

const name = arg("--impl", "COMPARE_IMPL", "rust")!;
const impl = impls()[name];
if (impl === undefined) throw new Error(`unknown impl ${name}; impls.json has ${Object.keys(impls()).join(", ")}`);
const wanted = arg("--steps")?.split(",");
const cwd = path.join(REPO, impl.cwd);
const jobs = Number(arg("--jobs", "COMPARE_JOBS", "2"));
if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs must be a whole number of CPUs, got ${jobs}`);
const cpus = `0-${jobs - 1}`;
const pinned = { CARGO_BUILD_JOBS: String(jobs), MAKEFLAGS: `-j${jobs}`, CMAKE_BUILD_PARALLEL_LEVEL: String(jobs), RUST_TEST_THREADS: String(jobs) };
const logFile = path.join(scratch(`build-${name}-log`), "build.log");
console.log(`log: ${logFile}; ${jobs} CPUs (${cpus})`);

/** Cargo's own "Finished … in 1m 02s" / "in 12.34s" for the run just logged, in ms. */
const toolMs = (from: number) => {
  const text = fs.readFileSync(logFile, "utf8").slice(from);
  const m = /Finished .* in (?:(\d+)m )?([\d.]+)s/u.exec(text);
  return {
    toolMs: m === null ? undefined : round((Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000, 0),
    waitedForSlot: /build slot/iu.test(text),
  };
};

const run = (command: string, env: Record<string, string>) => {
  const from = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const r = timed(command, { cwd, env: { ...env, ...pinned }, logFile, cpus });
  const out = { jobs, ...r, ...toolMs(from) };
  console.log(`  ${command}: exit ${out.code}, wall ${(out.wallMs / 1000).toFixed(1)} s${out.toolMs === undefined ? "" : `, cargo ${(out.toolMs / 1000).toFixed(1)} s`}${out.waitedForSlot ? " (waited for a build slot)" : ""}`);
  return out;
};

const scratches: Record<string, string> = {};
const results: Record<string, unknown> = {};
const touchFile = path.join(REPO, impl.touch);
try {
  for (const [stepName, step] of Object.entries(impl.steps)) {
    if (step === null || (wanted !== undefined && !wanted.includes(stepName))) continue;
    const dir = step.after === undefined ? scratch(`build-${name}-${stepName}`) : scratches[step.after];
    if (dir === undefined) throw new Error(`${stepName} runs after ${step.after}, which hasn't run (add it to --steps)`);
    scratches[stepName] = dir;
    const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, v.replaceAll("$SCRATCH", dir)]));
    console.log(`${name} ${stepName}`);
    if (step.after !== undefined) {
      // Cargo's "Finished" is its build before the run here; the suite's own time is the rest of the wall time.
      const warm = run(step.run, env);
      results[stepName] = { warm: { ...warm, runMs: warm.wallMs - (warm.toolMs ?? 0) } };
      continue;
    }
    if (step.prepare !== undefined) timed(step.prepare, { cwd, env: { ...env, ...pinned }, logFile });
    const clean = run(step.run, env);
    const original = fs.readFileSync(touchFile);
    let incremental;
    try {
      fs.appendFileSync(touchFile, `\n${impl.comment} compare: a one-file edit\n`);
      incremental = run(step.run, env);
    } finally {
      fs.writeFileSync(touchFile, original);
    }
    results[stepName] = { clean, incremental };
    const binOut = arg("--bin-out");
    if (step.artifact !== undefined) {
      const artifact = path.resolve(cwd, step.artifact.replaceAll("$SCRATCH", dir));
      results[stepName] = { clean, incremental, artifactBytes: fs.existsSync(artifact) ? fs.statSync(artifact).size : undefined };
      // The incremental build's binary has the edit's comment only, so it is the clean one's code.
      if (binOut !== undefined && fs.existsSync(artifact)) {
        fs.mkdirSync(path.dirname(path.resolve(binOut)), { recursive: true });
        fs.copyFileSync(artifact, path.resolve(binOut));
        fs.chmodSync(path.resolve(binOut), 0o755);
        console.log(`  binary copied to ${path.resolve(binOut)}`);
      }
    }
  }
  writeResult(name, `build-j${jobs}`, { jobs, cpus, pinnedEnv: pinned, steps: results, commands: impl.steps, touch: impl.touch });
} finally {
  if (!has("--keep")) for (const dir of new Set(Object.values(scratches))) fs.rmSync(dir, { recursive: true, force: true });
}
