// Xcode's `simctl`, on the node's own device set: `xcrun simctl --set
// <node home>/device/ios/set`. The simulators agents use live there, apart from a person's own in Xcode, so the node may
// delete whatever it finds in it. The runtimes and device types are Xcode's, shared by every set.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** A simctl call that hangs (a wedged CoreSimulator) is given up after this; a boot waits longer. */
export const CALL = 60_000;
/**
 * How long a call waits while CoreSimulator may still be starting. The first simctl call since the Mac started has
 * launchd start CoreSimulator's service, which readies every installed runtime before it answers: seconds on a Mac in
 * use, past CALL on a cold one (GitHub's 3-vCPU Mac VM, Nov 2026: `list` given up at 60 s, answered 3 s later). So
 * until simctl has answered once, a call gets this rather than its own bound.
 */
export const COLD_START = 300_000;

export type DeviceType = { identifier: string; name: string; productFamily?: string; bundlePath?: string };
/** An iOS runtime Xcode has installed, with the device types it runs. */
export type Runtime = {
  identifier: string;
  name: string;
  version: string;
  isAvailable: boolean;
  platform?: string;
  supportedDeviceTypes: DeviceType[];
};
/** A simulator in the set. */
export type Device = { udid: string; name: string; state: string };

/** `simctl list runtimes -j`'s iOS runtimes that are available, oldest first as simctl lists them. */
export function iosRuntimes(json: string): Runtime[] {
  let list: { runtimes?: Partial<Runtime>[] };
  try {
    list = JSON.parse(json) as { runtimes?: Partial<Runtime>[] };
  } catch (e) {
    throw new Error(`simctl's runtimes don't read: ${(e as Error).message}`);
  }
  if (!Array.isArray(list.runtimes)) throw new Error("simctl's runtimes don't read: no runtimes");
  return list.runtimes
    .map((r) => ({
      identifier: String(r.identifier ?? ""),
      name: String(r.name ?? ""),
      version: String(r.version ?? ""),
      isAvailable: r.isAvailable === true,
      ...(typeof r.platform === "string" ? { platform: r.platform } : {}),
      supportedDeviceTypes: Array.isArray(r.supportedDeviceTypes) ? r.supportedDeviceTypes : [],
    }))
    .filter((r) => r.isAvailable && (r.platform === undefined ? r.identifier.includes(".iOS-") : r.platform === "iOS"));
}

/** `simctl list devices -j`'s simulators, of every runtime. */
export function devices(json: string): Device[] {
  let list: { devices?: Record<string, Device[]> };
  try {
    list = JSON.parse(json) as { devices?: Record<string, Device[]> };
  } catch (e) {
    throw new Error(`simctl's devices don't read: ${(e as Error).message}`);
  }
  if (!list.devices || typeof list.devices !== "object") throw new Error("simctl's devices don't read: no devices");
  // As serde's BTreeMap gives them: by runtime, in order.
  return Object.keys(list.devices)
    .sort()
    .flatMap((k) => list.devices![k] ?? []);
}

const versionKey = (version: string) => version.split(".").map((p) => Number.parseInt(p, 10) || 0);
function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/** A plain iPhone's model number: "iPhone 17" is 17. */
function plainIphone(name: string): number | undefined {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length !== 2 || words[0] !== "iPhone" || !/^\d+$/.test(words[1]!)) return undefined;
  return Number(words[1]);
}

/** Whether `name` is the device type `pick` chooses when none is named: a plain iPhone. */
export const isPlainIphone = (name: string) => plainIphone(name) !== undefined;

/**
 * The runtime and device type agents use, chosen on purpose across every available iOS runtime: the device type named
 * `wanted` on the newest runtime that has it, else the plain iPhone with the highest number ("iPhone 17", not a Pro,
 * Plus, Max, mini or e) on the newest runtime that runs one. Never whatever type a runtime lists last: Xcode can
 * install a runtime made for one device beside the general one of the same version (`iOS-27-2-iPhone19-4`, which runs
 * only the multi-display "iPhone Duo"), and that runtime has no plain iPhone, so it's never picked. Ties go to the last
 * listed, as Rust's `max_by`.
 */
export function pick(runtimes: Runtime[], wanted?: string): [Runtime, DeviceType] {
  if (runtimes.length === 0) throw new Error("Xcode has no iOS runtime installed");
  const pairs = runtimes.flatMap((r) => r.supportedDeviceTypes.map((t) => [r, t] as [Runtime, DeviceType]));
  let best: { version: number[]; model: number; pair: [Runtime, DeviceType] } | undefined;
  for (const pair of pairs) {
    const [r, t] = pair;
    const named = wanted !== undefined;
    if (named && t.name !== wanted && t.identifier !== wanted) continue;
    const model = named ? 0 : plainIphone(t.name);
    if (model === undefined) continue;
    const version = versionKey(r.version);
    const order = best ? compareKeys(version, best.version) || model - best.model : 1;
    if (order >= 0) best = { version, model, pair };
  }
  if (best) return best.pair;
  throw new Error(
    wanted !== undefined
      ? `no iOS runtime has the device type ${wanted} (xcrun simctl list devicetypes lists them)`
      : 'no iOS runtime runs a plain iPhone ("iPhone 17"): name a device type in node.json\'s "ios": {"deviceType": ...}',
  );
}

/** `simctl create` and `clone` print the new simulator's udid. */
export function udidOf(out: string): string | undefined {
  const udid = out.trim();
  return udid.length === 36 && /^[0-9A-Fa-f-]+$/.test(udid) ? udid : undefined;
}

/** Whether a line of `recordVideo`'s says it has started recording. */
export const recordingStarted = (line: string) => line.toLowerCase().includes("recording started");

/** The node's simctl, on its device set. `xcrun` is Xcode's, or a test's stand-in. */
export class Simctl {
  /** Whether simctl has answered here: CoreSimulator is up, and a call gets its own bound. */
  private answered = false;

  constructor(
    readonly set: string,
    readonly xcrun = "xcrun",
    private readonly coldStart = COLD_START,
  ) {}

  /** `xcrun simctl --set <set> <args>`'s argv. */
  argv(args: string[]): string[] {
    return [this.xcrun, "simctl", "--set", this.set, ...args];
  }

  /**
   * Runs a call to its end and returns what it printed; its error says what simctl said. Given up after `within`, or
   * after `coldStart` when that is longer and simctl hasn't answered yet.
   */
  async run(args: string[], within = CALL): Promise<string> {
    try {
      mkdirSync(this.set, { recursive: true });
    } catch (e) {
      throw new Error(`cannot make ${this.set}: ${(e as Error).message}`);
    }
    const what = args[0] ?? "simctl";
    let child;
    try {
      child = Bun.spawn(this.argv(args), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      throw new Error(`cannot run xcrun simctl: ${(e as Error).message}`);
    }
    const bound = this.answered ? within : Math.max(within, this.coldStart);
    const started = performance.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, bound);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (timedOut) throw new Error(`simctl ${what} did not finish in ${Math.round(bound / 1000)} s`);
      if (code !== 0) throw new Error(`simctl ${what} failed: ${[...stderr.trim()].slice(0, 300).join("")}`);
      if (!this.answered) {
        this.answered = true;
        console.info(`CoreSimulator answered its first simctl call (${what}): ${Math.round(performance.now() - started)} ms`);
      }
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }

  async runtimes(): Promise<Runtime[]> {
    return iosRuntimes(await this.run(["list", "runtimes", "-j"]));
  }

  async devices(): Promise<Device[]> {
    return devices(await this.run(["list", "devices", "-j"]));
  }

  async create(name: string, deviceType: string, runtime: string): Promise<string> {
    const out = await this.run(["create", name, deviceType, runtime]);
    const udid = udidOf(out);
    if (!udid) throw new Error(`simctl create printed no udid: ${out.trim()}`);
    return udid;
  }

  /** A copy of `source`, which must be shut down. */
  async cloneDevice(source: string, name: string): Promise<string> {
    const out = await this.run(["clone", source, name]);
    const udid = udidOf(out);
    if (!udid) throw new Error(`simctl clone printed no udid: ${out.trim()}`);
    return udid;
  }

  /** Boots a simulator and waits until it has finished booting. */
  async boot(udid: string, within: number): Promise<void> {
    await this.run(["boot", udid]);
    await this.run(["bootstatus", udid], within);
  }

  async shutdown(udid: string): Promise<void> {
    try {
      await this.run(["shutdown", udid]);
    } catch (e) {
      // Shut down already.
      if (!(e as Error).message.includes("current state: Shutdown")) throw e;
    }
  }

  async delete(udid: string): Promise<void> {
    await this.run(["delete", udid]);
  }
}

/**
 * The screen's scale (3 on today's iPhones) from a device type's profile, which converts a screenshot's pixels to the
 * points agent-device taps at. 3 when the profile doesn't say.
 */
export async function scale(deviceType: DeviceType): Promise<number> {
  if (!deviceType.bundlePath) return 3;
  try {
    const out = Bun.spawn(["plutil", "-extract", "mainScreenScale", "raw", "-o", "-", join(deviceType.bundlePath, "Contents/Resources/profile.plist")], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [text, code] = await Promise.all([new Response(out.stdout).text(), out.exited]);
    const s = Number.parseFloat(text.trim());
    return code === 0 && s >= 1 ? s : 3;
  } catch {
    return 3;
  }
}
