// What a project with no repo kept under the node's home before every project became one kind (D310), under its
// on-disk name from then, `navis` (D500: the one place that name stays, so nothing installed there breaks):
// - `<node home>/navis/<id>/home`, the project's own HOME (D234), with what its lead installed there. It stays where
//   it is: a HOME that moves breaks the absolute paths inside it (pip's and npm's scripts). Its lead keeps running its
//   commands there (`ownHomeEnv`), and it goes with the project.
// - `<node home>/browser/navis/<id>`, its kept browser sign-ins: moved once, at the node's start, to
//   `browser/kept/<id>`, where every project's are (`moveKeptProfiles`).
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./util.ts";

/** The directory name from before D310 (D500). */
const OLD = "navis";
/** A kept profile set aside while the one it gives way to moves in: removed once that one is in place. */
const STALE = ".stale";

/** The user-level bin dirs installers put programs in, first on the PATH of commands run with a kept HOME. */
const HOME_BINS = [".local/bin", "bin", ".cargo/bin", "go/bin", ".bun/bin", ".deno/bin"];

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Where a project's own kept HOME and its tmp dir are, whether or not it has one. */
export const ownHomeDir = (nodeHome: string, projectId: string) => join(nodeHome, OLD, projectId);

/** What claude runs ahead of each command of the project's lead (`CLAUDE_ENV_FILE`), when the project kept a HOME of
 * its own: that home as HOME, with HOME_BINS first on its PATH and npm installing globally there too (`~/.local`); its
 * `tmp` beside it as TMPDIR; pip allowed to install for the user on a system that marks its Python as managed; the
 * person's rustup toolchains, when they have them. claude itself keeps the person's HOME, where its login and settings
 * are. Undefined for a project with no such home. */
export function ownHomeEnv(nodeHome: string, projectId: string, userHome: string): string | undefined {
  const own = ownHomeDir(nodeHome, projectId);
  let home: string;
  try {
    home = realpathSync(join(own, "home"));
  } catch {
    return undefined;
  }
  const tmp = join(own, "tmp");
  try {
    mkdirSync(tmp, { recursive: true });
  } catch (error) {
    console.warn(`${nowIso()} WARN a project's own tmp dir was not made: ${(error as Error).message}`);
  }
  let env =
    `export HOME=${quote(home)}\n` +
    `export PATH="${HOME_BINS.map((b) => `$HOME/${b}`).join(":")}:$PATH"\n` +
    `export NPM_CONFIG_PREFIX="$HOME/.local"\n` +
    `export CARGO_HOME="$HOME/.cargo"\n` +
    `export PIP_BREAK_SYSTEM_PACKAGES=1\n` +
    `export TMPDIR=${quote(tmp)} TMP=${quote(tmp)} TEMP=${quote(tmp)}\n`;
  const rustup = join(userHome, ".rustup");
  try {
    if (statSync(rustup).isDirectory()) env += `export RUSTUP_HOME=${quote(rustup)}\n`;
  } catch {}
  return env;
}

const isDir = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Where kept browser profiles were before D310. */
export const oldProfilesDir = (nodeHome: string) => join(nodeHome, "browser", OLD);

/** A kept profile not moved yet (a browser ran on it at the node's start): it stays the project's until it moves. */
export function unmovedProfile(nodeHome: string, projectId: string): string | undefined {
  const dir = join(oldProfilesDir(nodeHome), projectId);
  return isDir(dir) ? dir : undefined;
}

/** Whether a browser still runs on the profile: Chrome's `SingletonLock` names its host and pid while it does. */
function browserOn(dir: string, alive: (pid: number) => boolean): boolean {
  let target: string;
  try {
    target = readlinkSync(join(dir, "SingletonLock"));
  } catch {
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  return Number.isInteger(pid) && pid > 0 && alive(pid);
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Moves each kept profile from `browser/navis/<id>` to `browser/kept/<id>`. Each step is one rename, so a node stopped
 * at any point leaves every profile whole in one place or the other, and the next start goes on from there: a profile
 * already at `kept/<id>` gives way (set aside as `kept/.<id>.stale`, then removed), since the old place is the one
 * its browser used. A profile a browser still runs on stays until a start finds it free. Returns the ids moved.
 */
export function moveKeptProfiles(nodeHome: string, alive: (pid: number) => boolean = isAlive): string[] {
  const from = oldProfilesDir(nodeHome);
  const to = join(nodeHome, "browser", "kept");
  const moved: string[] = [];
  let ids: string[] = [];
  try {
    ids = readdirSync(from);
  } catch {}
  if (ids.length > 0) mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const id of ids) {
    const old = join(from, id);
    if (id.startsWith(".") || !isDir(old)) continue;
    if (browserOn(old, alive)) {
      console.warn(`${nowIso()} WARN project ${id}'s kept browser profile stays in ${from} until no browser runs on it`);
      continue;
    }
    const stale = join(to, `.${id}${STALE}`);
    try {
      if (existsSync(join(to, id))) {
        if (existsSync(stale)) rmSync(stale, { recursive: true, force: true });
        renameSync(join(to, id), stale);
      }
      renameSync(old, join(to, id));
      moved.push(id);
    } catch (error) {
      console.warn(`${nowIso()} WARN project ${id}'s kept browser profile was not moved: ${(error as Error).message}`);
    }
  }
  // What a move set aside goes once the profile it gave way to is in place, this start's or an earlier one's.
  let kept: string[] = [];
  try {
    kept = readdirSync(to);
  } catch {}
  for (const name of kept) {
    if (!name.startsWith(".") || !name.endsWith(STALE)) continue;
    const id = name.slice(1, -STALE.length);
    if (isDir(join(to, id)) && !isDir(join(from, id))) rmSync(join(to, name), { recursive: true, force: true });
  }
  try {
    if (readdirSync(from).length === 0) rmSync(from, { recursive: true, force: true });
  } catch {}
  return moved;
}
