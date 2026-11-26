// `fleetd heavy-slot <node home> <command>...`: a heavy run (a repo's full pre-push check, a whole test suite, a full
// build) takes one of the machine's heavy-run slots (a file under `<node home>/heavy-slots` it holds a flock on) while
// `command` runs; with every slot in use it queues, first come first served, and says so in one line. Ten writers'
// checks at once loaded the devbox past 100 and failed each other's timing tests, and every rerun added more; on Nov 23
// another repo's checks, which took no slot, loaded it to 47 and ran it out of ports. An agent's own partial test
// commands never take one.
//
// Agents' PATH carries `fleetd-heavy` (install, beside build_slots.ts's cargo wrapper): their standing rules (briefLine)
// tell them to run any repo's full check and long suites as `fleetd-heavy <command>`, and a repo's check may run
// itself under it (fleetd's scripts/check.sh does), unless FLEETD_HEAVY_SLOT says it holds one. So a run inside one
// takes no second slot, and neither does the repo's declared `background` start or `wait` (.fleetd/pre-push.json): the
// one returns at once, its run taking a slot of its own, and the other only waits for that run.
//
// On Linux a run is held to its slot's own CPUs (slotCpus: `taskset`), and its children with it. A slot counted as one
// run's test workers, but a run fans out past them: on Nov 26 a desktop check (vitest's workers, esbuild, Electron) kept
// up to 11.8 cores busy in one slot, a fleetd or cloud check (test workers, the hubs, browsers and Postgres its tests
// start) up to 4.7, and with three desktop checks among the six the devbox's load passed 110. Pinned, the six can use 24
// at most, and tools that size themselves by the CPUs they may use (`nproc`, Node's and Bun's availableParallelism,
// `bun test --parallel`, Go, Rust) see the slot's 4.
import { closeSync, existsSync, readFileSync, readlinkSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as buildSlots from "./build_slots.ts";
import { runInherited, take, writeWrapper } from "./build_slots.ts";
import { readConfig } from "./config.ts";
import { buildJobsHere } from "./load/index.ts";
import { testWorkers } from "./sessions/share.ts";

export const COMMAND = "heavy-slot";
/** The wrapper's name on agents' PATH. */
export const WRAPPER = "fleetd-heavy";
/** Set in the command's environment while it holds a slot: a heavy run inside it doesn't take a second. */
export const HELD = "FLEETD_HEAVY_SLOT";
/** The names from before heavy runs (Nov 22): branches' scripts/check.sh from then exec `fleetd-check-slot` unless
 * FLEETD_CHECK_SLOT is set, so both stay, or such a check would wrap itself forever. */
const OLD = { command: "check-slot", wrapper: "fleetd-check-slot", held: "FLEETD_CHECK_SLOT" };
export const COMMANDS = [COMMAND, OLD.command];
const POLL_MS = 500;

export const dir = (home: string) => join(home, "heavy-slots");

/** What one heavy run is sized for: memory at its worst (measured peaks are under 2.5 GB), and connections it leaves
 * in TIME_WAIT (a fleetd-cloud check leaves up to ~850 to its Postgres; the devbox ran out of ports at ~30k, ~3k a run). */
export const MEM_PER_RUN_GB = 8;
export const PORTS_PER_RUN = 4_000;

export type Machine = { cores: number; buildSlots: number; buildJobs: number; testWorkers: number; memTotal: number | undefined; ports: number };

/** The heavy runs `m` fits at once, the fewest of: the cores left once every build slot runs its build's jobs, at one
 * run's test workers each; memory (as sold) at MEM_PER_RUN_GB a run; ephemeral ports at PORTS_PER_RUN a run. At least
 * one. Unknown memory doesn't limit it. */
export function slotsFit(m: Machine): number {
  const cpu = Math.floor((m.cores - m.buildSlots * m.buildJobs) / Math.max(1, m.testWorkers));
  const mem = m.memTotal === undefined ? Infinity : Math.floor(Math.ceil(m.memTotal / 2 ** 30) / MEM_PER_RUN_GB);
  const ports = Math.floor(m.ports / PORTS_PER_RUN);
  return Math.max(1, Math.min(cpu, mem, ports));
}

/** How many ephemeral ports this machine's kernel hands out: Linux's ip_local_port_range, else the IANA range macOS
 * uses (49152–65535). */
export function ephemeralPorts(): number {
  try {
    const [lo, hi] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
    if (Number.isInteger(lo) && Number.isInteger(hi) && hi! >= lo!) return hi! - lo! + 1;
  } catch {}
  return 65535 - 49152 + 1;
}

/** A Linux CPU list (`0-3,8,10-11`) as its CPUs, in order; undefined when it isn't one. */
export function parseCpuList(text: string): number[] | undefined {
  const cpus: number[] = [];
  for (const part of text.trim().split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return undefined;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) return undefined;
    for (let c = lo; c <= hi; c++) cpus.push(c);
  }
  return cpus.length ? cpus : undefined;
}

/** The machine's CPUs runs can be pinned to: the root cgroup's (a container's own), else every online one; undefined
 * off Linux. Not this process's own: a run started inside a slot still sizes the machine, not its slot. */
export function machineCpus(): number[] | undefined {
  if (process.platform !== "linux") return undefined;
  for (const path of ["/sys/fs/cgroup/cpuset.cpus.effective", "/sys/devices/system/cpu/online"]) {
    try {
      const cpus = parseCpuList(readFileSync(path, "utf8"));
      if (cpus) return cpus;
    } catch {}
  }
  return undefined;
}

/** The CPUs of slot `slot` of `slots`: past the first `reserved` of `cpus` (the build slots' jobs, as slotsFit leaves
 * them), an equal share each, at least one, so no two slots share one while the machine has a CPU for each. Slots set
 * past that (node.json) wrap around. */
export function slotCpus(cpus: number[], reserved: number, slots: number, slot: number): number[] {
  const free = cpus.length > reserved ? cpus.slice(reserved) : cpus;
  const each = Math.min(free.length, Math.max(1, Math.floor(free.length / Math.max(1, slots))));
  return Array.from({ length: each }, (_, i) => free[(slot * each + i) % free.length]!);
}

/** `0-3,8`: the list taskset and /proc read. */
export const cpuList = (cpus: number[]) => {
  const parts: string[] = [];
  for (let i = 0; i < cpus.length; ) {
    let j = i;
    while (j + 1 < cpus.length && cpus[j + 1] === cpus[j]! + 1) j++;
    parts.push(i === j ? `${cpus[i]}` : `${cpus[i]}-${cpus[j]}`);
    i = j + 1;
  }
  return parts.join(",");
};

/** This machine as slotsFit reads it. Builds with no turns (`buildSlots` 0) count as the slots memory fits. */
export function machineHere(home: string): Machine {
  const jobs = buildJobsHere();
  const mem = buildSlots.memTotal();
  return {
    cores: machineCpus()?.length ?? availableParallelism(),
    buildSlots: buildSlots.slotsHere(home) ?? buildSlots.slotsFit(mem),
    buildJobs: jobs,
    testWorkers: testWorkers(jobs),
    memTotal: mem,
    ports: ephemeralPorts(),
  };
}

/** node.json's `heavySlots` (`checkSlots` before it), else what the machine fits; undefined when it is 0: no turns. */
export function slotsHere(home: string): number | undefined {
  let set: number | undefined;
  try {
    const config = readConfig(home);
    const n = config?.heavySlots ?? config?.checkSlots;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) set = n;
  } catch {}
  if (set === 0) return undefined;
  return set ?? slotsFit(machineHere(home));
}

export function waitingLine(slots: number, ahead: number): string {
  const place = ahead === 0 ? "next in line" : ahead === 1 ? "1 run ahead" : `${ahead} runs ahead`;
  return `fleetd: waiting for a heavy-run slot (${place}; ${slots === 1 ? "1 slot" : `${slots} slots`} on this machine, all in use, so it can't overload it): it starts by itself once one frees; don't stop it, as a run started again goes to the back of the queue`;
}

/** `'value'`, for a shell. */
const quoted = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;

/** Writes the heavy-run wrapper (and its old name) beside the cargo one (on agents' PATH: build_slots.ts addToPath),
 * which runs `exe` (fleetd's command line); its path. */
export function install(home: string, exe: string[]): string {
  const script = `#!/bin/sh\n# fleetd's: a long test or build command waits its turn for one of the machine's heavy-run slots.\nexec ${exe.map(quoted).join(" ")} ${COMMAND} ${quoted(home)} "$@"\n`;
  writeWrapper(home, OLD.wrapper, script);
  return writeWrapper(home, WRAPPER, script);
}

/** What a worker's standing rules say about heavy runs. */
export const briefLine = (slots: number) =>
  `- Run the repo's full pre-push check (\`.fleetd/pre-push.json\`'s \`check\`, or what its docs name) and any other whole test suite or full build as \`${WRAPPER} <command>\` (\`${WRAPPER} bun run check\`): it takes one of this machine's ${slots} heavy-run slots, so many agents' checks can't overload it and fail on ports or timeouts. With all in use it prints that it is waiting and starts by itself once one frees: give it Bash's longest timeout, and don't stop it or start another. One too long for one command: start \`${WRAPPER} <its background command>\`, then wait with the Monitor tool running its \`wait\` command; neither the start nor the wait holds a slot, and a check that wraps itself takes no second one. Your own partial test commands (one file, a filter) run directly and never wait.\n`;

/** Whether `argv`, run in `cwd`, is the `background` or `wait` command of the repo's `.fleetd/pre-push.json` (at the
 * top of the repo `cwd` is in). A first word with a slash is a path: `./scripts/check.sh` from the top, or
 * `../check.sh` from `scripts`, is `scripts/check.sh`. */
export function declaredLight(cwd: string, argv: string[]): boolean {
  let top = resolve(cwd);
  while (!existsSync(join(top, ".git"))) {
    if (dirname(top) === top) return false;
    top = dirname(top);
  }
  let declared: Record<string, unknown>;
  try {
    declared = JSON.parse(readFileSync(join(top, ".fleetd", "pre-push.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const word = (w: string, from: string) => (w.includes("/") ? resolve(from, w) : w);
  return [declared.background, declared.wait].some((command) => {
    if (typeof command !== "string") return false;
    const words = command.trim().split(/\s+/);
    return words.length === argv.length && words.every((w, i) => (i === 0 ? word(w, top) === word(argv[0]!, cwd) : w === argv[i]));
  });
}

/** Holds this process (every thread), and so the run it starts next, to slot `fd`'s CPUs (slotCpus), where Linux and
 * `taskset` are there; else, or when taskset fails, the run goes unpinned, as before pinning. */
function pin(home: string, slots: number, fd: number): void {
  const cpus = machineCpus();
  const taskset = Bun.which("taskset");
  if (!cpus || !taskset) return;
  let slot: number;
  try {
    slot = Number(/^slot-(\d+)$/.exec(basename(readlinkSync(`/proc/self/fd/${fd}`)))?.[1] ?? NaN);
  } catch {
    return;
  }
  if (!Number.isInteger(slot)) return;
  const m = machineHere(home);
  const mine = slotCpus(cpus, m.buildSlots * m.buildJobs, slots, slot);
  const r = Bun.spawnSync([taskset, "-a", "-p", "-c", cpuList(mine), String(process.pid)], { stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) process.stderr.write(`fleetd: couldn't hold this run to its slot's CPUs (${r.stderr.toString().trim()}): it may use every CPU\n`);
}

export async function main(argv: string[]): Promise<number> {
  const [home, bin, ...args] = argv;
  if (home === undefined || bin === undefined) {
    process.stderr.write(`fleetd: ${COMMAND} needs the node home, then the command to run\n`);
    return 2;
  }
  const held = process.env[HELD] !== undefined || process.env[OLD.held] !== undefined;
  const slots = held || declaredLight(process.cwd(), [bin, ...args]) ? undefined : slotsHere(home);
  if (slots === undefined) return runInherited(bin, args, process.env);
  let slot: number[] | undefined;
  try {
    slot = await take(dir(home), slots, 1, POLL_MS, (n) => process.stderr.write(`${waitingLine(slots, n)}\n`));
  } catch (error) {
    process.stderr.write(`fleetd: heavy-run slots unavailable (${(error as Error).message}): running without waiting\n`);
  }
  if (slot !== undefined) pin(home, slots, slot[0]!);
  // Held in this process only, never handed to the run's children: a server a test leaves running can't keep it.
  const code = await runInherited(bin, args, { ...process.env, [HELD]: "1", [OLD.held]: "1" });
  for (const fd of slot ?? []) closeSync(fd);
  return code;
}
