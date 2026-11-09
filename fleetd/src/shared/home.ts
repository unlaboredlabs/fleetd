import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** `~` expanded, absolute against the cwd. */
export function expandHome(raw: string, userHome = homedir()): string {
  const expanded = raw === "~" ? userHome : raw.startsWith("~/") ? join(userHome, raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** The parent of the `--home` this process was started with. */
let besideHome: string | undefined;

/** `$FLEETD_HOME`, else the directory beside `--home`, else `~/.fleetd`. */
export function fleetdDir(): string {
  const env = process.env.FLEETD_HOME;
  return env ? expandHome(env) : (besideHome ?? join(homedir(), ".fleetd"));
}

/** The fleetd dir when it isn't `~/.fleetd`: then files that otherwise live elsewhere go in it too. */
export function relocated(): string | undefined {
  const dir = fleetdDir();
  return dir === join(homedir(), ".fleetd") ? undefined : dir;
}

/** The `--home` in a command line (`--home <dir>` or `--home=<dir>`, before any `--`). */
export function homeFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
    if (argv[i] === "--home") return argv[i + 1] === "--" ? undefined : argv[i + 1];
    if (argv[i]!.startsWith("--home=")) return argv[i]!.slice(7);
  }
  return undefined;
}

/** Called once by main, before the command runs: a command given `--home <dir>` keeps its state beside it. */
export function initFromArgv(argv: string[]) {
  const home = homeFlag(argv);
  if (home) besideHome = dirname(expandHome(home));
}
