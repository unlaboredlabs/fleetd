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
// On Linux, with a systemd user manager, a run is held to its slot's share of the CPUs (slotShare) by a CPU quota: it
// runs in a scope of its own with `CPUQuota=`, and so does everything it starts. A slot counted as one run's test
// workers, but a run fans out past them: on Nov 26 a desktop check (vitest's workers, esbuild, Electron) kept up to 11.8
// cores busy in one slot, a fleetd or cloud check (test workers, the hubs, browsers and Postgres its tests start) up to
// 4.7, and with three desktop checks among the six the devbox's load passed 110. Capped, the six use 24 of its 32 at
// most, and a thread the quota holds back doesn't count in the load. A quota leaves the run's CPU affinity alone:
// pinned to a slot's 4 CPUs instead (#2257), Electron's GPU process put 16 of its threads on CPUs 0-3, whatever CPUs it
// had, and four pinned desktop checks ran CPUs 0-3 at 100% with the load at 158 and most cores idle.
import { closeSync, existsSync, readFileSync } from "node:fs";
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

/** The machine's CPUs: the root cgroup's (a container's own), else every online one; undefined off Linux. Not this
 * process's own affinity, which a caller may have narrowed (`taskset`). */
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

/** The CPUs each of `slots` slots may use, of `cores`: an equal share of those past the build slots' jobs (`reserved`,
 * as slotsFit leaves them), at least one; every CPU when the builds fill the machine. */
export function slotShare(cores: number, reserved: number, slots: number): number {
  const free = cores > reserved ? cores - reserved : cores;
  return Math.max(1, Math.floor(free / Math.max(1, slots)));
}

/** This machine as slotsFit reads it, from its own CPUs (machineCpus), never this process's: a run started inside a
 * pinned one (`check.sh --background`) must size the slots, and the build jobs they leave out, as every other run
 * does, or its slot's CPUs would overlap another's. Builds with no turns (`buildSlots` 0) count as the slots memory
 * fits. */
export function machineHere(home: string): Machine {
  const cores = machineCpus()?.length ?? availableParallelism();
  const jobs = buildJobsHere(cores);
  const mem = buildSlots.memTotal();
  return {
    cores,
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
  `- Run the repo's full pre-push check (\`.fleetd/pre-push.json\`'s \`check\`, or what its docs name) and any other whole test suite or full build as \`${WRAPPER} <command>\` (\`${WRAPPER} bun run check\`): it takes one of this machine's ${slots} heavy-run slots, so many agents' checks can't overload it and fail on ports or timeouts. With all in use it prints that it is waiting and starts by itself once one frees: give it Bash's longest timeout, and don't stop it or start another. One too long for one command: start \`${WRAPPER} <its background command>\`, then wait with the Monitor tool running its \`wait\` command; neither the start nor the wait holds a slot, and a check that wraps itself takes no second one. Your own partial test commands (one file, a filter) run directly and never wait, unless each worker starts an app or a browser (QA screens, end-to-end runs): those are heavy even filtered to one test.\n`;

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

/** A cgroup v2 file's number, or undefined for `max` or one that can't be read. */
function cgroupNumber(path: string): number | undefined {
  try {
    const v = readFileSync(path, "utf8").trim();
    return /^\d+$/.test(v) ? Number(v) : undefined;
  } catch {
    return undefined;
  }
}

/** `systemd-run`'s arguments that start a run in a scope of its own capped at `cpus` CPUs, up to the `--`: with the
 * session's own memory cap and OOM policy (runner/scope.ts), and bound to the session's scope, so a stopped agent's run
 * stops with it. `cgroup` is /proc/self/cgroup's text. */
export function quotaArgs(cpus: number, cgroup: string): string[] {
  const path = cgroup.split("\n").find((l) => l.startsWith("0::"))?.slice(3) ?? "";
  const args = ["--user", "--scope", "--quiet", "--collect", "--description=fleetd heavy run", `--property=CPUQuota=${cpus * 100}%`, "--property=OOMPolicy=continue"];
  const max = cgroupNumber(join("/sys/fs/cgroup", path, "memory.max"));
  const swap = cgroupNumber(join("/sys/fs/cgroup", path, "memory.swap.max"));
  if (max !== undefined) args.push(`--property=MemoryMax=${max}`);
  if (swap !== undefined) args.push(`--property=MemorySwapMax=${swap}`);
  const unit = basename(path);
  if (unit.endsWith(".scope") && path.includes("/user@")) args.push(`--property=BindsTo=${unit}`, `--property=After=${unit}`);
  args.push("--");
  return args;
}

/** How to start this run held to its slot's share: `systemd-run` and its arguments, once it has started `true` the same
 * way; undefined off Linux, without a user manager, or when that fails, and the run starts uncapped, as before. */
function capped(home: string, slots: number): string[] | undefined {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) return undefined;
  const systemdRun = Bun.which("systemd-run");
  if (!systemdRun) return undefined;
  let cgroup = "";
  try {
    cgroup = readFileSync("/proc/self/cgroup", "utf8");
  } catch {}
  const m = machineHere(home);
  const args = [systemdRun, ...quotaArgs(slotShare(m.cores, m.buildSlots * m.buildJobs, slots), cgroup)];
  const probe = Bun.spawnSync([...args, "true"], { stdout: "ignore", stderr: "pipe", timeout: 5_000 });
  if (probe.exitCode === 0) return args;
  process.stderr.write(`fleetd: couldn't cap this run at its slot's share of the CPUs (${probe.stderr.toString().trim() || "systemd-run failed"}): it may use every CPU\n`);
  return undefined;
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
  const cap = slot === undefined ? undefined : capped(home, slots);
  // Held in this process only, never handed to the run's children: a server a test leaves running can't keep it.
  const env = { ...process.env, [HELD]: "1", [OLD.held]: "1" };
  const code = cap ? await runInherited(cap[0]!, [...cap.slice(1), bin, ...args], env) : await runInherited(bin, args, env);
  for (const fd of slot ?? []) closeSync(fd);
  return code;
}
