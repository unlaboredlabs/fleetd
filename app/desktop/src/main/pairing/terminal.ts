// "Set up fleetd on this Mac": `fleetd init` in the system terminal. The wizard asks for logins and installs a
// background service, so it runs where the person can answer it, never hidden in the app. This is the only command
// main runs for the page, and the page can't change it: the request carries no arguments.
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { SetupOutcome } from "../../shared/pairing";

export interface TerminalDeps {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** PATH as main got it; an app opened from the Finder has only the system dirs. */
  readonly path: string;
  readonly executable: (file: string) => boolean;
  /** Runs to the end; true on exit 0. */
  readonly exec: (file: string, args: ReadonlyArray<string>) => Promise<boolean>;
  /** Starts a program that outlives the call; true once it started. */
  readonly launch: (file: string, args: ReadonlyArray<string>) => Promise<boolean>;
  /** Writes a script Terminal can open (a `.command` file) and returns its path. */
  readonly writeScript: (text: string) => string;
}

/** Linux terminals, most general first, with what comes before the command to run. */
const LINUX_TERMINALS: ReadonlyArray<{ readonly bin: string; readonly args: ReadonlyArray<string> }> = [
  { bin: "x-terminal-emulator", args: ["-e"] },
  { bin: "gnome-terminal", args: ["--"] },
  { bin: "konsole", args: ["-e"] },
  { bin: "xfce4-terminal", args: ["-x"] },
  { bin: "kitty", args: [] },
  { bin: "alacritty", args: ["-e"] },
  { bin: "foot", args: [] },
  { bin: "xterm", args: ["-e"] },
];

const which = (deps: TerminalDeps, name: string): string | null => {
  for (const dir of deps.path.split(delimiter)) {
    if (dir === "") continue;
    const file = join(dir, name);
    if (deps.executable(file)) return file;
  }
  return null;
};

/** The fleetd CLI, and the command a person would type for it: on PATH, else where the installer puts it. */
export const findFleetd = (deps: TerminalDeps): { readonly bin: string; readonly command: string } | null => {
  const onPath = which(deps, "fleetd");
  if (onPath !== null) return { bin: onPath, command: "fleetd init" };
  const installed = join(deps.home, ".local", "bin", "fleetd");
  return deps.executable(installed) ? { bin: installed, command: "~/.local/bin/fleetd init" } : null;
};

const shQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

export const openSetup = async (deps: TerminalDeps): Promise<SetupOutcome> => {
  const found = findFleetd(deps);
  if (found === null) {
    return { ok: false, message: "Couldn't find the fleetd command on this computer. Once fleetd is installed, run this in a terminal:", command: "fleetd init" };
  }
  const failed: SetupOutcome = { ok: false, message: "Couldn't open a terminal. Run this in one:", command: found.command };
  if (deps.platform === "darwin") {
    const script = deps.writeScript(`#!/bin/sh\nexec ${shQuote(found.bin)} init\n`);
    return (await deps.exec("/usr/bin/open", ["-a", "Terminal", script])) ? { ok: true, terminal: "Terminal" } : failed;
  }
  if (deps.platform !== "linux") return failed;
  for (const terminal of LINUX_TERMINALS) {
    const bin = which(deps, terminal.bin);
    if (bin !== null && (await deps.launch(bin, [...terminal.args, found.bin, "init"]))) return { ok: true, terminal: "a terminal" };
  }
  return failed;
};

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const realTerminalDeps = (): TerminalDeps => ({
  platform: process.platform,
  home: homedir(),
  path: process.env["PATH"] ?? "",
  executable,
  exec: (file, args) => new Promise((done) => execFile(file, [...args], (error) => done(error === null))),
  launch: (file, args) =>
    new Promise((done) => {
      const child = spawn(file, [...args], { detached: true, stdio: "ignore" });
      child.once("spawn", () => {
        child.unref();
        done(true);
      });
      child.once("error", () => done(false));
    }),
  writeScript: (text) => {
    const file = join(mkdtempSync(join(tmpdir(), "fleetd-setup-")), "fleetd-init.command");
    writeFileSync(file, text, { mode: 0o700 });
    return file;
  },
});
