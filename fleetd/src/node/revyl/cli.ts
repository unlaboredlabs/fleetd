// Runs Revyl's own CLI (`revyl`): the one on the machine, else fleetd's own copy, which the node fetches from Revyl's
// releases the first time it needs it (install.ts): fleetd ships no copy. The team's key goes to the one process in its environment (REVYL_API_KEY), never on a command line, and the process runs
// with a home of its own, so a login stored in a person's ~/.revyl never stands in for the team's key. What it prints
// comes back with any key masked. FLEETD_REVYL_BIN names a stand-in (the tests').
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mask } from "../../shared/revyl.ts";
import { type Install, InstallFailed, installRevyl } from "./install.ts";

export type Run = { exit: number | null; out: string; timedOut: boolean };

/** The `revyl` to run: FLEETD_REVYL_BIN, else the one on PATH, else where Revyl's installer puts it. */
export function revylBin(env: Record<string, string | undefined> = process.env): string | undefined {
  const given = env.FLEETD_REVYL_BIN;
  if (given) return existsSync(given) ? given : undefined;
  const onPath = Bun.which("revyl", { PATH: env.PATH ?? "" });
  if (onPath) return onPath;
  const installed = join(env.HOME ?? homedir(), ".revyl", "bin", "revyl");
  return existsSync(installed) ? installed : undefined;
}

/** Python's user base under the real home (`site.USER_BASE`): ~/Library/Python on a Mac, else ~/.local. */
const userBase = (home: string) => (process.platform === "darwin" ? join(home, "Library", "Python") : join(home, ".local"));

/** There is no `revyl` here and none could be installed: why, in a sentence. */
export class NoCli extends Error {}

/**
 * The `revyl` to run: one on the machine (revylBin), else fleetd's own copy in `install`'s folder, installed now when
 * it isn't there yet. A stand-in FLEETD_REVYL_BIN names is never installed over. Throws NoCli.
 */
export async function findRevyl(install?: Install, env: Record<string, string | undefined> = process.env): Promise<string> {
  const found = revylBin(env);
  if (found) return found;
  if (env.FLEETD_REVYL_BIN) throw new NoCli(`${env.FLEETD_REVYL_BIN} isn't there`);
  if (!install) throw new NoCli("there is no revyl command on this machine");
  try {
    return await installRevyl(install);
  } catch (e) {
    throw new NoCli(e instanceof InstallFailed ? e.message : `couldn't install Revyl's CLI: ${(e as Error).message}`);
  }
}

/**
 * `revyl <argv>` with the team's `key`, in `cwd`, cut off after `timeoutMs`. `home` is the folder the process gets as
 * its HOME (made 0700). Without `bin`, the `revyl` findRevyl gives, installed into `install`'s folder when there is
 * none; throws NoCli when there is none and it couldn't be.
 */
export async function runRevyl(
  argv: string[],
  opts: { key: string; home: string; cwd?: string; timeoutMs: number; bin?: string; install?: Install; env?: Record<string, string | undefined> },
): Promise<Run> {
  const bin = opts.bin ?? (await findRevyl(opts.install, opts.env));
  mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  const proc = Bun.spawn([bin, ...argv], {
    cwd: opts.cwd ?? opts.home,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: opts.home,
      // A `pip install --user revyl` finds its package under the real home still.
      PYTHONUSERBASE: process.env.PYTHONUSERBASE ?? userBase(process.env.HOME ?? homedir()),
      NO_COLOR: "1",
      REVYL_API_KEY: opts.key,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exit = await proc.exited;
    return { exit: timedOut ? null : exit, out: mask(`${out}${err ? `${out ? "\n" : ""}${err}` : ""}`, opts.key), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** The first JSON object in `out` (Revyl's `--json`), or undefined. */
export function jsonOf(out: string): Record<string, unknown> | undefined {
  const at = out.indexOf("{");
  if (at < 0) return undefined;
  for (let end = out.lastIndexOf("}"); end > at; end = out.lastIndexOf("}", end - 1)) {
    try {
      const v = JSON.parse(out.slice(at, end + 1)) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {}
  }
  return undefined;
}
