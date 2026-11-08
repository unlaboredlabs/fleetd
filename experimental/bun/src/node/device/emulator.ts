// The emulators sessions get (crates/fleetd/src/node/device/emulator.rs): `-read-only` copies of the node's virtual
// device, each booted from its Quick Boot snapshot (about 8 s on a KVM host) and thrown away with everything done in
// it, and a warm pool of booted ones so a session starts from one at once while the pool boots the next behind it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { adb, AVD, kvm, type KvmCheck, quoted, type Sdk, sdkEnv } from "./sdk.ts";
import { pushServer } from "./scrcpy.ts";
import { agentSpawn } from "../oom.ts";

/** A copy from the snapshot boots in about 8 s; this allows a loaded machine. */
export const BOOT_TIMEOUT = 120_000;

/** The console ports adb finds emulators on by itself: 5554, 5556, ... 5584 (adb on each one's next port). */
const PORTS = { first: 5554, last: 5584 };

/** One running emulator in its own process group (the emulator starts qemu as a child): killed with it. */
export class Emulator {
  /** scrcpy's server is on it already (the pool pushed it while the copy waited). */
  pushed = false;
  readonly serial: string;
  /** The emulator's first error lines, to say why a boot failed. */
  private readonly said: string[] = [];

  constructor(
    private readonly child: Subprocess<"ignore", "pipe", "pipe">,
    readonly port: number,
  ) {
    this.serial = `emulator-${port}`;
    // Keep draining its output, or the emulator blocks once a pipe fills; its errors say why a boot failed.
    for (const out of [child.stdout, child.stderr]) void this.drain(out);
  }

  private async drain(out: ReadableStream<Uint8Array>): Promise<void> {
    let rest = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of out) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) if ((line.includes("ERROR") || line.includes("FATAL")) && this.said.length < 3) this.said.push(line.trim());
      }
    } catch {
      // The emulator is gone.
    }
  }

  get pid(): number {
    return this.child.pid;
  }

  alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  kill(): void {
    try {
      process.kill(-this.child.pid, "SIGKILL");
    } catch {
      // Its group is gone already.
    }
    this.child.kill("SIGKILL");
  }

  saidText(): string {
    return this.said.join(" / ");
  }
}

/** Whether nothing listens on 127.0.0.1:`port` (it binds, then lets go). */
function bindable(port: number): boolean {
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** An even console port no emulator of the node's holds (`taken`) and nothing else listens on. */
export function freePort(taken: Set<number>): number | undefined {
  for (let port = PORTS.first; port <= PORTS.last; port += 2) {
    if (!taken.has(port) && bindable(port) && bindable(port + 1)) return port;
  }
  return undefined;
}

/**
 * The emulator's flags: no window, no audio; a copy (`readOnly`) loads the snapshot and saves nothing, while the
 * node's one cold boot (sdk.ts) skips loading it so it can save it.
 */
export function emulatorArgs(port: number, readOnly: boolean): string[] {
  return [
    ...["-avd", AVD, "-no-window", "-no-audio", "-no-boot-anim", "-no-metrics", "-port", String(port)],
    ...(readOnly ? ["-read-only", "-no-snapshot-save"] : ["-no-snapshot-load"]),
  ];
}

/**
 * The command that starts the emulator: itself, or through `sg kvm` where the node's process lacks the group its user
 * has joined since. sg execs the shell, which execs the emulator: one process, its pid the child's, so its process
 * group is killed as ever.
 */
export function emulatorCommand(sdk: Sdk, args: string[], how: "direct" | "sg" | undefined): string[] {
  if (how === "sg") return ["sg", "kvm", "-c", `exec ${[sdk.emulator, ...args].map(quoted).join(" ")}`];
  return [sdk.emulator, ...args];
}

export function spawnEmulator(sdk: Sdk, port: number, readOnly: boolean, kvmCheck: KvmCheck = kvm): Emulator {
  const k = kvmCheck();
  const how = "ok" in k ? k.ok : undefined;
  let child: Subprocess<"ignore", "pipe", "pipe">;
  try {
    // At the agent OOM score, so memory pressure takes the emulator before the node (oom.ts).
    const [exe, ...rest] = emulatorCommand(sdk, emulatorArgs(port, readOnly), how);
    child = Bun.spawn(agentSpawn(exe!, rest).flat(), {
      env: { ...process.env, ...sdkEnv(sdk) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (e) {
    throw new Error(`cannot start ${sdk.emulator}: ${(e as Error).message}`);
  }
  return new Emulator(child, port);
}

/** Waits until Android says it finished booting, or the emulator quits, or `timeoutMs` passes, or `stop` says so. */
export async function waitBooted(sdk: Sdk, serial: string, emulator: Emulator, timeoutMs: number, stop = () => false): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (stop()) throw new Error("the node is stopping");
    if (!emulator.alive()) {
      const said = emulator.saidText();
      throw new Error(said ? `the emulator quit: ${said}` : "the emulator quit");
    }
    const booted = await adb(sdk, serial, ["shell", "getprop", "sys.boot_completed"], 5_000).catch(() => undefined);
    if (booted?.stdout.trim() === "1") return;
    if (Date.now() > deadline) throw new Error(`Android did not finish booting in ${Math.round(timeoutMs / 1000)} s`);
    await Bun.sleep(200);
  }
}

/**
 * Whether a process's command line (NUL-separated) is an emulator of `ours` (the SDK's emulator directory) for the
 * node's AVD.
 */
export function isLeftover(cmdline: string, ours: string): boolean {
  const args = cmdline.split("\0");
  const program = args[0] ?? "";
  const under = program === ours || program.startsWith(`${ours.replace(/\/$/, "")}/`);
  return under && args.some((a, i) => a === "-avd" && args[i + 1] === AVD);
}

/**
 * Kills the emulators of this node's virtual device that run with no node holding them (one that died, or was killed,
 * leaves its copies running: about 2 GB each). Found by their command line: this SDK's emulator, this AVD. Returns how
 * many.
 */
export function killLeftovers(sdk: Sdk): number {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return 0;
  }
  const ours = join(sdk.root, "emulator");
  let killed = 0;
  for (const pid of pids) {
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "latin1");
    } catch {
      continue;
    }
    if (!isLeftover(cmdline, ours)) continue;
    try {
      process.kill(Number(pid), "SIGKILL");
      killed++;
    } catch {
      // Gone meanwhile.
    }
  }
  return killed;
}

/** A copy a session holds: `release` kills it and gives its port back to the pool. */
export type Lent = { emulator: Emulator; release(): void };

/** Booted copies waiting for a session: taking one costs no boot, and the pool boots a new one behind it. */
export class Pool {
  private readonly warmCopies: Emulator[] = [];
  /** The ports of every copy the pool started that still runs, waiting or in a session. */
  private readonly ports = new Set<number>();
  private filling = false;
  /** Drained (the node stops): a boot still under way kills its copy instead of keeping it. */
  private closed = false;

  constructor(
    readonly sdk: Sdk,
    private readonly size: number,
    private readonly kvmCheck: KvmCheck = kvm,
  ) {}

  /** Boots a copy now, and puts scrcpy's server on it for its session's stream. */
  private async boot(): Promise<Emulator> {
    const port = freePort(this.ports);
    if (port === undefined) throw new Error("every emulator port adb watches (5554-5584) is in use");
    this.ports.add(port);
    let emulator: Emulator | undefined;
    try {
      emulator = spawnEmulator(this.sdk, port, true, this.kvmCheck);
      await waitBooted(this.sdk, emulator.serial, emulator, BOOT_TIMEOUT, () => this.closed);
    } catch (e) {
      emulator?.kill();
      this.ports.delete(port);
      throw e;
    }
    try {
      await pushServer(this.sdk, emulator.serial);
      emulator.pushed = true;
    } catch (e) {
      console.warn(`${emulator.serial}: scrcpy's server not pushed ahead; the session pushes it: ${(e as Error).message}`);
    }
    return emulator;
  }

  /** A booted copy, or one booted now when none waits; the pool refills behind it. */
  async take(): Promise<Lent> {
    let emulator: Emulator | undefined;
    for (let next = this.warmCopies.shift(); next; next = this.warmCopies.shift()) {
      if (next.alive()) {
        emulator = next;
        break;
      }
      // One that died while it waited goes; try the next.
      this.ports.delete(next.port);
    }
    emulator ??= await this.boot();
    this.refill();
    const lent = emulator;
    return {
      emulator: lent,
      release: () => {
        lent.kill();
        this.ports.delete(lent.port);
      },
    };
  }

  /** Boots copies in the background until the pool holds its size. */
  refill(): void {
    if (this.filling) return;
    this.filling = true;
    void (async () => {
      try {
        while (this.warmCopies.length < this.size && !this.closed) {
          const emulator = await this.boot();
          if (this.closed) {
            emulator.kill();
            this.ports.delete(emulator.port);
            return;
          }
          this.warmCopies.push(emulator);
        }
      } catch (e) {
        console.warn(`emulator pool not refilled: ${(e as Error).message}`);
      } finally {
        this.filling = false;
      }
    })();
  }

  warm(): number {
    return this.warmCopies.length;
  }

  /** Kills every waiting copy. */
  drain(): void {
    this.closed = true;
    for (const emulator of this.warmCopies.splice(0)) {
      emulator.kill();
      this.ports.delete(emulator.port);
    }
  }
}
