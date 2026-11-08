// iOS simulators (crates/fleetd/src/node/device/ios/mod.rs `Simulators`): the agents' Mac lends agents a clone from its
// warm pool (`mac sim`, node/mac_tool, through `lend`). iOS screens are gone (D298): the kind router refuses an ios
// `session_start`, so the Rust node's legacy session side (session.rs, screen.rs) isn't ported. The pool lends a booted
// clone of the node's settled golden simulator (pool.ts), and the clone is deleted when it is given back. The
// simulators live in a device set of the node's own (simctl.ts), apart from a person's in Xcode.
//
// TODO(bun): health's Xcode facts beyond simctl (agents_mac/xcode.rs: an Xcode in /Applications that isn't selected).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IosHealth } from "../../../shared/contracts.ts";
import { ToolError } from "../../../shared/errors.ts";
import { writeAtomic } from "../../secrets/files.ts";
import { VERSION } from "../agent_device.ts";
import { clear, clearHomes, findGolden, type Golden, type Lent, Pool, prepare, type RunnerStarter, startRunner, waitingWords } from "./pool.ts";
import { iosRuntimes, pick, Simctl } from "./simctl.ts";
import { iosDir, setDir } from "./wrapper.ts";

/** node.json's `ios`: `enabled` true opts this Mac in (the node makes its golden), false turns it off; `deviceType`. */
export type IosConfig = { enabled?: boolean; deviceType?: string };

export const supported = () => process.platform === "darwin";
const optedIn = (c: IosConfig) => c.enabled === true;

/** What making the golden left for the doctor between heartbeats: `<ios dir>/state.json`. */
type PrepState = { preparing: boolean; failed?: string };
const statePath = (home: string) => join(iosDir(home), "state.json");

export function readState(home: string): PrepState {
  try {
    const s = JSON.parse(readFileSync(statePath(home), "utf8")) as Partial<PrepState>;
    return { preparing: s.preparing === true, ...(typeof s.failed === "string" ? { failed: s.failed } : {}) };
  } catch {
    return { preparing: false };
  }
}

function writeState(home: string, state: PrepState): void {
  try {
    mkdirSync(dirname(statePath(home)), { recursive: true });
    writeAtomic(statePath(home), JSON.stringify({ preparing: state.preparing, failed: state.failed ?? null }));
  } catch {
    // The doctor reads the next one.
  }
}

/** Installs the newest Xcode from a terminal on the Mac (xcodes asks for the Apple ID it downloads with). */
export const XCODE_FIX = "brew install xcodesorg/made/xcodes && xcodes install --latest --select";
export const XCODE_PAGE = "https://apps.apple.com/app/xcode/id497799835";
export const noXcode = () =>
  `no Xcode: install it with the command (on this Mac, over SSH too; it asks for your Apple ID), or at the Mac from ${XCODE_PAGE}`;

/** What Xcode offers: the newest iOS runtime's name, or why there is none and what fixes it. */
export type Xcode = { ok: string } | { err: string; fix?: string };

/** `xcode` from simctl's runtimes (undefined: simctl didn't run). */
export function xcodeFrom(runtimes: string | undefined): Xcode {
  if (runtimes === undefined) return { err: noXcode(), fix: XCODE_FIX };
  try {
    return { ok: pick(iosRuntimes(runtimes))[0].name };
  } catch (e) {
    if ((e as Error).message.includes("don't read")) return { err: (e as Error).message };
    return { err: "Xcode has no iOS simulator runtime", fix: "xcodebuild -downloadPlatform iOS" };
  }
}

/** The doctor's facts about Xcode, from `xcrun simctl list runtimes -j`, read at most every five minutes. */
let lastXcode: { at: number; xcode: Xcode } | undefined;
function xcode(): Xcode {
  if (lastXcode && Date.now() - lastXcode.at < 300_000) return lastXcode.xcode;
  let out: string | undefined;
  try {
    const ran = Bun.spawnSync(["xcrun", "simctl", "list", "runtimes", "-j"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    out = ran.success ? ran.stdout.toString() : undefined;
  } catch {
    out = undefined;
  }
  lastXcode = { at: Date.now(), xcode: xcodeFrom(out) };
  return lastXcode.xcode;
}

const nodeRuns = () => {
  try {
    return Bun.spawnSync(["node", "--version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).success;
  } catch {
    return false;
  }
};

/**
 * Whether simulators can run here, for the doctor: undefined off macOS, where they are off, and on a Mac without Xcode
 * that didn't opt in. With whether the hub may place on this Mac (`placeable`).
 */
export function healthFrom(
  config: IosConfig,
  golden: Golden | undefined,
  state: PrepState,
  xcodeNow: () => Xcode = xcode,
  node: () => boolean = nodeRuns,
): { health: IosHealth; placeable: boolean } | undefined {
  const of = (s: IosHealth["state"], message: string, fix: string | undefined, placeable: boolean) => ({
    health: { state: s, message: [...message].slice(0, 500).join(""), ...(fix ? { fix: [...fix].slice(0, 500).join("") } : {}) },
    placeable,
  });
  if (golden) return of("ready", `iOS simulators are ready: ${golden.runtimeName} on ${golden.deviceTypeName}, agent-device ${VERSION}.`, undefined, true);
  if (state.preparing) {
    return of("preparing", "Making the golden iOS simulator: one boot left to settle, then agent-device's runner built with xcodebuild.", undefined, optedIn(config));
  }
  const x = xcodeNow();
  if ("err" in x) return optedIn(config) ? of("unavailable", `No iOS simulators: ${x.err}.`, x.fix, false) : undefined;
  if (!optedIn(config)) {
    return of("wanted", `Xcode with ${x.ok}; iOS simulators are the agents' Mac's: Settings › Hub › Setup › A Mac for agents joins one.`, undefined, false);
  }
  if (!node()) return of("unavailable", "No iOS simulators: agent-device needs Node.js 22.12 or later on the node's PATH.", "brew install node", false);
  if (state.failed) {
    return of("unavailable", `Making the golden iOS simulator failed: ${state.failed}. The next ios session_start tries again.`, undefined, true);
  }
  return of("preparing", `Xcode with ${x.ok}; the node makes its golden iOS simulator next.`, undefined, true);
}

export function health(home: string, config: IosConfig): IosHealth | undefined {
  if (config.enabled === false || !supported()) return undefined;
  return healthFrom(config, findGolden(home, config.deviceType), readState(home))?.health;
}

/** A start's error, said for the agents' Mac's `mac sim start`. */
function simWords(e: ToolError): ToolError {
  if (e.message.includes("isn't set up")) {
    return new ToolError(
      "failed",
      "The agents' Mac has iOS simulators turned off (\"ios\": {\"enabled\": false} in its node.json).",
      "do without a simulator and say so in your result; an admin turns them on (fleetd docs: The agents' Mac)",
    );
  }
  return new ToolError(e.code, e.message.replaceAll("iOS sessions", "iOS simulators"), e.fix?.replaceAll("session_start", "mac sim start"));
}

type Prep = { at: "ready"; pool: Pool } | { at: "wanted" } | { at: "preparing" } | { at: "starting" } | { at: "missing"; why: string };

export type SimulatorsOptions = {
  simctl?: Simctl;
  runner?: RunnerStarter;
  /** How the golden is made: pool.ts's prepare, or a test's. */
  prepare?: (home: string, deviceType?: string) => Promise<Golden>;
};

/** The Mac's iOS simulators: its golden, and the warm pool agents' `mac sim start` lends from. */
export class Simulators {
  private prep: Prep = { at: "wanted" };
  readonly simctl: Simctl;
  /** Told when simulators start answering here. */
  onReady: (() => void) | undefined;

  constructor(
    readonly home: string,
    private readonly config: IosConfig,
    private readonly options: SimulatorsOptions = {},
  ) {
    this.simctl = options.simctl ?? new Simctl(setDir(home));
  }

  /**
   * Ready once the golden is made and the clones a stopped node left are deleted; on a Mac opted in without a golden,
   * the node starts making it.
   */
  async start(): Promise<void> {
    // The node stopped while making it; it starts again below.
    if (readState(this.home).preparing) writeState(this.home, { preparing: false });
    const golden = findGolden(this.home, this.config.deviceType);
    if (golden) {
      this.prep = { at: "starting" };
      const cleared = (await clearHomes(this.home)) + (await clear(this.simctl, golden.udid));
      if (cleared > 0) console.info(`${cleared} iOS simulators a stopped node left were deleted`);
      this.ready(golden);
    } else if (optedIn(this.config)) {
      this.beginPrepare();
    }
  }

  /** Starts making the golden, once. */
  private beginPrepare(): void {
    if (this.prep.at !== "wanted" && this.prep.at !== "missing") return;
    this.prep = { at: "preparing" };
    writeState(this.home, { preparing: true });
    const make = this.options.prepare ?? ((home: string, type?: string) => prepare(home, type, this.simctl));
    void make(this.home, this.config.deviceType).then(
      (golden) => {
        writeState(this.home, { preparing: false });
        this.ready(golden);
      },
      (e: Error) => {
        console.warn(`golden iOS simulator not made: ${e.message}`);
        writeState(this.home, { preparing: false, failed: e.message });
        this.prep = { at: "missing", why: e.message };
      },
    );
  }

  /** Makes the pool and starts filling it. */
  private ready(golden: Golden): void {
    const pool = new Pool(this.simctl, this.home, golden, 1, this.options.runner ?? startRunner);
    pool.refill();
    this.prep = { at: "ready", pool };
    this.onReady?.();
  }

  usable(): boolean {
    return this.prep.at === "ready";
  }

  private pool(): Pool {
    if (this.prep.at === "starting") throw new ToolError("failed", "This Mac's iOS sessions are starting up.", "try session_start again in a moment");
    if (this.prep.at !== "ready" && !optedIn(this.config)) {
      throw new ToolError(
        "failed",
        "This Mac isn't set up for iOS sessions.",
        'say so in your result: a person opts a Mac in with "ios": {"enabled": true} in its node.json (fleetd docs: iOS sessions)',
      );
    }
    // A golden that failed is tried again by the next start that asks.
    if (this.prep.at === "missing") this.prep = { at: "wanted" };
    this.beginPrepare();
    const prep = this.prep as Prep;
    if (prep.at === "ready") return prep.pool;
    if (prep.at === "missing") {
      throw new ToolError("failed", `This Mac has no golden iOS simulator: ${prep.why}.`, "say so in your result: a person must look at this machine's node log");
    }
    throw new ToolError(
      "failed",
      "This Mac is still making its golden iOS simulator (a boot to settle, then agent-device's runner built with xcodebuild).",
      "try session_start again in a few minutes, or carry on without it",
    );
  }

  /** A booted clone from the warm pool for `mac sim start`, and its device and runtime's names. */
  lend(): [Lent, string] {
    let pool: Pool;
    try {
      pool = this.pool();
    } catch (e) {
      throw e instanceof ToolError ? simWords(e) : e;
    }
    const taken = pool.take();
    if ("waiting" in taken) {
      const [message, fix] = waitingWords(taken.waiting);
      throw simWords(new ToolError("failed", message, fix));
    }
    return [taken.lent, `${pool.golden.deviceTypeName} on ${pool.golden.runtimeName}`];
  }

  /** `lend` of the device type `wanted`: the golden's type is a warm clone, any other made for this agent alone. */
  async lendType(wanted: string): Promise<[Lent, string]> {
    let pool: Pool;
    try {
      pool = this.pool();
    } catch (e) {
      throw e instanceof ToolError ? simWords(e) : e;
    }
    if (wanted === pool.golden.deviceTypeName || wanted === pool.golden.deviceType) return this.lend();
    try {
      return await pool.make(wanted);
    } catch (e) {
      throw new ToolError(
        "failed",
        `No ${wanted} simulator was made: ${(e as Error).message}.`,
        "check the name against xcrun simctl list devicetypes (mac run), or use mac sim start without --device for the Mac's iPhone",
      );
    }
  }

  warm(): number {
    return this.prep.at === "ready" ? this.prep.pool.warm() : 0;
  }

  /** Every waiting clone goes (the node stops). */
  async shutdown(): Promise<void> {
    if (this.prep.at === "ready") await this.prep.pool.drain();
  }
}

/** The developer check, when it fails (`<home>/mac-health.json`): iOS simulators would hang on its password prompt. */
export function blocksSimulators(home: string): { message: string; command?: string } | undefined {
  const file = join(home, "mac-health.json");
  if (!existsSync(file)) return undefined;
  try {
    const health = JSON.parse(readFileSync(file, "utf8")) as { checks?: { id?: string; state?: string; message?: string; command?: string }[] };
    const check = health.checks?.find((c) => c.id === "developer" && c.state === "fail");
    return check ? { message: String(check.message ?? ""), ...(check.command ? { command: check.command } : {}) } : undefined;
  } catch {
    return undefined;
  }
}
