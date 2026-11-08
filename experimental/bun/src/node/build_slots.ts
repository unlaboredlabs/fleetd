// `fleetd build-slot <node home> <cargo's arguments>` (crates/fleetd/src/node/build_slots.rs): an agent's cargo build
// takes one of the machine's build slots (a file under `<node home>/build-slots` it holds a flock on) while the real
// cargo runs; with every slot in use it queues, first come first served. Every other cargo command runs at once.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { lock, tryLock } from "./flock.ts";

export const COMMAND = "build-slot";
export const MEM_PER_BUILD_GB = 11;
const HEAVY = ["build", "b", "check", "c", "clippy", "test", "t", "bench", "doc", "d", "rustc", "rustdoc", "install", "fix", "nextest", "llvm-cov", "miri"];
const TESTS = ["test", "t", "bench", "nextest", "llvm-cov"];
const HELD = "FLEETD_BUILD_SLOT";
const POLL_MS = 500;
const PRINTS_ONLY = ["--version", "-V", "--help", "-h"];
const RUN_VALUES = ["-p", "--package", "--bin", "--example", "-F", "--features", "-j", "--jobs", "--profile", "--target", "--target-dir", "--manifest-path", "--message-format", "--color", "--config", "-Z", "-C", "--lockfile-path"];

export const dir = (home: string) => join(home, "build-slots");
export const binDir = (home: string) => join(dir(home), "bin");

/** The slots `memTotal` bytes fit: a quarter (4 to 16 GB) kept back, then one per 11 GB, at least one; unknown: 2. */
export function slotsFit(memTotal: number | undefined): number {
  if (memTotal === undefined) return 2;
  const total = Math.ceil(memTotal / 2 ** 30);
  const reserve = Math.min(16, Math.max(4, Math.floor(total / 4)));
  return Math.max(1, Math.floor(Math.max(0, total - reserve) / MEM_PER_BUILD_GB));
}

/** This machine's memory: /proc/meminfo's MemTotal, or macOS's hw.memsize. */
export function memTotal(): number | undefined {
  if (process.platform === "linux") {
    try {
      const kb = /^MemTotal:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
      return kb === undefined ? undefined : Number(kb) * 1024;
    } catch {
      return undefined;
    }
  }
  const out = Bun.spawnSync(["sysctl", "-n", "hw.memsize"], { stderr: "ignore" }).stdout.toString().trim();
  return /^\d+$/.test(out) ? Number(out) : undefined;
}

/** node.json's `buildSlots`, else what memory fits; undefined when `buildSlots` is 0: no turns. */
export function slotsHere(home: string): number | undefined {
  let set: number | undefined;
  try {
    const config = JSON.parse(readFileSync(join(home, "node.json"), "utf8"));
    // As the Rust node reads node.json: a file missing a field it needs counts as none.
    const valid =
      typeof config?.hub === "string" && typeof config.name === "string" && typeof config.enrolled === "boolean" &&
      typeof config.machineId === "string" && /^[a-z0-9-]{1,32}$/.test(config.machineId);
    if (valid && typeof config.buildSlots === "number") set = config.buildSlots;
  } catch {}
  if (set === 0) return undefined;
  return set ?? slotsFit(memTotal());
}

/** Where cargo's command is: the first argument neither a toolchain nor a flag (nor a global flag's value). */
function commandAt(args: string[]): number | undefined {
  let at = 0;
  while (at < args.length) {
    const arg = args[at]!;
    if (["-C", "--config", "-Z", "--color"].includes(arg)) at += 2;
    else if (arg.startsWith("-") || arg.startsWith("+")) at += 1;
    else return at;
  }
  return undefined;
}

const untilDashes = (args: string[]) => {
  const end = args.indexOf("--");
  return end < 0 ? args : args.slice(0, end);
};

export function heavy(args: string[]): boolean {
  const at = commandAt(args);
  return at !== undefined && HEAVY.includes(args[at]!) && !compilesNothing(args);
}

/** Two slots when a build may compile a lib's tests beside the lib, else one. */
export function slotsTaken(args: string[]): number {
  const at = commandAt(args);
  if (at === undefined) return 1;
  let [lib, others, both, packages] = [false, false, false, 0];
  for (const arg of untilDashes(args.slice(at + 1))) {
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (flag === "--lib") lib = true;
    else if (flag === "-p" || flag === "--package") packages += 1;
    else if (flag === "--workspace" || flag === "--all") packages += 2;
    else if (flag === "--all-targets" || flag === "--tests") both = true;
    else if (["--bin", "--bins", "--test", "--bench", "--benches", "--example", "--examples", "--doc"].includes(flag)) others = true;
  }
  const command = args[at]!;
  const two = TESTS.includes(command) ? both || lib === others || (lib && packages > 1) : both && (command === "build" || command === "b");
  return two ? 2 : 1;
}

/** Whether cargo's `args` compile nothing: no command, a version or help flag of the command's own, `install --list`. */
export function compilesNothing(args: string[]): boolean {
  const at = commandAt(args);
  if (at === undefined) return true;
  const command = args[at]!;
  const run = command === "run" || command === "r";
  const rest = untilDashes(args.slice(at + 1));
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (PRINTS_ONLY.includes(arg) || (command === "install" && arg === "--list")) return true;
    if (run && RUN_VALUES.includes(arg)) i++;
    else if (run && !arg.startsWith("-")) return false;
  }
  return false;
}

/** For a `cargo run`, the `cargo build` of what it runs. */
export function buildFirst(args: string[]): string[] | undefined {
  const at = commandAt(args);
  if (at === undefined || (args[at] !== "run" && args[at] !== "r")) return undefined;
  const build = [...args.slice(0, at), "build"];
  const rest = untilDashes(args.slice(at + 1));
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("-")) continue;
    build.push(arg);
    if (RUN_VALUES.includes(arg) && i + 1 < rest.length) build.push(rest[++i]!);
  }
  return build;
}

/** `'value'`, as the node's order_env quotes for a shell. */
const quoted = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;

/** Writes the cargo wrapper, which runs `exe`, unless it already says the same; its path. */
export function install(home: string, exe: string): string {
  const bin = binDir(home);
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const wrapper = join(bin, "cargo");
  const script = `#!/bin/sh\n# fleetd's: an agent's cargo build waits its turn for one of the machine's build slots.\nexec ${quoted(exe)} ${COMMAND} ${quoted(home)} "$@"\n`;
  let old: string | undefined;
  try {
    old = readFileSync(wrapper, "utf8");
  } catch {}
  if (old !== script) {
    const tmp = join(bin, `.cargo-${process.pid}`);
    writeFileSync(tmp, script);
    chmodSync(tmp, 0o755);
    renameSync(tmp, wrapper);
  }
  return wrapper;
}

/** The first `cargo` on `path` outside `skip`. */
export function realCargo(path: string, skip: string): string | undefined {
  const canon = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const skipped = canon(skip);
  for (const d of path.split(":")) {
    if (canon(d) === skipped) continue;
    const bin = join(d, "cargo");
    try {
      const st = statSync(bin);
      if (st.isFile() && (st.mode & 0o111) !== 0) return bin;
    } catch {}
  }
  return undefined;
}

type Ticket = { path: string; fd: number };

function ticket(queue: string): Ticket {
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const nanos = (BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor((performance.now() % 1) * 1e6))).toString().padStart(20, "0");
  const name = `${nanos}-${process.pid}`;
  for (let n = 0; ; n++) {
    const tmp = join(queue, `.${name}-${n}`);
    let fd: number;
    try {
      fd = openSync(tmp, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    lock(fd);
    const path = join(queue, `${name}-${n}`);
    renameSync(tmp, path);
    return { path, fd };
  }
}

/** The live tickets that sort before `mine`; removes those whose owner is gone. */
function ahead(queue: string, mine: string): number {
  let count = 0;
  for (const name of readdirSync(queue)) {
    const path = join(queue, name);
    if (name.startsWith(".") || Buffer.compare(Buffer.from(path), Buffer.from(mine)) >= 0) continue;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      continue;
    }
    try {
      if (tryLock(fd)) rmSync(path, { force: true });
      else count++;
    } finally {
      closeSync(fd);
    }
  }
  return count;
}

/** `need` free ones of `slots` slots (all of them if it needs more), if there are that many free: their fds. */
function freeSlot(d: string, slots: number, need: number): number[] | undefined {
  const locks: number[] = [];
  for (let i = 0; i < slots; i++) {
    const fd = openSync(join(d, `slot-${i}`), "a");
    if (tryLock(fd)) locks.push(fd);
    else closeSync(fd);
    if (locks.length === Math.min(need, slots)) return locks;
  }
  for (const fd of locks) closeSync(fd);
  return undefined;
}

/** Takes `need` of `slots` slots after every build queued before this one; `queued` hears once how many are ahead. */
export async function take(d: string, slots: number, need: number, pollMs: number, queued: (ahead: number) => void): Promise<number[]> {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const queue = join(d, "queue");
  const mine = ticket(queue);
  let told = false;
  try {
    for (;;) {
      const n = ahead(queue, mine.path);
      if (n === 0) {
        const slot = freeSlot(d, slots, need);
        if (slot) return slot;
      }
      if (!told) {
        queued(n);
        told = true;
      }
      await Bun.sleep(pollMs);
    }
  } finally {
    rmSync(mine.path, { force: true });
    closeSync(mine.fd);
  }
}

export function queuedLine(slots: number, ahead: number): string {
  const place = ahead === 0 ? "next in line" : ahead === 1 ? "1 build ahead" : `${ahead} builds ahead`;
  return `fleetd: queued for a build slot (${place}; ${slots === 1 ? "1 slot" : `${slots} slots`} on this machine): it starts once one frees`;
}

/** Runs cargo with inherited stdio and its signals passed on; its exit code, 128+signal when a signal ended it. */
async function runCargo(cargo: string, args: string[], env: Record<string, string | undefined>): Promise<number> {
  let proc;
  try {
    proc = Bun.spawn([cargo, ...args], { stdio: ["inherit", "inherit", "inherit"], env });
  } catch (error) {
    process.stderr.write(`fleetd: cannot run ${cargo}: ${(error as Error).message}\n`);
    return 126;
  }
  const forward = (s: NodeJS.Signals) => () => proc.kill(s);
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => [s, forward(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  const code = await proc.exited;
  for (const [s, h] of handlers) process.off(s, h);
  if (proc.signalCode) {
    const n = (constants.signals as Record<string, number>)[proc.signalCode];
    return n === undefined ? 1 : 128 + n;
  }
  return code;
}

export async function main(argv: string[]): Promise<number> {
  const [home, ...args] = argv;
  if (home === undefined) {
    process.stderr.write(`fleetd: ${COMMAND} needs the node home, then cargo's arguments\n`);
    return 2;
  }
  const cargo = realCargo(process.env.PATH ?? "", binDir(home));
  if (cargo === undefined) {
    process.stderr.write("fleetd: no cargo on PATH beside fleetd's build-slot wrapper\n");
    return 127;
  }
  const held = process.env[HELD] !== undefined;
  const build = !held && !compilesNothing(args) ? buildFirst(args) : undefined;
  const waits = !held && (build !== undefined || heavy(args));
  const slots = waits ? slotsHere(home) : undefined;
  if (slots === undefined) return runCargo(cargo, args, process.env);
  let slot: number[] | undefined;
  try {
    slot = await take(dir(home), slots, slotsTaken(args), POLL_MS, (n) => process.stderr.write(`${queuedLine(slots, n)}\n`));
  } catch (error) {
    process.stderr.write(`fleetd: build slots unavailable (${(error as Error).message}): building without waiting\n`);
  }
  const code = await runCargo(cargo, build ?? args, { ...process.env, [HELD]: "1" });
  for (const fd of slot ?? []) closeSync(fd);
  if (build !== undefined && code === 0) return runCargo(cargo, args, process.env);
  return code;
}
