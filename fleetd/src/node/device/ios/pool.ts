// The simulators agents get (crates/fleetd/src/node/device/ios/pool.rs). The node makes one golden simulator in its set
// (the newest iOS runtime, a plain iPhone), boots it once and lets it settle, has agent-device build its XCTest runner
// against it, and shuts it down: `simctl clone` copies only a simulator that is shut down. Each agent gets a clone of
// it, booted ahead of time in a warm pool with agent-device's runner already started in it (from an agent-device home
// made for that clone alone), and the clone is deleted with everything done in it, its home too, when it is given
// back; the pool clones, boots and starts the next behind it.
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkdirPrivate } from "../../config.ts";
import { writeAtomic } from "../../secrets/files.ts";
import { daemonPid, findAgentDevice, install as installAgentDevice, VERSION } from "../agent_device.ts";
import { isPlainIphone, pick, scale, Simctl } from "./simctl.ts";
import { binDir, builtXctestrun, findWrapper, installWrapper, iosDir, setDir, writeDevice } from "./wrapper.ts";

/** How long an agent's own agent-device gives its XCTest runner to start (session.rs `RUNNER_START`). */
export const RUNNER_START = 300_000;
/** A clone of a settled simulator boots in seconds on a Mac; this allows a loaded one. */
export const BOOT_TIMEOUT = 300_000;
/** How long startRunner gives a clone's runner: agent-device's whole start, and a minute for it to exit. */
const RUNNER_START_MAX = RUNNER_START + 60_000;
/** A simulator of a type the agent named boots from nothing (a first boot), within the agent's wait for `mac`'s answer. */
export const OWN_BOOT = 150_000;
/** The golden's first boot: it migrates data and builds caches. */
const FIRST_BOOT = 600_000;
/** agent-device's runner builds with xcodebuild: minutes on a laptop. */
const RUNNER_BUILD = 1_500_000;
/** How long one of TOOLCHAIN's reads may take, cold, before the golden is made. */
const TOOLCHAIN_READ = 300_000;
/** What agent-device reads of Xcode before it builds or starts its runner: read first, while the Mac is quiet. */
const TOOLCHAIN = [
  ["xcodebuild", "-version"],
  ["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"],
  ["xcrun", "--sdk", "iphonesimulator", "--show-sdk-build-version"],
];
/** How long agent-device's daemon may take to stop its runner and exit. */
const DAEMON_EXIT = 60_000;
/** How long the golden may take to settle before it is shut down anyway. */
const SETTLE_MAX = 600_000;
/** A simulator is settled once its processes together use less than this share of one core, SETTLED_SAMPLES running. */
const SETTLED_CPU = 25;
const SETTLED_SAMPLES = 3;
const SAMPLE_EVERY = 5_000;
/** After a boot fails the pool waits this long before the next, doubling with each failure in a row up to BACKOFF_MAX. */
const BACKOFF_FIRST = 60_000;
export const BACKOFF_MAX = 30 * 60_000;
/** What a boot is guessed to take before one has been timed. */
const BOOT_GUESS = 30_000;
/** The shortest wait a start is told. */
const WAIT_MIN = 5_000;

export const GOLDEN_NAME = "fleetd-golden";

export const shortId = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The golden simulator, as `<node home>/device/ios/golden.json` keeps it once made. */
export type Golden = {
  udid: string;
  runtime: string;
  /** "iOS 27.0". */
  runtimeName: string;
  deviceType: string;
  /** "iPhone 17". */
  deviceTypeName: string;
  /** The screen's pixels per point. */
  scale: number;
  /** The agent-device release whose runner was built for it. */
  agentDevice: string;
  /** That runner's `.xctestrun`, which every agent's agent-device starts as it is. */
  xctestrun: string;
};

export const goldenPath = (home: string) => join(iosDir(home), "golden.json");

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The golden, when it was made for the pinned agent-device, its runner is there, and it is of node.json's
 * `ios.deviceType` (`wanted`), or with none set a plain iPhone. A wrapper an older node wrote is written again.
 */
export function findGolden(home: string, wanted?: string): Golden | undefined {
  let golden: Golden;
  try {
    golden = JSON.parse(readFileSync(goldenPath(home), "utf8")) as Golden;
  } catch {
    return undefined;
  }
  const itsType = wanted !== undefined ? golden.deviceTypeName === wanted || golden.deviceType === wanted : isPlainIphone(golden.deviceTypeName ?? "");
  if (golden.agentDevice !== VERSION || !findAgentDevice(home) || !isFile(golden.xctestrun) || !itsType) return undefined;
  if (!findWrapper(home, golden.xctestrun)) {
    try {
      installWrapper(home, golden.xctestrun);
    } catch {
      return undefined;
    }
  }
  return golden;
}

/** Runs `argv` to its end within `ms`: its exit code (null when it was killed), stdout and stderr. */
async function run(argv: string[], ms: number, env?: Record<string, string | undefined>): Promise<{ code: number | null; out: string; err: string }> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code: child.signalCode ? null : code, out, err };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Makes the golden simulator, from nothing: whatever the set held goes first. `deviceType` names the device type to
 * use (node.json's `ios.deviceType`); absent, a plain iPhone.
 */
export async function prepare(home: string, deviceType?: string, simctl = new Simctl(setDir(home))): Promise<Golden> {
  if (!findAgentDevice(home)) await installAgentDevice(home);
  const wrapper = installWrapper(home);
  const [runtime, type] = pick(await simctl.runtimes(), deviceType);
  await toolchain();
  rmSync(goldenPath(home), { force: true });
  await clear(simctl);
  await clearHomes(home);
  const udid = await simctl.create(GOLDEN_NAME, type.identifier, runtime.identifier);
  let xctestrun: string;
  try {
    await simctl.boot(udid, FIRST_BOOT);
    await settle(udid);
    await buildRunner(home, wrapper, udid);
    await simctl.shutdown(udid);
    xctestrun = builtXctestrun(home);
    installWrapper(home, xctestrun);
  } catch (e) {
    await simctl.shutdown(udid).catch(() => {});
    await simctl.delete(udid).catch(() => {});
    throw e;
  }
  const golden: Golden = {
    udid,
    runtime: runtime.identifier,
    runtimeName: runtime.name,
    deviceType: type.identifier,
    deviceTypeName: type.name,
    scale: await scale(type),
    agentDevice: VERSION,
    xctestrun,
  };
  writeAtomic(goldenPath(home), JSON.stringify(golden, null, 2));
  return golden;
}

/** Reads TOOLCHAIN once, each to its end: what they say, and whether they fail, is agent-device's to report. */
async function toolchain(): Promise<void> {
  for (const argv of TOOLCHAIN) await run(argv, TOOLCHAIN_READ).catch(() => undefined);
}

/** Waits until the booted golden's processes go quiet, or SETTLE_MAX passes. */
async function settle(udid: string): Promise<void> {
  const started = Date.now();
  let quiet = 0;
  while (quiet < SETTLED_SAMPLES && Date.now() - started < SETTLE_MAX) {
    await Bun.sleep(SAMPLE_EVERY);
    const ps = await run(["ps", "-A", "-o", "pid=,ppid=,%cpu=,command="], 30_000).catch(() => undefined);
    const cpu = ps ? deviceCpu(ps.out, udid) : undefined;
    quiet = cpu !== undefined && cpu < SETTLED_CPU ? quiet + 1 : 0;
  }
}

/**
 * The CPU a simulator's processes use together, as `ps -A -o pid=,ppid=,%cpu=,command=` lists them: its `launchd_sim`
 * (whose arguments hold the simulator's data path, and so its udid) and everything under it.
 */
export function deviceCpu(ps: string, udid: string): number {
  const procs = ps.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), command: m[4]!.trim() }] : [];
  });
  const ours = procs.filter((p) => p.command.includes("launchd_sim") && p.command.includes(udid)).map((p) => p.pid);
  for (let i = 0; i < ours.length; i++) {
    for (const p of procs) if (p.ppid === ours[i] && !ours.includes(p.pid)) ours.push(p.pid);
  }
  return procs.filter((p) => ours.includes(p.pid)).reduce((sum, p) => sum + p.cpu, 0);
}

/** Has agent-device build its XCTest runner for the golden and start it once, then stops the daemon that did. */
async function buildRunner(home: string, wrapper: string, udid: string): Promise<void> {
  const dir = join(iosDir(home), "prepare");
  const state = join(dir, "state");
  mkdirPrivate(dir);
  const env = { ...process.env, AGENT_DEVICE_HOME: dir, AGENT_DEVICE_STATE_DIR: state, AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" };
  delete (env as Record<string, unknown>).FLEETD_DEVICE_CONTROL;
  const out = await run([wrapper, "prepare", "ios-runner", "--platform", "ios", "--udid", udid, "--timeout", String(RUNNER_BUILD)], RUNNER_BUILD + 60_000, env);
  await stopDaemon(state);
  if (out.code === null) throw new Error("agent-device's runner did not build in 25 minutes");
  if (out.code !== 0) throw new Error(`agent-device's runner did not build: ${[...`${out.out}${out.err}`.trim()].slice(0, 300).join("")}`);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Ends the agent-device daemon whose state directory is `state`, if one runs, and waits for it to exit: on its way out
 * it stops the XCTest runner it started, whose xcodebuild would otherwise boot the simulator again.
 */
export async function stopDaemon(state: string, within = DAEMON_EXIT): Promise<void> {
  const pid = daemonPid(state);
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const started = Date.now();
  while (alive(pid) && Date.now() - started < within) await Bun.sleep(100);
}

/**
 * A clone's own agent-device home, made for it alone and deleted with it. Its daemon's registration holds the token
 * that drives the clone, so it is outside `device` (which every Navi reads), in the node's home that Navis never see.
 */
export const cloneHome = (home: string, udid: string) => join(home, "ios-clones", udid);

/** Stops the daemons of the clone homes a stopped node left, and deletes them. Returns how many. */
export async function clearHomes(home: string): Promise<number> {
  const dir = join(home, "ios-clones");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let cleared = 0;
  for (const name of names) {
    await stopDaemon(join(dir, name, "state"));
    try {
      rmSync(join(dir, name), { recursive: true });
      cleared++;
    } catch {
      // Left for the next start.
    }
  }
  return cleared;
}

/** Deletes every simulator in the node's set but `keep`. Returns how many. */
export async function clear(simctl: Simctl, keep?: string): Promise<number> {
  let devices;
  try {
    devices = await simctl.devices();
  } catch {
    return 0;
  }
  let cleared = 0;
  for (const device of devices.filter((d) => d.udid !== keep)) {
    if (device.state !== "Shutdown") await simctl.shutdown(device.udid).catch(() => {});
    try {
      await simctl.delete(device.udid);
      cleared++;
    } catch {
      // Left for the next start.
    }
  }
  return cleared;
}

/** The wait after `failures` boots in a row failed. */
export const backoff = (failures: number) => Math.min(BACKOFF_FIRST * 2 ** Math.min(Math.max(failures - 1, 0), 16), BACKOFF_MAX);

/** Why a start has no clone now, and about how long until it has one (in seconds). */
export type Waiting = { secs: number; failing?: string; retryIn?: number };

/** How the pool's boots have gone: one under way, how long the last good one took, failures in a row and their backoff. */
export class Refill {
  bootingSince: number | undefined;
  lastBoot = BOOT_GUESS;
  failures = 0;
  retryAt: number | undefined;
  lastError: string | undefined;

  /** Whether a boot may start now: none under way, and no backoff running. */
  mayBoot(now: number): boolean {
    return this.bootingSince === undefined && (this.retryAt === undefined || now >= this.retryAt);
  }
  started(now: number): void {
    this.bootingSince = now;
  }
  succeeded(now: number): void {
    if (this.bootingSince !== undefined) this.lastBoot = now - this.bootingSince;
    this.bootingSince = undefined;
    this.failures = 0;
    this.retryAt = undefined;
    this.lastError = undefined;
  }
  /** Records a failure; returns the backoff it set. */
  failed(now: number, why: string): number {
    this.bootingSince = undefined;
    this.failures += 1;
    this.retryAt = now + backoff(this.failures);
    this.lastError = why;
    return backoff(this.failures);
  }
  /** A boot that ended without an outcome: the slot is free again, and nothing counts as a failure. */
  released(): void {
    this.bootingSince = undefined;
  }
  /** About how long until a clone is ready, with none warm. */
  wait(now: number): Waiting {
    const retryIn = this.bootingSince === undefined && this.retryAt !== undefined && this.retryAt > now ? this.retryAt - now : undefined;
    const left = this.bootingSince !== undefined ? Math.max(this.lastBoot - (now - this.bootingSince), 0) : (retryIn ?? 0) + this.lastBoot;
    return {
      secs: Math.floor(Math.max(left, WAIT_MIN) / 1000),
      ...(this.failures > 0 ? { failing: this.lastError ?? "" } : {}),
      ...(retryIn !== undefined ? { retryIn: Math.floor(Math.max(retryIn, WAIT_MIN) / 1000) } : {}),
    };
  }
}

/** What a start says with no warm clone, and what the agent does next. */
export function waitingWords(w: Waiting): [string, string] {
  if (w.failing === undefined) {
    return [`Starting a simulator for you; it is ready in about ${w.secs} s.`, `try session_start again in about ${w.secs} s`];
  }
  if (w.retryIn === undefined) {
    return [
      `This Mac's last iOS simulator boot failed (${w.failing}); another is booting now, ready in about ${w.secs} s if it works.`,
      `try session_start again in about ${w.secs} s, or carry on without it`,
    ];
  }
  return [
    `This Mac's iOS simulators keep failing to boot (${w.failing}); it tries again in about ${w.retryIn} s.`,
    "carry on without it and say so in your result, or try session_start again later",
  ];
}

/** A clone from the moment simctl made it: `discard` stops its daemon, shuts it down and deletes it with its home. */
export class Lent {
  /** The pool started the clone's runner in its home. */
  runner = false;
  private gone = false;

  constructor(
    readonly udid: string,
    /** The clone's own agent-device home (cloneHome). */
    readonly home: string,
    private readonly simctl: Simctl,
  ) {}

  /** Whether the runner the pool started is still up: its daemon runs. */
  runnerUp(): boolean {
    const pid = this.runner ? daemonPid(join(this.home, "state")) : undefined;
    return pid !== undefined && alive(pid);
  }

  /** Throws the clone away, in the background; once. */
  discard(): Promise<void> {
    if (this.gone) return Promise.resolve();
    this.gone = true;
    return (async () => {
      await stopDaemon(join(this.home, "state"));
      await this.simctl.shutdown(this.udid).catch(() => {});
      await this.simctl.delete(this.udid).catch(() => {});
      rmSync(this.home, { recursive: true, force: true });
    })();
  }
}

/** How a clone's runner starts: agent-device's wrapper, as its agent's first command would; or a test's. */
export type RunnerStarter = (home: string, lent: Lent) => Promise<void>;

/**
 * Starts the clone's XCTest runner in its own agent-device home, from the golden's build, with the whole RUNNER_START
 * for it. Its daemon keeps it up while the clone waits (`AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS=0`) and until it goes.
 */
export const startRunner: RunnerStarter = async (home, lent) => {
  writeDevice(lent.home, lent.udid);
  const env: Record<string, string | undefined> = {
    ...process.env,
    AGENT_DEVICE_HOME: lent.home,
    AGENT_DEVICE_STATE_DIR: join(lent.home, "state"),
    AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS: "0",
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
  };
  delete env.FLEETD_DEVICE_CONTROL;
  delete env.FLEETD_RUNNER_STARTING;
  const out = await run(
    [join(binDir(home), "agent-device"), "prepare", "ios-runner", "--platform", "ios", "--udid", lent.udid, "--timeout", String(RUNNER_START)],
    RUNNER_START_MAX,
    env,
  );
  if (out.code === null) throw new Error(`it did not start in ${RUNNER_START / 1000} s`);
  if (out.code !== 0) throw new Error([...out.err.trim()].slice(0, 300).join(""));
};

/** Booted clones waiting for an agent: taking one costs no boot, and the pool clones and boots another behind it. */
export class Pool {
  private readonly warmClones: Lent[] = [];
  /** Clones still booting or starting their runner: a drain throws them away too, daemon and all. */
  private readonly booting = new Set<Lent>();
  private filling = false;
  /** Drained (the node stops): a boot still under way deletes its clone instead of keeping it. */
  private closed = false;
  readonly refills = new Refill();

  constructor(
    readonly simctl: Simctl,
    /** The node's home: the wrapper, and the clones' agent-device homes. */
    private readonly home: string,
    readonly golden: Golden,
    private readonly size: number,
    private readonly runner: RunnerStarter = startRunner,
  ) {}

  /** Clones the golden, boots the clone and starts its runner. A runner that doesn't start leaves it to its agent. */
  private async boot(): Promise<Lent> {
    const udid = await this.simctl.cloneDevice(this.golden.udid, `fleetd-${shortId()}`);
    const lent = new Lent(udid, cloneHome(this.home, udid), this.simctl);
    this.booting.add(lent);
    try {
      try {
        await this.simctl.boot(udid, BOOT_TIMEOUT);
      } catch (e) {
        void lent.discard();
        throw e;
      }
      try {
        await this.runner(this.home, lent);
        lent.runner = true;
      } catch (e) {
        console.warn(`iOS clone ${udid}: runner did not start ahead; its agent's first command starts it: ${(e as Error).message}`);
      }
      // Drained while its runner started: the daemon that came up after the clone was thrown away goes too.
      if (this.closed) await stopDaemon(join(lent.home, "state"));
      return lent;
    } finally {
      this.booting.delete(lent);
    }
  }

  /**
   * A simulator of the device type `wanted` for one agent (`mac sim start --device`), on the newest runtime that has
   * it, and its device and runtime's names: made and booted from nothing, since a clone keeps the golden's type.
   */
  async make(wanted: string): Promise<[Lent, string]> {
    const [runtime, type] = pick(await this.simctl.runtimes(), wanted);
    const udid = await this.simctl.create(`fleetd-${shortId()}`, type.identifier, runtime.identifier);
    const lent = new Lent(udid, cloneHome(this.home, udid), this.simctl);
    try {
      await this.simctl.boot(udid, OWN_BOOT);
    } catch (e) {
      void lent.discard();
      throw e;
    }
    return [lent, `${type.name} on ${runtime.name}`];
  }

  /**
   * A booted clone; the pool refills behind it. With none warm, a boot starts (unless one is under way or the pool is
   * backing off), and the answer says about how long it takes: a boot can outlast the agent's wait for its call.
   */
  take(): { lent: Lent } | { waiting: Waiting } {
    const warm = this.warmClones.shift();
    this.refill();
    return warm ? { lent: warm } : { waiting: this.refills.wait(Date.now()) };
  }

  /** Clones and boots in the background until the pool holds its size. */
  refill(): void {
    if (this.filling) return;
    this.filling = true;
    void (async () => {
      try {
        while (this.warmClones.length < this.size && !this.closed) {
          if (!this.refills.mayBoot(Date.now())) return;
          this.refills.started(Date.now());
          let lent: Lent;
          try {
            lent = await this.boot();
          } catch (e) {
            const wait = this.refills.failed(Date.now(), (e as Error).message);
            console.warn(`iOS simulator pool not refilled (again in ${Math.round(wait / 1000)} s): ${(e as Error).message}`);
            return;
          }
          this.refills.succeeded(Date.now());
          if (this.closed) {
            void lent.discard();
            return;
          }
          this.warmClones.push(lent);
        }
      } catch {
        this.refills.released();
      } finally {
        this.filling = false;
      }
    })();
  }

  warm(): number {
    return this.warmClones.length;
  }

  /** About how long until the `nth` clone from now (1 is the next) is ready, in seconds: a warm one at once, the rest
   * one boot after another behind the one under way. */
  readyIn(nth: number): number {
    const warm = this.warm();
    if (nth <= warm) return 0;
    const behind = nth - warm - 1;
    return this.refills.wait(Date.now()).secs + behind * Math.max(Math.floor(this.refills.lastBoot / 1000), 1);
  }

  /** The last boot's error, while the pool's boots keep failing. */
  failing(): string | undefined {
    return this.refills.lastError;
  }

  /** Deletes every waiting clone, and those still booting: each one's agent-device daemon (with the XCTest runner it
   * starts) is stopped first, so none outlives the node. */
  drain(): Promise<void> {
    this.closed = true;
    const all = [...this.warmClones.splice(0), ...this.booting];
    this.booting.clear();
    return Promise.all(all.map((l) => l.discard())).then(() => {});
  }
}

