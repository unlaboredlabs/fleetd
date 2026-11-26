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
// The run's scope sits beside its session's, so it takes only what the session's memory cap has left (memoryLeft),
// and the wrapper watches it for kills by that cap and tells the agent, as the session's host does for its own scope.
import { closeSync, existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as buildSlots from "./build_slots.ts";
import { runInherited, take, writeWrapper } from "./build_slots.ts";
import { readConfig } from "./config.ts";
import { buildJobsHere } from "./load/index.ts";
import { noteFile, watchMemory } from "./runner/host/memory.ts";
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

/** A run's memory cap: `MemoryMax=` and, where the caller has one, `MemorySwapMax=`, in bytes. */
export type Memory = { max: number; swapMax?: number };

/** What the cgroup in `dir` (the session's scope) leaves for a run that starts outside it: its memory cap less what it
 * holds now, page cache aside (the kernel takes that back first), and its swap cap less the swap it uses. So the session
 * and its run stay inside the one cap together, never a second full one beside it. Undefined where it has no cap. */
export function memoryLeft(dir: string): Memory | undefined {
  const max = cgroupNumber(join(dir, "memory.max"));
  if (max === undefined) return undefined;
  let stat = "";
  try {
    stat = readFileSync(join(dir, "memory.stat"), "utf8");
  } catch {}
  const cache = Number(/^file (\d+)$/m.exec(stat)?.[1] ?? 0);
  const held = Math.max(0, (cgroupNumber(join(dir, "memory.current")) ?? 0) - cache);
  const swapMax = cgroupNumber(join(dir, "memory.swap.max"));
  const swapLeft = swapMax === undefined ? undefined : Math.max(0, swapMax - (cgroupNumber(join(dir, "memory.swap.current")) ?? 0));
  return { max: Math.max(0, max - held), ...(swapLeft === undefined ? {} : { swapMax: swapLeft }) };
}

/** The unit a cgroup path (`/proc/self/cgroup`'s, `/user.slice/…/user@1000.service/app.slice/run-p1-i2.scope`) is in
 * under a user manager: the session's scope, or the node's own service where sessions run without one. Undefined
 * outside a user manager. */
export function callerUnit(path: string): string | undefined {
  const parts = path.split("/");
  const manager = parts.findIndex((p) => p.startsWith("user@") && p.endsWith(".service"));
  const last = parts.at(-1);
  return manager >= 0 && parts.length - 1 > manager && last !== undefined && /\.(scope|service)$/.test(last) ? last : undefined;
}

/** How a heavy run's scope is set up: its CPUs, its memory cap (memoryLeft), the unit it is bound to (callerUnit), and
 * whether the quota's period is short (`CPUQuotaPeriodSec=10ms`, where this systemd takes it). */
export type RunScope = { cpus: number; memory?: Memory; unit?: string; shortPeriod: boolean };

/** The quota's period: a run held back waits at most this long at a time, where the default 100 ms let a run that sized
 * itself to all 32 CPUs stall a test's 5 ms timer for up to 103 ms. */
export const PERIOD = "10ms";

/** `systemd-run`'s arguments that start a run in a scope of its own, up to the `--`: capped at `cpus` CPUs, inside what
 * its session's memory cap has left, with the session's OOM policy (runner/scope.ts), and bound to the caller's unit: a
 * stopped agent's run stops with it, and one whose wrapper the node's restart stops (sessions without scopes of their
 * own run in its unit) stops with its slot. */
export function quotaArgs(r: RunScope): string[] {
  const args = ["--user", "--scope", "--quiet", "--collect", "--description=fleetd heavy run", `--property=CPUQuota=${r.cpus * 100}%`];
  if (r.shortPeriod) args.push(`--property=CPUQuotaPeriodSec=${PERIOD}`);
  args.push("--property=OOMPolicy=continue");
  if (r.memory) {
    args.push(`--property=MemoryMax=${r.memory.max}`);
    if (r.memory.swapMax !== undefined) args.push(`--property=MemorySwapMax=${r.memory.swapMax}`);
  }
  if (r.unit !== undefined) args.push(`--property=BindsTo=${r.unit}`, `--property=After=${r.unit}`);
  args.push("--");
  return args;
}

/** This process's cgroup path, from /proc/self/cgroup's v2 line. */
function cgroupPath(pid: number | "self" = "self"): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::"))?.slice(3);
  } catch {
    return undefined;
  }
}

/** How to start this run held to its slot's share: `systemd-run` and its arguments, once it has started `true` the same
 * way (with the short period, else the default one); undefined off Linux, without a user manager, or when both fail,
 * and the run starts uncapped, as before. */
function capped(home: string, slots: number): string[] | undefined {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) return undefined;
  const systemdRun = Bun.which("systemd-run");
  if (!systemdRun) return undefined;
  const path = cgroupPath() ?? "";
  const m = machineHere(home);
  const memory = path ? memoryLeft(join("/sys/fs/cgroup", path)) : undefined;
  const unit = callerUnit(path);
  let why = "";
  for (const shortPeriod of [true, false]) {
    const r: RunScope = { cpus: slotShare(m.cores, m.buildSlots * m.buildJobs, slots), shortPeriod, ...(memory ? { memory } : {}), ...(unit ? { unit } : {}) };
    const args = [systemdRun, ...quotaArgs(r)];
    const probe = Bun.spawnSync([...args, "true"], { stdout: "ignore", stderr: "pipe", timeout: 5_000 });
    if (probe.exitCode === 0) return args;
    why = probe.stderr.toString().trim() || "systemd-run failed";
  }
  process.stderr.write(`fleetd: couldn't cap this run at its slot's share of the CPUs (${why}): it may use every CPU\n`);
  return undefined;
}

/** Once the run `pid` is in its own scope (systemd-run moves itself there, then execs the run), watches that scope for
 * kills by its memory cap as the session's host watches the session's (runner/host/memory.ts), and notes each where the
 * session's hook hands it to the agent: the run's scope is outside the session's, which the host's watch can't see.
 * Nothing outside a session (no FLEETD_RUNNER_SESSION). */
async function watchRun(home: string, pid: number): Promise<(() => void) | undefined> {
  const session = process.env.FLEETD_RUNNER_SESSION?.split(".")[0];
  const mine = cgroupPath();
  if (!session || mine === undefined) return undefined;
  for (const end = Date.now() + 5_000; Date.now() < end; await Bun.sleep(50)) {
    const path = cgroupPath(pid);
    if (path === undefined) return undefined;
    // As the node names it (place/index.ts hostDir): the host's dir is the node home's hosts/<session>.
    if (path !== mine) return watchMemory(noteFile(join(home, "hosts", session)), join("/sys/fs/cgroup", path), undefined, true);
  }
  return undefined;
}

/** `--slots <n>`: as many slots as the caller sized (the agents' Mac's builds, mac_tool/protocol.ts macBuilds), not
 * what this machine's heavy runs fit. */
export async function main(argv: string[]): Promise<number> {
  const sized = argv[0] === "--slots" && /^[1-9][0-9]*$/.test(argv[1] ?? "") ? Number(argv[1]) : undefined;
  const [home, bin, ...args] = sized === undefined ? argv : argv.slice(2);
  if (home === undefined || bin === undefined) {
    process.stderr.write(`fleetd: ${COMMAND} needs the node home, then the command to run\n`);
    return 2;
  }
  const held = process.env[HELD] !== undefined || process.env[OLD.held] !== undefined;
  const slots = held || declaredLight(process.cwd(), [bin, ...args]) ? undefined : (sized ?? slotsHere(home));
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
  let stopWatch: Promise<(() => void) | undefined> | undefined;
  const code = cap
    ? await runInherited(cap[0]!, [...cap.slice(1), bin, ...args], env, (pid) => (stopWatch = watchRun(home, pid)))
    : await runInherited(bin, args, env);
  (await stopWatch)?.();
  for (const fd of slot ?? []) closeSync(fd);
  return code;
}
