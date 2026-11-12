// "Set up fleetd on this Mac": `fleetd init` in the system terminal; "Run in Terminal" for a hub on this computer:
// `fleetd update`. Both run where the person sees and answers them, never hidden in the app (the wizard asks for
// logins; update says what runs on the hub and restarts it only when nothing does). These are the only commands main
// runs for the page, and the page can't change them: each request carries no arguments, and main picks the command.
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
  /** Writes a script Terminal can open (a `.command` file named `name`) and returns its path. */
  readonly writeScript: (text: string, name: string) => string;
  /** Deletes a script no terminal ran, and its folder. */
  readonly removeScript: (file: string) => void;
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

/** The two fleetd commands main opens, each with no arguments. */
export type FleetdCommand = "init" | "update";

/** The fleetd CLI, and the command a person would type for it: on PATH, else where the installer puts it. */
export const findFleetd = (deps: TerminalDeps, run: FleetdCommand = "init"): { readonly bin: string; readonly command: string } | null => {
  const onPath = which(deps, "fleetd");
  if (onPath !== null) return { bin: onPath, command: `fleetd ${run}` };
  const installed = join(deps.home, ".local", "bin", "fleetd");
  return deps.executable(installed) ? { bin: installed, command: `~/.local/bin/fleetd ${run}` } : null;
};

const shQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The fixed shell script a terminal runs. `fleetd update` exits 0 after saying it left a busy hub running and how to
 * finish, and terminals close when their command exits, so update waits for Return to keep that message on screen.
 */
const script = (bin: string, run: FleetdCommand): string =>
  run === "update" ? `${shQuote(bin)} update\necho\nprintf 'Press Return to close. '\nread -r _\n` : `exec ${shQuote(bin)} init\n`;

const openFleetd = async (deps: TerminalDeps, run: FleetdCommand): Promise<SetupOutcome> => {
  const found = findFleetd(deps, run);
  if (found === null) {
    return { ok: false, message: "Couldn't find the fleetd command on this computer. Once fleetd is installed, run this in a terminal:", command: `fleetd ${run}` };
  }
  const failed: SetupOutcome = { ok: false, message: "Couldn't open a terminal. Run this in one:", command: found.command };
  if (deps.platform === "darwin") {
    const file = deps.writeScript(`#!/bin/sh\n${script(found.bin, run)}`, `fleetd-${run}.command`);
    return (await deps.exec("/usr/bin/open", ["-a", "Terminal", file])) ? { ok: true, terminal: "Terminal" } : failed;
  }
  if (deps.platform !== "linux") return failed;
  for (const terminal of LINUX_TERMINALS) {
    const bin = which(deps, terminal.bin);
    const command = run === "update" ? ["/bin/sh", "-c", script(found.bin, run)] : [found.bin, run];
    if (bin !== null && (await deps.launch(bin, [...terminal.args, ...command]))) return { ok: true, terminal: "a terminal" };
  }
  return failed;
};

export const openSetup = (deps: TerminalDeps): Promise<SetupOutcome> => openFleetd(deps, "init");

/**
 * Connect this computer (src/main/cloud/connect.ts): a hub's join line in a terminal, from a script that deletes
 * itself first, so the line's one-time code is in no terminal's arguments and nowhere on disk once it runs. The
 * terminal stays open on what the install said until Return.
 */
export const openJoinLine = async (deps: TerminalDeps, line: string): Promise<{ ok: true; terminal: string } | { ok: false }> => {
  const body = `#!/bin/sh\nrm -f "$0"\nrmdir "$(dirname "$0")" 2>/dev/null\n${line}\necho\nprintf 'Press Return to close. '\nread -r _\n`;
  if (deps.platform === "darwin") {
    const file = deps.writeScript(body, "fleetd-join.command");
    return (await deps.exec("/usr/bin/open", ["-a", "Terminal", file])) ? { ok: true, terminal: "Terminal" } : { ok: false };
  }
  if (deps.platform !== "linux") return { ok: false };
  for (const terminal of LINUX_TERMINALS) {
    const bin = which(deps, terminal.bin);
    if (bin === null) continue;
    const file = deps.writeScript(body, "fleetd-join.sh");
    if (await deps.launch(bin, [...terminal.args, "/bin/sh", file])) return { ok: true, terminal: "a terminal" };
    deps.removeScript(file);
  }
  return { ok: false };
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
  writeScript: (text, name) => {
    const file = join(mkdtempSync(join(tmpdir(), "fleetd-")), name);
    writeFileSync(file, text, { mode: 0o700 });
    return file;
  },
  removeScript: (file) => rmSync(dirname(file), { recursive: true, force: true }),
});
