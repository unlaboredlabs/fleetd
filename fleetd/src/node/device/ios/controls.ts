// A simulator's device controls on the agents' Mac (W804): what a person's
// control strip and an agent's `mac sim <control>` do to an iOS simulator. Each one was tried on the real Mac (Xcode
// 27.2, Nov 2026) on simulators in fleetd's own device set, where Device Hub and `devicectl` see none:
//
// - rotate: agent-device's `orientation`, which turns the device through its XCTest runner (XCUIDevice); the app on
//   screen turns, and simctl's screenshots with it (an iPhone 17's 1206x2622 becomes 2622x1206). An iPhone Duo's UI
//   doesn't follow XCUIDevice: it turns with the orientation picker Xcode's CoreDevice sends it, a vendor HID event as
//   its hinge's is (`orientation-picker-control`, an enum of portrait, pud, landscape-left and landscape-right), sent
//   from inside the simulator by the DEVICE helper below.
// - shake: the Darwin notification Simulator's own Shake posts (`notifyutil -p com.apple.UIKit.SimulatorShake`).
// - home and lock: the Home and Power buttons as HID key presses inside the simulator (DEVICE below, `simctl spawn`):
//   agent-device's `home` takes seconds and it has no lock on a simulator.
// - light/dark: `simctl ui appearance`; location: `simctl location set`; screenshot: `simctl io screenshot`.
// - fold (the iPhone Duo): the hinge as agent-device's own fold helper sets it (its Fold.m, `simctl spawn`). agent-device's
//   `fold` refuses a simulator outside the default set, since it reads the hinge back through CoreDevice; here the
//   pose is fleetd's to keep: closed lights the outer panel (`primary`), half-open and open the inner (`primary-1`).
//
// The helpers are built once per source and Xcode under the node's `device/ios/helpers/`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScreenAppearance, ScreenControl, ScreenOrientation } from "../../../shared/contracts.ts";
import { ToolError } from "../../../shared/errors.ts";
import type { ScreenDevice } from "../../../shared/screens_wire.ts";
import { packageDir } from "../agent_device.ts";
import { heldBy, inSession, NO_SESSION, type Ran } from "./screen.ts";
import type { Simctl } from "./simctl.ts";
import { iosDir } from "./wrapper.ts";

/** What every iPhone and iPad simulator takes. */
export const IOS_CONTROLS: readonly ScreenControl[] = ["rotate_left", "rotate_right", "shake", "home", "lock", "appearance", "screenshot", "location"];
/** A foldable's poses, as a picker shows them. */
export const FOLDS = ["closed", "half-open", "open"] as const;
export type Fold = (typeof FOLDS)[number];
/** The orientations a left turn steps through, from upright. */
const TURNS: readonly ScreenOrientation[] = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"];
/** The Duo's orientation picker's word for each. */
const PICKER: Record<string, string> = {
  portrait: "portrait",
  landscape_left: "landscape-left",
  portrait_upside_down: "pud",
  landscape_right: "landscape-right",
};
/** agent-device's word for each. */
const AGENT_DEVICE: Record<string, string> = {
  portrait: "portrait",
  landscape_left: "landscape-left",
  portrait_upside_down: "portrait-upside-down",
  landscape_right: "landscape-right",
};
/** What agent-device says while its XCTest runner still finishes an earlier command; tried again BUSY_TRIES times. */
const RUNNER_BUSY = "still finishing a previous command";
const BUSY_TRIES = 4;
/** How long a helper or a simctl control may take. */
const CONTROL_WAIT = 15_000;
/** A screenshot's bound. */
const SHOT_WAIT = 15_000;

/** Whether a device ("iPhone Duo on iOS 27.2") folds. */
export const foldable = (device: string) => /\bDuo\b/.test(device.split(" on ")[0] ?? "");

/** The controls a simulator of `device` takes. */
export const controlsOf = (device: string): ScreenControl[] => (foldable(device) ? [...IOS_CONTROLS, "fold"] : [...IOS_CONTROLS]);

/** The orientation a quarter turn to the left or right of `from` gives. */
export function turned(from: ScreenOrientation, way: "left" | "right"): ScreenOrientation {
  const at = Math.max(TURNS.indexOf(from), 0);
  return TURNS[(at + (way === "left" ? 1 : TURNS.length - 1)) % TURNS.length]!;
}

/** The panel a foldable lights in `fold` (simctl's `--display`); undefined for a device with one. */
export const panelOf = (device: string, fold: Fold) => (!foldable(device) ? undefined : fold === "closed" ? "primary" : "primary-1");

/** "lat,lon" as two numbers in range, or why not. */
export function latLon(value: string | undefined): [number, number] {
  const parts = (value ?? "").split(",").map((p) => p.trim());
  const [lat, lon] = parts.map(Number);
  if (parts.length !== 2 || parts.some((p) => p === "") || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat!) > 90 || Math.abs(lon!) > 180) {
    throw new ToolError("invalid", `A location is "lat,lon" in degrees (48.8584,2.2945), not ${JSON.stringify(value ?? "")}.`);
  }
  return [lat!, lon!];
}

/** What one control does: simctl commands (on the node's set), helper runs inside the simulator, an agent-device command. */
export type Step =
  | { simctl: string[] }
  | { helper: "fold" | "device"; args: string[] }
  | { agentDevice: string[] };

/** The device as fleetd last set it. */
export type DeviceState = { orientation: ScreenOrientation; fold?: Fold; appearance: ScreenAppearance };

/**
 * The steps `control` (with its `value`) takes on simulator `udid` of `device` in `state`, and the state after them.
 * A control the device doesn't take, or a value it can't use, is refused before anything runs.
 */
export function plan(device: string, udid: string, state: DeviceState, control: ScreenControl, value?: string): { steps: Step[]; next: DeviceState } {
  if (!controlsOf(device).includes(control)) {
    throw new ToolError("invalid", `A ${device.split(" on ")[0]} simulator has no ${control} control.`, `Its controls: ${controlsOf(device).join(", ")}.`);
  }
  switch (control) {
    case "rotate_left":
    case "rotate_right": {
      const orientation = turned(state.orientation, control === "rotate_left" ? "left" : "right");
      const step: Step = foldable(device) ? { helper: "device", args: ["turn", PICKER[orientation]!] } : { agentDevice: ["orientation", AGENT_DEVICE[orientation]!] };
      return { steps: [step], next: { ...state, orientation } };
    }
    case "shake":
      return { steps: [{ simctl: ["spawn", udid, "notifyutil", "-p", "com.apple.UIKit.SimulatorShake"] }], next: state };
    case "home":
    case "lock":
      return { steps: [{ helper: "device", args: [control] }], next: state };
    case "appearance": {
      const to = value ?? (state.appearance === "dark" ? "light" : "dark");
      if (to !== "light" && to !== "dark") throw new ToolError("invalid", `Appearance is light or dark, not ${JSON.stringify(value)}.`);
      return { steps: [{ simctl: ["ui", udid, "appearance", to] }], next: { ...state, appearance: to } };
    }
    case "location": {
      const [lat, lon] = latLon(value);
      return { steps: [{ simctl: ["location", udid, "set", `${lat},${lon}`] }], next: state };
    }
    case "fold": {
      const fold = FOLDS.find((f) => f === value);
      if (!fold) throw new ToolError("invalid", `A fold is one of ${FOLDS.join(", ")}, not ${JSON.stringify(value ?? "")}.`);
      // The pose a turn left on one panel isn't the other's: the panel now lit is turned as the session says.
      return { steps: [{ helper: "fold", args: [fold] }, { helper: "device", args: ["turn", PICKER[state.orientation] ?? "portrait"] }], next: { ...state, fold } };
    }
    case "screenshot":
      return { steps: [], next: state };
    default:
      throw new ToolError("invalid", `${control} is no control fleetd knows.`);
  }
}

/**
 * HID events from inside the simulator: `home` and `lock` press the Home and Power buttons (consumer page: Menu 0x40,
 * Power 0x30); `turn <orientation>` is a foldable's orientation picker, the vendor event its hinge's is (0xff61/0x5b).
 */
export const DEVICE = `#import <Foundation/Foundation.h>
#import <mach/mach_time.h>
#include <unistd.h>

extern CFDataRef IOCFSerialize(CFTypeRef object, CFOptionFlags options);
extern CFTypeRef IOHIDEventCreateKeyboardEvent(CFAllocatorRef allocator, uint64_t timestamp, uint32_t usagePage,
    uint32_t usage, Boolean down, uint32_t flags);
extern CFTypeRef IOHIDEventCreateVendorDefinedEvent(CFAllocatorRef allocator, uint64_t timestamp, uint32_t usagePage,
    uint32_t usage, uint32_t version, const uint8_t *data, CFIndex length, uint32_t options);
extern CFTypeRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
extern void IOHIDEventSystemClientDispatchEvent(CFTypeRef client, CFTypeRef event);

static int dispatch(CFTypeRef client, CFTypeRef event) {
  if (!event) return 1;
  IOHIDEventSystemClientDispatchEvent(client, event);
  CFRelease(event);
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    CFTypeRef client = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
    if (!client) return 1;
    if (argc == 3 && strcmp(argv[1], "turn") == 0) {
      NSDictionary *payload = @{@"provider": @"com.apple.Virtualization.VirtualMachines", @"source": @"orientation-picker-control",
        @"type": @"enum", @"value": @(argv[2])};
      CFDataRef data = IOCFSerialize((__bridge CFTypeRef)payload, 1);
      if (!data) return 1;
      int failed = dispatch(client, IOHIDEventCreateVendorDefinedEvent(kCFAllocatorDefault, mach_absolute_time(), 0xff61, 0x5b, 0,
        CFDataGetBytePtr(data), CFDataGetLength(data), 0));
      CFRelease(data);
      return failed;
    }
    uint32_t usage = argc == 2 && strcmp(argv[1], "home") == 0 ? 0x40 : argc == 2 && strcmp(argv[1], "lock") == 0 ? 0x30 : 0;
    if (!usage) { fprintf(stderr, "home, lock or turn <orientation>\\n"); return 2; }
    for (int down = 1; down >= 0; down--) {
      if (dispatch(client, IOHIDEventCreateKeyboardEvent(kCFAllocatorDefault, mach_absolute_time(), 0x0c, usage, down, 0))) return 1;
      if (down) usleep(100000);
    }
    return 0;
  }
}
`;

/** clang for the simulator, as agent-device builds its own fold helper. */
export const helperArgv = (source: string, out: string) => [
  "xcrun",
  "--sdk",
  "iphonesimulator",
  "clang",
  "-mios-simulator-version-min=15.0",
  "-fobjc-arc",
  "-framework",
  "Foundation",
  "-framework",
  "IOKit",
  source,
  "-o",
  out,
];

/** The node's helpers, built at their first use into a folder named for their sources and Xcode. */
export class Helpers {
  private built: Promise<Record<"fold" | "device", string>> | undefined;

  constructor(
    private readonly home: string,
    private readonly xcode: () => string = xcodeVersion,
  ) {}

  /** The helpers' paths, built once (again after a build that failed). */
  paths(): Promise<Record<"fold" | "device", string>> {
    this.built ??= this.build().catch((e) => {
      this.built = undefined;
      throw e;
    });
    return this.built;
  }

  private async build(): Promise<Record<"fold" | "device", string>> {
    const foldSource = join(packageDir(this.home), "apple", "fold-helper", "Fold.m");
    let fold: string;
    try {
      fold = readFileSync(foldSource, "utf8");
    } catch {
      throw new ToolError("failed", "agent-device's fold helper isn't on the Mac.", "an admin updates fleetd on the agents' Mac");
    }
    const key = createHash("sha256").update(fold).update(DEVICE).update(this.xcode()).digest("hex").slice(0, 16);
    const dir = join(iosDir(this.home), "helpers", key);
    const out = { fold: join(dir, "fold-helper"), device: join(dir, "device") };
    if (existsSync(out.fold) && existsSync(out.device)) return out;
    const scratch = `${dir}.${process.pid}.tmp`;
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "Fold.m"), fold);
    writeFileSync(join(scratch, "Device.m"), DEVICE);
    for (const [name, source] of [["fold-helper", "Fold.m"], ["device", "Device.m"]] as const) {
      const ran = await run(helperArgv(join(scratch, source), join(scratch, name)), 120_000);
      if (!ran.ok) {
        rmSync(scratch, { recursive: true, force: true });
        throw new ToolError("failed", `The simulator's ${name} helper didn't build: ${clip(ran.said)}`);
      }
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(scratch, dir);
    return out;
  }
}

/** `xcodebuild -version`'s first line, which a new Xcode changes. */
function xcodeVersion(): string {
  try {
    return Bun.spawnSync(["xcodebuild", "-version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }).stdout.toString().split("\n")[0] ?? "";
  } catch {
    return "";
  }
}

const clip = (text: string) => {
  const t = text.trim();
  return [...t].length <= 300 ? t : `${[...t].slice(0, 299).join("")}…`;
};

async function run(argv: string[], within: number): Promise<Ran> {
  const started = performance.now();
  let child;
  try {
    child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { ok: false, said: (e as Error).message, ms: 0 };
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), within);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { ok: code === 0 && child.signalCode === null, said: `${stderr}${stdout}`, ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

/** A PNG's width and height, from its header. */
export function pngSize(png: Uint8Array): [number, number] | undefined {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) return undefined;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

/** What a control gave back: a screenshot's PNG and its size. */
export type Shot = { png: Uint8Array; width: number; height: number };

/** The tools a simulator's controls use: simctl's, the helpers, agent-device on the simulator. A test's stand-ins. */
export type ControlTools = {
  simctl: (args: string[], within: number) => Promise<string>;
  helpers: () => Promise<Record<"fold" | "device", string>>;
  agentDevice: (args: string[]) => Promise<Ran>;
  /** Where a screenshot is written before it is read. */
  shots: string;
};

/** The tools on the Mac's own simulators. */
export const simctlControls = (simctl: Simctl, helpers: Helpers, agentDevice: (args: string[]) => Promise<Ran>, shots: string): ControlTools => ({
  simctl: (args, within) => simctl.run(args, within),
  helpers: () => helpers.paths(),
  agentDevice,
  shots,
});

/** One simulator's controls, and its device as fleetd last set it. */
export class SimDevice {
  state: DeviceState;
  /** One control at a time: a fold mid-way never races a rotate. */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(
    readonly udid: string,
    /** "iPhone Duo on iOS 27.2". */
    readonly device: string,
    private readonly tools: ControlTools,
    /** How long a busy runner is given before the next try. */
    private readonly busyWait = 3_000,
  ) {
    this.state = { orientation: "portrait", appearance: "light", ...(foldable(device) ? { fold: "closed" as Fold } : {}) };
  }

  /** The session's device fields. */
  report(): ScreenDevice {
    return {
      controls: controlsOf(this.device),
      orientation: this.state.orientation,
      appearance: this.state.appearance,
      ...(this.state.fold ? { fold: this.state.fold, folds: [...FOLDS] } : {}),
    };
  }

  /** The panel lit now, for a screenshot (`--display`); undefined on a device with one. */
  display(): string | undefined {
    return this.state.fold ? panelOf(this.device, this.state.fold) : undefined;
  }

  /** Reads the simulator's appearance, and puts a foldable in the pose fleetd keeps for it (closed). */
  async settle(): Promise<void> {
    try {
      const said = (await this.tools.simctl(["ui", this.udid, "appearance"], CONTROL_WAIT)).trim();
      if (said === "dark" || said === "light") this.state = { ...this.state, appearance: said };
    } catch {
      // Light, as a fresh simulator is.
    }
    if (this.state.fold) await this.apply("fold", this.state.fold).catch(() => {});
  }

  /** Runs `control`, one at a time; a screenshot comes back as its PNG. */
  apply(control: ScreenControl, value?: string): Promise<Shot | undefined> {
    const next = this.turn.then(() => this.now(control, value));
    this.turn = next.catch(() => {});
    return next;
  }

  private async now(control: ScreenControl, value?: string): Promise<Shot | undefined> {
    const { steps, next } = plan(this.device, this.udid, this.state, control, value);
    for (const step of steps) {
      if ("simctl" in step) {
        await this.tools.simctl(step.simctl, CONTROL_WAIT).catch((e: Error) => {
          throw new ToolError("failed", `The simulator's ${control} didn't go: ${clip(e.message)}`);
        });
      } else if ("helper" in step) {
        const helpers = await this.tools.helpers();
        await this.tools.simctl(["spawn", this.udid, helpers[step.helper], ...step.args], CONTROL_WAIT).catch((e: Error) => {
          throw new ToolError("failed", `The simulator's ${control} didn't go: ${clip(e.message)}`);
        });
      } else {
        const ran = await this.inASession(step.agentDevice);
        if (!ran.ok) throw new ToolError("failed", `The simulator's ${control} didn't go: ${clip(ran.said)}`);
      }
    }
    this.state = next;
    return control === "screenshot" ? this.shoot() : undefined;
  }

  /**
   * An agent-device command, which runs only in a session, kept per working folder (screen.ts): run here, then, with
   * none, in the agent's session by name when it holds the simulator, else in one opened for it alone and closed
   * right after, so the agent's own `open` is never refused.
   */
  private async inASession(args: string[]): Promise<Ran> {
    const ran = await this.whenFree(args);
    if (ran.ok || !ran.said.includes(NO_SESSION)) return ran;
    const open = await this.tools.agentDevice(["open"]);
    if (!open.ok) {
      const session = heldBy(open.said);
      return session ? this.tools.agentDevice(inSession(args, session)) : open;
    }
    try {
      return await this.tools.agentDevice(args);
    } finally {
      await this.tools.agentDevice(["close"]);
    }
  }

  /** An agent-device command, run again while its runner is still finishing an earlier command (a capture of a busy
   * screen, its watchdog's seconds). */
  private async whenFree(args: string[]): Promise<Ran> {
    for (let tries = 1; ; tries++) {
      const ran = await this.tools.agentDevice(args);
      if (ran.ok || !ran.said.includes(RUNNER_BUSY) || tries === BUSY_TRIES) return ran;
      await Bun.sleep(this.busyWait);
    }
  }

  /** The lit panel's screenshot, as PNG. */
  async shoot(): Promise<Shot> {
    mkdirSync(this.tools.shots, { recursive: true });
    const to = join(this.tools.shots, `${this.udid}-control.png`);
    const display = this.display();
    try {
      await this.tools.simctl(["io", this.udid, "screenshot", ...(display ? [`--display=${display}`] : []), to], SHOT_WAIT);
      const png = new Uint8Array(readFileSync(to));
      const size = pngSize(png);
      if (!size) throw new Error("simctl wrote no PNG");
      return { png, width: size[0], height: size[1] };
    } catch (e) {
      throw e instanceof ToolError ? e : new ToolError("failed", `The simulator's screenshot didn't go: ${clip((e as Error).message)}`);
    } finally {
      rmSync(to, { force: true });
    }
  }
}
