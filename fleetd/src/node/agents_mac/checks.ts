// The agents' Mac's setup checks (docs: agents-mac.md), run by the node
// as its own user, so each tests what a process of that user can do. Each is a pure verdict on what a `Probe` read;
// `Live` reads the Mac, tests fake it. A failing check says exactly what the person does, and where: in an admin's
// Terminal, or at the Mac in the account the node runs in (yours, an admin's, or a user of its own for agents: D309).
import { existsSync, statSync } from "node:fs";
import { VERSION } from "../../shared/version.ts";
import { versionLabel } from "../../update/version.ts";
import { clip, health, type MacCheck, type MacCheckId, type MacHealth, readHealth, user } from "./common.ts";
import { tcc } from "./tcc.ts";
import type { ToolsState } from "./tools.ts";
import { ACCEPT, APP_STORE, FIRST_LAUNCH, inApplications, type Located, locate, name as xcodeName, switchTo } from "./xcode.ts";

/** What a command said: its exit code (undefined when it didn't run or was killed), stdout and stderr together. */
export type Ran = { code?: number; out: string };
const ok = (ran: Ran) => ran.code === 0;

/** What the checks read of the Mac. */
export interface Probe {
  /** The macOS user the node runs as. */
  user(): string;
  /** A command, never through a shell. */
  run(program: string, args: string[]): Ran;
  /** The Xcode bundles in /Applications. */
  xcodes(): string[];
  isDir(path: string): boolean;
  /** `AXIsProcessTrusted()`; undefined where it can't be asked. */
  accessibility(): boolean | undefined;
  /** `CGPreflightScreenCaptureAccess()`; undefined where it can't be asked. */
  screenRecording(): boolean | undefined;
  /** Who owns the Mac's screen (/dev/console): a user, or `root` at the login window. */
  consoleUser(): string | undefined;
  /** The keep-awake assertion: held (undefined), or why not. */
  awake(): string | undefined;
  tools(): ToolsState;
  /** CocoaPods, from Homebrew (HOMEBREW_BINS). */
  pods(): Pods;
}

/** Where Homebrew puts its commands: Apple silicon's, then Intel's. Jobs get both on their PATH (mac_tool's jobs). */
export const HOMEBREW_BINS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;

/** Homebrew's own install line, from brew.sh: it asks for the account's password itself. */
export const HOMEBREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/** What the tools check reads of CocoaPods, which `pod install` and `expo prebuild --platform ios` need. */
export type Pods = {
  /** `pod --version`, from the first of Homebrew's bins that has `pod`; undefined where none has. */
  pod?: Ran;
  /** `brew`, where it is; undefined before Homebrew is installed. */
  brew?: string;
  /** Where `brew` lands once installed, on this Mac's chip. */
  brewAt: string;
};

/** Every check, in the order the guide shows them. */
export function run(probe: Probe): MacHealth {
  const who = probe.user();
  // xcodebuild runs only once an Xcode is selected: before that it says xcode-select's error, not what to do.
  const selected = probe.run("xcode-select", ["-p"]);
  const located = locate(ok(selected) ? selected.out : undefined, probe.xcodes(), (p) => probe.isDir(p));
  const xcode =
    located.kind === "selected"
      ? xcodeReady(
          located.path,
          probe.run("xcodebuild", ["-license", "check"]),
          probe.run("xcodebuild", ["-checkFirstLaunchStatus"]),
          probe.run("xcodebuild", ["-version"]),
        )
      : noXcode(located);
  return health(who, [
    developer(who, probe.run("dseditgroup", ["-o", "checkmember", "-m", who, "_developer"]), probe.run("DevToolsSecurity", ["-status"])),
    xcode,
    xcode.state === "ok" ? iosRuntime(probe.run("xcrun", ["simctl", "list", "runtimes"])) : waitsForXcode(),
    grant("accessibility", probe.accessibility()),
    grant("screen_recording", probe.screenRecording()),
    guiSession(who, probe.consoleUser()),
    tools(probe.tools(), probe.pods()),
    keepAwake(probe.awake(), sleepMinutes(probe.run("pmset", ["-g"]))),
    screenLock(lockDelay(probe.run("sysadminctl", ["-screenLock", "status"])), consoleLocked(probe.run("ioreg", ["-n", "Root", "-d1", "-a"]))),
  ]);
}

/** What the person does: where, and the command to paste there when there is one. */
type Fix = { label: string; command?: string };

function check(id: MacCheckId, state: MacCheck["state"], message: string, fix?: Fix): MacCheck {
  return {
    id,
    state,
    message: clip(message, 500),
    ...(fix ? { fix: clip(fix.label, 300) } : {}),
    ...(fix?.command ? { command: clip(fix.command, 300) } : {}),
  };
}

/** In the person's own account, which is an admin's: the only place an admin step happens. */
const yours = (command: string): Fix => ({ label: "In your own (admin) account's Terminal", command });

/** `dseditgroup -o checkmember` ("yes <user> is a member of _developer", or "no ...") and `DevToolsSecurity -status`.
 * Both are needed: with Developer Mode off, each simulator's XCTest runner waits on a "Developer Tools Access" password
 * prompt at the Mac's screen, and that simulator's installs and launches hang behind it. */
export function developer(who: string, member: Ran, devtools: Ran): MacCheck {
  const join = `sudo dseditgroup -o edit -a ${who} -t user _developer`;
  const enable = "sudo DevToolsSecurity -enable";
  const isMember = member.out.split(/\s+/).find((w) => w.length);
  const mode = devtools.out.includes("disabled") ? false : devtools.out.includes("enabled") ? true : undefined;
  if (isMember === "yes" && mode === true) {
    return check("developer", "ok", `${who} is in _developer and Developer Mode is on: simulators and debugging ask for no password.`);
  }
  if (isMember === "yes" && mode === false) {
    return check(
      "developer",
      "fail",
      "Developer Mode is off, so each iOS simulator's test runner waits on a password prompt at the Mac's screen, and installs into that simulator hang.",
      yours(enable),
    );
  }
  if (isMember === "no" && mode === true) {
    return check("developer", "fail", `${who} isn't in _developer, so Xcode would ask for an admin's password.`, yours(join));
  }
  if (isMember === "no" && mode === false) {
    return check(
      "developer",
      "fail",
      `${who} isn't in _developer and Developer Mode is off, so Xcode asks for an admin's password and installs into iOS simulators hang.`,
      yours(`${enable} && ${join}`),
    );
  }
  return check(
    "developer",
    "unknown",
    `dseditgroup and DevToolsSecurity didn't say whether ${who} is in _developer with Developer Mode on.`,
    yours(`${enable} && ${join}`),
  );
}

/** The developer check, when it fails: iOS simulators would hang on its password prompt, so `mac sim start` refuses
 * with its fix instead. From the node's last checks at `home`. */
export function blocksSimulators(home: string): MacCheck | undefined {
  return readHealth(home)?.health.checks.find((c) => c.id === "developer" && c.state === "fail");
}

/** Xcode isn't usable yet: not installed, or not the one selected. Only iOS simulators and builds wait for it, so it
 * warns, and setup finishes. */
export function noXcode(located: Located): MacCheck {
  if (located.kind === "unselected") {
    return check(
      "xcode",
      "warn",
      `${xcodeName(located.found)} is in /Applications, but ${located.why}. iOS simulators and builds wait for it; everything else works.`,
      yours(switchTo(located.found)),
    );
  }
  return check("xcode", "warn", "Xcode isn't installed. iOS simulators and builds wait for it; everything else works.", {
    label: "Install Xcode from the App Store; this check looks again by itself",
    command: `open "${APP_STORE}"`,
  });
}

/** A full Xcode selected at `path`: its licence, then its first launch. */
export function xcodeReady(path: string, license: Ran, firstLaunch: Ran, version: Ran): MacCheck {
  if (!ok(license)) {
    return check("xcode", "warn", "Xcode's licence isn't accepted, so xcodebuild and simctl refuse to run. iOS simulators wait for it.", yours(ACCEPT));
  }
  if (!ok(firstLaunch)) {
    return check(
      "xcode",
      "warn",
      "Xcode's first launch hasn't run: its system components aren't installed. iOS simulators wait for it.",
      yours(FIRST_LAUNCH),
    );
  }
  const name = (version.out.split("\n")[0] ?? "").trim() || "Xcode";
  return check("xcode", "ok", `${name} at ${path}, licence accepted.`);
}

/** The simulator check while Xcode isn't usable: the Xcode check says what to do. */
export const waitsForXcode = () => check("ios_runtime", "warn", "Waits for Xcode: the Xcode check says what it needs.");

/** `xcrun simctl list runtimes`: a line like "iOS 26.0 (26.0 - 23A343) - com.apple...", without "unavailable". */
export function iosRuntime(ran: Ran): MacCheck {
  const line = ran.out
    .split("\n")
    .map((l) => l.trim())
    .findLast((l) => l.startsWith("iOS ") && !l.includes("unavailable"));
  if (line !== undefined && ok(ran)) return check("ios_runtime", "ok", line.split(" - ")[0] ?? line);
  return check("ios_runtime", "fail", "No iOS simulator runtime is installed.", yours("xcodebuild -downloadPlatform iOS"));
}

/** System Settings' pane for a grant, by its URL. */
export const pane = (id: MacCheckId) =>
  id === "screen_recording" || id === "screen_capture"
    ? "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    : "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

const grantWords = (id: MacCheckId): [string, string] =>
  id === "screen_recording"
    ? ["Screen Recording", "the node can't show or record the Mac's screen"]
    : ["Accessibility", "the node can't click or type in the Mac's apps"];

/** Has the node ask macOS for the grant (its prompt, and fleetd in the list), then opens the grant's pane. */
export const askCommand = (id: MacCheckId) => `fleetd node grants --ask ${id}`;

export function grant(id: MacCheckId, granted: boolean | undefined): MacCheck {
  const [what, why] = grantWords(id);
  if (granted === true) return check(id, "ok", `fleetd has ${what}.`);
  if (granted === false) {
    return check(id, "fail", `fleetd doesn't have ${what}, so ${why}.`, {
      label: `In Terminal at the Mac, then turn on fleetd in System Settings › Privacy & Security › ${what}, which this opens once macOS has asked. macOS asks again from time to time: turn it on again then`,
      command: askCommand(id),
    });
  }
  return check(id, "unknown", `The node can't ask macOS about ${what} here.`);
}

/**
 * macOS's own question, from macOS 15 on, whether fleetd may capture the screen directly ("bypass the system private
 * window picker"): `captured` is the node's last try, true once a capture came back, its error while one fails, and
 * undefined before Screen Recording is on (it waits for that).
 */
export function screenCapture(captured: true | string | undefined): MacCheck {
  if (captured === true) return check("screen_capture", "ok", "fleetd captures the Mac's screen directly.");
  if (captured === undefined) return check("screen_capture", "unknown", "Waits for Screen Recording.");
  return check("screen_capture", "fail", `macOS hasn't let fleetd capture the screen directly yet: ${captured}`, {
    label: "Press Allow in macOS's prompt that fleetd may bypass the private window picker; Allow here shows it again",
  });
}

/** A grant macOS stopped counting with an update to this version (grants.ts `lost`). */
export function lostGrant(id: MacCheckId): MacCheck {
  const [what, why] = grantWords(id);
  return check(id, "fail", `macOS stopped counting fleetd's ${what} with the update to ${versionLabel(VERSION)}, so ${why}.`, {
    label: `In Terminal at the Mac, then turn fleetd off and on again in System Settings › Privacy & Security › ${what}, which this opens once macOS has asked`,
    command: askCommand(id),
  });
}

export function guiSession(who: string, console: string | undefined): MacCheck {
  if (console === undefined) return check("gui_session", "unknown", "The node couldn't tell who is at the Mac's screen.");
  if (console === who) return check("gui_session", "ok", `console: ${who} is at the Mac's screen, so agents can drive its apps.`);
  const at = console === "root" || console === "" ? "the login window" : console;
  return check(
    "gui_session",
    "warn",
    `background: ${at} is at the Mac's screen. Builds and simulators work; the Mac's own apps need ${who} at the screen.`,
    { label: `At the Mac, switch to ${who} (or use a Mac nobody else sits at)` },
  );
}

export function tools(state: ToolsState, pods: Pods): MacCheck {
  switch (state.kind) {
    case "ready":
      return cocoapods(state.versions, pods);
    case "installing":
      return check("tools", "unknown", "Installing the pinned Node.js, agent-device and agent-desktop.");
    case "failed":
      return check("tools", "fail", `The pinned tools didn't install: ${state.why}`, {
        label: "Check that the Mac reaches nodejs.org and registry.npmjs.org; the node tries again when it restarts",
      });
  }
}

/** The pinned tools are in, and CocoaPods runs or not. Without it only iOS builds with Pods wait, so it warns with the
 * one command that installs it (Homebrew first where there is none). */
function cocoapods(versions: string, pods: Pods): MacCheck {
  const version =
    pods.pod && ok(pods.pod)
      ? pods.pod.out
          .split("\n")
          .map((l) => l.trim())
          .findLast((l) => /^[0-9]/.test(l))
      : undefined;
  if (version !== undefined) return check("tools", "ok", `${versions} CocoaPods ${version}.`);
  const missing = pods.pod
    ? `CocoaPods doesn't run (${pods.pod.out
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length) ?? "no output"})`
    : "CocoaPods isn't installed";
  const command = pods.brew ? `${pods.brew} install cocoapods` : `${HOMEBREW_INSTALL} && ${pods.brewAt} install cocoapods`;
  return check(
    "tools",
    "warn",
    `${versions} ${missing}, so pod install and expo prebuild --platform ios don't run; everything else works.`,
    yours(command),
  );
}

/** System Settings › Lock Screen, where "Require password after screen saver begins or display is turned off" is. */
export const LOCK_PANE = "x-apple.systempreferences:com.apple.Lock-Screen-Settings.extension";

/** `sysadminctl -screenLock status`: the seconds before macOS asks for the password once the display is off (0: at
 * once), null when it never does, undefined unread. */
export function lockDelay(ran: Ran): number | null | undefined {
  if (/screenLock is off/u.test(ran.out)) return null;
  const m = /screenLock delay is (\d+) seconds/u.exec(ran.out);
  if (m) return Number(m[1]);
  return /screenLock (delay )?is immediate/u.test(ran.out) ? 0 : undefined;
}

/** Whether the Mac's screen is locked now, from `ioreg -n Root -d1 -a` (IOConsoleLocked); undefined unread. */
export function consoleLocked(ran: Ran): boolean | undefined {
  const m = /<key>IOConsoleLocked<\/key>\s*<(true|false)\/>/u.exec(ran.out);
  return m ? m[1] === "true" : undefined;
}

/**
 * The lock screen: while it shows, apps' new windows don't, and agents' clicks and keys land on it (Nov 22, the Mac
 * mini locked 5 min after its display went off). Locked now, it fails until someone unlocks it; a password asked
 * after the display goes off warns, with the one switch that stops it.
 */
export function screenLock(delay: number | null | undefined, locked: boolean | undefined): MacCheck {
  if (locked === true) {
    return check("screen_lock", "fail", "The Mac's screen is locked, so apps' windows don't show and agents' clicks land on the lock screen.", {
      label: "Unlock it at the Mac or over Screen Sharing, then set Require password to Never in System Settings › Lock Screen",
    });
  }
  if (delay !== null && delay !== undefined) {
    const when = delay === 0 ? "as soon as" : `${String(Math.round(delay / 60))} min after`;
    return check("screen_lock", "warn", `The screen locks ${when} the display turns off, and agents' windows and clicks stop at the lock screen.`, {
      label: "Set Require password after screen saver begins or display is turned off to Never in System Settings › Lock Screen",
      command: `open "${LOCK_PANE}"`,
    });
  }
  if (delay === null) return check("screen_lock", "ok", "The screen never locks by itself.");
  return check("screen_lock", "unknown", "The node couldn't read the lock screen's setting.");
}

/** System Settings › Energy, where a desktop Mac's "Prevent automatic sleeping" is. */
export const ENERGY_PANE = "x-apple.systempreferences:com.apple.Energy-Settings.extension";

/** The minutes of idle before the system sleeps, as `pmset -g` says them (`sleep 0`: never); undefined unread. */
export function sleepMinutes(ran: Ran): number | undefined {
  const m = /^\s*sleep\s+(\d+)/mu.exec(ran.out);
  return m ? Number(m[1]) : undefined;
}

/**
 * The node's power assertion (`caffeinate -i -s`, held while the node runs) and the Mac's own sleep setting: an agents'
 * Mac that slept dropped off its hub (Nov 22), and the assertion goes with the node at each update or restart, so the
 * setting must be off too.
 */
export function keepAwake(why: string | undefined, sleep?: number): MacCheck {
  if (why !== undefined) return check("keep_awake", "fail", `fleetd can't keep the Mac awake: ${why}.`, yours("sudo pmset -a sleep 0"));
  if (sleep !== undefined && sleep > 0) {
    return check(
      "keep_awake",
      "warn",
      `The Mac sleeps after ${String(sleep)} min idle whenever fleetd's node isn't holding it awake (an update, a restart), and drops off its hub.`,
      { label: "Turn on Prevent automatic sleeping when the display is off in System Settings › Energy", command: `open "${ENERGY_PANE}"` },
    );
  }
  return check("keep_awake", "ok", sleep === 0 ? "The Mac never sleeps, and fleetd's node holds it awake too." : "fleetd's node holds the Mac awake.");
}

/** How long one command of the checks may run before it is stopped: a wedged xcrun or simctl answers nothing. */
export const COMMAND_TIMEOUT = 30_000;

/** A command's exit code and output, never through a shell, off the event loop; stopped at `timeoutMs`. */
export async function ran(program: string, args: string[], env?: Record<string, string | undefined>, timeoutMs = COMMAND_TIMEOUT): Promise<Ran> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([program, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
  } catch (e) {
    return { out: (e as Error).message };
  }
  let stopped = false;
  const timer = setTimeout(() => {
    stopped = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (stopped) return { out: `${program} was stopped after ${Math.round(timeoutMs / 1000)} s` };
  return { ...(code === null ? {} : { code }), out: `${stdout}${stderr}` };
}

const key = (program: string, args: string[]) => [program, ...args].join(" ");

/** What the checks read of the Mac, read beforehand (`readMac`), so the checks themselves block nothing. */
export class Recorded implements Probe {
  constructor(
    private readonly runs: Map<string, Ran>,
    private readonly read: {
      user: string;
      xcodes: string[];
      dirs: Set<string>;
      accessibility: boolean | undefined;
      screenRecording: boolean | undefined;
      console: string | undefined;
      held: string | undefined;
      tools: ToolsState;
      pods: Pods;
    },
  ) {}
  user = () => this.read.user;
  run = (program: string, args: string[]) => this.runs.get(key(program, args)) ?? { out: "" };
  xcodes = () => this.read.xcodes;
  isDir = (path: string) => this.read.dirs.has(path);
  accessibility = () => this.read.accessibility;
  screenRecording = () => this.read.screenRecording;
  consoleUser = () => this.read.console;
  awake = () => this.read.held;
  tools = () => this.read.tools;
  pods = () => this.read.pods;
}

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Reads the Mac for the checks, every command an async spawn with a timeout, so the node's link, heartbeats and the
 * screens it hosts never wait on one (the Rust node runs them on its blocking threads). As `run` asks: xcodebuild only
 * once an Xcode is selected, and simctl only once its licence and first launch are done.
 */
export async function readMac(held: string | undefined, tools: ToolsState): Promise<Probe> {
  const who = user();
  const runs = new Map<string, Ran>();
  const go = async (program: string, args: string[], env?: Record<string, string | undefined>) => {
    const r = await ran(program, args, env);
    runs.set(key(program, args), r);
    return r;
  };
  const has = (name: string) => HOMEBREW_BINS.map((bin) => `${bin}/${name}`).find((p) => existsSync(p));
  const pod = has("pod");
  // The Mac's sleep and lock settings and whether it is locked now, read back by their checks from the recorded runs.
  const settings = Promise.all([go("pmset", ["-g"]), go("sysadminctl", ["-screenLock", "status"]), go("ioreg", ["-n", "Root", "-d1", "-a"])]);
  const [selected, , , console, podRan] = await Promise.all([
    go("xcode-select", ["-p"]),
    go("dseditgroup", ["-o", "checkmember", "-m", who, "_developer"]),
    go("DevToolsSecurity", ["-status"]),
    ran("stat", ["-f", "%Su", "/dev/console"]),
    // CocoaPods refuses to run outside UTF-8, and a launchd service gets no LANG.
    pod ? ran(pod, ["--version"], { ...process.env, LANG: "en_US.UTF-8" }) : Promise.resolve(undefined),
  ]);
  await settings;
  const xcodes = inApplications("/Applications");
  const dirs = new Set<string>();
  const path = ok(selected) ? selected.out.trim() : undefined;
  if (path && isDir(path)) dirs.add(path);
  if (path && locate(path, xcodes, (p) => dirs.has(p)).kind === "selected") {
    const [licence, first] = await Promise.all([
      go("xcodebuild", ["-license", "check"]),
      go("xcodebuild", ["-checkFirstLaunchStatus"]),
      go("xcodebuild", ["-version"]),
    ]);
    if (ok(licence) && ok(first)) await go("xcrun", ["simctl", "list", "runtimes"]);
  }
  return new Recorded(runs, {
    user: who,
    xcodes,
    dirs,
    accessibility: tcc.accessibility(),
    screenRecording: tcc.screenRecording(),
    console: ok(console) ? console.out.trim() : undefined,
    held,
    tools,
    pods: {
      ...(podRan ? { pod: podRan } : {}),
      ...(has("brew") ? { brew: has("brew")! } : {}),
      brewAt: `${HOMEBREW_BINS[process.arch === "arm64" ? 0 : 1]}/brew`,
    },
  });
}
