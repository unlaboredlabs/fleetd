// The agents' Mac's setup checks (crates/fleetd/src/node/agents_mac/checks.rs, docs: agents-mac.md), run by the node
// as its own user, so each tests what a process of that user can do. Each is a pure verdict on what a `Probe` read;
// `Live` reads the Mac, tests fake it. A failing check says exactly what the person does, and where: in an admin's
// Terminal, or at the Mac in the account the node runs in (yours, an admin's, or a user of its own for agents: D309).
import { spawnSync } from "node:child_process";
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
    keepAwake(probe.awake()),
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
  id === "screen_recording"
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

export function keepAwake(why: string | undefined): MacCheck {
  if (why === undefined) {
    return check("keep_awake", "ok", "fleetd keeps the Mac from sleeping while it is idle (a closed laptop lid still sleeps).");
  }
  return check("keep_awake", "fail", `fleetd can't keep the Mac awake: ${why}.`, yours("sudo pmset -a sleep 0"));
}

/** A command's exit code and output, never through a shell. */
export function ran(program: string, args: string[], env?: NodeJS.ProcessEnv): Ran {
  const out = spawnSync(program, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...(env ? { env } : {}) });
  if (out.error) return { out: out.error.message };
  return { ...(out.status === null ? {} : { code: out.status }), out: `${out.stdout ?? ""}${out.stderr ?? ""}` };
}

/** The Mac itself. */
export class Live implements Probe {
  constructor(
    private readonly held: string | undefined,
    private readonly toolsState: ToolsState,
  ) {}
  user(): string {
    return user();
  }
  run(program: string, args: string[]): Ran {
    return ran(program, args);
  }
  xcodes(): string[] {
    return inApplications("/Applications");
  }
  isDir(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
  accessibility(): boolean | undefined {
    return tcc.accessibility();
  }
  screenRecording(): boolean | undefined {
    return tcc.screenRecording();
  }
  consoleUser(): string | undefined {
    const r = this.run("stat", ["-f", "%Su", "/dev/console"]);
    return ok(r) ? r.out.trim() : undefined;
  }
  awake(): string | undefined {
    return this.held;
  }
  tools(): ToolsState {
    return this.toolsState;
  }
  pods(): Pods {
    const has = (name: string) => HOMEBREW_BINS.map((bin) => `${bin}/${name}`).find((p) => existsSync(p));
    const pod = has("pod");
    // CocoaPods refuses to run outside UTF-8, and a launchd service gets no LANG.
    return {
      ...(pod ? { pod: ran(pod, ["--version"], { ...process.env, LANG: "en_US.UTF-8" }) } : {}),
      ...(has("brew") ? { brew: has("brew")! } : {}),
      brewAt: `${HOMEBREW_BINS[process.arch === "arm64" ? 0 : 1]}/brew`,
    };
  }
}
