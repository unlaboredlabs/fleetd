// Shared plumbing for the comparison harness: the implementations under test (impls.json), result files, /proc
// sampling of a process's memory and CPU, and small statistics. Every bench treats a fleetd as a black box: a binary
// given by FLEETD_BIN (or --bin), started and measured from outside, so two builds run the same scripts.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../..");
export const RESULTS = path.join(HERE, "results");

export interface Step {
  readonly run: string;
  readonly prepare?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Runs once, warm, in this earlier step's $SCRATCH instead of clean and incremental. */
  readonly after?: string;
  /** What the step builds (the binary), relative to `cwd`; `--bin-out` copies it there. */
  readonly artifact?: string;
}

/** What a build bench runs for one implementation; see impls.json. */
export interface Impl {
  readonly name: string;
  /** The binary the runtime benches default to, relative to the repo. */
  readonly bin: string;
  /** Where its commands run, relative to the repo. */
  readonly cwd: string;
  /** The one file the incremental builds edit (a comment appended, then restored), relative to the repo. */
  readonly touch: string;
  readonly comment: string;
  /** Each step: a clean build (`prepare` first, in a fresh $SCRATCH) and an incremental one after a one-file edit. */
  readonly steps: Readonly<Record<string, Step | null>>;
}

export const impls = (): Record<string, Impl> =>
  Object.fromEntries(
    Object.entries(JSON.parse(fs.readFileSync(path.join(HERE, "impls.json"), "utf8")) as Record<string, Omit<Impl, "name"> | string>)
      .filter((e): e is [string, Omit<Impl, "name">] => typeof e[1] === "object")
      .map(([name, impl]) => [name, { name, ...impl }]),
  );

/** `--flag value` from argv, else the environment variable, else the default. */
export const arg = (flag: string, env?: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  if (i >= 0) return process.argv[i + 1];
  return (env === undefined ? undefined : process.env[env]) ?? fallback;
};
export const has = (flag: string) => process.argv.includes(flag);

/**
 * The implementation under test: `--impl <name>` (default `bun`) names its results directory; `--bin` or FLEETD_BIN
 * the binary, else the impl's own default.
 */
export const target = () => {
  const name = arg("--impl", "COMPARE_IMPL", "bun")!;
  const impl = impls()[name];
  const given = arg("--bin", "FLEETD_BIN") ?? (impl === undefined ? undefined : path.join(REPO, impl.bin));
  if (given === undefined) throw new Error(`no binary for ${name}: give --bin or FLEETD_BIN`);
  const bin = path.resolve(given);
  if (!fs.existsSync(bin)) throw new Error(`${bin} does not exist (build it first, or give --bin / FLEETD_BIN)`);
  return { name, bin };
};

/** The machine the numbers came from: they only compare within one machine and one load. */
export const machine = () => ({
  cpus: os.cpus().length,
  cpuModel: os.cpus()[0]?.model ?? "unknown",
  memGb: Math.round(os.totalmem() / 2 ** 30),
  kernel: os.release(),
  loadavg: os.loadavg().map((l) => Math.round(l * 100) / 100),
  at: new Date().toISOString(),
});

/** Writes results/<impl>/<bench>.json: the bench's numbers plus the machine, binary and load they were taken on. */
export const writeResult = (impl: string, bench: string, data: unknown, bin?: string) => {
  const dir = path.join(arg("--out", "COMPARE_OUT") ?? RESULTS, impl);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${bench}.json`);
  const version = bin === undefined ? undefined : spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(file, `${JSON.stringify({ impl, bench, version, machine: machine(), data }, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
  return file;
};

/** A new directory under $TMPDIR/fc. Names stay short: a node's socket lives a few levels down, within SUN_LEN. */
export const scratch = (name: string) => {
  const root = path.join(process.env.TMPDIR ?? os.tmpdir(), "fc");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${name}-`));
};

// Statistics over a sample: medians and percentiles by rank, rounded for the report.
export const round = (x: number, places = 2) => Math.round(x * 10 ** places) / 10 ** places;
export const quantile = (xs: ReadonlyArray<number>, q: number) => {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
export const summary = (xs: ReadonlyArray<number>) => ({
  n: xs.length,
  median: round(quantile(xs, 0.5)),
  p90: round(quantile(xs, 0.9)),
  min: round(Math.min(...xs)),
  max: round(Math.max(...xs)),
});

const TICK = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim() || 100);
const PAGE = Number(spawnSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).stdout.trim() || 4096);

/** One process's resident memory (MB) and CPU time used so far (ms), from /proc; undefined once it's gone. */
export const procStat = (pid: number): { rssMb: number; cpuMs: number } | undefined => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Fields 14 and 15 (utime, stime) and 24 (rss in pages), counted from 1 with the state as field 3.
    return { cpuMs: ((Number(f[11]) + Number(f[12])) * 1000) / TICK, rssMb: (Number(f[21]) * PAGE) / 2 ** 20 };
  } catch {
    return undefined;
  }
};

/** Proportional memory (MB) from smaps_rollup: shared pages split between the processes mapping them. */
export const pssMb = (pid: number): number | undefined => {
  try {
    const kb = /^Pss:\s+(\d+) kB/mu.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1];
    return kb === undefined ? undefined : Number(kb) / 1024;
  } catch {
    return undefined;
  }
};

/**
 * Samples processes every `everyMs` until `stop()`: peak and last RSS, and CPU used between start and stop, per
 * name. `pids()` is read on every tick, so a group whose members come and go (a node's session hosts) is summed.
 */
export const sampler = (groups: Record<string, () => ReadonlyArray<number>>, everyMs = 250) => {
  const first: Record<string, Map<number, number>> = {};
  const last: Record<string, Map<number, number>> = {};
  const peak: Record<string, number> = {};
  const rss: Record<string, Array<number>> = {};
  const tick = () => {
    for (const [name, pids] of Object.entries(groups)) {
      let total = 0;
      for (const pid of pids()) {
        const s = procStat(pid);
        if (s === undefined) continue;
        total += s.rssMb;
        (first[name] ??= new Map()).has(pid) || first[name].set(pid, s.cpuMs);
        (last[name] ??= new Map()).set(pid, s.cpuMs);
      }
      peak[name] = Math.max(peak[name] ?? 0, total);
      (rss[name] ??= []).push(total);
    }
  };
  tick();
  const timer = setInterval(tick, everyMs);
  const t0 = Date.now();
  return {
    stop: () => {
      clearInterval(timer);
      tick();
      const wallMs = Date.now() - t0;
      return Object.fromEntries(
        Object.keys(groups).map((name) => {
          let cpuMs = 0;
          for (const [pid, end] of last[name] ?? new Map()) cpuMs += end - (first[name]?.get(pid) ?? 0);
          const series = rss[name] ?? [];
          return [name, { peakRssMb: round(peak[name] ?? 0, 1), lastRssMb: round(series.at(-1) ?? 0, 1), cpuMs: round(cpuMs, 0), cpuPct: round((100 * cpuMs) / Math.max(1, wallMs), 1) }];
        }),
      );
    },
  };
};

/** Runs a shell command, its output into `logFile` (on the CPUs `cpus` names, with taskset); its exit code and wall time. */
export const timed = (command: string, opts: { cwd: string; env?: Record<string, string>; logFile: string; cpus?: string }) => {
  const out = fs.openSync(opts.logFile, "a");
  fs.writeSync(out, `\n$ ${command}\n`);
  const argv = opts.cpus === undefined ? ["bash", "-c", command] : ["taskset", "-c", opts.cpus, "bash", "-c", command];
  const t0 = performance.now();
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", out, out] });
  const wallMs = performance.now() - t0;
  fs.closeSync(out);
  return { code: r.status ?? -1, wallMs: round(wallMs, 0) };
};

const TITLE_WORDS = "amber birch cedar delta ember fjord grove harbor island juniper kestrel lagoon meadow nectar orchid pebble quartz raven saffron tundra umber violet willow xenon yarrow zephyr basalt cobalt dune falcon garnet heron indigo jasper krill lotus marble nimbus onyx prairie".split(" ");
/** A writer title no other one shares a word with: the hub refuses a spawn that looks like a duplicate. */
export const uniqueTitle = (i: number) => `${TITLE_WORDS[i % TITLE_WORDS.length]}${i >= TITLE_WORDS.length ? Math.floor(i / TITLE_WORDS.length) : ""}`;
